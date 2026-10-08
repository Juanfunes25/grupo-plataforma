import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fechaHN, sumarDias } from '@grupo/shared';
import { iniciar } from './helpers.js';

const HOY = fechaHN(), ANIO = Number(HOY.slice(0, 4));
import { sembrar } from '../src/db/sembrar.js';
import { calcularVacaciones, contarDias, diasLey, sumarMeses } from '../src/modulos/rrhh/vacaciones.js';
import { asistenciaDiaria, turnosDeMarcaciones, verificarUbicacion } from '../src/modulos/rrhh/horas.js';
import { identidadValida } from '../src/modulos/rrhh/comun.js';
import { proximaFecha } from '../src/modulos/rrhh/consultas.js';

let t, dueno, admin, gerente, caja, contador, enItalo, ger, sucO;
before(async () => {
  t = await iniciar();
  await sembrar(t.db, t.config.semillas, 'origen');
  await t.usuario({ nombre: 'Dueño', email: 'dueno@grupo.hn', password: 'ClaveSegura123', dueno: true });
  await t.usuario({ nombre: 'Admin', email: 'admin@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'admin' }] });
  await t.usuario({ nombre: 'Gerente', email: 'ger@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Conta', email: 'conta@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'contador' }] });
  await t.usuario({ nombre: 'Cajera', accesos: [{ empresa: 'origen', rol: 'cajero', pin: '1234' }] });
  const tok = await t.login('origen', 'dueno@grupo.hn', 'ClaveSegura123');
  dueno = t.cli(tok, 'origen'); enItalo = t.cli(tok, 'italo');
  admin = t.cli(await t.login('origen', 'admin@origen.hn', 'ClaveSegura123'), 'origen');
  gerente = t.cli(await t.login('origen', 'ger@origen.hn', 'ClaveSegura123'), 'origen');
  contador = t.cli(await t.login('origen', 'conta@origen.hn', 'ClaveSegura123'), 'origen');
  caja = t.cli(await t.loginPin('origen', '1234'), 'origen');
  ger = gerente;
  sucO = (await caja.get('/api/pos/catalogo')).body.sucursales[0].id;
});
after(() => t.cerrar());

test('vacaciones por antigüedad: 10, 12, 15 y 20 días según la ley', () => {
  assert.deepEqual([1, 2, 3, 4, 7].map(diasLey), [10, 12, 15, 20, 20]);
  const v = (ingreso, hoy, tomadas = []) => calcularVacaciones({ ingreso, hoy, tomadas });
  assert.equal(v('2026-03-01', '2026-10-01').ganados, 0);                 // aún no cumple el año
  assert.equal(v('2025-10-01', '2026-10-01').ganados, 10);
  assert.equal(v('2024-10-01', '2026-10-01').ganados, 22);                // 10 + 12
  assert.equal(v('2023-10-01', '2026-10-01').ganados, 37);                // 10 + 12 + 15
  assert.equal(v('2022-10-01', '2026-10-01').ganados, 57);                // + 20
  const c = v('2023-10-01', '2026-10-01', [{ dias: 12, estado: 'tomada' }, { dias: 5, estado: 'aprobada' }, { dias: 9, estado: 'solicitada' }]);
  assert.equal(c.tomados, 17); assert.equal(c.pendientes, 20); assert.equal(c.solicitados, 9);
  assert.equal(c.periodos[0].pendientes, 0);                               // se gasta el período más antiguo primero
  assert.equal(c.periodos[1].tomados, 7);
  assert.equal(v('2020-02-29', '2021-02-28').ganados, 10);                // 29 feb → cumple el año el 28 feb
  assert.equal(v(null, '2026-10-01').sin_fecha_ingreso, true);
  // por vencer / vencido: el período 1 se ganó el 2025-10-01 y vence 12 meses después
  assert.equal(v('2024-10-15', '2026-11-01').periodos[0].estado, 'vencido');
  assert.equal(v('2025-10-15', '2026-10-20').periodos[0].estado, 'vigente');
  assert.equal(v('2024-12-01', '2026-10-20').periodos[0].estado, 'por_vencer');
  assert.equal(sumarMeses('2024-01-31', 1), '2024-02-29');
  assert.equal(contarDias('2026-10-05', '2026-10-11'), 6);                 // lun–dom sin domingo
  assert.equal(contarDias('2026-10-05', '2026-10-11', 'corridos'), 7);
});

test('identidad hondureña, ubicación y turnos nocturnos', () => {
  assert.ok(identidadValida('0501-1990-12345')); assert.ok(!identidadValida('0501-1990-1234')); assert.ok(!identidadValida('9901-1990-12345'));
  const geo = { lat: 15.5, lon: -88.03, radio_metros: 150 };
  assert.equal(verificarUbicacion({ geo, lat: 15.5001, lon: -88.03 }).verificacion, 'dentro');
  assert.equal(verificarUbicacion({ geo, lat: 15.6, lon: -88.03 }).verificacion, 'lejos');
  assert.equal(verificarUbicacion({ geo, lat: null, lon: null }).verificacion, 'sin_ubicacion');
  assert.equal(verificarUbicacion({ geo: null, lat: 1, lon: 1 }).verificacion, 'sin_configurar');
  const ts = turnosDeMarcaciones([{ tipo: 'entrada', marcada_at: '2026-10-01T20:00:00Z' }, { tipo: 'salida', marcada_at: '2026-10-02T04:30:00Z' }, { tipo: 'entrada', marcada_at: '2026-10-03T14:00:00Z' }]);
  assert.equal(ts[0].horas, 8.5); assert.equal(ts[0].fecha, '2026-10-01'); assert.equal(ts[1].incompleto, true);
  const a = asistenciaDiaria({ desde: '2026-10-05', hasta: '2026-10-06', marcaciones: [{ tipo: 'entrada', marcada_at: '2026-10-05T16:30:00Z' }, { tipo: 'salida', marcada_at: '2026-10-06T00:30:00Z' }],
    horarios: [{ dia_semana: 1, estado: 'turno', entrada: '10:00', salida: '18:00' }] });
  assert.equal(a.dias[0].tarde_min, 20); assert.equal(a.totales.horas, 8);
  assert.equal(proximaFecha('1990-10-10', '2026-10-08', 30).en_dias, 2);
});

let emp;
test('perfil: alta completa, validación de identidad y datos sensibles ocultos', async () => {
  assert.equal((await dueno.post('/api/rrhh/empleados', { nombres: 'Mala', puesto: 'X1', identidad: '1234' })).status, 400);
  const r = await dueno.post('/api/rrhh/empleados', {
    nombres: 'Ana', apellidos: 'Reyes', identidad: '0501-1995-04321', rtn: '05011995043210', fecha_nacimiento: '1995-01-12', sexo: 'F', estado_civil: 'soltero',
    telefono: '9988-7766', whatsapp: '9988-7766', correo: 'ana@correo.hn', puesto: 'Cajera', departamento: 'Ventas', sucursal_id: sucO, fecha_ingreso: `${ANIO - 3}-01-01`,
    tipo_contrato: 'plazo_fijo', fecha_fin_contrato: sumarDias(HOY, 40), tipo_pago: 'quincenal', salario_mensual: 9000, banco: 'Atlántida', tipo_cuenta: 'ahorro', cuenta_bancaria: '1234567890',
    ihss_numero: '77', emergencia_nombre: 'Luis Reyes', emergencia_telefono: '9911-2233', talla_camisa: 'M' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  emp = r.body;
  const f = (await dueno.get(`/api/rrhh/empleados/${emp.id}/ficha`)).body;
  assert.equal(f.persona.identidad, '0501199504321'); assert.equal(f.empleado.salario_mensual, 9000); assert.equal(f.persona.cuenta_bancaria, '1234567890');
  assert.ok(f.empleado.antiguedad_meses >= 36 && f.empleado.antiguedad_meses < 48); assert.equal(f.empleado.edad, ANIO - 1995);
  assert.equal(f.vacaciones.resumen.ganados, 37);
  assert.ok(f.salarios.length === 1 && f.historial[0].tipo === 'ingreso');
  // el gerente ve la ficha pero sin salario, identidad ni cuenta
  const g = (await gerente.get(`/api/rrhh/empleados/${emp.id}/ficha`)).body;
  assert.equal(g.empleado.salario_mensual, null); assert.equal(g.persona.cuenta_bancaria, null); assert.equal(g.salarios, null);
  assert.equal(g.persona.identidad, null); assert.match(g.persona.identidad_formato, /^\*\*\*\*-\*\*\*\*-\*4321$/);
  assert.equal(g.permisos.sensible, false);
  const lista = (await gerente.get('/api/rrhh/empleados')).body.find((x) => x.id === emp.id);
  assert.equal(lista.salario_mensual, null); assert.match(lista.identidad, /\*\*\*\*/);
  assert.equal((await contador.get(`/api/rrhh/empleados/${emp.id}/ficha`)).status, 403);
});

test('edición: salario solo con permiso sensible, historial y bitácora con antes/después', async () => {
  // administrador (rol admin) sí tiene rrhh:sensible; el gerente ni siquiera edita
  assert.equal((await gerente.put(`/api/rrhh/empleados/${emp.id}`, { puesto: 'Jefa' })).status, 403);
  const r = await admin.put(`/api/rrhh/empleados/${emp.id}`, { salario_mensual: 10500, motivo_salario: 'Aumento anual', puesto: 'Cajera principal', telefono: '9900-1122' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const f = (await admin.get(`/api/rrhh/empleados/${emp.id}/ficha`)).body;
  assert.equal(f.salarios[0].salario_anterior, 9000); assert.equal(f.salarios[0].salario_nuevo, 10500);
  assert.ok(f.historial.some((h) => h.tipo === 'cambio_puesto')); assert.ok(f.historial.some((h) => h.tipo === 'cambio_salario'));
  const bit = (await t.db.query(`select detalle from core.auditoria where accion = 'empleado_editado' and entidad_id = $1 order by id desc limit 1`, [emp.id])).rows[0].detalle;
  assert.equal(bit.cambios.puesto.antes, 'Cajera'); assert.equal(bit.cambios.puesto.despues, 'Cajera principal');
  assert.equal(bit.cambios.telefono.antes, '9988-7766');
  assert.equal(JSON.stringify(bit).includes('10500'), false);              // el salario nunca va a la bitácora
});

test('baja y suspensión exigen motivo; reingreso queda en el historial', async () => {
  const e = (await dueno.post('/api/rrhh/empleados', { nombres: 'Luis', apellidos: 'Mejía', puesto: 'Bodeguero', fecha_ingreso: '2025-01-10' })).body;
  assert.equal((await dueno.put(`/api/rrhh/empleados/${e.id}`, { estado: 'suspendido' })).status, 400);
  assert.equal((await dueno.put(`/api/rrhh/empleados/${e.id}`, { estado: 'suspendido', motivo_estado: 'Investigación interna' })).status, 200);
  assert.equal((await dueno.put(`/api/rrhh/empleados/${e.id}`, { estado: 'baja', motivo_estado: 'Renunció', tipo_baja: 'renuncia', fecha_salida: '2026-09-30' })).status, 200);
  const f = (await dueno.get(`/api/rrhh/empleados/${e.id}/ficha`)).body;
  assert.equal(f.empleado.estado, 'baja'); assert.equal(f.empleado.fecha_salida, '2026-09-30'); assert.equal(f.empleado.tipo_baja, 'renuncia');
  assert.deepEqual(f.historial.map((h) => h.tipo).slice(0, 2), ['baja', 'suspension']);
  assert.equal((await dueno.post('/api/rrhh/vacaciones', { empleado_id: e.id, desde: '2026-12-01', hasta: '2026-12-05' })).status, 400);
});

test('vacaciones: saldo, adelanto confirmado, cruces y aprobación', async () => {
  const sol = await dueno.post('/api/rrhh/vacaciones', { empleado_id: emp.id, desde: '2026-12-01', hasta: '2026-12-12' });   // 11 días (lun-sáb)
  assert.equal(sol.status, 201, JSON.stringify(sol.body)); assert.equal(sol.body.dias, 11);
  assert.equal((await dueno.post('/api/rrhh/vacaciones', { empleado_id: emp.id, desde: '2026-12-10', hasta: '2026-12-15' })).status, 409);   // se cruza
  assert.equal((await dueno.put(`/api/rrhh/vacaciones/${sol.body.id}`, { estado: 'aprobada' })).status, 200);
  const ya = await dueno.post('/api/rrhh/vacaciones', { empleado_id: emp.id, desde: '2027-02-01', hasta: '2027-03-31' });       // > saldo
  assert.equal(ya.status, 409); assert.equal(ya.body.codigo, 'saldo_insuficiente');
  assert.equal((await dueno.post('/api/rrhh/vacaciones', { empleado_id: emp.id, desde: '2027-02-01', hasta: '2027-03-31', forzar: true, estado: 'aprobada' })).status, 201);
  const f = (await dueno.get(`/api/rrhh/empleados/${emp.id}/ficha`)).body;
  assert.equal(f.vacaciones.resumen.tomados, 11 + 51);
  assert.equal((await dueno.put(`/api/rrhh/vacaciones/${f.vacaciones.lista[0].id}`, { estado: 'rechazada' })).status, 400);       // pide motivo
});

test('ausencias, permisos, incapacidades y contadores por año', async () => {
  const mk = (b) => dueno.post(`/api/rrhh/empleados/${emp.id}/ausencias`, b);
  assert.equal((await mk({ tipo: 'dia_libre', desde: '2026-03-02', hasta: '2026-03-02', motivo: 'Trámite' })).status, 201);
  assert.equal((await mk({ tipo: 'permiso', desde: '2026-04-06', hasta: '2026-04-07', motivo: 'Médico', pagado: true })).status, 201);
  assert.equal((await mk({ tipo: 'ausencia', desde: '2026-05-04', hasta: '2026-05-04' })).body.pagado, false);
  const inc = await mk({ tipo: 'incapacidad', subtipo: 'IHSS', desde: '2026-06-01', hasta: '2026-06-05' });
  assert.equal(inc.body.dias, 5);
  assert.equal((await mk({ tipo: 'tardanza', desde: '2026-06-10' })).status, 400);
  assert.equal((await mk({ tipo: 'tardanza', desde: '2026-06-10', minutos: 25 })).status, 201);
  assert.equal((await mk({ tipo: 'permiso', desde: '2025-01-10', hasta: '2025-01-10' })).status, 201);
  const c = (await dueno.get(`/api/rrhh/empleados/${emp.id}/ficha`)).body.ausencias.contadores;
  const a26 = c.find((x) => x.anio === 2026), a25 = c.find((x) => x.anio === 2025);
  assert.equal(a26.libres_tomados, 3); assert.equal(a26.dias_fuera, 9); assert.equal(a26.dias_no_pagados, 1);
  assert.equal(a26.tardanzas, 1); assert.equal(a26.minutos_tarde, 25); assert.equal(a25.libres_tomados, 1);
  assert.equal((await gerente.post(`/api/rrhh/empleados/${emp.id}/ausencias`, { tipo: 'permiso', desde: '2026-07-01' })).status, 403);
  const ed = await dueno.put(`/api/rrhh/ausencias/${inc.body.id}`, { hasta: '2026-06-03' });
  assert.equal(ed.status, 200);
  assert.equal((await dueno.get(`/api/rrhh/ausencias?empleado_id=${emp.id}&desde=2026-06-01&hasta=2026-06-30`)).body.find((x) => x.tipo === 'incapacidad').dias, 3);
});

test('amonestaciones, evaluaciones, capacitaciones y línea de tiempo', async () => {
  const s = await dueno.post(`/api/rrhh/empleados/${emp.id}/sanciones`, { tipo: 'escrita', fecha: '2026-08-01', motivo: 'Llegadas tarde repetidas' });
  assert.equal(s.status, 201);
  assert.equal((await dueno.post(`/api/rrhh/empleados/${emp.id}/sanciones`, { tipo: 'escrita', motivo: 'x' })).status, 400);
  assert.equal((await dueno.post(`/api/rrhh/empleados/${emp.id}/evaluaciones`, { fecha: '2026-07-01', periodo: '2026 · 1er semestre', puntaje: 88, fortalezas: 'Atención' })).status, 201);
  assert.equal((await dueno.post(`/api/rrhh/empleados/${emp.id}/capacitaciones`, { nombre: 'Manipulación de alimentos', fecha: '2026-02-01', horas: 8, vence: '2027-02-01' })).status, 201);
  assert.equal((await dueno.put(`/api/rrhh/sanciones/${s.body.id}`, { estado: 'anulada' })).status, 200);
  const f = (await dueno.get(`/api/rrhh/empleados/${emp.id}/ficha`)).body;
  assert.equal(f.sanciones[0].estado, 'anulada'); assert.equal(f.evaluaciones[0].puntaje, 88); assert.equal(f.capacitaciones.length, 1);
  const tipos = new Set(f.linea.map((x) => x.tipo));
  for (const k of ['ingreso', 'sancion', 'evaluacion', 'capacitacion', 'vacaciones', 'permiso']) assert.ok(tipos.has(k), k);
  assert.equal((await dueno.del(`/api/rrhh/sanciones/${s.body.id}`)).status, 200);
});

test('turno: marcar compañeros con ubicación, doble toque, reporte de horas y checklist', async () => {
  assert.equal((await dueno.put(`/api/rrhh/sucursales/${sucO}/geo`, { lat: 15.5, lon: -88.03, radio_metros: 100 })).status, 200);
  const hoy = (await caja.get(`/api/rrhh/turno/hoy`)).body;
  assert.equal(hoy.status ?? 200, 200);
  assert.ok(hoy.empleados.some((e) => e.id === emp.id));
  const m1 = await caja.post('/api/rrhh/turno/marcar', { empleado_id: emp.id, tipo: 'entrada', lat: 15.5, lon: -88.03 });
  assert.equal(m1.status, 201); assert.equal(m1.body.verificacion, 'dentro'); assert.equal(m1.body.origen, 'pin');
  assert.equal((await caja.post('/api/rrhh/turno/marcar', { empleado_id: emp.id, tipo: 'entrada' })).status, 409);   // doble toque
  const m2 = await caja.post('/api/rrhh/turno/marcar', { empleado_id: emp.id, lat: 15.7, lon: -88.03 });             // alterna → salida, lejos
  assert.equal(m2.body.tipo, 'salida'); assert.equal(m2.body.verificacion, 'lejos');
  const hoyD = (await caja.get(`/api/rrhh/turno/hoy`)).body.empleados.find((e) => e.id === emp.id);
  assert.equal(hoyD.adentro, false); assert.equal(hoyD.marcas.length, 2);
  const q = (await dueno.get('/api/rrhh/quincena-actual')).body;
  const rep = await dueno.get(`/api/rrhh/reporte-horas?desde=${q.desde}&hasta=${q.hasta}`);
  assert.equal(rep.status, 200); assert.equal(rep.body.empleados.find((e) => e.id === emp.id).marcaciones_lejos, 1);
  assert.equal((await caja.get(`/api/rrhh/reporte-horas?desde=${q.desde}&hasta=${q.hasta}`)).status, 403);
  assert.ok((await dueno.get('/api/rrhh/panel')).body.sucursales.length >= 1);
  // checklist (Italo trae el catálogo del sistema viejo)
  const chk = (await enItalo.get(`/api/rrhh/checklist?sucursal_id=${await t.sucursalId('italo', 'mackey')}`)).body;
  assert.equal(chk.apertura.total, 8); assert.equal(chk.cierre.total, 8);
  const ok = await enItalo.post('/api/rrhh/checklist', { sucursal_id: chk.sucursal.id, momento: 'apertura', item_id: chk.apertura.items[0].id, ok: true });
  assert.equal(ok.status, 200);
  assert.equal((await enItalo.get(`/api/rrhh/checklist?sucursal_id=${chk.sucursal.id}`)).body.apertura.hechos, 1);
});

test('personal real de Italo cargado e idempotente; importar fechas de ingreso', async () => {
  const lista = (await enItalo.get('/api/rrhh/empleados')).body;
  assert.equal(lista.length, 18);
  const daisy = lista.find((e) => e.nombres === 'Daisy');
  const f = (await enItalo.get(`/api/rrhh/empleados/${daisy.id}/ficha`)).body;
  assert.equal(f.horarios.length, 7); assert.equal(f.horarios.filter((h) => h.sucursal_id).length, 2); assert.equal(f.empleado.sucursales_extra.length, 1);
  assert.equal(f.vacaciones.resumen.sin_fecha_ingreso, true);
  const prop = (await enItalo.get('/api/rrhh/fechas-ingreso/propuesta')).body;
  const astrid = prop.cruces.find((c) => c.nombre_app === 'Astrid');
  assert.equal(astrid.sugerencia.fecha_ingreso, '2023-04-07');
  const g = await enItalo.post('/api/rrhh/fechas-ingreso', { cambios: [{ empleado_id: astrid.empleado_id, fecha_ingreso: '2023-04-07' }] });
  assert.equal(g.body.guardados, 1);
  assert.equal((await dueno.get('/api/rrhh/fechas-ingreso/propuesta')).status, 404);   // la planilla es de Italo
});

test('Dirección del grupo: directorio con filtros, resumen, calendario y ficha', async () => {
  const d = (await dueno.get('/api/grupo/rrhh/directorio')).body;
  assert.ok(d.empleados.some((e) => e.empresa === 'italo') && d.empleados.some((e) => e.empresa === 'origen'));
  assert.equal(d.empresas.length, 4);
  const ana = d.empleados.find((e) => e.id === emp.id);
  assert.equal(ana.identidad, '0501199504321');
  assert.equal((await dueno.get('/api/grupo/rrhh/directorio?empresa=italo')).body.empleados.every((e) => e.empresa === 'italo'), true);
  assert.equal((await dueno.get('/api/grupo/rrhh/directorio?q=reyes')).body.empleados.length >= 1, true);
  assert.equal((await dueno.get('/api/grupo/rrhh/directorio?q=0501-1995')).body.empleados.length, 1);   // por identidad (sensible)
  assert.equal((await dueno.get('/api/grupo/rrhh/directorio?vence=60')).body.empleados.some((e) => e.id === emp.id), true);
  assert.equal((await dueno.get('/api/grupo/rrhh/directorio?vence=30')).body.empleados.some((e) => e.id === emp.id), false);   // vence en 40 días
  assert.equal((await dueno.get('/api/grupo/rrhh/directorio?estado=baja')).body.empleados.every((e) => e.estado === 'baja'), true);
  const r = (await dueno.get('/api/grupo/rrhh/resumen')).body;
  assert.ok(r.plantilla.length >= 2 && r.total_activos >= 19);
  assert.ok(r.sin_fecha_ingreso > 0);
  const cal = (await dueno.get('/api/grupo/rrhh/calendario?desde=2026-12-01&hasta=2026-12-31')).body;
  assert.ok(cal.eventos.some((e) => e.empleado_id === emp.id && e.clase === 'vacaciones'));
  const fi = await dueno.get(`/api/grupo/rrhh/empleados/${emp.id}`);
  assert.equal(fi.body.empleado.salario_mensual, 10500); assert.equal(fi.body.permisos.editar, true);
  // el contador (grupo:ver, sin rrhh:sensible) ve el directorio pero enmascarado y sin salario
  const cg = (await t.cli(await t.login('origen', 'conta@origen.hn', 'ClaveSegura123'), 'origen').get('/api/grupo/rrhh/directorio')).body;
  assert.ok(cg.empleados.length > 0 && cg.empleados.every((e) => e.empresa === 'origen'));
  assert.match(cg.empleados.find((e) => e.id === emp.id).identidad, /\*\*\*\*/);
  const cf = (await contador.get(`/api/grupo/rrhh/empleados/${emp.id}`)).body;
  assert.equal(cf.empleado.salario_mensual, null); assert.equal(cf.permisos.editar, false);
  assert.equal((await gerente.get('/api/grupo/rrhh/directorio')).status, 403);
  assert.equal((await caja.get('/api/grupo/rrhh/resumen')).status, 403);
});
