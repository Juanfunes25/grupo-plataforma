// Ticket de texto para impresora térmica (42 col ≈ 80 mm, 32 col ≈ 58 mm).
// Devuelve un arreglo de renglones; el frontend lo imprime en monoespaciado.
const centrar = (t, w) => { const s = String(t).slice(0, w); const e = w - s.length; const i = Math.floor(e / 2); return ' '.repeat(i) + s; };
const fila = (izq, der, w) => { const d = String(der); const i = String(izq).slice(0, Math.max(1, w - d.length - 1)); return i + ' '.repeat(Math.max(1, w - i.length - d.length)) + d; };
const L = (n) => `L ${Number(n).toFixed(2)}`;

function ajustar(texto, w) {
  const out = []; let act = '';
  for (const p of String(texto).split(/\s+/).flatMap((x) => (x.length > w ? x.match(new RegExp(`.{1,${w}}`, 'g')) : [x]))) {
    if ((act + ' ' + p).trim().length > w) { if (act) out.push(act); act = p; } else act = (act + ' ' + p).trim();
  }
  if (act) out.push(act);
  return out;
}

export function formatearTicket({ empresa, sucursal, venta, lineas, pagos, punto, cliente, cajero }, ancho = 42, { copia = 0 } = {}) {
  const t = [];
  const raya = '-'.repeat(ancho);
  t.push(centrar(empresa.razon_social.toUpperCase(), ancho));
  if (empresa.nombre.toUpperCase() !== empresa.razon_social.toUpperCase()) t.push(centrar(empresa.nombre.toUpperCase(), ancho));
  if (empresa.rtn) t.push(centrar(`RTN ${empresa.rtn}`, ancho));
  for (const r of ajustar(sucursal.direccion || empresa.direccion || '', ancho)) t.push(centrar(r, ancho));
  if (sucursal.nombre) t.push(centrar(sucursal.nombre, ancho));
  if (empresa.telefono) t.push(centrar(`Tel ${empresa.telefono}`, ancho));
  t.push(raya);
  if (copia > 0) { t.push(centrar('*** COPIA ***', ancho)); t.push(centrar(`REIMPRESION #${copia} - NO ES ORIGINAL`, ancho)); t.push(raya); }
  if (venta.estado === 'anulada') { t.push(centrar('*** ANULADA ***', ancho)); t.push(raya); }
  if (venta.es_borrador_fiscal) { t.push(centrar('*** SIN VALIDEZ FISCAL ***', ancho)); t.push(centrar('(documento interno de prueba)', ancho)); t.push(raya); }
  t.push(centrar('FACTURA', ancho));
  if (venta.numero_factura) t.push(centrar(venta.numero_factura, ancho));
  if (punto && !punto.es_borrador && punto.cai) {
    for (const r of ajustar(`CAI: ${punto.cai}`, ancho)) t.push(r);
    const f = (n) => `${punto.punto_emision_codigo}-${punto.punto_venta_codigo}-${punto.tipo_documento_codigo}-${String(n).padStart(8, '0')}`;
    t.push(`Rango: ${f(punto.correlativo_desde)}`);
    t.push(`   al: ${f(punto.correlativo_hasta)}`);
    if (punto.fecha_limite_emision) t.push(`Fecha límite de emisión: ${punto.fecha_limite_emision}`);
  }
  const fecha = new Intl.DateTimeFormat('es-HN', { timeZone: 'America/Tegucigalpa', dateStyle: 'short', timeStyle: 'short' }).format(new Date(venta.fecha_emision ?? venta.created_at));
  t.push(`Fecha: ${fecha}`);
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
  if (Number(venta.cambio) > 0) { t.push(fila('Efectivo recibido', L(venta.efectivo_recibido), ancho)); t.push(fila('Cambio', L(venta.cambio), ancho)); }
  t.push(raya);
  t.push(centrar('LA FACTURA ES BENEFICIO DE TODOS, EXÍJALA', ancho));
  t.push(centrar('¡Gracias por su visita!', ancho));
  return t;
}
