// PDF 1.4 mínimo para documentos que se mandan por correo (cotizaciones): texto, tabla de partidas y totales.
// Sin dependencias; fuentes estándar Helvetica. Mismo enfoque que pos/pdf.js (la factura).
const ANCHO = 612, ALTO = 792, MARGEN = 48;

const limpiar = (t) => String(t ?? '')
  .replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...').replace(/×/g, 'x')
  .replace(/[^\x20-\x7E -ÿ]/g, '?');
const esc = (t) => limpiar(t).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

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

function envolver(texto, tam, max) {
  const out = []; let act = '';
  for (const p of String(texto ?? '').split(/\s+/).filter(Boolean)) {
    const prueba = act ? `${act} ${p}` : p;
    if (ancho(prueba, tam) > max && act) { out.push(act); act = p; } else act = prueba;
  }
  if (act) out.push(act);
  return out.length ? out : [''];
}

export const lempirasPdf = (n) => `L ${Number(n || 0).toLocaleString('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * @param {object} d
 * @param {{nombre:string, razon_social?:string, rtn?:string, telefono?:string, correo?:string, direccion?:string}} d.empresa
 * @param {string} d.titulo        p. ej. «Cotización 0012»
 * @param {string} [d.leyenda]     aviso en rojo (BORRADOR – SIN VALOR FISCAL)
 * @param {[string,string][]} [d.datos]     pares etiqueta/valor del encabezado
 * @param {{cabeza:string, ancho:number, derecha?:boolean}[]} [d.columnas]  ancho en puntos
 * @param {string[][]} [d.filas]
 * @param {[string,string][]} [d.totales]
 * @param {string[]} [d.notas]
 */
export function generarPdfDocumento({ empresa, titulo, leyenda, datos = [], columnas = [], filas = [], totales = [], notas = [] }) {
  const paginas = []; let ops; let y;
  const nueva = () => { ops = []; paginas.push(ops); y = ALTO - MARGEN; };
  const txt = (t, x, yy, { tam = 10, neg = false, color = [0, 0, 0], derecha = false, w = 0, centro = false } = {}) => {
    let px = x;
    if (derecha) px = x + w - ancho(t, tam, neg);
    if (centro) px = x + (w - ancho(t, tam, neg)) / 2;
    ops.push(`BT /${neg ? 'F2' : 'F1'} ${tam} Tf ${color.join(' ')} rg ${px.toFixed(2)} ${yy.toFixed(2)} Td (${esc(t)}) Tj ET`);
  };
  const linea = (x1, y1, x2, y2, g = 0.5) => ops.push(`${g} w ${x1} ${y1} m ${x2} ${y2} l S`);
  const util = ANCHO - 2 * MARGEN;
  const hace = (alto) => { if (y - alto < MARGEN + 24) { nueva(); cabeceraTabla(); } };
  const cabeceraTabla = () => {
    if (!columnas.length || paginas.length === 1) return;
    let x = MARGEN; y -= 4;
    for (const c of columnas) { txt(c.cabeza, x, y, { tam: 9, neg: true, derecha: c.derecha, w: c.ancho - 4 }); x += c.ancho; }
    y -= 4; linea(MARGEN, y, MARGEN + util, y); y -= 12;
  };

  nueva();
  txt(empresa?.nombre ?? '', MARGEN, y, { tam: 17, neg: true }); y -= 15;
  const sub = [empresa?.razon_social, empresa?.rtn ? `RTN ${empresa.rtn}` : null].filter(Boolean).join('  -  ');
  if (sub) { txt(sub, MARGEN, y, { tam: 9, color: [0.35, 0.35, 0.35] }); y -= 12; }
  const contacto = [empresa?.direccion, empresa?.telefono, empresa?.correo].filter(Boolean).join('  -  ');
  if (contacto) { txt(contacto, MARGEN, y, { tam: 9, color: [0.35, 0.35, 0.35] }); y -= 12; }
  y -= 4; linea(MARGEN, y, MARGEN + util, y, 1); y -= 22;
  txt(titulo, MARGEN, y, { tam: 15, neg: true }); y -= 20;
  if (leyenda) { txt(leyenda, MARGEN, y, { tam: 11, neg: true, color: [0.75, 0.1, 0.1] }); y -= 18; }
  for (const [k, v] of datos) {
    if (v === null || v === undefined || v === '') continue;
    const rs = envolver(v, 10, util - 120);
    hace(14 * rs.length);
    txt(`${k}:`, MARGEN, y, { tam: 10, neg: true });
    rs.forEach((r, i) => { txt(r, MARGEN + 120, y - i * 12, { tam: 10 }); });
    y -= 13 * rs.length;
  }
  if (columnas.length) {
    y -= 8;
    let x = MARGEN;
    for (const c of columnas) { txt(c.cabeza, x, y, { tam: 9, neg: true, derecha: c.derecha, w: c.ancho - 4 }); x += c.ancho; }
    y -= 4; linea(MARGEN, y, MARGEN + util, y); y -= 12;
    for (const f of filas) {
      const lineasCelda = f.map((celda, i) => (columnas[i].derecha ? [String(celda ?? '')] : envolver(celda, 9.5, columnas[i].ancho - 6)));
      const n = Math.max(...lineasCelda.map((l) => l.length));
      hace(12 * n + 4);
      let cx = MARGEN;
      f.forEach((_, i) => {
        lineasCelda[i].forEach((r, j) => txt(r, cx, y - j * 11.5, { tam: 9.5, derecha: columnas[i].derecha, w: columnas[i].ancho - 4 }));
        cx += columnas[i].ancho;
      });
      y -= 11.5 * n + 3;
    }
    linea(MARGEN, y + 4, MARGEN + util, y + 4); y -= 8;
  }
  for (const [k, v, fuerte] of totales) {
    hace(16);
    txt(k, MARGEN + util - 230, y, { tam: fuerte ? 12 : 10, neg: Boolean(fuerte) });
    txt(v, MARGEN + util - 100, y, { tam: fuerte ? 12 : 10, neg: Boolean(fuerte), derecha: true, w: 100 });
    y -= fuerte ? 18 : 14;
  }
  if (notas.length) {
    y -= 8;
    for (const n of notas) for (const r of envolver(n, 9, util)) { hace(12); txt(r, MARGEN, y, { tam: 9, color: [0.3, 0.3, 0.3] }); y -= 11; }
  }
  paginas.forEach((p, i) => {
    ops = p;
    txt(`Página ${i + 1} de ${paginas.length}`, MARGEN, MARGEN - 18, { tam: 8, color: [0.5, 0.5, 0.5], derecha: true, w: util });
  });

  // ── Estructura del archivo PDF ──
  const objetos = [];
  const agregar = (s) => { objetos.push(s); return objetos.length; };
  agregar('<< /Type /Catalog /Pages 2 0 R >>');
  agregar('PLACEHOLDER');
  const f1 = agregar('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = agregar('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const p of paginas) {
    const cont = Buffer.from(p.join('\n'), 'latin1');
    const idC = agregar(`<< /Length ${cont.length} >>\nstream\n${cont.toString('latin1')}\nendstream`);
    const idP = agregar(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ANCHO} ${ALTO}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${idC} 0 R >>`);
    kids.push(`${idP} 0 R`);
  }
  objetos[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n'; const offs = [];
  objetos.forEach((o, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}
