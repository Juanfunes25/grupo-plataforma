import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { iniciar } from './helpers.js';
import { sembrar } from '../src/db/sembrar.js';
import { generarPdfFactura, leerPng } from '../src/modulos/pos/pdf.js';

// POS sin conexión: las ventas hechas sin internet llegan después, con su id de cliente. Nunca se duplican, el correlativo fiscal
// sigue sin huecos ni repetidos, y lo que no se puede validar sin conexión (tarjeta) se rechaza.
let t, caja, gerente, cat, suc, tokenCaja;
const prod = (n) => cat.productos.find((p) => p.nombre === n);
const forma = (tipo) => cat.formas_pago.find((f) => f.tipo === tipo).id;
const pagoEf = (monto) => [{ forma_pago_id: forma('efectivo'), monto }];
const ventaOffline = (extra = {}) => ({
  id_cliente: randomUUID(), sucursal_id: suc,
  items: [{ producto_id: prod('Naranja Pura').id, cantidad: 1 }],
  cobrar: { pagos: pagoEf(100) },
  offline: { vendida_at: new Date(Date.now() - 20 * 60_000).toISOString(), numero_provisional: 'OFF-TEST-0001', cajero_nombre: 'Cajera Ana', total_cliente: 75 },
  ...extra,
});
const numero = (f) => Number(String(f).split('-').pop());

before(async () => {
  t = await iniciar();
  await sembrar(t.db, t.config.semillas, 'origen');
  await t.usuario({ nombre: 'Gerente', email: 'ger@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Cajera Ana', accesos: [{ empresa: 'origen', rol: 'cajero', pin: '1234' }] });
  tokenCaja = await t.loginPin('origen', '1234');
  caja = t.cli(tokenCaja, 'origen');
  gerente = t.cli(await t.login('origen', 'ger@origen.hn', 'ClaveSegura123'), 'origen');
  cat = (await caja.get('/api/pos/catalogo')).body;
  suc = cat.sucursales[0].id;
});
after(() => t.cerrar());

test('venta sin conexión: se factura al sincronizar; reenviarla NO crea otra factura ni gasta otro correlativo', async () => {
  const antes = await caja.post('/api/pos/ventas', { items: [{ producto_id: prod('Naranja Pura').id, cantidad: 1 }], cobrar: { pagos: pagoEf(100) } });
  const v = ventaOffline();
  const a = await caja.post('/api/pos/ventas', v);
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.estado, 'pagada');
  assert.equal(a.body.numero_provisional, 'OFF-TEST-0001');
  assert.equal(a.body.id_cliente, v.id_cliente);
  assert.equal(numero(a.body.numero_factura), numero(antes.body.numero_factura) + 1, 'el correlativo sigue seguido');

  const b = await caja.post('/api/pos/ventas', v);                 // el reintento
  assert.equal(b.status, 200);
  assert.equal(b.body.duplicado, true);
  assert.equal(b.body.id, a.body.id);
  assert.equal(b.body.numero_factura, a.body.numero_factura);
  assert.equal((await t.db.query('select count(*)::int as n from pos.ventas where id_cliente = $1', [v.id_cliente])).rows[0].n, 1);

  const despues = await caja.post('/api/pos/ventas', { items: [{ producto_id: prod('Naranja Pura').id, cantidad: 1 }], cobrar: { pagos: pagoEf(100) } });
  assert.equal(numero(despues.body.numero_factura), numero(a.body.numero_factura) + 1, 'el reintento no se comió un número');
});

test('venta sin conexión: cinco envíos simultáneos de la misma venta producen UNA factura', async () => {
  const v = ventaOffline();
  const rs = await Promise.all(Array.from({ length: 5 }, () => caja.post('/api/pos/ventas', v)));
  assert.ok(rs.every((r) => [200, 201].includes(r.status)), rs.map((r) => r.status).join(','));
  assert.equal(new Set(rs.map((r) => r.body.numero_factura)).size, 1);
  assert.equal((await t.db.query('select count(*)::int as n from pos.ventas where id_cliente = $1', [v.id_cliente])).rows[0].n, 1);
  assert.equal(rs.filter((r) => r.status === 201).length, 1);
});

test('venta sin conexión: solo efectivo; tarjeta o transferencia se rechazan sin dejar nada a medias', async () => {
  const v = ventaOffline({ cobrar: { pagos: [{ forma_pago_id: forma('tarjeta'), monto: 75 }] } });
  const r = await caja.post('/api/pos/ventas', v);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /efectivo/);
  assert.equal((await t.db.query('select count(*)::int as n from pos.ventas where id_cliente = $1', [v.id_cliente])).rows[0].n, 0);
  assert.equal((await caja.get('/api/pos/ventas?estado=abierta')).body.length, 0);
  // y una venta sin conexión siempre llega ya cobrada y con su id
  assert.equal((await caja.post('/api/pos/ventas', { ...ventaOffline(), cobrar: undefined })).status, 400);
  assert.equal((await caja.post('/api/pos/ventas', { ...ventaOffline(), id_cliente: undefined })).status, 400);
});

