import { Router } from 'express';
import { z } from 'zod';
import { fechaHN, sumarDias } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { uuid, validar, fechaISO } from '../../lib/http.js';
import { kpisDeRango } from './reportes-completo.js';

const FECHA = (col) => `(${col} at time zone 'America/Tegucigalpa')::date`;
const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const n = (v) => Number(v ?? 0);

/** Dashboard: un solo endpoint agregado (KPIs, formas de pago, sucursales, productos, categorías, tendencia). Por defecto el mes en curso. */
export function rutasDashboard({ db }) {
  const r = Router();
  r.get('/', requierePermiso('pos:reportes'), async (req, res) => {
    const f = validar(z.object({ desde: fechaISO.optional(), hasta: fechaISO.optional(), sucursal_id: uuid.optional() }), req.query);
    const hoy = fechaHN();
    const desde = f.desde ?? `${hoy.slice(0, 8)}01`;
    const hasta = f.hasta ?? hoy;
    const a = { empresaId: req.ctx.empresa.id, sucursalIds: req.ctx.sucursalIds, sucursalId: f.sucursal_id ?? null, desde, hasta };
    const args = [a.empresaId, a.sucursalIds, a.sucursalId, desde, hasta];
    const filtro = `v.empresa_id = $1 and ($2::uuid[] = '{}' or v.sucursal_id = any($2::uuid[])) and ($3::uuid is null or v.sucursal_id = $3) and ${FECHA('v.fecha_emision')} between $4::date and $5::date`;
    const dias = Math.round((Date.parse(hasta) - Date.parse(desde)) / 86400000) + 1;

    const [tot, pagos, suc, prods, cats, dia, hora, ant, hoyQ] = await Promise.all([
      q(`select count(*)::int as facturas, coalesce(sum(v.total),0)::numeric as total, coalesce(sum(v.isv_total),0)::numeric as isv, coalesce(sum(v.descuento),0)::numeric as descuento
           from pos.ventas v where v.estado = 'pagada' and ${filtro}`),
      q(`select f.nombre, f.tipo, sum(p.monto)::numeric as monto from pos.venta_pagos p join pos.formas_pago f on f.id = p.forma_pago_id join pos.ventas v on v.id = p.venta_id
          where v.estado = 'pagada' and ${filtro} group by f.nombre, f.tipo order by 3 desc`),
      q(`select s.id as sucursal_id, s.nombre, s.color, count(*)::int as facturas, sum(v.total)::numeric as total from pos.ventas v join core.sucursales s on s.id = v.sucursal_id
          where v.estado = 'pagada' and ${filtro} group by s.id, s.nombre, s.color order by 5 desc`),
      q(`select max(d.nombre_producto) as nombre, sum(d.cantidad)::numeric as cantidad, sum(d.monto)::numeric as total from pos.detalle_venta d join pos.ventas v on v.id = d.venta_id
          where v.estado = 'pagada' and ${filtro} group by coalesce(d.producto_id::text, d.nombre_producto) order by 2 desc limit 10`),
      q(`select coalesce(c.nombre, 'Sin categoría') as nombre, sum(d.cantidad)::numeric as cantidad, sum(d.monto)::numeric as total
           from pos.detalle_venta d join pos.ventas v on v.id = d.venta_id left join pos.productos p on p.id = d.producto_id left join pos.categorias c on c.id = p.categoria_id
          where v.estado = 'pagada' and ${filtro} group by 1 order by 3 desc`),
      q(`select ${FECHA('v.fecha_emision')}::text as fecha, count(*)::int as facturas, sum(v.total)::numeric as total from pos.ventas v where v.estado = 'pagada' and ${filtro} group by 1 order by 1`),
      q(`select extract(hour from v.fecha_emision at time zone 'America/Tegucigalpa')::int as hora, count(*)::int as facturas, sum(v.total)::numeric as total
           from pos.ventas v where v.estado = 'pagada' and ${filtro} group by 1 order by 1`),
      kpisDeRango(db, { ...a, desde: sumarDias(desde, -dias), hasta: sumarDias(desde, -1) }),
      db.query(`select count(*)::int as facturas, coalesce(sum(v.total),0)::numeric as total from pos.ventas v
                 where v.estado = 'pagada' and v.empresa_id = $1 and ($2::uuid[] = '{}' or v.sucursal_id = any($2::uuid[])) and ($3::uuid is null or v.sucursal_id = $3)
                   and ${FECHA('v.fecha_emision')} = $4::date`, [a.empresaId, a.sucursalIds, a.sucursalId, hoy]),
    ]);
    function q(sql) { return db.query(sql, args).then((x) => x.rows); }
    const t = tot[0];
    const totalPagos = pagos.reduce((s, p) => s + n(p.monto), 0);
    const anulaciones = (await db.query(`select count(*)::int as n, coalesce(sum(v.total),0)::numeric as total from pos.ventas v where v.estado = 'anulada' and ${filtro}`, args)).rows[0];
    res.json({
      desde, hasta, dias,
      total: n(t.total), cantidad_facturas: t.facturas, ticket_promedio: t.facturas ? r2(n(t.total) / t.facturas) : 0, isv_total: n(t.isv), descuentos: n(t.descuento),
      anuladas: { n: anulaciones.n, total: n(anulaciones.total) },
      anterior: { desde: sumarDias(desde, -dias), hasta: sumarDias(desde, -1), ventas: ant.ventas, facturas: ant.facturas, ticket_promedio: ant.ticket_promedio },
      hoy: { fecha: hoy, facturas: hoyQ.rows[0].facturas, total: n(hoyQ.rows[0].total) },
      formas_pago: pagos.map((p) => ({ nombre: p.nombre, tipo: p.tipo, monto: n(p.monto), porcentaje: totalPagos > 0 ? r2((n(p.monto) / totalPagos) * 100) : 0 })),
      por_sucursal: suc.map((s) => ({ sucursal_id: s.sucursal_id, nombre: s.nombre, color: s.color, total: n(s.total), facturas: s.facturas, ticket_promedio: s.facturas ? r2(n(s.total) / s.facturas) : 0 })),
      top_productos: prods.map((p) => ({ nombre: p.nombre, cantidad: n(p.cantidad), total: n(p.total) })),
      por_categoria: cats.map((c) => ({ nombre: c.nombre, cantidad: n(c.cantidad), total: n(c.total) })),
      tendencia_diaria: dia.map((d) => ({ fecha: d.fecha, facturas: d.facturas, total: n(d.total) })),
      por_hora: hora.map((h) => ({ hora: h.hora, facturas: h.facturas, total: n(h.total) })),
    });
  });
  return r;
}
