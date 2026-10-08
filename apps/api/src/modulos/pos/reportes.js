import { Router } from 'express';
import { z } from 'zod';
import { fechaHN, sumarDias } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { uuid, validar, fechaISO } from '../../lib/http.js';

const FECHA = (col) => `(${col} at time zone 'America/Tegucigalpa')::date`;

/** Reporte de ventas de una empresa en un rango (fechas en hora de Honduras). */
export async function resumenVentas(q, { empresaId, sucursalIds = [], desde, hasta, sucursalId = null }) {
  const filtro = `v.empresa_id = $1 and ($2::uuid[] = '{}' or v.sucursal_id = any($2::uuid[])) and ($5::uuid is null or v.sucursal_id = $5)
                  and ${FECHA('v.fecha_emision')} between $3::date and $4::date`;
  const args = [empresaId, sucursalIds, desde, hasta, sucursalId];
  const [tot, dia, pagos, prods, hora, cats, suc, anul] = await Promise.all([
    q.query(`select count(*)::int as facturas, coalesce(sum(total),0)::numeric as total, coalesce(sum(isv_total),0)::numeric as isv,
                    coalesce(sum(descuento),0)::numeric as descuento,
                    coalesce(sum(subtotal_exento),0)::numeric as exento, coalesce(sum(subtotal_exonerado),0)::numeric as exonerado,
                    coalesce(sum(subtotal_gravado_15),0)::numeric as gravado_15, coalesce(sum(subtotal_gravado_18),0)::numeric as gravado_18
               from pos.ventas v where v.estado = 'pagada' and ${filtro}`, args),
    q.query(`select ${FECHA('v.fecha_emision')}::text as fecha, count(*)::int as facturas, sum(total)::numeric as total
               from pos.ventas v where v.estado = 'pagada' and ${filtro} group by 1 order by 1`, args),
    q.query(`select f.nombre, f.tipo, sum(p.monto)::numeric as monto from pos.venta_pagos p join pos.formas_pago f on f.id = p.forma_pago_id
               join pos.ventas v on v.id = p.venta_id where v.estado = 'pagada' and ${filtro} group by f.nombre, f.tipo order by 3 desc`, args),
    q.query(`select d.nombre_producto as producto, sum(d.cantidad)::numeric as unidades, sum(d.monto)::numeric as venta,
                    sum(d.costo_unitario * d.cantidad) filter (where d.costo_unitario is not null)::numeric as costo
               from pos.detalle_venta d join pos.ventas v on v.id = d.venta_id where v.estado = 'pagada' and ${filtro}
              group by 1 order by 3 desc limit 15`, args),
    q.query(`select extract(hour from v.fecha_emision at time zone 'America/Tegucigalpa')::int as hora, count(*)::int as facturas, sum(total)::numeric as total
               from pos.ventas v where v.estado = 'pagada' and ${filtro} group by 1 order by 1`, args),
    q.query(`select coalesce(c.nombre, 'Sin categoría') as categoria, sum(d.monto)::numeric as venta, sum(d.cantidad)::numeric as unidades
               from pos.detalle_venta d join pos.ventas v on v.id = d.venta_id left join pos.productos p on p.id = d.producto_id left join pos.categorias c on c.id = p.categoria_id
              where v.estado = 'pagada' and ${filtro} group by 1 order by 2 desc`, args),
    q.query(`select s.nombre as sucursal, count(*)::int as facturas, sum(v.total)::numeric as total from pos.ventas v join core.sucursales s on s.id = v.sucursal_id
              where v.estado = 'pagada' and ${filtro} group by 1 order by 3 desc`, args),
    q.query(`select count(*)::int as n, coalesce(sum(total),0)::numeric as total from pos.ventas v where v.estado = 'anulada' and ${FECHA('v.anulada_at')} between $3::date and $4::date
              and v.empresa_id = $1 and ($2::uuid[] = '{}' or v.sucursal_id = any($2::uuid[])) and ($5::uuid is null or v.sucursal_id = $5)`, args),
  ]);
  const t = tot.rows[0];
  const costo = prods.rows.reduce((s, p) => s + (p.costo ?? 0), 0);
  const ventaConCosto = prods.rows.filter((p) => p.costo != null).reduce((s, p) => s + p.venta, 0);
  return {
    desde, hasta, ...t,
    ticket_promedio: t.facturas ? Math.round((t.total / t.facturas) * 100) / 100 : 0,
    anuladas: anul.rows[0],
    por_dia: dia.rows, por_forma_pago: pagos.rows, top_productos: prods.rows.map((p) => ({ ...p, margen_pct: p.costo != null && p.venta > 0 ? Math.round(((p.venta - p.costo) / p.venta) * 1000) / 10 : null })),
    por_hora: hora.rows, por_categoria: cats.rows, por_sucursal: suc.rows,
    margen_pct: ventaConCosto > 0 ? Math.round(((ventaConCosto - costo) / ventaConCosto) * 1000) / 10 : null,
  };
}

