import { Router } from 'express';
import { z } from 'zod';
import { fechaHN, sumarDias } from '@grupo/shared';
import { requierePermiso, resolverSucursal } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { conflicto, malaPeticion, noEncontrado, uuid, validar, dinero, fechaISO } from '../../lib/http.js';
import { BANCOS_POR_DEFECTO, DENOMINACIONES, calcularCuadre, hayDescuadre, patrones, round2, sinSistema, totalConteo } from './cierre-calculo.js';
import { formatearCierre } from './cierre-ticket.js';
import { resumenTurno } from './turnos.js';

const instante = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'fecha inválida').transform((s) => new Date(s));
const BASE = `v.empresa_id = $1 and v.sucursal_id = $2 and v.fecha_emision >= $3 and v.fecha_emision <= $4`;

/** Configuración del cierre de la empresa: bancos de los POS y si el cajero cierra a ciegas. */
export async function configCierre(q, empresaId) {
  const v = (await q.query(`select valor from core.config where empresa_id = $1 and clave = 'cierre'`, [empresaId])).rows[0]?.valor ?? {};
  const bancos = Array.isArray(v.bancos) && v.bancos.length ? v.bancos.map(String) : BANCOS_POR_DEFECTO;
  return { bancos, cierre_ciego: v.cierre_ciego !== false, denominaciones: DENOMINACIONES };
}

/** Lo que dice el sistema de una sucursal entre dos instantes: totales por forma de pago, rango de facturas, caja chica. */
export async function sistemaDelRango(q, { empresaId, sucursalId, desde, hasta }) {
  const a = [empresaId, sucursalId, desde, hasta];
  const [tot, desdeF, hastaF, pagos, caja, abiertas, turnos] = await Promise.all([
    q.query(`select count(*) filter (where v.estado = 'pagada')::int as facturas, coalesce(sum(v.total) filter (where v.estado = 'pagada'),0)::numeric as total,
                    count(*) filter (where v.estado = 'anulada')::int as anuladas, coalesce(sum(v.total) filter (where v.estado = 'anulada'),0)::numeric as monto_anulado
               from pos.ventas v where ${BASE}`, a),
    q.query(`select numero_factura from pos.ventas v where ${BASE} and v.estado in ('pagada','anulada') and v.numero_factura is not null order by v.correlativo asc limit 1`, a),
    q.query(`select numero_factura from pos.ventas v where ${BASE} and v.estado in ('pagada','anulada') and v.numero_factura is not null order by v.correlativo desc limit 1`, a),
    // venta_pagos guarda el monto NETO (sin el cambio): el efectivo ya viene limpio.
    q.query(`select f.nombre, f.tipo, count(distinct v.id)::int as facturas, coalesce(sum(p.monto),0)::numeric as monto
               from pos.venta_pagos p join pos.formas_pago f on f.id = p.forma_pago_id join pos.ventas v on v.id = p.venta_id
              where ${BASE} and v.estado = 'pagada' group by f.nombre, f.tipo, f.orden order by f.orden, f.nombre`, a),
    q.query(`select tipo, coalesce(sum(monto),0)::numeric as monto from pos.movimientos_caja
              where empresa_id = $1 and sucursal_id = $2 and created_at >= $3 and created_at <= $4
                and fecha = (created_at at time zone 'America/Tegucigalpa')::date group by tipo`, a),   // los movimientos con fecha pasada no entran en el efectivo del día
    q.query(`select count(*)::int as n from pos.ventas where empresa_id = $1 and sucursal_id = $2 and estado = 'abierta'`, [empresaId, sucursalId]),
    q.query(`select t.id, u.nombre as cajero, t.abierto_at, t.fondo_inicial from pos.turnos t join core.usuarios u on u.id = t.cajero_id
              where t.sucursal_id = $1 and t.estado = 'abierto' order by t.abierto_at`, [sucursalId]),
  ]);
  const por = (tipo) => round2(pagos.rows.filter((x) => x.tipo === tipo).reduce((s, x) => s + x.monto, 0));
  const mov = (tipo) => round2(caja.rows.find((x) => x.tipo === tipo)?.monto ?? 0);
  return {
    cantidad_facturas: tot.rows[0].facturas, factura_desde: desdeF.rows[0]?.numero_factura ?? null, factura_hasta: hastaF.rows[0]?.numero_factura ?? null,
    total_ventas: round2(tot.rows[0].total), anuladas: tot.rows[0].anuladas, monto_anulado: round2(tot.rows[0].monto_anulado),
    efectivo: por('efectivo'), tarjeta: por('tarjeta'), transferencia: por('transferencia'), otros: round2(por('credito') + por('otro')),
    formas: pagos.rows.map((p) => ({ nombre: p.nombre, tipo: p.tipo, facturas: p.facturas, monto: round2(p.monto) })),
    salidas_sugeridas: mov('salida'), ingresos_sugeridos: mov('ingreso'),
    ordenes_abiertas: abiertas.rows[0].n, turnos_abiertos: turnos.rows,
  };
}

