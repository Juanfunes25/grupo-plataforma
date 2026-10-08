import { Router } from 'express';
import { z } from 'zod';
import { requierePermiso, resolverSucursal } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { conflicto, noEncontrado, uuid, validar, dinero } from '../../lib/http.js';

/** Cuadre de un turno: ventas por forma de pago, movimientos de caja y efectivo esperado. */
export async function resumenTurno(q, t) {
  const [v, p, m, f] = await Promise.all([
    q.query(`select count(*) filter (where estado = 'pagada')::int as facturas, coalesce(sum(total) filter (where estado = 'pagada'),0)::numeric as total,
                    count(*) filter (where estado = 'anulada')::int as anuladas, coalesce(sum(total) filter (where estado = 'anulada'),0)::numeric as total_anulado
               from pos.ventas where turno_id = $1`, [t.id]),
    q.query(`select f.tipo, f.nombre, coalesce(sum(p.monto),0)::numeric as monto
               from pos.venta_pagos p join pos.formas_pago f on f.id = p.forma_pago_id join pos.ventas v on v.id = p.venta_id
              where v.turno_id = $1 and v.estado = 'pagada' group by f.tipo, f.nombre order by f.nombre`, [t.id]),
    q.query(`select tipo, coalesce(sum(monto),0)::numeric as monto from pos.movimientos_caja where turno_id = $1 group by tipo`, [t.id]),
    q.query(`select min(numero_factura) as desde, max(numero_factura) as hasta from pos.ventas where turno_id = $1 and estado = 'pagada'`, [t.id]),
  ]);
  const sum = (tipo) => Number(p.rows.filter((x) => x.tipo === tipo).reduce((s, x) => s + x.monto, 0));
  const mov = (tipo) => Number(m.rows.find((x) => x.tipo === tipo)?.monto ?? 0);
  const efectivo = sum('efectivo');
  const esperado = Math.round((Number(t.fondo_inicial) + efectivo + mov('ingreso') - mov('salida')) * 100) / 100;
  return {
    ...v.rows[0], por_forma: p.rows, efectivo_ventas: efectivo, tarjeta: sum('tarjeta'), transferencia: sum('transferencia'),
    ingresos: mov('ingreso'), salidas: mov('salida'), efectivo_esperado: esperado,
    factura_desde: f.rows[0].desde, factura_hasta: f.rows[0].hasta,
  };
}

