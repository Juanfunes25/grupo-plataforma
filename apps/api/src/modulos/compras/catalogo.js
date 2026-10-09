// Lo que se puede comprar en una empresa: la unión de sus catálogos de inventario, con existencia, mínimos,
// lo que ya viene en camino (órdenes enviadas) y el último precio pagado. Solo lectura sobre las tablas de cada inventario.
import { sugerirCantidad, r2 } from './calculo.js';

const SQL_ITEMS = `
  select 'inv'::text as origen, i.id, i.nombre, i.unidad, i.categoria,
         coalesce((select sum(m.cantidad) from inv.movimientos m where m.insumo_id = i.id), 0)::float8 as stock,
         i.stock_minimo::float8 as minimo, null::float8 as maximo, i.costo_actual::float8 as costo
    from inv.insumos i where i.empresa_id = $1 and i.activo
  union all
  select 'fab', i.id, i.nombre, i.unidad, i.categoria,
         coalesce((select s.stock from fab.stock_insumos s where s.insumo_id = i.id), 0)::float8,
         i.stock_minimo::float8, null, i.costo_promedio::float8
    from fab.insumos i where i.empresa_id = $1 and i.activo
  union all
  select 'rinv_fab', i.id, i.nombre, i.unidad, i.categoria,
         i.stock_actual::float8, i.stock_minimo::float8, i.stock_maximo::float8, null
    from rinv.insumos_fab i where i.empresa_id = $1 and i.activo
  union all
  select 'rep_suc', c.id, c.nombre, c.unidad, c.categoria,
         (select sum(s.cantidad) from rinv.stock_suc s where s.insumo_id = c.id)::float8,
         null, null, null
    from rep.insumos_catalogo c where c.empresa_id = $1 and c.activo
  union all
  select 'dis', p.id, p.nombre, p.unidad, null,
         coalesce((select e.existencia from dis.existencias e where e.producto_id = p.id), 0)::float8,
         p.stock_minimo::float8, null, x.costo_estandar::float8
    from pos.productos p join dis.producto_ext x on x.producto_id = p.id
   where p.empresa_id = $1 and p.activo and x.controla_inventario`;

export async function leerCatalogo(db, empresaId) {
  const [items, camino, ultimos] = await Promise.all([
    db.query(`${SQL_ITEMS} order by 3`, [empresaId]),
    db.query(
      `select l.origen, l.item_id, sum(l.cantidad - l.cantidad_recibida)::float8 as cantidad
         from cmp.orden_lineas l join cmp.ordenes o on o.id = l.orden_id
        where o.empresa_id = $1 and o.estado in ('enviada','recibida_parcial') group by 1, 2`, [empresaId]),
    db.query(
      `select distinct on (p.origen, p.item_id) p.origen, p.item_id, p.proveedor_id, t.nombre as proveedor, p.fecha::text as fecha, p.moneda,
              p.precio::float8 as precio, p.tipo_cambio::float8 as tipo_cambio, p.precio_lps::float8 as precio_lps
         from cmp.precios p left join core.terceros t on t.id = p.proveedor_id
        where p.empresa_id = $1 order by p.origen, p.item_id, p.fecha desc, p.id desc`, [empresaId]),
  ]);
  const mapaCamino = new Map(camino.rows.map((c) => [`${c.origen}:${c.item_id}`, c.cantidad]));
  const mapaUltimo = new Map(ultimos.rows.map((u) => [`${u.origen}:${u.item_id}`, u]));
  return items.rows.map((i) => {
    const k = `${i.origen}:${i.id}`;
    const en_camino = mapaCamino.get(k) ?? 0;
    return {
      ...i, en_camino, ultimo: mapaUltimo.get(k) ?? null,
      sin_conteo: i.stock === null,
      bajo_minimo: i.stock !== null && i.minimo > 0 && i.stock <= i.minimo,
      sugerido: sugerirCantidad({ stock: i.stock, minimo: i.minimo, maximo: i.maximo, enCamino: en_camino }),
    };
  });
}

/** Sugerencias de reorden: lo que está en o bajo su mínimo y no está ya cubierto por lo que viene en camino. */
export function sugerenciasReorden(catalogo) {
  return catalogo
    .filter((i) => i.bajo_minimo)
    .map((i) => {
      const ref = i.ultimo?.precio_lps ?? i.costo ?? null;
      return { ...i, cubierto_en_camino: i.sugerido === 0, costo_estimado_lps: ref !== null ? r2(ref * i.sugerido) : null };
    })
    .sort((a, b) => (a.stock / (a.minimo || 1)) - (b.stock / (b.minimo || 1)));
}