test('venta sin conexión: si el precio subió y el cliente pagó de menos, se rechaza con código precio_cambio y no se factura', async () => {
  const v = ventaOffline({ cobrar: { pagos: pagoEf(50) } });          // pagó 50 y el producto cuesta 75
  const r = await caja.post('/api/pos/ventas', v);
  assert.equal(r.status, 409);
  assert.equal(r.body.codigo, 'precio_cambio');
  assert.equal((await t.db.query('select count(*)::int as n from pos.ventas where id_cliente = $1', [v.id_cliente])).rows[0].n, 0);
});

test('venta sin conexión: hora del cliente acotada, datos guardados para revisión y bitácora', async () => {
  const v = ventaOffline({ offline: { vendida_at: new Date(Date.now() + 3 * 3600_000).toISOString(), numero_provisional: 'OFF-TEST-0009', cajero_nombre: 'Cajera Ana', total_cliente: 70 } });
  const r = await caja.post('/api/pos/ventas', v);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const fila = (await t.db.query('select vendida_at, fecha_emision, offline_info from pos.ventas where id = $1', [r.body.id])).rows[0];
  assert.ok(new Date(fila.vendida_at) <= new Date(), 'una hora futura del reloj del equipo se recorta');
  assert.equal(fila.offline_info.cajero_nombre, 'Cajera Ana');
  assert.equal(fila.offline_info.total_servidor, 75);
  assert.equal(fila.offline_info.diferencia, 5, 'queda registrada la diferencia de precio contra lo que vio el cliente');
  const aud = (await t.db.query(`select detalle from core.auditoria where accion = 'venta_offline_sincronizada' and entidad_id = $1`, [r.body.id])).rows;
  assert.equal(aud.length, 1);
  assert.equal(aud[0].detalle.provisional, 'OFF-TEST-0009');
  // el ticket de esa factura muestra el comprobante provisional que se entregó
  const tk = (await caja.get(`/api/pos/ventas/${r.body.id}/ticket?columnas=48`)).body.lineas.join('\n');
  assert.match(tk, /Comprobante provisional: OFF-TEST-0009/);
  assert.match(tk, /BORRADOR - SIN VALOR FISCAL/);
  // y el listado de facturas lo expone
  const lista = (await gerente.get('/api/pos/ventas?estado=pagada')).body;
  assert.equal(lista.find((x) => x.id === r.body.id).numero_provisional, 'OFF-TEST-0009');
});

