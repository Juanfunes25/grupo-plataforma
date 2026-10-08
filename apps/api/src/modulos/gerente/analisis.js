import { sumarDias } from '@grupo/shared';

// ════════════════════════════════════════════════════════════════════════════
// GERENTE DIGITAL — motor de análisis (puro: recibe datos, devuelve hallazgos)
//
// No inventa nada: cada hallazgo sale de una regla explícita sobre los números de la empresa
// (ventas, costos de receta, gastos, inventario, caja, fiscal). Detecta lo que a una persona le
// cuesta ver: tendencias contra el periodo anterior, días fuera de lo normal para ese día de la
// semana, productos que venden pero pierden margen, fruta que se va en merma, insumos a punto de
// agotarse, gastos que crecen más rápido que las ventas.
// ════════════════════════════════════════════════════════════════════════════

export const UMBRALES = {
  tendencia_pct: 15,          // cambio de ventas que merece mención
  dia_anomalo_pct: 35,        // un día X% por debajo/encima de su día de semana habitual
  margen_objetivo: 55,        // % de margen bruto deseado en preparados
  margen_bajo: 40,            // por debajo → hallazgo
  caida_producto_pct: 30,
  concentracion_pct: 40,      // un producto > X% de la venta
  sin_costo_pct: 20,          // % de venta sin receta
  merma_pct_compras: 8,
  cobertura_dias_critica: 2,
  gasto_crece_pct: 30,
  carga_fija_pct: 45,         // alquiler + planilla + servicios sobre ventas netas
  faltante_caja: 100,
};

