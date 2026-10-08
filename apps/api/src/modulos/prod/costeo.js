// Motor de costeo de gelato (portado de lib/costeo.js del original «Italo Reposición»):
// cuánto cuesta REALMENTE producir cada sabor con los precios reales de los insumos vigentes
// en cada fecha. Las reglas están aquí a propósito, para no reintroducir los bugs que ya se corrigieron:
//
//   1. El precio vigente de un insumo a una fecha es el MÁS RECIENTE con fecha_vigencia <= esa
//      fecha (empate: el de mayor id). Reacciona a subidas y a bajadas.
//   2. Costo por kg de una receta = costo total del LOTE de la receta / peso del lote en kg.
//   3. Todo o nada: si falta el precio de UN ingrediente a esa fecha, el costo de la receta es
//      null (incompleto), nunca un número aproximado.
//   4. El costo de cada tanda se congela con el precio vigente a la fecha de ESA tanda y no se
//      recalcula después, salvo al «recalcular pendientes» (las que quedaron en null).
//
// Las funciones *Cache trabajan 100 % en memoria sobre lo que cargan cargarPrecios/cargarRecetas
// (una consulta por tabla, nada de N+1). Todo va filtrado por empresa.
import { sumarDias } from '@grupo/shared';
import { num } from './comun.js';

/** Historial de precios de todos los insumos de la empresa, agrupado por insumo. */
export async function cargarPrecios(q, empresaId) {
  const { rows } = await q.query(
    `select insumo_id, fecha_vigencia::text as fecha_vigencia, lps_kg::float8 as lps_kg, id
       from prod.costeo_precios where empresa_id = $1 order by insumo_id, fecha_vigencia, id`, [empresaId]);
  const mapa = new Map();
  for (const f of rows) {
    if (!mapa.has(f.insumo_id)) mapa.set(f.insumo_id, []);
    mapa.get(f.insumo_id).push(f);
  }
  return mapa;
}

/** Precio vigente de un insumo a una fecha (null si no tenía precio ese día). */
export function precioVigente(precios, insumoId, fechaISO) {
  const filas = precios.get(insumoId);
  if (!filas?.length) return null;
  let mejor = null;
  for (const f of filas) {
    if (f.fecha_vigencia > fechaISO) continue;
    if (!mejor || f.fecha_vigencia > mejor.fecha_vigencia || (f.fecha_vigencia === mejor.fecha_vigencia && f.id > mejor.id)) mejor = f;
  }
  return mejor ? mejor.lps_kg : null;
}

/**
 * Todas las recetas con sus ingredientes. Se cargan primero las recetas (tengan o no ingredientes)
 * y después los renglones: una receta recién creada sin ingredientes tiene que figurar como
 * «existe pero incompleta», distinto de «el sabor no tiene receta».
 */
export async function cargarRecetas(q, empresaId) {
  const [recetas, items] = await Promise.all([
    q.query('select id, sabor_id, nombre, precio_venta_kg::float8 as precio_venta_kg from prod.costeo_recetas where empresa_id = $1', [empresaId]),
    q.query(`select ri.receta_id, ri.insumo_id, ri.gramos::float8 as gramos from prod.receta_insumos ri
               join prod.costeo_recetas r on r.id = ri.receta_id where r.empresa_id = $1 order by ri.id`, [empresaId]),
  ]);
  const mapa = new Map();
  for (const r of recetas.rows) mapa.set(r.id, { id: r.id, saborId: r.sabor_id, nombre: r.nombre, precioVentaKg: r.precio_venta_kg, items: [], pesoTotalGramos: 0 });
  for (const i of items.rows) {
    const r = mapa.get(i.receta_id);
    if (!r) continue;
    r.items.push({ insumoId: i.insumo_id, gramos: i.gramos });
    r.pesoTotalGramos += i.gramos;
  }
  return mapa;
}

/** sabor_id → id de receta (solo las recetas ya enganchadas a un sabor). */
export function indiceRecetaPorSabor(recetas) {
  const mapa = new Map();
  for (const [id, r] of recetas) if (r.saborId) mapa.set(r.saborId, id);
  return mapa;
}

/** Costo por KG DEL LOTE de una receta a una fecha. null si no tiene ingredientes o falta algún precio. */
export function costoKgReceta(recetaId, fechaISO, recetas, precios) {
  const r = recetas.get(recetaId);
  if (!r || !r.items.length) return null;
  let total = 0;
  for (const it of r.items) {
    const p = precioVigente(precios, it.insumoId, fechaISO);
    if (p === null) return null;               // todo o nada
    total += (it.gramos * p) / 1000;
  }
  return total / (r.pesoTotalGramos / 1000);
}

/** Costo de una tanda para congelar. null si el sabor no tiene receta o el costeo está incompleto. */
export function congelarCosto(saborId, fechaISO, kg, recetas, precios, indice) {
  const recetaId = indice.get(saborId);
  if (recetaId === undefined) return { costoKg: null, costoTotal: null };
  const costoKg = costoKgReceta(recetaId, fechaISO, recetas, precios);
  if (costoKg === null) return { costoKg: null, costoTotal: null };
  return { costoKg, costoTotal: costoKg * kg };
}

