// Tickets de texto para impresora térmica (48/42 columnas ≈ 80 mm, 32 columnas ≈ 58 mm).
// Viven en el paquete compartido porque los usan DOS lados: el servidor (factura emitida, reimpresión, prueba) y la caja del
// navegador (comprobante provisional cuando NO hay internet y el cierre de caja). Cada función devuelve un arreglo de renglones.
import { ANCHOS_TICKET, fechaHoraHN } from './formato.js';

export const anchoValido = (n) => (ANCHOS_TICKET[Number(n)] ? Number(n) : 48);

export const LEYENDA_BORRADOR = 'BORRADOR - SIN VALOR FISCAL';

const centrar = (t, w) => { const s = String(t).slice(0, w); const e = w - s.length; return ' '.repeat(Math.floor(e / 2)) + s; };
const fila = (izq, der, w) => { const d = String(der); const i = String(izq).slice(0, Math.max(1, w - d.length - 1)); return i + ' '.repeat(Math.max(1, w - i.length - d.length)) + d; };
const L = (n) => `L ${Number(n || 0).toFixed(2)}`;

export function ajustar(texto, w) {
  const out = []; let act = '';
  for (const p of String(texto).split(/\s+/).flatMap((x) => (x.length > w ? x.match(new RegExp(`.{1,${w}}`, 'g')) : [x]))) {
    if ((act + ' ' + p).trim().length > w) { if (act) out.push(act); act = p; } else act = (act + ' ' + p).trim();
  }
  if (act) out.push(act);
  return out;
}
const centradas = (t, w) => ajustar(t, w).map((r) => centrar(r, w));
// «*** TEXTO ***» solo si cabe; en papel de 58 mm el texto va sin asteriscos, en dos renglones limpios.
const enmarcado = (t, w) => (t.length + 8 <= w ? `*** ${t} ***` : t);

/** Encabezado con los datos de la empresa y la sucursal (el logo, si hay, lo pone la página HTML encima de estos renglones). */
function encabezado(t, empresa, sucursal, ancho) {
  t.push(...centradas(String(empresa.razon_social ?? empresa.nombre ?? '').toUpperCase(), ancho));
  if (empresa.nombre && empresa.razon_social && empresa.nombre.toUpperCase() !== empresa.razon_social.toUpperCase()) t.push(...centradas(empresa.nombre.toUpperCase(), ancho));
  if (empresa.rtn) t.push(centrar(`RTN ${empresa.rtn}`, ancho));
  for (const r of ajustar(sucursal?.direccion || empresa.direccion || '', ancho)) t.push(centrar(r, ancho));
  if (sucursal?.nombre) t.push(...centradas(sucursal.nombre, ancho));
  if (empresa.telefono) t.push(centrar(`Tel ${empresa.telefono}`, ancho));
}

/**
 * Factura (o su copia) en ticket térmico.
 *  · Sin CAI real (`venta.es_borrador_fiscal`): leyenda «BORRADOR - SIN VALOR FISCAL» arriba y abajo.
 *  · Reimpresión: «COPIA #n»; la primera impresión nunca lo lleva (lo decide el servidor, ver ventas.js).
 *  · Venta hecha sin conexión: muestra el número del comprobante provisional que se entregó en el momento.
 */
