import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { iniciar } from './helpers.js';
import { armarLinea, impuestoAnual, periodoDe, recalcularRenglon, resumenContable, totalesDe, agruparPorSucursal, diasEntre } from '../src/modulos/planilla/calculo.js';

// Parámetros de arranque (los mismos que siembra la migración; el contador debe confirmarlos). Datos de prueba INVENTADOS.
const P = {
  dias_mes: 30, quincena_dias: 15, semana_dias_pago: 6, semana_inicio_dia: 1, semana_dia_pago: 6, horas_dia_diurna: 8, horas_dia_mixta: 7, horas_dia_nocturna: 6,
  he_diurna_pct: 0, he_nocturna_pct: 0, he_feriada_pct: 0, salario_minimo_diario: 400, decimos_dias_pago: 30, decimos_dias_base: 365,
  aguinaldo_mes_pago: 12, aguinaldo_dia_pago: 20, catorceavo_mes_pago: 6, catorceavo_dia_pago: 30, aplicar_ley: 0,
  ihss_techo_mensual: 11903.13, ihss_em_empleado_pct: 2.5, ihss_em_patrono_pct: 5, ihss_ivm_empleado_pct: 2.5, ihss_ivm_patrono_pct: 3.5,
  rap_exento_mensual: 11903.13, rap_empleado_pct: 1.5, rap_patrono_pct: 1.5, infop_patrono_pct: 1, infop_empleado_pct: 0, isr_gastos_medicos: 40000, isr_deduce_ihss: 0,
};
const TRAMOS = [{ desde: 0, tasa: 0 }, { desde: 217493.17, tasa: 15 }, { desde: 494224.41, tasa: 20 }, { desde: 771252.38, tasa: 25 }];
const emp = (o = {}) => ({ id: 'e1', nombres: 'Ana', apellidos: 'Prueba', identidad: null, puesto: 'Cajera', sucursal: 'Tienda A', salario_mensual: 13200, jornada: 'diurna', fecha_ingreso: '2020-01-01', fecha_salida: null, estado: 'activo', cuenta_bancaria: '123456', ...o });
const q1 = periodoDe({ tipo: 'quincena', anio: 2026, mes: 8, quincena: 1 }, P);

test('periodos: quincena, semana (lunes-domingo), mes, aguinaldo y catorceavo', () => {
  assert.deepEqual([q1.desde, q1.hasta, q1.fraccion, q1.diasBase], ['2026-08-01', '2026-08-15', 0.5, 15]);
  const q2 = periodoDe({ tipo: 'quincena', anio: 2026, mes: 2, quincena: 2 }, P);
  assert.deepEqual([q2.desde, q2.hasta, q2.diasBase], ['2026-02-16', '2026-02-28', 15]);
  const s = periodoDe({ tipo: 'semanal', desde: '2026-10-05' }, P);                      // 5 oct 2026 es lunes
  assert.deepEqual([s.desde, s.hasta, s.diasBase, s.pago], ['2026-10-05', '2026-10-11', 6, '2026-10-10']);   // pago el sábado
  assert.match(periodoDe({ tipo: 'semanal', desde: '2026-10-06' }, P).error, /lunes/);
  assert.equal(periodoDe({ tipo: 'semanal', desde: '2026-10-05' }, { ...P, semana_dias_pago: 7 }).diasBase, 7);
  const a = periodoDe({ tipo: 'aguinaldo', anio: 2026 }, P); assert.deepEqual([a.desde, a.hasta, a.pago], ['2026-01-01', '2026-12-31', '2026-12-20']);
  const c = periodoDe({ tipo: 'catorceavo', anio: 2026 }, P); assert.deepEqual([c.desde, c.hasta], ['2025-07-01', '2026-06-30']);
  assert.equal(diasEntre('2026-01-01', '2026-12-31'), 365);
});

test('la hoja: 15 días × diario, por hora = diario ÷ 8, horas extra a tarifa normal, deducción y total', () => {
  const { linea } = armarLinea({ tipo: 'quincena', emp: emp(), P, periodo: q1, horasSugeridas: 0,
    novedades: [{ tipo: 'he_diurna', horas: 22 }], fijas: [{ concepto: 'IHSS', monto_mensual: 626 }] });
  assert.equal(linea.salario_diario, 440); assert.equal(linea.dias, 15); assert.equal(linea.total_quincenal, 6600);
  assert.equal(linea.por_hora, 55); assert.equal(linea.horas_extra, 22); assert.equal(linea.total_hx, 1210);
  assert.deepEqual(linea.deducciones.map((d) => [d.concepto, d.monto]), [['IHSS', 313]]);
  assert.equal(linea.total, 6600 + 1210 - 313);
});

