// Boletas de pago en PDF, sin dependencias (PDF 1.4 escrito a mano con Helvetica, como la factura).
// Dos boletas por hoja carta (arriba y abajo, con línea de corte): se imprimen en cualquier impresora y ahorran papel.
const ANCHO = 612, ALTO = 792, MARGEN = 40;
const L = (n) => Number(n || 0).toLocaleString('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const limpiar = (t) => String(t ?? '').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...').replace(/×/g, 'x').replace(/[^\x20-\x7E -ÿ]/g, '?');
const esc = (t) => limpiar(t).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
function ancho(texto, tam, negrita = false) {
  let w = 0;
  for (const ch of limpiar(texto)) {
    if ('iljI.,;:\'!|'.includes(ch)) w += 250; else if ('ftr() -'.includes(ch)) w += 330; else if ('mwMW'.includes(ch)) w += 830;
    else if (/[A-Z0-9]/.test(ch)) w += negrita ? 700 : 667; else w += negrita ? 590 : 556;
  }
  return (w * tam) / 1000;
}
const recortar = (t, tam, max, neg = false) => { let s = String(t ?? ''); while (s.length > 1 && ancho(s, tam, neg) > max) s = s.slice(0, -1); return s; };

class Pagina {
  constructor() { this.ops = []; }
  texto(t, x, y, { tam = 9, negrita = false, derecha = false, w = 0, gris = 0 } = {}) {
    const px = derecha ? x + w - ancho(t, tam, negrita) : x;
    this.ops.push(`BT /${negrita ? 'F2' : 'F1'} ${tam} Tf ${gris} g ${px.toFixed(2)} ${y.toFixed(2)} Td (${esc(t)}) Tj ET`);
  }
  linea(x1, y1, x2, y2, g = 0.5, punteada = false) { this.ops.push(`${punteada ? '[3 3] 0 d' : '[] 0 d'} ${g} w ${x1} ${y1} m ${x2} ${y2} l S`); }
  rect(x, y, w, h, gris) { this.ops.push(`${gris} g ${x} ${y} ${w} ${h} re f 0 g`); }
  contenido() { return this.ops.join('\n'); }
}

