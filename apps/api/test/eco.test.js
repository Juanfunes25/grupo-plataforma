import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from './helpers.js';
import { calcularCotizacion, dimensionarLinea, sugerirAccesorios, calcularAnticipo } from '../src/modulos/eco/calculo.js';
import * as calcWeb from '../../web/src/eco/cotizacion.js';

let t, adm, ven, caja, italo, eid, piedra, acc, flete, fp;

before(async () => {
  t = await iniciar();
  await t.usuario({ nombre: 'Admin Eco', email: 'adm@eco.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'ecostone', rol: 'admin' }, { empresa: 'italo', rol: 'admin' }] });
  await t.usuario({ nombre: 'Ventas Eco', email: 'ven@eco.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'ecostone', rol: 'ventas' }] });
  await t.usuario({ nombre: 'Cajero Eco', accesos: [{ empresa: 'ecostone', rol: 'cajero', pin: '5566' }] });
  adm = t.cli(await t.login('ecostone', 'adm@eco.hn', 'ClaveSegura123'), 'ecostone');
  ven = t.cli(await t.login('ecostone', 'ven@eco.hn', 'ClaveSegura123'), 'ecostone');
  caja = t.cli(await t.loginPin('ecostone', '5566'), 'ecostone');
  italo = t.cli(await t.login('italo', 'adm@eco.hn', 'ClaveSegura123'), 'italo');
  eid = await t.empresaId('ecostone');
  fp = (await t.db.query(`select id from pos.formas_pago where empresa_id = $1 and tipo = 'efectivo'`, [eid])).rows[0].id;
});
after(() => t.cerrar());

const lote = async (productoId, codigo, cantidad) => (await t.db.query(
  `insert into fab.lotes (empresa_id, codigo, producto_id, calidad, estado, cantidad_producida, cantidad_disponible, fecha_lista) values ($1,$2,$3,'primera','lista',$4,$4,now()) returning id`, [eid, codigo, productoId, cantidad])).rows[0].id;
const stock = async (productoId) => (await t.db.query(`select coalesce(sum(cantidad_disponible),0)::float as f, coalesce(sum(cantidad_reservada),0)::float as r from fab.lotes where producto_id = $1`, [productoId])).rows[0];

test('cálculo: m² netos + desperdicio → cajas completas; ISV incluido o separado; descuento %; accesorios por rendimiento', () => {
  const p = { m2_por_caja: 1.2, unidad_venta: 'm2' };
  const d = dimensionarLinea(p, 10, 8);              // 10.8 m² → 9 cajas de 1.2
  assert.equal(d.cajas, 9); assert.equal(d.cantidad, 9); assert.equal(d.factor_precio, 1.2); assert.equal(d.m2_entregado, 10.8);
  assert.equal(dimensionarLinea({ m2_por_caja: 1, unidad_venta: 'm2' }, 10, 0).cantidad, 10);
  assert.equal(dimensionarLinea({ unidad_venta: 'pieza', piezas_por_m2: 40 }, 3, 0).cantidad, 120);
  assert.deepEqual(sugerirAccesorios(25, [{ id: 'a', nombre: 'Pegamento', unidad_venta: 'saco', rendimiento_m2: 6 }]).map((s) => s.cantidad), [5]);
  // ISV separado (Contratista): 10 cajas × L 100 + 15 % ISV
  const sep = calcularCotizacion([{ cantidad: 10, precio_unitario: 100, isv_tasa: 0.15 }], { isv_incluido: false });
  assert.equal(sep.subtotal, 1000); assert.equal(sep.isv, 150); assert.equal(sep.total, 1150);
  // ISV incluido (Público): el total es el precio y se separa la base
  const inc = calcularCotizacion([{ cantidad: 10, precio_unitario: 115, isv_tasa: 0.15 }], { isv_incluido: true });
  assert.equal(inc.total, 1150); assert.equal(inc.subtotal, 1000); assert.equal(inc.isv, 150);
  // descuento 10 % repartido entre líneas antes del ISV
  const dsc = calcularCotizacion([{ cantidad: 1, precio_unitario: 100, isv_tasa: 0.15 }, { cantidad: 1, precio_unitario: 300, isv_tasa: 0.15 }], { isv_incluido: false, descuento_pct: 10 });
  assert.equal(dsc.descuento_global, 40); assert.equal(dsc.subtotal, 360); assert.equal(dsc.isv, 54); assert.equal(dsc.total, 414);
  assert.equal(calcularCotizacion([{ cantidad: 1, precio_unitario: 100, isv_tasa: 0.15 }], { cliente_exento: true }).total, 100);
  assert.deepEqual(calcularAnticipo(1150, 30), { anticipo: 345, saldo: 805 });
});

test('el cálculo del navegador y el del servidor dan exactamente lo mismo (miles de casos)', () => {
  let s = 12345; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  for (let i = 0; i < 3000; i++) {
    const lineas = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => ({ cantidad: 1 + Math.floor(rnd() * 200), precio_unitario: Math.round(rnd() * 90000) / 100, descuento_pct: rnd() < 0.2 ? 5 : 0, isv_tasa: rnd() < 0.9 ? 0.15 : 0, costo_unitario: rnd() * 50 }));
    const o = { isv_incluido: rnd() < 0.5, descuento_pct: rnd() < 0.4 ? Math.round(rnd() * 20) : 0, descuento: rnd() < 0.2 ? 33.33 : 0, cliente_exento: rnd() < 0.1 };
    assert.deepEqual(calcularCotizacion(lineas, o), calcWeb.calcularCotizacion(lineas, o));
    const p = { m2_por_caja: [0, 1, 1.2, 0.5][i % 4], unidad_venta: ['m2', 'caja', 'pieza', 'saco'][i % 4], piezas_por_m2: 33, rendimiento_m2: 6 };
    const m2 = Math.floor(rnd() * 300), dp = Math.floor(rnd() * 12);
    assert.deepEqual(dimensionarLinea(p, m2, dp), calcWeb.dimensionarLinea(p, m2, dp));
  }
});

test('el módulo es solo de fábrica y exige permisos', async () => {
  assert.equal((await italo.get('/api/eco/productos')).status, 403);            // Italo no tiene fábrica
  assert.equal((await caja.get('/api/eco/cotizaciones')).status, 403);          // el cajero no cotiza
  assert.equal((await ven.post('/api/eco/productos', { nombre: 'X', tipo: 'piedra' })).status, 403);   // Ventas no edita el catálogo
});

test('catálogo: piedra (modelo+color, m² por caja), accesorio con rendimiento, servicio y listas de precio', async () => {
  const p = await adm.post('/api/eco/productos', { tipo: 'piedra', nombre: 'Piedra Río Ocre', codigo: 'PR-OC', modelo: 'Río', color: 'Ocre', unidad_venta: 'm2', m2_por_caja: 1, peso_kg_m2: 38, precio: 230, impuesto_tasa: 0.15 });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  piedra = p.body;
  assert.equal(piedra.tipo, 'piedra'); assert.equal(piedra.color, 'Ocre'); assert.equal(Number(piedra.m2_por_caja), 1);
  const base = (await t.db.query('select es_piedra, unidad_venta from pos.productos where id = $1', [piedra.id])).rows[0];
  assert.equal(base.es_piedra, true); assert.equal(base.unidad_venta, 'm2');
  acc = (await adm.post('/api/eco/productos', { tipo: 'accesorio', nombre: 'Pegamento flexible', unidad_venta: 'saco', rendimiento_m2: 5, precio: 345 })).body;
  flete = (await adm.post('/api/eco/productos', { tipo: 'servicio', nombre: 'Instalación', unidad_venta: 'm2', precio: 115 })).body;
  assert.equal(Number(acc.rendimiento_m2), 5);
  assert.equal((await adm.post('/api/eco/productos', { tipo: 'piedra', nombre: 'Otra', codigo: 'PR-OC' })).status, 409);   // código repetido
  const listas = (await adm.get('/api/eco/listas-precio')).body;
  assert.deepEqual(listas.map((l) => [l.nombre, l.isv_incluido]), [['Público', true], ['Contratista', false], ['Distribuidor', false]]);
  const contr = listas.find((l) => l.nombre === 'Contratista');
  assert.equal((await adm.put('/api/eco/listas-precio/precios', { producto_id: piedra.id, lista_id: contr.id, precio: 180 })).status, 200);
  assert.equal((await adm.get('/api/eco/listas-precio/precios')).body.find((x) => x.producto_id === piedra.id).precio, 180);
  assert.equal((await ven.put('/api/eco/listas-precio/precios', { producto_id: piedra.id, lista_id: contr.id, precio: 1 })).status, 403);
  assert.equal((await ven.get('/api/eco/productos')).status, 200);                // Ventas sí lo ve (y sin costos)
  assert.equal((await ven.get('/api/eco/productos')).body[0].costo_estandar, undefined);
  // baja de precio queda en la bitácora
  assert.equal((await adm.put('/api/eco/listas-precio/precios', { producto_id: piedra.id, lista_id: contr.id, precio: 170 })).status, 200);
  assert.ok((await t.db.query(`select 1 from core.auditoria where accion = 'precio_baja' and empresa_id = $1`, [eid])).rowCount >= 1);
});

let cot;
test('cotización: lista Contratista (ISV aparte), cajas completas, accesorio, instalación y descuento %', async () => {
  const contr = (await adm.get('/api/eco/listas-precio')).body.find((l) => l.nombre === 'Contratista');
  const cuerpo = {
    nombre_cliente: 'Constructora Sula', rtn_cliente: '05019013557791', telefono: '9999-1111', tipo_cliente: 'constructora', proyecto: 'Torre Mirador', lista_precio_id: contr.id, descuento_pct: 0,
    lineas: [
      { tipo: 'producto', producto_id: piedra.id, m2_neto: 100 },
      { tipo: 'accesorio', producto_id: acc.id, cantidad: 20 },
      { tipo: 'instalacion', descripcion: 'Instalación', unidad: 'm2', cantidad: 100, precio_unitario: 50 },
      { tipo: 'flete', descripcion: 'Flete', unidad: 'viaje', cantidad: 1, precio_unitario: 1500 },
    ],
  };
  const r = await adm.post('/api/eco/cotizaciones', cuerpo);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  cot = r.body;
  assert.equal(Number(cot.numero), 1001); assert.equal(cot.estado, 'borrador'); assert.equal(cot.isv_incluido, false);
  const l0 = cot.lineas[0];
  assert.equal(Number(l0.cantidad), 100); assert.equal(Number(l0.cajas), 100); assert.equal(Number(l0.precio_unitario), 170);      // precio de la lista Contratista
  // 100×170 + 20×(345/1.15=300) + 100×50 + 1500 = 17000+6000+5000+1500 = 29500 ; ISV 15 % = 4425
  assert.equal(Number(cot.subtotal), 29500); assert.equal(Number(cot.isv), 4425); assert.equal(Number(cot.total), 33925);
  assert.equal(cot.rtn_cliente, '05019013557791');
  // descuento negociado
  const d = await adm.put(`/api/eco/cotizaciones/${cot.id}`, { ...cuerpo, descuento_pct: 10 });
  assert.equal(d.status, 200); assert.equal(Number(d.body.descuento), 2950); assert.equal(Number(d.body.total), 30532.5);
  // Ventas no pasa de su tope (5 %) ni cotiza por debajo de la lista
  assert.equal((await ven.post('/api/eco/cotizaciones', { ...cuerpo, descuento_pct: 10 })).status, 403);
  const bajo = { ...cuerpo, lineas: [{ tipo: 'producto', producto_id: piedra.id, m2_neto: 10, precio_unitario: 100 }] };
  assert.equal((await ven.post('/api/eco/cotizaciones', bajo)).status, 403);
  assert.equal((await ven.post('/api/eco/cotizaciones', { ...cuerpo, descuento_pct: 5 })).status, 201);
  assert.equal((await adm.post('/api/eco/cotizaciones', { ...cuerpo, lineas: [{ tipo: 'producto', producto_id: piedra.id, m2_neto: 10.5 }] })).status, 400);   // m² enteros
  const doc = await adm.get(`/api/eco/cotizaciones/${cot.id}/documento`);
  assert.equal(doc.status, 200); assert.equal(doc.body.calculo.total, 30532.5); assert.ok(doc.body.condiciones.length);
  cot = d.body;
});

test('aprobar: reserva la piedra de la bodega (FIFO) y manda a producir lo que falta; cobrar antes de aprobar no se puede', async () => {
  const fpPago = { forma_pago_id: fp, monto: 100 };
  assert.equal((await adm.post(`/api/eco/cotizaciones/${cot.id}/pagos`, fpPago)).status, 409);
  await lote(piedra.id, 'EC-A', 60); await lote(piedra.id, 'EC-B', 30);
  await t.db.query(`insert into fab.recetas (empresa_id, producto_id, nombre) values ($1,$2,'Receta Ocre')`, [eid, piedra.id]);
  const r = await adm.post(`/api/eco/cotizaciones/${cot.id}/aprobar`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.cotizacion.estado, 'aprobada');
  assert.deepEqual(r.body.plan.reservado.map((x) => [x.lote, x.m2]), [['EC-A', 60], ['EC-B', 30]]);   // FIFO por lote
  assert.equal(r.body.plan.ordenes.length, 1); assert.equal(r.body.plan.ordenes[0].m2, 10);              // faltaban 10 m²
  assert.equal((await stock(piedra.id)).r, 90);
  assert.equal((await adm.post(`/api/eco/cotizaciones/${cot.id}/aprobar`, {})).status, 409);            // ya aprobada
  assert.equal((await adm.put(`/api/eco/cotizaciones/${cot.id}`, { nombre_cliente: 'x', lineas: [] })).status, 409);
  const det = (await adm.get(`/api/eco/cotizaciones/${cot.id}`)).body;
  assert.equal(det.reservas.length, 2); assert.equal(det.ordenes.length, 1);
});

test('cobro: anticipo y pago; no se factura hasta cubrir el total; la factura sale con CAI (borrador), ISV y consume la reserva', async () => {
  const total = Number(cot.total);
  assert.equal((await adm.post(`/api/eco/cotizaciones/${cot.id}/facturar`, {})).status, 409);            // sin pago
  const a = await adm.post(`/api/eco/cotizaciones/${cot.id}/pagos`, { forma_pago_id: fp, monto: 10000 });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.pago.tipo, 'pago'); assert.equal(a.body.cotizacion.pendiente, total - 10000);
  assert.equal((await adm.post(`/api/eco/cotizaciones/${cot.id}/pagos`, { forma_pago_id: fp, monto: total })).status, 400);   // excede el saldo
  assert.equal((await adm.post(`/api/eco/cotizaciones/${cot.id}/facturar`, {})).status, 409);            // falta cobrar
  assert.equal((await adm.post(`/api/eco/cotizaciones/${cot.id}/pagos`, { forma_pago_id: fp, monto: total - 10000 })).status, 201);
  const sin = await adm.post(`/api/eco/cotizaciones/${cot.id}/facturar`, {});     // 10 m² siguen en producción: pide confirmación
  assert.equal(sin.status, 409); assert.equal(sin.body.codigo, 'SIN_STOCK'); assert.equal(sin.body.faltantes[0].hay, 90);
  assert.equal((await t.db.query(`select count(*)::int as n from pos.ventas where empresa_id = $1`, [eid])).rows[0].n, 0);   // nada quedó a medias
  const f = await adm.post(`/api/eco/cotizaciones/${cot.id}/facturar`, { confirmar_sin_stock: true });
  assert.equal(f.status, 201, JSON.stringify(f.body));
  assert.match(f.body.factura.numero_factura, /^BORRADOR-/); assert.equal(f.body.factura.total, total);
  assert.equal(f.body.cotizacion.estado, 'facturada');
  const v = (await t.db.query('select * from pos.ventas where id = $1', [f.body.factura.id])).rows[0];
  assert.equal(v.estado, 'pagada'); assert.equal(Number(v.total), total);
  assert.equal(Number(v.isv_total), 3982.5);                 // 15 % sobre la base 26 550 (29 500 − 2 950)
  assert.equal(Number(v.subtotal_gravado_15), 26550);
  assert.ok(v.aviso === undefined);
  const pagos = (await t.db.query('select sum(monto)::float as m from pos.venta_pagos where venta_id = $1', [v.id])).rows[0].m;
  assert.equal(pagos, total);
  // la reserva se consumió y salió del inventario (90 reservados + 10 sin existencia)
  const s = await stock(piedra.id);
  assert.equal(s.f, 0); assert.equal(s.r, 0);
  assert.ok((await t.db.query(`select 1 from core.auditoria where accion = 'venta_sin_existencia' and empresa_id = $1`, [eid])).rowCount === 1);
  assert.equal((await adm.post(`/api/eco/cotizaciones/${cot.id}/facturar`, {})).status, 409);            // no se factura dos veces
  // anular la factura (desde POS) devuelve la piedra a su lote
  const an = await adm.post(`/api/pos/ventas/${f.body.factura.id}/anular`, { motivo: 'Error al cobrar' });
  assert.equal(an.status, 200, JSON.stringify(an.body));
  assert.equal((await stock(piedra.id)).f, 90);
});

test('rechazar y anular liberan la reserva y cancelan la producción pendiente', async () => {
  const mk = async () => (await adm.post('/api/eco/cotizaciones', { nombre_cliente: 'Casa López', proyecto: 'Fachada', lineas: [{ tipo: 'producto', producto_id: piedra.id, m2_neto: 20 }] })).body;
  const c1 = await mk();
  assert.equal(c1.isv_incluido, true);                       // lista Público: precio con ISV
  assert.equal(Number(c1.total), 4600);
  const ap = await adm.post(`/api/eco/cotizaciones/${c1.id}/aprobar`, {});
  assert.equal(ap.body.plan.reservado[0].m2, 20); assert.equal((await stock(piedra.id)).r, 20);
  assert.equal((await ven.post(`/api/eco/cotizaciones/${c1.id}/anular`, { motivo: 'x' })).status, 403);   // anular es de gerencia
  assert.equal((await adm.post(`/api/eco/cotizaciones/${c1.id}/anular`, { motivo: 'El cliente desistió' })).status, 200);
  assert.equal((await stock(piedra.id)).r, 0);
  const c2 = await mk();
  assert.equal((await ven.post(`/api/eco/cotizaciones/${c2.id}/rechazar`, { motivo: 'Precio' })).status, 200);
  assert.equal((await adm.get(`/api/eco/cotizaciones?estado=rechazada,anulada`)).body.length, 2);
});

test('POS «Venta Directa» de EcoStone: sobre L 10,000 sin RTN solo avisa; sin existencia pide confirmación y luego factura', async () => {
  // existencia: 90 m² en bodega. Se piden 100 cajas → falta
  const orden = { items: [{ producto_id: piedra.id, cantidad: 100 }], cobrar: { pagos: [{ forma_pago_id: fp, monto: 23000 }] } };
  const r1 = await adm.post('/api/pos/ventas', orden);
  assert.equal(r1.status, 409); assert.equal(r1.body.codigo, 'SIN_STOCK');
  assert.deepEqual(r1.body.faltantes.map((f) => [f.producto, f.pedido, f.hay]), [['Piedra Río Ocre', 100, 90]]);
  const r2 = await adm.post('/api/pos/ventas', { ...orden, confirmar_sin_stock: true });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.equal(r2.body.estado, 'pagada'); assert.match(r2.body.aviso_rtn, /RTN/); assert.equal(r2.body.faltantes_inventario[0].producto, 'Piedra Río Ocre');
  assert.equal((await stock(piedra.id)).f, 0);
  assert.ok((await t.db.query(`select 1 from core.auditoria where accion = 'venta_sin_rtn' and empresa_id = $1`, [eid])).rowCount === 1);
  // con existencia suficiente factura directo, sin avisos
  await lote(piedra.id, 'EC-C', 50);
  const r3 = await adm.post('/api/pos/ventas', { items: [{ producto_id: piedra.id, cantidad: 5 }], cobrar: { pagos: [{ forma_pago_id: fp, monto: 1150 }] } });
  assert.equal(r3.status, 201); assert.equal(r3.body.aviso_rtn, null); assert.deepEqual(r3.body.faltantes_inventario, []);
  assert.equal((await stock(piedra.id)).f, 45);
  // si la empresa NO permite vender sin existencia, bloquea
  await t.db.query(`update core.config set valor = valor || '{"permitir_sin_stock": false}'::jsonb where empresa_id = $1 and clave = 'pos'`, [eid]);
  const r4 = await adm.post('/api/pos/ventas', { items: [{ producto_id: piedra.id, cantidad: 500 }], cobrar: { pagos: [{ forma_pago_id: fp, monto: 115000 }] }, confirmar_sin_stock: true });
  assert.equal(r4.status, 409); assert.equal(r4.body.codigo, 'SIN_STOCK');
  await t.db.query(`update core.config set valor = valor || '{"permitir_sin_stock": true}'::jsonb where empresa_id = $1 and clave = 'pos'`, [eid]);
});

test('inventario de piedra: físico, reservado y disponible por lote; ajuste con motivo y conteo sorpresa', async () => {
  const inv = async () => (await adm.get('/api/eco/inventario/pt')).body.find((p) => p.id === piedra.id);
  let p = await inv();
  assert.equal(p.fisico_primera, 45); assert.equal(p.disponible_primera, 45); assert.equal(p.reservado, 0); assert.equal(p.unidad, 'm²');
  const c = (await adm.post('/api/eco/cotizaciones', { nombre_cliente: 'Obra Norte', proyecto: 'P', lineas: [{ tipo: 'producto', producto_id: piedra.id, m2_neto: 15 }] })).body;
  await adm.post(`/api/eco/cotizaciones/${c.id}/aprobar`, {});
  p = await inv();
  assert.equal(p.fisico_primera, 45); assert.equal(p.reservado, 15); assert.equal(p.disponible_primera, 30);
  assert.equal((await adm.post('/api/eco/inventario/pt/ajuste', { producto_id: piedra.id, lote: 'EC-C', m2: -5 })).status, 400);                  // motivo obligatorio
  assert.equal((await adm.post('/api/eco/inventario/pt/ajuste', { producto_id: piedra.id, lote: 'EC-C', m2: -40, motivo: 'Rotura' })).status, 400);   // no baja de lo reservado
  assert.equal((await adm.post('/api/eco/inventario/pt/ajuste', { producto_id: piedra.id, lote: 'EC-NUEVO', m2: 10, motivo: 'Carga inicial', tipo: 'inicial' })).status, 201);
  const cn = await adm.post('/api/eco/inventario/pt/conteo', { producto_id: piedra.id, lote: 'EC-C', contado: 42 });
  assert.deepEqual(cn.body, { sistema: 45, contado: 42, diferencia: -3 });
  p = await inv();
  assert.equal(p.fisico_primera, 52);
  assert.equal((await ven.post('/api/eco/inventario/pt/conteo', { producto_id: piedra.id, lote: 'EC-C', contado: 1 })).status, 403);   // Ventas no cuenta
  assert.ok((await adm.get('/api/eco/inventario/pt/kardex')).body.length > 5);
});