test('empleado nuevo: días proporcionales; ausencias sin goce restan días; vacaciones se pagan', () => {
  const nuevo = armarLinea({ tipo: 'quincena', emp: emp({ fecha_ingreso: '2026-08-08' }), P, periodo: q1 }).linea;
  assert.equal(nuevo.dias, 8); assert.equal(nuevo.total_quincenal, 3520); assert.match(nuevo.observaciones, /nuevo/i);
  const aus = armarLinea({ tipo: 'quincena', emp: emp(), P, periodo: q1, ausencias: [{ tipo: 'ausencia', desde: '2026-08-05', hasta: '2026-08-06', dias: 2 }], vacaciones: [{ desde: '2026-08-10', hasta: '2026-08-12', dias: 3 }] }).linea;
  assert.equal(aus.dias, 13); assert.equal(aus.total_quincenal, 5720); assert.match(aus.observaciones, /Vacaciones pagadas: 3/);
  assert.ok(armarLinea({ tipo: 'quincena', emp: emp({ fecha_salida: '2026-07-31' }), P, periodo: q1 }).omitido);
  assert.ok(armarLinea({ tipo: 'quincena', emp: emp({ salario_mensual: null }), P, periodo: q1 }).omitido);
});

test('semana de 6 o 7 días según el parámetro; fija mensual se reparte en 12/52', () => {
  const s6 = periodoDe({ tipo: 'semanal', desde: '2026-10-05' }, P), s7 = periodoDe({ tipo: 'semanal', desde: '2026-10-05' }, { ...P, semana_dias_pago: 7 });
  assert.equal(armarLinea({ tipo: 'semanal', emp: emp(), P, periodo: s6 }).linea.total_quincenal, 2640);
  assert.equal(armarLinea({ tipo: 'semanal', emp: emp(), P: { ...P, semana_dias_pago: 7 }, periodo: s7 }).linea.total_quincenal, 3080);
  const f = armarLinea({ tipo: 'semanal', emp: emp(), P, periodo: s6, fijas: [{ concepto: 'Préstamo', monto_mensual: 520 }] }).linea;
  assert.equal(f.deducciones[0].monto, 120);
});

test('las deducciones de ley por porcentaje están APAGADAS salvo que se activen', () => {
  assert.equal(armarLinea({ tipo: 'quincena', emp: emp({ salario_mensual: 40000 }), P, tramos: TRAMOS, periodo: q1 }).linea.deducciones.length, 0);
  const on = armarLinea({ tipo: 'quincena', emp: emp({ salario_mensual: 40000 }), P: { ...P, aplicar_ley: 1 }, tramos: TRAMOS, periodo: q1 }).linea;
  assert.deepEqual(on.deducciones.map((d) => d.concepto), ['IHSS', 'RAP', 'ISR retenido']);
  assert.ok(on.aportes_patronales > 0); assert.ok(on.deducciones.every((d) => d.tipo === 'ley'));
  assert.equal(impuestoAnual(200000, TRAMOS), 0);
  assert.equal(impuestoAnual(300000, TRAMOS), Math.round((300000 - 217493.16) * 0.15 * 100) / 100);
});

test('aguinaldo: 30 días × diario con el año completo; proporcional por antigüedad; aviso sin fecha', () => {
  const ag = periodoDe({ tipo: 'aguinaldo', anio: 2026 }, P);
  const full = armarLinea({ tipo: 'aguinaldo', emp: emp(), P, periodo: ag }).linea;
  assert.equal(full.dias, 30); assert.equal(full.total, 13200);
  const medio = armarLinea({ tipo: 'aguinaldo', emp: emp({ fecha_ingreso: '2026-07-01' }), P, periodo: ag }).linea;
  assert.equal(medio.dias, Math.round(30 * 184 / 365 * 100) / 100); assert.equal(medio.total, Math.round(medio.dias * 440 * 100) / 100);
  const sin = armarLinea({ tipo: 'catorceavo', emp: emp({ fecha_ingreso: null }), P, periodo: periodoDe({ tipo: 'catorceavo', anio: 2026 }, P) });
  assert.equal(sin.linea.dias, 30); assert.ok(sin.avisos.some((a) => /fecha de ingreso/.test(a)));
});

