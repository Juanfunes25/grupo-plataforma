import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fechaHN } from '@grupo/shared';
import { iniciar } from './helpers.js';

// Asistente fiscal: datos, lista de verificación, modo PRUEBA/REAL y alertas de CAI.

let t, dueno, admin, gerente, cajero;
const hex = (n) => n.toString(16).toUpperCase().padStart(6, '0');
const cai = (n, dias = 365) => ({
  cai: `${hex(n)}-${hex(n + 1)}-${hex(n + 2)}-${hex(n + 3)}-${hex(n + 4)}-AB`,
  punto_emision_codigo: '001', punto_venta_codigo: '001', tipo_documento_codigo: '01',
  correlativo_desde: 1, correlativo_hasta: 1000, correlativo_actual: 1,
  fecha_limite_emision: new Date(Date.now() + dias * 86_400_000).toISOString().slice(0, 10), es_borrador: false,
});

before(async () => {
  t = await iniciar();
  await t.usuario({ nombre: 'Dueño', email: 'dueno@grupo.hn', password: 'ClaveSegura123', dueno: true });
  await t.usuario({ nombre: 'Admin Italo', email: 'admin@italo.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'italo', rol: 'admin' }] });
  await t.usuario({ nombre: 'Gerente Italo', email: 'gerente@italo.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'italo', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Caja Italo', accesos: [{ empresa: 'italo', rol: 'cajero', pin: '4821' }] });
  dueno = t.cli(await t.login('italo', 'dueno@grupo.hn', 'ClaveSegura123'), 'italo');
  admin = t.cli(await t.login('italo', 'admin@italo.hn', 'ClaveSegura123'), 'italo');
  gerente = t.cli(await t.login('italo', 'gerente@italo.hn', 'ClaveSegura123'), 'italo');
  cajero = t.cli(await t.loginPin('italo', '4821'), 'italo');
});
after(() => t.cerrar());

test('el asistente arranca en modo PRUEBA y dice qué falta para facturar en vivo', async () => {
  const r = await admin.get('/api/fiscal/asistente');
  assert.equal(r.status, 200);
  assert.equal(r.body.modo, 'prueba');
  assert.equal(r.body.listo_para_real, false);
  const ids = r.body.verificacion.map((i) => i.id);
  for (const id of ['datos_empresa', 'datos_sucursales', 'cai', 'impresora', 'usuarios']) assert.ok(ids.includes(id), id);
  const cai = r.body.verificacion.find((i) => i.id === 'cai');
  assert.equal(cai.estado, 'falta');
  assert.match(cai.detalle, /sin CAI real/);
  // El RTN que dejó la migración 0026 es ficticio: no cuenta como dato fiscal real.
  assert.equal(r.body.verificacion.find((i) => i.id === 'datos_empresa').estado, 'falta');
  assert.equal(r.body.sucursales.length, 4);
  assert.equal(r.body.sucursales.filter((s) => s.factura).length, 4);
});

test('solo quien tiene pos:fiscal ve el asistente', async () => {
  assert.equal((await gerente.get('/api/fiscal/asistente')).status, 403);
  assert.equal((await cajero.get('/api/fiscal/asistente')).status, 403);
  assert.equal((await cajero.put('/api/fiscal/empresa', {})).status, 403);
});

test('los datos de la empresa se validan (RTN de 14 dígitos, correo, teléfono) y quedan en la bitácora', async () => {
  const base = { razon_social: 'Inversiones Milano S. de R.L.', nombre: 'Italo Gelatería', direccion: '12 Avenida, Los Andes', ciudad: 'San Pedro Sula', telefono: '2550-1234', correo: 'facturas@italo.hn', web: null };
  assert.equal((await admin.put('/api/fiscal/empresa', { ...base, rtn: '123' })).status, 400);
  assert.equal((await admin.put('/api/fiscal/empresa', { ...base, rtn: '08011999123456', correo: 'no-es-correo' })).status, 400);
  assert.equal((await admin.put('/api/fiscal/empresa', { ...base, rtn: '08011999123456', telefono: '12' })).status, 400);
  const ok = await admin.put('/api/fiscal/empresa', { ...base, rtn: '0801-1999-123456' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.rtn, '08011999123456');
  const aud = (await admin.get('/api/admin/auditoria?accion=datos_fiscales_empresa')).body;
  assert.equal(aud.length, 1);
  assert.ok(aud[0].detalle.cambios.rtn);
  const v = (await admin.get('/api/fiscal/asistente')).body;
  assert.equal(v.verificacion.find((i) => i.id === 'datos_empresa').estado, 'ok');
});

test('datos de cada sucursal: dirección, teléfono y correo', async () => {
  const a = (await admin.get('/api/fiscal/asistente')).body.sucursales[1];
  const r = await admin.put(`/api/fiscal/sucursales/${a.id}`, { nombre: a.nombre, direccion: 'Bulevar Morazán, local 4', telefono: '2550-9999', correo: 'mackey@italo.hn' });
  assert.equal(r.status, 200);
  assert.equal(r.body.correo, 'mackey@italo.hn');
  assert.equal((await admin.put(`/api/fiscal/sucursales/${a.id}`, { nombre: a.nombre, correo: 'x' })).status, 400);
  // una sucursal de otra empresa no se toca
  const ajena = await t.sucursalId('origen', 'principal');
  assert.equal((await admin.put(`/api/fiscal/sucursales/${ajena}`, { nombre: 'Hackeada' })).status, 404);
});

test('no se puede pasar a modo REAL mientras falte algo, y la respuesta dice qué', async () => {
  const r = await admin.post('/api/fiscal/modo', { modo: 'real', confirmar: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.codigo, 'fiscal_incompleto');
  assert.ok(r.body.faltantes.some((f) => f.id === 'cai'));
  assert.equal((await admin.post('/api/fiscal/modo', { modo: 'real' })).status, 400);   // sin confirmar
});

test('alertas de CAI: por vencer, agotándose y vencido, con nivel y clave estable', async () => {
  const suc = (await admin.get('/api/fiscal/asistente')).body.sucursales;
  const pe = (await admin.get('/api/pos/puntos-emision')).body;
  // 0: vence en 5 días → crítica · 1: vence en 20 días (sin alerta) · 2: 96 % usado → aviso o crítica · 3: sigue en borrador
  assert.equal((await admin.put(`/api/pos/puntos-emision/${pe[0].id}`, cai(0x100000, 5))).status, 200);
  assert.equal((await admin.put(`/api/pos/puntos-emision/${pe[1].id}`, cai(0x200000, 20))).status, 200);
  assert.equal((await admin.put(`/api/pos/puntos-emision/${pe[2].id}`, { ...cai(0x300000, 90), correlativo_actual: 920 })).status, 200);
  const r = await admin.get('/api/fiscal/alertas');
  assert.equal(r.status, 200);
  const por = Object.fromEntries(r.body.alertas.map((a) => [a.sucursal_id, a]));
  assert.equal(por[pe[0].sucursal_id].nivel, 'critica');
  assert.equal(por[pe[0].sucursal_id].tipo, 'cai_por_vencer');
  assert.ok(por[pe[0].sucursal_id].clave.startsWith('cai:'));
  assert.equal(por[pe[1].sucursal_id], undefined, 'con 20 días y poco uso no hay alerta');
  assert.equal(por[pe[2].sucursal_id].tipo, 'cai_por_agotarse');
  assert.equal(por[pe[3]?.sucursal_id], undefined, 'un punto en borrador no genera alerta');
  assert.equal(suc.length, 4);
  // las críticas van primero
  assert.equal(r.body.alertas[0].nivel, 'critica');
  // el gerente (pos:reportes) las ve para el tablero; el cajero no
  assert.equal((await gerente.get('/api/fiscal/alertas')).status, 200);
  assert.equal((await cajero.get('/api/fiscal/alertas')).status, 403);
  // el alcance de grupo solo existe para quien ve la Dirección
  assert.equal((await admin.get('/api/fiscal/alertas?alcance=grupo')).body.alertas.length, 0);
  assert.ok((await dueno.get('/api/fiscal/alertas?alcance=grupo')).body.alertas.length >= 2);
});

test('puesta en vivo: con todo completo se pasa a REAL (RTN obligatorio) y se puede volver a PRUEBA', async () => {
  const sucs = (await admin.get('/api/fiscal/asistente')).body.sucursales;
  const pe = (await admin.get('/api/pos/puntos-emision')).body;
  for (const p of pe.filter((x) => x.es_borrador)) assert.equal((await admin.put(`/api/pos/puntos-emision/${p.id}`, cai(0x400000, 300))).status, 200);
  // la impresora la confirma una persona, sucursal por sucursal
  let v = (await admin.get('/api/fiscal/asistente')).body;
  assert.equal(v.verificacion.find((i) => i.id === 'cai').estado, 'aviso');   // todos activos, algunos por vencer
  assert.equal(v.listo_para_real, false);
  assert.equal(v.verificacion.find((i) => i.id === 'impresora').estado, 'manual');
  assert.equal((await admin.post('/api/fiscal/modo', { modo: 'real', confirmar: true })).status, 409);
  for (const s of sucs) assert.equal((await admin.post('/api/fiscal/confirmaciones', { id: `impresora_${s.id}`, confirmado: true })).status, 200);
  assert.equal((await admin.post('/api/fiscal/confirmaciones', { id: `impresora_${await t.sucursalId('origen', 'principal')}`, confirmado: true })).status, 404);
  v = (await admin.get('/api/fiscal/asistente')).body;
  assert.equal(v.verificacion.find((i) => i.id === 'impresora').estado, 'ok');
  assert.equal(v.listo_para_real, true, JSON.stringify(v.verificacion.filter((i) => i.estado !== 'ok')));

  const real = await admin.post('/api/fiscal/modo', { modo: 'real', confirmar: true });
  assert.equal(real.status, 200);
  v = (await admin.get('/api/fiscal/asistente')).body;
  assert.equal(v.modo, 'real');
  assert.equal(v.rtn_bloqueante, true);
  assert.ok(v.en_vivo_desde);
  assert.equal((await admin.post('/api/fiscal/modo', { modo: 'real', confirmar: true })).status, 409);   // ya está

  // En vivo: ninguna sucursal vuelve sola a borrador, ni se deja la empresa sin RTN.
  assert.equal((await admin.put(`/api/pos/puntos-emision/${pe[0].id}`, { es_borrador: true })).status, 409);
  const base = { razon_social: 'Inversiones Milano S. de R.L.', nombre: 'Italo Gelatería', direccion: null, ciudad: 'San Pedro Sula', telefono: '2550-1234', correo: 'facturas@italo.hn', rtn: '08011999123456' };
  assert.equal((await admin.put('/api/fiscal/empresa', base)).status, 409);

  const prueba = await admin.post('/api/fiscal/modo', { modo: 'prueba', confirmar: true });
  assert.equal(prueba.status, 200);
  v = (await admin.get('/api/fiscal/asistente')).body;
  assert.equal(v.modo, 'prueba');
  assert.equal(v.rtn_bloqueante, false);
  assert.equal(v.sucursales_con_cai_real, 0, 'todos los puntos vuelven a borrador');
  const acciones = (await admin.get('/api/admin/auditoria?accion=modo_fiscal')).body.map((a) => a.accion).sort();
  assert.deepEqual(acciones, ['modo_fiscal_prueba', 'modo_fiscal_real']);
});

test('un punto con CAI real cargado, sin haber declarado la puesta en vivo, se marca «en preparación»', async () => {
  const pe = (await admin.get('/api/pos/puntos-emision')).body;
  assert.equal((await admin.put(`/api/pos/puntos-emision/${pe[0].id}`, cai(0x500000, 300))).status, 200);
  const v = (await admin.get('/api/fiscal/asistente')).body;
  assert.equal(v.modo, 'prueba');
  assert.equal(v.en_preparacion, true);
  assert.equal(v.sucursales_con_cai_real, 1);
});
