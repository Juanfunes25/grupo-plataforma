// Factura completa tamaño carta en PDF, sin dependencias: un PDF 1.4 escrito a mano con las fuentes estándar
// (Helvetica / Helvetica-Bold, que todo visor trae). Es el equivalente de "Ver PDF / Descargar PDF" de Italo Facturación.
//
// Solo texto y líneas: lo que hace falta para una factura. Los caracteres fuera de Latin-1 se sustituyen para no romper el archivo.

const ANCHO = 612, ALTO = 792, MARGEN = 50;
const L = (n) => `L ${Number(n || 0).toLocaleString('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const limpiar = (t) => String(t ?? '')
  .replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...').replace(/×/g, 'x')
  .replace(/[^\x20-\x7E -ÿ]/g, '?');
const esc = (t) => limpiar(t).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

// Anchos aproximados de Helvetica (por 1000 unidades) para alinear a la derecha y centrar sin métricas completas.
function ancho(texto, tam, negrita = false) {
  let w = 0;
  for (const ch of limpiar(texto)) {
    if ('iljI.,;:\'!|'.includes(ch)) w += 250;
    else if ('ftr() -'.includes(ch)) w += 330;
    else if ('mwMW'.includes(ch)) w += 830;
    else if (/[A-Z0-9]/.test(ch)) w += negrita ? 700 : 667;
    else w += negrita ? 590 : 556;
  }
  return (w * tam) / 1000;
}

class Pagina {
  constructor() { this.ops = []; this.y = ALTO - MARGEN; }
  texto(t, x, y, { tam = 10, negrita = false, color = [0, 0, 0], derecha = false, centro = false, w = 0 } = {}) {
    let px = x;
    if (derecha) px = x + w - ancho(t, tam, negrita);
    if (centro) px = x + (w - ancho(t, tam, negrita)) / 2;
    this.ops.push(`BT /${negrita ? 'F2' : 'F1'} ${tam} Tf ${color.join(' ')} rg ${px.toFixed(2)} ${y.toFixed(2)} Td (${esc(t)}) Tj ET`);
  }
  linea(x1, y1, x2, y2, grosor = 0.5) { this.ops.push(`${grosor} w ${x1} ${y1} m ${x2} ${y2} l S`); }
  contenido() { return this.ops.join('\n'); }
}

/** Parte un texto en renglones que quepan en `max` puntos. */
function envolver(texto, tam, max) {
  const out = []; let act = '';
  for (const p of String(texto).split(/\s+/)) {
    const prueba = act ? `${act} ${p}` : p;
    if (ancho(prueba, tam) > max && act) { out.push(act); act = p; } else act = prueba;
  }
  if (act) out.push(act);
  return out;
}

export function generarPdfFactura({ empresa, sucursal, venta, lineas, pagos, punto, cliente, cajero }) {
  const paginas = [];
  let pg;
  const nueva = () => { pg = new Pagina(); paginas.push(pg); };
  const salto = (alto) => { if (pg.y - alto < MARGEN + 30) { nueva(); } };
  nueva();

  const fecha = new Intl.DateTimeFormat('es-HN', { timeZone: 'America/Tegucigalpa', dateStyle: 'short', timeStyle: 'short' }).format(new Date(venta.fecha_emision ?? venta.created_at));
  const util = ANCHO - 2 * MARGEN;
  const fila = (t, { tam = 10, negrita = false, color, centro = false, sep = 14 } = {}) => {
    salto(sep);
    pg.texto(t, MARGEN, pg.y, { tam, negrita, color, centro, w: util });
    pg.y -= sep;
  };

  fila(String(empresa.razon_social ?? empresa.nombre).toUpperCase(), { tam: 16, negrita: true, centro: true, sep: 20 });
  if (empresa.nombre && empresa.nombre !== empresa.razon_social) fila(empresa.nombre, { tam: 12, centro: true, sep: 16 });
  if (empresa.rtn) fila(`RTN ${empresa.rtn}`, { centro: true });
  for (const r of envolver(sucursal?.direccion || empresa.direccion || '', 10, util)) if (r) fila(r, { centro: true });
  if (sucursal?.nombre) fila(sucursal.nombre, { centro: true });
  if (empresa.telefono) fila(`Tel. ${empresa.telefono}`, { centro: true });
  pg.y -= 8;

  if (venta.estado === 'anulada') fila('*** FACTURA ANULADA ***', { tam: 14, negrita: true, color: [0.75, 0.1, 0.1], centro: true, sep: 20 });
  if (venta.es_borrador_fiscal) fila('DOCUMENTO SIN VALIDEZ FISCAL - CAI pendiente de confirmar con el SAR', { tam: 11, negrita: true, color: [0.75, 0.1, 0.1], centro: true, sep: 18 });
  else if (punto?.cai) {
    for (const r of envolver(`CAI: ${punto.cai}`, 10, util)) fila(r);
  }
  fila('FACTURA', { tam: 13, negrita: true, sep: 18 });
  fila(`Factura No.: ${venta.numero_factura ?? '(sin emitir)'}`);
  fila(`Fecha de emisión: ${fecha}`);
  if (punto && !punto.es_borrador && punto.cai) {
    const f = (n) => `${punto.punto_emision_codigo}-${punto.punto_venta_codigo}-${punto.tipo_documento_codigo}-${String(n).padStart(8, '0')}`;
    fila(`Rango autorizado: ${f(punto.correlativo_desde)} al ${f(punto.correlativo_hasta)}`);
    if (punto.fecha_limite_emision) fila(`Fecha límite de emisión: ${punto.fecha_limite_emision}`);
  }
  pg.y -= 6;
  fila(`Cliente: ${cliente?.nombre ?? 'Consumidor Final'}`);
  fila(`RTN: ${cliente?.rtn || 'N/A'}`);
  if (cajero?.nombre) fila(`Atendió: ${cajero.nombre}`);
  fila(`Orden #${venta.ticket_dia || venta.numero_orden}${venta.nombre_orden ? ` - ${venta.nombre_orden}` : ''}`);
  pg.y -= 6;

  // Tabla de productos
  const cols = { prod: MARGEN, cant: MARGEN + 260, precio: MARGEN + 320, monto: MARGEN + 410 };
  const cabecera = () => {
    pg.texto('Producto', cols.prod, pg.y, { negrita: true });
    pg.texto('Cant.', cols.cant, pg.y, { negrita: true, derecha: true, w: 50 });
    pg.texto('Precio', cols.precio, pg.y, { negrita: true, derecha: true, w: 70 });
    pg.texto('Monto', cols.monto, pg.y, { negrita: true, derecha: true, w: 92 });
    pg.y -= 5; pg.linea(MARGEN, pg.y, ANCHO - MARGEN, pg.y); pg.y -= 13;
  };
  cabecera();
  for (const l of lineas) {
    const nombre = envolver(l.nombre_producto, 10, 250);
    salto(14 * nombre.length + 12);
    if (pg.y > ALTO - MARGEN - 5) cabecera();
    const bruto = Number(l.cantidad) * Number(l.precio_unitario);
    pg.texto(nombre[0] ?? '', cols.prod, pg.y);
    pg.texto(String(Number(l.cantidad)), cols.cant, pg.y, { derecha: true, w: 50 });
    pg.texto(L(l.precio_unitario), cols.precio, pg.y, { derecha: true, w: 70 });
    pg.texto(L(bruto), cols.monto, pg.y, { derecha: true, w: 92 });
    pg.y -= 13;
    for (const r of nombre.slice(1)) { pg.texto(r, cols.prod, pg.y); pg.y -= 13; }
    for (const o of l.opciones ?? []) { salto(12); pg.texto(`+ ${o.nombre}${Number(o.precio_extra) ? ` (${L(o.precio_extra)})` : ''}`, cols.prod + 10, pg.y, { tam: 8.5, color: [0.35, 0.35, 0.35] }); pg.y -= 11; }
    if (l.notas) { salto(12); pg.texto(`* ${l.notas}`, cols.prod + 10, pg.y, { tam: 8.5, color: [0.35, 0.35, 0.35] }); pg.y -= 11; }
    if (Number(l.descuento) > 0) {
      salto(12);
      pg.texto(`Descuento ${l.descuento_porcentaje ? `${l.descuento_porcentaje}%` : ''}${Number(l.descuento_porcentaje) === 25 ? ' (3ra edad)' : ''}`, cols.prod + 10, pg.y, { tam: 8.5, color: [0.35, 0.35, 0.35] });
      pg.texto(`-${L(l.descuento)}`, cols.monto, pg.y, { tam: 8.5, derecha: true, w: 92, color: [0.35, 0.35, 0.35] });
      pg.y -= 11;
    }
  }
  salto(150);
  pg.linea(MARGEN, pg.y + 4, ANCHO - MARGEN, pg.y + 4);
  pg.y -= 8;

  const total = (etq, monto, negrita = false, tam = 10) => {
    salto(16);
    pg.texto(etq, MARGEN + 200, pg.y, { negrita, tam, derecha: true, w: 190 });
    pg.texto(L(monto), cols.monto, pg.y, { negrita, tam, derecha: true, w: 92 });
    pg.y -= tam + 5;
  };
  if (Number(venta.descuento) > 0) total('Descuentos:', -Number(venta.descuento));
  total('Importe exento:', venta.subtotal_exento);
  total('Importe exonerado:', venta.subtotal_exonerado);
  total('Importe gravado 15%:', venta.subtotal_gravado_15);
  if (Number(venta.subtotal_gravado_18) > 0) total('Importe gravado 18%:', venta.subtotal_gravado_18);
  total('ISV:', venta.isv_total);
  total('TOTAL:', venta.total, true, 12);
  pg.y -= 6;

  for (const p of pagos ?? []) fila(`Pago ${p.forma}: ${L(p.monto)}${p.referencia ? ` (ref. ${p.referencia})` : ''}`);
  if (venta.efectivo_recibido != null) { fila(`Efectivo recibido: ${L(venta.efectivo_recibido)}   Cambio: ${L(venta.cambio ?? 0)}`); }
  if (venta.tercera_edad_identidad) fila(`Descuento 3ra edad: ${venta.tercera_edad_nombre ?? ''} - ID ${venta.tercera_edad_identidad}`, { tam: 9 });
  if (venta.estado === 'anulada' && venta.motivo_anulacion) fila(`Motivo de anulación: ${venta.motivo_anulacion}`, { tam: 9, color: [0.75, 0.1, 0.1] });
  pg.y -= 10;
  fila('LA FACTURA ES BENEFICIO DE TODOS, EXÍJALA', { tam: 9, negrita: true, centro: true });
  fila('Original: cliente - Copia: emisor', { tam: 8, centro: true, color: [0.4, 0.4, 0.4] });

  return ensamblar(paginas);
}

/** Arma el archivo PDF (objetos + tabla de referencias) a partir de las páginas de contenido. */
function ensamblar(paginas) {
  const objs = [];
  const add = (cuerpo) => { objs.push(cuerpo); return objs.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(''); // se rellena abajo con los hijos
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const hijos = [];
  for (const p of paginas) {
    const flujo = p.contenido();
    const cont = add(`<< /Length ${Buffer.byteLength(flujo, 'latin1')} >>\nstream\n${flujo}\nendstream`);
    const pag = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ANCHO} ${ALTO}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${cont} 0 R >>`);
    hijos.push(`${pag} 0 R`);
  }
  objs[1] = `<< /Type /Pages /Kids [${hijos.join(' ')}] /Count ${hijos.length} >>`;

  let salida = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(salida, 'latin1')); salida += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(salida, 'latin1');
  salida += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  salida += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(salida, 'latin1');
}
