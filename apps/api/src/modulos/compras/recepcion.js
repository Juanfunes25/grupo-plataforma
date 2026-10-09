// PUNTO DE INTEGRACIÓN Compras → inventarios. Cada empresa tiene su propio inventario; aquí NO se duplica su lógica:
// se llaman las funciones y tablas que ya existen, en la misma transacción de la recepción.
//
//   origen     inventario                    qué se llama
//   inv        Origen (y genérico)           inv.compras + inv.compra_items + inv.ingresar()  → lote FEFO y costo_actual
//   fab        EcoStone (materia prima)      fab.mover_insumo(…,'compra',…)                    → costo PROMEDIO ponderado, USD a tipo de cambio
//   rinv_fab   Italo fábrica (Mec3/local)    rinv.insumos_fab (stock, kardex, lote Mec3) + rinv.precios_fab
//                                            y, si hay un insumo de costeo con el mismo nombre, prod.costeo_precios (el costeo del gelato)
//   rep_suc    Italo sucursales (empaques)   rinv.stock_suc + kardex de sucursal
//   dis        DISERCO (productos)           dis.mover(…,'compra',…)                           → costo estándar promedio (sin ISV)
//
// Costos siempre SIN ISV (el ISV de compra es crédito fiscal, no costo). Las entradas por orden quedan marcadas con recepcion_id.
import { sumarDias } from '@grupo/shared';
import { conflicto, malaPeticion, noEncontrado } from '../../lib/http.js';
import { aplicarMovimiento, vencimientoDe } from '../rinv/calculo.js';
import { registrarLote, registrarMov } from '../rinv/util.js';
import { r2, r4 } from './calculo.js';

export const ORIGENES = ['inv', 'fab', 'rinv_fab', 'rep_suc', 'dis'];
export const ORIGEN_NOMBRE = { inv: 'Inventario', fab: 'Materia prima (fábrica)', rinv_fab: 'Materia prima (fábrica de gelato)', rep_suc: 'Insumos de sucursal', dis: 'Producto' };
export const necesitaSucursal = (origen) => origen === 'inv' || origen === 'rep_suc';

/** Datos básicos de un ítem (nombre y unidad) validando que sea de la empresa. */
export async function resolverItem(q, empresaId, origen, id) {
  const sqls = {
    inv: 'select id, nombre, unidad from inv.insumos where id = $1 and empresa_id = $2 and activo',
    fab: 'select id, nombre, unidad from fab.insumos where id = $1 and empresa_id = $2 and activo',
    rinv_fab: 'select id, nombre, unidad from rinv.insumos_fab where id = $1 and empresa_id = $2 and activo',
    rep_suc: 'select id, nombre, unidad from rep.insumos_catalogo where id = $1 and empresa_id = $2 and activo',
    dis: `select p.id, p.nombre, p.unidad from pos.productos p join dis.producto_ext x on x.producto_id = p.id where p.id = $1 and p.empresa_id = $2 and p.activo and x.controla_inventario`,
  };
  if (!sqls[origen]) throw malaPeticion('Tipo de ítem no válido');
  const it = (await q.query(sqls[origen], [id, empresaId])).rows[0];
  if (!it) throw noEncontrado('Uno de los ítems ya no existe o no es de esta empresa');
  return it;
}

/**
 * Entra a inventario las líneas recibidas. `lineas` trae { linea, cantidad, precio (moneda de la orden), costoLps, vence_at }.
 * Devuelve, por línea, lo que quedó (costo resultante, avisos) para mostrarlo en pantalla.
 */
