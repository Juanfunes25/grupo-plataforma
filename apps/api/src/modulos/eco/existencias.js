// Puente entre ventas/cotizaciones y el inventario de piedra de fábrica (fab.lotes, de F2).
// Contrato: fab.reservar / fab.liberar / fab.consumir (ver supabase/migrations/0014_fab.sql).
import { fechaHN, sumarDias } from '@grupo/shared';
import { crearOrden, alerta } from '../fab/produccion.js';
import { auditar } from '../../lib/auditoria.js';
import { ErrorHttp } from '../../lib/http.js';
import { round3 } from './calculo.js';

export const esFabrica = (ctx) => Boolean(ctx?.empresa?.modulos?.includes('fabrica'));

/** m² de piedra que necesita una cotización, por producto (cajas × m² por caja, o m² netos con desperdicio). */
export async function demandaCotizacion(q, empresaId, lineas) {
  const ids = [...new Set(lineas.map((l) => l.producto_id).filter(Boolean))];
  if (!ids.length) return new Map();
  const prods = new Map((await q.query('select id, nombre, es_piedra, m2_por_caja, unidad_venta from pos.productos where empresa_id = $1 and id = any($2::uuid[])', [empresaId, ids])).rows.map((p) => [p.id, p]));
  const mapa = new Map();
  for (const l of lineas) {
    if (l.tipo !== 'producto' || !l.producto_id) continue;
    const p = prods.get(l.producto_id);
    if (!p?.es_piedra) continue;
    let m2 = 0;
    if (Number(l.cajas) > 0 && Number(p.m2_por_caja) > 0) m2 = Number(l.cajas) * Number(p.m2_por_caja);
    else if (Number(l.m2_neto) > 0) m2 = Number(l.m2_neto) * (1 + Number(l.desperdicio_pct || 0) / 100);
    else if (['m2', 'caja'].includes(p.unidad_venta)) m2 = Number(l.cantidad || 0);
    if (m2 > 0) {
      const previo = mapa.get(p.id) ?? { nombre: p.nombre, m2: 0 };
      previo.m2 += Math.ceil(m2 - 1e-9);
      mapa.set(p.id, previo);
    }
  }
  return mapa;
}

/** Piedra facturada por producto: cantidad × m² por caja (las cajas de EcoStone son de 1 m²). */
export async function demandaVenta(q, empresaId, ventaId) {
  const { rows } = await q.query(
    `select d.producto_id, d.cantidad, p.nombre, p.m2_por_caja from pos.detalle_venta d join pos.productos p on p.id = d.producto_id
      where d.venta_id = $1 and p.empresa_id = $2 and p.es_piedra`, [ventaId, empresaId]);
  const mapa = new Map();
  for (const l of rows) {
    const m2 = Math.ceil(Number(l.cantidad) * (Number(l.m2_por_caja) || 1) - 1e-9);
    const previo = mapa.get(l.producto_id) ?? { nombre: l.nombre, m2: 0 };
    previo.m2 += m2;
    mapa.set(l.producto_id, previo);
  }
  return mapa;
}

/** Existencia de un producto: libre (1ª calidad, lista) más lo reservado para `refId`. */
export async function existenciaDe(q, empresaId, productoId, refId = null) {
  const libre = Number((await q.query(
    `select coalesce(sum(cantidad_libre),0) as n from fab.lotes where empresa_id = $1 and producto_id = $2 and calidad = 'primera' and estado = 'lista'`, [empresaId, productoId])).rows[0].n);
  const propio = refId ? Number((await q.query('select coalesce(sum(cantidad),0) as n from fab.reservas where empresa_id = $1 and ref_id = $2 and producto_id = $3', [empresaId, refId, productoId])).rows[0].n) : 0;
  return round3(libre + propio);
}

/** Faltantes de una demanda: [{ producto, pedido, hay }]. No bloquea por sí solo. */
export async function faltantesDe(q, empresaId, demanda, refId = null) {
  const out = [];
  for (const [id, { nombre, m2 }] of demanda) {
    const hay = await existenciaDe(q, empresaId, id, refId);
    if (hay + 1e-9 < m2) out.push({ producto_id: id, producto: nombre, pedido: m2, hay: Math.max(0, Math.floor(hay + 1e-9)) });
  }
  return out;
}

