import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from './helpers.js';
import { calcularLinea, impuestoAnual, periodoDe, resumenContable, totalesDe, diasEntre } from '../src/modulos/planilla/calculo.js';

// Parámetros de arranque (los mismos que siembra la migración; el contador debe confirmarlos).
const P = {
  dias_mes: 30, horas_dia_diurna: 8, horas_dia_mixta: 7, horas_dia_nocturna: 6, he_diurna_pct: 25, he_nocturna_pct: 75, he_feriada_pct: 100,
  ihss_techo_mensual: 11903.13, ihss_em_empleado_pct: 2.5, ihss_em_patrono_pct: 5, ihss_ivm_empleado_pct: 2.5, ihss_ivm_patrono_pct: 3.5,
  rap_exento_mensual: 11903.13, rap_empleado_pct: 1.5, rap_patrono_pct: 1.5, infop_patrono_pct: 1, infop_empleado_pct: 0,
  isr_gastos_medicos: 40000, isr_deduce_ihss: 0, decimos_dias_base: 365, aguinaldo_mes_pago: 12, aguinaldo_dia_pago: 20, catorceavo_mes_pago: 6, catorceavo_dia_pago: 30, vacaciones_prima_pct: 0,
};
const TRAMOS = [{ desde: 0, tasa: 0 }, { desde: 217493.17, tasa: 15 }, { desde: 494224.41, tasa: 20 }, { desde: 771252.38, tasa: 25 }];
const emp = (o = {}) => ({ id: 'e1', nombres: 'Ana', apellidos: 'Pérez', identidad: '0501199900123', puesto: 'Cajera', sucursal: 'Mackey', salario_mensual: 20000, jornada: 'diurna', tipo_pago: 'mensual', fecha_ingreso: '2020-01-01', fecha_salida: null, estado: 'activo', ...o });
const quincena = periodoDe({ tipo: 'quincena', anio: 2026, mes: 10, quincena: 1 }, P);

test('periodos: quincenas, mes, aguinaldo y catorceavo', () => {
  assert.deepEqual([quincena.desde, quincena.hasta, quincena.fraccion], ['2026-10-01', '2026-10-15', 0.5]);
  const q2 = periodoDe({ tipo: 'quincena', anio: 2026, mes: 2, quincena: 2 }, P);
  assert.deepEqual([q2.desde, q2.hasta, q2.diasBase], ['2026-02-16', '2026-02-28', 15]);       // febrero: la quincena se paga completa
  const a = periodoDe({ tipo: 'aguinaldo', anio: 2026 }, P); assert.deepEqual([a.desde, a.hasta, a.pago], ['2026-01-01', '2026-12-31', '2026-12-20']);
  const c = periodoDe({ tipo: 'catorceavo', anio: 2026 }, P); assert.deepEqual([c.desde, c.hasta, c.pago], ['2025-07-01', '2026-06-30', '2026-06-30']);
  assert.equal(diasEntre('2026-01-01', '2026-12-31'), 365);
});

test('ISR: tabla progresiva por tramos, sin huecos de centavos', () => {
  assert.equal(impuestoAnual(200000, TRAMOS), 0);
  assert.equal(impuestoAnual(300000, TRAMOS), Math.round((300000 - 217493.16) * 0.15 * 100) / 100);
  const t = (494224.40 - 217493.16) * 0.15 + (600000 - 494224.40) * 0.20;
  assert.equal(impuestoAnual(600000, TRAMOS), Math.round(t * 100) / 100);
});

test('quincena de L 20,000: sueldo, IHSS con techo, RAP sobre el excedente, ISR en cero', () => {
  const { linea } = calcularLinea({ tipo: 'quincena', emp: emp(), P, tramos: TRAMOS, periodo: quincena });
  assert.equal(linea.devengado, 10000);
  assert.equal(linea.ihss, Math.round(11903.13 * 0.5 * 0.05 * 100) / 100);                 // techo proporcional a la quincena
  assert.equal(linea.rap, Math.round((10000 - 11903.13 * 0.5) * 0.015 * 100) / 100);
  assert.equal(linea.isr, 0);
  assert.equal(linea.infop, 0); assert.equal(linea.infop_patrono, 100);
  assert.equal(linea.neto, Math.round((10000 - linea.ihss - linea.rap) * 100) / 100);
});

