// Constructor sencillo de libros de Excel para los reportes (Finanzas, Compras…).
//   const buf = await libroExcel({ titulo: 'Estado de resultados', hojas: [{ nombre, columnas: [{ h, k, tipo, ancho }], filas, totales }] });
// tipo: 'texto' (por defecto) · 'lempiras' · 'numero' · 'porcentaje' (el valor ya viene en %).
// exceljs pesa ~250 ms al importarse: se carga la primera vez que se arma o lee un Excel, no al arrancar el servidor.
const cargarExcel = () => import('exceljs').then((m) => m.default);

const FORMATOS = { lempiras: '"L" #,##0.00;[Red]-"L" #,##0.00', numero: '#,##0.00', entero: '#,##0', porcentaje: '0.0"%"' };

export async function libroExcel({ titulo, subtitulo = '', hojas }) {
  const ExcelJS = await cargarExcel();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Plataforma del Grupo';
  wb.created = new Date();
  for (const h of hojas) {
    const ws = wb.addWorksheet(String(h.nombre).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Hoja');
    let fila = 1;
    ws.getCell(fila, 1).value = h.titulo ?? titulo;
    ws.getCell(fila, 1).font = { bold: true, size: 14 };
    fila += 1;
    if (subtitulo || h.subtitulo) { ws.getCell(fila, 1).value = h.subtitulo ?? subtitulo; ws.getCell(fila, 1).font = { color: { argb: 'FF666666' } }; fila += 1; }
    fila += 1;
    const cab = ws.getRow(fila);
    h.columnas.forEach((c, i) => {
      const cell = cab.getCell(i + 1);
      cell.value = c.h;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3D3A36' } };
      cell.alignment = { horizontal: c.tipo && c.tipo !== 'texto' ? 'right' : 'left', vertical: 'middle', wrapText: true };
      ws.getColumn(i + 1).width = c.ancho ?? (c.tipo && c.tipo !== 'texto' ? 16 : 28);
    });
    const primera = fila + 1;
    fila += 1;
    for (const f of h.filas) {
      h.columnas.forEach((c, i) => {
        const cell = ws.getCell(fila, i + 1);
        const v = f[c.k];
        cell.value = v === undefined ? null : v;
        if (FORMATOS[c.tipo] && typeof v === 'number') cell.numFmt = FORMATOS[c.tipo];
      });
      fila += 1;
    }
    if (h.totales) {
      h.columnas.forEach((c, i) => {
        const cell = ws.getCell(fila, i + 1);
        const v = h.totales[c.k];
        cell.value = v === undefined ? null : v;
        cell.font = { bold: true };
        cell.border = { top: { style: 'thin' } };
        if (FORMATOS[c.tipo] && typeof v === 'number') cell.numFmt = FORMATOS[c.tipo];
      });
    }
    ws.views = [{ state: 'frozen', ySplit: primera - 1 }];
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Responde un libro como descarga. */
export function enviarLibro(res, buffer, nombre) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${String(nombre).replace(/[^\w.\- ]/g, '_')}"`);
  res.send(buffer);
}