test('corregir una celda recalcula; totales por sucursal y resumen contable cuadran', () => {
  const a = armarLinea({ tipo: 'quincena', emp: emp(), P, periodo: q1, fijas: [{ concepto: 'IHSS', monto_mensual: 626 }] }).linea;
  const b = armarLinea({ tipo: 'quincena', emp: emp({ id: 'e2', sucursal: 'Tienda B', salario_mensual: 15000 }), P, periodo: q1, novedades: [{ tipo: 'bono', monto: 200, concepto: 'Meta' }, { tipo: 'descuento', monto: 150, concepto: 'Anticipo' }] }).linea;
  const editada = recalcularRenglon({ ...a, dias: 14 });
  assert.equal(editada.total_quincenal, 6160); assert.equal(editada.total, 6160 - 313);
  const lineas = [editada, b];
  const g = agruparPorSucursal(lineas);
  assert.deepEqual(g.map((x) => x.sucursal), ['Tienda A', 'Tienda B']);
  const t = totalesDe(lineas);
  assert.equal(t.total, Math.round((g[0].totales.total + g[1].totales.total) * 100) / 100);
  assert.deepEqual(t.por_concepto, { IHSS: 313, Anticipo: 150 });
  const c = resumenContable('quincena', t);
  assert.equal(c.total_gasto, c.total_por_pagar);
});

// ── API ──────────────────────────────────────────────────────────────────────
let tt, dueno, ger, adminEmp, eid, e1, e2, e3, ecoId;
const tok = {};
before(async () => {
  tt = await iniciar();
  eid = await tt.empresaId('origen'); ecoId = await tt.empresaId('ecostone');
  await tt.usuario({ nombre: 'Dueño', email: 'd@grupo.hn', password: 'ClaveSegura123', dueno: true });
  await tt.usuario({ nombre: 'Gerente', email: 'g@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  await tt.usuario({ nombre: 'Admin Origen', email: 'a@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'admin' }] });
  tok.dueno = await tt.login('origen', 'd@grupo.hn', 'ClaveSegura123');
  tok.ger = await tt.login('origen', 'g@origen.hn', 'ClaveSegura123');
  dueno = tt.cli(tok.dueno, 'origen'); ger = tt.cli(tok.ger, 'origen'); adminEmp = tt.cli(await tt.login('origen', 'a@origen.hn', 'ClaveSegura123'), 'origen');
  const alta = async (empresa, n, ap, sueldo, ingreso, cuenta = null) => {
    const p = (await tt.db.query('insert into rrhh.personas (nombres, apellidos, cuenta_bancaria) values ($1,$2,$3) returning id', [n, ap, cuenta])).rows[0].id;
    return (await tt.db.query(`insert into rrhh.empleados (persona_id, empresa_id, puesto, fecha_ingreso, salario_mensual) values ($1,$2,'Cajero',$3,$4) returning id`, [p, empresa, ingreso, sueldo])).rows[0].id;
  };
  e1 = await alta(eid, 'Luis', 'Inventado', 13200, '2020-03-01', '000111');
  e2 = await alta(eid, 'Marta', 'Ficticia', 9000, '2024-01-15');
  await alta(eid, 'Sin', 'Sueldo', null, '2025-01-01');
  e3 = await alta(ecoId, 'Pedro', 'Semanal', 12000, '2023-01-01', '000222');
  await alta(ecoId, 'Rosa', 'Quincenal', 15000, '2023-01-01', '000333');
});
after(() => tt.cerrar());

const bin = async (ruta, token, empresa = 'origen') => { const r = await fetch(tt.base + ruta, { headers: { authorization: `Bearer ${token}`, 'x-empresa': empresa } }); return { status: r.status, tipo: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()) }; };

