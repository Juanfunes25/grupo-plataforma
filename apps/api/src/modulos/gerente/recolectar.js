import { fechaHN, sumarDias } from '@grupo/shared';
import { calcularAlertas } from '../pos/antifraude.js';
import { estadoPunto } from '../pos/fiscal.js';
import { resumenParaGerente } from '../documentos/servicio.js';

const FECHA = (c) => `(${c} at time zone 'America/Tegucigalpa')::date`;

/** Junta los números de UNA empresa que necesita el análisis. Solo lecturas. */
export async function recolectar(q, { empresa, sucursalIds = [], dias = 28, hasta = fechaHN() }) {
  const desde = sumarDias(hasta, -(dias - 1));
  const previoDesde = sumarDias(desde, -dias);
  const E = empresa.id;
  const suc = [sucursalIds];
  const filtroV = `v.empresa_id = $1 and v.estado = 'pagada' and ($2::uuid[] = '{}' or v.sucursal_id = any($2::uuid[]))`;

  const [vd, pa, pp, ho, ga, gp, me, co, st, ve, tu, pe, ds, cat] = await Promise.all([
    q.query(`select ${FECHA('v.fecha_emision')}::text as fecha, sum(v.total - v.isv_total)::numeric as neto, count(*)::int as facturas from pos.ventas v
              where ${filtroV} and ${FECHA('v.fecha_emision')} between $3::date and $4::date group by 1 order by 1`, [E, ...suc, previoDesde, hasta]),
    q.query(prodSql, [E, ...suc, desde, hasta]),
    q.query(prodSql, [E, ...suc, previoDesde, sumarDias(desde, -1)]),
    q.query(`select extract(hour from v.fecha_emision at time zone 'America/Tegucigalpa')::int as hora, sum(v.total - v.isv_total)::numeric as venta, count(*)::int as facturas from pos.ventas v
              where ${filtroV} and ${FECHA('v.fecha_emision')} between $3::date and $4::date group by 1 order by 1`, [E, ...suc, desde, hasta]),
    q.query(gastoSql, [E, desde, hasta]),
    q.query(gastoSql, [E, previoDesde, sumarDias(desde, -1)]),
    q.query(`select i.nombre as insumo, sum(-m.costo_total)::numeric as costo from inv.movimientos m join inv.insumos i on i.id = m.insumo_id
              where m.empresa_id = $1 and m.tipo = 'merma' and ($2::uuid[] = '{}' or m.sucursal_id = any($2::uuid[])) and ${FECHA('m.created_at')} between $3::date and $4::date group by 1 order by 2 desc`, [E, ...suc, desde, hasta]),
    q.query(`select coalesce(sum(subtotal),0)::numeric as total from inv.compras where empresa_id = $1 and ($2::uuid[] = '{}' or sucursal_id = any($2::uuid[])) and fecha between $3::date and $4::date`, [E, ...suc, desde, hasta]),
    q.query(`select i.nombre as insumo, i.unidad, st.cantidad as stock, i.costo_actual as costo, i.stock_minimo as minimo,
                    coalesce((select sum(-m.cantidad) from inv.movimientos m where m.insumo_id = i.id and m.tipo = 'consumo' and ($2::uuid[] = '{}' or m.sucursal_id = any($2::uuid[]))
                                 and m.created_at > now() - interval '14 days'), 0) / 14.0 as consumo_diario
               from inv.insumos i join (select insumo_id, sum(cantidad) as cantidad from inv.stock where empresa_id = $1 and ($2::uuid[] = '{}' or sucursal_id = any($2::uuid[])) group by insumo_id) st on st.insumo_id = i.id
              where i.empresa_id = $1 and i.activo`, [E, ...suc]),
    q.query(`select coalesce(sum(cantidad_actual * costo_unitario),0)::numeric as valor, count(*)::int as lotes from inv.lotes
              where empresa_id = $1 and cantidad_actual > 0 and vence_at is not null and vence_at <= $3::date and ($2::uuid[] = '{}' or sucursal_id = any($2::uuid[]))`, [E, ...suc, sumarDias(hasta, 2)]),
    q.query(`select diferencia from pos.turnos where empresa_id = $1 and estado = 'cerrado' and diferencia is not null and ($2::uuid[] = '{}' or sucursal_id = any($2::uuid[])) and ${FECHA('abierto_at')} between $3::date and $4::date`, [E, ...suc, desde, hasta]),
    q.query(`select pe.*, s.nombre as sucursal from pos.puntos_emision pe join core.sucursales s on s.id = pe.sucursal_id where pe.empresa_id = $1 and pe.activo and ($2::uuid[] = '{}' or pe.sucursal_id = any($2::uuid[]))`, [E, ...suc]),
    q.query(`select coalesce(sum(v.descuento),0)::numeric as descuento, coalesce(sum(v.total + v.descuento),0)::numeric as bruto from pos.ventas v where ${filtroV} and ${FECHA('v.fecha_emision')} between $3::date and $4::date`, [E, ...suc, desde, hasta]),
    q.query(`select nombre, precio, impuesto_tasa as tasa from pos.productos where empresa_id = $1 and activo`, [E]),
  ]);

  return {
    empresa: { codigo: empresa.codigo, nombre: empresa.nombre },
    periodo: { desde, hasta, dias, previo_desde: previoDesde },
    ventasDia: vd.rows, productosActual: pa.rows, productosPrevio: pp.rows, horas: ho.rows,
    gastosActual: ga.rows, gastosPrevio: gp.rows,
    mermas: { costo: me.rows.reduce((s, x) => s + x.costo, 0), top: me.rows.slice(0, 5) },
    compras: co.rows[0].total, stock: st.rows, vencen: ve.rows[0],
    turnos: tu.rows, fiscal: pe.rows.map((p) => { const e = estadoPunto(p); return { sucursal: p.sucursal, borrador: p.es_borrador, restantes: p.correlativo_hasta - p.correlativo_actual + 1, dias_restantes: e.dias_restantes }; }),
    descuento: ds.rows[0], catalogo: cat.rows,
    documentos: await resumenParaGerente(q, empresa, { hoy: fechaHN() }),
    antifraude: await calcularAlertas(q, { empresaId: E, sucursalIds, desde, hasta, reglas: ((await q.query(`select valor from core.config where empresa_id = $1 and clave = 'antifraude'`, [E])).rows[0]?.valor) ?? {} }),
  };
}

const prodSql = `select d.nombre_producto as producto, sum(d.cantidad)::numeric as unidades, sum(d.monto / (1 + d.impuesto_tasa))::numeric as venta,
                        case when bool_or(d.costo_unitario is not null) then sum(d.costo_unitario * d.cantidad) filter (where d.costo_unitario is not null) end as costo
                   from pos.detalle_venta d join pos.ventas v on v.id = d.venta_id
                  where v.empresa_id = $1 and v.estado = 'pagada' and ($2::uuid[] = '{}' or v.sucursal_id = any($2::uuid[]))
                    and ${FECHA('v.fecha_emision')} between $3::date and $4::date group by 1`;
const gastoSql = `select coalesce(c.nombre, 'Sin categoría') as categoria, coalesce(c.grupo, 'otro') as grupo, sum(g.monto - g.isv)::numeric as monto
                    from fin.gastos g left join fin.categorias_gasto c on c.id = g.categoria_id
                   where g.empresa_id = $1 and not g.anulado and g.fecha between $2::date and $3::date group by 1, 2`;
