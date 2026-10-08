import { Router } from 'express';
import { z } from 'zod';
import { requierePermiso, resolverSucursal, sucursalesPermitidas } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { conflicto, malaPeticion, noEncontrado, prohibido, uuid, validar, fechaISO } from '../../lib/http.js';
import { armarItems, totalesDe } from './calculo.js';
import { formatearTicket } from './ticket.js';

const item = z.object({
  producto_id: uuid,
  cantidad: z.coerce.number().positive().max(999),
  opciones: z.array(uuid).max(30).default([]),
  notas: z.string().trim().max(200).optional().nullable(),
  descuento_porcentaje: z.coerce.number().default(0),
});
const pago = z.object({ forma_pago_id: uuid, monto: z.coerce.number().positive(), referencia: z.string().trim().max(60).optional().nullable() });
const cuerpoVenta = z.object({
  sucursal_id: uuid.optional(),
  canal: z.enum(['mostrador', 'recoger', 'delivery', 'evento', 'mayoreo']).default('mostrador'),
  tipo_orden: z.enum(['aqui', 'llevar']).default('aqui'),
  nombre_orden: z.string().trim().max(60).optional().nullable(),
  notas: z.string().trim().max(300).optional().nullable(),
  cliente_id: uuid.optional().nullable(),
  items: z.array(item).min(1, 'La orden no tiene productos').max(100),
  cobrar: z.object({ pagos: z.array(pago).min(1) }).optional(),
});

