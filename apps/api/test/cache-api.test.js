import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { iniciar } from './helpers.js';
import { sembrar } from '../src/db/sembrar.js';
import { crearApp } from '../src/app.js';
import { crearCache } from '../src/lib/cache.js';

// Caché de lecturas pesadas: acierta, nunca mezcla personas ni empresas y se borra con cualquier cambio.

let t, base, srv, tokOrigen, tokCaja, tokGerente, tokItalo;
const llamar = async (token, empresa, ruta, { metodo = 'GET', cuerpo } = {}) => {
  const r = await fetch(base + ruta, { method: metodo, headers: { authorization: `Bearer ${token}`, 'x-empresa': empresa, 'content-type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  return { status: r.status, cache: r.headers.get('x-cache'), body: await r.json().catch(() => null) };
};

before(async () => {
  t = await iniciar();
  await sembrar(t.db, t.config.semillas, 'origen');
  await t.usuario({ nombre: 'Dueño', email: 'dueno@grupo.hn', password: 'ClaveSegura123', dueno: true });
  await t.usuario({ nombre: 'Gerente', email: 'ger@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Cajera', accesos: [{ empresa: 'origen', rol: 'cajero', pin: '1234' }] });
  await t.usuario({ nombre: 'Bodega', accesos: [{ empresa: 'origen', rol: 'bodega', pin: '5678' }] });
  const app = crearApp({ db: t.db, config: { ...t.config, cacheApi: true }, log: () => {} });
  srv = app.listen(0); await once(srv, 'listening');
  base = `http://127.0.0.1:${srv.address().port}`;
  tokOrigen = await t.login('origen', 'dueno@grupo.hn', 'ClaveSegura123');
  tokGerente = await t.login('origen', 'ger@origen.hn', 'ClaveSegura123');
  tokCaja = await t.loginPin('origen', '1234');
  tokItalo = tokOrigen;   // el dueño del grupo también entra a Italo
});
after(async () => { srv.close(); await t.cerrar(); });

test('la versión del catálogo y el catálogo se sirven de la caché y se renuevan al cambiar un precio', async () => {
  const a = await llamar(tokCaja, 'origen', '/api/pos/catalogo/version');
  const b = await llamar(tokCaja, 'origen', '/api/pos/catalogo/version');
  assert.equal(a.cache, 'MISS'); assert.equal(b.cache, 'HIT');
  assert.deepEqual(a.body, b.body);
  const c1 = await llamar(tokCaja, 'origen', '/api/pos/catalogo');
  assert.equal((await llamar(tokCaja, 'origen', '/api/pos/catalogo')).cache, 'HIT');
  // otra persona con las mismas sucursales comparte el catálogo (es de la empresa, no de la persona)
  assert.equal((await llamar(tokGerente, 'origen', '/api/pos/catalogo')).cache, 'HIT');
  // el gerente cambia un precio → se borra y llega el precio nuevo
  const p = c1.body.productos[0];
  const m = await llamar(tokGerente, 'origen', `/api/pos/catalogo/admin/productos/${p.id}`, { metodo: 'PUT', cuerpo: { nombre: p.nombre, precio: Number(p.precio) + 5, impuesto_tasa: p.impuesto_tasa } });
  assert.ok(m.status < 300, JSON.stringify(m.body));
  const d = await llamar(tokCaja, 'origen', '/api/pos/catalogo');
  assert.equal(d.cache, 'MISS');
  assert.equal(Number(d.body.productos.find((x) => x.id === p.id).precio), Number(p.precio) + 5);
  assert.notEqual((await llamar(tokCaja, 'origen', '/api/pos/catalogo/version')).body.v, a.body.v);
});

test('quien no tiene el permiso no recibe nada de la caché (403 aunque la respuesta esté guardada)', async () => {
  await llamar(tokGerente, 'origen', '/api/pos/dashboard');
  assert.equal((await llamar(tokGerente, 'origen', '/api/pos/dashboard')).cache, 'HIT');
  assert.equal((await llamar(tokCaja, 'origen', '/api/pos/dashboard')).status, 403);
  const bodega = await t.loginPin('origen', '5678');
  assert.equal((await llamar(bodega, 'origen', '/api/pos/catalogo/version')).status, 403);
});

test('el dashboard es por persona y empresa: ningún dato cruza; una venta nueva lo renueva', async () => {
  const antes = await llamar(tokGerente, 'origen', '/api/pos/dashboard');
  assert.equal((await llamar(tokGerente, 'origen', '/api/pos/dashboard')).cache, 'HIT');
  // el dueño tiene su propia entrada (mismo URL, otra persona)
  assert.equal((await llamar(tokOrigen, 'origen', '/api/pos/dashboard')).cache, 'MISS');
  // Italo no ve lo de Origen
  const it = await llamar(tokItalo, 'italo', '/api/pos/dashboard');
  assert.equal(it.cache, 'MISS');
  assert.equal(it.body.cantidad_facturas, 0);
  // venta en Origen → el dashboard de Origen se renueva; el de Italo sigue en caché
  const cat = (await llamar(tokCaja, 'origen', '/api/pos/catalogo')).body;
  const v = await llamar(tokCaja, 'origen', '/api/pos/ventas', { metodo: 'POST', cuerpo: { items: [{ producto_id: cat.productos[0].id, cantidad: 1 }], cobrar: { pagos: [{ forma_pago_id: cat.formas_pago.find((f) => f.tipo === 'efectivo').id, monto: 500 }] } } });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  const despues = await llamar(tokGerente, 'origen', '/api/pos/dashboard');
  assert.equal(despues.cache, 'MISS');
  assert.equal(despues.body.cantidad_facturas, antes.body.cantidad_facturas + 1);
  assert.equal((await llamar(tokItalo, 'italo', '/api/pos/dashboard')).cache, 'HIT');
});

test('un cambio en cualquier empresa borra los tableros de Dirección', async () => {
  await llamar(tokOrigen, 'origen', '/api/grupo/resumen');
  assert.equal((await llamar(tokOrigen, 'origen', '/api/grupo/resumen')).cache, 'HIT');
  const cat = (await llamar(tokCaja, 'origen', '/api/pos/catalogo')).body;
  await llamar(tokCaja, 'origen', '/api/pos/ventas', { metodo: 'POST', cuerpo: { items: [{ producto_id: cat.productos[0].id, cantidad: 1 }], cobrar: { pagos: [{ forma_pago_id: cat.formas_pago.find((f) => f.tipo === 'efectivo').id, monto: 500 }] } } });
  assert.equal((await llamar(tokOrigen, 'origen', '/api/grupo/resumen')).cache, 'MISS');
});

test('sin sesión no hay caché; los errores no se guardan; las lecturas de otras rutas no se cachean', async () => {
  const r = await fetch(`${base}/api/pos/catalogo/version`);
  assert.equal(r.status, 401);
  assert.equal(r.headers.get('x-cache'), null);
  assert.equal((await llamar(tokGerente, 'origen', '/api/pos/ventas')).cache, null);
  assert.equal((await llamar(tokGerente, 'origen', '/api/pos/dashboard?desde=malo')).status, 400);
});

test('unidad: vence por tiempo, tope de tamaño y no guarda si hubo un cambio mientras se calculaba', () => {
  let reloj = 1000;
  const c = crearCache({ ahora: () => reloj, max: 2 });
  const req = (url, metodo = 'GET') => ({ method: metodo, originalUrl: url, ctx: { empresa: { id: 'e1' }, usuario: { id: 'u1' }, sucursalIds: [], permisos: new Set(['pos:reportes']) } });
  const res = () => { const h = {}; const r = { statusCode: 200, headers: h, setHeader: (k, v) => { h[k] = v; }, on(ev, f) { r.fin = f; }, json: (b) => b, type() { return r; }, send: (b) => ({ hit: b }) }; return r; };
  const pasar = (rq, rs) => { let paso = false; c.middleware(rq, rs, () => { paso = true; }); return paso; };
  const r1 = res(); assert.equal(pasar(req('/api/pos/dashboard'), r1), true); r1.json({ a: 1 });
  const r2 = res(); assert.equal(pasar(req('/api/pos/dashboard'), r2), false);   // acierto: no llega a la ruta
  reloj += 31_000;
  const r3 = res(); assert.equal(pasar(req('/api/pos/dashboard'), r3), true);   // venció
  // cambio durante el cálculo → no se guarda
  const r4 = res(); pasar(req('/api/pos/reportes/resumen'), r4); c.invalidar('e1'); r4.json({ x: 1 });
  assert.equal(pasar(req('/api/pos/reportes/resumen'), res()), true);
  assert.ok(c.stats().entradas <= 2);
});
