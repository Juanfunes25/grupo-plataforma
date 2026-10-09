// Reporte neutral → PDF 1.4 escrito a mano (Helvetica, sin dependencias), igual criterio que la factura en PDF.
// Hoja carta; si la tabla tiene muchas columnas, horizontal. Repite el encabezado de la tabla en cada página.

const MARGEN = 40;
const limpiar = (t) => String(t ?? '')
  .replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/…/g, '...').replace(/×/g, 'x').replace(/·/g, '-')
  .replace(/[^\x20-\x7E -ÿ]/g, '?');
const esc = (t) => limpiar(t).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** Ancho aproximado en puntos de un texto en Helvetica. */
export function anchoTexto(texto, tam, negrita = false) {
  let w = 0;
  for (const ch of limpiar(texto)) {
    if ('iljI.,;:\'!|'.includes(ch)) w += 250;
    else if ('ftr() -/'.includes(ch)) w += 330;
    else if ('mwMW'.includes(ch)) w += 830;
    else if (/[A-Z0-9]/.test(ch)) w += negrita ? 700 : 667;
    else w += negrita ? 590 : 556;
  }
  return (w * tam) / 1000;
}
/** Recorta con «...» para que quepa en `max` puntos. */
export function ajustar(texto, tam, max, negrita = false) {
  let t = limpiar(texto);
  if (anchoTexto(t, tam, negrita) <= max) return t;
  while (t.length > 1 && anchoTexto(`${t}...`, tam, negrita) > max) t = t.slice(0, -1);
  return `${t}...`;
}