/**
 * Desglose de una receta a una fecha: cada ingrediente con su precio vigente y su costo en el lote,
 * el costo del lote, el costo por kg y, si la receta tiene precio de venta por kg, el margen.
 * `completo` es false si a algún ingrediente le falta el precio (entonces los totales son null).
 */
export function desglosarReceta(receta, nombres, fechaISO, precios) {
  let completo = receta.items.length > 0;
  const lineas = receta.items.map((it) => {
    const precio = precioVigente(precios, it.insumoId, fechaISO);
    if (precio === null) completo = false;
    return { insumo_id: it.insumoId, insumo_nombre: nombres.get(it.insumoId) ?? '(borrado)', gramos: it.gramos, precio_vigente: precio, costo: precio === null ? null : (it.gramos * precio) / 1000 };
  });
  const pesoKg = receta.pesoTotalGramos / 1000;
  const costoLote = completo ? lineas.reduce((a, l) => a + l.costo, 0) : null;
  const costoKg = completo ? costoLote / pesoKg : null;
  const pv = receta.precioVentaKg;
  const margen = costoKg !== null && pv > 0 ? { por_kg: pv - costoKg, pct: ((pv - costoKg) / pv) * 100 } : null;
  return { lineas: lineas.map((l) => ({ ...l, pct_costo: costoLote ? (l.costo / costoLote) * 100 : null })), peso_lote_g: receta.pesoTotalGramos, costo_lote: costoLote, costo_kg: costoKg, precio_venta_kg: pv, margen };
}

/**
 * Consumo teórico de insumos en un rango: reparto proporcional de cada tanda real según su receta.
 * «¿Cuántos kg de leche o de pasta de pistacho se usaron de verdad entre estas fechas y cuánto costó?»
 * No son compras: es producción real × receta.
 */
export async function calcularConsumoInsumos(q, empresaId, desde, hasta) {
  const [prods, recetas, precios, insumos] = await Promise.all([
    q.query('select sabor_id, fecha::text as fecha, kg::float8 as kg from prod.producciones where empresa_id = $1 and fecha >= $2 and fecha <= $3', [empresaId, desde, hasta]),
    cargarRecetas(q, empresaId),
    cargarPrecios(q, empresaId),
    q.query('select id, nombre, tipo, unidad from prod.costeo_insumos where empresa_id = $1', [empresaId]),
  ]);
  const indice = indiceRecetaPorSabor(recetas);
  const insumoPorId = new Map(insumos.rows.map((i) => [i.id, i]));
  const porInsumo = new Map();
  let considerada = 0, sinReceta = 0, sinIngredientes = 0;
  for (const p of prods.rows) {
    const recetaId = indice.get(p.sabor_id);
    if (recetaId === undefined) { sinReceta += p.kg; continue; }
    const receta = recetas.get(recetaId);
    if (!receta.items.length) { sinIngredientes += p.kg; continue; }
    considerada += p.kg;
    for (const it of receta.items) {
      const gramos = (it.gramos / receta.pesoTotalGramos) * (p.kg * 1000);
      const precio = precioVigente(precios, it.insumoId, p.fecha);
      if (!porInsumo.has(it.insumoId)) porInsumo.set(it.insumoId, { insumo_id: it.insumoId, kg_consumido: 0, costo_total: 0, kg_sin_precio: 0 });
      const acc = porInsumo.get(it.insumoId);
      acc.kg_consumido += gramos / 1000;
      if (precio === null) acc.kg_sin_precio += gramos / 1000; else acc.costo_total += (gramos / 1000) * precio;
    }
  }
  const lista = [...porInsumo.values()].map((r) => {
    const i = insumoPorId.get(r.insumo_id) ?? { nombre: '(borrado)', tipo: '', unidad: 'kg' };
    return { ...r, nombre: i.nombre, tipo: i.tipo, unidad: i.unidad };
  }).sort((a, b) => b.costo_total - a.costo_total);
  return { desde, hasta, insumos: lista, kg_produccion_considerada: considerada, kg_produccion_sin_receta: sinReceta, kg_produccion_receta_sin_ingredientes: sinIngredientes };
}

const primerDiaDelMes = (f) => `${f.slice(0, 7)}-01`;
function mesAnterior(f) {
  const [y, m] = f.split('-').map(Number);
  const desde = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  const hasta = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
  return { desde, hasta };
}

async function sumaRango(q, empresaId, desde, hasta) {
  const r = (await q.query(
    `select coalesce(sum(costo_total_congelado),0)::float8 as costo_total, coalesce(sum(kg),0)::float8 as kg_total
       from prod.producciones where empresa_id = $1 and fecha >= $2 and fecha <= $3 and costo_total_congelado is not null`, [empresaId, desde, hasta])).rows[0];
  return { costo_total: r.costo_total, kg_total: r.kg_total, costo_promedio_kg: r.kg_total > 0 ? r.costo_total / r.kg_total : 0 };
}