export function rutasVentas({ db, ctxMgr }) {
  const r = Router();

  async function consumidorFinal(q) {
    return (await q.query('select * from core.terceros where es_consumidor_final')).rows[0];
  }
  async function clienteDe(q, id) {
    if (!id) return consumidorFinal(q);
    const c = (await q.query('select * from core.terceros where id = $1 and activo', [id])).rows[0];
    if (!c) throw malaPeticion('El cliente no existe');
    return c;
  }

  /** Carga una venta completa verificando empresa y sucursal permitida. */
  async function cargar(q, ctx, id, { bloquear = false } = {}) {
    const v = (await q.query(`select * from pos.ventas where id = $1 and empresa_id = $2 ${bloquear ? 'for update' : ''}`, [id, ctx.empresa.id])).rows[0];
    if (!v) throw noEncontrado('Venta no encontrada');
    if (ctx.sucursalIds.length && !ctx.sucursalIds.includes(v.sucursal_id)) throw prohibido();
    return v;
  }
  async function detalle(q, ctx, v) {
    const [lineas, pagos, cliente, sucursal, cajero, punto] = await Promise.all([
      q.query('select * from pos.detalle_venta where venta_id = $1 order by orden', [v.id]),
      q.query('select p.monto, p.referencia, f.nombre as forma, f.tipo from pos.venta_pagos p join pos.formas_pago f on f.id = p.forma_pago_id where p.venta_id = $1', [v.id]),
      v.cliente_id ? q.query('select id, nombre, rtn from core.terceros where id = $1', [v.cliente_id]) : { rows: [] },
      q.query('select id, nombre, alias, direccion from core.sucursales where id = $1', [v.sucursal_id]),
      v.cajero_id ? q.query('select id, nombre from core.usuarios where id = $1', [v.cajero_id]) : { rows: [] },
      v.punto_emision_id ? q.query('select * from pos.puntos_emision where id = $1', [v.punto_emision_id]) : { rows: [] },
    ]);
    return { ...v, lineas: lineas.rows, pagos: pagos.rows, cliente: cliente.rows[0] ?? null, sucursal: sucursal.rows[0], cajero: cajero.rows[0] ?? null, punto: punto.rows[0] ?? null };
  }

  async function guardarLineas(q, ventaId, tot) {
    await q.query('delete from pos.detalle_venta where venta_id = $1', [ventaId]);
    for (const l of tot.lineas) {
      await q.query(
        `insert into pos.detalle_venta (venta_id, producto_id, nombre_producto, cantidad, precio_base, extras, precio_unitario, opciones, notas,
                                        descuento, descuento_porcentaje, impuesto_tasa, exento, monto, orden)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)`,
        [ventaId, l.producto_id, l.nombre_producto, l.cantidad, l.precio_base, l.extras, l.precio_unitario, JSON.stringify(l.opciones), l.notas,
          l.descuento, l.descuento_porcentaje, l.impuesto_tasa, l.exento, l.monto, l.orden]);
    }
  }
  const camposTotales = (tot) => [tot.subtotal_exento, tot.subtotal_exonerado, tot.subtotal_gravado_15, tot.subtotal_gravado_18,
    tot.descuento, Math.max(0, ...tot.lineas.map((l) => l.descuento_porcentaje)), tot.isv_total, tot.total];

  async function turnoAbierto(q, ctx, sucursalId) {
    return (await q.query(`select * from pos.turnos where sucursal_id = $1 and cajero_id = $2 and estado = 'abierto'`, [sucursalId, ctx.usuario.id])).rows[0];
  }

  async function cobrar(q, ctx, ventaId, pagos) {
    const v = await cargar(q, ctx, ventaId, { bloquear: true });
    if (v.estado !== 'abierta') throw conflicto(`La venta ya está ${v.estado}`);
    const turno = await turnoAbierto(q, ctx, v.sucursal_id);
    if (!turno) throw conflicto('Abre tu turno de caja antes de cobrar');
    await q.query('update pos.ventas set turno_id = $1, cajero_id = $2 where id = $3', [turno.id, ctx.usuario.id, ventaId]);
    const pagado = (await q.query('select * from pos.cobrar_venta($1, $2::jsonb)', [ventaId, JSON.stringify(pagos)])).rows[0];
    await auditar(q, ctx, 'venta_cobrada', 'venta', ventaId, { factura: pagado.numero_factura, total: pagado.total }, { sucursalId: v.sucursal_id });
    return pagado;
  }

  // ── Crear (y opcionalmente cobrar en el mismo paso) ──────────────────────
  r.post('/', requierePermiso('pos:vender'), async (req, res) => {
    const b = validar(cuerpoVenta, req.body);
    const out = await db.tx(async (q) => {
      const suc = await resolverSucursal(q, req.ctx, b.sucursal_id);
      const cliente = await clienteDe(q, b.cliente_id);
      const items = await armarItems(q, req.ctx, b.items);
      const tot = totalesDe(items, cliente, 0);
      const ticket = (await q.query('select pos.siguiente_ticket($1) as n', [suc.id])).rows[0].n;
      const v = (await q.query(
        `insert into pos.ventas (empresa_id, sucursal_id, cliente_id, cajero_id, canal, tipo_orden, nombre_orden, notas, ticket_dia,
                                 subtotal_exento, subtotal_exonerado, subtotal_gravado_15, subtotal_gravado_18, descuento, descuento_porcentaje, isv_total, total)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning *`,
        [req.ctx.empresa.id, suc.id, cliente.id, req.ctx.usuario.id, b.canal, b.tipo_orden, b.nombre_orden ?? null, b.notas ?? null, ticket, ...camposTotales(tot)])).rows[0];
      await guardarLineas(q, v.id, tot);
      if (b.cobrar) await cobrar(q, req.ctx, v.id, b.cobrar.pagos);
      return detalle(q, req.ctx, await cargar(q, req.ctx, v.id));
    });
    res.status(201).json(out);
  });

  // ── Editar una orden abierta ─────────────────────────────────────────────
  r.put('/:id', requierePermiso('pos:vender'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(cuerpoVenta.omit({ cobrar: true }).partial({ items: true }), req.body);
    const out = await db.tx(async (q) => {
      const v = await cargar(q, req.ctx, id, { bloquear: true });
      if (v.estado !== 'abierta') throw conflicto('Solo se pueden editar órdenes abiertas');
      const cliente = await clienteDe(q, b.cliente_id ?? v.cliente_id);
      let tot;
      if (b.items) {
        tot = totalesDe(await armarItems(q, req.ctx, b.items), cliente, 0);
        await guardarLineas(q, id, tot);
      }
      const t = tot ? camposTotales(tot) : null;
      await q.query(
        `update pos.ventas set cliente_id = $2, canal = coalesce($3, canal), tipo_orden = coalesce($4, tipo_orden), nombre_orden = coalesce($5, nombre_orden),
                notas = coalesce($6, notas),
                subtotal_exento = coalesce($7, subtotal_exento), subtotal_exonerado = coalesce($8, subtotal_exonerado),
                subtotal_gravado_15 = coalesce($9, subtotal_gravado_15), subtotal_gravado_18 = coalesce($10, subtotal_gravado_18),
                descuento = coalesce($11, descuento), descuento_porcentaje = coalesce($12, descuento_porcentaje),
                isv_total = coalesce($13, isv_total), total = coalesce($14, total), updated_at = now()
          where id = $1`,
        [id, cliente.id, b.canal ?? null, b.tipo_orden ?? null, b.nombre_orden ?? null, b.notas ?? null, ...(t ?? Array(8).fill(null))]);
      return detalle(q, req.ctx, await cargar(q, req.ctx, id));
    });
    res.json(out);
  });

  // ── Cobrar una orden abierta ─────────────────────────────────────────────
  r.post('/:id/cobrar', requierePermiso('pos:vender'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const { pagos } = validar(z.object({ pagos: z.array(pago).min(1, 'Falta la forma de pago') }), req.body);
    const out = await db.tx(async (q) => {
      await cobrar(q, req.ctx, id, pagos);
      return detalle(q, req.ctx, await cargar(q, req.ctx, id));
    });
    res.json(out);
  });

  // ── Anular ───────────────────────────────────────────────────────────────
  r.post('/:id/anular', requierePermiso('pos:anular'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const { motivo } = validar(z.object({ motivo: z.string().trim().min(3, 'Escribe el motivo de la anulación').max(300) }), req.body);
    const out = await db.tx(async (q) => {
      const v = await cargar(q, req.ctx, id, { bloquear: true });
      if (v.estado === 'abierta') {   // una orden sin cobrar simplemente se descarta
        await q.query(`update pos.ventas set estado = 'anulada', anulada_at = now(), anulada_por = $2, motivo_anulacion = $3, updated_at = now() where id = $1`, [id, req.ctx.usuario.id, motivo]);
      } else {
        await q.query('select pos.anular_venta($1,$2,$3)', [id, motivo, req.ctx.usuario.id]);
      }
      await auditar(q, req.ctx, 'venta_anulada', 'venta', id, { motivo, factura: v.numero_factura, total: v.total, estado_previo: v.estado }, { sucursalId: v.sucursal_id });
      return detalle(q, req.ctx, await cargar(q, req.ctx, id));
    });
    res.json(out);
  });

  // ── Estado de preparación (cocina) ───────────────────────────────────────
  r.put('/:id/prep', requierePermiso('kds:ver', 'pos:vender'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const { estado } = validar(z.object({ estado: z.enum(['pendiente', 'preparando', 'listo', 'entregado']) }), req.body);
    const v = await cargar(db, req.ctx, id);
    if (v.estado !== 'pagada') throw conflicto('Solo las órdenes cobradas pasan por cocina');
    await db.query(`update pos.ventas set estado_prep = $2, prep_listo_at = case when $2 = 'listo' then now() else prep_listo_at end, updated_at = now() where id = $1`, [id, estado]);
    res.json({ ok: true, estado });
  });

  // ── Lista ────────────────────────────────────────────────────────────────
  r.get('/', requierePermiso('pos:vender', 'pos:reportes'), async (req, res) => {
    const f = validar(z.object({
      estado: z.enum(['abierta', 'pagada', 'anulada']).optional(),
      desde: fechaISO.optional(), hasta: fechaISO.optional(),
      sucursal_id: uuid.optional(), q: z.string().trim().max(60).optional(),
      limite: z.coerce.number().int().min(1).max(500).default(100),
    }), req.query);
    const ver = req.ctx.permisos.has('pos:reportes');
    const suc = (await sucursalesPermitidas(db, req.ctx)).map((s) => s.id);
    const { rows } = await db.query(
      `select v.id, v.ticket_dia, v.numero_orden, v.numero_factura, v.estado, v.estado_prep, v.nombre_orden, v.canal, v.tipo_orden, v.total,
              v.created_at, v.fecha_emision, v.es_borrador_fiscal, s.nombre as sucursal, u.nombre as cajero,
              (select count(*)::int from pos.detalle_venta d where d.venta_id = v.id) as lineas
         from pos.ventas v join core.sucursales s on s.id = v.sucursal_id left join core.usuarios u on u.id = v.cajero_id
        where v.empresa_id = $1 and v.sucursal_id = any($2::uuid[])
          and ($3::text is null or v.estado = $3)
          and ($4::date is null or (coalesce(v.fecha_emision, v.created_at) at time zone 'America/Tegucigalpa')::date >= $4::date)
          and ($5::date is null or (coalesce(v.fecha_emision, v.created_at) at time zone 'America/Tegucigalpa')::date <= $5::date)
          and ($6::uuid is null or v.sucursal_id = $6)
          and ($7::text is null or v.numero_factura ilike '%'||$7||'%' or v.nombre_orden ilike '%'||$7||'%' or v.numero_orden::text = $7 or v.ticket_dia::text = $7)
          and ($8::boolean or v.cajero_id = $9 or v.estado = 'abierta')
        order by coalesce(v.fecha_emision, v.created_at) desc limit $10`,
      [req.ctx.empresa.id, suc, f.estado ?? null, f.desde ?? null, f.hasta ?? null, f.sucursal_id ?? null, f.q ?? null, ver, req.ctx.usuario.id, f.limite]);
    res.json(rows);
  });

  r.get('/:id', requierePermiso('pos:vender', 'pos:reportes'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    res.json(await detalle(db, req.ctx, await cargar(db, req.ctx, id)));
  });

  r.get('/:id/ticket', requierePermiso('pos:vender', 'pos:reportes'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const { columnas, reimpresion } = validar(z.object({ columnas: z.coerce.number().refine((n) => [32, 42, 48].includes(n)).default(42), reimpresion: z.coerce.boolean().default(false) }), req.query);
    if (reimpresion && !req.ctx.permisos.has('pos:reimprimir')) throw prohibido('No tienes permiso para reimprimir');
    const d = await detalle(db, req.ctx, await cargar(db, req.ctx, id));
    if (reimpresion) await auditar(db, req.ctx, 'factura_reimpresa', 'venta', id, { factura: d.numero_factura }, { sucursalId: d.sucursal_id });
    res.json({ lineas: formatearTicket({ empresa: req.ctx.empresa, sucursal: d.sucursal, venta: d, lineas: d.lineas, pagos: d.pagos, punto: d.punto, cliente: d.cliente, cajero: d.cajero }, columnas, { copia: reimpresion ? 1 : 0 }) });
  });

  return r;
}
