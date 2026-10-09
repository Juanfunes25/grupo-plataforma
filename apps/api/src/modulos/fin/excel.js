// Hojas de Excel de Finanzas (una empresa y consolidado). Cada reporte devuelve { hojas, nombre, titulo } para lib/excel.js.
import { GRUPOS_GASTO } from './estados.js';

const L = 'lempiras';
const ESTADO_PRES = { ok: 'En orden', riesgo: 'En riesgo', excedido: 'Excedido', bajo: 'Por debajo', sin_presupuesto: 'Sin presupuesto' };

const colsResultados = [
  { h: 'Concepto', k: 'nombre', ancho: 30 }, { h: 'Facturas', k: 'facturas', tipo: 'entero', ancho: 10 }, { h: 'Ventas netas', k: 'ventas_netas', tipo: L }, { h: 'Costo de ventas', k: 'costo_ventas', tipo: L },
  { h: 'Utilidad bruta', k: 'utilidad_bruta', tipo: L }, { h: 'Margen bruto', k: 'margen_bruto_pct', tipo: 'porcentaje', ancho: 13 }, { h: 'Gastos operativos', k: 'gastos_operativos', tipo: L }, { h: 'Utilidad operativa', k: 'utilidad_operativa', tipo: L },
];

export function hojasDe(reporte, d) {
  if (reporte === 'resultados') {
    const filas = [{ nombre: 'Total de la empresa', ...d.total }, ...d.sucursales.map((s) => ({ nombre: s.nombre, ...s })), { nombre: 'General (toda la empresa)', gastos_operativos: d.general.gastos_operativos }];
    return { nombre: 'estado-de-resultados', titulo: 'Estado de resultados', hojas: [
      { nombre: 'Por sucursal', columnas: colsResultados, filas },
      { nombre: 'Gastos por categoría', columnas: [{ h: 'Categoría', k: 'nombre', ancho: 34 }, { h: 'Grupo', k: 'grupo', ancho: 24 }, { h: 'Monto sin ISV', k: 'monto', tipo: L }], filas: d.categorias.map((c) => ({ ...c, grupo: GRUPOS_GASTO[c.grupo] ?? c.grupo })) },
    ] };
  }
  if (reporte === 'flujo') {
    const per = d.periodos;
    const cols = [{ h: 'Concepto', k: 'concepto', ancho: 42 }, ...per.map((p) => ({ h: p, k: p, tipo: L })), { h: 'Total', k: 'total', tipo: L }];
    const fila = (c) => ({ concepto: c.concepto, total: c.total, ...c.periodos });
    const resumen = (n, k) => ({ concepto: n, total: d.totales[k], ...Object.fromEntries(d.serie.map((s) => [s.periodo, s[k]])) });
    return { nombre: 'flujo-de-caja', titulo: 'Flujo de caja', hojas: [{ nombre: 'Flujo de caja', columnas: cols,
      filas: [{ concepto: 'ENTRADAS' }, ...d.entradas.map(fila), resumen('Total entradas', 'entradas'), { concepto: 'SALIDAS' }, ...d.salidas.map(fila), resumen('Total salidas', 'salidas'), resumen('Flujo neto', 'neto'),
        { concepto: 'Saldo acumulado', ...Object.fromEntries(d.serie.map((s) => [s.periodo, s.acumulado])) }] }] };
  }
  if (reporte === 'cobrar') {
    return { nombre: 'cuentas-por-cobrar', titulo: 'Cuentas por cobrar', hojas: [
      { nombre: 'Detalle', columnas: [{ h: 'Tipo', k: 'tipo', ancho: 12 }, { h: 'Documento', k: 'ref', ancho: 22 }, { h: 'Cliente', k: 'cliente', ancho: 32 }, { h: 'Fecha', k: 'fecha', ancho: 12 }, { h: 'Vence', k: 'vence', ancho: 12 }, { h: 'Días', k: 'dias', tipo: 'entero', ancho: 8 },
        { h: 'Antigüedad', k: 'bucket', ancho: 12 }, { h: 'Total', k: 'total', tipo: L }, { h: 'Abonado', k: 'abonado', tipo: L }, { h: 'Saldo', k: 'saldo', tipo: L }], filas: d.items, totales: { cliente: 'Total por cobrar', saldo: d.total } },
      { nombre: 'Por cliente', columnas: [{ h: 'Cliente', k: 'cliente', ancho: 34 }, { h: '0-30 días', k: '0-30', tipo: L }, { h: '31-60 días', k: '31-60', tipo: L }, { h: '61-90 días', k: '61-90', tipo: L }, { h: 'Más de 90', k: '+90', tipo: L }, { h: 'Saldo', k: 'saldo', tipo: L }], filas: d.por_cliente },
    ] };
  }
  if (reporte === 'pagar') {
    return { nombre: 'cuentas-por-pagar', titulo: 'Cuentas por pagar', hojas: [
      { nombre: 'Detalle', columnas: [{ h: 'Tipo', k: 'tipo', ancho: 10 }, { h: 'Referencia', k: 'ref', ancho: 30 }, { h: 'Proveedor', k: 'proveedor', ancho: 30 }, { h: 'Factura', k: 'documento', ancho: 16 }, { h: 'Fecha', k: 'fecha', ancho: 12 }, { h: 'Vence', k: 'vence', ancho: 12 },
        { h: 'Días para vencer', k: 'dias_para_vencer', tipo: 'entero', ancho: 12 }, { h: 'Situación', k: 'bucket', ancho: 12 }, { h: 'Saldo', k: 'saldo', tipo: L }], filas: d.items, totales: { proveedor: 'Total por pagar', saldo: d.total } },
      { nombre: 'Por proveedor', columnas: [{ h: 'Proveedor', k: 'proveedor', ancho: 34 }, { h: 'Vencido', k: 'vencido', tipo: L }, { h: 'Saldo', k: 'saldo', tipo: L }], filas: d.por_proveedor },
    ] };
  }
  if (reporte === 'presupuesto') {
    const filas = [d.ventas, ...d.gastos].map((l) => ({ ...l, estado: ESTADO_PRES[l.estado], grupo: l.grupo === 'ventas' ? 'Ventas' : GRUPOS_GASTO[l.grupo] ?? l.grupo }));
    return { nombre: 'presupuesto', titulo: `Presupuesto vs real · ${d.mes.slice(0, 7)}`, hojas: [{ nombre: 'Presupuesto', columnas: [{ h: 'Concepto', k: 'nombre', ancho: 32 }, { h: 'Grupo', k: 'grupo', ancho: 22 }, { h: 'Presupuesto', k: 'presupuesto', tipo: L }, { h: 'Real', k: 'real', tipo: L },
      { h: 'Diferencia', k: 'diferencia', tipo: L }, { h: '% usado', k: 'pct', tipo: 'porcentaje' }, { h: 'Proyección al cierre', k: 'proyeccion', tipo: L }, { h: 'Situación', k: 'estado', ancho: 16 }], filas }] };
  }
  // interco
  return { nombre: 'entre-empresas', titulo: 'Operaciones entre empresas', hojas: [{ nombre: 'Entre empresas', columnas: [{ h: 'Fecha', k: 'fecha', ancho: 12 }, { h: 'Cobra (origen)', k: 'de', ancho: 20 }, { h: 'Debe (destino)', k: 'a', ancho: 20 }, { h: 'Concepto', k: 'concepto', ancho: 40 },
    { h: 'Monto', k: 'monto', tipo: L }, { h: 'Pagado', k: 'pagado', tipo: L }, { h: 'Pendiente', k: 'pendiente', tipo: L }, { h: 'Estado', k: 'estado', ancho: 13 }], filas: d }] };
}

