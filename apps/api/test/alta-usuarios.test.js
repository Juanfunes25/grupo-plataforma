import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from './helpers.js';
import { altaUsuariosDesdeEnv } from '../src/db/alta-usuarios.js';

let t;
before(async () => { t = await iniciar(); });
after(async () => { await t.cerrar(); });

test('alta de usuarios iniciales: crea con PIN, entra, es idempotente y rechaza roles que no entran con PIN', async () => {
  const raw = JSON.stringify([
    { nombre: 'Cajera Prueba', accesos: [{ empresa: 'italo', rol: 'cajero', pin: '4545', sucursal: 'Mackey' }] },
    { nombre: 'Vendedora Prueba', accesos: [{ empresa: 'ecostone', rol: 'ventas', pin: '3434' }, { empresa: 'diserco', rol: 'ventas', pin: '3434' }] },
    { nombre: 'Contador Prueba', accesos: [{ empresa: 'italo', rol: 'contador', pin: '5656' }] },
  ]);
  const a = await altaUsuariosDesdeEnv(t.db, t.config, { raw, log: () => {} });
  assert.equal(a.creados, 3, 'cajera + vendedora en dos empresas; el contador no entra con PIN');
  const tok = await t.loginPin('italo', '4545');
  assert.ok(tok);
  const yo = await t.cli(tok, 'italo').get('/api/auth/yo');
  assert.equal(yo.status, 200);
  assert.ok(await t.loginPin('ecostone', '3434') && await t.loginPin('diserco', '3434'));
  const b = await altaUsuariosDesdeEnv(t.db, t.config, { raw, log: () => {} });
  assert.deepEqual([b.creados, b.saltados], [0, 3], 'repetir no duplica');
  assert.equal((await t.db.query(`select count(*)::int n from core.usuarios where nombre = 'Vendedora Prueba'`)).rows[0].n, 1);
  assert.deepEqual(await altaUsuariosDesdeEnv(t.db, t.config, { raw: 'no es json', log: () => {} }), { creados: 0, saltados: 0 });
});

test('entrada con PIN: lista de tiendas y personas, exige quién eres, y la tienda tiene que ser suya', async () => {
  const raw = JSON.stringify([
    { nombre: 'Mackey Uno', accesos: [{ empresa: 'italo', rol: 'cajero', pin: '6161', sucursal: 'Mackey' }] },
    { nombre: 'Procer Dos', accesos: [{ empresa: 'italo', rol: 'cajero', pin: '6262', sucursal: 'Próceres' }] },
  ]);
  await altaUsuariosDesdeEnv(t.db, t.config, { raw, log: () => {} });
  const op = (await t.cli().get('/api/auth/pin/opciones?empresa=italo')).body;
  assert.ok(op.sucursales.length >= 2 && op.usuarios.some((u) => u.nombre === 'Mackey Uno'));
  assert.ok(op.usuarios.every((u) => typeof u.rol === 'string'), 'cada persona trae su rol (para separar planta de tiendas)');
  assert.ok(!JSON.stringify(op).includes('pin_hash') && !JSON.stringify(op).includes('6161'), 'solo nombres, nunca claves');
  const mackey = await t.pinUsuario('italo', '6161');
  const sucMackey = await t.sucursalId('italo', 'mackey'), sucProceres = await t.sucursalId('italo', 'proceres');
  const post = (b) => t.cli().post('/api/auth/pin', { empresa: 'italo', ...b });
  assert.equal((await post({ pin: '6161' })).status, 400, 'sin decir quién eres no entra');
  assert.equal((await post({ pin: '6262', usuario_id: mackey })).status, 401, 'el PIN de otra persona no sirve para esta');
  assert.equal((await post({ pin: '6161', usuario_id: mackey, sucursal_id: sucProceres })).status, 403, 'no puede entrar a una tienda que no es la suya');
  assert.equal((await post({ pin: '6161', usuario_id: mackey, sucursal_id: sucMackey })).status, 200);
});
