import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fechaHN, sumarDias } from '@grupo/shared';
import { iniciar } from './helpers.js';
import { sembrar } from '../src/db/sembrar.js';
import { armarDias, comparar, horaCorteHN } from '../src/modulos/tablero/calculo.js';
import { sinTildes } from '../src/modulos/busqueda/rutas.js';

let t, dueno, gerente, caja, suc, cat;
const prod = (n) => cat.productos.find((p) => p.nombre === n);
const fp = (tipo) => cat.formas_pago.find((f) => f.tipo === tipo).id;

before(async () => {
  t = await iniciar();
  await sembrar(t.db, t.config.semillas, 'origen');
  (await t.usuario({ nombre: 'Dueño', email: 'dueno@grupo.hn', password: 'ClaveSegura123', dueno: true })).id;
  await t.usuario({ nombre: 'Gerente', email: 'ger@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Cajera Ana', accesos: [{ empresa: 'origen', rol: 'cajero', pin: '1234' }] });
  caja = t.cli(await t.loginPin('origen', '1234'), 'origen');
  gerente = t.cli(await t.login('origen', 'ger@origen.hn', 'ClaveSegura123'), 'origen');
  dueno = t.cli(await t.login('origen', 'dueno@grupo.hn', 'ClaveSegura123'), 'origen');
  cat = (await caja.get('/api/pos/catalogo')).body;
  suc = cat.sucursales[0].id;
  const v = await caja.post('/api/pos/ventas', { sucursal_id: suc, items: [{ producto_id: prod('Naranja Pura').id, cantidad: 2 }], cobrar: { pagos: [{ forma_pago_id: fp('efectivo'), monto: 500 }] } });
  assert.equal(v.status, 201, JSON.stringify(v.body));
});
after(() => t.cerrar());

// ── Cálculo puro ────────────────────────────────────────────────────────────
test('comparar: variación porcentual y sin base de comparación', () => {
  assert.deepEqual(comparar(120, 100), { delta: 20, pct: 20, nuevo: false });
  assert.equal(comparar(50, 100).pct, -50);
  assert.deepEqual(comparar(10, 0), { delta: 10, pct: null, nuevo: true });
  assert.deepEqual(comparar(0, 0), { delta: 0, pct: null, nuevo: false });
});

test('hora de corte en Honduras (UTC-6) y armado de días', () => {
  assert.equal(horaCorteHN(new Date('2026-03-10T03:30:15Z')), '21:30:15');   // 21:30 del 9 de marzo en Honduras
  const dias = armarDias({
    fechas: ['2026-03-09', '2026-03-10'],
    ventas: [{ fecha: '2026-03-10', facturas: 2, total: 300, facturas_corte: 1, total_corte: 100 }, { fecha: '2026-03-10', facturas: 1, total: 50, facturas_corte: 1, total_corte: 50 }],
    margen: [{ fecha: '2026-03-10', venta: 350, venta_costeada: 200, costo: 50 }],
  });
  assert.equal(dias['2026-03-10'].total, 350);
  assert.equal(dias['2026-03-10'].ticket_promedio, 116.67);
  assert.equal(dias['2026-03-10'].margen_pct, 75);
  assert.equal(dias['2026-03-10'].cobertura_pct, 57);
  assert.equal(dias['2026-03-09'].margen_pct, null);
  assert.equal(dias['2026-03-10'].dia, 'Mar');
});

// ── Tablero ─────────────────────────────────────────────────────────────────
test('tablero de la empresa: hoy, ayer, semana pasada, sucursales, formas de pago y tendencia de 7 días', async () => {
  const r = await gerente.get('/api/tablero');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.fecha, fechaHN());
  assert.equal(r.body.hoy.facturas, 1);
  assert.ok(r.body.hoy.total > 0);
  assert.equal(r.body.ayer.fecha, sumarDias(fechaHN(), -1));
  assert.equal(r.body.semana_pasada.fecha, sumarDias(fechaHN(), -7));
  assert.equal(r.body.tendencia.length, 7);
  assert.equal(r.body.tendencia.at(-1).fecha, fechaHN());
  assert.equal(r.body.tendencia.at(-1).total, r.body.hoy.total);
  assert.equal(r.body.vs_ayer.misma_hora.nuevo, true, 'sin ventas ayer: no hay porcentaje');
  assert.equal(r.body.formas_pago[0].tipo, 'efectivo');
  assert.equal(r.body.sucursales.find((s) => s.id === suc).hoy.facturas, 1);
  assert.ok(Array.isArray(r.body.alertas));
});

test('tablero: el cajero no lo ve; el tablero del grupo es solo para Dirección', async () => {
  assert.equal((await caja.get('/api/tablero')).status, 403);
  assert.equal((await gerente.get('/api/tablero/grupo')).status, 403);
  const g = await dueno.get('/api/tablero/grupo');
  assert.equal(g.status, 200);
  assert.equal(g.body.empresas.length, 4);
  assert.equal(g.body.empresas.find((e) => e.codigo === 'origen').hoy.facturas, 1);
  assert.equal(g.body.total.hoy, g.body.empresas.reduce((s, e) => s + e.hoy.total, 0));
  assert.equal(g.body.tendencia.length, 7);
});

// ── Búsqueda global ─────────────────────────────────────────────────────────
test('sinTildes iguala mayúsculas, tildes y eñes', () => assert.equal(sinTildes('JOSÉ Peña'), 'jose pena'));

test('búsqueda: facturas y productos de la empresa activa; sin tildes; mínimo 2 letras', async () => {
  const num = (await gerente.get('/api/pos/ventas?estado=pagada')).body[0].numero_factura;
  const f = await gerente.get(`/api/busqueda?q=${encodeURIComponent(num.slice(-6))}`);
  assert.equal(f.status, 200);
  const gf = f.body.grupos.find((g) => g.id === 'facturas');
  assert.ok(gf && gf.items[0].titulo === num, 'encuentra la factura por parte de su número');
  assert.equal(gf.items[0].ruta, 'facturas');
  const p = await gerente.get('/api/busqueda?q=NARANJA');
  assert.ok(p.body.grupos.find((g) => g.id === 'productos').items.some((i) => i.titulo === 'Naranja Pura'));
  assert.deepEqual((await gerente.get('/api/busqueda?q=n')).body.grupos, []);
  assert.equal((await gerente.get('/api/busqueda?q=%25%25')).status, 200, 'los comodines se tratan como texto');
});

test('búsqueda: el cajero no ve empleados ni documentos; otra empresa no se mezcla', async () => {
  await t.usuario({ nombre: 'Zulema Cajera', accesos: [{ empresa: 'origen', rol: 'cajero', pin: '5678' }] });
  const r = await caja.get('/api/busqueda?q=Zulema');
  assert.equal(r.status, 200);
  assert.ok(!r.body.grupos.some((g) => ['empleados', 'documentos'].includes(g.id)));
  // El dueño buscando en Italo no ve las facturas de Origen.
  const italo = t.cli(await t.login('italo', 'dueno@grupo.hn', 'ClaveSegura123'), 'italo');
  const num = (await gerente.get('/api/pos/ventas?estado=pagada')).body[0].numero_factura;
  const x = await italo.get(`/api/busqueda?q=${encodeURIComponent(num.slice(-6))}`);
  assert.ok(!x.body.grupos.find((g) => g.id === 'facturas'));
});

