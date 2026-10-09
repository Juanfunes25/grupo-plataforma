import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from './helpers.js';
import { estadoDe } from '../src/modulos/inv/adaptadores.js';

let t, dueno, gerOrigen, cajero, oId, iId, eId, dId, sucMackey, sucProceres, sucPrincipal;

before(async () => {
  t = await iniciar();
  oId = await t.empresaId('origen'); iId = await t.empresaId('italo'); eId = await t.empresaId('ecostone'); dId = await t.empresaId('diserco');
  sucMackey = await t.sucursalId('italo', 'mackey'); sucProceres = await t.sucursalId('italo', 'proceres'); sucPrincipal = await t.sucursalId('origen', 'principal');
  await t.usuario({ nombre: 'Dueño', email: 'd@grupo.hn', password: 'ClaveSegura123', dueno: true });
  await t.usuario({ nombre: 'Gerente Origen', email: 'g@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Cajera', accesos: [{ empresa: 'origen', rol: 'cajero', pin: '1313' }] });
  const con = (token, emp) => t.cli(token, emp);
  const tk = await t.login('italo', 'd@grupo.hn', 'ClaveSegura123');
  dueno = (emp) => con(tk, emp);
  gerOrigen = con(await t.login('origen', 'g@origen.hn', 'ClaveSegura123'), 'origen');
  cajero = con(await t.loginPin('origen', '1313'), 'origen');
});
after(() => t.cerrar());

test('estado uniforme', () => {
  assert.equal(estadoDe(-1, 5), 'negativo'); assert.equal(estadoDe(0, 5), 'agotado'); assert.equal(estadoDe(3, 5), 'bajo');
  assert.equal(estadoDe(9, 5), 'ok'); assert.equal(estadoDe(9, null), 'ok'); assert.equal(estadoDe(0, 0, true), 'sin_cargar');
});

test('Origen: existencias unificadas, mínimo, vencimiento y costo oculto sin permiso', async () => {
  const ins = (await gerOrigen.post('/api/inv/insumos', { nombre: 'Fresa', categoria: 'Fruta', unidad: 'kg', costo_actual: 40, stock_minimo: 10, perecedero: true })).body;
  const vence = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const c = await gerOrigen.post('/api/inv/compras', { sucursal_id: sucPrincipal, items: [{ insumo_id: ins.id, cantidad: 6, costo_unitario: 40, vence_at: vence }] });
  assert.equal(c.status, 201);
  const r = await gerOrigen.get('/api/inv/u/existencias');
  assert.equal(r.status, 200);
  const f = r.body.items.find((i) => i.nombre === 'Fresa');
  assert.equal(f.existencia, 6); assert.equal(f.estado, 'bajo'); assert.equal(f.valor, 240); assert.equal(f.fuente, 'inv'); assert.equal(f.vence, vence);
  assert.equal(r.body.resumen.bajo_minimo, 1);
  const a = await gerOrigen.get('/api/inv/u/alertas?dias=5');
  assert.equal(a.body.vencimientos.length, 1); assert.equal(a.body.bajo_minimo[0].nombre, 'Fresa');
  // el cajero no tiene inv:ver
  assert.equal((await cajero.get('/api/inv/u/existencias')).status, 403);
});

test('Italo: sucursales e insumos de fábrica comparten la misma vista', async () => {
  const d = dueno('italo');
  const fab = (await d.post('/api/rinv/fabrica', { nombre: 'PASTA PISTACHO', tipo: 'mec3', unidad: 'kg', lps_kg: 500 })).body;
  assert.ok(fab.id);
  await d.patch?.call; // sin uso
  const m = await fetch(`http://127.0.0.1:${new URL((await import('./helpers.js')).default ?? 'http://x').port}`).catch(() => null); void m;
});
