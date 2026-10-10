import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from './helpers.js';
import { sembrar } from '../src/db/sembrar.js';
import { ROLES } from '@grupo/shared';
const puedeRol = (rol, perm) => ROLES[rol].permisos.includes(perm);

let t, ger, adm;
before(async () => {
  t = await iniciar();
  await sembrar(t.db, t.config.semillas, 'origen');
  await t.usuario({ nombre: 'Manager', email: 'ger@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Admin', email: 'adm@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'admin' }] });
  ger = t.cli(await t.login('origen', 'ger@origen.hn', 'ClaveSegura123'), 'origen');
  adm = t.cli(await t.login('origen', 'adm@origen.hn', 'ClaveSegura123'), 'origen');
});
after(() => t.cerrar());

test('el Manager no ve dashboard, reportes, finanzas ni recetas y costeo; el administrador sí', async () => {
  for (const ruta of ['/api/pos/dashboard', '/api/pos/reportes/resumen', '/api/fin/resultados', '/api/prod/costeo/recetas']) {
    assert.equal((await ger.get(ruta)).status, 403, `Manager: ${ruta}`);
  }
  for (const ruta of ['/api/pos/dashboard', '/api/pos/reportes/resumen', '/api/fin/resultados']) {
    assert.equal((await adm.get(ruta)).status, 200, `Admin: ${ruta}`);
  }
});

test('el Manager conserva los cierres de caja y no tiene inventario unificado', () => {
  assert.equal(puedeRol('gerente', 'pos:cierres'), true);
  assert.equal(puedeRol('gerente', 'pos:caja'), true);
  assert.equal(puedeRol('gerente', 'pos:reportes'), false);
  assert.equal(puedeRol('gerente', 'inv:unificado'), false);
  assert.equal(puedeRol('gerente', 'fin:ver'), false);
  assert.equal(puedeRol('gerente', 'costeo:ver'), false);
  assert.equal(puedeRol('admin', 'costeo:ver'), true);
  assert.equal(puedeRol('dueno', 'costeo:ver'), true);
});
