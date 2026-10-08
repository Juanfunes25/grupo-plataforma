import { fechaHN } from '@grupo/shared';
import { auditar } from '../../lib/auditoria.js';
import { antifraudeActivo, crearAlerta } from './alertas.js';
import { obtenerReglas } from './reglas.js';

// Vigilancia: hooks que se llaman desde ventas y login, y la revisión periódica.
// Todo es a prueba de fallos: si algo se rompe aquí, la venta o el login siguen igual.
const seguro = (nombre, fn) => async (...args) => {
  try { return await fn(...args); } catch (e) { console.error(`[antifraude] ${nombre}:`, e.message); return null; }
};
const L = (n) => Number(n ?? 0).toFixed(2);
const FIRMA = `(select coalesce(string_agg(d.producto_id::text || ':' || d.cantidad::text, '|' order by d.producto_id, d.cantidad), '') from pos.detalle_venta d where d.venta_id = v.id)`;

// ── Ventas ──────────────────────────────────────────────────────────────────
/**
 * evento: 'cobrada' | 'anulada' | 'nota_credito'
 * extra:  { motivo, estado_previo, monto } según el evento.
 */
export const vigilarVenta = seguro('venta', async (db, ctx, evento, ventaId, extra = {}) => {
  if (!antifraudeActivo(ctx)) return;
  const empresaId = ctx.empresa.id;
  const v = (await db.query(
    `select v.*, ${FIRMA} as firma, coalesce(s.nombre, '') as sucursal from pos.ventas v join core.sucursales s on s.id = v.sucursal_id where v.id = $1 and v.empresa_id = $2`,
    [ventaId, empresaId])).rows[0];
  if (!v) return;
  const R = await obtenerReglas(db, empresaId);
  const usuario = { id: ctx.usuario.id, nombre: ctx.usuario.nombre };
  const base = { empresaId, sucursalId: v.sucursal_id, usuario, entidad: 'venta', entidadId: v.id };

  if (evento === 'cobrada') {
    // Doble factura: mismos productos y total, misma sucursal, a pocos minutos.
    const gemela = (await db.query(
      `select v.numero_factura from pos.ventas v
        where v.empresa_id = $1 and v.sucursal_id = $2 and v.estado = 'pagada' and v.total = $3 and v.id <> $4
          and v.fecha_emision >= now() - make_interval(mins => $5::int) and ${FIRMA} = $6 limit 1`,
      [empresaId, v.sucursal_id, v.total, v.id, Math.ceil(R.minutos_doble_factura), v.firma])).rows[0];
    if (gemela) {
      await crearAlerta(db, { ...base, tipo: 'venta.doble_factura', severidad: 'media',
        titulo: `Posible doble factura: ${v.numero_factura} y ${gemela.numero_factura} son idénticas`,
        detalle: { factura: v.numero_factura, gemela: gemela.numero_factura, total: Number(v.total), cajero: usuario.nombre },
        clave: `doble:${v.id}`, cadaMin: 1440 });
    }
    // Tercera edad: carné reutilizado y exceso de descuentos por cajero.
    const hoy = fechaHN();
    const dia = `(v.fecha_emision at time zone 'America/Tegucigalpa')::date = $2::date`;
    if (v.tercera_edad_identidad) {
      const usos = (await db.query(
        `select count(*)::int as n from pos.ventas v where v.empresa_id = $1 and ${dia} and v.estado = 'pagada' and v.tercera_edad_identidad = $3`,
        [empresaId, hoy, v.tercera_edad_identidad])).rows[0].n;
      if (usos > R.max_usos_carne_dia) {
        await crearAlerta(db, { ...base, tipo: 'tercera_edad.carne_repetido', severidad: 'alta',
          titulo: `El carné ${v.tercera_edad_identidad} se usó ${usos} veces hoy para el descuento de tercera edad`,
          detalle: { identidad: v.tercera_edad_identidad, nombre: v.tercera_edad_nombre ?? '', usos_hoy: usos, cajero: usuario.nombre },
          clave: `carne:${v.tercera_edad_identidad}:${hoy}`, cadaMin: 1440 });
      }
    }
    const delCajero = (await db.query(
      `select count(*)::int as n from pos.ventas v where v.empresa_id = $1 and ${dia} and v.estado = 'pagada' and v.cajero_id = $3 and v.tercera_edad_identidad is not null`,
      [empresaId, hoy, ctx.usuario.id])).rows[0].n;
    if (delCajero > R.max_tercera_edad_dia) {
      await crearAlerta(db, { ...base, entidad: null, entidadId: null, tipo: 'tercera_edad.exceso', severidad: 'media',
        titulo: `${usuario.nombre} lleva ${delCajero} facturas con descuento de tercera edad hoy`,
        detalle: { facturas_hoy: delCajero, limite: R.max_tercera_edad_dia },
        clave: `te-cajero:${ctx.usuario.id}:${hoy}`, cadaMin: 1440 });
    }
  } else if (evento === 'anulada') {
    // Las órdenes descartadas y las reimpresiones repetidas las alerta el propio POS (ventas.js) en esta misma bandeja.
    if (extra.estado_previo !== 'abierta') {
      await crearAlerta(db, { ...base, tipo: 'venta.anular', severidad: 'media',
        titulo: `${usuario.nombre} anuló la factura ${v.numero_factura} (L ${L(v.total)})`,
        detalle: { factura: v.numero_factura, total: Number(v.total), motivo: extra.motivo ?? '' } });
    }
  } else if (evento === 'nota_credito') {
    await crearAlerta(db, { ...base, tipo: 'venta.nota_credito', severidad: 'media',
      titulo: `${usuario.nombre} emitió una nota de crédito de L ${L(extra.monto)} sobre ${v.numero_factura}`,
      detalle: { factura: v.numero_factura, nota: extra.nota ?? '', monto: Number(extra.monto ?? 0), motivo: extra.motivo ?? '' } });
  }
});