/** Detalle para el ticket y la pantalla: las de tarjeta/transferencia una por una, anuladas y descuentos. */
export async function desgloseCierre(q, { empresaId, sucursalId, desde, hasta }) {
  const a = [empresaId, sucursalId, desde, hasta];
  const pagos = (tipo) => q.query(
    `select v.numero_factura as numero, p.monto, p.referencia, f.nombre as forma from pos.venta_pagos p join pos.formas_pago f on f.id = p.forma_pago_id join pos.ventas v on v.id = p.venta_id
      where ${BASE} and v.estado = 'pagada' and f.tipo = '${tipo}' order by v.correlativo, v.fecha_emision`, a);
  const [tar, trf, anu, desc, formas] = await Promise.all([
    pagos('tarjeta'), pagos('transferencia'),
    q.query(`select v.numero_factura as numero, v.total as monto from pos.ventas v where ${BASE} and v.estado = 'anulada' order by v.correlativo`, a),
    q.query(`select d.descuento_porcentaje as porcentaje, count(*)::int as lineas, sum(d.descuento)::numeric as monto
               from pos.detalle_venta d join pos.ventas v on v.id = d.venta_id where ${BASE} and v.estado = 'pagada' and d.descuento > 0 group by 1 order by 1`, a),
    q.query(`select f.nombre, count(distinct v.id)::int as facturas, sum(p.monto)::numeric as monto from pos.venta_pagos p join pos.formas_pago f on f.id = p.forma_pago_id
               join pos.ventas v on v.id = p.venta_id where ${BASE} and v.estado = 'pagada' group by f.nombre, f.orden order by f.orden, f.nombre`, a),
  ]);
  return { formas: formas.rows, tarjeta: tar.rows, transferencia: trf.rows, anuladas: anu.rows, descuentos: desc.rows };
}

const SELECT_CIERRE = `select c.*, s.nombre as sucursal, s.color as sucursal_color, u.nombre as cajero
                         from pos.cierres_caja c join core.sucursales s on s.id = c.sucursal_id join core.usuarios u on u.id = c.cajero_id`;

