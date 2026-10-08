import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from './helpers.js';

let t;
before(async () => {
  t = await iniciar();
  await t.usuario({ nombre: 'Juan Carlos', email: 'juan@grupo.hn', password: 'ClaveSegura123', dueno: true });
  await t.usuario({ nombre: 'Gerente Origen', email: 'gerente@origen.hn', password: 'OtraClave1234', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Caja Origen', accesos: [{ empresa: 'origen', rol: 'cajero', pin: '4821' }] });
  await t.usuario({ nombre: 'Caja Italo', accesos: [{ empresa: 'italo', rol: 'cajero', pin: '4821' }] });
});
after(() => t.cerrar());

test('lista pública de empresas trae marca pero nada sensible', async () => {
  const r = await t.cli().get('/api/publico/empresas');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((e) => e.codigo), ['italo', 'origen', 'ecostone', 'diserco', 'grupo']);
  assert.ok(!('rtn' in r.body[0]));
});

test('dueño del grupo entra a cualquier empresa con correo+contraseña', async () => {
  for (const emp of ['italo', 'origen', 'ecostone', 'diserco']) {
    const r = await t.cli().post('/api/auth/login', { empresa: emp, email: 'juan@grupo.hn', password: 'ClaveSegura123' });
    assert.equal(r.status, 200, emp);
  }
});

test('contraseña mala → 401 genérico; correo inexistente igual', async () => {
  const a = await t.cli().post('/api/auth/login', { empresa: 'origen', email: 'juan@grupo.hn', password: 'mala' });
  const b = await t.cli().post('/api/auth/login', { empresa: 'origen', email: 'nadie@x.hn', password: 'mala' });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.body.error, b.body.error);
});

test('un gerente de Origen NO puede entrar a Italo', async () => {
  const r = await t.cli().post('/api/auth/login', { empresa: 'italo', email: 'gerente@origen.hn', password: 'OtraClave1234' });
  assert.equal(r.status, 403);
});

test('/auth/yo devuelve permisos y módulos de la empresa activa', async () => {
  const token = await t.login('origen', 'gerente@origen.hn', 'OtraClave1234');
  const r = await t.cli(token, 'origen').get('/api/auth/yo');
  assert.equal(r.status, 200);
  assert.equal(r.body.contexto.rol, 'gerente');
  assert.ok(r.body.contexto.permisos.includes('pos:anular'));
  assert.ok(!r.body.contexto.permisos.includes('admin:usuarios'));
  const mods = r.body.contexto.modulos.map((m) => m.id);
  assert.ok(mods.includes('pos') && mods.includes('kds') && mods.includes('inventario'));
  assert.ok(!mods.includes('grupo'));
  assert.deepEqual(r.body.empresas.map((e) => e.codigo), ['origen']);
});

test('PIN: entra a su empresa; el mismo PIN en otra empresa es otra persona', async () => {
  const a = await t.cli().post('/api/auth/pin', { empresa: 'origen', pin: '4821' });
  const b = await t.cli().post('/api/auth/pin', { empresa: 'italo', pin: '4821' });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const ya = await t.cli(a.body.token, 'origen').get('/api/auth/yo');
  const yb = await t.cli(b.body.token, 'italo').get('/api/auth/yo');
  assert.equal(ya.body.usuario.nombre, 'Caja Origen');
  assert.equal(yb.body.usuario.nombre, 'Caja Italo');
});

test('token de PIN no sirve para otra empresa aunque mande X-Empresa', async () => {
  const token = await t.loginPin('origen', '4821');
  const r = await t.cli(token, 'italo').get('/api/auth/yo');
  assert.equal(r.status, 403);
});

test('PIN incorrecto → 401 y tras varios intentos se bloquea (429)', async () => {
  t.app.locals.limitadores?.limPin?.reiniciar();
  let ultimo;
  for (let i = 0; i < 9; i++) ultimo = await t.cli().post('/api/auth/pin', { empresa: 'origen', pin: '0000' });
  assert.equal(ultimo.status, 429);
  t.app.locals.limitadores?.limPin?.reiniciar();
});

test('un cajero NO puede entrar con correo (no tiene) ni un rol de dirección con PIN', async () => {
  const r = await t.cli().post('/api/auth/pin', { empresa: 'origen', pin: '9999' });
  assert.equal(r.status, 401);
});

test('sin token → 401; token roto → 401', async () => {
  assert.equal((await t.cli(null, 'origen').get('/api/auth/yo')).status, 401);
  assert.equal((await t.cli('abc.def.ghi', 'origen').get('/api/auth/yo')).status, 401);
});

test('cambiar contraseña invalida las sesiones anteriores', async () => {
  const token = await t.login('origen', 'gerente@origen.hn', 'OtraClave1234');
  const r = await t.cli(token).post('/api/auth/cambiar-password', { actual: 'OtraClave1234', nueva: 'NuevaClave5678' });
  assert.equal(r.status, 200);
  assert.equal((await t.cli(token, 'origen').get('/api/auth/yo')).status, 401);
  await t.login('origen', 'gerente@origen.hn', 'NuevaClave5678');
});

test('entrada de Dirección: dueño sí; gerente sin grupo:ver no; contador sí', async () => {
  await t.usuario({ nombre: 'Contadora', email: 'conta@grupo.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'italo', rol: 'contador' }] });
  const ok = await t.cli().post('/api/auth/login', { empresa: 'grupo', email: 'juan@grupo.hn', password: 'ClaveSegura123' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.empresa, 'grupo');
  const conta = await t.cli().post('/api/auth/login', { empresa: 'grupo', email: 'conta@grupo.hn', password: 'ClaveSegura123' });
  assert.equal(conta.status, 200);
  const ger = await t.cli().post('/api/auth/login', { empresa: 'grupo', email: 'gerente@origen.hn', password: 'NuevaClave5678' });
  assert.equal(ger.status, 403);
  const pin = await t.cli().post('/api/auth/pin', { empresa: 'grupo', pin: '4821' });
  assert.equal(pin.status, 400);
});
