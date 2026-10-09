import { Router } from 'express';
import { z } from 'zod';
import { fechaHN, sumarDias } from '@grupo/shared';
import { requierePermiso, resolverSucursal } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { ErrorHttp, noEncontrado, uuid, validar, fechaISO } from '../../lib/http.js';
import { ABIERTAS, ESTADOS_ALERTA, antifraudeActivo } from './alertas.js';
import { calcularAlertas } from './analisis.js';
import { guardarReglas, obtenerReglas } from './reglas.js';
import { revisarEmpresa, verificarBitacora, vigilarDispositivo, vigilarHorario } from './vigilancia.js';

const FECHA = (c) => `(${c} at time zone 'America/Tegucigalpa')::date`;
const redondear = (n) => Math.round(Number(n) * 100) / 100;

// Eventos que manda la app (navegación, carrito, búsquedas). Cualquier usuario con sesión;
// solo prefijos permitidos y detalle acotado: nadie puede usarlo para llenar la bitácora de basura.
const PREFIJOS_EVENTO = ['sesion.', 'pantalla.', 'orden.', 'factura.', 'reporte.', 'cierre.ver'];
const eventosPorMinuto = new Map();
function limitarDetalle(detalle) {
  const limpio = {};
  for (const [k, v] of Object.entries(detalle ?? {}).slice(0, 12)) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) limpio[String(k).slice(0, 40)] = typeof v === 'string' ? v.slice(0, 200) : v;
  }
  return limpio;
}

// Tipos de alerta que cuentan para la tendencia de riesgo de una persona.
const TIPOS_RIESGO = new Set(['cierre.descuadre', 'cierre.reincidencia', 'cierre.patron_desvio', 'descartar_orden', 'reimpresion_repetida', 'venta.reimpresion_repetida', 'venta.doble_factura',
  'tercera_edad.carne_repetido', 'tercera_edad.exceso', 'acceso.denegado', 'arqueo.descuadre', 'orden.estacionada', 'sesion.simultanea']);

const ACCIONES_USO = ['sesion.%', 'pantalla.%', 'orden.%', 'factura.%', 'reporte.%', 'cierre.ver%'];