test('horas extra con recargo, ausencias sin goce y bonos', () => {
  const { linea } = calcularLinea({
    tipo: 'quincena', emp: emp(), P, tramos: TRAMOS, periodo: quincena,
    novedades: [{ tipo: 'he_diurna', horas: 4 }, { tipo: 'he_nocturna', horas: 2 }, { tipo: 'he_feriada', horas: 1 }, { tipo: 'bono', monto: 500 }, { tipo: 'descuento', monto: 100, concepto: 'Uniforme' }],
    ausencias: [{ tipo: 'ausencia', desde: '2026-10-05', hasta: '2026-10-06', dias: 2 }, { tipo: 'tardanza', desde: '2026-10-07', hasta: '2026-10-07', dias: 0, minutos: 30 }],
  });
  const hora = 20000 / 30 / 8;
  assert.equal(linea.he_monto, Math.round((4 * hora * 1.25 + 2 * hora * 1.75 + 1 * hora * 2) * 100) / 100);
  assert.equal(linea.desc_ausencias, Math.round((2 * (20000 / 30) + 0.5 * hora) * 100) / 100);
  assert.equal(linea.bonos, 500); assert.equal(linea.otros_desc, 100);
  assert.equal(linea.total_ingresos, Math.round((10000 + linea.he_monto + 500) * 100) / 100);
  assert.equal(linea.neto, Math.round((linea.total_ingresos - linea.total_deducciones) * 100) / 100);
});

test('ISR retenido para un sueldo alto (L 40,000 al mes)', () => {
  const { linea } = calcularLinea({ tipo: 'mensual', emp: emp({ salario_mensual: 40000 }), P, tramos: TRAMOS, periodo: periodoDe({ tipo: 'mensual', anio: 2026, mes: 10 }, P) });
  const gravable = 40000 * 12 - 40000;
  assert.equal(linea.isr, Math.round((impuestoAnual(gravable, TRAMOS) / 12) * 100) / 100);
  assert.ok(linea.isr > 1000);
  assert.equal(linea.ihss, Math.round(11903.13 * 0.05 * 100) / 100);                          // se cotiza solo hasta el techo
});

test('ingreso y salida a mitad de periodo: se paga lo proporcional; el que ya no estaba, no entra', () => {
  const nuevo = calcularLinea({ tipo: 'quincena', emp: emp({ fecha_ingreso: '2026-10-08' }), P, tramos: TRAMOS, periodo: quincena });
  assert.equal(nuevo.linea.dias_pagados, 8);
  assert.equal(nuevo.linea.devengado, Math.round((20000 / 30) * 8 * 100) / 100);
  assert.ok(calcularLinea({ tipo: 'quincena', emp: emp({ fecha_salida: '2026-09-30' }), P, tramos: TRAMOS, periodo: quincena }).omitido);
  assert.ok(calcularLinea({ tipo: 'quincena', emp: emp({ salario_mensual: null }), P, tramos: TRAMOS, periodo: quincena }).omitido);
});

test('décimo tercer mes proporcional por antigüedad, catorceavo completo, y aviso si falta la fecha de ingreso', () => {
  const ag = periodoDe({ tipo: 'aguinaldo', anio: 2026 }, P);
  const full = calcularLinea({ tipo: 'aguinaldo', emp: emp(), P, tramos: TRAMOS, periodo: ag }).linea;
  assert.equal(full.devengado, 20000); assert.equal(full.isr, 0); assert.equal(full.ihss, 0);
  const medio = calcularLinea({ tipo: 'aguinaldo', emp: emp({ fecha_ingreso: '2026-07-01' }), P, tramos: TRAMOS, periodo: ag }).linea;
  assert.equal(medio.dias_pagados, 184); assert.equal(medio.devengado, Math.round((20000 * 184 / 365) * 100) / 100);
  const cat = calcularLinea({ tipo: 'catorceavo', emp: emp({ fecha_ingreso: '2025-07-01' }), P, tramos: TRAMOS, periodo: periodoDe({ tipo: 'catorceavo', anio: 2026 }, P) }).linea;
  assert.equal(cat.devengado, 20000);
  const sin = calcularLinea({ tipo: 'catorceavo', emp: emp({ fecha_ingreso: null }), P, tramos: TRAMOS, periodo: periodoDe({ tipo: 'catorceavo', anio: 2026 }, P) });
  assert.equal(sin.linea.devengado, 20000); assert.ok(sin.avisos.some((a) => /fecha de ingreso/.test(a)));
});