/** Consolidado del grupo: una hoja por tema, una fila por empresa y el total. */
export function hojasConsolidado(c) {
  const fila = (e, extra = {}) => ({ nombre: e.nombre, ...extra });
  return { nombre: 'consolidado-del-grupo', titulo: 'Consolidado del grupo', hojas: [
    { nombre: 'Resultados', columnas: colsResultados, filas: c.empresas.map((e) => fila(e, e.resultados)),
      totales: { nombre: 'Total grupo (sin eliminar)', ...c.total.resultados } },
    { nombre: 'Consolidado', columnas: [{ h: 'Concepto', k: 'c', ancho: 50 }, { h: 'Monto', k: 'm', tipo: L }], filas: [
      { c: 'Ventas netas de las empresas', m: c.total.resultados.ventas_netas }, { c: 'Menos: ventas entre empresas del grupo', m: -c.total.eliminacion },
      { c: 'Ventas netas consolidadas', m: c.total.ventas_consolidadas }, { c: 'Costo de ventas y gastos de las empresas', m: c.total.costos_y_gastos },
      { c: 'Menos: compras y gastos entre empresas del grupo', m: -c.total.eliminacion }, { c: 'Costos y gastos consolidados', m: c.total.costos_y_gastos_consolidados }, { c: 'Utilidad operativa consolidada', m: c.total.utilidad_consolidada }] },
    { nombre: 'Flujo de caja', columnas: [{ h: 'Empresa', k: 'nombre', ancho: 28 }, { h: 'Entradas', k: 'entradas', tipo: L }, { h: 'Salidas', k: 'salidas', tipo: L }, { h: 'Flujo neto', k: 'neto', tipo: L }], filas: c.empresas.map((e) => fila(e, e.flujo)),
      totales: { nombre: 'Total grupo', ...c.total.flujo } },
    { nombre: 'Por cobrar', columnas: [{ h: 'Empresa', k: 'nombre', ancho: 28 }, { h: '0-30 días', k: '0-30', tipo: L }, { h: '31-60 días', k: '31-60', tipo: L }, { h: '61-90 días', k: '61-90', tipo: L }, { h: 'Más de 90', k: '+90', tipo: L }, { h: 'Total', k: 'total', tipo: L }],
      filas: c.empresas.map((e) => fila(e, { ...e.cobrar.buckets, total: e.cobrar.total })), totales: { nombre: 'Total grupo', ...c.total.cobrar.buckets, total: c.total.cobrar.total } },
    { nombre: 'Por pagar', columnas: [{ h: 'Empresa', k: 'nombre', ancho: 28 }, { h: 'Vencido', k: 'vencido', tipo: L }, { h: 'Vence en 7 días', k: '0-7', tipo: L }, { h: '8-30 días', k: '8-30', tipo: L }, { h: 'Más de 30', k: '+30', tipo: L }, { h: 'Total', k: 'total', tipo: L }],
      filas: c.empresas.map((e) => fila(e, { ...e.pagar.buckets, total: e.pagar.total })), totales: { nombre: 'Total grupo', ...c.total.pagar.buckets, total: c.total.pagar.total } },
    { nombre: 'Presupuesto', columnas: [{ h: 'Empresa', k: 'nombre', ancho: 28 }, { h: 'Ventas presupuesto', k: 'vp', tipo: L }, { h: 'Ventas reales', k: 'vr', tipo: L }, { h: 'Gastos presupuesto', k: 'gp', tipo: L }, { h: 'Gastos reales', k: 'gr', tipo: L }],
      filas: c.empresas.map((e) => fila(e, { vp: e.presupuesto.ventas_presupuesto, vr: e.presupuesto.ventas_real, gp: e.presupuesto.gastos_presupuesto, gr: e.presupuesto.gastos_real })) },
    { nombre: 'Entre empresas', columnas: [{ h: 'Debe', k: 'deudor_nombre', ancho: 22 }, { h: 'A', k: 'acreedor_nombre', ancho: 22 }, { h: 'Saldo neto', k: 'saldo', tipo: L }, { h: 'Operaciones', k: 'operaciones', tipo: 'entero' }, { h: 'Sin conciliar', k: 'sin_conciliar', tipo: 'entero' }], filas: c.interco.saldos },
  ] };
}