const porSaborRango = async (q, empresaId, desde, hasta) => (await q.query(
  `select p.sabor_id, sa.nombre as sabor_nombre, sum(p.costo_total_congelado)::float8 as costo_total, sum(p.kg)::float8 as kg_total
     from prod.producciones p join rep.sabores sa on sa.id = p.sabor_id
    where p.empresa_id = $1 and p.fecha >= $2 and p.fecha <= $3 and p.costo_total_congelado is not null
    group by p.sabor_id, sa.nombre order by costo_total desc`, [empresaId, desde, hasta])).rows;

/** Panorama del dueño: hoy, semana, mes, mes anterior, top sabores/insumos, costo teórico de hoy por sabor y serie de 30 días. */
export async function resumenCosteo(q, empresaId, hoy) {
  const desdeSemana = sumarDias(hoy, -6);
  const desdeMes = primerDiaDelMes(hoy);
  const ant = mesAnterior(hoy);
  const desde30 = sumarDias(hoy, -29);
  const [hoyS, semana, mes, mesAnt, topSabores, serie, recetas, precios, sabores, consumo] = await Promise.all([
    sumaRango(q, empresaId, hoy, hoy), sumaRango(q, empresaId, desdeSemana, hoy), sumaRango(q, empresaId, desdeMes, hoy), sumaRango(q, empresaId, ant.desde, ant.hasta),
    porSaborRango(q, empresaId, desdeMes, hoy),
    q.query(`select fecha::text as fecha, coalesce(sum(kg),0)::float8 as kg_total, coalesce(sum(costo_total_congelado),0)::float8 as costo_total
               from prod.producciones where empresa_id = $1 and fecha >= $2 and fecha <= $3 group by fecha order by fecha`, [empresaId, desde30, hoy]),
    cargarRecetas(q, empresaId), cargarPrecios(q, empresaId),
    q.query('select id, nombre from rep.sabores where empresa_id = $1 and activo order by nombre', [empresaId]),
    calcularConsumoInsumos(q, empresaId, desdeMes, hoy),
  ]);
  const indice = indiceRecetaPorSabor(recetas);
  const teorico = sabores.rows.map((s) => {
    const rid = indice.get(s.id);
    return { sabor_id: s.id, sabor_nombre: s.nombre, tiene_receta: rid !== undefined, costo_kg_hoy: rid !== undefined ? costoKgReceta(rid, hoy, recetas, precios) : null };
  }).sort((a, b) => (b.costo_kg_hoy ?? -1) - (a.costo_kg_hoy ?? -1));
  return {
    fecha: hoy, hoy: hoyS, semana, mes, mes_anterior: mesAnt,
    variacion_mes_pct: mesAnt.costo_total > 0 ? ((mes.costo_total - mesAnt.costo_total) / mesAnt.costo_total) * 100 : null,
    top_sabores_mes: topSabores.slice(0, 5), top_insumos_mes: consumo.insumos.slice(0, 8),
    costo_teorico_hoy_por_sabor: teorico, produccion_diaria_30_dias: serie.rows,
  };
}

/** Mismo agregado, para un rango elegido a mano. */
export async function resumenCosteoRango(q, empresaId, desde, hasta) {
  const [total, por] = await Promise.all([sumaRango(q, empresaId, desde, hasta), porSaborRango(q, empresaId, desde, hasta)]);
  return { desde, hasta, ...total, por_sabor: por };
}

/**
 * Qué pasa con las recetas si el precio de un insumo cambia: para cada receta que lo usa, su costo por kg
 * antes y después (a la fecha dada). Sirve para decidir ANTES de guardar un precio nuevo.
 */
export function impactoDePrecio({ insumoId, nuevoLpsKg, fechaISO, recetas, precios, nombreSabor }) {
  const mod = new Map(precios);
  mod.set(insumoId, [...(precios.get(insumoId) ?? []), { insumo_id: insumoId, fecha_vigencia: fechaISO, lps_kg: nuevoLpsKg, id: Number.MAX_SAFE_INTEGER }]);
  const out = [];
  for (const [id, r] of recetas) {
    if (!r.items.some((i) => i.insumoId === insumoId)) continue;
    const antes = costoKgReceta(id, fechaISO, recetas, precios);
    const despues = costoKgReceta(id, fechaISO, recetas, mod);
    out.push({ receta_id: id, nombre: r.saborId ? (nombreSabor.get(r.saborId) ?? r.nombre) : r.nombre, antes, despues, variacion_pct: antes && despues !== null ? ((despues - antes) / antes) * 100 : null });
  }
  return out.sort((a, b) => Math.abs(b.variacion_pct ?? 0) - Math.abs(a.variacion_pct ?? 0));
}

export { num };
