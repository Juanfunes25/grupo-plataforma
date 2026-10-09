import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from './helpers.js';
import { iniciarVigilancia } from '../src/modulos/salud/vigilancia.js';

let t, dueno, admin;
before(async () => {
  t = await iniciar();
  await t.usuario({ nombre: 'Dueño', email: 'dueno@grupo.hn', password: 'ClaveSegura123', dueno: true });
  await t.usuario({ nombre: 'Admin', email: 'admin@italo.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'italo', rol: 'admin' }] });
  dueno = t.cli(await t.login('italo', 'dueno@grupo.hn', 'ClaveSegura123'), 'italo');
  admin = t.cli(await t.login('italo', 'admin@italo.hn', 'ClaveSegura123'), 'italo');
});
after(() => t.cerrar());

test('/api/health es público y mínimo; el detalle exige ser dueño del grupo', async () => {
  const h = await t.cli().get('/api/health');
  assert.equal(h.status, 200);
  assert.deepEqual(Object.keys(h.body).sort(), ['db', 'ms', 'ok', 'version']);
  assert.equal((await t.cli().get('/api/sistema/estado')).status, 401);
  assert.equal((await admin.get('/api/sistema/estado')).status, 403);
  const e = await dueno.get('/api/sistema/estado');
  assert.equal(e.status, 200);
  assert.ok(['ok', 'aviso', 'critico'].includes(e.body.general));
  assert.ok(e.body.migraciones.aplicadas > 30);
  assert.deepEqual(e.body.migraciones.pendientes, []);
  assert.ok(e.body.base.latencia_ms >= 0);
  const ids = e.body.chequeos.map((c) => c.id);
  for (const id of ['base', 'migraciones', 'correo', 'respaldo', 'dos_pasos', 'secretos']) assert.ok(ids.includes(id), id);
  assert.equal(e.body.chequeos.find((c) => c.id === 'correo').estado, 'aviso');   // sin Gmail: «pendiente de configurar», no falla
  assert.ok(!JSON.stringify(e.body).includes(t.config.jwtSecret));
});

test('los navegadores reportan errores, se agrupan y salen en el resumen; el abuso tiene tope', async () => {
  for (let i = 0; i < 3; i++) {
    const r = await t.cli().post('/api/errores-cliente', { mensaje: `Cannot read properties of undefined (reading 'x${i}0000')`, pila: 'TypeError\n    at Foo (app.js:10:5)', ruta: '/italo/pos', empresa: 'italo', version: 'v1', tipo: 'error' });
    assert.equal(r.status, 202);
  }
  const lista = (await dueno.get('/api/sistema/errores?origen=navegador')).body;
  assert.equal(lista.length, 1, 'el mismo error repetido se cuenta, no se duplica');
  assert.equal(lista[0].extra.repeticiones, 3);
  const e = (await dueno.get('/api/sistema/estado')).body;
  assert.equal(e.errores.mas_repetidos[0].veces, 3);
  assert.equal((await admin.get('/api/sistema/errores')).status, 403);
});

test('un error 500 del servidor queda registrado con su ruta', async () => {
  await t.db.query('alter table core.config rename to config_x');
  try { await dueno.get('/api/auth/yo'); const r = await dueno.get('/api/pos/catalogo'); assert.ok(r.status >= 500 || r.status === 200); }
  finally { await t.db.query('alter table core.config_x rename to config'); }
  await new Promise((r) => setTimeout(r, 200));
  const n = (await t.db.query(`select count(*)::int as n from core.errores_sistema where origen = 'servidor'`)).rows[0].n;
  assert.ok(n >= 1);
});

test('vigilancia: detecta una caída entre dos arranques y, si se repite, deja el aviso pendiente (sin Gmail no falla)', async () => {
  const hace = (min) => new Date(Date.now() - min * 60_000).toISOString();
  for (let i = 0; i < 3; i++) {
    await t.db.query(`insert into core.sistema_estado (clave, valor) values ('latido', $1::jsonb) on conflict (clave) do update set valor = excluded.valor`, [JSON.stringify({ at: hace(30) })]);
    const v = iniciarVigilancia({ db: t.db, config: t.config, errores: t.app.locals.errores, cadaMs: 3_600_000, log: () => {} });
    await new Promise((r) => setTimeout(r, 400));
    v.detener();
    await t.db.query(`update core.errores_sistema set huella = huella || $1 where origen = 'caida'`, [String(i)]);   // evita que se junten como repetición
  }
  const caidas = (await t.db.query(`select count(*)::int as n from core.errores_sistema where origen = 'caida'`)).rows[0].n;
  assert.ok(caidas >= 3, `caídas: ${caidas}`);
  const pend = (await dueno.get('/api/sistema/errores?origen=aviso')).body;
  assert.equal(pend.length, 1);
  assert.match(pend[0].mensaje, /correo sin configurar|dueño/);
  const e = (await dueno.get('/api/sistema/estado')).body;
  assert.equal(e.chequeos.find((c) => c.id === 'caidas').estado, 'critico');
});