export async function configPos(q, empresaId) {
  return (await q.query(`select valor from core.config where empresa_id = $1 and clave = 'pos'`, [empresaId])).rows[0]?.valor ?? {};
}

/**
 * Reserva (FIFO por lote) lo que hay y manda a producir lo que falta. Idempotente por cotización.
 * Devuelve { reservado:[{producto,lote,m2}], ordenes:[…], pendientes:[…] }.
 */
export async function reservarCotizacion(q, ctx, cot, lineas) {
  const eid = ctx.empresa.id;
  const demanda = await demandaCotizacion(q, eid, lineas);
  const plan = { reservado: [], ordenes: [], pendientes: [] };
  for (const [productoId, { nombre, m2 }] of demanda) {
    const r = (await q.query('select fab.reservar($1,$2,$3,$4,$5,$6,$7) as r', [eid, productoId, m2, cot.id, String(cot.numero), cot.nombre_cliente, ctx.usuario.id])).rows[0].r;
    for (const l of r.lotes ?? []) plan.reservado.push({ producto: nombre, lote: l.codigo, m2: Number(l.cantidad) });
    const falta = round3(Number(r.faltante));
    if (falta <= 0) continue;
    const enCamino = Number((await q.query(
      `select coalesce(sum(m2_planificado),0) as n from fab.ordenes where empresa_id = $1 and cotizacion_id = $2 and producto_id = $3 and estado in ('planificada','curando')`, [eid, cot.id, productoId])).rows[0].n);
    const porProducir = Math.ceil(falta - enCamino - 1e-9);
    if (porProducir <= 0) continue;
    try {
      const dias = Number((await q.query(`select valor->>'dias_a_inventario' as d from core.config where empresa_id = $1 and clave = 'fab'`, [eid])).rows[0]?.d) || 5;
      const hoy = fechaHN();
      let programada = sumarDias(hoy, 1);
      if (cot.fecha_entrega) { const ideal = sumarDias(String(cot.fecha_entrega).slice(0, 10), -(dias + 3)); if (ideal > programada) programada = ideal; }
      await q.query('savepoint orden_prod');
      const orden = await crearOrden(q, ctx, { producto_id: productoId, m2: porProducir, fecha_programada: programada, cotizacion_id: cot.id, cotizacion_numero: String(cot.numero), notas: `Generada por la cotización #${cot.numero}` });
      await q.query('release savepoint orden_prod');
      plan.ordenes.push({ producto: nombre, lote: orden.lote, m2: porProducir, fecha_programada: orden.fecha_programada });
    } catch (e) {
      await q.query('rollback to savepoint orden_prod').catch(() => {});
      plan.pendientes.push({ producto: nombre, m2: porProducir, motivo: e.message });
    }
  }
  return plan;
}

/** Libera las reservas de una cotización y cancela sus órdenes que aún no arrancan. */
export async function liberarCotizacion(q, ctx, cot) {
  const eid = ctx.empresa.id;
  const liberado = Number((await q.query('select fab.liberar($1,$2,$3) as n', [eid, cot.id, ctx.usuario.id])).rows[0].n);
  await q.query(`update fab.ordenes set estado = 'cancelada', notas = $3 where empresa_id = $1 and cotizacion_id = $2 and estado = 'planificada'`,
    [eid, cot.id, `Cancelada por anulación de la cotización #${cot.numero}`]);
  return liberado;
}

/** Al emitir la factura la piedra sale del inventario (primero lo reservado para su cotización, luego FIFO). */
export async function descontarVenta(q, ctx, venta, refId = null) {
  const demanda = await demandaVenta(q, ctx.empresa.id, venta.id);
  const faltantes = [];
  for (const [productoId, { nombre, m2 }] of demanda) {
    const r = (await q.query('select fab.consumir($1,$2,$3,$4,$5,$6,$7,$8,true) as r',
      [ctx.empresa.id, productoId, m2, refId, venta.id, venta.numero_factura, venta.nombre_cliente ?? null, ctx.usuario.id])).rows[0].r;
    if (Number(r.faltante) > 0) faltantes.push({ producto: nombre, pedido: m2, hay: Math.max(0, m2 - Number(r.faltante)) });
  }
  return faltantes;
}