const L = (v) => `L ${Number(v).toLocaleString('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export function textoCelda(tipo, v) {
  if (v === null || v === undefined || v === '') return tipo === 'texto' || tipo === 'fecha' ? '' : '-';
  if (tipo === 'moneda') return Number.isFinite(Number(v)) ? L(v) : String(v);
  if (tipo === 'entero') return Number.isFinite(Number(v)) ? Number(v).toLocaleString('es-HN', { maximumFractionDigits: 0 }) : String(v);
  if (tipo === 'numero') return Number.isFinite(Number(v)) ? Number(v).toLocaleString('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v);
  if (tipo === 'pct') return Number.isFinite(Number(v)) ? `${Number(v).toLocaleString('es-HN', { maximumFractionDigits: 1 })}%` : String(v);
  if (tipo === 'fecha') { const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v); }
  return String(v);
}

class Pagina {
  constructor() { this.ops = []; }
  texto(t, x, y, { tam = 9, negrita = false, color = [0.1, 0.1, 0.1], derecha = false, w = 0 } = {}) {
    const px = derecha ? x + w - anchoTexto(t, tam, negrita) : x;
    this.ops.push(`BT /${negrita ? 'F2' : 'F1'} ${tam} Tf ${color.join(' ')} rg ${px.toFixed(2)} ${y.toFixed(2)} Td (${esc(t)}) Tj ET`);
  }
  rect(x, y, w, h, color) { this.ops.push(`${color.join(' ')} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`); }
  linea(x1, y1, x2, y2, g = 0.4, color = [0.8, 0.8, 0.8]) { this.ops.push(`${color.join(' ')} RG ${g} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`); }
}

export function reporteAPdf(rep) {
  const ancha = Math.max(0, ...(rep.secciones ?? []).map((s) => s.columnas.length)) > 6;
  const AN = ancha ? 792 : 612, AL = ancha ? 612 : 792;
  const util = AN - 2 * MARGEN;
  const paginas = [];
  let pg, y;
  const nueva = () => { pg = new Pagina(); paginas.push(pg); y = AL - MARGEN; };
  const asegurar = (alto) => { if (y - alto < MARGEN + 16) { nueva(); return true; } return false; };
  nueva();

  pg.texto(rep.titulo, MARGEN, y - 14, { tam: 16, negrita: true }); y -= 24;
  if (rep.subtitulo) { pg.texto(rep.subtitulo, MARGEN, y - 8, { tam: 10, color: [0.4, 0.4, 0.4] }); y -= 18; }
  pg.linea(MARGEN, y - 2, AN - MARGEN, y - 2, 1, [0.17, 0.16, 0.15]); y -= 14;

  const kpis = (rep.resumen ?? []).map((k) => ({ ...k, texto: textoCelda(k.tipo, k.valor) }));
  const colK = ancha ? 4 : 3, anK = util / colK;
  for (let i = 0; i < kpis.length; i += colK) {
    asegurar(36);
    kpis.slice(i, i + colK).forEach((k, j) => {
      pg.texto(ajustar(k.etiqueta, 8, anK - 8), MARGEN + j * anK, y - 8, { tam: 8, color: [0.45, 0.45, 0.45] });
      pg.texto(ajustar(k.texto, 13, anK - 8, true), MARGEN + j * anK, y - 23, { tam: 13, negrita: true });
    });
    y -= 36;
  }

  for (const s of rep.secciones ?? []) {
    asegurar(60);
    y -= 6;
    pg.texto(s.titulo, MARGEN, y - 11, { tam: 11, negrita: true }); y -= 20;
    // Anchos: proporcional al tipo; el texto toma lo que sobra.
    const peso = (c) => ({ moneda: 1.1, entero: 0.8, numero: 1, pct: 0.9, fecha: 0.95 }[c.tipo] ?? 1.9);
    const suma = s.columnas.reduce((a, c) => a + peso(c), 0);
    const cols = s.columnas.map((c) => ({ ...c, w: (peso(c) / suma) * util }));
    const tam = s.columnas.length > 9 ? 6.5 : s.columnas.length > 6 ? 7.5 : 8.5;
    const encabezado = () => {
      pg.rect(MARGEN, y - 15, util, 16, [0.17, 0.16, 0.15]);
      let x = MARGEN;
      for (const c of cols) { pg.texto(ajustar(c.titulo, tam, c.w - 6, true), x + 3, y - 11, { tam, negrita: true, color: [1, 1, 1], derecha: c.tipo !== 'texto' && c.tipo !== 'fecha', w: c.w - 6 }); x += c.w; }
      y -= 17;
    };
    encabezado();
    s.filas.forEach((f, idx) => {
      if (asegurar(15)) encabezado();
      if (idx % 2) pg.rect(MARGEN, y - 12, util, 14, [0.96, 0.95, 0.93]);
      let x = MARGEN;
      for (const c of cols) {
        const num = c.tipo !== 'texto' && c.tipo !== 'fecha';
        pg.texto(ajustar(textoCelda(c.tipo, f[c.clave]), tam, c.w - 6), x + 3, y - 9, { tam, derecha: num, w: c.w - 6 });
        x += c.w;
      }
      y -= 14;
    });
    if (!s.filas.length) { pg.texto('Sin datos.', MARGEN + 3, y - 9, { tam, color: [0.5, 0.5, 0.5] }); y -= 14; }
    y -= 6;
  }
  for (const t of rep.notas ?? []) { asegurar(14); pg.texto(ajustar(t, 8, util), MARGEN, y - 8, { tam: 8, color: [0.45, 0.45, 0.45] }); y -= 12; }

  const pie = `Plataforma del Grupo - ${new Date().toLocaleString('es-HN', { timeZone: 'America/Tegucigalpa', dateStyle: 'short', timeStyle: 'short' })}`;
  paginas.forEach((p, i) => p.texto(`${pie} - Pagina ${i + 1} de ${paginas.length}`, MARGEN, 22, { tam: 7, color: [0.55, 0.55, 0.55] }));
  return ensamblar(paginas, AN, AL);
}

function ensamblar(paginas, AN, AL) {
  const objs = [];
  const add = (c) => { objs.push(c); return objs.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const hijos = [];
  for (const p of paginas) {
    const flujo = p.ops.join('\n');
    const cont = add(`<< /Length ${Buffer.byteLength(flujo, 'latin1')} >>\nstream\n${flujo}\nendstream`);
    const pag = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${AN} ${AL}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${cont} 0 R >>`);
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

export const MIME_PDF = 'application/pdf';