test('seguridad: sin rrhh:sensible no se ve nada; el administrador lee pero no cambia parámetros', async () => {
  assert.equal((await ger.get('/api/planilla/planillas')).status, 403);
  assert.equal((await ger.get('/api/planilla/parametros')).status, 403);
  assert.equal((await ger.post('/api/planilla/planillas', { tipo: 'quincena', anio: 2026, mes: 8, quincena: 1 })).status, 403);
  const p = (await adminEmp.get('/api/planilla/parametros')).body;
  assert.equal(p.por_confirmar, true); assert.equal(p.puede_editar, false); assert.ok(p.parametros.every((x) => x.por_confirmar));
  assert.equal(p.parametros.find((x) => x.clave === 'aplicar_ley').valor, 0);
  assert.equal((await adminEmp.put('/api/planilla/parametros', { valores: { he_diurna_pct: 25 } })).status, 403);
  assert.equal((await adminEmp.get('/api/planilla/grupo')).status, 403);
});

test('parámetros: solo el dueño los edita, quedan en bitácora y vuelven a «por confirmar»', async () => {
  assert.equal((await dueno.post('/api/planilla/parametros/confirmar', { contador: 'Lic. Inventado' })).status, 200);
  assert.equal((await dueno.get('/api/planilla/parametros')).body.por_confirmar, false);
  assert.equal((await dueno.put('/api/planilla/parametros', { valores: { he_diurna_pct: 25 } })).status, 200);
  assert.equal((await dueno.get('/api/planilla/parametros')).body.por_confirmar, true);
  await dueno.put('/api/planilla/parametros', { valores: { he_diurna_pct: 0 } });
  assert.equal((await dueno.put('/api/planilla/parametros', { valores: { inventada: 1 } })).status, 400);
  assert.equal((await dueno.put('/api/planilla/isr-tramos', { tramos: [{ desde: 100, tasa: 5 }] })).status, 400);
  assert.ok((await tt.db.query(`select 1 from core.auditoria where accion in ('planilla.parametros_editados','planilla.parametros_confirmados')`)).rowCount >= 2);
});