const L = (n) => `L ${Number(n).toLocaleString('es-HN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const L2 = (n) => `L ${Number(n).toLocaleString('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (a, b) => (b > 0 ? ((a - b) / b) * 100 : null);
const r1 = (n) => Math.round(n * 10) / 10;
const suma = (a, f = (x) => x) => a.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const diaSemana = (f) => new Date(`${f}T12:00:00Z`).getUTCDay();
const redondear5 = (n) => Math.ceil(n / 5) * 5;

function hallazgo(severidad, area, titulo, detalle, accion, extra = {}) {
  return { severidad, area, titulo, detalle, accion, ...extra };
}

/** datos: ver recolectar.js. `hasta` = último día del periodo actual (YYYY-MM-DD). */
export function analizar(datos, umbrales = {}) {
  const U = { ...UMBRALES, ...umbrales };
  const H = [];
  const { periodo, empresa } = datos;
  const dias = periodo.dias;
  const desdeActual = periodo.desde, desdePrevio = periodo.previo_desde;

  const enActual = (f) => f >= desdeActual && f <= periodo.hasta;
  const enPrevio = (f) => f >= desdePrevio && f < desdeActual;
  const vA = datos.ventasDia.filter((d) => enActual(d.fecha));
  const vP = datos.ventasDia.filter((d) => enPrevio(d.fecha));
  const netoA = suma(vA, (d) => d.neto), netoP = suma(vP, (d) => d.neto);
  const factA = suma(vA, (d) => d.facturas), factP = suma(vP, (d) => d.facturas);

  const gastosA = suma(datos.gastosActual.filter((g) => g.grupo !== 'costo_venta'), (g) => g.monto);
  const gastosP = suma(datos.gastosPrevio.filter((g) => g.grupo !== 'costo_venta'), (g) => g.monto);
  const costoA = suma(datos.productosActual, (p) => p.costo);
  const ventaConCosto = suma(datos.productosActual.filter((p) => p.costo != null), (p) => p.venta);
  const costoConCosto = suma(datos.productosActual.filter((p) => p.costo != null), (p) => p.costo);
  const ventaTotalProd = suma(datos.productosActual, (p) => p.venta);
  const margenBruto = ventaConCosto > 0 ? ((ventaConCosto - costoConCosto) / ventaConCosto) * 100 : null;
  const utilBruta = netoA - costoA;
  const utilOp = utilBruta - gastosA;

  const metricas = {
    ventas_netas: Math.round(netoA * 100) / 100, ventas_previas: Math.round(netoP * 100) / 100, variacion_ventas_pct: netoP > 0 ? r1(pct(netoA, netoP)) : null,
    facturas: factA, ticket_promedio: factA ? Math.round((netoA / factA) * 100) / 100 : 0,
    ticket_previo: factP ? Math.round((netoP / factP) * 100) / 100 : null,
    margen_bruto_pct: margenBruto == null ? null : r1(margenBruto), costo_ventas: Math.round(costoA * 100) / 100,
    gastos_operativos: Math.round(gastosA * 100) / 100, utilidad_operativa: Math.round(utilOp * 100) / 100,
    margen_operativo_pct: netoA > 0 ? r1((utilOp / netoA) * 100) : null,
  };

  if (factA === 0) {
    return { empresa, periodo, metricas, salud: null, hallazgos: [hallazgo('info', 'datos', 'Aún no hay ventas en el periodo', 'Sin facturas cobradas no hay números que analizar todavía.', 'Registra las primeras ventas; el gerente digital empieza a opinar con unos días de movimiento.')], resumen: `${empresa.nombre} todavía no registra ventas en los últimos ${dias} días.`, acciones: [] };
  }

  // ── 1. Tendencia de ventas ──────────────────────────────────────────────
  if (netoP > 0) {
    const v = pct(netoA, netoP);
    if (v <= -U.tendencia_pct) H.push(hallazgo(v <= -30 ? 'alta' : 'media', 'ventas', `Las ventas cayeron ${r1(-v)}%`, `${L(netoA)} contra ${L(netoP)} en el periodo anterior de ${dias} días (${L(netoP - netoA)} menos).`, 'Revisa qué producto, día u hora perdió más (ver hallazgos siguientes) y si hubo faltantes de producto o cambios de precio.', { valor: Math.round(netoP - netoA) }));
    else if (v >= U.tendencia_pct) H.push(hallazgo('positivo', 'ventas', `Las ventas crecieron ${r1(v)}%`, `${L(netoA)} contra ${L(netoP)} del periodo anterior.`, 'Identifica qué lo impulsó (producto, horario, promoción) y repítelo; asegúrate de tener inventario para sostener el ritmo.'));
    const tA = factA ? netoA / factA : 0, tP = factP ? netoP / factP : 0;
    if (tP > 0 && Math.abs(pct(tA, tP)) >= 10) H.push(hallazgo(pct(tA, tP) < 0 ? 'media' : 'positivo', 'ventas', `El ticket promedio ${pct(tA, tP) < 0 ? 'bajó' : 'subió'} ${r1(Math.abs(pct(tA, tP)))}%`, `${L2(tA)} por factura contra ${L2(tP)} antes.`, pct(tA, tP) < 0 ? 'Ofrece combos o extras (boosters, tamaño grande) en caja para recuperar valor por cliente.' : 'Mantén las sugerencias de venta adicional que están funcionando.'));
  }

  // ── 2. Días fuera de lo normal para su día de la semana ─────────────────
  const previosPorDia = new Map();
  for (const d of datos.ventasDia.filter((x) => x.fecha < desdeActual)) previosPorDia.set(diaSemana(d.fecha), [...(previosPorDia.get(diaSemana(d.fecha)) ?? []), d.neto]);
  const ultimos7 = vA.filter((d) => d.fecha > sumarDias(periodo.hasta, -7));
  for (const d of ultimos7) {
    const base = previosPorDia.get(diaSemana(d.fecha)) ?? [];
    if (base.length < 3) continue;
    const prom = suma(base) / base.length;
    const v = pct(d.neto, prom);
    if (prom > 0 && v !== null && v <= -U.dia_anomalo_pct) H.push(hallazgo('media', 'ventas', `El ${DIAS[diaSemana(d.fecha)]} ${d.fecha.slice(5)} vendió ${r1(-v)}% menos de lo habitual`, `${L(d.neto)} contra un ${DIAS[diaSemana(d.fecha)]} típico de ${L(prom)}.`, 'Pregunta qué pasó ese día: ¿faltó producto, personal, lluvia, equipo dañado, local cerrado antes de hora?', { valor: Math.round(prom - d.neto) }));
    if (prom > 0 && v !== null && v >= U.dia_anomalo_pct + 15) H.push(hallazgo('positivo', 'ventas', `El ${DIAS[diaSemana(d.fecha)]} ${d.fecha.slice(5)} fue un día excepcional (+${r1(v)}%)`, `${L(d.neto)} contra ${L(prom)} habitual.`, 'Averigua la causa (evento, promoción, clima) para poder repetirla.'));
  }

  // ── 3. Patrón semanal y horario (información útil para planificar) ──────
  const porDia = new Map();
  for (const d of vA) porDia.set(diaSemana(d.fecha), [...(porDia.get(diaSemana(d.fecha)) ?? []), d.neto]);
  const promDia = [...porDia].map(([k, v]) => ({ dia: k, prom: suma(v) / v.length })).sort((a, b) => b.prom - a.prom);
  if (promDia.length >= 5) {
    const mejor = promDia[0], peor = promDia[promDia.length - 1];
    if (peor.prom > 0 && mejor.prom / peor.prom >= 1.8) H.push(hallazgo('info', 'ventas', `Tu mejor día es ${DIAS[mejor.dia]} y el más flojo ${DIAS[peor.dia]}`, `${DIAS[mejor.dia]} promedia ${L(mejor.prom)}; ${DIAS[peor.dia]} apenas ${L(peor.prom)} (${r1(mejor.prom / peor.prom)}×).`, `Programa personal y producción según esa curva; prueba una promoción los ${DIAS[peor.dia]}.`));
  }
  const horasTot = suma(datos.horas, (h) => h.venta);
  if (datos.horas.length >= 4 && horasTot > 0) {
    const orden = [...datos.horas].sort((a, b) => b.venta - a.venta);
    const top3 = orden.slice(0, 3);
    const share = (suma(top3, (h) => h.venta) / horasTot) * 100;
    if (share >= 55) H.push(hallazgo('info', 'ventas', `${r1(share)}% de la venta ocurre en solo 3 horas (${top3.map((h) => `${h.hora}h`).join(', ')})`, 'La operación depende de picos cortos.', 'Refuerza personal y producto listo en esas horas; fuera de ellas puedes bajar costos o lanzar ofertas.'));
  }

  // ── 4. Productos: margen, caída, concentración, costos sin receta ──────
  const prods = datos.productosActual.map((p) => ({ ...p, margen: p.costo != null && p.venta > 0 ? ((p.venta - p.costo) / p.venta) * 100 : null }));
  const mapPrev = new Map(datos.productosPrevio.map((p) => [p.producto, p]));
  const conMargenBajo = prods.filter((p) => p.margen != null && p.margen < U.margen_bajo && p.venta >= Math.max(netoA * 0.03, 1));
  for (const p of conMargenBajo.sort((a, b) => b.venta - a.venta).slice(0, 3)) {
    const cat = datos.catalogo.find((c) => c.nombre === p.producto);
    const costoUnit = p.unidades > 0 ? p.costo / p.unidades : null;
    let sug = '';
    if (cat && costoUnit) {
      const precioSug = redondear5((costoUnit / (1 - U.margen_objetivo / 100)) * (1 + (cat.tasa ?? 0)));
      if (precioSug > cat.precio) sug = ` Para llegar a ${U.margen_objetivo}% de margen el precio sería cerca de ${L(precioSug)} (hoy ${L(cat.precio)}).`;
    }
    H.push(hallazgo(p.margen < 25 ? 'alta' : 'media', 'margen', `${p.producto}: margen de solo ${r1(p.margen)}%`, `Vendió ${L(p.venta)} pero su costo de receta fue ${L(p.costo)}.${sug}`, 'Sube el precio, reduce la porción o renegocia el insumo más caro de la receta.', { valor: Math.round(p.venta * (U.margen_objetivo / 100) - (p.venta - p.costo)) }));
  }
  const estrellas = prods.filter((p) => p.margen != null && p.margen >= 65 && p.venta >= netoA * 0.05).sort((a, b) => b.venta - a.venta);
  if (estrellas.length) H.push(hallazgo('positivo', 'margen', `${estrellas[0].producto} es tu mejor negocio (${r1(estrellas[0].margen)}% de margen)`, `Vendió ${L(estrellas[0].venta)} con margen alto.`, 'Dale protagonismo en el menú y en la sugerencia de caja.'));

  const caidas = [];
  for (const p of prods) {
    const prev = mapPrev.get(p.producto);
    if (prev && prev.unidades >= 8) {
      const v = pct(p.unidades, prev.unidades);
      if (v <= -U.caida_producto_pct) caidas.push({ p, prev, v });
    }
  }
  for (const c of caidas.sort((a, b) => a.v - b.v).slice(0, 3)) H.push(hallazgo('media', 'productos', `${c.p.producto} vende ${r1(-c.v)}% menos unidades`, `${r1(c.p.unidades)} contra ${r1(c.prev.unidades)} del periodo anterior.`, 'Verifica disponibilidad (¿se agotó?), calidad y precio; si es estacional, planifica la producción.'));
  const vistos = new Set(prods.map((p) => p.producto));
  for (const prev of datos.productosPrevio) if (!vistos.has(prev.producto) && prev.venta >= netoP * 0.04) H.push(hallazgo('media', 'productos', `${prev.producto} dejó de venderse`, `Vendía ${L(prev.venta)} en el periodo anterior y hoy no tiene ventas.`, '¿Se retiró del menú o está marcado como agotado? Reactívalo si fue un error.'));

  if (ventaTotalProd > 0) {
    const top = [...prods].sort((a, b) => b.venta - a.venta)[0];
    const share = (top.venta / ventaTotalProd) * 100;
    if (share >= U.concentracion_pct && prods.length >= 4) H.push(hallazgo('media', 'productos', `${top.producto} concentra ${r1(share)}% de las ventas`, 'Depender tanto de un producto es riesgoso (faltante de un insumo o un cambio de gusto golpea todo).', 'Impulsa el segundo y tercer producto con promociones o combos.'));
    const sinCosto = ventaTotalProd - ventaConCosto;
    if ((sinCosto / ventaTotalProd) * 100 >= U.sin_costo_pct) H.push(hallazgo('media', 'datos', `${r1((sinCosto / ventaTotalProd) * 100)}% de la venta no tiene costo de receta`, `${L(sinCosto)} se vendieron de productos sin receta: la utilidad real está oculta.`, 'Completa las recetas en Inventario → Recetas; sin ellas ni el margen ni el análisis son confiables.'));
  }

  // ── 5. Gastos ───────────────────────────────────────────────────────────
  if (netoA > 0 && gastosA > 0) {
    const fijos = suma(datos.gastosActual.filter((g) => ['alquiler', 'nomina', 'servicios'].includes(g.grupo)), (g) => g.monto);
    const share = (fijos / netoA) * 100;
    if (share >= U.carga_fija_pct) H.push(hallazgo(share >= 60 ? 'alta' : 'media', 'gastos', `La carga fija (alquiler, planilla, servicios) es ${r1(share)}% de las ventas`, `${L(fijos)} de gastos fijos contra ${L(netoA)} vendidos.`, 'Necesitas vender más o ajustar la estructura: cada punto de venta adicional ayuda a diluir estos costos.'));
  }
  const gPrev = new Map();
  for (const g of datos.gastosPrevio) gPrev.set(g.categoria, (gPrev.get(g.categoria) ?? 0) + g.monto);
  for (const [cat, mA] of Object.entries(datos.gastosActual.reduce((o, g) => ({ ...o, [g.categoria]: (o[g.categoria] ?? 0) + g.monto }), {}))) {
    const mP = gPrev.get(cat) ?? 0;
    if (mP > 0 && mA >= 500 && pct(mA, mP) >= U.gasto_crece_pct && pct(mA, mP) > (netoP > 0 ? pct(netoA, netoP) : 0) + 10)
      H.push(hallazgo('media', 'gastos', `El gasto en "${cat}" creció ${r1(pct(mA, mP))}%`, `${L(mA)} contra ${L(mP)} del periodo anterior, más rápido que las ventas.`, 'Revisa facturas y proveedores de esa categoría; confirma si es un gasto único o recurrente.'));
  }
  if (utilOp < 0) H.push(hallazgo('alta', 'resultado', `La operación perdió ${L(-utilOp)} en el periodo`, `Ventas netas ${L(netoA)} − costo de ventas ${L(costoA)} − gastos ${L(gastosA)}.`, 'Es la prioridad: decide entre subir precios/margen, bajar gastos o aumentar volumen. Empieza por los productos de margen bajo.', { valor: Math.round(-utilOp) }));
  else if (metricas.margen_operativo_pct != null && metricas.margen_operativo_pct >= 15) H.push(hallazgo('positivo', 'resultado', `Margen operativo sano: ${metricas.margen_operativo_pct}%`, `Utilidad de ${L(utilOp)} sobre ${L(netoA)} vendidos.`, 'Protege ese margen al crecer; evita subir gastos fijos al mismo ritmo que las ventas.'));
  else if (metricas.margen_operativo_pct != null && metricas.margen_operativo_pct < 5) H.push(hallazgo('media', 'resultado', `Margen operativo ajustado: ${metricas.margen_operativo_pct}%`, `Utilidad de ${L(utilOp)} sobre ${L(netoA)} vendidos.`, 'Con tan poco colchón un mal mes se vuelve pérdida: revisa margen por producto y gastos.'));

  // ── 6. Inventario y merma ───────────────────────────────────────────────
  const compras = datos.compras ?? 0;
  if (datos.mermas.costo > 0 && compras > 0) {
    const m = (datos.mermas.costo / compras) * 100;
    if (m >= U.merma_pct_compras) H.push(hallazgo(m >= 15 ? 'alta' : 'media', 'inventario', `La merma equivale a ${r1(m)}% de lo comprado`, `${L(datos.mermas.costo)} perdidos${datos.mermas.top.length ? ` (principalmente ${datos.mermas.top.slice(0, 3).map((t) => `${t.insumo} ${L(t.costo)}`).join(', ')})` : ''}.`, 'Compra en menor cantidad y más seguido los insumos que más se pierden; rota el inventario con el más próximo a vencer primero.', { valor: Math.round(datos.mermas.costo) }));
  }
  const criticos = datos.stock.filter((s) => s.consumo_diario > 0 && s.stock >= 0 && s.stock / s.consumo_diario < U.cobertura_dias_critica);
  if (criticos.length) H.push(hallazgo('alta', 'inventario', `${criticos.length} insumo(s) se agotan en menos de ${U.cobertura_dias_critica} días`, criticos.slice(0, 5).map((s) => `${s.insumo}: ${r1(s.stock)} ${s.unidad} (~${r1(s.stock / s.consumo_diario)} días)`).join(' · '), 'Haz el pedido hoy: un faltante en estos insumos detiene ventas de varios productos.'));
  const negativos = datos.stock.filter((s) => s.stock < 0);
  if (negativos.length) H.push(hallazgo('media', 'inventario', `${negativos.length} insumo(s) con existencia negativa`, negativos.slice(0, 5).map((s) => `${s.insumo} (${r1(s.stock)} ${s.unidad})`).join(' · '), 'Se vendió sin que la compra estuviera registrada. Registra las compras o haz un conteo físico para corregir el sistema.'));
  const dormidos = datos.stock.filter((s) => s.stock > 0 && !(s.consumo_diario > 0) && s.stock * s.costo >= 300);
  if (dormidos.length) { const v = suma(dormidos, (s) => s.stock * s.costo); H.push(hallazgo('info', 'inventario', `${L(v)} en insumos sin movimiento`, dormidos.slice(0, 5).map((s) => s.insumo).join(', '), 'Revisa si siguen en el menú; capital detenido y riesgo de vencer.')); }
  if (datos.vencen.valor > 0) H.push(hallazgo(datos.vencen.valor >= 500 ? 'alta' : 'media', 'inventario', `${L(datos.vencen.valor)} en producto que vence en 2 días`, `${datos.vencen.lotes} lote(s) próximos a vencer.`, 'Úsalo primero, haz una promoción o conviértelo en producto (jugo del día) antes de que sea merma.', { valor: Math.round(datos.vencen.valor) }));

  // ── 7. Caja, control y fiscal ───────────────────────────────────────────
  const faltante = suma(datos.turnos.filter((t) => t.diferencia < 0), (t) => -t.diferencia);
  if (faltante >= U.faltante_caja) H.push(hallazgo(faltante >= 500 ? 'alta' : 'media', 'caja', `Faltantes de caja acumulados: ${L(faltante)}`, `En ${datos.turnos.filter((t) => t.diferencia < 0).length} cierre(s) del periodo.`, 'Revisa los cierres con diferencia y conversa con los cajeros involucrados; considera arqueos sorpresa.', { valor: Math.round(faltante) }));
  const graves = datos.antifraude.filter((a) => a.severidad === 'alta');
  if (graves.length) H.push(hallazgo('alta', 'control', `${graves.length} alerta(s) de control para revisar`, graves.slice(0, 3).map((a) => a.titulo).join(' · '), 'Abre Ventas → Alertas para ver el detalle. Son patrones a revisar, no acusaciones.'));
  if (datos.descuento.bruto > 0 && (datos.descuento.descuento / datos.descuento.bruto) * 100 >= 8) H.push(hallazgo('media', 'control', `Los descuentos son ${r1((datos.descuento.descuento / datos.descuento.bruto) * 100)}% de la venta bruta`, `${L(datos.descuento.descuento)} otorgados.`, 'Verifica que correspondan a tercera edad o promociones autorizadas.', { valor: Math.round(datos.descuento.descuento) }));
  for (const f of datos.fiscal) {
    if (f.borrador) H.push(hallazgo('info', 'fiscal', `${f.sucursal} factura en modo borrador`, 'Las facturas no tienen validez fiscal hasta cargar el CAI real.', 'Carga el CAI autorizado por el SAR en Administración → Facturación antes de operar de verdad.'));
    else if (f.dias_restantes != null && f.dias_restantes <= 15 || f.restantes <= 200) H.push(hallazgo('alta', 'fiscal', `${f.sucursal}: el CAI está por ${f.dias_restantes != null && f.dias_restantes <= 15 ? `vencer (${f.dias_restantes} días)` : `agotarse (quedan ${f.restantes} facturas)`}`, 'Facturar sin CAI vigente es una infracción.', 'Solicita el nuevo rango al SAR hoy.'));
  }

  const orden = { alta: 0, media: 1, info: 2, positivo: 3 };
  H.sort((a, b) => orden[a.severidad] - orden[b.severidad] || (b.valor ?? 0) - (a.valor ?? 0));

  // ── Salud (0–100) y resumen ejecutivo ───────────────────────────────────
  const altas = H.filter((h) => h.severidad === 'alta').length, medias = H.filter((h) => h.severidad === 'media').length, pos = H.filter((h) => h.severidad === 'positivo').length;
  const salud = Math.max(15, Math.min(100, 100 - altas * 12 - medias * 5 + Math.min(pos, 3) * 3));
  const nivel = salud >= 80 ? 'saludable' : salud >= 60 ? 'con puntos de atención' : salud >= 40 ? 'en alerta' : 'crítica';
  const acciones = H.filter((h) => h.severidad === 'alta' || h.severidad === 'media').slice(0, 3).map((h) => ({ titulo: h.titulo, accion: h.accion }));
  let resumen = `${empresa.nombre} vendió ${L(netoA)} netos en los últimos ${dias} días`
    + (metricas.variacion_ventas_pct != null ? ` (${metricas.variacion_ventas_pct >= 0 ? '+' : ''}${metricas.variacion_ventas_pct}% frente al periodo anterior)` : '')
    + (margenBruto != null ? `, con un margen bruto de ${r1(margenBruto)}%` : '')
    + `, y ${utilOp >= 0 ? 'una utilidad operativa de' : 'una pérdida operativa de'} ${L(Math.abs(utilOp))}. La salud del negocio se ve ${nivel} (${salud}/100).`;
  if (acciones.length) resumen += ` Lo más importante ahora: ${acciones.map((a) => a.titulo.toLowerCase()).join('; ')}.`;
  else resumen += ' No hay alertas importantes en este momento.';

  return { empresa, periodo, metricas, salud: { puntaje: salud, nivel }, resumen, acciones, hallazgos: H };
}

/** Gerente digital de Dirección: compara empresas y destaca lo cruzado. */
export function analizarGrupo(porEmpresa, intercompania = []) {
  const H = [];
  const con = porEmpresa.filter((e) => e.salud);
  const ventas = suma(con, (e) => e.metricas.ventas_netas);
  const util = suma(con, (e) => e.metricas.utilidad_operativa);
  for (const e of con) {
    const share = ventas > 0 ? (e.metricas.ventas_netas / ventas) * 100 : 0;
    if (con.length > 1 && share >= 70) H.push(hallazgo('media', 'grupo', `${e.empresa.nombre} genera ${r1(share)}% de las ventas del grupo`, 'El resultado del grupo depende casi de una sola empresa.', 'Impulsa el crecimiento de las otras empresas para diversificar el riesgo.'));
    if (e.metricas.utilidad_operativa < 0) H.push(hallazgo('alta', 'grupo', `${e.empresa.nombre} está perdiendo dinero (${L(e.metricas.utilidad_operativa)})`, `Salud ${e.salud.puntaje}/100.`, 'Revisa su gerente digital: ahí están las causas ordenadas por impacto.'));
  }
  const margenes = con.filter((e) => e.metricas.margen_bruto_pct != null);
  if (margenes.length >= 2) {
    const ord = [...margenes].sort((a, b) => b.metricas.margen_bruto_pct - a.metricas.margen_bruto_pct);
    const dif = ord[0].metricas.margen_bruto_pct - ord[ord.length - 1].metricas.margen_bruto_pct;
    if (dif >= 20) H.push(hallazgo('info', 'grupo', `Brecha de margen: ${ord[0].empresa.nombre} (${ord[0].metricas.margen_bruto_pct}%) vs ${ord[ord.length - 1].empresa.nombre} (${ord[ord.length - 1].metricas.margen_bruto_pct}%)`, `${r1(dif)} puntos de diferencia.`, `Comparte prácticas de costeo y precios de ${ord[0].empresa.nombre} con el resto.`));
  }
  for (const e of con) for (const h of e.hallazgos.filter((x) => x.severidad === 'alta').slice(0, 2)) H.push({ ...h, titulo: `${e.empresa.nombre}: ${h.titulo}`, area: h.area });
  const pendiente = suma(intercompania.filter((i) => i.estado === 'pendiente'), (i) => i.monto);
  if (pendiente > 0) H.push(hallazgo('info', 'finanzas', `${L(pendiente)} en operaciones entre empresas sin conciliar`, 'Ventas de una empresa a otra del grupo que aún no se concilian.', 'Concilíalas para que el consolidado no cuente ventas internas dos veces.'));
  const orden = { alta: 0, media: 1, info: 2, positivo: 3 };
  H.sort((a, b) => orden[a.severidad] - orden[b.severidad] || (b.valor ?? 0) - (a.valor ?? 0));
  const ranking = [...con].sort((a, b) => b.metricas.utilidad_operativa - a.metricas.utilidad_operativa).map((e) => ({ codigo: e.empresa.codigo, nombre: e.empresa.nombre, ventas_netas: e.metricas.ventas_netas, utilidad_operativa: e.metricas.utilidad_operativa, margen_bruto_pct: e.metricas.margen_bruto_pct, salud: e.salud.puntaje, nivel: e.salud.nivel }));
  const sinDatos = porEmpresa.filter((e) => !e.salud).map((e) => e.empresa.nombre);
  const saludGrupo = con.length ? Math.round(suma(con, (e) => e.salud.puntaje * Math.max(e.metricas.ventas_netas, 1)) / suma(con, (e) => Math.max(e.metricas.ventas_netas, 1))) : null;
  let resumen;
  if (!con.length) resumen = 'Ninguna empresa registra ventas todavía en el periodo.';
  else {
    resumen = `El grupo vendió ${L(ventas)} netos y ${util >= 0 ? 'obtuvo' : 'perdió'} ${L(Math.abs(util))} de utilidad operativa entre ${con.length} empresa(s) con actividad. ${ranking[0] ? `La que mejor resultado da es ${ranking[0].nombre}` : ''}${ranking.length > 1 ? `; la que más atención necesita es ${ranking[ranking.length - 1].nombre}` : ''}.`;
    if (sinDatos.length) resumen += ` Sin actividad aún: ${sinDatos.join(', ')}.`;
  }
  return { resumen, salud: saludGrupo, ranking, hallazgos: H, totales: { ventas_netas: Math.round(ventas * 100) / 100, utilidad_operativa: Math.round(util * 100) / 100 } };
}
