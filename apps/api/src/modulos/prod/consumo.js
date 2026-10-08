// Consumo de materia prima por tanda y rastro del lote que la alimentó (portado de lib/consumoTanda.js
// y lib/trazabilidad.js del original).
//
// Qué hace: dado el sabor y los kg de una tanda, sugiere cuánta materia prima se llevó según la receta;
// quien confirma puede corregir lo que de verdad se usó. Se guardan las DOS cifras (la receta es teórica:
// la diferencia acumulada es el rendimiento real). Al confirmar se descuenta del inventario de fábrica
// (existencias.js, rinv) con reparto FIFO entre lotes Mec3. Corregir o borrar la tanda lo deshace.
//
// La receta es información sensible (es el producto): estas funciones solo las usan rutas que exigen
// rep:costeo o rep:inventario. Producción registra la tanda sin ver ni descontar nada.
import { cargarRecetas, indiceRecetaPorSabor } from './costeo.js';
import { redondear } from './comun.js';
import { aplicarSalida, devolverEntrada, ajustarLote, lotesDisponibles, rinvPorNombre } from './existencias.js';

// Tolerancia para comparar cantidades con decimales (restar 1.5 tres veces a 4.5 deja basura binaria).
const EPSILON = 1e-6;

/**
 * Cuánta materia prima DEBERÍA llevarse una tanda de `kg` según la receta (en kg de insumo).
 * La receta guarda gramos sobre un lote de `pesoTotalGramos`; se escala al tamaño real de la tanda.
 * Es una SUGERENCIA, no la verdad.
 */
export function consumoSegunReceta(receta, kg) {
  if (!receta || !receta.items.length || receta.pesoTotalGramos <= 0) return [];
  const factor = kg / (receta.pesoTotalGramos / 1000);
  return receta.items
    .map((i) => ({ insumoId: i.insumoId, cantidad: redondear((i.gramos * factor) / 1000) }))
    .filter((i) => i.cantidad > 0);
}

/**
 * Reparte una cantidad entre orígenes FIFO (lo más viejo primero), tomando parcialmente de cada uno.
 * `disponibles` viene YA ordenado; `restante` es lo que le queda a cada origen. `sinOrigen` es lo que
 * no se pudo cubrir: se devuelve en vez de silenciarse (en trazabilidad, «no se sabe de qué lote venía»
 * es una respuesta válida).
 */
export function repartirFifo({ disponibles, cantidad }) {
  const tomas = [];
  let pendiente = redondear(cantidad);
  for (const o of disponibles) {
    if (pendiente <= EPSILON) break;
    const restante = redondear(Number(o.restante) || 0);
    if (restante <= EPSILON) continue;
    const toma = Math.min(restante, pendiente);
    tomas.push({ id: o.id, cantidad: redondear(toma) });
    pendiente = redondear(pendiente - toma);
  }
  return { tomas, sinOrigen: pendiente > EPSILON ? pendiente : 0 };
}

/** Cuánto se apartó lo real de la receta, en %. null si no hay con qué comparar (≠ «dio 0 %»). */
export function desviacion(sugerido, real) {
  const s = Number(sugerido), r = Number(real);
  if (sugerido === null || sugerido === undefined || !Number.isFinite(s) || !Number.isFinite(r) || s <= 0) return null;
  return redondear(((r - s) / s) * 100, 1);
}
export const DESVIACION_NOTABLE = 10;     // debajo de esto es ruido de balanza
export const esDesviacionNotable = (pct) => pct !== null && Math.abs(pct) >= DESVIACION_NOTABLE;

/** ¿La tanda ya salió en algún despacho? Entonces no se puede corregir ni borrar (se perdería el rastro). */
export async function tandaYaDespachada(q, empresaId, tandaId) {
  const r = await q.query('select count(*)::int as n from rep.despacho_tandas where empresa_id = $1 and produccion_id = $2', [empresaId, tandaId]);
  return r.rows[0].n > 0;
}

/**
 * Qué insumos toca la tanda y de qué lotes salen, SIN escribir nada.
 * `declarados` = [{insumo_id, cantidad}] si quien confirma corrigió lo que la receta sugería.
 */
