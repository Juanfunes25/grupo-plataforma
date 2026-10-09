import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fechaHN, sumarDias } from '@grupo/shared';
import { iniciar } from './helpers.js';
import { sembrar } from '../src/db/sembrar.js';
import { aLempiras, diasEntre, estadoTrasRecepcion, saldosPorRecepcion, sugerirCantidad, totalesOrden, variacionDolarizada, variacionPct } from '../src/modulos/compras/calculo.js';
import { armarFlujo, bucketCobrar, bucketPagar, estadoLinea, limitesMes, netearSaldos, resumirCobrar } from '../src/modulos/fin/estados.js';
import { consolidar } from '../src/modulos/fin/consolidado.js';

let t, duenoO, duenoE, gerO, cajera, eidO, eidE, sucO, provO, provE;
const hoy = fechaHN();

before(async () => {
  t = await iniciar();
  await sembrar(t.db, t.config.semillas, 'origen');
  await t.usuario({ nombre: 'Dueño', email: 'dueno@grupo.hn', password: 'ClaveSegura123', dueno: true });
  await t.usuario({ nombre: 'Gerente', email: 'ger@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Cajera', accesos: [{ empresa: 'origen', rol: 'cajero', pin: '1234' }] });
  const tok = await t.login('origen', 'dueno@grupo.hn', 'ClaveSegura123');
  duenoO = t.cli(tok, 'origen'); duenoE = t.cli(tok, 'ecostone');
  gerO = t.cli(await t.login('origen', 'ger@origen.hn', 'ClaveSegura123'), 'origen');
  cajera = t.cli(await t.loginPin('origen', '1234'), 'origen');
  eidO = await t.empresaId('origen'); eidE = await t.empresaId('ecostone');
  sucO = (await t.db.query('select id from core.sucursales where empresa_id = $1 order by orden limit 1', [eidO])).rows[0].id;
  provO = (await duenoO.post('/api/compras/proveedores', { nombre: 'Frutas del Valle', correo: 'ventas@frutas.hn' })).body;
  provE = (await duenoE.post('/api/compras/proveedores', { nombre: 'Pigmentos Centroamérica', rtn: '08011999123456' })).body;
});
after(() => t.cerrar());

// ── Reglas puras ─────────────────────────────────────────────────────────────
test('compras: totales, dólares, variación y estado se calculan bien', () => {
  const tot = totalesOrden([{ cantidad: 10, precio_unitario: 12.5 }, { cantidad: 3, precio_unitario: 0.333 }], 15);
  assert.deepEqual(tot, { subtotal: 126, isv: 18.9, total: 144.9 });
  assert.equal(aLempiras(4, 'USD', 26.3), 105.2);
  assert.equal(aLempiras(105, 'HNL', 26.3), 105);
  assert.equal(variacionPct(110, 100), 10);
  assert.equal(variacionPct(90, 100), -10);
  assert.equal(variacionPct(5, 0), null);
  // cambio de precio y de tipo de cambio por separado: 4 US$ a 26 → 4.4 US$ a 27 = +10 % en dólares y +3.8 % de cambio
  const v = variacionDolarizada({ moneda: 'USD', precio: 4.4, tipo_cambio: 27, precio_lps: 118.8 }, { moneda: 'USD', precio: 4, tipo_cambio: 26, precio_lps: 104 });
  assert.equal(v.usd_pct, 10); assert.equal(v.cambio_pct, 3.8); assert.equal(v.total_pct, 14.2);
  assert.equal(variacionDolarizada({ moneda: 'HNL' }, { moneda: 'USD' }), null);
  assert.equal(estadoTrasRecepcion([{ cantidad: 5, cantidad_recibida: 5 }, { cantidad: 2, cantidad_recibida: 1 }]), 'recibida_parcial');
  assert.equal(estadoTrasRecepcion([{ cantidad: 5, cantidad_recibida: 5 }]), 'recibida');
  assert.equal(diasEntre('2026-09-01', '2026-09-30'), 29);
});

test('reorden: pide hasta el máximo (o el doble del mínimo) menos lo que ya viene en camino', () => {
  assert.equal(sugerirCantidad({ stock: 2, minimo: 5 }), 8);                       // objetivo 10
  assert.equal(sugerirCantidad({ stock: 2, minimo: 5, maximo: 20 }), 18);
  assert.equal(sugerirCantidad({ stock: 2, minimo: 5, enCamino: 8 }), 0);          // ya viene
  assert.equal(sugerirCantidad({ stock: 9, minimo: 5 }), 0);
  assert.equal(sugerirCantidad({ stock: null, minimo: 5 }), 0);                    // sin conteo: no se adivina
  assert.equal(sugerirCantidad({ stock: 1, minimo: 0 }), 0);
});