test('el resumen contable cuadra: gasto total = neto + retenciones + aportes por pagar', () => {
  const lineas = [emp(), emp({ id: 'e2', salario_mensual: 35000 })].map((e) => calcularLinea({
    tipo: 'quincena', emp: e, P, tramos: TRAMOS, periodo: quincena, novedades: [{ tipo: 'he_diurna', horas: 3 }, { tipo: 'bono', monto: 250 }] }).linea);
  const t = totalesDe(lineas);
  const c = resumenContable('quincena', t);
  assert.equal(c.total_gasto, c.total_por_pagar);
  assert.equal(c.total_gasto, t.costo_empresa);
});

// ── API ──────────────────────────────────────────────────────────────────────
let tt, dueno, ger, adminEmp, eid, e1, e2, gastoRows;
before(async () => {
  tt = await iniciar();
  eid = await tt.empresaId('origen');
  await tt.usuario({ nombre: 'Dueño', email: 'd@grupo.hn', password: 'ClaveSegura123', dueno: true });
  await tt.usuario({ nombre: 'Gerente', email: 'g@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  await tt.usuario({ nombre: 'Admin Origen', email: 'a@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'admin' }] });
  dueno = tt.cli(await tt.login('origen', 'd@grupo.hn', 'ClaveSegura123'), 'origen');
  ger = tt.cli(await tt.login('origen', 'g@origen.hn', 'ClaveSegura123'), 'origen');
  adminEmp = tt.cli(await tt.login('origen', 'a@origen.hn', 'ClaveSegura123'), 'origen');
  const alta = async (n, ap, sueldo, ingreso) => {
    const p = (await tt.db.query('insert into rrhh.personas (nombres, apellidos, identidad) values ($1,$2,$3) returning id', [n, ap, null])).rows[0].id;
    return (await tt.db.query(`insert into rrhh.empleados (persona_id, empresa_id, puesto, fecha_ingreso, salario_mensual) values ($1,$2,'Cajero',$3,$4) returning id`, [p, eid, ingreso, sueldo])).rows[0].id;
  };
  e1 = await alta('Luis', 'Mejía', 20000, '2020-03-01');
  e2 = await alta('Marta', 'Reyes', 14000, '2024-01-15');
  await alta('Sin Sueldo', 'Pendiente', null, '2025-01-01');
});
after(() => tt.cerrar());

test('seguridad: sin rrhh:sensible no se ve nada de planilla; el admin de empresa lee pero no cambia parámetros', async () => {
  assert.equal((await ger.get('/api/planilla/planillas')).status, 403);
  assert.equal((await ger.get('/api/planilla/parametros')).status, 403);
  assert.equal((await ger.post('/api/planilla/planillas', { tipo: 'mensual', anio: 2026, mes: 10 })).status, 403);
  const p = (await adminEmp.get('/api/planilla/parametros')).body;
  assert.equal(p.por_confirmar, true); assert.equal(p.puede_editar, false);
  assert.ok(p.parametros.every((x) => x.por_confirmar));
  assert.equal((await adminEmp.put('/api/planilla/parametros', { valores: { he_diurna_pct: 30 } })).status, 403);
});

