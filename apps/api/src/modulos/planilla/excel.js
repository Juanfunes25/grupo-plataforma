// Exporta una planilla a Excel con el MISMO diseño de columnas de la hoja del dueño («ITALO 2026»):
//   ITALO GELATERIA / SALARIOS DEL [rango] / Empleado · DIAS · SALARIO DIARIO · TOTAL QUINCENAL · POR HORA · HORAS EXTRAS · TOTAL HX ·
//   deducciones · TOTAL · Numeros de cuenta · OBSERVACIONES, con un bloque por sucursal, su «Total» y el total general.
// Las celdas llevan fórmulas (como en su hoja): se puede corregir un día o una hora en Excel y todo se recalcula.
import ExcelJS from 'exceljs';
import { agruparPorSucursal, totalesDe } from './calculo.js';

const L = '#,##0.00';
const rango = (p) => `${p.desde.split('-').reverse().join('/')} AL ${p.hasta.split('-').reverse().join('/')}`;

export async function generarExcel({ empresa, planilla, lineas }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Plataforma del Grupo';
  const decimo = planilla.tipo === 'aguinaldo' || planilla.tipo === 'catorceavo';
  const ws = wb.addWorksheet(planilla.etiqueta.slice(0, 28).replace(/[\\/?*[\]:]/g, '-'));
  const negrita = { bold: true };
  ws.getCell('A1').value = empresa.toUpperCase(); ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A2').value = decimo ? `SALARIOS DEL ${planilla.tipo === 'aguinaldo' ? 'AGUINALDO' : 'CATORCEAVO'} (${rango(planilla)})` : `SALARIOS DEL ${rango(planilla)} · ${planilla.etiqueta}`;
  ws.getCell('A2').font = negrita;
  if (planilla.por_confirmar) ws.getCell('A3').value = 'Calculada con parámetros por confirmar con el contador.';
  const cols = decimo
    ? ['Empleado', 'DIAS', 'SALARIO DIARIO', 'TOTAL', 'Numeros de cuenta', 'OBSERVACIONES']
    : ['Empleado', 'DIAS', 'SALARIO DIARIO', 'TOTAL QUINCENAL', 'POR HORA', 'HORAS EXTRAS', 'TOTAL HX', 'deducciones', 'TOTAL', 'Numeros de cuenta', 'OBSERVACIONES'];
  const head = ws.getRow(5);
  cols.forEach((c, i) => { const cell = head.getCell(i + 1); cell.value = c; cell.font = negrita; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } }; cell.alignment = { horizontal: 'center', wrapText: true }; });
  ws.columns = decimo ? [{ width: 42 }, { width: 8 }, { width: 14 }, { width: 14 }, { width: 22 }, { width: 36 }]
    : [{ width: 42 }, { width: 8 }, { width: 14 }, { width: 16 }, { width: 10 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 14 }, { width: 22 }, { width: 44 }];
  let fila = 6;
  const filasTotal = [];
  const fmt = (cell) => { cell.numFmt = L; };
  for (const g of agruparPorSucursal(lineas)) {
    ws.getCell(`A${fila}`).value = g.sucursal.toUpperCase(); ws.getCell(`A${fila}`).font = negrita; fila++;
    const ini = fila;
    for (const l of g.lineas) {
      const r = fila;
      const dedTexto = (l.deducciones ?? []).filter((d) => d.monto > 0).map((d) => `${d.concepto} ${d.monto}`).join(', ');
      const obs = [l.observaciones, dedTexto ? `Deducciones: ${dedTexto}` : ''].filter(Boolean).join(' · ');
      ws.getCell(`A${r}`).value = l.nombre;
      ws.getCell(`B${r}`).value = Number(l.dias); ws.getCell(`C${r}`).value = Number(l.salario_diario);
      if (decimo) {
        ws.getCell(`D${r}`).value = { formula: `B${r}*C${r}`, result: Number(l.total) }; fmt(ws.getCell(`D${r}`));
        ws.getCell(`E${r}`).value = l.cuenta ?? ''; ws.getCell(`F${r}`).value = obs;
      } else {
        ws.getCell(`D${r}`).value = { formula: `B${r}*C${r}`, result: Number(l.total_quincenal) };
        ws.getCell(`E${r}`).value = Number(l.por_hora); ws.getCell(`F${r}`).value = Number(l.horas_extra);
        // TOTAL HX: fórmula si coincide con horas × tarifa; si se corrigió a mano o lleva recargo queda el valor
        const calc = Math.round(Number(l.horas_extra) * Number(l.por_hora) * 100) / 100;
        ws.getCell(`G${r}`).value = calc === Number(l.total_hx) ? { formula: `F${r}*E${r}`, result: Number(l.total_hx) } : Number(l.total_hx);
        ws.getCell(`H${r}`).value = Number(l.total_deducciones);
        ws.getCell(`I${r}`).value = { formula: `D${r}+G${r}+${Number(l.otros_ingresos)}-H${r}`, result: Number(l.total) };
        ws.getCell(`J${r}`).value = l.cuenta ?? ''; ws.getCell(`K${r}`).value = obs;
        for (const c of ['C', 'D', 'E', 'G', 'H', 'I']) fmt(ws.getCell(`${c}${r}`));
      }
      fmt(ws.getCell(`C${r}`));
      fila++;
    }
    const fin = fila - 1;
    ws.getCell(`A${fila}`).value = 'Total'; ws.getCell(`A${fila}`).font = negrita;
    const tcol = decimo ? 'D' : 'I';
    const t = totalesDe(g.lineas);
    ws.getCell(`${tcol}${fila}`).value = { formula: `SUM(${tcol}${ini}:${tcol}${fin})`, result: decimo ? t.total : t.total }; ws.getCell(`${tcol}${fila}`).font = negrita; fmt(ws.getCell(`${tcol}${fila}`));
    filasTotal.push({ fila, total: t.total });
    fila += 2;
  }
  ws.getCell(`A${fila}`).value = `Total ${empresa}`; ws.getCell(`A${fila}`).font = { bold: true, size: 12 };
  const tcol = decimo ? 'D' : 'I';
  ws.getCell(`${tcol}${fila}`).value = { formula: filasTotal.map((f) => `${tcol}${f.fila}`).join('+') || '0', result: totalesDe(lineas).total };
  ws.getCell(`${tcol}${fila}`).font = { bold: true, size: 12 }; fmt(ws.getCell(`${tcol}${fila}`));
  ws.views = [{ state: 'frozen', ySplit: 5 }];
  return wb.xlsx.writeBuffer();
}
