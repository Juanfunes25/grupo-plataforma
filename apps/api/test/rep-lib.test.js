// Pruebas de los cálculos de reposición portados del original (rotación, recomendación de despacho,
// gerente digital, normalización de sabores…). Viven junto al código en src/modulos/rep/lib; este
// archivo solo las agrupa para que `npm test` las corra.
const pruebas = [
  'asistencia', 'avisos', 'fechaNegocio', 'insumosDespachados', 'normalizarSabor', 'pesoDesdeNombre', 'rangoFechas',
  'recomendacionDespacho', 'reporteAsistencia', 'reposicion', 'rotacion', 'vacaciones',
  'gerente/auditoria', 'gerente/cobertura', 'gerente/negocioSano', 'gerente/simulador',
  'gerente/verif/despachos', 'gerente/verif/fabrica', 'gerente/verif/inventario', 'gerente/verif/personal', 'gerente/verif/pesajes', 'gerente/verif/sistema',
];
for (const p of pruebas) await import(`../src/modulos/rep/lib/${p}.test.js`);