/** Anulación de la factura: lo descontado regresa a su mismo lote. */
export async function reponerVenta(q, ctx, venta) {
  const eid = ctx.empresa.id;
  const ya = await q.query(`select 1 from fab.lote_movs where empresa_id = $1 and venta_id = $2 and tipo = 'ajuste'`, [eid, venta.id]);
  if (ya.rowCount) return 0;
  const { rows } = await q.query(`select lote_id, sum(-cantidad) as m2 from fab.lote_movs where empresa_id = $1 and venta_id = $2 and tipo = 'venta' group by lote_id`, [eid, venta.id]);
  for (const m of rows) {
    await q.query(`update fab.lotes set cantidad_disponible = cantidad_disponible + $2, estado = case when estado = 'agotado' then 'lista' else estado end where id = $1`, [m.lote_id, m.m2]);
    await q.query(`insert into fab.lote_movs (empresa_id, lote_id, tipo, cantidad, venta_id, venta_numero, motivo, usuario_id) values ($1,$2,'ajuste',$3,$4,$5,$6,$7)`,
      [eid, m.lote_id, m.m2, venta.id, venta.numero_factura, `Anulación de factura ${venta.numero_factura}`, ctx.usuario.id]);
  }
  return rows.length;
}

// ── Ganchos del POS (se llaman desde pos/ventas.js; no hacen nada fuera de fábricas) ────────────────────────
/**
 * Antes de cobrar: avisa si falta piedra. Con permitir_sin_stock=true pide confirmación (código SIN_STOCK) y deja facturar;
 * con false bloquea. Devuelve los faltantes confirmados.
 */
export async function antesDeCobrar(q, ctx, ventaId, { confirmarSinStock = false, refId = null } = {}) {
  if (!esFabrica(ctx)) return [];
  const demanda = await demandaVenta(q, ctx.empresa.id, ventaId);
  if (!demanda.size) return [];
  const faltantes = await faltantesDe(q, ctx.empresa.id, demanda, refId);
  if (!faltantes.length) return [];
  const cfg = await configPos(q, ctx.empresa.id);
  const detalle = faltantes.map((f) => `${f.producto} (pides ${f.pedido}, hay ${f.hay})`).join('; ');
  if (cfg.permitir_sin_stock !== true) {
    throw Object.assign(new ErrorHttp(409, `Sin existencia suficiente: ${detalle}. Produce o ajusta el inventario antes de facturar.`, 'SIN_STOCK'), { faltantes, bloqueante: true });
  }
  if (!confirmarSinStock) throw Object.assign(new ErrorHttp(409, `Sin existencia suficiente: ${detalle}`, 'SIN_STOCK'), { faltantes });
  return faltantes;
}

export async function despuesDeCobrar(q, ctx, venta, { refId = null, faltantesAvisados = [] } = {}) {
  if (!esFabrica(ctx)) return [];
  const cli = venta.cliente_id ? (await q.query('select nombre from core.terceros where id = $1', [venta.cliente_id])).rows[0] : null;
  const faltan = await descontarVenta(q, ctx, { ...venta, nombre_cliente: cli?.nombre }, refId);
  const todos = faltantesAvisados.length ? faltantesAvisados : faltan;
  if (todos.length) {
    const texto = todos.map((f) => `${f.producto}: pidió ${f.pedido}, había ${f.hay}`).join(' · ');
    await auditar(q, ctx, 'venta_sin_existencia', 'venta', venta.id, { factura: venta.numero_factura, faltantes: texto }, { sucursalId: venta.sucursal_id });
    await alerta(q, ctx, { tipo: 'inventario.venta_sin_stock', severidad: 'media', titulo: `Factura ${venta.numero_factura} emitida sin existencia suficiente (${ctx.usuario?.nombre ?? ''})`, entidad: 'venta', entidadId: venta.id, detalle: { factura: venta.numero_factura, faltantes: texto } });
  }
  return todos;
}

export async function despuesDeAnular(q, ctx, venta) {
  if (!esFabrica(ctx) || venta.estado !== 'pagada') return 0;
  return reponerVenta(q, ctx, venta);
}
