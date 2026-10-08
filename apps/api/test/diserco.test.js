import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from './helpers.js';
import { calcularCotizacion } from '../src/modulos/diserco/calculo.js';
import { generarExcelCotizacion } from '../src/modulos/diserco/excel.js';

let t, dueno, gerente, ventas, bodega, gestor, cajero, otra;
let prods;
const D = '/api/diserco';
const prod = (n) => prods.find((p) => p.nombre === n);
const stock = async (id) => Number((await t.db.query('select coalesce(sum(cantidad),0) as n from dis.movimientos where producto_id = $1', [id])).rows[0].n);

before(async () => {
  t = await iniciar();
  await t.usuario({ nombre: 'Dueño', email: 'dueno@grupo.hn', password: 'ClaveSegura123', dueno: true });
  await t.usuario({ nombre: 'Gerente D', email: 'ger@diserco.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'diserco', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Ventas D', email: 'ven@diserco.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'diserco', rol: 'ventas' }] });
  await t.usuario({ nombre: 'Bodega D', accesos: [{ empresa: 'diserco', rol: 'bodega', pin: '1111' }] });
  await t.usuario({ nombre: 'Gestor D', accesos: [{ empresa: 'diserco', rol: 'gestor', pin: '2222' }] });
  await t.usuario({ nombre: 'Cajero D', accesos: [{ empresa: 'diserco', rol: 'cajero', pin: '3333' }] });
  await t.usuario({ nombre: 'Gerente O', email: 'ger@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  dueno = t.cli(await t.login('diserco', 'dueno@grupo.hn', 'ClaveSegura123'), 'diserco');
  gerente = t.cli(await t.login('diserco', 'ger@diserco.hn', 'ClaveSegura123'), 'diserco');
  ventas = t.cli(await t.login('diserco', 'ven@diserco.hn', 'ClaveSegura123'), 'diserco');
  bodega = t.cli(await t.loginPin('diserco', '1111'), 'diserco');
  gestor = t.cli(await t.loginPin('diserco', '2222'), 'diserco');
  cajero = t.cli(await t.loginPin('diserco', '3333'), 'diserco');
  otra = t.cli(await t.login('origen', 'ger@origen.hn', 'ClaveSegura123'), 'origen');
  prods = (await dueno.get(`${D}/productos`)).body;
});
after(() => t.cerrar());

test('catálogo importado de WizPOS: 278 productos con existencias iniciales, precios sin ISV y consumibles', async () => {
  assert.equal(prods.length, 278);
  const sealer = prod('Clear Sealer Cub 5 Gal');
  assert.equal(sealer.existencia, 55.7);
  assert.equal(sealer.precio_con_isv, 5453.72);
  assert.ok(Math.abs(sealer.precio - 4742.3652) < 0.0001);
  assert.equal(sealer.consumible, true);
  assert.ok(prods.some((p) => p.consumible === false), 'moldes y herramientas no son consumibles');
  const { rows } = await t.db.query(`select count(*)::int as n from core.terceros where nombre ilike '%ANTARES%'`);
  assert.equal(rows[0].n, 1);
  assert.equal((await otra.get(`${D}/productos`)).status, 403);          // Origen no usa distribuidora
});

test('producto nuevo: precio sin ISV → precio con ISV en el POS; solo catálogo edita; código único; eliminar con historial', async () => {
  const cat = (await dueno.get(`${D}/categorias`)).body[0].id;
  assert.equal((await ventas.post(`${D}/productos`, { nombre: 'X', precio: 10 })).status, 403);
  const r = await gerente.post(`${D}/productos`, { nombre: 'Epóxico Prueba', codigo: 'EP-1', categoria_id: cat, precio: 1000, costo_estandar: 600, unidad_venta: 'kit', presentacion: 'Kit', stock_minimo: 5, rendimiento_texto: '15 m2' });
  assert.equal(r.status, 201);
  assert.equal(r.body.precio_con_isv, 1150);
  assert.equal((await gerente.post(`${D}/productos`, { nombre: 'Otro', codigo: 'EP-1', precio: 5 })).status, 409);
  assert.equal((await gerente.post(`${D}/productos`, { nombre: 'Sin precio' })).status, 400);
  const e = await gerente.put(`${D}/productos/${r.body.id}`, { precio: 2000 });
  assert.equal(e.body.precio_con_isv, 2300);
  assert.equal(e.body.nombre, 'Epóxico Prueba');
  const pos = (await t.db.query('select precio from pos.productos where id = $1', [r.body.id])).rows[0];
  assert.equal(Number(pos.precio), 2300);
  await bodega.post(`${D}/inventario/movimiento`, { producto_id: r.body.id, tipo: 'compra', cantidad: 3, costo: 600 });
  const del = await gerente.del(`${D}/productos/${r.body.id}?definitivo=1`);
  assert.equal(del.status, 409);
  assert.equal(del.body.codigo, 'CON_HISTORIAL');
  assert.equal((await gerente.del(`${D}/productos/${r.body.id}`)).status, 204);   // desactivar
});

test('inventario: compra (costo promedio), ajuste con motivo, sin costos para bodega, kardex', async () => {
  const p = prod('Clear Sealer 1 Galon');
  assert.equal((await ventas.post(`${D}/inventario/movimiento`, { producto_id: p.id, tipo: 'compra', cantidad: 1, costo: 5 })).status, 403);
  assert.equal((await bodega.post(`${D}/inventario/movimiento`, { producto_id: p.id, tipo: 'compra', cantidad: 2.5, costo: 100 })).status, 400);
  assert.equal((await bodega.post(`${D}/inventario/movimiento`, { producto_id: p.id, tipo: 'compra', cantidad: 10 })).status, 400);   // falta costo
  assert.equal((await bodega.post(`${D}/inventario/movimiento`, { producto_id: p.id, tipo: 'ajuste', cantidad: -1 })).status, 400);   // falta motivo
  assert.equal((await bodega.post(`${D}/inventario/movimiento`, { producto_id: p.id, tipo: 'compra', cantidad: 10, costo: 400, proveedor: 'Sika', referencia: 'F-1' })).status, 201);
  assert.equal((await bodega.post(`${D}/inventario/movimiento`, { producto_id: p.id, tipo: 'ajuste', cantidad: -2, motivo: 'dañado' })).status, 201);
  assert.equal(await stock(p.id), 8);
  assert.equal((await bodega.post(`${D}/inventario/movimiento`, { producto_id: p.id, tipo: 'ajuste', cantidad: -50, motivo: 'x' })).status, 409);   // no deja negativo a mano
  const inv = (await gerente.get(`${D}/inventario`)).body.find((x) => x.id === p.id);
  assert.equal(inv.existencia, 8);
  assert.equal(inv.costo_estandar, 400);
  const invB = (await bodega.get(`${D}/inventario`)).body.find((x) => x.id === p.id);
  assert.equal(invB.costo_estandar, undefined);
  assert.equal(invB.en_proyectos, 0);
  const k = (await gerente.get(`${D}/inventario/kardex?producto_id=${p.id}`)).body;
  assert.equal(k.length, 2);
  assert.equal(k[0].tipo, 'ajuste');
});

test('cálculo de cotización: ISV encima, descuento repartido, cliente exento', () => {
  const c = calcularCotizacion([{ cantidad: 2, precio_unitario: 100 }, { cantidad: 1, precio_unitario: 50.5 }], { descuento_pct: 10 });
  assert.equal(c.subtotal, 225.45);
  assert.equal(c.isv, 33.82);
  assert.equal(c.total, 259.27);
  assert.equal(calcularCotizacion([{ cantidad: 1, precio_unitario: 100 }], { cliente_exento: true }).total, 100);
});

let cotProy, cotProd;
test('cotización de proyecto: numeración, secciones, permisos, aprobar, cobros parciales con factura', async () => {
  const cuerpo = { tipo: 'proyecto', nombre_cliente: 'Constructora Prueba', rtn_cliente: '08011999123456', proyecto: 'Nave 7', ubicacion: 'Choloma', anticipo_pct: 50,
    secciones: [{ titulo: 'Forma de pago', texto: '50% anticipo' }], firma_nombre: 'Damaris', firma_cargo: 'Asistente', lineas: [{ descripcion: 'Epóxico sólido', cantidad: 100.5, unidad: 'm2', precio_unitario: 400 }] };
  assert.equal((await cajero.post(`${D}/cotizaciones`, cuerpo)).status, 403);
  assert.equal((await ventas.post(`${D}/cotizaciones`, { ...cuerpo, descuento_pct: 5 })).status, 403);    // descuento solo gerencia
  const r = await ventas.post(`${D}/cotizaciones`, cuerpo);
  assert.equal(r.status, 201);
  cotProy = r.body;
  assert.equal(cotProy.codigo, 'INDE0061-26');         // continúa la numeración de la app original (última 0060-26)
  assert.equal(cotProy.subtotal, 40200);
  assert.equal(cotProy.total, 46230);
  assert.equal(cotProy.estado, 'borrador');
  const ed = await ventas.put(`${D}/cotizaciones/${cotProy.id}`, { ...cuerpo, lineas: [{ descripcion: 'Epóxico sólido', cantidad: 100, unidad: 'm2', precio_unitario: 400 }] });
  assert.equal(ed.body.total, 46000);
  cotProy = ed.body;
  assert.equal((await ventas.post(`${D}/cotizaciones/${cotProy.id}/correo`, { email: 'a@b.com' })).body.codigo, 'correo_pendiente');
  assert.equal((await ventas.post(`${D}/cotizaciones/${cotProy.id}/cobros`, { forma_pago_id: '00000000-0000-4000-8000-000000000000', monto: 10 })).status, 409);   // aún no aprobada
  assert.equal((await ventas.post(`${D}/cotizaciones/${cotProy.id}/aprobar`)).body.estado, 'aprobada');
  assert.equal((await ventas.put(`${D}/cotizaciones/${cotProy.id}`, cuerpo)).status, 409);   // aprobada ya no se edita
  const fp = (await ventas.get(`${D}/formas-pago`)).body.find((f) => f.tipo === 'efectivo').id;
  const c1 = await ventas.post(`${D}/cotizaciones/${cotProy.id}/cobros`, { forma_pago_id: fp, monto: 23000 });
  assert.equal(c1.status, 201, JSON.stringify(c1.body));
  assert.match(c1.body.factura.numero_factura, /^BORRADOR-/);
  assert.equal(c1.body.cotizacion.pendiente, 23000);
  assert.equal(c1.body.cotizacion.pagos[0].concepto, 'Anticipo 50%');
  assert.equal(c1.body.cotizacion.estado, 'aprobada');
  assert.equal((await ventas.post(`${D}/cotizaciones/${cotProy.id}/cobros`, { forma_pago_id: fp, monto: 30000 })).status, 400);   // supera el saldo
  const c2 = await ventas.post(`${D}/cotizaciones/${cotProy.id}/cobros`, { forma_pago_id: fp, monto: 23000 });
  assert.equal(c2.body.cotizacion.estado, 'facturada');
  assert.equal(c2.body.cotizacion.pagos[1].concepto, 'Saldo final');
  assert.equal((await ventas.post(`${D}/cotizaciones/${cotProy.id}/anular`, { motivo: 'x' })).status, 403);   // solo gerencia
  assert.equal((await gerente.post(`${D}/cotizaciones/${cotProy.id}/anular`, { motivo: 'x' })).status, 409);  // con facturas
  const lista = (await ventas.get(`${D}/cotizaciones?estado=facturada&q=nave`)).body;
  assert.equal(lista.length, 1);
  assert.equal(lista[0].pagado, 46000);
});

test('cotización de productos: cobro completo factura, descuenta inventario y avisa si falta existencia; anular factura devuelve', async () => {
  const p = prod('Clear Sealer 1 Galon');   // hay 8
  const base = { tipo: 'productos', nombre_cliente: 'Cliente Mostrador', lineas: [{ producto_id: p.id, cantidad: 20, precio_unitario: '' }] };
  assert.equal((await ventas.post(`${D}/cotizaciones`, { ...base, lineas: [{ producto_id: p.id, cantidad: 1.5 }] })).status, 400);   // enteros
  assert.equal((await ventas.post(`${D}/cotizaciones`, { ...base, lineas: [{ producto_id: p.id, cantidad: 2, precio_unitario: 100 }] })).status, 403);   // bajo el catálogo
  const r = await gerente.post(`${D}/cotizaciones`, { ...base, descuento_pct: 10 });
  assert.equal(r.status, 201);
  cotProd = r.body;
  assert.equal(cotProd.codigo, '0062-26');
  assert.ok(Math.abs(cotProd.lineas[0].precio_unitario - 1058.9739) < 0.0001);
  assert.equal((await gerente.post(`${D}/cotizaciones/${cotProd.id}/aprobar`)).status, 200);
  const fp = (await gerente.get(`${D}/formas-pago`)).body.find((f) => f.tipo === 'efectivo').id;
  assert.equal((await gerente.post(`${D}/cotizaciones/${cotProd.id}/cobros`, { forma_pago_id: fp, monto: 100 })).status, 400);   // se cobra completa
  const sin = await gerente.post(`${D}/cotizaciones/${cotProd.id}/cobros`, { forma_pago_id: fp, monto: cotProd.total });
  assert.equal(sin.status, 409);
  assert.equal(sin.body.codigo, 'SIN_STOCK');
  assert.deepEqual(sin.body.faltantes, [{ producto: 'Clear Sealer 1 Galon', pedido: 20, hay: 8 }]);
  assert.equal(await stock(p.id), 8);
  const ok = await gerente.post(`${D}/cotizaciones/${cotProd.id}/cobros`, { forma_pago_id: fp, monto: cotProd.total, confirmar_sin_stock: true });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.cotizacion.estado, 'facturada');
  assert.match(ok.body.factura.aviso_rtn, /RTN/);   // solo avisa, no bloquea
  assert.equal(await stock(p.id), -12);                       // la caja no se bloquea: queda negativo
  const inv = (await gerente.get(`${D}/inventario`)).body.find((x) => x.id === p.id);
  assert.equal(inv.existencia, -12);
  assert.equal(inv.bajo_minimo, false);
  await t.db.query(`select pos.anular_venta($1, 'prueba', $2)`, [ok.body.factura.id, (await t.db.query(`select id from core.usuarios where nombre = 'Gerente D'`)).rows[0].id]);
  assert.equal(await stock(p.id), 8);                          // anular devuelve la existencia
});

test('salidas a proyecto: sacar, sumar al mismo proyecto, faltante confirmado, gestor sin costos, conteo y cierre con no consumibles', async () => {
  const resina = prod('Clear Sealer 1 Galon');
  const noCons = prods.find((x) => x.consumible === false && x.controla_inventario);
  await bodega.post(`${D}/inventario/movimiento`, { producto_id: noCons.id, tipo: 'compra', cantidad: 4, costo: 50 });
  assert.equal((await ventas.post(`${D}/salidas`, { proyecto: 'Nave 7', items: [{ producto_id: resina.id, cantidad: 1 }] })).status, 403);
  const e = await gestor.post(`${D}/salidas`, { proyecto: 'Nave 7 — Constructora Prueba', cotizacion_id: cotProy.id, items: [{ producto_id: resina.id, cantidad: 3 }, { producto_id: noCons.id, cantidad: 2 }] });
  assert.equal(e.status, 201);
  assert.equal(e.body.unidades, 5);
  assert.equal(e.body.costo_total, undefined);
  assert.equal(await stock(resina.id), 5);
  // sumar al mismo proyecto (otra persona, otro texto con tildes/mayúsculas)
  const s2 = await bodega.post(`${D}/salidas`, { proyecto: 'nave 7 — constructora prueba', items: [{ producto_id: resina.id, cantidad: 1 }] });
  assert.equal(s2.status, 200);
  assert.equal(s2.body.sumada, true);
  // faltante pide confirmación
  const f = await gestor.post(`${D}/salidas`, { proyecto: 'Nave 7 — Constructora Prueba', items: [{ producto_id: resina.id, cantidad: 100 }] });
  assert.equal(f.status, 409);
  assert.equal(f.body.codigo, 'SIN_STOCK');
  assert.equal(f.body.faltantes[0].hay, 4);
  assert.equal(await stock(resina.id), 4);
  assert.equal((await gestor.post(`${D}/salidas`, { proyecto: 'Nave 7 — Constructora Prueba', items: [{ producto_id: resina.id, cantidad: 5 }], confirmar_sin_stock: true })).status, 200);
  assert.equal(await stock(resina.id), -1);
  // lista solo administrador; ve "en proyectos"
  assert.equal((await gestor.get(`${D}/salidas`)).status, 403);
  const lista = (await dueno.get(`${D}/salidas?estado=abierta`)).body;
  assert.equal(lista.length, 1);
  assert.equal(lista[0].unidades, 11);
  assert.ok(lista[0].costo_total > 0);
  const s = lista[0];
  assert.equal(s.cotizacion.codigo, cotProy.codigo);
  const enProy = (await dueno.get(`${D}/inventario`)).body.find((x) => x.id === resina.id);
  assert.equal(enProy.en_proyectos, 9);
  assert.equal((await gerente.get(`${D}/inventario`)).body.find((x) => x.id === resina.id).en_proyectos, 0);
  // devolver a bodega (admin)
  const dev = await dueno.post(`${D}/salidas/${s.id}/movimiento`, { items: [{ producto_id: resina.id, cantidad: -1 }] });
  assert.equal(dev.status, 200);
  assert.equal((await dueno.post(`${D}/salidas/${s.id}/movimiento`, { items: [{ producto_id: resina.id, cantidad: -50 }] })).status, 400);
  // recepción y cierre
  const rec = (await gestor.get(`${D}/salidas/${s.id}/recepcion`)).body;
  assert.equal(rec.items.length, 2);
  assert.equal((await gestor.post(`${D}/salidas/${s.id}/cerrar`, { conteo: [{ producto_id: resina.id, regreso: 1 }] })).status, 400);   // falta contar
  assert.equal((await gestor.post(`${D}/salidas/${s.id}/cerrar`, { conteo: [{ producto_id: resina.id, regreso: 99 }, { producto_id: noCons.id, regreso: 0 }] })).status, 400);
  const c = await gestor.post(`${D}/salidas/${s.id}/cerrar`, { conteo: [{ producto_id: resina.id, regreso: 2 }, { producto_id: noCons.id, regreso: 1 }] });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.costo_consumido, undefined);
  assert.equal(c.body.no_regresaron, 1);
  const lr = c.body.lineas.find((l) => l.producto_id === resina.id);
  assert.equal(lr.salio, 9); assert.equal(lr.regreso, 3); assert.equal(lr.consumido, 6);
  const ln = c.body.lineas.find((l) => l.producto_id === noCons.id);
  assert.equal(ln.consumible, false); assert.equal(ln.consumido, 1);
  assert.equal((await t.db.query(`select count(*)::int as n from core.auditoria where accion = 'proyecto_material_no_regreso'`)).rows[0].n, 1);
  const cerr = (await dueno.get(`${D}/salidas/${s.id}`)).body;
  assert.equal(cerr.estado, 'cerrada');
  assert.ok(cerr.resumen.costo_no_regresado > 0);
  assert.equal((await gestor.post(`${D}/salidas/${s.id}/cerrar`, { conteo: [] })).status, 409);
  const hist = (await dueno.get(`${D}/salidas/${s.id}/historial`)).body;
  assert.ok(hist.some((h) => h.tipo === 'estado'));
  assert.equal((await dueno.post(`${D}/salidas/${s.id}/reabrir`)).body.estado, 'abierta');
  assert.equal((await dueno.get(`${D}/cotizaciones/${cotProy.id}`)).status, 200);
});

test('Excel: se genera, se vuelve a importar (varios archivos) con secciones, firma y fecha original, y se conserva el original', async () => {
  const cot = (await dueno.get(`${D}/cotizaciones/${cotProy.id}`)).body;
  const buf = await generarExcelCotizacion({ ...cot, created_at: '2026-03-10T15:00:00Z' });
  const bajado = await fetch(`${t.base}${D}/cotizaciones/${cot.id}/excel`, { headers: { authorization: `Bearer ${await t.login('diserco', 'dueno@grupo.hn', 'ClaveSegura123')}`, 'x-empresa': 'diserco' } });
  assert.equal(bajado.status, 200);
  assert.ok((await bajado.arrayBuffer()).byteLength > 3000);
  const b64 = buf.toString('base64');
  const a = await ventas.post(`${D}/cotizaciones/importar-excel`, { nombre: 'uno.xlsx', contenido: b64 });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.cotizacion.tipo, 'proyecto');
  assert.equal(a.body.cotizacion.estado, 'borrador');
  assert.equal(a.body.cotizacion.nombre_cliente, 'Constructora Prueba');
  assert.equal(a.body.cotizacion.proyecto, 'Nave 7');
  assert.equal(a.body.cotizacion.total, 46000);
  assert.equal(a.body.cotizacion.tiene_original, true);
  assert.equal(a.body.cotizacion.secciones[0].titulo, 'Forma de pago');
  assert.equal(a.body.cotizacion.firma_nombre, 'Damaris');
  assert.match(a.body.cotizacion.created_at, /^2026-03-10/);
  assert.notEqual(a.body.cotizacion.codigo, cot.codigo);                   // número nuevo del sistema
  const b = await ventas.post(`${D}/cotizaciones/importar-excel`, { nombre: 'dos.xlsx', contenido: b64 });
  assert.equal(b.status, 201);
  const orig = await fetch(`${t.base}${D}/cotizaciones/${a.body.cotizacion.id}/excel-original`, { headers: { authorization: `Bearer ${await t.login('diserco', 'ven@diserco.hn', 'ClaveSegura123')}`, 'x-empresa': 'diserco' } });
  assert.equal(orig.status, 200);
  assert.equal(Buffer.from(await orig.arrayBuffer()).toString('base64'), b64);
  assert.equal((await ventas.post(`${D}/cotizaciones/importar-excel`, { nombre: 'malo.xlsx', contenido: Buffer.from('no es excel').toString('base64') })).status, 400);
  const doc = (await ventas.get(`${D}/cotizaciones/${a.body.cotizacion.id}/documento`)).body;
  assert.equal(doc.config.prefijoProyecto, 'INDE');
  assert.equal(doc.cotizacion.lineas.length, 1);
});

test('migración: el rol gestor solo ve salidas e inventario (sin costos) y la bitácora registra lo hecho', async () => {
  assert.equal((await gestor.get(`${D}/cotizaciones`)).status, 403);
  assert.equal((await gestor.get(`${D}/inventario`)).status, 200);
  assert.equal((await gestor.get(`${D}/inventario/kardex`)).status, 200);
  assert.equal((await gestor.post(`${D}/inventario/movimiento`, { producto_id: prods[0].id, tipo: 'ajuste', cantidad: 1, motivo: 'x' })).status, 403);
  const acc = (await t.db.query(`select distinct accion from core.auditoria where accion like 'dcotizacion%' or accion like 'salida%' or accion like 'inventario%'`)).rows.map((x) => x.accion);
  for (const a of ['dcotizacion_creada', 'dcotizacion_cobro', 'salida_creada', 'salida_cerrada', 'inventario_compra', 'inventario_salida_sin_stock']) assert.ok(acc.includes(a), a);
});
