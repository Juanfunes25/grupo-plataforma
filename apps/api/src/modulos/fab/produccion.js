// Lógica de producción de EcoStone (portada de lib/produccion.js y lib/colada.js de la app original).
// Todas las funciones reciben `q` (db o transacción) y `ctx` ({ empresa, usuario }).
import { fechaHN, sumarDias } from '@grupo/shared';
import { auditar } from '../../lib/auditoria.js';
import { ErrorHttp, malaPeticion } from '../../lib/http.js';

export const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

export const PARAMETROS = {
  tipo_cambio_usd: { def: 26.3, texto: 'Tipo de cambio (L por US$)' },
  dias_a_inventario: { def: 5, texto: 'Días en secado antes de pasar a lista para vender' },
  tolerancia_consumo_pct: { def: 10, texto: 'Tolerancia consumo vs receta (%)' },
  merma_maxima_pct: { def: 8, texto: 'Merma máxima normal (%)' },
  coladas_por_molde_dia: { def: 1, texto: 'Coladas por molde por día' },
};

/** Parámetros de fabricación de la empresa (core.config, clave 'fab') con valores de la app original por defecto. */
export async function parametros(q, empresaId) {
  const r = (await q.query(`select valor from core.config where empresa_id = $1 and clave = 'fab'`, [empresaId])).rows[0]?.valor ?? {};
  const out = { prefijo_lote: String(r.prefijo_lote || 'EC') };
  for (const [k, v] of Object.entries(PARAMETROS)) out[k] = num(r[k], v.def);
  return out;
}

/** Costo por m² terminado: insumos × (1 + merma) + mano de obra + indirectos. */
export function costoDeReceta(receta, items) {
  const insumos = items.reduce((s, i) => s + num(i.cantidad_m2) * num(i.costo_promedio), 0);
  const conMerma = insumos * (1 + num(receta.merma_esperada_pct) / 100);
  const total = conMerma + num(receta.mano_obra_m2) + num(receta.indirectos_m2);
  return { insumos: round2(insumos), insumos_con_merma: round2(conMerma), mano_obra: round2(receta.mano_obra_m2), indirectos: round2(receta.indirectos_m2), total_m2: round2(total) };
}

export async function recetaActiva(q, empresaId, productoId) {
  const r = (await q.query('select * from fab.recetas where empresa_id = $1 and producto_id = $2 and activa', [empresaId, productoId])).rows[0];
  if (!r) return null;
  r.items = (await q.query(
    `select ri.insumo_id, ri.cantidad_m2, i.nombre, i.unidad, i.costo_promedio from fab.receta_items ri join fab.insumos i on i.id = ri.insumo_id where ri.receta_id = $1`, [r.id])).rows;
  return r;
}

export async function actualizarCostoEstandar(q, empresaId, productoId) {
  const receta = await recetaActiva(q, empresaId, productoId);
  if (!receta) return null;
  const c = costoDeReceta(receta, receta.items);
  await q.query('update pos.productos set costo_estandar = $2 where id = $1 and empresa_id = $3', [productoId, c.total_m2, empresaId]);
  return c;
}

export async function alerta(q, ctx, { tipo, severidad = 'media', titulo, entidad = null, entidadId = null, detalle = {} }) {
  await q.query(
    'insert into fab.alertas (empresa_id, tipo, severidad, titulo, entidad, entidad_id, detalle, usuario_id) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',
    [ctx.empresa.id, tipo, severidad, titulo, entidad, entidadId ? String(entidadId) : null, JSON.stringify(detalle), ctx.usuario?.id ?? null]);
}