test('por pagar: los pagos se aplican a la recepción más vieja; antigüedades y vencimientos', () => {
  const s = saldosPorRecepcion([{ id: 'b', fecha: '2026-09-10', total_lps: 500 }, { id: 'a', fecha: '2026-09-01', total_lps: 300 }], 400);
  assert.deepEqual(s.map((x) => [x.id, x.saldo]), [['b', 400]]);                    // a pagada completa, b abonada 100
  assert.equal(saldosPorRecepcion([{ id: 'a', fecha: '2026-09-01', total_lps: 300 }], 300).length, 0);
  assert.equal(bucketCobrar(30), '0-30'); assert.equal(bucketCobrar(31), '31-60'); assert.equal(bucketCobrar(90), '61-90'); assert.equal(bucketCobrar(91), '+90');
  assert.equal(bucketPagar(-1), 'vencido'); assert.equal(bucketPagar(0), '0-7'); assert.equal(bucketPagar(8), '8-30'); assert.equal(bucketPagar(31), '+30');
  const r = resumirCobrar([{ cliente: 'A', cliente_id: 'a', saldo: 100, bucket: '0-30', vencida: false }, { cliente: 'A', cliente_id: 'a', saldo: 50, bucket: '+90', vencida: true }, { cliente: 'B', cliente_id: 'b', saldo: 10, bucket: '31-60', vencida: false }]);
  assert.equal(r.total, 160); assert.equal(r.buckets['+90'], 50); assert.equal(r.vencido, 50); assert.equal(r.por_cliente[0].saldo, 150);
});

test('flujo de caja: arma periodos, totales y acumulado', () => {
  const f = armarFlujo([
    { lado: 'entrada', concepto: 'Ventas en efectivo', periodo: '2026-09-01', monto: 1000 }, { lado: 'entrada', concepto: 'Ventas en efectivo', periodo: '2026-10-01', monto: 500 },
    { lado: 'salida', concepto: 'Gastos: Alquiler', periodo: '2026-09-01', monto: 300 }, { lado: 'salida', concepto: 'Gastos: Alquiler', periodo: '2026-10-01', monto: 900 },
  ], { desde: '2026-09-01', hasta: '2026-10-31', agrupar: 'mes' });
  assert.deepEqual(f.serie.map((s) => [s.neto, s.acumulado]), [[700, 700], [-400, 300]]);
  assert.deepEqual(f.totales, { entradas: 1500, salidas: 1200, neto: 300 });
});

test('presupuesto: gasto excedido o en riesgo; ventas por debajo del ritmo; límites del mes', () => {
  assert.equal(estadoLinea({ tipo: 'gasto', presupuesto: 100, real: 120, proyeccion: 300 }), 'excedido');
  assert.equal(estadoLinea({ tipo: 'gasto', presupuesto: 100, real: 50, proyeccion: 130 }), 'riesgo');
  assert.equal(estadoLinea({ tipo: 'gasto', presupuesto: 100, real: 40, proyeccion: 80 }), 'ok');
  assert.equal(estadoLinea({ tipo: 'ventas', presupuesto: 1000, real: 300, proyeccion: 800 }), 'bajo');
  assert.equal(estadoLinea({ tipo: 'ventas', presupuesto: 1000, real: 300, proyeccion: 950 }), 'riesgo');
  assert.equal(estadoLinea({ tipo: 'gasto', presupuesto: 0, real: 10, proyeccion: 10 }), 'sin_presupuesto');
  assert.deepEqual(limitesMes('2026-02'), { ini: '2026-02-01', fin: '2026-02-28', dias: 28 });
});

test('intercompañía: los saldos de una pareja se compensan y se consolida sin contar dos veces', () => {
  const s = netearSaldos([
    { empresa_origen_id: 'B', empresa_destino_id: 'A', monto: 100, monto_pagado: 0, estado: 'pendiente' },     // A le debe 100 a B
    { empresa_origen_id: 'A', empresa_destino_id: 'B', monto: 30, monto_pagado: 0, estado: 'conciliado' },     // B le debe 30 a A
    { empresa_origen_id: 'A', empresa_destino_id: 'C', monto: 50, monto_pagado: 50, estado: 'conciliado' },    // saldada
  ]);
  assert.deepEqual(s, [{ deudor: 'A', acreedor: 'B', saldo: 70, operaciones: 2, sin_conciliar: 1 }]);
  const empresa = (v, c, g) => ({ resultados: { facturas: 1, ventas_netas: v, costo_ventas: c, utilidad_bruta: v - c, gastos_operativos: g, utilidad_operativa: v - c - g }, flujo: { entradas: 0, salidas: 0, neto: 0 },
    cobrar: { buckets: { '0-30': 0, '31-60': 0, '61-90': 0, '+90': 0 }, total: 0, vencido: 0 }, pagar: { buckets: { vencido: 0, '0-7': 0, '8-30': 0, '+30': 0 }, total: 0, vencido: 0 } });
  const c = consolidar([empresa(1000, 400, 100), empresa(500, 200, 50)], 200);
  assert.equal(c.ventas_consolidadas, 1300); assert.equal(c.costos_y_gastos_consolidados, 550);
  assert.equal(c.utilidad_consolidada, 750);                       // igual que la suma de las utilidades: eliminar no cambia el resultado
  assert.equal(c.resultados.utilidad_operativa, 750);
});

