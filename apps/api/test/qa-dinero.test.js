// QA · dinero, bitácora y datos. Cubre lo que se rompe solo bajo carga o con datos raros:
//  · totales fiscales que SIEMPRE cuadran al centavo (barrido aleatorio de carritos);
//  · doble toque y cobros en paralelo: un número de factura por venta, sin huecos ni repetidos;
//  · montos absurdos → 400 en español (nunca 500);
//  · la cadena de hashes de la bitácora sigue íntegra con escrituras concurrentes;
//  · las semillas de Italo se pueden correr dos veces sin duplicar nada.
// Con TEST_PG_ADMIN_URL=postgres://usuario:clave@host:puerto corre contra un Postgres REAL (concurrencia de verdad).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { calcularTotales, round2 } from '@grupo/shared';
import { iniciar } from './helpers.js';
import { sembrar } from '../src/db/sembrar.js';
import { sembrarCatalogoItalo } from '../src/db/italo-catalogo.js';

let t, caja1, caja2, gerente, cat;
const prod = (n) => cat.productos.find((p) => p.nombre === n);
const fp = (tipo) => cat.formas_pago.find((f) => f.tipo === tipo).id;

before(async () => {
  t = await iniciar();
  await sembrar(t.db, t.config.semillas, 'origen');
  await t.usuario({ nombre: 'Caja 1', accesos: [{ empresa: 'origen', rol: 'cajero', pin: '1111' }] });
  await t.usuario({ nombre: 'Caja 2', accesos: [{ empresa: 'origen', rol: 'cajero', pin: '2222' }] });
  await t.usuario({ nombre: 'Gerente', email: 'g@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  caja1 = t.cli(await t.loginPin('origen', '1111'), 'origen');
  caja2 = t.cli(await t.loginPin('origen', '2222'), 'origen');
  gerente = t.cli(await t.login('origen', 'g@origen.hn', 'ClaveSegura123'), 'origen');
  cat = (await caja1.get('/api/pos/catalogo')).body;
});
after(() => t.cerrar());

test('totales: 40 000 carritos al azar cuadran al centavo (buckets + ISV = total = suma de líneas)', () => {
  const rnd = (a, b) => a + Math.random() * (b - a);
  for (let k = 0; k < 40000; k++) {
    const items = Array.from({ length: 1 + Math.floor(rnd(0, 6)) }, () => ({
      cantidad: Math.random() < 0.3 ? round2(rnd(0.01, 5)) : Math.floor(rnd(1, 30)), precio_base: round2(rnd(0, 500)), extras: Math.random() < 0.3 ? round2(rnd(0, 40)) : 0,
      impuesto_tasa: [0, 0.15, 0.18][Math.floor(rnd(0, 3))], exento: Math.random() < 0.5, descuento_porcentaje: [0, 10, 25][Math.floor(rnd(0, 3))] }));
    const x = calcularTotales(items, { exento_impuestos: Math.random() < 0.1 }, 0);
    const suma = round2(x.subtotal_exento + x.subtotal_exonerado + x.subtotal_gravado_15 + x.subtotal_gravado_18 + x.isv_total);
    assert.ok(Math.abs(suma - x.total) < 0.0001, `descuadre ${suma} vs ${x.total} en ${JSON.stringify(items)}`);
    assert.equal(round2(x.lineas.reduce((s, l) => s + l.monto, 0)), x.total);
  }
});

test('doble toque y cobros en paralelo: una factura por orden y números consecutivos sin repetir', async () => {
  const item = [{ producto_id: prod('Naranja Pura').id, cantidad: 1 }];
  const pagos = [{ forma_pago_id: fp('efectivo'), monto: 100 }];
  // doble toque sobre la misma orden
  const o = (await caja1.post('/api/pos/ventas', { items: item })).body;
  const toques = await Promise.all([1, 2, 3, 4].map(() => caja1.post(`/api/pos/ventas/${o.id}/cobrar`, { pagos })));
  assert.equal(toques.filter((r) => r.status === 200).length, 1);
  assert.ok(toques.filter((r) => r.status !== 200).every((r) => r.status === 409));
  // 24 cobros a la vez desde dos cajas
  const rs = await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? caja1 : caja2).post('/api/pos/ventas', { items: item, cobrar: { pagos } })));
  assert.ok(rs.every((r) => r.status === 201), JSON.stringify(rs.map((r) => r.status)));
  const nums = rs.map((r) => r.body.correlativo).sort((a, b) => a - b);
  assert.equal(new Set(nums).size, 24);
  assert.equal(nums[23] - nums[0], 23, 'hay huecos en el correlativo');
  const facturas = (await t.db.query(`select count(*)::int as n, count(distinct numero_factura)::int as d from pos.ventas where numero_factura is not null`)).rows[0];
  assert.equal(facturas.n, facturas.d);
});