/** Crea una orden de producción con su consumo teórico según la receta activa. También la usa el lado comercial (cotizaciones). */
export async function crearOrden(q, ctx, { producto_id, m2, fecha_programada = null, cotizacion_id = null, cotizacion_numero = null, molde_id = null, notas = null, responsable_id = null, permitirSinReceta = false }) {
  const empresaId = ctx.empresa.id;
  const prod = (await q.query('select id, nombre from pos.productos where id = $1 and empresa_id = $2 and es_piedra', [producto_id, empresaId])).rows[0];
  if (!prod) throw malaPeticion('Producto no válido: elige una piedra del catálogo');
  const receta = await recetaActiva(q, empresaId, producto_id);
  if (!receta && !permitirSinReceta) throw malaPeticion('El producto no tiene una receta activa: créala en Fabricación → Recetas');
  const m2Plan = round3(m2);
  if (!(m2Plan > 0)) throw malaPeticion('La cantidad a producir debe ser mayor que 0');
  let molde = null;
  if (molde_id) molde = (await q.query('select * from fab.moldes where id = $1 and empresa_id = $2', [molde_id, empresaId])).rows[0] ?? null;
  const coladas = molde && num(molde.m2_por_colada) > 0 ? Math.ceil(m2Plan / num(molde.m2_por_colada)) : null;

  const p = await parametros(q, empresaId);
  const hoy = fechaHN();
  const prefijo = `${p.prefijo_lote}-${hoy.slice(2).replace(/-/g, '')}`;
  const n = Number((await q.query('select fab.siguiente($1,$2) as n', [empresaId, `lote-${prefijo}`])).rows[0].n);
  const lote = `${prefijo}-${String(n).padStart(2, '0')}`;
  const numero = Number((await q.query('select fab.siguiente($1,$2) as n', [empresaId, 'orden'])).rows[0].n);
  const orden = (await q.query(
    `insert into fab.ordenes (empresa_id, numero, lote, producto_id, receta_id, cotizacion_id, cotizacion_numero, m2_planificado, molde_id, coladas, fecha_programada, responsable_id, notas, creada_por)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
    [empresaId, numero, lote, producto_id, receta?.id ?? null, cotizacion_id, cotizacion_numero, m2Plan, molde?.id ?? null, coladas, fecha_programada || sumarDias(hoy, 1),
      responsable_id ?? ctx.usuario?.id ?? null, notas, ctx.usuario?.id ?? null])).rows[0];
  const factor = 1 + num(receta?.merma_esperada_pct) / 100;
  for (const i of receta?.items ?? []) {
    await q.query('insert into fab.orden_consumos (orden_id, insumo_id, teorico, costo_unitario) values ($1,$2,$3,$4)',
      [orden.id, i.insumo_id, round3(num(i.cantidad_m2) * m2Plan * factor), num(i.costo_promedio)]);
  }
  return orden;
}

/**
 * Colada: descuenta los insumos del kardex (receta o lo indicado) y arranca la cuenta del secado.
 * forzar=true registra aunque falte existencia (la producción ya ocurrió): queda stock negativo y una alerta.
 */
export async function colarOrden(q, ctx, orden, { reales = null, forzar = false } = {}) {
  const empresaId = ctx.empresa.id;
  const consumos = (await q.query(
    'select c.*, i.nombre, i.unidad from fab.orden_consumos c join fab.insumos i on i.id = c.insumo_id where c.orden_id = $1', [orden.id])).rows;
  const p = await parametros(q, empresaId);
  const stockRows = consumos.length
    ? (await q.query('select insumo_id, stock from fab.stock_insumos where insumo_id = any($1::uuid[])', [consumos.map((c) => c.insumo_id)])).rows : [];
  const stock = new Map(stockRows.map((s) => [s.insumo_id, num(s.stock)]));
  const plan = consumos.map((c) => {
    const pedido = reales?.get(c.insumo_id);
    const real = Number.isFinite(pedido) ? pedido : num(c.teorico);
    if (real < 0) throw malaPeticion('El consumo real no puede ser negativo');
    return { c, real };
  });
  const faltantes = plan.filter(({ c, real }) => (stock.get(c.insumo_id) ?? 0) < real)
    .map(({ c, real }) => ({ insumo: c.nombre, unidad: c.unidad, hay: stock.get(c.insumo_id) ?? 0, necesita: real }));
  if (faltantes.length && !forzar) {
    throw malaPeticion(`Insumos insuficientes: ${faltantes.map((f) => `${f.insumo} (hay ${f.hay}, se necesitan ${f.necesita} ${f.unidad})`).join('; ')}`);
  }
  let costoMp = 0;
  const desvios = [];
  const consumido = [];
  for (const { c, real } of plan) {
    let costoUnit = num(c.costo_unitario);
    if (real > 0) {
      const mov = (await q.query('select * from fab.mover_insumo($1,$2,$3,$4,null,$5,1,null,null,$6,$7,$8,$9)',
        [empresaId, c.insumo_id, 'consumo', -real, 'HNL', `Colada ${orden.lote}`, orden.id, ctx.usuario?.id ?? null, forzar])).rows[0];
      costoUnit = num(mov.costo_unitario);
    }
    costoMp += real * costoUnit;
    await q.query('update fab.orden_consumos set real = $2, costo_unitario = $3 where id = $1', [c.id, real, costoUnit]);
    consumido.push({ insumo: c.nombre, unidad: c.unidad, cantidad: round3(real) });
    const teo = num(c.teorico);
    if (teo > 0 && (Math.abs(real - teo) / teo) * 100 > p.tolerancia_consumo_pct) desvios.push({ insumo: c.nombre, teorico: teo, real, desvio_pct: round2(((real - teo) / teo) * 100) });
  }
  const ahora = new Date().toISOString();
  const actualizada = (await q.query(
    `update fab.ordenes set estado = 'curando', fecha_colado = $2, etiqueta_at = $2, fecha_disponible = $3, costo_mp = $4, responsable_id = coalesce(responsable_id, $5)
      where id = $1 returning *`, [orden.id, ahora, sumarDias(fechaHN(), p.dias_a_inventario), round2(costoMp), ctx.usuario?.id ?? null])).rows[0];
  // El lote nace «en secado»: todavía no se puede vender.
  const operario = ctx.usuario?.id ? (await q.query('select nombre from core.usuarios where id = $1', [actualizada.responsable_id ?? ctx.usuario.id])).rows[0]?.nombre ?? null : null;
  const lote = (await q.query(
    `insert into fab.lotes (empresa_id, codigo, producto_id, orden_id, calidad, estado, cantidad_producida, fecha_produccion, operario_id, operario, etiqueta_at)
     values ($1,$2,$3,$4,'primera','secado',$5,$6,$7,$8,$6) on conflict (empresa_id, codigo, calidad) do nothing returning id`,
    [empresaId, orden.lote, orden.producto_id, orden.id, orden.m2_planificado, ahora, actualizada.responsable_id ?? ctx.usuario?.id ?? null, operario])).rows[0];
  if (lote) {
    await q.query(`insert into fab.lote_movs (empresa_id, lote_id, tipo, cantidad, motivo, usuario_id) values ($1,$2,'produccion',0,$3,$4)`,
      [empresaId, lote.id, `Producción registrada: ${orden.m2_planificado} (en secado)`, ctx.usuario?.id ?? null]);
  }
  if (orden.molde_id && orden.coladas) await q.query('update fab.moldes set usos = usos + $2 where id = $1', [orden.molde_id, orden.coladas]);
  await auditar(q, ctx, 'produccion.colada', 'orden_produccion', orden.id, { lote: orden.lote, costo_mp: round2(costoMp), desvios, faltantes: faltantes.length ? faltantes : undefined });
  if (desvios.length) {
    await alerta(q, ctx, { tipo: 'produccion.consumo_desviado', severidad: desvios.some((d) => Math.abs(d.desvio_pct) > p.tolerancia_consumo_pct * 2) ? 'alta' : 'media',
      titulo: `Consumo fuera de receta en ${orden.lote}: ${desvios.map((d) => `${d.insumo} ${d.desvio_pct > 0 ? '+' : ''}${d.desvio_pct}%`).join(', ')}`, entidad: 'orden_produccion', entidadId: orden.id, detalle: { lote: orden.lote, tolerancia_pct: p.tolerancia_consumo_pct, desvios } });
  }
  if (faltantes.length) {
    await alerta(q, ctx, { tipo: 'produccion.insumo_insuficiente', severidad: 'alta',
      titulo: `Producción ${orden.lote} registrada sin insumos suficientes en el sistema: ${faltantes.map((f) => f.insumo).join(', ')}`, entidad: 'orden_produccion', entidadId: orden.id,
      detalle: { lote: orden.lote, faltantes, nota: 'Falta cargar compras de insumos, o el consumo fue mayor al registrado.' } });
  }
  return { orden: actualizada, desvios, faltantes, consumido };
}

/** Pasa a «lista para vender»: el lote entra al inventario (1ª y 2ª calidad) y se calcula el costo real. */
export async function terminarOrden(q, ctx, orden, { bueno, segunda = 0, merma = 0, motivoAnticipado = '', automatica = false }) {
  const empresaId = ctx.empresa.id;
  const receta = orden.receta_id ? (await q.query('select mano_obra_m2, indirectos_m2 from fab.recetas where id = $1', [orden.receta_id])).rows[0] : null;
  const controles = (await q.query('select resultado from fab.controles_calidad where orden_id = $1', [orden.id])).rows;
  bueno = round3(bueno); segunda = round3(segunda); merma = round3(merma);
  const producido = round3(bueno + segunda);
  const costoMo = round2(num(receta?.mano_obra_m2) * producido);
  const costoInd = round2(num(receta?.indirectos_m2) * producido);
  const costoTotal = round2(num(orden.costo_mp) + costoMo + costoInd);
  const costoM2 = producido > 0 ? round2(costoTotal / producido) : 0;
  const uid = ctx.usuario?.id ?? null;
  const ahora = new Date().toISOString();

  // Lote de primera (ya existe en secado) y, si hay, el de segunda.
  let primera = (await q.query(`select * from fab.lotes where empresa_id = $1 and codigo = $2 and calidad = 'primera'`, [empresaId, orden.lote])).rows[0];
  if (!primera) {
    primera = (await q.query(
      `insert into fab.lotes (empresa_id, codigo, producto_id, orden_id, calidad, estado, cantidad_producida, fecha_produccion, operario_id)
       values ($1,$2,$3,$4,'primera','secado',$5,coalesce($6::timestamptz, now()),$7) returning *`,
      [empresaId, orden.lote, orden.producto_id, orden.id, orden.m2_planificado, orden.fecha_colado, orden.responsable_id])).rows[0];
  }
  await q.query(
    `update fab.lotes set estado = case when $2::numeric > 0 then 'lista' else 'agotado' end, cantidad_disponible = $2::numeric, fecha_lista = $3, costo_m2 = $4 where id = $1`,
    [primera.id, bueno, ahora, costoM2]);
  await q.query(`insert into fab.lote_movs (empresa_id, lote_id, tipo, cantidad, motivo, usuario_id) values ($1,$2,'produccion',$3,$4,$5)`,
    [empresaId, primera.id, bueno, `Lote ${orden.lote} lista para vender`, uid]);
  if (segunda > 0) {
    const s = (await q.query(
      `insert into fab.lotes (empresa_id, codigo, producto_id, orden_id, calidad, estado, cantidad_producida, cantidad_disponible, fecha_produccion, fecha_lista, costo_m2, operario_id, operario)
       values ($1,$2,$3,$4,'segunda','lista',$5,$5,$6,$7,$8,$9,$10)
       on conflict (empresa_id, codigo, calidad) do update set cantidad_disponible = excluded.cantidad_disponible, cantidad_producida = excluded.cantidad_producida, estado = 'lista' returning id`,
      [empresaId, orden.lote, orden.producto_id, orden.id, segunda, primera.fecha_produccion, ahora, costoM2, primera.operario_id, primera.operario])).rows[0];
    await q.query(`insert into fab.lote_movs (empresa_id, lote_id, tipo, cantidad, motivo, usuario_id) values ($1,$2,'produccion',$3,$4,$5)`, [empresaId, s.id, segunda, `Segunda calidad ${orden.lote}`, uid]);
  }
  if (merma > 0) await q.query(`insert into fab.lote_movs (empresa_id, lote_id, tipo, cantidad, motivo, usuario_id) values ($1,$2,'merma',0,$3,$4)`, [empresaId, primera.id, `Merma del lote: ${merma}`, uid]);

  const actualizada = (await q.query(
    `update fab.ordenes set estado = 'terminada', fecha_terminada = $2, m2_bueno = $3, m2_segunda = $4, m2_merma = $5, costo_mano_obra = $6, costo_indirectos = $7, costo_total = $8, costo_m2 = $9
      where id = $1 returning *`, [orden.id, ahora, bueno, segunda, merma, costoMo, costoInd, costoTotal, costoM2])).rows[0];
  if (costoM2 > 0) await q.query('update pos.productos set costo_estandar = $2 where id = $1', [orden.producto_id, costoM2]);

  const total = producido + merma;
  const mermaPct = total > 0 ? round2((merma / total) * 100) : 0;
  const rendimiento = num(orden.m2_planificado) > 0 ? round2((producido / num(orden.m2_planificado)) * 100) : 0;
  const p = await parametros(q, empresaId);
  await auditar(q, ctx, 'produccion.terminar', 'orden_produccion', orden.id, { lote: orden.lote, bueno, segunda, merma, merma_pct: mermaPct, costo_m2: costoM2, automatica: automatica || undefined, liberada_antes: motivoAnticipado || undefined, sin_control_calidad: !controles.length });
  if (mermaPct > p.merma_maxima_pct) {
    await alerta(q, ctx, { tipo: 'produccion.merma_alta', severidad: mermaPct > p.merma_maxima_pct * 1.5 ? 'alta' : 'media',
      titulo: `Merma alta en ${orden.lote}: ${mermaPct}% (normal hasta ${p.merma_maxima_pct}%)`, entidad: 'orden_produccion', entidadId: orden.id, detalle: { lote: orden.lote, merma_m2: merma, merma_pct: mermaPct, rendimiento_pct: rendimiento } });
  }
  // Producción pedida por una cotización: lo producido se aparta para ella (fab.reservar es idempotente por referencia).
  let reserva = null;
  if (orden.cotizacion_id && bueno > 0) {
    const ya = num((await q.query('select coalesce(sum(cantidad),0) as c from fab.reservas where empresa_id = $1 and ref_id = $2 and producto_id = $3', [empresaId, orden.cotizacion_id, orden.producto_id])).rows[0].c);
    reserva = (await q.query('select fab.reservar($1,$2,$3,$4,$5,null,$6) as r', [empresaId, orden.producto_id, ya + bueno, orden.cotizacion_id, orden.cotizacion_numero, uid])).rows[0].r;
  }
  return { orden: actualizada, merma_pct: mermaPct, rendimiento_pct: rendimiento, sin_control_calidad: !controles.length, reserva };
}

/** Pasan solas a «lista para vender» las producciones que cumplieron sus días (sin calidad rechazada). */
export async function liberarVencidos(db, empresaId) {
  const sistema = { empresa: { id: empresaId }, usuario: null };
  const ordenes = (await db.query(
    `select o.* from fab.ordenes o where o.empresa_id = $1 and o.estado = 'curando' and o.fecha_disponible <= $2
        and not exists (select 1 from fab.controles_calidad c where c.orden_id = o.id and c.resultado = 'rechazado')`, [empresaId, fechaHN()])).rows;
  let n = 0;
  for (const o of ordenes) {
    try {
      await db.tx(async (q) => {
        const viva = (await q.query(`select * from fab.ordenes where id = $1 and estado = 'curando' for update`, [o.id])).rows[0];
        if (viva) { await terminarOrden(q, sistema, viva, { bueno: num(viva.m2_planificado), automatica: true }); n++; }
      });
    } catch (e) { console.error('[fab] no se pudo liberar', o.lote, e.message); }
  }
  return n;
}

export function iniciarLiberacionAutomatica(db) {
  const ciclo = async () => {
    try {
      const { rows } = await db.query(`select distinct empresa_id from core.empresa_modulos where modulo = 'fabrica' and activo`);
      for (const r of rows) await liberarVencidos(db, r.empresa_id);
    } catch (e) { console.error('[fab] liberación', e.message); }
  };
  const a = setTimeout(ciclo, 45_000); const b = setInterval(ciclo, 30 * 60_000);
  a.unref?.(); b.unref?.();
}

export { ErrorHttp };