// ── Dispositivos: cada navegador manda su identificador en X-Dispositivo ───
// Primer uso de un dispositivo nuevo, y uso simultáneo desde dos dispositivos → alerta.
export const vigilarDispositivo = seguro('dispositivo', async (db, { empresa, usuario, dispositivo, navegador = '', ip = '' }) => {
  if (!antifraudeActivo(empresa)) return;
  const disp = String(dispositivo ?? '').replace(/[^\w-]/g, '').slice(0, 64);
  if (!usuario?.id || !disp) return;
  const nav = String(navegador).slice(0, 200);
  const emp = empresa.id;

  const otros = (await db.query(
    `select dispositivo_id, ultima_vez > now() - interval '3 minutes' as reciente from af.dispositivos where empresa_id = $1 and usuario_id = $2 and dispositivo_id <> $3`,
    [emp, usuario.id, disp])).rows;
  const ins = await db.query(
    `insert into af.dispositivos (empresa_id, usuario_id, dispositivo_id, navegador, ip) values ($1,$2,$3,$4,$5) on conflict do nothing`,
    [emp, usuario.id, disp, nav, ip]);
  const nuevo = ins.rowCount > 0;
  if (!nuevo) await db.query(`update af.dispositivos set ultima_vez = now(), ip = $4 where empresa_id = $1 and usuario_id = $2 and dispositivo_id = $3 and ultima_vez < now() - interval '30 seconds'`, [emp, usuario.id, disp, ip]);

  const rol = usuario.rol ?? (usuario.es_dueno_grupo ? 'dueno' : (await db.query('select rol from core.accesos where usuario_id = $1 and empresa_id = $2', [usuario.id, emp])).rows[0]?.rol);
  const directivo = rol === 'dueno' || rol === 'admin';
  const quien = { id: usuario.id, nombre: usuario.nombre };
  const reciente = otros.find((o) => o.reciente);
  if (reciente) {
    await crearAlerta(db, { empresaId: emp, usuario: quien, tipo: 'sesion.simultanea', severidad: 'alta',
      titulo: `${usuario.nombre} está usando el sistema en dos dispositivos a la vez`,
      detalle: { dispositivo_actual: disp.slice(0, 8), otro_dispositivo: reciente.dispositivo_id.slice(0, 8), nota: '¿Alguien más conoce su contraseña o PIN?' },
      clave: `simultaneo:${usuario.id}`, cadaMin: 60 });
  }
  if (nuevo) {
    await auditar(db, { empresa, usuario, ip }, 'sesion.dispositivo_nuevo', 'sesion', null, { dispositivo: disp.slice(0, 8), navegador: nav.slice(0, 120) });
    if (otros.length > 0) {
      await crearAlerta(db, { empresaId: emp, usuario: quien, tipo: 'sesion.dispositivo_nuevo', severidad: directivo ? 'alta' : 'media',
        titulo: `${usuario.nombre} entró desde un dispositivo nuevo`,
        detalle: { dispositivo: disp.slice(0, 8), navegador: nav.slice(0, 120), ip, dispositivos_previos: otros.length } });
    }
  }
});