export async function planificarConsumo(q, empresaId, { saborId, kg, declarados = null }) {
  const recetas = await cargarRecetas(q, empresaId);
  const recetaId = indiceRecetaPorSabor(recetas).get(saborId);
  const receta = recetaId === undefined ? null : recetas.get(recetaId);
  const sugerido = consumoSegunReceta(receta, kg);
  const sugeridoPorInsumo = new Map(sugerido.map((s) => [s.insumoId, s.cantidad]));
  const real = declarados
    ? declarados.map((c) => ({ insumoId: c.insumo_id, cantidad: redondear(Number(c.cantidad)) })).filter((c) => Number.isFinite(c.cantidad) && c.cantidad > 0)
    : sugerido;

  const ids = [...new Set(real.map((r) => r.insumoId))];
  const insumos = ids.length
    ? (await q.query('select id, nombre, tipo, unidad from prod.costeo_insumos where empresa_id = $1 and id = any($2::uuid[])', [empresaId, ids])).rows
    : [];
  const porId = new Map(insumos.map((i) => [i.id, i]));
  const desconocidos = ids.filter((id) => !porId.has(id));
  const enRinv = await rinvPorNombre(q, empresaId, insumos.map((i) => i.nombre));
  const lotes = await lotesDisponibles(q, [...enRinv.values()].map((x) => x.id));

  // Un insumo repetido en la lista se junta (una sola fila por tanda e insumo).
  const juntos = new Map();
  for (const r of real) juntos.set(r.insumoId, redondear((juntos.get(r.insumoId) || 0) + r.cantidad));

  const consumos = [];
  for (const [insumoId, cantidad] of juntos) {
    const insumo = porId.get(insumoId);
    if (!insumo) continue;
    const inv = enRinv.get(insumo.nombre.toUpperCase()) ?? null;
    let tomas = [], sinLote = cantidad;
    // Los lotes son solo de materia prima Mec3; la leche y la fruta no llevan lote.
    if (inv && insumo.tipo === 'mec3') {
      const reparto = repartirFifo({ disponibles: lotes.get(inv.id) || [], cantidad });
      tomas = reparto.tomas;
      sinLote = reparto.sinOrigen;
    }
    consumos.push({
      insumo_id: insumoId, nombre: insumo.nombre, unidad: insumo.unidad, tipo: insumo.tipo, cantidad,
      sugerida: sugeridoPorInsumo.has(insumoId) ? sugeridoPorInsumo.get(insumoId) : null,
      rinv_insumo_id: inv?.id ?? null, stock_actual: inv?.stock_actual ?? null, tomas, sin_lote: sinLote,
    });
  }
  return {
    tiene_receta: receta !== null, receta_con_ingredientes: !!receta?.items.length, consumos, desconocidos,
    sin_inventario: consumos.filter((c) => !c.rinv_insumo_id).map((c) => c.nombre),
  };
}

/**
 * Confirma el consumo de una tanda: deshace el que hubiera, descuenta del inventario y guarda
 * consumo + lotes. Todo dentro de la transacción de `q`.
 */
export async function aplicarConsumo(q, ctx, tanda, declarados = null) {
  await revertirConsumo(q, ctx, tanda.id, `Se volvió a confirmar el consumo de la tanda ${tanda.lote}`);
  const plan = await planificarConsumo(q, ctx.empresa.id, { saborId: tanda.sabor_id, kg: Number(tanda.kg), declarados });
  const motivo = `Tanda ${tanda.lote}`;
  for (const c of plan.consumos) {
    if (c.rinv_insumo_id) await aplicarSalida(q, ctx, { rinvId: c.rinv_insumo_id, cantidad: c.cantidad, motivo });
    await q.query(
      `insert into prod.consumos (empresa_id, produccion_id, insumo_id, cantidad_sugerida, cantidad_real, sin_lote, rinv_insumo_id)
       values ($1,$2,$3,$4,$5,$6,$7)`, [ctx.empresa.id, tanda.id, c.insumo_id, c.sugerida, c.cantidad, c.sin_lote, c.rinv_insumo_id]);
    for (const t of c.tomas) {
      await q.query('insert into prod.produccion_lotes (empresa_id, produccion_id, lote_id, insumo_id, cantidad) values ($1,$2,$3,$4,$5)', [ctx.empresa.id, tanda.id, t.id, c.insumo_id, t.cantidad]);
      await ajustarLote(q, t.id, -t.cantidad);
    }
  }
  return plan;
}

/**
 * Deshace el consumo de una tanda: devuelve la materia prima al stock y a los lotes de donde salió.
 * El kardex NO se borra: se le agrega un renglón de entrada con el motivo, para que el movimiento
 * equivocado y su corrección queden a la vista. Devuelve true si había algo que deshacer.
 */
export async function revertirConsumo(q, ctx, tandaId, motivo = 'Corrección de tanda') {
  const [consumos, lotes] = await Promise.all([
    q.query('select insumo_id, cantidad_real::float8 as cantidad, rinv_insumo_id from prod.consumos where produccion_id = $1', [tandaId]),
    q.query('select lote_id, cantidad::float8 as cantidad from prod.produccion_lotes where produccion_id = $1', [tandaId]),
  ]);
  for (const c of consumos.rows) if (c.rinv_insumo_id) await devolverEntrada(q, ctx, { rinvId: c.rinv_insumo_id, cantidad: c.cantidad, motivo });
  for (const l of lotes.rows) await ajustarLote(q, l.lote_id, l.cantidad);
  await q.query('delete from prod.produccion_lotes where produccion_id = $1', [tandaId]);
  await q.query('delete from prod.consumos where produccion_id = $1', [tandaId]);
  return consumos.rows.length > 0;
}