export function rutasTurnos({ db }) {
  const resumen = resumenTurno;
  const r = Router();

  const miTurno = async (q, ctx, sucursalId) =>
    (await q.query(`select * from pos.turnos where sucursal_id = $1 and cajero_id = $2 and estado = 'abierto'`, [sucursalId, ctx.usuario.id])).rows[0];

  // Turno abierto del usuario en una sucursal (con cuadre en vivo; el cajero no ve el esperado: cierre ciego).
  r.get('/actual', requierePermiso('pos:vender', 'pos:caja'), async (req, res) => {
    const { sucursal_id } = validar(z.object({ sucursal_id: uuid.optional() }), req.query);
    const suc = await resolverSucursal(db, req.ctx, sucursal_id);
    const t = await miTurno(db, req.ctx, suc.id);
    if (!t) return res.json({ turno: null, sucursal_id: suc.id });
    const rs = await resumen(db, t);
    if (req.ctx.rol === 'cajero') delete rs.efectivo_esperado;
    res.json({ turno: t, resumen: rs, sucursal_id: suc.id });
  });

  r.post('/abrir', requierePermiso('pos:caja'), async (req, res) => {
    const b = validar(z.object({ sucursal_id: uuid.optional(), fondo_inicial: dinero.default(0) }), req.body);
    const t = await db.tx(async (q) => {
      const suc = await resolverSucursal(q, req.ctx, b.sucursal_id);
      if (await miTurno(q, req.ctx, suc.id)) throw conflicto('Ya tienes un turno abierto en esta sucursal');
      const t = (await q.query(
        'insert into pos.turnos (empresa_id, sucursal_id, cajero_id, fondo_inicial) values ($1,$2,$3,$4) returning *',
        [req.ctx.empresa.id, suc.id, req.ctx.usuario.id, b.fondo_inicial])).rows[0];
      await auditar(q, req.ctx, 'turno_abierto', 'turno', t.id, { fondo: b.fondo_inicial }, { sucursalId: suc.id });
      return t;
    });
    res.status(201).json(t);
  });

  r.post('/movimiento', requierePermiso('pos:caja'), async (req, res) => {
    const b = validar(z.object({
      sucursal_id: uuid.optional(), tipo: z.enum(['ingreso', 'salida']), monto: dinero.refine((n) => n > 0, 'El monto debe ser mayor a 0'),
      concepto: z.string().trim().min(3, 'Escribe el concepto').max(200),
    }), req.body);
    const out = await db.tx(async (q) => {
      const suc = await resolverSucursal(q, req.ctx, b.sucursal_id);
      const t = await miTurno(q, req.ctx, suc.id);
      if (!t) throw conflicto('Abre tu turno de caja primero');
      const m = (await q.query(
        'insert into pos.movimientos_caja (empresa_id, sucursal_id, turno_id, tipo, monto, concepto, usuario_id) values ($1,$2,$3,$4,$5,$6,$7) returning *',
        [req.ctx.empresa.id, suc.id, t.id, b.tipo, b.monto, b.concepto, req.ctx.usuario.id])).rows[0];
      await auditar(q, req.ctx, 'movimiento_caja', 'turno', t.id, { tipo: b.tipo, monto: b.monto, concepto: b.concepto }, { sucursalId: suc.id });
      return m;
    });
    res.status(201).json(out);
  });

  r.post('/cerrar', requierePermiso('pos:caja'), async (req, res) => {
    const b = validar(z.object({ sucursal_id: uuid.optional(), efectivo_contado: dinero, observaciones: z.string().trim().max(500).optional().nullable() }), req.body);
    const out = await db.tx(async (q) => {
      const suc = await resolverSucursal(q, req.ctx, b.sucursal_id);
      const t = (await q.query(`select * from pos.turnos where sucursal_id = $1 and cajero_id = $2 and estado = 'abierto' for update`, [suc.id, req.ctx.usuario.id])).rows[0];
      if (!t) throw noEncontrado('No tienes un turno abierto');
      const abiertas = (await q.query(`select count(*)::int as n from pos.ventas where sucursal_id = $1 and estado = 'abierta' and cajero_id = $2`, [suc.id, req.ctx.usuario.id])).rows[0].n;
      if (abiertas > 0) throw conflicto(`Tienes ${abiertas} orden(es) abierta(s) sin cobrar o descartar; resuélvelas antes de cerrar`);
      const rs = await resumen(q, t);
      const dif = Math.round((b.efectivo_contado - rs.efectivo_esperado) * 100) / 100;
      const cerrado = (await q.query(
        `update pos.turnos set estado = 'cerrado', cerrado_at = now(), cerrado_por = $2, efectivo_contado = $3, efectivo_esperado = $4, diferencia = $5,
                tarjeta_sistema = $6, transferencia_sistema = $7, total_ventas = $8, cantidad_facturas = $9, factura_desde = $10, factura_hasta = $11, observaciones = $12
          where id = $1 returning *`,
        [t.id, req.ctx.usuario.id, b.efectivo_contado, rs.efectivo_esperado, dif, rs.tarjeta, rs.transferencia, rs.total, rs.facturas, rs.factura_desde, rs.factura_hasta, b.observaciones ?? null])).rows[0];
      await auditar(q, req.ctx, 'turno_cerrado', 'turno', t.id, { diferencia: dif, contado: b.efectivo_contado, esperado: rs.efectivo_esperado }, { sucursalId: suc.id });
      return { turno: cerrado, resumen: rs };
    });
    res.json(out);
  });

  // Historial de turnos (para dirección/gerencia)
  r.get('/', requierePermiso('pos:reportes'), async (req, res) => {
    const f = validar(z.object({ sucursal_id: uuid.optional(), limite: z.coerce.number().int().min(1).max(200).default(60) }), req.query);
    const { rows } = await db.query(
      `select t.*, s.nombre as sucursal, u.nombre as cajero from pos.turnos t join core.sucursales s on s.id = t.sucursal_id join core.usuarios u on u.id = t.cajero_id
        where t.empresa_id = $1 and ($2::uuid is null or t.sucursal_id = $2) and ($3::uuid[] = '{}' or t.sucursal_id = any($3::uuid[]))
        order by t.abierto_at desc limit $4`, [req.ctx.empresa.id, f.sucursal_id ?? null, req.ctx.sucursalIds, f.limite]);
    res.json(rows);
  });

  return r;
}