export function rutasAntifraude({ db }) {
  const r = Router();

  /** Todo menos el reporte de eventos exige que la empresa tenga el módulo encendido. */
  const moduloActivo = (req, _res, next) => {
    if (!antifraudeActivo(req.ctx)) throw new ErrorHttp(404, 'El módulo Antifraude no está activo en esta empresa', 'modulo_inactivo');
    next();
  };
  const admin = [moduloActivo, requierePermiso('antifraude:ver')];
  const permitidas = (req) => req.ctx.sucursalIds;

  // ── Lo que necesita cualquier usuario: ¿hay vigilancia? ¿cuándo bloquear la pantalla? ──
  r.get('/sesion', async (req, res) => {
    if (!antifraudeActivo(req.ctx)) return res.json({ activo: false });
    const R = await obtenerReglas(db, req.ctx.empresa.id);
    res.json({ activo: true, minutos_bloqueo: req.ctx.rol === 'pesaje' ? 0 : req.ctx.rol === 'cajero' ? R.minutos_bloqueo_cajero : R.minutos_bloqueo_otros });
  });

  r.post('/evento', async (req, res) => {
    if (!antifraudeActivo(req.ctx)) return res.status(204).end();
    const { accion, detalle, sucursal_id } = validar(z.object({
      accion: z.string().max(60), detalle: z.record(z.any()).optional(), sucursal_id: uuid.optional().nullable(),
    }), req.body);
    if (!PREFIJOS_EVENTO.some((p) => accion.startsWith(p))) throw new ErrorHttp(400, 'Evento no permitido');
    const minuto = Math.floor(Date.now() / 60000);
    const clave = `${req.ctx.usuario.id}:${minuto}`;
    const n = (eventosPorMinuto.get(clave) ?? 0) + 1;
    eventosPorMinuto.set(clave, n);
    if (eventosPorMinuto.size > 5000) eventosPorMinuto.clear();
    if (n > 120) throw new ErrorHttp(429, 'Demasiados eventos');
    let sucursalId = null;
    if (sucursal_id) sucursalId = (await resolverSucursal(db, req.ctx, sucursal_id)).id;
    await auditar(db, req.ctx, accion, accion.split('.')[0], null, limitarDetalle(detalle), { sucursalId });
    await vigilarDispositivo(db, { empresa: req.ctx.empresa, usuario: { ...req.ctx.usuario, rol: req.ctx.rol }, dispositivo: req.headers['x-dispositivo'], navegador: req.headers['user-agent'], ip: req.ctx.ip });
    if (accion === 'sesion.inicio' || accion === 'pantalla.ver') await vigilarHorario(db, req.ctx, accion);
    res.status(204).end();
  });

  // ── Alertas ───────────────────────────────────────────────────────────────
  const revisar = (req) => revisarEmpresa(db, req.ctx.empresa);

  r.get('/alertas/pendientes', ...admin, async (req, res) => {
    await revisar(req);
    const { rows } = await db.query(
      `select count(*)::int as n, count(*) filter (where severidad = 'alta')::int as altas from af.alertas
        where empresa_id = $1 and estado = any($2::text[]) and ($3::uuid[] = '{}' or sucursal_id is null or sucursal_id = any($3::uuid[]))`,
      [req.ctx.empresa.id, ABIERTAS, permitidas(req)]);
    res.json({ pendientes: rows[0].n, altas: rows[0].altas });
  });

  // Para las notificaciones en vivo: alertas nuevas desde el último id visto.
  r.get('/alertas/nuevas', ...admin, async (req, res) => {
    const { desde_id } = validar(z.object({ desde_id: z.coerce.number().int().min(0).optional() }), req.query);
    const { rows } = await db.query(
      `select a.id, a.titulo, a.severidad, a.tipo, a.created_at, s.nombre as sucursal from af.alertas a left join core.sucursales s on s.id = a.sucursal_id
        where a.empresa_id = $1 and ($2::bigint is null or a.id > $2) and ($3::uuid[] = '{}' or a.sucursal_id is null or a.sucursal_id = any($3::uuid[]))
        order by a.id desc limit 10`,
      [req.ctx.empresa.id, desde_id ?? null, permitidas(req)]);
    res.json(rows);
  });

  r.get('/alertas', ...admin, async (req, res) => {
    const f = validar(z.object({
      estado: z.enum(ESTADOS_ALERTA).optional(), solo_pendientes: z.enum(['1', '0']).optional(),
      sucursal_id: uuid.optional(), desde: fechaISO.optional(), hasta: fechaISO.optional(),
    }), req.query);
    await revisar(req);
    const { rows } = await db.query(
      `select a.*, s.nombre as sucursal, rv.nombre as revisor
         from af.alertas a left join core.sucursales s on s.id = a.sucursal_id left join core.usuarios rv on rv.id = a.revisada_por
        where a.empresa_id = $1 and ($2::text is null or a.estado = $2) and ($3::boolean is not true or a.estado = any($4::text[]))
          and ($5::uuid is null or a.sucursal_id = $5) and ($6::date is null or ${FECHA('a.created_at')} >= $6::date) and ($7::date is null or ${FECHA('a.created_at')} <= $7::date)
          and ($8::uuid[] = '{}' or a.sucursal_id is null or a.sucursal_id = any($8::uuid[]))
        order by (a.estado = any($4::text[])) desc, a.created_at desc limit 300`,
      [req.ctx.empresa.id, f.estado ?? null, f.solo_pendientes === '1', ABIERTAS, f.sucursal_id ?? null, f.desde ?? null, f.hasta ?? null, permitidas(req)]);
    res.json(rows);
  });

  async function cambiarEstado(req, res, estado) {
    const id = validar(z.coerce.number().int().positive(), req.params.id);
    const { nota } = validar(z.object({ nota: z.string().trim().max(500).optional().nullable() }), req.body);
    const cerrada = estado === 'resuelta' || estado === 'falso_positivo';
    const { rows } = await db.query(
      `update af.alertas set estado = $3, revisada_por = $4, revisada_at = now(), nota_revision = coalesce($5, nota_revision)
        where id = $1 and empresa_id = $2 returning *`, [id, req.ctx.empresa.id, estado, req.ctx.usuario.id, nota || null]);
    if (!rows[0]) throw noEncontrado('Alerta no encontrada');
    await auditar(db, req.ctx, 'alerta_revisada', 'alerta', id, { titulo: rows[0].titulo, estado, nota: nota || null, cerrada }, { sucursalId: rows[0].sucursal_id });
    res.json(rows[0]);
  }
  r.put('/alertas/:id/revisar', ...admin, (req, res) => cambiarEstado(req, res, 'resuelta'));
  r.put('/alertas/:id/estado', ...admin, (req, res) => cambiarEstado(req, res, validar(z.enum(ESTADOS_ALERTA), req.body?.estado)));

  // Revisión manual (botón "Analizar"): fuerza la revisión sin esperar los 2 minutos.
  r.post('/revisar', ...admin, async (req, res) => {
    await revisarEmpresa(db, req.ctx.empresa, { forzar: true });
    res.json({ ok: true });
  });

  // ── Reglas y umbrales ─────────────────────────────────────────────────────
  r.get('/reglas', ...admin, async (req, res) => res.json(await obtenerReglas(db, req.ctx.empresa.id)));
  r.put('/reglas', ...admin, async (req, res) => {
    const { reglas, cambios } = await guardarReglas(db, req.ctx.empresa.id, req.body ?? {});
    await auditar(db, req.ctx, 'antifraude_reglas', 'config', 'antifraude', { cambios: cambios.join(' · ') });
    res.json(reglas);
  });

  // ── Análisis del periodo (patrones por cajero, huecos de numeración, descuadres) ──
  r.get('/analisis', ...admin, async (req, res) => {
    const f = validar(z.object({ desde: fechaISO.optional(), hasta: fechaISO.optional() }), req.query);
    const hoy = fechaHN();
    const desde = f.desde ?? sumarDias(hoy, -6), hasta = f.hasta ?? hoy;
    const reglas = await obtenerReglas(db, req.ctx.empresa.id);
    res.json({ desde, hasta, alertas: await calcularAlertas(db, { empresaId: req.ctx.empresa.id, sucursalIds: permitidas(req), desde, hasta, reglas }) });
  });

  // ── Arqueo sorpresa ───────────────────────────────────────────────────────
  // Conteo a mitad de turno SIN mostrar antes cuánto debería haber: se cuenta, se guarda y
  // recién entonces el sistema dice si cuadra.
  r.post('/arqueos', ...admin, async (req, res) => {
    const b = validar(z.object({
      sucursal_id: uuid, contado: z.coerce.number().finite().min(0).max(99_999_999),
      fondo_caja: z.union([z.coerce.number().finite().min(0).max(99_999_999), z.literal(''), z.null()]).optional(),
      nota: z.string().trim().max(300).optional().nullable(),
    }), req.body);
    const out = await db.tx(async (q) => {
      const suc = await resolverSucursal(q, req.ctx, b.sucursal_id);
      const emp = req.ctx.empresa.id;
      // Desde el último cierre de caja de la sucursal (o desde el inicio del día).
      const ult = (await q.query(`select max(cerrado_at) as t from pos.turnos where empresa_id = $1 and sucursal_id = $2 and estado = 'cerrado'`, [emp, suc.id])).rows[0].t;
      const inicioDia = (await q.query(`select (($1::date)::timestamp at time zone 'America/Tegucigalpa') as t`, [fechaHN()])).rows[0].t;
      const desde = ult && new Date(ult) > new Date(inicioDia) ? ult : inicioDia;
      const abiertos = (await q.query(`select coalesce(sum(fondo_inicial),0)::numeric as fondo from pos.turnos where empresa_id = $1 and sucursal_id = $2 and estado = 'abierto'`, [emp, suc.id])).rows[0].fondo;
      const fondo = b.fondo_caja === undefined || b.fondo_caja === '' || b.fondo_caja === null ? Number(abiertos) : Number(b.fondo_caja);
      const efectivo = (await q.query(
        `select coalesce(sum(p.monto),0)::numeric as m from pos.venta_pagos p join pos.formas_pago f on f.id = p.forma_pago_id join pos.ventas v on v.id = p.venta_id
          where v.empresa_id = $1 and v.sucursal_id = $2 and v.estado = 'pagada' and f.tipo = 'efectivo' and v.fecha_emision >= $3`, [emp, suc.id, desde])).rows[0].m;
      const mov = (await q.query(
        `select coalesce(sum(monto) filter (where tipo = 'salida'),0)::numeric as salidas, coalesce(sum(monto) filter (where tipo = 'ingreso'),0)::numeric as ingresos
           from pos.movimientos_caja where empresa_id = $1 and sucursal_id = $2 and created_at >= $3`, [emp, suc.id, desde])).rows[0];
      const esperado = redondear(fondo + Number(efectivo) + Number(mov.ingresos) - Number(mov.salidas));
      const diferencia = redondear(b.contado - esperado);
      const cajeros = (await q.query(
        `select string_agg(distinct u.nombre, ', ') as n from core.usuarios u where u.id in (
           select cajero_id from pos.ventas where empresa_id = $1 and sucursal_id = $2 and estado = 'pagada' and fecha_emision >= $3
           union select cajero_id from pos.turnos where empresa_id = $1 and sucursal_id = $2 and estado = 'abierto')`, [emp, suc.id, desde])).rows[0].n;
      const a = (await q.query(
        `insert into af.arqueos (empresa_id, sucursal_id, usuario_id, desde, fondo_caja, efectivo_sistema, salidas, esperado, contado, diferencia, cajeros_turno, nota)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
        [emp, suc.id, req.ctx.usuario.id, desde, fondo, Number(efectivo) + Number(mov.ingresos), Number(mov.salidas), esperado, b.contado, diferencia, cajeros, b.nota || null])).rows[0];
      await auditar(q, req.ctx, 'arqueo_sorpresa', 'arqueo', a.id, { esperado, contado: b.contado, diferencia, cajeros }, { sucursalId: suc.id });
      if (Math.abs(diferencia) >= 1) {
        await q.query(
          `insert into af.alertas (empresa_id, tipo, severidad, titulo, detalle, sucursal_id, usuario_id, usuario_nombre, entidad, entidad_id)
           values ($1,'arqueo.descuadre',$2,$3,$4::jsonb,$5,$6,$7,'arqueo',$8)`,
          [emp, diferencia <= -1 ? 'alta' : 'media', `Arqueo sorpresa en ${suc.nombre}: ${diferencia < 0 ? 'faltan' : 'sobran'} L ${Math.abs(diferencia).toFixed(2)}`,
            JSON.stringify({ esperado, contado: b.contado, diferencia, cajeros_en_turno: cajeros ?? '', conto: req.ctx.usuario.nombre }), suc.id, req.ctx.usuario.id, req.ctx.usuario.nombre, String(a.id)]);
      }
      return { ...a, sucursal: suc.nombre };
    });
    res.status(201).json(out);
  });

  r.get('/arqueos', ...admin, async (req, res) => {
    const { rows } = await db.query(
      `select a.*, s.nombre as sucursal, u.nombre as usuario from af.arqueos a join core.sucursales s on s.id = a.sucursal_id left join core.usuarios u on u.id = a.usuario_id
        where a.empresa_id = $1 and ($2::uuid[] = '{}' or a.sucursal_id = any($2::uuid[])) order by a.created_at desc limit 100`, [req.ctx.empresa.id, permitidas(req)]);
    res.json(rows);
  });

  // ── Personas de la empresa y línea de tiempo de un turno ──────────────────
  r.get('/usuarios', ...admin, async (req, res) => {
    const { rows } = await db.query(
      `select u.id, u.nombre, coalesce(a.rol, 'dueno') as rol from core.usuarios u left join core.accesos a on a.usuario_id = u.id and a.empresa_id = $1 and a.activo
        where u.activo and (a.usuario_id is not null or u.es_dueno_grupo) order by u.nombre`, [req.ctx.empresa.id]);
    res.json(rows);
  });

  r.get('/linea-tiempo', ...admin, async (req, res) => {
    const { usuario_id, fecha } = validar(z.object({ usuario_id: uuid, fecha: fechaISO }), req.query);
    const emp = req.ctx.empresa.id;
    const [eventos, ventas, reimp] = await Promise.all([
      db.query(`select a.id, a.created_at as momento, a.accion, a.detalle, a.entidad_id, a.ip, s.nombre as sucursal from core.auditoria a left join core.sucursales s on s.id = a.sucursal_id
                 where a.empresa_id = $1 and a.usuario_id = $2 and ${FECHA('a.created_at')} = $3::date order by a.id`, [emp, usuario_id, fecha]),
      db.query(`select v.id, v.numero_factura, v.total, v.estado, v.fecha_emision, v.tercera_edad_identidad from pos.ventas v
                 where v.empresa_id = $1 and v.cajero_id = $2 and v.estado in ('pagada','anulada') and v.numero_factura is not null and ${FECHA('v.fecha_emision')} = $3::date order by v.fecha_emision`, [emp, usuario_id, fecha]),
      db.query(`select count(*)::int as n from core.auditoria where empresa_id = $1 and usuario_id = $2 and accion = 'factura_reimpresa' and ${FECHA('created_at')} = $3::date`, [emp, usuario_id, fecha]),
    ]);
    const facturadas = new Set(eventos.rows.filter((e) => e.accion === 'venta_cobrada').map((e) => e.entidad_id));
    const items = [
      ...eventos.rows.map((e) => ({ momento: e.momento, accion: e.accion, detalle: e.detalle, sucursal: e.sucursal ?? '', ip: e.ip })),
      ...ventas.rows.filter((v) => !facturadas.has(v.id)).map((v) => ({ momento: v.fecha_emision, accion: 'venta_cobrada', detalle: { factura: v.numero_factura, total: Number(v.total) }, sucursal: '' })),
    ].sort((a, b) => new Date(a.momento) - new Date(b.momento));
    const vigentes = ventas.rows.filter((v) => v.estado === 'pagada');
    res.json({
      resumen: {
        facturas: vigentes.length, total: redondear(vigentes.reduce((s, v) => s + Number(v.total), 0)),
        anuladas: ventas.rows.length - vigentes.length, reimpresiones: reimp.rows[0].n, tercera_edad: vigentes.filter((v) => v.tercera_edad_identidad).length,
        primer_movimiento: items[0]?.momento ?? null, ultimo_movimiento: items[items.length - 1]?.momento ?? null,
      },
      items,
    });
  });

  // ── Tendencia de riesgo: últimas 4 semanas por persona ────────────────────
  r.get('/tendencia', ...admin, async (req, res) => {
    const { rows } = await db.query(
      `select tipo, created_at, usuario_id, usuario_nombre from af.alertas where empresa_id = $1 and created_at > now() - interval '28 days' and usuario_id is not null and estado <> 'falso_positivo' order by id`,
      [req.ctx.empresa.id]);
    const por = new Map();
    for (const a of rows) {
      if (!TIPOS_RIESGO.has(a.tipo)) continue;
      const semana = Math.min(3, Math.floor((Date.now() - new Date(a.created_at).getTime()) / (7 * 86400000)));
      const f = por.get(a.usuario_id) ?? { usuario_id: a.usuario_id, nombre: a.usuario_nombre ?? '', semanas: [0, 0, 0, 0], total: 0 };
      f.semanas[3 - semana] += 1; f.total += 1;
      por.set(a.usuario_id, f);
    }
    res.json([...por.values()].sort((a, b) => b.total - a.total));
  });

  // ── Indicadores por cajero y huecos sin facturar ──────────────────────────
  r.get('/indicadores', ...admin, async (req, res) => {
    const { desde, hasta, sucursal_id } = validar(z.object({ desde: fechaISO, hasta: fechaISO, sucursal_id: uuid.optional() }), req.query);
    const emp = req.ctx.empresa.id;
    const R = await obtenerReglas(db, emp);
    const sp = [emp, permitidas(req), sucursal_id ?? null, desde, hasta];
    const filtroSuc = `($2::uuid[] = '{}' or %S = any($2::uuid[])) and ($3::uuid is null or %S = $3)`;
    const fsV = filtroSuc.replaceAll('%S', 'v.sucursal_id');

    const [ventas, auditoria, cierres, nombres, sucursales] = await Promise.all([
      db.query(
        `select v.id, v.cajero_id, v.sucursal_id, v.estado, v.numero_factura, v.total, v.descuento, v.fecha_emision,
                (select coalesce(sum(p.monto),0)::numeric from pos.venta_pagos p join pos.formas_pago f on f.id = p.forma_pago_id where p.venta_id = v.id and f.tipo = 'efectivo') as efectivo,
                (select count(*)::int from pos.detalle_venta d where d.venta_id = v.id and d.descuento > 0) as lineas_desc,
                (select count(*)::int from pos.detalle_venta d where d.venta_id = v.id and d.descuento_porcentaje = 25) as d25,
                (select count(*)::int from pos.detalle_venta d where d.venta_id = v.id and d.descuento_porcentaje = 10) as d10
           from pos.ventas v where v.empresa_id = $1 and ${fsV} and v.estado in ('pagada','anulada')
            and ${FECHA('coalesce(v.fecha_emision, v.anulada_at, v.created_at)')} between $4::date and $5::date`, sp),
      db.query(
        `select a.id, a.created_at, a.usuario_id, a.usuario_nombre, a.accion, a.entidad_id, a.detalle from core.auditoria a
          where a.empresa_id = $1 and ($2::uuid[] = '{}' or a.sucursal_id is null or a.sucursal_id = any($2::uuid[])) and ($3::uuid is null or a.sucursal_id = $3 or a.sucursal_id is null)
            and a.accion in ('factura_reimpresa','orden.quitar_producto','acceso.denegado','pantalla.ver','sesion.inicio','orden_descartada')
            and ${FECHA('a.created_at')} between $4::date and $5::date order by a.id`, sp),
      db.query(
        `select c.cajero_id, c.diferencia_efectivo as diferencia from pos.cierres_caja c where c.empresa_id = $1 and ($2::uuid[] = '{}' or c.sucursal_id = any($2::uuid[])) and ($3::uuid is null or c.sucursal_id = $3)
            and c.diferencia_efectivo <= -1 and ${FECHA('c.fecha_fin')} between $4::date and $5::date
          union all
         select t.cajero_id, t.diferencia from pos.turnos t where t.empresa_id = $1 and ($2::uuid[] = '{}' or t.sucursal_id = any($2::uuid[])) and ($3::uuid is null or t.sucursal_id = $3)
            and t.estado = 'cerrado' and t.cierre_id is null and t.diferencia <= -1 and ${FECHA('t.cerrado_at')} between $4::date and $5::date`, sp),
      db.query('select id, nombre from core.usuarios'),
      db.query('select id, nombre from core.sucursales where empresa_id = $1', [emp]),
    ]);
    const nombreDe = new Map(nombres.rows.map((u) => [u.id, u.nombre]));
    const porCajero = new Map();
    const fila = (id) => {
      if (!porCajero.has(id)) {
        porCajero.set(id, { cajero_id: id, nombre: nombreDe.get(id) ?? 'Desconocido', facturas: 0, total: 0, efectivo: 0, con_descuento: 0, desc_25: 0, desc_10: 0, monto_descuentos: 0,
          anuladas: 0, monto_anulado: 0, descartadas: 0, monto_descartado: 0, quitados: 0, monto_quitado: 0, reimpresiones: 0, faltantes: 0, monto_faltante: 0, accesos_denegados: 0, fuera_horario: 0, pantallas: 0 });
      }
      return porCajero.get(id);
    };
    for (const v of ventas.rows) {
      if (!v.cajero_id) continue;
      const f = fila(v.cajero_id);
      if (v.estado === 'anulada') {
        if (v.numero_factura) { f.anuladas += 1; f.monto_anulado += Number(v.total); }       // factura emitida y anulada
        else { f.descartadas += 1; f.monto_descartado += Number(v.total); }                  // orden descartada sin cobrar
        continue;
      }
      f.facturas += 1; f.total += Number(v.total); f.efectivo += Number(v.efectivo);
      if (v.lineas_desc > 0) f.con_descuento += 1;
      f.desc_25 += v.d25; f.desc_10 += v.d10; f.monto_descuentos += Number(v.descuento);
    }
    const recientes = [];
    const horaHn = (iso) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Tegucigalpa', hour: '2-digit', hour12: false }).format(new Date(iso))) % 24;
    for (const e of auditoria.rows) {
      if (!e.usuario_id) continue;
      const f = fila(e.usuario_id);
      const d = e.detalle ?? {};
      if (e.accion === 'factura_reimpresa') f.reimpresiones += 1;
      else if (e.accion === 'orden_descartada') { f.descartadas += 1; f.monto_descartado += Number(d.total ?? 0); }
      else if (e.accion === 'orden.quitar_producto') { f.quitados += Number(d.cantidad ?? 1); f.monto_quitado += Number(d.monto ?? 0); }
      else if (e.accion === 'acceso.denegado') f.accesos_denegados += 1;
      else if (e.accion === 'pantalla.ver') f.pantallas += 1;
      if ((e.accion === 'sesion.inicio' || e.accion === 'pantalla.ver') && (horaHn(e.created_at) < R.hora_apertura || horaHn(e.created_at) >= R.hora_cierre)) f.fuera_horario += 1;
      if (['factura_reimpresa', 'orden_descartada', 'orden.quitar_producto', 'acceso.denegado'].includes(e.accion)) recientes.push(e);
    }
    for (const c of cierres.rows) { const f = fila(c.cajero_id); f.faltantes += 1; f.monto_faltante += Math.abs(Number(c.diferencia)); }

    // Señales: cada cajero contra el promedio del grupo, para no marcar a todos en un día de muchos descuentos legítimos.
    const filas = [...porCajero.values()].filter((f) => f.facturas + f.anuladas + f.descartadas + f.quitados + f.accesos_denegados + f.pantallas + f.reimpresiones + f.faltantes > 0);
    const conVentas = filas.filter((f) => f.facturas > 0);
    const promedio = (fn) => (conVentas.length ? conVentas.reduce((s, f) => s + fn(f), 0) / conVentas.length : 0);
    const promDesc = promedio((f) => f.con_descuento / f.facturas), promAnul = promedio((f) => f.anuladas / (f.facturas || 1));
    for (const f of filas) {
      const s = [];
      const pctDesc = f.facturas ? f.con_descuento / f.facturas : 0;
      if (f.facturas >= 10 && pctDesc > Math.max(0.15, promDesc * 2)) s.push({ nivel: 'alta', texto: `${Math.round(pctDesc * 100)}% de sus facturas llevan descuento` });
      if (f.anuladas >= 2 && f.anuladas / (f.facturas || 1) > promAnul * 1.5) s.push({ nivel: 'alta', texto: `${f.anuladas} facturas anuladas` });
      if (f.descartadas >= 5 || f.monto_descartado > Math.max(500, f.total * 0.03)) s.push({ nivel: 'media', texto: `${f.descartadas} órdenes descartadas (L ${redondear(f.monto_descartado)})` });
      if (f.quitados >= 8 || f.monto_quitado > Math.max(400, f.total * 0.02)) s.push({ nivel: 'media', texto: `${f.quitados} productos quitados de órdenes (L ${redondear(f.monto_quitado)})` });
      if (f.reimpresiones >= 3) s.push({ nivel: 'media', texto: `${f.reimpresiones} reimpresiones de facturas` });
      if (f.faltantes >= 1) s.push({ nivel: 'alta', texto: `${f.faltantes} cierre(s) con faltante (L ${redondear(f.monto_faltante)})` });
      if (f.accesos_denegados >= 1) s.push({ nivel: 'media', texto: `${f.accesos_denegados} intento(s) de entrar a funciones sin permiso` });
      if (f.fuera_horario >= 1) s.push({ nivel: 'baja', texto: `${f.fuera_horario} uso(s) del sistema fuera de horario` });
      f.senales = s;
      f.riesgo = s.reduce((acc, x) => acc + (x.nivel === 'alta' ? 3 : x.nivel === 'media' ? 2 : 1), 0);
      for (const k of Object.keys(f)) if (typeof f[k] === 'number' && !Number.isInteger(f[k])) f[k] = redondear(f[k]);
      f.ticket_promedio = f.facturas ? redondear(f.total / f.facturas) : 0;
      f.pct_efectivo = f.total ? Math.round((f.efectivo / f.total) * 100) : 0;
      f.pct_descuento = Math.round(pctDesc * 100);
    }
    filas.sort((a, b) => b.riesgo - a.riesgo || b.total - a.total);

    // Huecos: ratos largos sin facturar con la tienda abierta. Puede ser un rato flojo… o ventas sin facturar.
    const nombreSuc = new Map(sucursales.rows.map((s) => [s.id, s.nombre]));
    const porDia = new Map();
    for (const v of ventas.rows) {
      if (v.estado !== 'pagada') continue;
      const dia = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Tegucigalpa' }).format(new Date(v.fecha_emision));
      const k = `${v.sucursal_id}|${dia}`;
      (porDia.get(k) ?? porDia.set(k, []).get(k)).push(v.fecha_emision);
    }
    const huecos = [];
    const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    for (const [k, fechas] of porDia) {
      if (fechas.length < 5) continue;
      const [sid, dia] = k.split('|');
      const mins = fechas.map((iso) => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Tegucigalpa', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso)); return (Number(p.find((x) => x.type === 'hour').value) % 24) * 60 + Number(p.find((x) => x.type === 'minute').value); }).sort((a, b) => a - b);
      const abre = R.hueco_desde_hora * 60, cierra = R.hueco_hasta_hora * 60;
      const puntos = [abre, ...mins.filter((m) => m >= abre && m <= cierra), cierra];
      for (let i = 1; i < puntos.length; i++) {
        const gap = puntos[i] - puntos[i - 1];
        if (gap >= R.minutos_hueco) huecos.push({ sucursal: nombreSuc.get(sid) ?? '', fecha: dia, desde: hhmm(puntos[i - 1]), hasta: hhmm(puntos[i]), minutos: gap, facturas_dia: fechas.length });
      }
    }
    huecos.sort((a, b) => b.minutos - a.minutos);

    res.json({
      cajeros: filas, huecos: huecos.slice(0, 60),
      recientes: recientes.sort((a, b) => b.id - a.id).slice(0, 100).map((e) => ({ id: e.id, created_at: e.created_at, usuario_nombre: e.usuario_nombre, accion: e.accion, detalle: e.detalle })),
      totales: { facturas: ventas.rows.filter((v) => v.estado === 'pagada').length, eventos: auditoria.rows.length },
    });
  });

  // ── Uso del sistema: bitácora de pantallas y sesiones, dispositivos ────────
  r.get('/uso', ...admin, async (req, res) => {
    const f = validar(z.object({ desde: fechaISO.optional(), hasta: fechaISO.optional(), usuario_id: uuid.optional() }), req.query);
    const hoy = fechaHN();
    const p = [req.ctx.empresa.id, f.desde ?? sumarDias(hoy, -6), f.hasta ?? hoy, f.usuario_id ?? null, ACCIONES_USO];
    const donde = `a.empresa_id = $1 and ${FECHA('a.created_at')} between $2::date and $3::date and ($4::uuid is null or a.usuario_id = $4) and a.accion like any($5::text[])`;
    const [eventos, pantallas, sesiones] = await Promise.all([
      db.query(`select a.id, a.created_at, a.usuario_nombre, a.accion, a.detalle, a.ip, s.nombre as sucursal from core.auditoria a left join core.sucursales s on s.id = a.sucursal_id where ${donde} order by a.id desc limit 200`, p),
      db.query(`select coalesce(a.usuario_nombre, 'Sistema') as usuario, coalesce(a.detalle->>'pantalla', '(sin nombre)') as pantalla, count(*)::int as veces, max(a.created_at) as ultima
                  from core.auditoria a where ${donde} and a.accion = 'pantalla.ver' group by 1, 2 order by veces desc limit 100`, p),
      db.query(`select coalesce(a.usuario_nombre, 'Sistema') as usuario, count(*) filter (where a.accion = 'sesion.inicio')::int as inicios, count(*) filter (where a.accion = 'sesion.bloqueo')::int as bloqueos,
                       count(*) filter (where a.accion = 'sesion.desbloqueo_fallido')::int as desbloqueos_fallidos, count(*) filter (where a.accion = 'pantalla.ver')::int as pantallas, min(a.created_at) as primero, max(a.created_at) as ultimo
                  from core.auditoria a where ${donde} group by 1 order by 1`, p),
    ]);
    const fallidos = await db.query(
      `select a.id, a.created_at, a.accion, a.detalle->>'email' as acceso, a.ip from core.auditoria a
        where a.empresa_id = $1 and a.accion in ('login_fallido','pin_fallido') and ${FECHA('a.created_at')} between $2::date and $3::date order by a.id desc limit 100`, p.slice(0, 3));
    res.json({ eventos: eventos.rows, pantallas: pantallas.rows, sesiones: sesiones.rows, login_fallidos: fallidos.rows });
  });

  r.get('/dispositivos', ...admin, async (req, res) => {
    const { rows } = await db.query(
      `select d.usuario_id, u.nombre as usuario, d.dispositivo_id, d.primera_vez, d.ultima_vez, d.navegador, d.ip,
              (select count(*)::int from af.dispositivos x where x.empresa_id = d.empresa_id and x.usuario_id = d.usuario_id) as dispositivos_usuario
         from af.dispositivos d join core.usuarios u on u.id = d.usuario_id where d.empresa_id = $1 order by d.ultima_vez desc limit 200`, [req.ctx.empresa.id]);
    res.json(rows.map((d) => ({ ...d, dispositivo_id: d.dispositivo_id.slice(0, 8) })));
  });

  // ── Integridad de la bitácora (cadena de hashes) ──────────────────────────
  r.get('/integridad', ...admin, async (req, res) => {
    res.json(await verificarBitacora(db, { forzar: true }));
  });

  return r;
}
