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
