// ÚNICO punto de contacto de Producción con las existencias de fábrica, que son de Inventario (R3, esquema
// rinv; ver el recuadro de integración al inicio de supabase/migrations/0019_prod.sql).
//
// El catálogo de materia prima de costeo (prod.costeo_insumos) y el de inventario (rinv.insumos_fab) se
// reconocen por (empresa, nombre). Si un insumo no está en rinv, el consumo de la tanda se registra igual
// pero sin mover existencias (y se avisa «sin inventario»): producir nunca se bloquea por inventario.
import { redondear } from './comun.js';

/** ¿Existe el esquema de inventario? (en producción siempre; protege entornos a medio migrar) */
export async function hayInventario(q) {
  try { return (await q.query("select to_regclass('rinv.insumos_fab') is not null as ok")).rows[0].ok; } catch { return false; }
}

/** nombre en MAYÚSCULAS → { id, tipo, unidad, stock_actual } de rinv.insumos_fab. */
export async function rinvPorNombre(q, empresaId, nombres) {
  const mapa = new Map();
  if (!nombres.length || !(await hayInventario(q))) return mapa;
  const { rows } = await q.query(
    `select id, upper(nombre) as nombre, tipo, unidad, stock_actual::float8 as stock_actual
       from rinv.insumos_fab where empresa_id = $1 and upper(nombre) = any($2::text[])`, [empresaId, nombres.map((n) => n.toUpperCase())]);
  for (const r of rows) mapa.set(r.nombre, r);
  return mapa;
}

/** Lotes Mec3 con saldo, lo más viejo primero: rinvInsumoId → [{ id, restante }]. */
export async function lotesDisponibles(q, rinvIds) {
  const mapa = new Map();
  if (!rinvIds.length) return mapa;
  const { rows } = await q.query(
    `select id, insumo_id, cantidad_restante::float8 as restante from rinv.lotes_mec3
      where insumo_id = any($1::uuid[]) and cantidad_restante > 0 order by fecha_ingreso asc, n asc`, [rinvIds]);
  for (const l of rows) {
    if (!mapa.has(l.insumo_id)) mapa.set(l.insumo_id, []);
    mapa.get(l.insumo_id).push({ id: l.id, restante: l.restante });
  }
  return mapa;
}

async function mover(q, ctx, { rinvId, cantidad, motivo, tipo }) {
  const signo = tipo === 'salida' ? '-' : '+';
  // El saldo puede quedar negativo: la tanda ya se hizo, y un stock en rojo es un dato útil («aquí falta cargar una entrada»).
  const r = await q.query(
    `update rinv.insumos_fab set stock_actual = round(coalesce(stock_actual, 0) ${signo} $1::numeric, 2), stock_actualizado_en = now()
      where id = $2 and empresa_id = $3 returning stock_actual::float8 as saldo`, [cantidad, rinvId, ctx.empresa.id]);
  if (!r.rows.length) return null;
  const saldo = r.rows[0].saldo;
  await q.query(
    `insert into rinv.movimientos (empresa_id, ambito, insumo_fab_id, tipo, cantidad, saldo_resultante, motivo, rol, usuario_id, usuario_nombre)
     values ($1,'fabrica',$2,$3,$4,$5,$6,'produccion',$7,$8)`,
    [ctx.empresa.id, rinvId, tipo, cantidad, saldo, motivo, ctx.usuario?.id ?? null, ctx.usuario?.nombre ?? null]);
  return saldo;
}

export const aplicarSalida = (q, ctx, d) => mover(q, ctx, { ...d, tipo: 'salida' });
export const devolverEntrada = (q, ctx, d) => mover(q, ctx, { ...d, tipo: 'entrada' });

/** Suma (o resta, si delta < 0) a lo que queda de un lote, sin pasarse de 0 ni de lo que entró. */
export async function ajustarLote(q, loteId, delta) {
  await q.query(
    `update rinv.lotes_mec3 set cantidad_restante = greatest(0, least(cantidad_inicial, round(cantidad_restante + $1::numeric, 3))) where id = $2`,
    [redondear(delta, 4), loteId]);
}