test('montos y datos absurdos responden 400 en español (nunca 500)', async () => {
  const item = [{ producto_id: prod('Naranja Pura').id, cantidad: 1 }];
  for (const monto of [1e15, 99999999999, -5, 0]) {
    const r = await caja1.post('/api/pos/ventas', { items: item, cobrar: { pagos: [{ forma_pago_id: fp('efectivo'), monto }] } });
    assert.equal(r.status, 400, `monto ${monto}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(r.body.error);
  }
  const r = await caja1.post('/api/pos/ventas', { items: [{ ...item[0], cantidad: -2 }] });
  assert.equal(r.status, 400);
  assert.equal((await caja1.post('/api/pos/ventas', { items: [{ ...item[0], cantidad: 1000 }] })).status, 400);
  assert.equal((await caja1.post('/api/pos/ventas', { items: Array(101).fill(item[0]) })).status, 400);
  assert.equal((await caja1.post('/api/pos/ventas', { items: [{ ...item[0], descuento_porcentaje: 'abc' }] })).status, 400);
});

test('la bitácora mantiene su cadena de hashes con 120 escrituras concurrentes', async () => {
  await Promise.all(Array.from({ length: 120 }, (_, i) => t.db.tx(async (q) => {
    await q.query(`insert into core.auditoria (accion, entidad, detalle) values ($1, 'qa', '{}'::jsonb)`, [`qa_${i}`]);
    await q.query(`insert into core.auditoria (accion, entidad, detalle) values ($1, 'qa', '{}'::jsonb)`, [`qa_${i}_b`]);
  })));
  const v = (await t.db.query('select * from core.verificar_auditoria()')).rows[0];
  assert.equal(v.integra, true, `cadena rota en el id ${v.primer_id_alterado}`);
  assert.ok(v.total >= 240);
});

test('semillas: el catálogo de Italo se puede cargar dos veces sin duplicar y los mínimos nunca son negativos', async () => {
  const cuenta = async () => ({
    productos: (await t.db.query('select count(*)::int as n from pos.productos')).rows[0].n,
    clientes: (await t.db.query('select count(*)::int as n from core.terceros')).rows[0].n,
    categorias: (await t.db.query('select count(*)::int as n from pos.categorias')).rows[0].n,
  });
  await sembrarCatalogoItalo(t.db);
  const a = await cuenta();
  const otra = await sembrarCatalogoItalo(t.db);
  assert.deepEqual(await cuenta(), a);
  assert.equal(otra.productos, 0);
  assert.equal((await t.db.query('select count(*)::int as n from pos.productos where stock_minimo < 0')).rows[0].n, 0);
});

test('el cierre de caja no cuenta ventas anuladas y cuadra con los pagos netos', async () => {
  const item = [{ producto_id: prod('Piña Fresca').id, cantidad: 2 }];
  const venta = async (pagos) => (await caja1.post('/api/pos/ventas', { items: item, cobrar: { pagos } })).body;
  const desde = new Date(Date.now() - 3600_000).toISOString();
  const a = await venta([{ forma_pago_id: fp('efectivo'), monto: 200 }]);          // total 160, cambio 40
  const b = await venta([{ forma_pago_id: fp('tarjeta'), monto: 160 }]);
  const c = await venta([{ forma_pago_id: fp('efectivo'), monto: 160 }]);
  assert.equal((await gerente.post(`/api/pos/ventas/${c.id}/anular`, { motivo: 'Error al cobrar' })).status, 200);
  const hasta = new Date(Date.now() + 60_000).toISOString();
  const g = await gerente.get(`/api/pos/cierres/resumen?desde=${encodeURIComponent(desde)}&hasta=${encodeURIComponent(hasta)}`);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const db = async (tipo) => Number((await t.db.query(
    `select coalesce(sum(p.monto),0) as m from pos.venta_pagos p join pos.formas_pago f on f.id = p.forma_pago_id join pos.ventas v on v.id = p.venta_id
      where v.estado = 'pagada' and v.fecha_emision >= $1 and v.fecha_emision <= $2 and f.tipo = $3`, [desde, hasta, tipo])).rows[0].m);
  assert.equal(g.body.efectivo, round2(await db('efectivo')));      // neto: sin el cambio y sin la anulada
  assert.equal(g.body.tarjeta, round2(await db('tarjeta')));
  assert.ok(g.body.anuladas >= 1);
  assert.equal(a.cambio, 40);
  assert.equal(b.cambio ?? null, null);
  // el cajero (cierre a ciegas) solo recibe los datos que no revelan el esperado
  const ciega = await caja1.get(`/api/pos/cierres/resumen?desde=${encodeURIComponent(desde)}&hasta=${encodeURIComponent(hasta)}`);
  assert.equal(ciega.body.ciego, true);
  assert.equal(ciega.body.efectivo, undefined);
});

test('pedido de insumos de la tienda: un reintento del MISMO envío (cola sin señal) no duplica los artículos', async () => {
  const sucMackey = await t.sucursalId('italo', 'mackey');
  await t.usuario({ nombre: 'Caja Mackey', accesos: [{ empresa: 'italo', rol: 'cajero', pin: '4821', sucursal_ids: [sucMackey] }] });
  const tienda = t.cli(await t.loginPin('italo', '4821'), 'italo');
  const fecha = new Date().toISOString().slice(0, 10);
  const cuerpo = { sucursal_id: sucMackey, fecha, cliente_id: 'envio-1', items: [{ insumo_texto: 'Vasos 8oz', cantidad: '2 cajas' }] };
  const a = await tienda.post('/api/rep/pedidos', cuerpo);
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const [b, c] = await Promise.all([tienda.post('/api/rep/pedidos', cuerpo), tienda.post('/api/rep/pedidos', cuerpo)]);   // reintento + doble sincronización
  assert.equal(b.body.duplicado, true);
  assert.equal(c.body.duplicado, true);
  const n = (await t.db.query(`select count(*)::int as n from rep.pedido_items where pedido_id = $1`, [a.body.id])).rows[0].n;
  assert.equal(n, 1, 'el reintento sumó otra vez los artículos');
  // otro envío distinto (otro cliente_id) SÍ se suma al pedido abierto, como siempre
  const d = await tienda.post('/api/rep/pedidos', { ...cuerpo, cliente_id: 'envio-2', items: [{ insumo_texto: 'Servilletas' }] });
  assert.equal(d.status, 200);
  assert.equal((await t.db.query(`select count(*)::int as n from rep.pedido_items where pedido_id = $1`, [a.body.id])).rows[0].n, 2);
});