test('flujo: pre-llenado desde RRHH → editar celdas → aprobar (inalterable) → Excel y boletas → Finanzas → pagar', async () => {
  await tt.db.query(`insert into rrhh.ausencias (empleado_id, empresa_id, tipo, desde, hasta, dias, pagado, estado) values ($1,$2,'ausencia','2026-08-05','2026-08-05',1,false,'aprobada')`, [e2, eid]);
  await dueno.post('/api/planilla/fijas', { empleado_id: e1, concepto: 'IHSS', monto_mensual: 626 });
  await dueno.post('/api/planilla/novedades', { empleado_id: e1, fecha: '2026-08-03', tipo: 'he_diurna', horas: 10 });
  await dueno.post('/api/planilla/novedades', { empleado_id: e2, fecha: '2026-08-04', tipo: 'descuento', monto: 150, concepto: 'Anticipo' });
  const crear = await dueno.post('/api/planilla/planillas', { tipo: 'quincena', anio: 2026, mes: 8, quincena: 1 });
  assert.equal(crear.status, 201);
  assert.equal((await dueno.post('/api/planilla/planillas', { tipo: 'quincena', anio: 2026, mes: 8, quincena: 1 })).status, 409);
  const id = crear.body.id;
  let d = (await dueno.get(`/api/planilla/planillas/${id}`)).body;
  assert.equal(d.lineas.length, 2);
  assert.ok(d.advertencias.some((a) => /Sin Sueldo/.test(a.empleado)));
  assert.ok(d.advertencias.some((a) => /cuenta/.test(a.mensaje)));
  const l1 = d.lineas.find((l) => l.nombre.startsWith('Luis')), l2 = d.lineas.find((l) => l.nombre.startsWith('Marta'));
  assert.equal(l1.total_quincenal, 6600); assert.equal(l1.total_hx, 550); assert.equal(l1.total, 6600 + 550 - 313);
  assert.equal(l2.dias, 14); assert.equal(l2.total, 14 * 300 - 150);
  assert.equal(d.control.cuadra, true); assert.equal(d.control.sin_cuenta, 1);
  // corregir celdas a mano: se marca editado, se recalcula y se conserva al recalcular
  const ed = await dueno.patch(`/api/planilla/planillas/${id}/lineas/${l2.id}`, { dias: 15, cuenta: '999888', observaciones: 'Se le pagó el día', deducciones: [{ concepto: 'Anticipo', monto: 200 }] });
  assert.equal(ed.status, 200); assert.equal(ed.body.total, 15 * 300 - 200);
  assert.equal((await dueno.patch(`/api/planilla/planillas/${id}/lineas/${l2.id}`, { deducciones: [{ concepto: 'Anticipo', monto: 99999 }] })).status, 400);   // total negativo
  await dueno.post(`/api/planilla/planillas/${id}/recalcular`);
  d = (await dueno.get(`/api/planilla/planillas/${id}`)).body;
  assert.equal(d.lineas.find((l) => l.id === l2.id).total, 4300); assert.equal(d.lineas.find((l) => l.id === l2.id).editado, true);
  assert.equal(d.grupos.length, 1);
  assert.equal((await bin(`/api/planilla/planillas/${id}/boletas.pdf`, tok.dueno)).status, 409);          // aún no aprobada
  // aprobar
  assert.equal((await dueno.post(`/api/planilla/planillas/${id}/aprobar`)).status, 200);
  await assert.rejects(() => tt.db.query(`update plan.planilla_lineas set total = 1 where planilla_id = $1`, [id]), /ya está aprobada/);
  assert.equal((await dueno.patch(`/api/planilla/planillas/${id}/lineas/${l2.id}`, { dias: 10 })).status, 409);
  assert.equal((await dueno.post(`/api/planilla/planillas/${id}/recalcular`)).status, 409);
  // Excel con el diseño de la hoja y rango de fechas correcto
  const xl = await bin(`/api/planilla/planillas/${id}/excel`, tok.dueno);
  assert.equal(xl.status, 200);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xl.buf);
  const ws = wb.worksheets[0];
  assert.match(String(ws.getCell('A2').value), /01\/08\/2026 AL 15\/08\/2026/);
  assert.deepEqual(['Empleado', 'DIAS', 'SALARIO DIARIO', 'TOTAL QUINCENAL', 'POR HORA', 'HORAS EXTRAS', 'TOTAL HX', 'deducciones', 'TOTAL', 'Numeros de cuenta', 'OBSERVACIONES'].map((_, i) => ws.getRow(5).getCell(i + 1).value),
    ['Empleado', 'DIAS', 'SALARIO DIARIO', 'TOTAL QUINCENAL', 'POR HORA', 'HORAS EXTRAS', 'TOTAL HX', 'deducciones', 'TOTAL', 'Numeros de cuenta', 'OBSERVACIONES']);
  assert.equal(ws.getCell('D7').value.formula, 'B7*C7');
  // boletas PDF
  const todas = await bin(`/api/planilla/planillas/${id}/boletas.pdf`, tok.dueno);
  assert.equal(todas.tipo, 'application/pdf'); assert.equal(todas.buf.subarray(0, 5).toString(), '%PDF-');
  assert.match(todas.buf.toString('latin1'), /BOLETA DE PAGO/); assert.match(todas.buf.toString('latin1'), /2026-08-01 al 2026-08-15/);
  const una = await bin(`/api/planilla/planillas/${id}/boleta/${l2.empleado_id}`, tok.dueno);
  assert.match(una.buf.toString('latin1'), /Marta Ficticia/); assert.ok(!una.buf.toString('latin1').includes('Luis Inventado'));
  assert.equal((await bin(`/api/planilla/planillas/${id}/boletas.pdf`, tok.ger)).status, 403);
  // Finanzas y pago
  const f = await dueno.post(`/api/planilla/planillas/${id}/finanzas`);
  assert.equal(f.status, 200); assert.equal(f.body.monto, d.totales.costo_empresa);
  assert.equal((await dueno.post(`/api/planilla/planillas/${id}/finanzas`)).status, 409);
  assert.equal((await dueno.post(`/api/planilla/planillas/${id}/pagar`)).status, 200);
  assert.equal((await dueno.post(`/api/planilla/planillas/${id}/reabrir`, { motivo: 'Se equivocaron' })).status, 409);       // pagada: no se reabre
  const rc = (await dueno.get('/api/planilla/resumen-contable?anio=2026&mes=8')).body;
  assert.equal(rc.contable.total_gasto, rc.contable.total_por_pagar);
});