export function formatearTicket({ empresa, sucursal, venta, lineas, pagos, punto, cliente, cajero }, ancho = 42, { copia = 0 } = {}) {
  const t = [];
  const raya = '-'.repeat(ancho);
  encabezado(t, empresa, sucursal, ancho);
  t.push(raya);
  if (copia > 0) { t.push(centrar(`*** COPIA #${copia} ***`, ancho)); t.push(...centradas(`REIMPRESION #${copia} - NO ES ORIGINAL`, ancho)); t.push(raya); }
  if (venta.estado === 'anulada') { t.push(centrar('*** ANULADA ***', ancho)); t.push(raya); }
  if (venta.es_borrador_fiscal) { t.push(...centradas(enmarcado(LEYENDA_BORRADOR, ancho), ancho)); t.push(...centradas('(etapa de pruebas: no es una factura valida)', ancho)); t.push(raya); }
  t.push(centrar('FACTURA', ancho));
  if (venta.numero_factura) t.push(centrar(venta.numero_factura, ancho));
  if (punto && !punto.es_borrador && punto.cai) {
    for (const r of ajustar(`CAI: ${punto.cai}`, ancho)) t.push(r);
    const f = (n) => `${punto.punto_emision_codigo}-${punto.punto_venta_codigo}-${punto.tipo_documento_codigo}-${String(n).padStart(8, '0')}`;
    t.push(`Rango: ${f(punto.correlativo_desde)}`);
    t.push(`   al: ${f(punto.correlativo_hasta)}`);
    if (punto.fecha_limite_emision) t.push(`Fecha límite de emisión: ${punto.fecha_limite_emision}`);
  }
  t.push(`Fecha: ${fechaHoraHN(venta.fecha_emision ?? venta.created_at)}`);
  if (venta.numero_provisional) {
    t.push(`Venta sin conexion: ${fechaHoraHN(venta.vendida_at ?? venta.created_at)}`);
    t.push(`Comprobante provisional: ${venta.numero_provisional}`);
  }
  t.push(`Orden #${venta.ticket_dia || venta.numero_orden}${venta.nombre_orden ? '  ' + venta.nombre_orden : ''}`);
  if (cajero) t.push(`Atendió: ${cajero.nombre}`);
  t.push(`Cliente: ${cliente?.nombre ?? 'Consumidor Final'}`);
  if (cliente?.rtn) t.push(`RTN: ${cliente.rtn}`);
  t.push(raya);
  for (const l of lineas) {
    t.push(fila(`${Number(l.cantidad)} x ${l.nombre_producto}`, L(l.cantidad * l.precio_base), ancho));
    for (const o of l.opciones ?? []) t.push(fila(`   + ${o.nombre}`, Number(o.precio_extra) ? L(o.precio_extra * l.cantidad) : '', ancho));
    if (l.notas) for (const r of ajustar(`   * ${l.notas}`, ancho)) t.push(r);
    if (Number(l.descuento) > 0) t.push(fila(`   Desc. ${l.descuento_porcentaje ? l.descuento_porcentaje + '%' : ''}`, `-${L(l.descuento)}`, ancho));
  }
  t.push(raya);
  if (Number(venta.descuento) > 0) t.push(fila('Descuentos', `-${L(venta.descuento)}`, ancho));
  t.push(fila('Importe exento', L(venta.subtotal_exento), ancho));
  t.push(fila('Importe exonerado', L(venta.subtotal_exonerado), ancho));
  t.push(fila('Importe gravado 15%', L(venta.subtotal_gravado_15), ancho));
  if (Number(venta.subtotal_gravado_18) > 0) t.push(fila('Importe gravado 18%', L(venta.subtotal_gravado_18), ancho));
  t.push(fila('ISV', L(venta.isv_total), ancho));
  t.push(fila('TOTAL', L(venta.total), ancho));
  t.push(raya);
  for (const p of pagos ?? []) t.push(fila(p.forma, L(p.monto) + (p.referencia ? ` (${p.referencia})` : ''), ancho));
  if (venta.efectivo_recibido != null) { t.push(fila('Efectivo recibido', L(Number(venta.efectivo_recibido)), ancho)); t.push(fila('Cambio', L(Number(venta.cambio ?? 0)), ancho)); }
  if (venta.tercera_edad_identidad) for (const r of ajustar(`Desc. 3ra edad: ${venta.tercera_edad_nombre ?? ''} ID ${venta.tercera_edad_identidad}`, ancho)) t.push(r);
  t.push(raya);
  if (venta.es_borrador_fiscal) { t.push(...centradas(LEYENDA_BORRADOR, ancho)); t.push(raya); }
  t.push(...centradas('LA FACTURA ES BENEFICIO DE TODOS, EXÍJALA', ancho));
  t.push(centrar('¡Gracias por su visita!', ancho));
  t.push('');
  return t;
}

/**
 * Comprobante PROVISIONAL de una venta hecha SIN conexión. NO es una factura: el número fiscal (correlativo del SAR) solo lo asigna el
 * servidor al sincronizar, para que jamás se repita ni se salte un número. `totales` es la salida de calcularTotales.
 */
export function formatearTicketProvisional({ empresa, sucursal, cajero, cliente, numero, fecha, lineas, totales, recibido, cambio, borrador = true }, ancho = 42) {
  const t = [];
  const raya = '-'.repeat(ancho);
  encabezado(t, empresa, sucursal, ancho);
  t.push(raya);
  t.push(centrar('*** COMPROBANTE PROVISIONAL ***', ancho));
  t.push(...centradas('VENTA SIN CONEXION - NO ES FACTURA', ancho));
  t.push(...centradas('Su factura fiscal se emite en cuanto la caja recupere la conexion. Conserve este comprobante.', ancho));
  if (borrador) t.push(...centradas(enmarcado(LEYENDA_BORRADOR, ancho), ancho));
  t.push(raya);
  t.push(`No. provisional: ${numero}`);
  t.push(`Fecha: ${fechaHoraHN(fecha ?? new Date())}`);
  if (cajero) t.push(`Atendió: ${cajero}`);
  t.push(`Cliente: ${cliente?.nombre ?? 'Consumidor Final'}`);
  if (cliente?.rtn) t.push(`RTN: ${cliente.rtn}`);
  t.push(raya);
  lineas.forEach((l, i) => {
    const c = totales.lineas[i];
    t.push(fila(`${Number(l.cantidad)} x ${l.nombre}`, L(c.precio_unitario * l.cantidad), ancho));
    for (const o of l.opciones ?? []) t.push(fila(`   + ${o.nombre}`, Number(o.precio_extra) ? L(o.precio_extra * l.cantidad) : '', ancho));
    if (l.notas) for (const r of ajustar(`   * ${l.notas}`, ancho)) t.push(r);
    if (Number(c.descuento) > 0) t.push(fila(`   Desc. ${c.descuento_porcentaje ? c.descuento_porcentaje + '%' : ''}`, `-${L(c.descuento)}`, ancho));
  });
  t.push(raya);
  t.push(fila('ISV', L(totales.isv_total), ancho));
  t.push(fila('TOTAL', L(totales.total), ancho));
  t.push(fila('Efectivo recibido', L(recibido), ancho));
  t.push(fila('Cambio', L(cambio), ancho));
  t.push(raya);
  t.push(...centradas('Precios sujetos a confirmacion al sincronizar.', ancho));
  t.push(centrar('¡Gracias por su visita!', ancho));
  t.push('');
  return t;
}