export function rutasCierres({ db }) {
  const r = Router();
  const esCiego = (ctx, cfg) => ctx.rol === 'cajero' && cfg.cierre_ciego;
  const ver = requierePermiso('pos:caja', 'pos:reportes');

  async function cierreVisible(q, ctx, id) {
    const c = (await q.query(`${SELECT_CIERRE} where c.id = $1 and c.empresa_id = $2`, [id, ctx.empresa.id])).rows[0];
    if (!c) throw noEncontrado('Cierre no encontrado');
    if (ctx.sucursalIds.length && !ctx.sucursalIds.includes(c.sucursal_id)) throw noEncontrado('Cierre no encontrado');
    if (ctx.rol === 'cajero' && c.cajero_id !== ctx.usuario.id) throw noEncontrado('Cierre no encontrado');
    return c;
  }

  // Dónde arranca el siguiente cierre de la sucursal y qué fondo sugerir.
  r.get('/ultimo', requierePermiso('pos:caja'), async (req, res) => {
    const { sucursal_id } = validar(z.object({ sucursal_id: uuid.optional() }), req.query);
    const suc = await resolverSucursal(db, req.ctx, sucursal_id);
    const u = (await db.query('select fecha_fin, fondo_caja from pos.cierres_caja where sucursal_id = $1 order by fecha_fin desc limit 1', [suc.id])).rows[0] ?? null;
    res.json({ sucursal_id: suc.id, ultimo: u, config: await configCierre(db, req.ctx.empresa.id) });
  });

  // Cuadre en vivo del rango (el cajero ciego solo recibe lo que no revela el esperado).
  r.get('/resumen', requierePermiso('pos:caja'), async (req, res) => {
    const f = validar(z.object({ sucursal_id: uuid.optional(), desde: instante, hasta: instante }), req.query);
    if (f.hasta <= f.desde) throw malaPeticion('La hora de cierre debe ser posterior a la de apertura');
    const suc = await resolverSucursal(db, req.ctx, f.sucursal_id);
    const cfg = await configCierre(db, req.ctx.empresa.id);
    const s = await sistemaDelRango(db, { empresaId: req.ctx.empresa.id, sucursalId: suc.id, desde: f.desde, hasta: f.hasta });
    if (esCiego(req.ctx, cfg)) {
      const { cantidad_facturas, factura_desde, factura_hasta, salidas_sugeridas, ingresos_sugeridos, ordenes_abiertas } = s;
      return res.json({ ciego: true, cantidad_facturas, factura_desde, factura_hasta, salidas_sugeridas, ingresos_sugeridos, ordenes_abiertas });
    }
    res.json({ ciego: false, ...s });
  });

  r.post('/', requierePermiso('pos:caja'), async (req, res) => {
    const b = validar(z.object({
      sucursal_id: uuid.optional(), fecha_inicio: instante, fecha_fin: instante,
      pos: z.record(z.string(), dinero).default({}),
      efectivo_contado: dinero, fondo_caja: dinero.default(0), salidas: dinero.default(0), ingresos: dinero.default(0),
      conteo: z.record(z.string(), z.coerce.number().int().min(0).max(100000)).optional().nullable(),
      observaciones: z.string().trim().max(500).optional().nullable(),
    }), req.body);
    if (b.fecha_fin <= b.fecha_inicio) throw malaPeticion('La hora de cierre debe ser posterior a la de apertura');
    if (b.fecha_fin.getTime() > Date.now() + 5 * 60_000) throw malaPeticion('La hora de cierre no puede estar en el futuro');
    const ctx = req.ctx;
    const out = await db.tx(async (q) => {
      const suc = await resolverSucursal(q, ctx, b.sucursal_id);
      const cfg = await configCierre(q, ctx.empresa.id);
      const ciego = esCiego(ctx, cfg);
      // Sin montos de los POS es lo normal (la pantalla solo pide Fondo de caja y Efectivo total); si vienen, tienen que venir todos.
      const conPos = Object.keys(b.pos).length > 0;
      if (conPos) for (const banco of cfg.bancos) if (!(banco in b.pos)) throw malaPeticion(`Falta el cierre del POS ${banco} (usa 0 si no hubo)`);
      for (const banco of Object.keys(b.pos)) if (!cfg.bancos.includes(banco)) throw malaPeticion(`El POS «${banco}» no está configurado`);
      if (b.conteo) {
        const validas = new Set(DENOMINACIONES.map((d) => String(d.valor)));
        for (const k of Object.keys(b.conteo)) if (!validas.has(k)) throw malaPeticion(`Denominación inválida: ${k}`);
        if (Math.abs(totalConteo(b.conteo) - round2(b.efectivo_contado)) > 0.005) throw malaPeticion(`El conteo de billetes y monedas suma L ${totalConteo(b.conteo).toFixed(2)} y no coincide con el efectivo contado`);
      }
      // Serializa los cierres de una misma sucursal: dos personas no pueden cerrar el mismo rango a la vez.
      await q.query('select id from core.sucursales where id = $1 for update', [suc.id]);
      const solape = (await q.query(
        'select fecha_inicio, fecha_fin from pos.cierres_caja where sucursal_id = $1 and fecha_inicio < $3 and fecha_fin > $2 limit 1', [suc.id, b.fecha_inicio, b.fecha_fin])).rows[0];
      if (solape) {
        const fmt = (d) => new Date(d).toLocaleString('es-HN', { timeZone: 'America/Tegucigalpa' });
        throw conflicto(`Ya existe un cierre en ese rango (del ${fmt(solape.fecha_inicio)} al ${fmt(solape.fecha_fin)}). Ajusta las fechas para no contar las mismas facturas dos veces.`);
      }

      // El sistema se recalcula aquí; nunca se toma lo que mande la pantalla.
      const s = await sistemaDelRango(q, { empresaId: ctx.empresa.id, sucursalId: suc.id, desde: b.fecha_inicio, hasta: b.fecha_fin });
      const cuadre = calcularCuadre({ tarjeta: s.tarjeta, efectivo: s.efectivo }, { pos_bancos: conPos ? b.pos : null, fondo_caja: b.fondo_caja, salidas: b.salidas, ingresos: b.ingresos, efectivo_contado: b.efectivo_contado });
      const noCuadra = hayDescuadre(cuadre);
      const obs = (b.observaciones ?? '').trim();
      if (noCuadra && !ciego && !obs) throw malaPeticion('El cierre no cuadra: escribe en Observaciones qué pasó con la diferencia');

      const reglas = (await q.query(`select valor from core.config where empresa_id = $1 and clave = 'antifraude'`, [ctx.empresa.id])).rows[0]?.valor ?? {};
      const previos = (await q.query(
        `select count(*)::int as n from pos.cierres_caja where cajero_id = $1 and diferencia_efectivo <= -1 and fecha_fin >= now() - interval '7 days'`, [ctx.usuario.id])).rows[0].n;
      const alertas = patrones(cuadre, { cajero: ctx.usuario.nombre, faltantesPrevios: previos, reincidencia: reglas.faltantes_reincidencia ?? 2 });
      if (noCuadra) {
        const L = (n) => `L ${Math.abs(n).toFixed(2)}`, tipo = (x) => (x < 0 ? `faltante ${L(x)}` : `sobrante ${L(x)}`);
        const partes = [];
        if (Math.abs(cuadre.diferencia_tarjeta) >= 1) partes.push(`tarjeta ${tipo(cuadre.diferencia_tarjeta)}`);
        if (Math.abs(cuadre.diferencia_efectivo) >= 1) partes.push(`efectivo ${tipo(cuadre.diferencia_efectivo)}`);
        alertas.unshift({ tipo: 'descuadre', severidad: Math.abs(cuadre.diferencia_total) >= 100 || Math.abs(cuadre.diferencia_efectivo) >= 100 ? 'alta' : 'media',
          titulo: `Descuadre en el cierre de ${suc.nombre}: ${partes.join(', ')}` });
      }

      // El cierre del día cierra los turnos que sigan abiertos en la sucursal (los de ventas posteriores al cierre se respetan).
      const abiertos = (await q.query(
        `select t.* from pos.turnos t where t.sucursal_id = $1 and t.estado = 'abierto' and t.abierto_at <= $2
            and not exists (select 1 from pos.ventas v where v.turno_id = t.id and v.fecha_emision > $2) order by t.abierto_at for update of t`, [suc.id, b.fecha_fin])).rows;
      const c = (await q.query(
        `insert into pos.cierres_caja (empresa_id, sucursal_id, fecha, fecha_inicio, fecha_fin, cajero_id, cantidad_facturas, factura_desde, factura_hasta, total_ventas,
            efectivo_sistema, tarjeta_sistema, transferencia_sistema, otros_sistema, anuladas, monto_anulado, desglose_pagos, pos_bancos, tarjeta_reportada, fondo_caja, ingresos, salidas,
            efectivo_contado, conteo, efectivo_esperado, diferencia_tarjeta, diferencia_efectivo, diferencia, observaciones, cierre_ciego, alertas, turnos_cerrados)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19,$20,$21,$22,$23,$24::jsonb,$25,$26,$27,$28,$29,$30,$31::jsonb,$32) returning *`,
        [ctx.empresa.id, suc.id, fechaHN(b.fecha_fin), b.fecha_inicio, b.fecha_fin, ctx.usuario.id, s.cantidad_facturas, s.factura_desde, s.factura_hasta, s.total_ventas,
          s.efectivo, s.tarjeta, s.transferencia, s.otros, s.anuladas, s.monto_anulado, JSON.stringify(s.formas), JSON.stringify(b.pos), cuadre.tarjeta_reportada, cuadre.fondo_caja, cuadre.ingresos, cuadre.salidas,
          cuadre.efectivo_contado, b.conteo ? JSON.stringify(b.conteo) : null, cuadre.efectivo_esperado, cuadre.diferencia_tarjeta, cuadre.diferencia_efectivo, cuadre.diferencia_total,
          obs || null, ciego, JSON.stringify(alertas), abiertos.length])).rows[0];

      for (const t of abiertos) {
        const rs = await resumenTurno(q, t);
        const unico = abiertos.length === 1;   // con un solo turno, el conteo del cierre es el de ese turno
        await q.query(
          `update pos.turnos set estado = 'cerrado', cerrado_at = now(), cerrado_por = $2, efectivo_esperado = $3, efectivo_contado = $4, diferencia = $5, tarjeta_sistema = $6,
                  transferencia_sistema = $7, total_ventas = $8, cantidad_facturas = $9, factura_desde = $10, factura_hasta = $11, observaciones = $12, cierre_id = $13 where id = $1`,
          [t.id, ctx.usuario.id, rs.efectivo_esperado, unico ? cuadre.efectivo_contado : null, unico ? cuadre.diferencia_efectivo : null, rs.tarjeta, rs.transferencia, rs.total, rs.facturas,
            rs.factura_desde, rs.factura_hasta, 'Cerrado con el cierre de caja de la sucursal', c.id]);
        await auditar(q, ctx, 'turno_cerrado', 'turno', t.id, { por_cierre: c.id, automatico: true }, { sucursalId: suc.id });
      }
      const guardado = (await q.query(`${SELECT_CIERRE} where c.id = $1`, [c.id])).rows[0];
      await auditar(q, ctx, 'cierre_caja', 'cierre', c.id, {
        factura_desde: s.factura_desde, factura_hasta: s.factura_hasta, total_ventas: s.total_ventas, esperado: cuadre.efectivo_esperado, contado: cuadre.efectivo_contado,
        diferencia_tarjeta: cuadre.diferencia_tarjeta, diferencia_efectivo: cuadre.diferencia_efectivo, diferencia: cuadre.diferencia_total, turnos_cerrados: abiertos.length,
      }, { sucursalId: suc.id });
      for (const al of alertas) await auditar(q, ctx, `cierre_alerta_${al.tipo}`, 'cierre', c.id, { titulo: al.titulo, severidad: al.severidad }, { sucursalId: suc.id });
      return { cierre: guardado, ciego, noCuadra, alertas, turnos_cerrados: abiertos.length };
    });
    const base = out.ciego ? sinSistema(out.cierre) : out.cierre;
    res.status(201).json({ ...base, descuadre: out.noCuadra, turnos_cerrados: out.turnos_cerrados, ...(out.ciego ? {} : { alertas: out.alertas }) });
  });

  // Historial (dirección/gerencia)
  r.get('/', requierePermiso('pos:reportes'), async (req, res) => {
    const f = validar(z.object({ sucursal_id: uuid.optional(), desde: fechaISO.optional(), hasta: fechaISO.optional(), limite: z.coerce.number().int().min(1).max(500).default(200) }), req.query);
    const hoy = fechaHN();
    const { rows } = await db.query(
      `${SELECT_CIERRE} where c.empresa_id = $1 and ($2::uuid[] = '{}' or c.sucursal_id = any($2::uuid[])) and ($3::uuid is null or c.sucursal_id = $3)
          and c.fecha between $4::date and $5::date order by c.fecha_fin desc limit $6`,
      [req.ctx.empresa.id, req.ctx.sucursalIds, f.sucursal_id ?? null, f.desde ?? sumarDias(hoy, -365), f.hasta ?? hoy, f.limite]);
    res.json(rows);
  });

  r.get('/:id', ver, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const c = await cierreVisible(db, req.ctx, id);
    const cfg = await configCierre(db, req.ctx.empresa.id);
    if (esCiego(req.ctx, cfg)) return res.json(sinSistema(c));
    const a = { empresaId: req.ctx.empresa.id, sucursalId: c.sucursal_id, desde: c.fecha_inicio, hasta: c.fecha_fin };
    const [desglose, facturas, turnos] = await Promise.all([
      desgloseCierre(db, a),
      db.query(`select v.id, v.numero_factura, v.total, v.estado, coalesce(v.cliente_nombre, t.nombre, 'Consumidor Final') as cliente, v.fecha_emision from pos.ventas v left join core.terceros t on t.id = v.cliente_id
                 where ${BASE} and v.estado in ('pagada','anulada') order by v.correlativo nulls last, v.fecha_emision`, [a.empresaId, a.sucursalId, a.desde, a.hasta]),
      db.query(`select t.id, t.abierto_at, t.cerrado_at, t.fondo_inicial, u.nombre as cajero from pos.turnos t join core.usuarios u on u.id = t.cajero_id where t.cierre_id = $1 order by t.abierto_at`, [id]),
    ]);
    res.json({ ...c, desglose, facturas: facturas.rows, turnos_cerrados_lista: turnos.rows, config: cfg });
  });

  r.get('/:id/ticket', ver, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const { columnas } = validar(z.object({ columnas: z.coerce.number().refine((n) => [32, 42, 48].includes(n), 'columnas inválidas').default(42) }), req.query);
    const c = await cierreVisible(db, req.ctx, id);
    const cfg = await configCierre(db, req.ctx.empresa.id);
    const oculto = esCiego(req.ctx, cfg);
    const desglose = oculto ? null : await desgloseCierre(db, { empresaId: req.ctx.empresa.id, sucursalId: c.sucursal_id, desde: c.fecha_inicio, hasta: c.fecha_fin });
    await auditar(db, req.ctx, 'cierre_impreso', 'cierre', id, {}, { sucursalId: c.sucursal_id });
    res.json({ lineas: formatearCierre({ empresa: req.ctx.empresa, cierre: c, desglose, ocultarSistema: oculto }, columnas) });
  });

  return r;
}