// ── Intentos fallidos de entrada (se cuentan en la bitácora, que ya los guarda) ─
// `clave` = correo intentado (o la IP, para el PIN).
export const vigilarLoginFallido = seguro('login_fallido', async (db, { empresa, clave, ip, via }) => {
  if (!antifraudeActivo(empresa)) return;
  const R = await obtenerReglas(db, empresa.id);
  const n = via === 'pin'
    ? (await db.query(`select count(*)::int as n from core.auditoria where empresa_id = $1 and accion = 'pin_fallido' and ip = $2 and created_at > now() - interval '15 minutes'`, [empresa.id, ip ?? ''])).rows[0].n
    : (await db.query(`select count(*)::int as n from core.auditoria where empresa_id = $1 and accion = 'login_fallido' and detalle->>'email' = $2 and created_at > now() - interval '15 minutes'`, [empresa.id, clave])).rows[0].n;
  if (n < R.intentos_login) return;
  await crearAlerta(db, { empresaId: empresa.id, tipo: 'sesion.login_fallido', severidad: 'alta',
    titulo: via === 'pin' ? `${n} PIN incorrectos seguidos desde ${ip || 'un mismo equipo'} en 15 minutos` : `${n} intentos fallidos de entrar como "${clave}" en 15 minutos`,
    detalle: { intentado: via === 'pin' ? 'PIN' : clave, intentos: n, ip: ip ?? '' },
    clave: `fallido:${via}:${via === 'pin' ? ip : clave}`, cadaMin: 30 });
});

// ── Fuera de horario (solo para quien no es dueño/administrador) ─────────────
export const vigilarHorario = seguro('horario', async (db, ctx, accion) => {
  if (!antifraudeActivo(ctx) || ctx.rol === 'dueno' || ctx.rol === 'admin') return;
  const R = await obtenerReglas(db, ctx.empresa.id);
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Tegucigalpa', hour: '2-digit', hour12: false }).format(new Date())) % 24;
  if (h >= R.hora_apertura && h < R.hora_cierre) return;
  await crearAlerta(db, { empresaId: ctx.empresa.id, usuario: { id: ctx.usuario.id, nombre: ctx.usuario.nombre }, tipo: 'horario.fuera', severidad: 'media',
    titulo: `${ctx.usuario.nombre} usó el sistema fuera de horario`,
    detalle: { accion, hora: new Date().toLocaleTimeString('es-HN', { timeZone: 'America/Tegucigalpa' }), horario_normal: `${R.hora_apertura}:00–${R.hora_cierre}:00` },
    clave: `horario:${ctx.usuario.id}`, cadaMin: 120 });
});

// ── Revisión periódica ────────────────────────────────────────────────────────
// No hay un cron: se ejecuta cuando alguien con acceso abre el panel o el contador del menú
// consulta (máximo una vez cada 2 minutos por empresa). Genera:
//   · descuadres de caja y faltantes repetidos de cierres de turno
//   · órdenes estacionadas (abiertas mucho tiempo sin cobrar)
//   · bitácora alterada (verifica la cadena de hashes, máximo cada 6 horas)
const ultimaRevision = new Map();
let bitacora = { ts: 0, resultado: null };

export async function verificarBitacora(db, { forzar = false } = {}) {
  if (!forzar && bitacora.resultado && Date.now() - bitacora.ts < 6 * 3600_000) return bitacora.resultado;
  const r = (await db.query('select * from core.verificar_auditoria()')).rows[0];
  bitacora = { ts: Date.now(), resultado: { integra: r.integra, total: Number(r.total), primer_id_alterado: r.primer_id_alterado } };
  return bitacora.resultado;
}

