// Reporte neutral → libro de Excel (.xlsx) con exceljs: una hoja «Resumen» y una hoja por tabla.
import ExcelJS from 'exceljs';

const FORMATO = { moneda: '"L" #,##0.00;[Red]-"L" #,##0.00', entero: '#,##0', numero: '#,##0.00', pct: '0.0"%"', fecha: 'dd/mm/yyyy' };
const ANCHO = { moneda: 16, entero: 11, numero: 14, pct: 12, fecha: 13, texto: 26 };
const ARGB_ENCABEZADO = 'FF2F2A26';

/** Nombre de hoja válido (≤31 caracteres, sin : \ / ? * [ ]) y único. */
function nombreHoja(titulo, usados) {
  const base = String(titulo).replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 28) || 'Hoja';
  let n = base, i = 2;
  while (usados.has(n.toLowerCase())) n = `${base.slice(0, 26)} ${i++}`;
  usados.add(n.toLowerCase());
  return n;
}

function valorCelda(tipo, v) {
  if (v === null || v === undefined || v === '') return null;
  if (tipo === 'fecha') { const d = /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? new Date(`${String(v).slice(0, 10)}T12:00:00Z`) : null; return d ?? String(v); }
  if (['moneda', 'entero', 'numero', 'pct'].includes(tipo)) { const x = Number(v); return Number.isFinite(x) ? x : String(v); }
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

export async function reporteAExcel(rep) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Plataforma del Grupo'; wb.created = new Date();
  const usados = new Set();

  const hr = wb.addWorksheet(nombreHoja('Resumen', usados), { views: [{ showGridLines: false }] });
  hr.columns = [{ width: 38 }, { width: 22 }];
  hr.addRow([rep.titulo]).font = { bold: true, size: 16 };
  hr.addRow([rep.subtitulo ?? '']).font = { color: { argb: 'FF666666' } };
  hr.addRow([]);
  for (const k of rep.resumen ?? []) {
    const fila = hr.addRow([k.etiqueta, valorCelda(k.tipo, k.valor) ?? '—']);
    fila.getCell(1).font = { bold: true };
    if (FORMATO[k.tipo]) fila.getCell(2).numFmt = FORMATO[k.tipo];
    fila.getCell(2).alignment = { horizontal: 'right' };
  }
  if (rep.notas?.length) { hr.addRow([]); for (const t of rep.notas) { const f = hr.addRow([t]); f.font = { italic: true, color: { argb: 'FF666666' } }; } }
  hr.addRow([]);
  hr.addRow([`Generado ${new Date().toLocaleString('es-HN', { timeZone: 'America/Tegucigalpa' })} · Plataforma del Grupo`]).font = { size: 9, color: { argb: 'FF888888' } };

  for (const s of rep.secciones ?? []) {
    const ws = wb.addWorksheet(nombreHoja(s.titulo, usados), { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = s.columnas.map((c) => ({ header: c.titulo, key: c.clave, width: ANCHO[c.tipo] ?? ANCHO.texto, style: FORMATO[c.tipo] ? { numFmt: FORMATO[c.tipo] } : {} }));
    for (const f of s.filas) ws.addRow(Object.fromEntries(s.columnas.map((c) => [c.clave, valorCelda(c.tipo, f[c.clave])])));
    const cab = ws.getRow(1);
    cab.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cab.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ARGB_ENCABEZADO } };
    cab.alignment = { vertical: 'middle', wrapText: true };
    cab.height = 24;
    s.columnas.forEach((c, i) => { if (c.tipo !== 'texto' && c.tipo !== 'fecha') ws.getColumn(i + 1).alignment = { horizontal: 'right' }; });
    if (s.filas.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: s.columnas.length } };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