test('parámetros: solo el dueño del grupo los edita, queda en bitácora y vuelven a «por confirmar»', async () => {
  assert.equal((await dueno.post('/api/planilla/parametros/confirmar', { contador: 'Lic. Pérez' })).status, 200);
  assert.equal((await dueno.get('/api/planilla/parametros')).body.por_confirmar, false);
  assert.equal((await dueno.put('/api/planilla/parametros', { valores: { he_diurna_pct: 30 } })).status, 200);
  const p = (await dueno.get('/api/planilla/parametros')).body;
  assert.equal(p.parametros.find((x) => x.clave === 'he_diurna_pct').valor, 30); assert.equal(p.por_confirmar, true);
  await dueno.put('/api/planilla/parametros', { valores: { he_diurna_pct: 25 } });
  assert.equal((await dueno.put('/api/planilla/parametros', { valores: { inventada: 1 } })).status, 400);
  assert.equal((await dueno.put('/api/planilla/isr-tramos', { tramos: [{ desde: 100, tasa: 5 }] })).status, 400);
  assert.ok((await tt.db.query(`select 1 from core.auditoria where accion in ('planilla.parametros_editados','planilla.parametros_confirmados')`)).rowCount >= 2);
});

test('flujo completo: novedades → planilla → aprobar (inalterable) → boletas PDF → Finanzas → pagar', async () => {
  await tt.db.query(`insert into rrhh.ausencias (empleado_id, empresa_id, tipo, desde, hasta, dias, pagado, estado) values ($1,$2,'ausencia','2026-10-05','2026-10-05',1,false,'aprobada')`, [e2, eid]);
  assert.equal((await dueno.post('/api/planilla/novedades', { empleado_id: e1, fecha: '2026-10-03', tipo: 'he_diurna', horas: 5, concepto: 'Cierre de mes' })).status, 201);
  assert.equal((await dueno.post('/api/planilla/novedades', { empleado_id: e2, fecha: '2026-10-10', tipo: 'bono', monto: 300 })).status, 201);
  assert.equal((await dueno.post('/api/planilla/novedades', { empleado_id: e1, fecha: '2026-10-10', tipo: 'bono' })).status, 400);          // falta el monto
  const crear = await dueno.post('/api/planilla/planillas', { tipo: 'quincena', anio: 2026, mes: 10, quincena: 1 });
  assert.equal(crear.status, 201);
  assert.equal((await dueno.post('/api/planilla/planillas', { tipo: 'quincena', anio: 2026, mes: 10, quincena: 1 })).status, 409);            // ya existe
  const d = (await dueno.get(`/api/planilla/planillas/${crear.body.id}`)).body;
  assert.equal(d.lineas.length, 2);                                                                                                           // el que no tiene sueldo no entra…
  assert.ok(d.advertencias.some((a) => /Sin Sueldo/.test(a.empleado)));                                                                      // …y se avisa
  assert.equal(d.por_confirmar, true);
  const l1 = d.lineas.find((l) => l.nombre.startsWith('Luis')), l2 = d.lineas.find((l) => l.nombre.startsWith('Marta'));
  assert.equal(l1.he_monto, Math.round(5 * (20000 / 30 / 8) * 1.25 * 100) / 100);
  assert.equal(l2.desc_ausencias, Math.round((14000 / 30) * 100) / 100); assert.equal(l2.bonos, 300);
  assert.equal(d.contable.total_gasto, d.contable.total_por_pagar);
  // aprobar
  assert.equal((await dueno.get(`/api/planilla/planillas/${crear.body.id}/boletas.pdf`)).status, 409);                                       // aún no
  const ap = await dueno.post(`/api/planilla/planillas/${crear.body.id}/aprobar`);
  assert.equal(ap.status, 200);
  assert.equal((await tt.db.query(`select count(*)::int as n from plan.novedades where estado = 'aplicada' and planilla_id = $1`, [crear.body.id])).rows[0].n, 2);
  await assert.rejects(() => tt.db.query(`update plan.planilla_lineas set neto = 1 where planilla_id = $1`, [crear.body.id]), /ya está aprobada/);
  assert.equal((await dueno.post(`/api/planilla/planillas/${crear.body.id}/recalcular`)).status, 409);
  assert.equal((await dueno.del(`/api/planilla/novedades/${(await tt.db.query('select id from plan.novedades limit 1')).rows[0].id}`)).status, 409);
  // boletas PDF (binario)
  const pdf = async (ruta, token) => { const r = await fetch(tt.base + ruta, { headers: { authorization: `Bearer ${token}`, 'x-empresa': 'origen' } }); return { status: r.status, tipo: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()) }; };
  const tokDueno = await tt.login('origen', 'd@grupo.hn', 'ClaveSegura123');
  const todas = await pdf(`/api/planilla/planillas/${crear.body.id}/boletas.pdf`, tokDueno);
  assert.equal(todas.status, 200); assert.equal(todas.tipo, 'application/pdf'); assert.equal(todas.buf.subarray(0, 5).toString(), '%PDF-');
  assert.match(todas.buf.toString('latin1'), /BOLETA DE PAGO/); assert.match(todas.buf.toString('latin1'), /Luis Mej/);
  const una = await pdf(`/api/planilla/planillas/${crear.body.id}/boleta/${e2}`, tokDueno);
  assert.equal(una.status, 200); assert.ok(!una.buf.toString('latin1').includes('Luis Mej')); assert.match(una.buf.toString('latin1'), /Marta Reyes/);
  const tokGer = await tt.login('origen', 'g@origen.hn', 'ClaveSegura123');
  assert.equal((await pdf(`/api/planilla/planillas/${crear.body.id}/boletas.pdf`, tokGer)).status, 403);
  // Finanzas: un gasto con el costo total de la empresa, una sola vez
  const f = await dueno.post(`/api/planilla/planillas/${crear.body.id}/finanzas`);
  assert.equal(f.status, 200); assert.equal(f.body.monto, d.contable.total_gasto);
  assert.equal((await dueno.post(`/api/planilla/planillas/${crear.body.id}/finanzas`)).status, 409);
  const g = (await tt.db.query('select * from fin.gastos where id = $1', [f.body.gasto_id])).rows[0];
  assert.equal(g.monto, d.contable.total_gasto); assert.equal(g.pagado, false);
  assert.equal((await dueno.post(`/api/planilla/planillas/${crear.body.id}/pagar`)).status, 200);
  assert.equal((await tt.db.query('select pagado from fin.gastos where id = $1', [f.body.gasto_id])).rows[0].pagado, true);
  assert.equal((await dueno.post(`/api/planilla/planillas/${crear.body.id}/anular`, { motivo: 'prueba' })).status, 409);       // pagada: no se anula
  const rc = (await dueno.get('/api/planilla/resumen-contable?anio=2026&mes=10')).body;
  assert.equal(rc.planillas.length, 1); assert.equal(rc.contable.total_gasto, rc.contable.total_por_pagar);
  assert.ok((await tt.db.query(`select 1 from core.auditoria where accion = 'planilla.aprobada'`)).rowCount === 1);
});