export const revisarEmpresa = seguro('revision', async (db, empresa, { forzar = false } = {}) => {
  if (!antifraudeActivo(empresa)) return;
  if (!forzar && Date.now() - (ultimaRevision.get(empresa.id) ?? 0) < 120_000) return;
  ultimaRevision.set(empresa.id, Date.now());
  const R = await obtenerReglas(db, empresa.id);

  // Cierres de caja recientes: cada alerta que el cierre calculó (descuadre, patrón de desvío, reincidencia) pasa a la bandeja.
  const cierres = (await db.query(
    `select c.id, c.sucursal_id, c.cajero_id, c.alertas, c.fecha, u.nombre as cajero, s.nombre as sucursal
       from pos.cierres_caja c join core.usuarios u on u.id = c.cajero_id join core.sucursales s on s.id = c.sucursal_id
      where c.empresa_id = $1 and c.created_at > now() - interval '3 days' and jsonb_array_length(c.alertas) > 0 order by c.created_at limit 50`, [empresa.id])).rows;
  for (const c of cierres) {
    for (const al of c.alertas) {
      await crearAlerta(db, { empresaId: empresa.id, sucursalId: c.sucursal_id, usuario: { id: c.cajero_id, nombre: c.cajero }, entidad: 'cierre', entidadId: c.id,
        tipo: `cierre.${al.tipo}`, severidad: al.severidad ?? 'media', titulo: al.titulo, detalle: { sucursal: c.sucursal, fecha: c.fecha }, clave: `cierre:${c.id}:${al.tipo}`, cadaMin: 100_000 });
    }
  }

  // Turnos cerrados por la vía sencilla (sin cierre de caja del día) con faltante o sobrante
  const turnos = (await db.query(
    `select t.id, t.sucursal_id, t.cajero_id, t.diferencia, u.nombre as cajero, s.nombre as sucursal
       from pos.turnos t join core.usuarios u on u.id = t.cajero_id join core.sucursales s on s.id = t.sucursal_id
      where t.empresa_id = $1 and t.estado = 'cerrado' and t.cierre_id is null and t.cerrado_at > now() - interval '3 days' and (t.diferencia <= -1 or t.diferencia >= $2)
        and not exists (select 1 from af.alertas a where a.empresa_id = t.empresa_id and a.entidad = 'turno' and a.entidad_id = t.id::text)
      order by t.cerrado_at limit 50`, [empresa.id, R.umbral_sobrante])).rows;
  for (const c of turnos) {
    const dif = Number(c.diferencia);
    const base = { empresaId: empresa.id, sucursalId: c.sucursal_id, usuario: { id: c.cajero_id, nombre: c.cajero }, entidad: 'turno', entidadId: c.id };
    if (dif <= -1) {
      await crearAlerta(db, { ...base, tipo: 'cierre.descuadre', severidad: 'alta', titulo: `${c.cajero}: faltante de L ${L(Math.abs(dif))} al cerrar su turno en ${c.sucursal}`, detalle: { diferencia: dif, sucursal: c.sucursal } });
      const rec = (await db.query(`select count(*)::int as n from pos.turnos where empresa_id = $1 and cajero_id = $2 and estado = 'cerrado' and diferencia <= -1 and cerrado_at > now() - interval '7 days'`, [empresa.id, c.cajero_id])).rows[0].n;
      if (rec >= R.faltantes_reincidencia) {
        await crearAlerta(db, { ...base, entidad: null, entidadId: null, tipo: 'cierre.reincidencia', severidad: 'alta', titulo: `${c.cajero}: ${rec} cierres con faltante en 7 días`,
          detalle: { cierres_con_faltante: rec }, clave: `reinc:${c.cajero_id}:${fechaHN()}`, cadaMin: 1440 });
      }
    } else {
      await crearAlerta(db, { ...base, tipo: 'cierre.descuadre', severidad: 'media', titulo: `${c.cajero}: sobrante de L ${L(dif)} al cerrar su turno en ${c.sucursal}`, detalle: { diferencia: dif, sucursal: c.sucursal } });
    }
  }

  // Órdenes estacionadas
  const ordenes = (await db.query(
    `select v.id, v.numero_orden, v.total, v.created_at, v.sucursal_id, u.nombre as cajero, v.cajero_id
       from pos.ventas v left join core.usuarios u on u.id = v.cajero_id
      where v.empresa_id = $1 and v.estado = 'abierta' and v.total > 0 and v.created_at < now() - make_interval(mins => $2::int)
        and not exists (select 1 from af.alertas a where a.empresa_id = v.empresa_id and a.tipo = 'orden.estacionada' and a.entidad_id = v.id::text)
      limit 50`, [empresa.id, Math.ceil(R.minutos_orden_estacionada)])).rows;
  for (const o of ordenes) {
    const min = Math.round((Date.now() - new Date(o.created_at).getTime()) / 60000);
    await crearAlerta(db, { empresaId: empresa.id, sucursalId: o.sucursal_id, usuario: o.cajero_id ? { id: o.cajero_id, nombre: o.cajero } : null, entidad: 'venta', entidadId: o.id,
      tipo: 'orden.estacionada', severidad: 'media', titulo: `Orden #${o.numero_orden} abierta hace ${min} min sin cobrar (L ${L(o.total)})`,
      detalle: { orden: o.numero_orden, total: Number(o.total), cajero: o.cajero ?? '', minutos_abierta: min } });
  }

  // Integridad de la bitácora
  const b = await verificarBitacora(db, { forzar });
  if (b && b.integra === false) {
    await crearAlerta(db, { empresaId: empresa.id, tipo: 'bitacora.alterada', severidad: 'alta',
      titulo: 'La bitácora de auditoría fue alterada directamente en la base de datos',
      detalle: { primer_registro_alterado: b.primer_id_alterado, total_registros: b.total }, clave: 'bitacora', cadaMin: 360 });
  }
});