export function rutasReportes({ db }) {
  const r = Router();
  const rango = z.object({ desde: fechaISO.optional(), hasta: fechaISO.optional(), sucursal_id: uuid.optional() });

  r.get('/resumen', requierePermiso('pos:reportes'), async (req, res) => {
    const f = validar(rango, req.query);
    const hoy = fechaHN();
    res.json(await resumenVentas(db, {
      empresaId: req.ctx.empresa.id, sucursalIds: req.ctx.sucursalIds, desde: f.desde ?? sumarDias(hoy, -6), hasta: f.hasta ?? hoy, sucursalId: f.sucursal_id ?? null }));
  });

  // Libro de ventas (formato SAR: una fila por factura con sus importes) — listo para exportar a CSV/Excel.
  r.get('/libro', requierePermiso('pos:reportes'), async (req, res) => {
    const f = validar(rango, req.query);
    const hoy = fechaHN();
    const { rows } = await db.query(
      `select ${FECHA('v.fecha_emision')}::text as fecha, v.numero_factura, v.estado, s.nombre as sucursal, coalesce(c.nombre, 'Consumidor Final') as cliente, c.rtn,
              v.subtotal_exento as exento, v.subtotal_exonerado as exonerado, v.subtotal_gravado_15 as gravado_15, v.subtotal_gravado_18 as gravado_18,
              v.isv_total as isv, v.descuento, v.total, v.es_borrador_fiscal as borrador
         from pos.ventas v join core.sucursales s on s.id = v.sucursal_id left join core.terceros c on c.id = v.cliente_id
        where v.empresa_id = $1 and ($2::uuid[] = '{}' or v.sucursal_id = any($2::uuid[])) and ($5::uuid is null or v.sucursal_id = $5)
          and v.estado in ('pagada','anulada') and v.numero_factura is not null and ${FECHA('v.fecha_emision')} between $3::date and $4::date
        order by v.fecha_emision, v.correlativo`,
      [req.ctx.empresa.id, req.ctx.sucursalIds, f.desde ?? sumarDias(hoy, -6), f.hasta ?? hoy, f.sucursal_id ?? null]);
    res.json(rows);
  });
  return r;
}

export function rutasKds({ db }) {
  const r = Router();
  // Pantalla de cocina: órdenes cobradas hoy que aún no se entregan.
  r.get('/', requierePermiso('kds:ver'), async (req, res) => {
    const f = validar(z.object({ sucursal_id: uuid.optional() }), req.query);
    const { rows } = await db.query(
      `select v.id, v.ticket_dia, v.nombre_orden, v.tipo_orden, v.canal, v.notas, v.estado_prep, v.fecha_emision,
              (select json_agg(json_build_object('cantidad', d.cantidad, 'nombre', d.nombre_producto, 'opciones', d.opciones, 'notas', d.notas) order by d.orden)
                 from pos.detalle_venta d where d.venta_id = v.id) as lineas
         from pos.ventas v
        where v.empresa_id = $1 and v.estado = 'pagada' and v.estado_prep <> 'entregado' and v.fecha_emision > now() - interval '14 hours'
          and ($2::uuid is null or v.sucursal_id = $2) and ($3::uuid[] = '{}' or v.sucursal_id = any($3::uuid[]))
        order by v.fecha_emision`, [req.ctx.empresa.id, f.sucursal_id ?? null, req.ctx.sucursalIds]);
    res.json(rows);
  });
  return r;
}