test('anular una planilla aprobada libera las novedades y permite rehacerla; décimos del año', async () => {
  const c = (await dueno.post('/api/planilla/planillas', { tipo: 'quincena', anio: 2026, mes: 11, quincena: 2 })).body;
  await dueno.post('/api/planilla/novedades', { empleado_id: e1, fecha: '2026-11-20', tipo: 'descuento', monto: 200, concepto: 'Préstamo' });
  assert.equal((await dueno.post(`/api/planilla/planillas/${c.id}/recalcular`)).status, 200);
  assert.equal((await dueno.post(`/api/planilla/planillas/${c.id}/aprobar`)).status, 200);
  assert.equal((await dueno.post(`/api/planilla/planillas/${c.id}/anular`, {})).status, 400);                                     // el motivo es obligatorio
  assert.equal((await dueno.post(`/api/planilla/planillas/${c.id}/anular`, { motivo: 'Faltó un bono' })).status, 200);
  assert.equal((await tt.db.query(`select estado from plan.novedades where concepto = 'Préstamo'`)).rows[0].estado, 'pendiente');
  assert.equal((await dueno.post('/api/planilla/planillas', { tipo: 'quincena', anio: 2026, mes: 11, quincena: 2 })).status, 201);
  const ag = (await dueno.post('/api/planilla/planillas', { tipo: 'aguinaldo', anio: 2026 })).body;
  const d = (await dueno.get(`/api/planilla/planillas/${ag.id}`)).body;
  assert.equal(ag.fecha_pago, '2026-12-20');
  assert.equal(d.lineas.find((l) => l.nombre.startsWith('Luis')).neto, 20000);
});