export async function ingresarAInventario(q, ctx, { orden, recepcion, proveedor, lineas, documento }) {
  const emp = ctx.empresa.id;
  const ref = documento || `OC-${orden.numero}`;
  const motivo = `Orden de compra #${orden.numero}`;
  const resultados = [];

  // ── inv: una compra de inventario por recepción, con sus líneas ──
  const lineasInv = lineas.filter((l) => l.linea.origen === 'inv');
  if (lineasInv.length) {
    if (!orden.sucursal_id) throw malaPeticion('La orden no tiene sucursal destino');
    const subtotal = r2(lineasInv.reduce((s, l) => s + l.cantidad * l.costoLps, 0));
    const isv = r2((subtotal * Number(orden.isv_pct)) / 100);
    const c = (await q.query(
      `insert into inv.compras (empresa_id,sucursal_id,proveedor_id,numero_documento,fecha,subtotal,isv,total,notas,usuario_id,recepcion_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
      [emp, orden.sucursal_id, orden.proveedor_id, ref, recepcion.fecha, subtotal, isv, r2(subtotal + isv), motivo, ctx.usuario.id, recepcion.id])).rows[0];
    for (const l of lineasInv) {
      const ins = (await q.query('select perecedero, vida_util_dias from inv.insumos where id = $1 and empresa_id = $2', [l.linea.item_id, emp])).rows[0];
      const vence = l.vence_at ?? (ins?.perecedero && ins.vida_util_dias ? sumarDias(recepcion.fecha, ins.vida_util_dias) : null);
      await q.query('insert into inv.compra_items (compra_id,insumo_id,cantidad,costo_unitario,vence_at) values ($1,$2,$3,$4,$5)', [c.id, l.linea.item_id, l.cantidad, l.costoLps, vence]);
      await q.query('select inv.ingresar($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11,$12)',
        [emp, orden.sucursal_id, l.linea.item_id, l.cantidad, l.costoLps, 'compra', vence, 'compra', c.id, ref, ctx.usuario.id, c.id]);
      resultados.push({ linea_id: l.linea.id, costo_resultante: l.costoLps, nota: 'Último costo del inventario actualizado' });
    }
  }

  for (const l of lineas) {
    const { linea } = l;
    if (linea.origen === 'fab') {
      const mov = (await q.query('select * from fab.mover_insumo($1,$2,$3,$4,$5,$6,$7,null,$8,$9,null,$10,false)',
        [emp, linea.item_id, 'compra', l.cantidad, l.precio, orden.moneda, orden.moneda === 'USD' ? recepcion.tipo_cambio : 1, ref, motivo, ctx.usuario.id])).rows[0];
      await q.query('update fab.mov_insumos set recepcion_id = $2 where id = $1', [mov.id, recepcion.id]);
      const prom = (await q.query('select costo_promedio from fab.insumos where id = $1', [linea.item_id])).rows[0].costo_promedio;
      resultados.push({ linea_id: linea.id, costo_resultante: Number(prom), nota: 'Costo promedio ponderado recalculado' });
    } else if (linea.origen === 'rinv_fab') {
      resultados.push(await entradaRinvFab(q, ctx, { orden, recepcion, l, ref, motivo }));
    } else if (linea.origen === 'rep_suc') {
      if (!orden.sucursal_id) throw malaPeticion('La orden no tiene sucursal destino');
      const fila = (await q.query('select cantidad from rinv.stock_suc where sucursal_id = $1 and insumo_id = $2 for update', [orden.sucursal_id, linea.item_id])).rows[0];
      const r = aplicarMovimiento(fila?.cantidad ?? 0, 'entrada', l.cantidad);
      await q.query(
        `insert into rinv.stock_suc (empresa_id, sucursal_id, insumo_id, cantidad) values ($1,$2,$3,$4)
         on conflict (sucursal_id, insumo_id) do update set cantidad = excluded.cantidad, actualizado_en = now()`, [emp, orden.sucursal_id, linea.item_id, r.nuevo]);
      await registrarMov(q, ctx, { ambito: 'sucursal', sucursalId: orden.sucursal_id, insumoSucId: linea.item_id, tipo: 'entrada', cantidad: l.cantidad, saldo: r.nuevo, motivo: `${motivo} · ${ref}` });
      resultados.push({ linea_id: linea.id, costo_resultante: l.costoLps, nota: 'Existencia de la sucursal actualizada' });
    } else if (linea.origen === 'dis') {
      if (!Number.isInteger(l.cantidad)) throw malaPeticion(`«${linea.descripcion}»: DISERCO maneja unidades enteras`);
      const id = (await q.query('select dis.mover($1,$2,$3,$4,$5,$6,null,$7,$8,$9,false,null) as id',
        [emp, linea.item_id, 'compra', l.cantidad, l.costoLps, motivo, proveedor?.nombre ?? null, ref, ctx.usuario.id])).rows[0].id;
      await q.query('update dis.movimientos set recepcion_id = $2 where id = $1', [id, recepcion.id]);
      const est = (await q.query('select costo_estandar from dis.producto_ext where producto_id = $1', [linea.item_id])).rows[0];
      resultados.push({ linea_id: linea.id, costo_resultante: Number(est?.costo_estandar ?? 0), nota: 'Costo estándar promedio recalculado' });
    }
  }
  return resultados;
}

/** Italo fábrica: stock + kardex + lote Mec3 (vence al año) + precio vigente por kg (historial inalterable) y precio de costeo. */
async function entradaRinvFab(q, ctx, { orden, recepcion, l, ref, motivo }) {
  const emp = ctx.empresa.id;
  const { linea } = l;
  const fila = (await q.query('select * from rinv.insumos_fab where id = $1 and empresa_id = $2 for update', [linea.item_id, emp])).rows[0];
  if (!fila) throw noEncontrado('Insumo de fábrica no encontrado');
  const r = aplicarMovimiento(fila.stock_actual, 'entrada', l.cantidad);
  await q.query('update rinv.insumos_fab set stock_actual = $2, stock_actualizado_en = now() where id = $1', [fila.id, r.nuevo]);
  await registrarMov(q, ctx, { ambito: 'fabrica', insumoFabId: fila.id, tipo: 'entrada', cantidad: l.cantidad, saldo: r.nuevo, motivo: `${motivo} · ${ref}` });
  if (fila.tipo === 'mec3') {
    await registrarLote(q, emp, { insumoId: fila.id, cantidad: l.cantidad, fechaIngreso: recepcion.fecha, fechaVencimiento: vencimientoDe(recepcion.fecha), motivo: `${motivo} · ${ref}` });
  }
  // Precio por kg: directo si se cuenta en kg; si no, se divide entre el peso de la unidad (bote/bolsa). Sin peso no hay precio por kg.
  const pesoKg = /^kg$/i.test(fila.unidad) ? 1 : Number(fila.peso_unitario) > 0 ? Number(fila.peso_unitario) : null;
  let nota = 'Existencia y lote actualizados';
  if (pesoKg) {
    const lpsKg = r4(l.costoLps / pesoKg);
    const usdKg = orden.moneda === 'USD' ? r4(l.precio / pesoKg) : null;
    const tc = orden.moneda === 'USD' ? recepcion.tipo_cambio : null;
    const fuente = fila.tipo === 'mec3' ? 'factura_mec3' : 'manual';
    await q.query(
      `insert into rinv.precios_fab (empresa_id, insumo_id, fecha_vigencia, lps_kg, usd_kg, tipo_cambio_usado, fuente, factura_ref) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [emp, fila.id, recepcion.fecha, lpsKg, usdKg, tc, fuente, ref]);
    const costeo = (await q.query('select id from prod.costeo_insumos where empresa_id = $1 and nombre = $2', [emp, fila.nombre])).rows[0];
    if (costeo) {
      await q.query(
        `insert into prod.costeo_precios (empresa_id, insumo_id, fecha_vigencia, lps_kg, usd_kg, tipo_cambio_usado, fuente, factura_ref, usuario_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [emp, costeo.id, recepcion.fecha, lpsKg, usdKg, tc, fuente, ref, ctx.usuario.id]);
      nota = 'Existencia, lote y precio del costeo de gelato actualizados';
    } else nota = 'Existencia, lote y precio vigente actualizados (no hay insumo de costeo con este nombre)';
    return { linea_id: linea.id, costo_resultante: lpsKg, nota };
  }
  return { linea_id: linea.id, costo_resultante: l.costoLps, nota: `${nota}. Sin peso por unidad: no se pudo calcular el precio por kg para el costeo` };
}

/** Todas las líneas deben ser del mismo ámbito de empresa: se valida que el destino exista cuando hace falta. */
export function validarDestino(lineas, sucursalId) {
  if (!sucursalId && lineas.some((l) => necesitaSucursal(l.origen))) throw conflicto('Elige la sucursal donde entra la mercadería');
}
