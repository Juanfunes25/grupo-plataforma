// Regla del dueño: la piedra de EcoStone se vende en cajas completas de 1 m². Nada de media caja ni venta porcionada.
// Italo / Origen / DISERCO no se tocan: siguen vendiendo por peso o por unidad donde aplica.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from './helpers.js';
import { sembrar } from '../src/db/sembrar.js';
import { dimensionarLinea } from '../src/modulos/eco/calculo.js';

let t, adm, origenCaja, eid, piedra, catOrigen, fpEco;

before(async () => {
  t = await iniciar();
  await sembrar(t.db, t.config.semillas, 'origen');
  await t.usuario({ nombre: 'Admin Eco', email: 'adm@eco.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'ecostone', rol: 'admin' }] });
  await t.usuario({ nombre: 'Cajera Origen', accesos: [{ empresa: 'origen', rol: 'cajero', pin: '1234' }] });
  adm = t.cli(await t.login('ecostone', 'adm@eco.hn', 'ClaveSegura123'), 'ecostone');
  origenCaja = t.cli(await t.loginPin('origen', '1234'), 'origen');
  eid = await t.empresaId('ecostone');
  fpEco = (await t.db.query(`select id from pos.formas_pago where empresa_id = $1 and tipo = 'efectivo'`, [eid])).rows[0].id;
  piedra = (await adm.post('/api/eco/productos', { tipo: 'piedra', nombre: 'Piedra Cajas', codigo: 'PC-1', modelo: 'Río', color: 'Gris', unidad_venta: 'm2', m2_por_caja: 1, precio: 230, impuesto_tasa: 0.15 })).body;
  catOrigen = (await origenCaja.get('/api/pos/catalogo')).body;
});
after(() => t.cerrar());

const venta = (cantidad, extra = {}) => adm.post('/api/pos/ventas', { items: [{ producto_id: piedra.id, cantidad }], confirmar_sin_stock: true, cobrar: { pagos: [{ forma_pago_id: fpEco, monto: 100000 }] }, ...extra });

test('venta POS de piedra: decimal rechazado con mensaje claro', async () => {
  for (const c of [1.5, 0.5, 2.25]) {
    const r = await venta(c);
    assert.equal(r.status, 400, `cantidad ${c}`);
    assert.match(JSON.stringify(r.body), /cajas completas de 1 m²/);
  }
});

test('venta POS de piedra: cero y negativos rechazados', async () => {
  assert.equal((await venta(0)).status, 400);
  assert.equal((await venta(-2)).status, 400);
});

test('venta POS de piedra: entero aceptado', async () => {
  const r = await venta(3);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(Number(r.body.total), 690);
});

test('orden guardada (sin cobrar) con decimal también se rechaza', async () => {
  const r = await adm.post('/api/pos/ventas', { items: [{ producto_id: piedra.id, cantidad: 1.5 }] });
  assert.equal(r.status, 400);
});

test('cotización: 10.5 m² → 11 cajas (hacia arriba); cero rechazado; cantidad decimal rechazada', async () => {
  const base = { nombre_cliente: 'Cliente Cajas' };
  const ok = await adm.post('/api/eco/cotizaciones', { ...base, lineas: [{ tipo: 'producto', producto_id: piedra.id, m2_neto: 10.5 }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const l = ok.body.lineas[0];
  assert.equal(Number(l.cantidad), 11); assert.equal(Number(l.cajas), 11);
  assert.equal((await adm.post('/api/eco/cotizaciones', { ...base, lineas: [{ tipo: 'producto', producto_id: piedra.id, m2_neto: 0 }] })).status, 400);
  const frac = await adm.post('/api/eco/cotizaciones', { ...base, lineas: [{ tipo: 'producto', producto_id: piedra.id, cantidad: 2.5 }] });
  assert.equal(frac.status, 400); assert.match(JSON.stringify(frac.body), /cajas completas de 1 m²/);
  assert.equal((await adm.post('/api/eco/cotizaciones', { ...base, lineas: [{ tipo: 'producto', producto_id: piedra.id, cantidad: 4 }] })).status, 201);
});

test('cálculo: redondeo hacia arriba y desperdicio sin fracciones', () => {
  const p = { m2_por_caja: 1, unidad_venta: 'm2' };
  assert.equal(dimensionarLinea(p, 10.5, 0).cantidad, 11);
  assert.equal(dimensionarLinea(p, 10, 5).cantidad, 11);      // 10.5 → 11
  assert.equal(dimensionarLinea(p, 0.2, 0).cantidad, 1);
  assert.ok(Number.isInteger(dimensionarLinea(p, 7.3, 7.5).cantidad));
});

test('inventario y producción de piedra: decimales rechazados, enteros aceptados', async () => {
  const aj = (m2) => adm.post('/api/eco/inventario/pt/ajuste', { producto_id: piedra.id, lote: 'L-CAJ', m2, motivo: 'prueba', tipo: 'inicial' });
  const d = await aj(2.5);
  assert.equal(d.status, 400); assert.match(JSON.stringify(d.body), /cajas completas/);
  assert.equal((await aj(10)).status, 201);
  const c = await adm.post('/api/eco/inventario/pt/conteo', { producto_id: piedra.id, lote: 'L-CAJ', contado: 9.5 });
  assert.equal(c.status, 400);
  assert.equal((await adm.post('/api/eco/inventario/pt/conteo', { producto_id: piedra.id, lote: 'L-CAJ', contado: 9 })).status, 200);
  const reg = await adm.post('/api/fab/registro', { producto_id: piedra.id, cantidad: 4.5 });
  assert.equal(reg.status, 400); assert.match(JSON.stringify(reg.body), /cajas completas/);
  assert.equal((await adm.post('/api/fab/ordenes', { producto_id: piedra.id, m2_planificado: 3.5 })).status, 400);
});

test('Origen no se afecta: sigue vendiendo por peso (decimal)', async () => {
  const mango = catOrigen.productos.find((p) => p.nombre === 'Mango (por kg)');
  const fp = catOrigen.formas_pago.find((f) => f.tipo === 'efectivo').id;
  const r = await origenCaja.post('/api/pos/ventas', { items: [{ producto_id: mango.id, cantidad: 1.35 }], cobrar: { pagos: [{ forma_pago_id: fp, monto: 100 }] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
});

test('solo la piedra tiene la regla: ningún producto de otras empresas es es_piedra', async () => {
  const { rows } = await t.db.query(`select count(*)::int as n from pos.productos p join core.empresas e on e.id = p.empresa_id where p.es_piedra and e.codigo <> 'ecostone'`);
  assert.equal(rows[0].n, 0);
});
