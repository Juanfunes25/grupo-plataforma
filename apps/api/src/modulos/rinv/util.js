import { fechaHN } from '@grupo/shared';
import { noEncontrado } from '../../lib/http.js';
import { redondearSaldo, repartirFifo } from './calculo.js';

export const empresaDe = (req) => req.ctx.empresa.id;

/** Texto limpio o null. */
export function texto(v) {
  const t = String(v ?? '').trim();
  return t || null;
}

/** El movimiento ya aplicado con ese cliente_id (un reintento de algo que ya se hizo), o null. */
export async function movimientoPorCliente(q, empresaId, clienteId) {
  if (!clienteId) return null;
  return (await q.query('select id, saldo_resultante from rinv.movimientos where empresa_id = $1 and cliente_id = $2', [empresaId, clienteId])).rows[0] ?? null;
}

/** Escribe un renglón del kardex (solo inserta; el kardex es inalterable). */
export async function registrarMov(q, ctx, m) {
  await q.query(
    `insert into rinv.movimientos (empresa_id, ambito, sucursal_id, insumo_fab_id, insumo_suc_id, tipo, cantidad, saldo_resultante, motivo, rol, usuario_id, usuario_nombre, cliente_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [ctx.empresa.id, m.ambito, m.sucursalId ?? null, m.insumoFabId ?? null, m.insumoSucId ?? null, m.tipo, m.cantidad, m.saldo, m.motivo ?? null,
      ctx.rol, ctx.usuario.id, ctx.usuario.nombre, m.clienteId ?? null]);
}

/**
 * Corregir el total a mano (conteo físico) se traduce a una entrada o salida según para qué lado cambió,
 * para que el kardex quede uniforme. Si no cambió nada no se registra nada.
 */
export async function registrarAjusteAbsoluto(q, ctx, { anterior, nuevo, motivo, ...ref }) {
  const delta = redondearSaldo(nuevo - (Number(anterior) || 0));
  if (delta === 0) return;
  await registrarMov(q, ctx, {
    ...ref, tipo: delta > 0 ? 'entrada' : 'salida', cantidad: Math.abs(delta), saldo: nuevo,
    motivo: texto(motivo) ?? 'Ajuste manual (conteo/corrección)',
  });
}

export async function insumoFab(q, empresaId, id, { bloquear = false, incluirArchivados = false } = {}) {
  const r = await q.query(
    `select * from rinv.insumos_fab where id = $1 and empresa_id = $2 ${incluirArchivados ? '' : 'and activo'} ${bloquear ? 'for update' : ''}`, [id, empresaId]);
  if (!r.rows[0]) throw noEncontrado('Insumo no encontrado');
  return r.rows[0];
}

export async function insumoSuc(q, empresaId, id, { bloquear = false, incluirArchivados = false } = {}) {
  const r = await q.query(
    `select * from rep.insumos_catalogo where id = $1 and empresa_id = $2 ${incluirArchivados ? '' : 'and activo'} ${bloquear ? 'for update' : ''}`, [id, empresaId]);
  if (!r.rows[0]) throw noEncontrado('Insumo no encontrado');
  return r.rows[0];
}

/** Abre un lote nuevo de Mec3 (cada entrada vence al año de haber llegado). */
export async function registrarLote(q, empresaId, { insumoId, cantidad, fechaIngreso, fechaVencimiento, motivo }) {
  await q.query(
    `insert into rinv.lotes_mec3 (empresa_id, insumo_id, cantidad_inicial, cantidad_restante, fecha_ingreso, fecha_vencimiento, motivo)
     values ($1,$2,$3,$3,$4,$5,$6)`,
    [empresaId, insumoId, cantidad, fechaIngreso, fechaVencimiento, motivo ?? null]);
}

/**
 * Descuenta una salida de los lotes más viejos primero (FIFO) y anota de qué lote salió y qué día.
 * Best-effort a propósito: si los lotes no alcanzan (stock anterior a llevar lotes) se descuenta lo
 * que haya y el resto pasa sin bloquear; el stock total sigue siendo la verdad.
 */
export async function consumirLotesFifo(q, empresaId, insumoId, cantidad, motivo) {
  const { rows } = await q.query(
    'select id, cantidad_restante from rinv.lotes_mec3 where insumo_id = $1 and cantidad_restante > 0 order by fecha_ingreso, n for update', [insumoId]);
  const { tomas } = repartirFifo({ disponibles: rows.map((l) => ({ id: l.id, restante: l.cantidad_restante })), cantidad });
  const hoy = fechaHN();
  for (const t of tomas) {
    await q.query('update rinv.lotes_mec3 set cantidad_restante = greatest(round(cantidad_restante - $2, 3), 0) where id = $1', [t.id, t.cantidad]);
    await q.query(
      'insert into rinv.salida_lotes (empresa_id, lote_id, insumo_id, cantidad, fecha, motivo) values ($1,$2,$3,$4,$5,$6)',
      [empresaId, t.id, insumoId, t.cantidad, hoy, motivo ?? null]);
  }
  return tomas;
}

/** Busca un código de barras en los dos catálogos a la vez (para saber a cuál pertenece). */
export async function buscarPorCodigoBarras(q, empresaId, codigo) {
  const f = (await q.query('select id, nombre from rinv.insumos_fab where empresa_id = $1 and codigo_barras = $2 and activo', [empresaId, codigo])).rows[0];
  if (f) return { ambito: 'fabrica', id: f.id, nombre: f.nombre };
  const s = (await q.query('select id, nombre from rep.insumos_catalogo where empresa_id = $1 and codigo_barras = $2 and activo', [empresaId, codigo])).rows[0];
  if (s) return { ambito: 'sucursal', id: s.id, nombre: s.nombre };
  return null;
}

/** Quita un código de barras de donde esté (para reasignarlo a la fuerza). */
export async function soltarCodigoBarras(q, empresaId, codigo) {
  await q.query('update rinv.insumos_fab set codigo_barras = null where empresa_id = $1 and codigo_barras = $2', [empresaId, codigo]);
  await q.query('update rep.insumos_catalogo set codigo_barras = null where empresa_id = $1 and codigo_barras = $2', [empresaId, codigo]);
}

/** Sucursales (activas) de la empresa que el usuario puede ver. */
export async function sucursalesVisibles(q, ctx) {
  const { rows } = await q.query('select id, nombre, alias, tipo, color from core.sucursales where empresa_id = $1 and activo order by orden, nombre', [ctx.empresa.id]);
  return ctx.sucursalIds.length ? rows.filter((s) => ctx.sucursalIds.includes(s.id)) : rows;
}