test('favoritos y más vendidos: solo quien edita catálogo puede marcar; la caja los recibe en el catálogo', async () => {
  const p = prod('Naranja Pura');
  const marcar = await fetch(`${t.base}/api/pos/catalogo/productos/${p.id}/favorito`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenCaja}`, 'x-empresa': 'origen' }, body: JSON.stringify({ favorito: true }) });
  assert.equal(marcar.status, 403);
  const tokenGer = await t.login('origen', 'ger@origen.hn', 'ClaveSegura123');
  const ok = await fetch(`${t.base}/api/pos/catalogo/productos/${p.id}/favorito`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenGer}`, 'x-empresa': 'origen' }, body: JSON.stringify({ favorito: true }) });
  assert.equal(ok.status, 200);
  const c = (await caja.get('/api/pos/catalogo')).body;
  assert.equal(c.productos.find((x) => x.id === p.id).favorito, true);
  assert.ok(c.mas_vendidos.includes(p.id), 'la naranja se ha vendido en estas pruebas');
  assert.ok(c.mas_vendidos.length <= 8);
  // el cambio de favorito cambia la huella del catálogo (las demás cajas lo reciben solas)
  const v1 = (await caja.get('/api/pos/catalogo/version')).body.v;
  await fetch(`${t.base}/api/pos/catalogo/productos/${p.id}/favorito`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenGer}`, 'x-empresa': 'origen' }, body: JSON.stringify({ favorito: false }) });
  assert.notEqual((await caja.get('/api/pos/catalogo/version')).body.v, v1);
});

test('PDF carta: marca de agua BORRADOR en cada página, leyenda y logo PNG incrustado', async () => {
  const png = fs.readFileSync(new URL('../../web/public/logos/diserco.png', import.meta.url));
  const img = leerPng(png);
  assert.ok(img && img.w > 100 && img.rgb.length > 0, 'el PNG del logo se entiende');
  assert.equal(leerPng(Buffer.from('no es un png')), null);
  const empresa = { nombre: 'DISERCO', razon_social: 'DISERCO S. de R.L.', rtn: '08019999999999', direccion: 'SPS', telefono: '2550-0000' };
  const lineas = Array.from({ length: 60 }, (_, i) => ({ nombre_producto: `Producto ${i + 1}`, cantidad: 1, precio_unitario: 10, precio_base: 10, descuento: 0, opciones: [] }));
  const venta = { estado: 'pagada', es_borrador_fiscal: true, numero_factura: 'BORRADOR-001-001-01-00000001', created_at: new Date().toISOString(), ticket_dia: 1, subtotal_exento: 0, subtotal_exonerado: 0, subtotal_gravado_15: 521.74, subtotal_gravado_18: 0, isv_total: 78.26, total: 600, descuento: 0 };
  const con = generarPdfFactura({ empresa, sucursal: { nombre: 'Matriz' }, venta, lineas, pagos: [], punto: null, cliente: null, cajero: null }, { logo: png });
  const txt = con.toString('latin1');
  const paginas = (txt.match(/\/Type \/Page /g) ?? []).length;
  assert.ok(paginas >= 2, 'la factura larga ocupa varias páginas');
  assert.equal((txt.match(/\(BORRADOR\) Tj/g) ?? []).length, paginas, 'la marca de agua sale en TODAS las páginas');
  assert.ok(txt.includes('BORRADOR - SIN VALOR FISCAL'));
  assert.ok(txt.includes('/Subtype /Image') && txt.includes('/Im1 Do'));
  const pos = Number(/startxref\n(\d+)/.exec(txt)[1]);
  assert.equal(txt.slice(pos, pos + 4), 'xref');
  const sin = generarPdfFactura({ empresa, sucursal: null, venta: { ...venta, es_borrador_fiscal: false, numero_factura: '001-001-01-00000001' }, lineas: lineas.slice(0, 2), pagos: [], punto: null, cliente: null, cajero: null }).toString('latin1');
  assert.ok(!sin.includes('BORRADOR') && !sin.includes('/Im1'));
});

test('cobro normal con id_cliente: si la respuesta se perdió y la caja reintenta como venta sin conexión, recibe LA MISMA factura', async () => {
  const idCliente = randomUUID();
  const orden = (await caja.post('/api/pos/ventas', { items: [{ producto_id: prod('Naranja Pura').id, cantidad: 2 }] })).body;
  const cobro = await caja.post(`/api/pos/ventas/${orden.id}/cobrar`, { pagos: pagoEf(200), id_cliente: idCliente });
  assert.equal(cobro.status, 200);
  // «se cayó la señal justo al responder»: la caja no lo supo y manda la venta como sin conexión sobre la misma orden
  const reintento = await caja.post('/api/pos/ventas', { id_cliente: idCliente, orden_id: orden.id, sucursal_id: suc, items: [{ producto_id: prod('Naranja Pura').id, cantidad: 2 }],
    cobrar: { pagos: pagoEf(200) }, offline: { vendida_at: new Date().toISOString(), numero_provisional: 'OFF-TEST-0020' } });
  assert.equal(reintento.status, 200);
  assert.equal(reintento.body.duplicado, true);
  assert.equal(reintento.body.id, orden.id);
  assert.equal(reintento.body.numero_factura, cobro.body.numero_factura);
});

test('venta sin conexión sobre una orden que ya estaba guardada como abierta: se cobra ESA orden (no queda una abierta huérfana)', async () => {
  const orden = (await caja.post('/api/pos/ventas', { items: [{ producto_id: prod('Naranja Pura').id, cantidad: 1 }] })).body;
  assert.equal((await caja.get('/api/pos/ventas?estado=abierta')).body.length, 1);
  const r = await caja.post('/api/pos/ventas', { id_cliente: randomUUID(), orden_id: orden.id, sucursal_id: suc, items: [{ producto_id: prod('Naranja Pura').id, cantidad: 3 }],
    cobrar: { pagos: pagoEf(300) }, offline: { vendida_at: new Date().toISOString(), numero_provisional: 'OFF-TEST-0021' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.id, orden.id);
  assert.equal(Number(r.body.lineas[0].cantidad), 3);
  assert.equal(Number(r.body.total), 225);
  assert.equal((await caja.get('/api/pos/ventas?estado=abierta')).body.length, 0);
  // si otra caja ya la había cobrado, se rechaza sin duplicar
  const otra = await caja.post('/api/pos/ventas', { id_cliente: randomUUID(), orden_id: orden.id, sucursal_id: suc, items: [{ producto_id: prod('Naranja Pura').id, cantidad: 1 }],
    cobrar: { pagos: pagoEf(100) }, offline: { vendida_at: new Date().toISOString(), numero_provisional: 'OFF-TEST-0022' } });
  assert.equal(otra.status, 409);
});