test('reabrir: solo el dueño del grupo, con motivo; queda en el historial y la bitácora', async () => {
  const c = (await dueno.post('/api/planilla/planillas', { tipo: 'quincena', anio: 2026, mes: 8, quincena: 2 })).body;
  assert.equal((await dueno.post(`/api/planilla/planillas/${c.id}/aprobar`)).status, 200);
  assert.equal((await adminEmp.post(`/api/planilla/planillas/${c.id}/reabrir`, { motivo: 'Faltó un bono' })).status, 403);
  assert.equal((await dueno.post(`/api/planilla/planillas/${c.id}/reabrir`, { motivo: 'x' })).status, 400);
  assert.equal((await dueno.post(`/api/planilla/planillas/${c.id}/reabrir`, { motivo: 'Faltó un bono' })).status, 200);
  const d = (await dueno.get(`/api/planilla/planillas/${c.id}`)).body;
  assert.equal(d.estado, 'borrador'); assert.equal(d.reaperturas.length, 1); assert.equal(d.reaperturas[0].motivo, 'Faltó un bono');
  assert.equal((await tt.db.query(`select 1 from core.auditoria where accion = 'planilla.reabierta'`)).rowCount, 1);
  assert.equal((await dueno.post(`/api/planilla/planillas/${c.id}/anular`, { motivo: 'prueba' })).status, 200);
});

test('periodicidad: EcoStone genera semanal y quincenal en el mismo mes sin mezclar empleados', async () => {
  const eco = tt.cli(tok.dueno, 'ecostone');
  const cfg = (await eco.get('/api/planilla/config')).body;
  assert.equal(cfg.periodicidad_empresa, 'semanal');
  assert.equal((await dueno.get('/api/planilla/config')).body.periodicidad_empresa, 'quincena');
  assert.equal((await eco.put(`/api/planilla/empleados/${cfg.empleados.find((e) => e.nombre.startsWith('Rosa')).id}/periodicidad`, { periodicidad: 'quincena' })).status, 200);
  assert.equal((await eco.post('/api/planilla/planillas', { tipo: 'semanal', desde: '2026-10-06' })).status, 400);          // martes: la semana empieza en lunes
  const sem = await eco.post('/api/planilla/planillas', { tipo: 'semanal', desde: '2026-10-05' });
  assert.equal(sem.status, 201); assert.equal(sem.body.fecha_pago, '2026-10-10');
  const qui = await eco.post('/api/planilla/planillas', { tipo: 'quincena', anio: 2026, mes: 10, quincena: 1 });
  assert.equal(qui.status, 201);
  const ds = (await eco.get(`/api/planilla/planillas/${sem.body.id}`)).body, dq = (await eco.get(`/api/planilla/planillas/${qui.body.id}`)).body;
  assert.deepEqual(ds.lineas.map((l) => l.nombre), ['Pedro Semanal']); assert.equal(ds.lineas[0].dias, 6); assert.equal(ds.lineas[0].total_quincenal, 2400);
  assert.deepEqual(dq.lineas.map((l) => l.nombre), ['Rosa Quincenal']); assert.equal(dq.lineas[0].dias, 15);
  const xl = await bin(`/api/planilla/planillas/${sem.body.id}/excel`, tok.dueno, 'ecostone');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xl.buf);
  assert.match(String(wb.worksheets[0].getCell('A2').value), /05\/10\/2026 AL 11\/10\/2026/);
  // el consolidado del grupo las muestra juntas
  const g = (await dueno.get('/api/planilla/grupo?anio=2026&mes=10')).body;
  assert.equal(g.empresas.find((e) => e.codigo === 'ecostone').planillas.length, 2);
  void e3;
});

test('aguinaldo del año y bloqueo de planillas duplicadas', async () => {
  const ag = (await dueno.post('/api/planilla/planillas', { tipo: 'aguinaldo', anio: 2026 })).body;
  const d = (await dueno.get(`/api/planilla/planillas/${ag.id}`)).body;
  assert.equal(ag.fecha_pago, '2026-12-20');
  assert.equal(d.lineas.find((l) => l.nombre.startsWith('Luis')).total, 13200);
  assert.equal((await dueno.post('/api/planilla/planillas', { tipo: 'aguinaldo', anio: 2026 })).status, 409);
});