/** Dibuja UNA boleta con su borde superior en `top` (puntos desde abajo). */
function dibujarBoleta(pg, { empresa, planilla, linea, aviso }, top) {
  const x0 = MARGEN, w = ANCHO - 2 * MARGEN, mitad = w / 2 - 8;
  let y = top;
  pg.texto(empresa, x0, y, { tam: 13, negrita: true });
  pg.texto('BOLETA DE PAGO', x0, y, { tam: 11, negrita: true, derecha: true, w });
  y -= 13; pg.texto(planilla.etiqueta, x0, y, { tam: 9 });
  pg.texto(`Fecha de pago: ${planilla.fecha_pago ?? '-'}`, x0, y, { tam: 9, derecha: true, w });
  y -= 6; pg.linea(x0, y, x0 + w, y, 0.8);
  y -= 13;
  pg.texto('Empleado', x0, y, { tam: 7, gris: 0.4 }); pg.texto('Identidad', x0 + 230, y, { tam: 7, gris: 0.4 }); pg.texto('Puesto', x0 + 340, y, { tam: 7, gris: 0.4 });
  y -= 11;
  pg.texto(recortar(linea.nombre, 10, 220, true), x0, y, { tam: 10, negrita: true }); pg.texto(linea.identidad ?? '-', x0 + 230, y, { tam: 9 });
  pg.texto(recortar(`${linea.puesto ?? '-'}${linea.sucursal ? ` · ${linea.sucursal}` : ''}`, 9, w - 340), x0 + 340, y, { tam: 9 });
  y -= 14;
  const esDecimo = planilla.tipo === 'aguinaldo' || planilla.tipo === 'catorceavo';
  const ingresos = [];
  if (esDecimo) {
    ingresos.push([`${planilla.etiqueta}`, linea.devengado]);
    ingresos.push([`Proporcional: ${linea.dias_pagados} dias trabajados`, null]);
  } else {
    ingresos.push([`Sueldo (${linea.dias_pagados} dias) · base ${L(linea.salario_mensual)} al mes`, linea.devengado]);
    const hx = [['he_diurna_h', 'diurnas'], ['he_nocturna_h', 'nocturnas'], ['he_feriada_h', 'feriadas']].filter(([k]) => Number(linea[k]) > 0).map(([k, n]) => `${linea[k]} h ${n}`);
    if (Number(linea.he_monto) > 0) ingresos.push([`Horas extra (${hx.join(', ')})`, linea.he_monto]);
    if (Number(linea.bonos) > 0) ingresos.push(['Bonos', linea.bonos]);
    if (Number(linea.vacaciones_extra) > 0) ingresos.push([`Pago adicional por vacaciones (${linea.vacaciones_dias} dias)`, linea.vacaciones_extra]);
    else if (Number(linea.vacaciones_dias) > 0) ingresos.push([`Vacaciones pagadas incluidas en el sueldo: ${linea.vacaciones_dias} dias`, null]);
  }
  const deducciones = [];
  if (Number(linea.desc_ausencias) > 0) deducciones.push(['Ausencias / permisos sin goce', linea.desc_ausencias]);
  if (Number(linea.ihss) > 0) deducciones.push(['IHSS', linea.ihss]);
  if (Number(linea.rap) > 0) deducciones.push(['RAP', linea.rap]);
  if (Number(linea.infop) > 0) deducciones.push(['INFOP', linea.infop]);
  if (Number(linea.isr) > 0) deducciones.push(['ISR retenido', linea.isr]);
  if (Number(linea.otros_desc) > 0) deducciones.push(['Otros descuentos', linea.otros_desc]);
  if (!deducciones.length) deducciones.push(['Sin deducciones', null]);

  const yTabla = y;
  pg.rect(x0, y - 3, mitad, 13, 0.92); pg.rect(x0 + mitad + 16, y - 3, mitad, 13, 0.92);
  pg.texto('INGRESOS', x0 + 4, y, { tam: 8, negrita: true }); pg.texto('DEDUCCIONES', x0 + mitad + 20, y, { tam: 8, negrita: true });
  y -= 14;
  const filas = Math.max(ingresos.length, deducciones.length);
  for (let i = 0; i < filas; i++) {
    if (ingresos[i]) { pg.texto(recortar(ingresos[i][0], 8.5, mitad - 70), x0 + 4, y, { tam: 8.5 }); if (ingresos[i][1] != null) pg.texto(L(ingresos[i][1]), x0, y, { tam: 8.5, derecha: true, w: mitad - 4 }); }
    if (deducciones[i]) { pg.texto(recortar(deducciones[i][0], 8.5, mitad - 70), x0 + mitad + 20, y, { tam: 8.5 }); if (deducciones[i][1] != null) pg.texto(L(deducciones[i][1]), x0 + mitad + 16, y, { tam: 8.5, derecha: true, w: mitad - 4 }); }
    y -= 12;
  }
  pg.linea(x0, y + 6, x0 + mitad, y + 6, 0.4); pg.linea(x0 + mitad + 16, y + 6, x0 + w, y + 6, 0.4);
  y -= 4;
  pg.texto('Total ingresos', x0 + 4, y, { tam: 9, negrita: true }); pg.texto(L(linea.total_ingresos), x0, y, { tam: 9, negrita: true, derecha: true, w: mitad - 4 });
  pg.texto('Total deducciones', x0 + mitad + 20, y, { tam: 9, negrita: true }); pg.texto(L(linea.total_deducciones), x0 + mitad + 16, y, { tam: 9, negrita: true, derecha: true, w: mitad - 4 });
  y -= 8; void yTabla;
  pg.rect(x0, y - 18, w, 20, 0.88);
  pg.texto('NETO A PAGAR (Lempiras)', x0 + 6, y - 12, { tam: 10, negrita: true }); pg.texto(`L ${L(linea.neto)}`, x0, y - 12, { tam: 12, negrita: true, derecha: true, w: w - 6 });
  y -= 44;
  pg.linea(x0 + 10, y, x0 + 210, y, 0.5); pg.linea(x0 + w - 210, y, x0 + w - 10, y, 0.5);
  y -= 10; pg.texto('Firma del empleado', x0 + 10, y, { tam: 7.5, gris: 0.35 }); pg.texto('Firma de la empresa', x0 + w - 210, y, { tam: 7.5, gris: 0.35 });
  if (aviso) { y -= 12; pg.texto(aviso, x0, y, { tam: 7, gris: 0.45 }); }
}

function ensamblar(paginas) {
  const objs = [];
  const add = (c) => { objs.push(c); return objs.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>'); add('');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const hijos = [];
  for (const p of paginas) {
    const flujo = p.contenido();
    const cont = add(`<< /Length ${Buffer.byteLength(flujo, 'latin1')} >>\nstream\n${flujo}\nendstream`);
    hijos.push(`${add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ANCHO} ${ALTO}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${cont} 0 R >>`)} 0 R`);
  }
  objs[1] = `<< /Type /Pages /Kids [${hijos.join(' ')}] /Count ${hijos.length} >>`;
  let salida = '%PDF-1.4\n'; const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(salida, 'latin1')); salida += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(salida, 'latin1');
  salida += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  salida += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(salida, 'latin1');
}

/** `lineas`: renglones de plan.planilla_lineas. `aviso`: texto al pie (p. ej. parámetros sin confirmar). */
export function generarBoletasPdf({ empresa, planilla, lineas, aviso = null }) {
  const paginas = [];
  const mitadAlto = (ALTO - 2 * MARGEN) / 2;
  lineas.forEach((linea, i) => {
    if (i % 2 === 0) paginas.push(new Pagina());
    const pg = paginas[paginas.length - 1];
    const top = i % 2 === 0 ? ALTO - MARGEN - 8 : ALTO - MARGEN - mitadAlto - 8;
    dibujarBoleta(pg, { empresa, planilla, linea, aviso }, top);
    if (i % 2 === 0) pg.linea(MARGEN, ALTO / 2, ANCHO - MARGEN, ALTO / 2, 0.4, true);
  });
  if (!paginas.length) paginas.push(new Pagina());
  return ensamblar(paginas);
}