/** Ticket de prueba para ajustar el ancho del papel de la impresora de una caja. */
export function formatearTicketPrueba(ancho, { empresa, sucursal } = {}) {
  const t = [];
  const raya = '-'.repeat(ancho);
  t.push(...centradas(String(empresa?.razon_social ?? empresa?.nombre ?? '').toUpperCase(), ancho));
  t.push(centrar('PRUEBA DE IMPRESORA', ancho));
  t.push(raya);
  if (sucursal) for (const r of ajustar(sucursal, ancho)) t.push(centrar(r, ancho));
  t.push(`Papel: ${ANCHOS_TICKET[ancho]} (${ancho} columnas)`);
  t.push(`Fecha: ${fechaHoraHN(new Date())}`);
  t.push(raya);
  t.push('0123456789'.repeat(Math.ceil(ancho / 10)).slice(0, ancho));
  t.push(fila('Si esta línea cabe completa', L(123.45), ancho));
  t.push('='.repeat(ancho));
  t.push(centrar('Si ve todo derecho y sin cortes,', ancho));
  t.push(centrar('la impresora quedó bien configurada.', ancho));
  t.push(centrar('Si el papel NO se corta solo, active', ancho).slice(0, ancho));
  t.push(centrar('"cortar al final" en el driver.', ancho).slice(0, ancho));
  t.push('');
  return t;
}

/** Cierre de turno de caja imprimible (lo arma la caja con lo que devuelve /pos/turno/cerrar). */
export function formatearCierreTurno({ empresa, sucursal, cajero, turno, resumen, ocultarEsperado = false }, ancho = 42) {
  const t = [];
  const raya = '-'.repeat(ancho);
  const f = (etq, n) => t.push(fila(etq, L(n), ancho));
  t.push(...centradas(String(empresa.razon_social ?? empresa.nombre ?? '').toUpperCase(), ancho));
  if (sucursal?.nombre) t.push(...centradas(sucursal.nombre, ancho));
  t.push(raya);
  t.push(centrar('CIERRE DE CAJA', ancho));
  t.push(raya);
  if (cajero) t.push(`Cajero: ${cajero}`);
  t.push(`Abierto: ${fechaHoraHN(turno.abierto_at)}`);
  t.push(`Cerrado: ${fechaHoraHN(turno.cerrado_at ?? new Date())}`);
  t.push(raya);
  t.push(fila('Facturas emitidas', String(resumen.facturas ?? 0), ancho));
  if (resumen.factura_desde) { t.push(`Desde: ${resumen.factura_desde}`); t.push(`Hasta: ${resumen.factura_hasta}`); }
  if (Number(resumen.anuladas) > 0) t.push(fila('Anuladas', `${resumen.anuladas} (${L(resumen.total_anulado)})`, ancho));
  t.push(raya);
  f('Ventas totales', resumen.total);
  for (const p of resumen.por_forma ?? []) f(`  ${p.nombre}`, p.monto);
  t.push(raya);
  f('Fondo inicial', turno.fondo_inicial);
  f('+ Efectivo de ventas', resumen.efectivo_ventas);
  if (Number(resumen.ingresos) > 0) f('+ Ingresos', resumen.ingresos);
  if (Number(resumen.salidas) > 0) f('- Salidas', resumen.salidas);
  if (!ocultarEsperado && resumen.efectivo_esperado != null) f('Efectivo esperado', resumen.efectivo_esperado);
  f('Efectivo contado', turno.efectivo_contado);
  if (!ocultarEsperado && turno.diferencia != null) {
    const d = Number(turno.diferencia);
    t.push(fila(Math.abs(d) < 0.005 ? 'CUADRA' : d < 0 ? 'FALTANTE' : 'SOBRANTE', L(Math.abs(d)), ancho));
  }
  if (turno.observaciones) for (const r of ajustar(`Obs.: ${turno.observaciones}`, ancho)) t.push(r);
  t.push(raya);
  t.push('');
  t.push('');
  t.push(centrar('Firma del cajero', ancho));
  t.push(centrar('________________________', ancho));
  t.push('');
  return t;
}