// ── Orden de compra de punta a punta (Origen · inventario) ───────────────────
async function fresa() { return (await duenoO.get('/api/inv/insumos')).body.find((i) => i.nombre === 'Fresa'); }

test('orden de compra: borrador → enviada → recibida parcial → recibida → cerrada alimenta inventario y precios', async () => {
  const f = await fresa();
  const stock0 = f.stock;
  let r = await gerO.post('/api/compras/ordenes', { proveedor_id: provO.id, sucursal_id: sucO, condicion: 'contado', fecha_esperada: hoy, lineas: [{ origen: 'inv', item_id: f.id, cantidad: 10, precio_unitario: 120 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const oc = r.body;
  assert.equal(oc.estado, 'borrador'); assert.equal(oc.total, 1200); assert.equal(oc.numero, 1);
  assert.equal((await gerO.post(`/api/compras/ordenes/${oc.id}/recibir`, { lineas: [{ linea_id: oc.lineas[0].id, cantidad: 1 }] })).status, 409);   // aún no se envía
  assert.equal((await cajera.get('/api/compras/ordenes')).status, 403);
  r = await gerO.put(`/api/compras/ordenes/${oc.id}`, { proveedor_id: provO.id, sucursal_id: sucO, lineas: [{ origen: 'inv', item_id: f.id, cantidad: 10, precio_unitario: 130 }] });
  assert.equal(r.body.total, 1300);
  r = await gerO.post(`/api/compras/ordenes/${oc.id}/enviar`, {});
  assert.equal(r.status, 200); assert.equal(r.body.orden.estado, 'enviada');
  assert.equal((await gerO.put(`/api/compras/ordenes/${oc.id}`, { proveedor_id: provO.id, sucursal_id: sucO, lineas: [{ origen: 'inv', item_id: f.id, cantidad: 1, precio_unitario: 1 }] })).status, 409);
  const linea = r.body.orden.lineas[0];

  r = await gerO.post(`/api/compras/ordenes/${oc.id}/recibir`, { documento: 'F-900', lineas: [{ linea_id: linea.id, cantidad: 4, precio_unitario: 140 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.estado, 'recibida_parcial');
  assert.equal(r.body.lineas[0].variacion_pct, null);                                           // primera compra: nada con qué comparar
  assert.equal((await fresa()).stock, stock0 + 4);
  assert.equal((await fresa()).costo_actual, 140);                                              // costo = lo facturado, no lo ordenado
  const comp = (await t.db.query('select * from inv.compras where recepcion_id is not null')).rows;
  assert.equal(comp.length, 1); assert.equal(Number(comp[0].total), 560); assert.equal(comp[0].numero_documento, 'F-900');
  assert.equal((await gerO.post(`/api/compras/ordenes/${oc.id}/recibir`, { lineas: [{ linea_id: linea.id, cantidad: 7 }] })).status, 409);   // solo faltan 6

  r = await gerO.post(`/api/compras/ordenes/${oc.id}/recibir`, { lineas: [{ linea_id: linea.id, cantidad: 6, precio_unitario: 154 }] });
  assert.equal(r.body.estado, 'recibida');
  assert.equal(r.body.lineas[0].variacion_pct, 10);                                             // 154 contra 140
  r = await gerO.post(`/api/compras/ordenes/${oc.id}/cerrar`, {});
  assert.equal(r.body.estado, 'cerrada');
  assert.equal((await gerO.post(`/api/compras/ordenes/${oc.id}/anular`, { motivo: 'prueba' })).status, 409);

  const p = (await gerO.get(`/api/compras/precios?item_id=${f.id}&origen=inv`)).body;
  assert.equal(p.historial.length, 2);
  assert.equal(p.resumen.proveedores[0].variacion_pct, 10);
  const mod = await t.db.query(`update cmp.precios set precio = 1 where true`).then(() => 'edita', (e) => e.message);
  assert.match(mod, /no se edita/);                                                              // el historial de precios es inalterable
  const bit = (await t.db.query(`select accion from core.auditoria where accion like 'oc_%' order by id`)).rows.map((x) => x.accion);
  assert.deepEqual(bit, ['oc_creada', 'oc_editada', 'oc_enviada', 'oc_recibida', 'oc_recibida', 'oc_cerrada']);
});

test('orden anulada en borrador; sin permiso no se crea; ítems repetidos se rechazan', async () => {
  const f = await fresa();
  const base = { proveedor_id: provO.id, sucursal_id: sucO, lineas: [{ origen: 'inv', item_id: f.id, cantidad: 1, precio_unitario: 10 }] };
  assert.equal((await cajera.post('/api/compras/ordenes', base)).status, 403);
  assert.equal((await duenoO.post('/api/compras/ordenes', { ...base, lineas: [...base.lineas, ...base.lineas] })).status, 400);
  assert.equal((await duenoO.post('/api/compras/ordenes', { ...base, moneda: 'USD' })).status, 400);        // dólares sin tipo de cambio
  const oc = (await duenoO.post('/api/compras/ordenes', base)).body;
  assert.equal((await duenoO.post(`/api/compras/ordenes/${oc.id}/anular`, { motivo: 'ya no hace falta' })).body.estado, 'anulada');
  assert.equal((await duenoO.get(`/api/compras/ordenes?estado=anulada`)).body.length, 1);
  // un ítem de otra empresa no se puede pedir
  const ajeno = (await duenoE.get('/api/compras/catalogo')).body.find((i) => i.origen === 'fab');
  assert.equal((await duenoO.post('/api/compras/ordenes', { ...base, lineas: [{ origen: 'fab', item_id: ajeno.id, cantidad: 1, precio_unitario: 1 }] })).status, 404);
});

// ── EcoStone: dólares y costo promedio ───────────────────────────────────────
test('EcoStone: compra en dólares con tipo de cambio del día, costo promedio y variación por cambio', async () => {
  const cat = (await duenoE.get('/api/compras/catalogo')).body;
  const pig = cat.find((i) => i.origen === 'fab' && /rojo/i.test(i.nombre));
  assert.ok(pig);
  assert.equal((await duenoE.get('/api/compras/config')).body.tipo_cambio_sugerido.valor, 26.3);   // el de la configuración de la fábrica
  const comprar = async (precio, tcOrden, tcFactura, cantidad) => {
    const oc = (await duenoE.post('/api/compras/ordenes', { proveedor_id: provE.id, moneda: 'USD', tipo_cambio: tcOrden, lineas: [{ origen: 'fab', item_id: pig.id, cantidad, precio_unitario: precio }] })).body;
    await duenoE.post(`/api/compras/ordenes/${oc.id}/enviar`, {});
    return duenoE.post(`/api/compras/ordenes/${oc.id}/recibir`, { tipo_cambio: tcFactura, documento: `F-${precio}`, lineas: [{ linea_id: oc.lineas[0].id, cantidad }] });
  };
  let r = await comprar(4, 26, 26.3, 10);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.lineas[0].costo_resultante, 105.2);                                     // 4 US$ × 26.30
  r = await comprar(4.4, 26, 27, 10);                                                          // sube el precio y sube el cambio
  assert.equal(r.status, 201);
  assert.equal(r.body.lineas[0].costo_resultante, (105.2 + 118.8) / 2);                      // promedio ponderado de fab.mover_insumo
  assert.deepEqual(r.body.lineas[0].variacion_dolar, { total_pct: 12.9, usd_pct: 10, cambio_pct: 2.7 });
  const mov = (await t.db.query(`select recepcion_id, moneda, tipo_cambio from fab.mov_insumos where insumo_id = $1 and tipo = 'compra' order by id desc limit 1`, [pig.id])).rows[0];
  assert.ok(mov.recepcion_id); assert.equal(mov.moneda, 'USD'); assert.equal(Number(mov.tipo_cambio), 27);
  assert.equal((await duenoE.get('/api/compras/config')).body.tipo_cambio_sugerido.valor, 27);   // ahora sugiere la última usada
});

test('Italo fábrica (Mec3): la recepción sube el stock, abre lote y deja el precio por kg', async () => {
  const eidI = await t.empresaId('italo');
  const duenoI = t.cli(await t.login('italo', 'dueno@grupo.hn', 'ClaveSegura123'), 'italo');
  const ins = (await t.db.query(`insert into rinv.insumos_fab (empresa_id, nombre, tipo, unidad, peso_unitario, stock_actual) values ($1,'PASTA PISTACHO','mec3','unidad',3,2) returning id`, [eidI])).rows[0].id;
  await t.db.query(`insert into prod.costeo_insumos (empresa_id, nombre, tipo) values ($1,'PASTA PISTACHO','mec3')`, [eidI]);
  const prov = (await duenoI.post('/api/compras/proveedores', { nombre: 'MEC3 Importaciones' })).body;
  const oc = (await duenoI.post('/api/compras/ordenes', { proveedor_id: prov.id, moneda: 'USD', tipo_cambio: 26.3, lineas: [{ origen: 'rinv_fab', item_id: ins, cantidad: 4, precio_unitario: 60 }] })).body;
  await duenoI.post(`/api/compras/ordenes/${oc.id}/enviar`, {});
  const r = await duenoI.post(`/api/compras/ordenes/${oc.id}/recibir`, { tipo_cambio: 26.5, documento: 'FAC-MEC3-1', lineas: [{ linea_id: oc.lineas[0].id, cantidad: 4 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const fila = (await t.db.query('select stock_actual from rinv.insumos_fab where id = $1', [ins])).rows[0];
  assert.equal(Number(fila.stock_actual), 6);
  assert.equal((await t.db.query('select 1 from rinv.lotes_mec3 where insumo_id = $1', [ins])).rowCount, 1);
  const pr = (await t.db.query('select lps_kg, usd_kg, tipo_cambio_usado, fuente from rinv.precios_fab where insumo_id = $1', [ins])).rows[0];
  assert.equal(Number(pr.usd_kg), 20); assert.equal(Number(pr.lps_kg), 530); assert.equal(Number(pr.tipo_cambio_usado), 26.5); assert.equal(pr.fuente, 'factura_mec3');
  const costeo = (await t.db.query(`select p.lps_kg from prod.costeo_precios p join prod.costeo_insumos i on i.id = p.insumo_id where i.nombre = 'PASTA PISTACHO'`)).rows[0];
  assert.equal(Number(costeo.lps_kg), 530);                                                    // el costeo del gelato se entera del nuevo precio
  assert.equal((await t.db.query(`select count(*)::int as n from rinv.movimientos where insumo_fab_id = $1 and tipo = 'entrada'`, [ins])).rows[0].n, 1);
});

test('DISERCO: la compra entra con dis.mover y exige unidades enteras', async () => {
  const eidD = await t.empresaId('diserco');
  const duenoD = t.cli(await t.login('diserco', 'dueno@grupo.hn', 'ClaveSegura123'), 'diserco');
  const p = (await t.db.query(`insert into pos.productos (empresa_id, codigo, nombre, precio, unidad) values ($1,'D-1','Sellador 1 gal',100,'galón') returning id`, [eidD])).rows[0].id;
  await t.db.query('insert into dis.producto_ext (producto_id, empresa_id) values ($1,$2)', [p, eidD]);
  const prov = (await duenoD.post('/api/compras/proveedores', { nombre: 'Química Industrial' })).body;
  const oc = (await duenoD.post('/api/compras/ordenes', { proveedor_id: prov.id, lineas: [{ origen: 'dis', item_id: p, cantidad: 5.5, precio_unitario: 40 }] })).body;
  await duenoD.post(`/api/compras/ordenes/${oc.id}/enviar`, {});
  assert.equal((await duenoD.post(`/api/compras/ordenes/${oc.id}/recibir`, { lineas: [{ linea_id: oc.lineas[0].id, cantidad: 5.5 }] })).status, 400);
  const oc2 = (await duenoD.post('/api/compras/ordenes', { proveedor_id: prov.id, lineas: [{ origen: 'dis', item_id: p, cantidad: 6, precio_unitario: 40 }] })).body;
  await duenoD.post(`/api/compras/ordenes/${oc2.id}/enviar`, {});
  assert.equal((await duenoD.post(`/api/compras/ordenes/${oc2.id}/recibir`, { lineas: [{ linea_id: oc2.lineas[0].id, cantidad: 6 }] })).status, 201);
  const ex = (await t.db.query('select existencia from dis.existencias where producto_id = $1', [p])).rows[0];
  assert.equal(Number(ex.existencia), 6);
  assert.equal(Number((await t.db.query('select costo_estandar from dis.producto_ext where producto_id = $1', [p])).rows[0].costo_estandar), 40);
});

test('reorden: lo que está bajo el mínimo aparece con cantidad sugerida y se descuenta lo que viene en camino', async () => {
  const f = await fresa();
  await t.db.query('update inv.insumos set stock_minimo = 500 where id = $1', [f.id]);
  let r = (await duenoO.get('/api/compras/reorden')).body.find((i) => i.id === f.id);
  assert.ok(r.bajo_minimo && r.sugerido > 0);
  const sug = r.sugerido;
  const oc = (await duenoO.post('/api/compras/ordenes', { proveedor_id: provO.id, sucursal_id: sucO, lineas: [{ origen: 'inv', item_id: f.id, cantidad: sug, precio_unitario: 100 }] })).body;
  await duenoO.post(`/api/compras/ordenes/${oc.id}/enviar`, {});
  r = (await duenoO.get('/api/compras/reorden')).body.find((i) => i.id === f.id);
  assert.equal(r.en_camino, sug); assert.equal(r.sugerido, 0); assert.equal(r.cubierto_en_camino, true);
});

// ── Cuentas por pagar y flujo ───────────────────────────────────────────────
test('compras a crédito: aparecen por pagar con vencimiento, el pago las baja y el flujo las registra al pagarlas', async () => {
  const f = await fresa();
  const oc = (await duenoO.post('/api/compras/ordenes', { proveedor_id: provO.id, sucursal_id: sucO, condicion: 'credito', dias_credito: 15, lineas: [{ origen: 'inv', item_id: f.id, cantidad: 10, precio_unitario: 100 }] })).body;
  await duenoO.post(`/api/compras/ordenes/${oc.id}/enviar`, {});
  await duenoO.post(`/api/compras/ordenes/${oc.id}/recibir`, { documento: 'F-CRED', lineas: [{ linea_id: oc.lineas[0].id, cantidad: 10 }] });
  let cxp = (await duenoO.get('/api/fin/por-pagar')).body;
  const it = cxp.items.find((x) => x.ref === `OC-${oc.numero}`);
  assert.equal(it.saldo, 1000); assert.equal(it.vence, sumarDias(hoy, 15)); assert.equal(it.dias_para_vencer, 15); assert.equal(it.bucket, '8-30');
  assert.equal((await gerO.post(`/api/compras/ordenes/${oc.id}/pagos`, { monto_lps: 100 })).status, 201);   // el gerente tiene fin:gastos
  assert.equal((await duenoO.post(`/api/compras/ordenes/${oc.id}/pagos`, { monto_lps: 5000 })).status, 400);
  await duenoO.post(`/api/compras/ordenes/${oc.id}/pagos`, { monto_lps: 400, forma: 'Transferencia' });
  cxp = (await duenoO.get('/api/fin/por-pagar')).body;
  assert.equal(cxp.items.find((x) => x.ref === `OC-${oc.numero}`).saldo, 500);
  const det = (await duenoO.get(`/api/compras/ordenes/${oc.id}`)).body;
  assert.equal(det.saldo_lps, 500); assert.equal(det.pagos.length, 2);
  // gasto por pagar
  const cat = (await duenoO.get('/api/fin/categorias')).body[0];
  const g = (await duenoO.post('/api/fin/gastos', { descripcion: 'Energía septiembre', monto: 2300, categoria_id: cat.id, pagado: false, vence: sumarDias(hoy, -3) })).body;
  cxp = (await duenoO.get('/api/fin/por-pagar')).body;
  assert.equal(cxp.items.find((x) => x.id === g.id).bucket, 'vencido'); assert.equal(cxp.vencido, 2300);
  const flujoAntes = (await duenoO.get(`/api/fin/flujo-caja?desde=${hoy.slice(0, 8)}01&hasta=${hoy}`)).body;
  assert.ok(!flujoAntes.salidas.some((s) => s.concepto.startsWith('Gastos')));                  // sin pagar no es salida de caja
  assert.equal((await duenoO.post(`/api/fin/gastos/${g.id}/pagar`, {})).status, 200);
  assert.equal((await duenoO.post(`/api/fin/gastos/${g.id}/pagar`, {})).status, 404);
  const flujo = (await duenoO.get(`/api/fin/flujo-caja?desde=${hoy.slice(0, 8)}01&hasta=${hoy}`)).body;
  assert.equal(flujo.salidas.find((s) => s.concepto.startsWith('Gastos')).total, 2300);
  assert.equal(flujo.salidas.find((s) => s.concepto.startsWith('Pagos a proveedores')).total, 500);
  assert.ok(flujo.salidas.find((s) => s.concepto.startsWith('Compras de contado')).total >= 1300);   // las recepciones de contado de la primera prueba
  // las compras por orden no se cuentan otra vez como «compras directas»
  const directas = flujo.salidas.find((s) => s.concepto === 'Compras directas de inventario');
  assert.ok(!directas || directas.total < 1000);
});

// ── Por cobrar ──────────────────────────────────────────────────────────────
test('por cobrar: factura a crédito con antigüedad, abono y cotización aprobada de EcoStone', async () => {
  const fp = (await t.db.query(`select id from pos.formas_pago where empresa_id = $1 and tipo = 'credito' limit 1`, [eidO])).rows[0]?.id
    ?? (await t.db.query(`insert into pos.formas_pago (empresa_id, nombre, tipo) values ($1,'Crédito','credito') returning id`, [eidO])).rows[0].id;
  const cli = (await t.db.query(`insert into core.terceros (nombre, es_cliente) values ('Hotel Plaza', true) returning id`)).rows[0].id;
  const venta = (await t.db.query(
    `insert into pos.ventas (empresa_id, sucursal_id, cliente_id, estado, total, numero_factura, fecha_emision) values ($1,$2,$3,'pagada',1500,'BORRADOR-000045', now() - interval '45 days') returning id`, [eidO, sucO, cli])).rows[0].id;
  await t.db.query('insert into pos.venta_pagos (venta_id, forma_pago_id, monto) values ($1,$2,1500)', [venta, fp]);
  let cxc = (await duenoO.get('/api/fin/por-cobrar')).body;
  const f = cxc.items.find((x) => x.id === venta);
  assert.equal(f.saldo, 1500); assert.equal(f.bucket, '31-60'); assert.ok(f.dias >= 44 && f.dias <= 46);
  assert.equal((await cajera.get('/api/fin/por-cobrar')).status, 403);
  assert.equal((await duenoO.post('/api/fin/abonos', { venta_id: venta, monto: 2000 })).status, 400);
  assert.equal((await duenoO.post('/api/fin/abonos', { venta_id: venta, monto: 600, forma: 'Transferencia' })).status, 201);
  cxc = (await duenoO.get('/api/fin/por-cobrar')).body;
  assert.equal(cxc.items.find((x) => x.id === venta).saldo, 900); assert.equal(cxc.total, 900); assert.equal(cxc.buckets['31-60'], 900);
  const flujo = (await duenoO.get(`/api/fin/flujo-caja?desde=${hoy.slice(0, 8)}01&hasta=${hoy}`)).body;
  assert.equal(flujo.entradas.find((e) => e.concepto === 'Cobros de facturas a crédito').total, 600);
  assert.ok(!flujo.entradas.some((e) => /crédito/i.test(e.concepto) && e.total === 1500));        // la venta a crédito no es entrada de caja

  // EcoStone: cotización aprobada con anticipo
  await t.db.query(`insert into eco.cotizaciones (empresa_id, numero, estado, nombre_cliente, total, aprobada_at, created_at) values ($1,1001,'aprobada','Constructora Sula',10000, now() - interval '100 days', now() - interval '100 days')`, [eidE]);
  const cot = (await t.db.query('select id from eco.cotizaciones where empresa_id = $1', [eidE])).rows[0].id;
  const fpE = (await t.db.query(`select id from pos.formas_pago where empresa_id = $1 limit 1`, [eidE])).rows[0]?.id
    ?? (await t.db.query(`insert into pos.formas_pago (empresa_id, nombre, tipo) values ($1,'Transferencia','transferencia') returning id`, [eidE])).rows[0].id;
  await t.db.query(`insert into eco.cotizacion_pagos (cotizacion_id, tipo, forma_pago_id, monto) values ($1,'anticipo',$2,3000)`, [cot, fpE]);
  const e = (await duenoE.get('/api/fin/por-cobrar')).body;
  assert.equal(e.items[0].saldo, 7000); assert.equal(e.items[0].bucket, '+90'); assert.equal(e.items[0].tipo, 'cotizacion');
  const fe = (await duenoE.get(`/api/fin/flujo-caja?desde=${hoy.slice(0, 8)}01&hasta=${hoy}`)).body;
  assert.equal(fe.entradas.find((x) => x.concepto.startsWith('Anticipos')).total, 3000);
});

// ── Estado de resultados, presupuesto y consolidado ─────────────────────────
test('estado de resultados por sucursal suma el total; los gastos sin sucursal quedan en «general»', async () => {
  const cat = (await duenoO.get('/api/fin/categorias')).body.find((c) => c.grupo === 'alquiler');
  await duenoO.post('/api/fin/gastos', { descripcion: 'Alquiler local', monto: 1150, isv: 150, categoria_id: cat.id, sucursal_id: sucO });
  await duenoO.post('/api/fin/gastos', { descripcion: 'Contabilidad', monto: 500, categoria_id: cat.id });
  const er = (await duenoO.get(`/api/fin/estado-resultados?desde=${hoy.slice(0, 8)}01&hasta=${hoy}`)).body;
  assert.equal(er.sucursales.length, 1);
  assert.equal(er.sucursales[0].gastos_operativos, 1000);                                      // 1,150 con ISV 150
  assert.ok(er.general.gastos_operativos >= 500);                                              // «Contabilidad» no tiene sucursal
  assert.equal(er.total.gastos_operativos, er.sucursales[0].gastos_operativos + er.general.gastos_operativos);
  assert.ok(er.categorias.some((c) => c.nombre === cat.nombre && c.monto >= 1500));
});

test('presupuesto mensual: solo con permiso, compara contra lo real y se copia al mes siguiente', async () => {
  const cats = (await duenoO.get('/api/fin/categorias')).body;
  const alq = cats.find((c) => c.grupo === 'alquiler');
  const mes = hoy.slice(0, 7);
  assert.equal((await gerO.put('/api/fin/presupuesto', { mes, lineas: [{ clave: 'ventas', monto: 50000 }] })).status, 403);
  let r = await duenoO.put('/api/fin/presupuesto', { mes, lineas: [{ clave: 'ventas', monto: 50000 }, { clave: alq.id, monto: 1000 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const l = r.body.gastos.find((x) => x.clave === alq.id);
  assert.equal(l.presupuesto, 1000); assert.ok(l.real >= 1500); assert.equal(l.estado, 'excedido'); assert.equal(r.body.ventas.presupuesto, 50000);
  assert.equal((await duenoO.put('/api/fin/presupuesto', { mes, lineas: [{ clave: '00000000-0000-0000-0000-000000000000', monto: 5 }] })).status, 400);
  const sig = sumarDias(hoy.slice(0, 8) + '01', 32).slice(0, 7);
  assert.equal((await duenoO.post('/api/fin/presupuesto/copiar', { desde_mes: mes, mes: sig })).body.copiadas, 2);
  assert.equal((await duenoO.get(`/api/fin/presupuesto?mes=${sig}`)).body.gastos.find((x) => x.clave === alq.id).presupuesto, 1000);
  assert.equal((await duenoO.get('/api/fin/presupuesto?mes=2026-13x')).status, 400);
});

test('entre empresas: la empresa que recibe concilia, se pagan los saldos y Dirección ve el neto', async () => {
  const i1 = (await duenoO.post('/api/fin/intercompania', { destino: 'ecostone', concepto: 'Cajas de producto', monto: 1000 })).body;
  assert.equal((await duenoO.put(`/api/fin/intercompania/${i1.id}/conciliar`, {})).status, 200);     // el dueño del grupo puede por las dos
  await duenoE.post('/api/fin/intercompania', { destino: 'origen', concepto: 'Flete', monto: 300 });
  const s = (await duenoO.get('/api/fin/intercompania/saldos')).body;
  assert.equal(s.me_deben, 700); assert.equal(s.debo, 0); assert.equal(s.saldos[0].deudor_nombre, 'EcoStone');
  assert.equal(s.sin_conciliar, 1);
  assert.equal((await duenoO.post(`/api/fin/intercompania/${i1.id}/pago`, { monto: 5000 })).status, 400);
  assert.equal((await duenoE.post(`/api/fin/intercompania/${i1.id}/pago`, { monto: 400 })).body.pendiente, 600);
  assert.equal((await duenoO.get('/api/fin/intercompania/saldos')).body.me_deben, 300);       // 600 − 300 que Origen le debe a EcoStone

  const c = (await duenoO.get(`/api/grupo/finanzas/consolidado?desde=${hoy.slice(0, 8)}01&hasta=${hoy}`)).body;
  assert.equal(c.empresas.length, 4);
  assert.equal(c.total.eliminacion, 1300);
  assert.equal(c.total.ventas_consolidadas, c.total.resultados.ventas_netas - 1300);
  assert.equal(c.total.utilidad_consolidada, c.total.resultados.utilidad_operativa);
  assert.equal(c.interco.saldos[0].saldo, 300);
  assert.ok(c.total.cobrar.total >= 900 + 7000); assert.ok(c.total.pagar.total > 0);
  assert.equal((await gerO.get('/api/grupo/finanzas/consolidado')).status, 403);
});

test('Excel: cada reporte baja como libro .xlsx válido', async () => {
  const dueno = await t.login('origen', 'dueno@grupo.hn', 'ClaveSegura123');
  for (const [ruta, emp] of [
    ['/api/fin/exportar?reporte=resultados', 'origen'], ['/api/fin/exportar?reporte=flujo', 'origen'], ['/api/fin/exportar?reporte=cobrar', 'origen'], ['/api/fin/exportar?reporte=pagar', 'origen'],
    ['/api/fin/exportar?reporte=presupuesto', 'origen'], ['/api/fin/exportar?reporte=interco', 'origen'], ['/api/grupo/finanzas/exportar', 'origen'],
    ['/api/compras/exportar?reporte=ordenes', 'origen'], ['/api/compras/exportar?reporte=precios', 'origen'], ['/api/compras/exportar?reporte=reorden', 'origen'],
  ]) {
    const r = await fetch(t.base + ruta, { headers: { authorization: `Bearer ${dueno}`, 'x-empresa': emp } });
    assert.equal(r.status, 200, ruta);
    assert.match(r.headers.get('content-type'), /spreadsheetml/);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.slice(0, 2).toString(), 'PK', `${ruta} no es un .xlsx`);
  }
});

test('correo de la orden: sin Gmail configurado queda pendiente y no falla', async () => {
  const f = await fresa();
  const oc = (await duenoO.post('/api/compras/ordenes', { proveedor_id: provO.id, sucursal_id: sucO, lineas: [{ origen: 'inv', item_id: f.id, cantidad: 2, precio_unitario: 90 }] })).body;
  const r = await duenoO.post(`/api/compras/ordenes/${oc.id}/enviar`, { correo: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.orden.estado, 'enviada');
  assert.ok(r.body.correo.ok || r.body.correo.pendiente || r.body.correo.error, JSON.stringify(r.body.correo));
  const sinCorreo = (await duenoE.post('/api/compras/proveedores', { nombre: 'Sin correo SA' })).body;
  assert.ok(sinCorreo.id);
});
