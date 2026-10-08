// QA · facturas: datos del cliente congelados, anulación por fechas con autorización del dueño y notas de crédito apagadas.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fechaHN } from '@grupo/shared';
import { iniciar } from './helpers.js';
import { sembrar } from '../src/db/sembrar.js';

let t, caja, gerente, dueno, adminO, cat;
const prod = (n) => cat.productos.find((p) => p.nombre === n);
const efectivo = () => cat.formas_pago.find((f) => f.tipo === 'efectivo').id;
const vender = async (cliente_id) => (await caja.post('/api/pos/ventas', { cliente_id, items: [{ producto_id: prod('Naranja Pura').id, cantidad: 1 }], cobrar: { pagos: [{ forma_pago_id: efectivo(), monto: 100 }] } })).body;
const retrasar = (id, dias) => t.db.query(`update pos.ventas set fecha_emision = fecha_emision - ($2 || ' days')::interval where id = $1`, [id, String(dias)]);

before(async () => {
  t = await iniciar();
  await sembrar(t.db, t.config.semillas, 'origen');
  await t.usuario({ nombre: 'Dueño', email: 'dueno@grupo.hn', password: 'ClaveSegura123', dueno: true });
  await t.usuario({ nombre: 'Gerente', email: 'g@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Admin', email: 'a@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'admin' }] });
  await t.usuario({ nombre: 'Dueña Origen', email: 'do@origen.hn', password: 'ClaveDueno123', accesos: [{ empresa: 'origen', rol: 'dueno' }] });
  await t.usuario({ nombre: 'Cajera', accesos: [{ empresa: 'origen', rol: 'cajero', pin: '1234' }] });
  caja = t.cli(await t.loginPin('origen', '1234'), 'origen');
  gerente = t.cli(await t.login('origen', 'g@origen.hn', 'ClaveSegura123'), 'origen');
  adminO = t.cli(await t.login('origen', 'a@origen.hn', 'ClaveSegura123'), 'origen');
  dueno = t.cli(await t.login('origen', 'dueno@grupo.hn', 'ClaveSegura123'), 'origen');
  cat = (await caja.get('/api/pos/catalogo')).body;
});
after(() => t.cerrar());

test('la factura guarda nombre, RTN y dirección del cliente al emitirse: editar la ficha no cambia facturas viejas', async () => {
  const c = (await caja.post('/api/terceros', { nombre: 'Cliente Original SA', rtn: '08011990123456', direccion: 'Col. Uno', es_cliente: true })).body;
  const v = await vender(c.id);
  const abierta = (await caja.post('/api/pos/ventas', { cliente_id: c.id, items: [{ producto_id: prod('Naranja Pura').id, cantidad: 1 }] })).body;
  assert.equal((await caja.put(`/api/terceros/${c.id}`, { nombre: 'OTRO NOMBRE', rtn: '08011990999999', direccion: 'Otra', es_cliente: true })).status, 200);
  const d = (await gerente.get(`/api/pos/ventas/${v.id}`)).body;
  assert.equal(d.cliente.nombre, 'Cliente Original SA');
  assert.equal(d.cliente.rtn, '08011990123456');
  assert.equal(d.cliente.direccion, 'Col. Uno');
  const tk = (await gerente.get(`/api/pos/ventas/${v.id}/ticket?reimpresion=true&motivo=reimpresion&razon=prueba`)).body.lineas.join('\n');
  assert.match(tk, /Cliente Original SA/); assert.match(tk, /08011990123456/); assert.doesNotMatch(tk, /OTRO NOMBRE/);
  const lista = (await gerente.get('/api/pos/ventas?estado=facturadas')).body.find((x) => x.id === v.id);
  assert.equal(lista.cliente, 'Cliente Original SA'); assert.equal(lista.cliente_rtn, '08011990123456');
  assert.equal((await gerente.get('/api/pos/ventas?q=08011990123456')).body.some((x) => x.id === v.id), true);
  const libro = (await gerente.get('/api/pos/reportes/libro')).body.find((x) => x.numero_factura === v.numero_factura);
  assert.equal(libro.cliente, 'Cliente Original SA'); assert.equal(libro.rtn, '08011990123456');
  const pdf = await fetch(`${t.base}/api/pos/ventas/${v.id}/pdf`, { headers: { authorization: `Bearer ${await t.login('origen', 'g@origen.hn', 'ClaveSegura123')}`, 'x-empresa': 'origen' } });
  assert.equal(pdf.status, 200);
  // una orden todavía ABIERTA sí toma los datos vigentes al cobrarse
  const cobrada = (await caja.post(`/api/pos/ventas/${abierta.id}/cobrar`, { pagos: [{ forma_pago_id: efectivo(), monto: 100 }] })).body;
  assert.equal(cobrada.cliente.nombre, 'OTRO NOMBRE');
  // el trigger de la migración: la columna quedó llena
  assert.equal((await t.db.query('select cliente_nombre from pos.ventas where id = $1', [v.id])).rows[0].cliente_nombre, 'Cliente Original SA');
});

test('anular: el mismo día basta pos:anular; días anteriores del mes piden autorización de un dueño; de meses anteriores no se puede', async () => {
  const hoy = fechaHN();
  // mismo día
  const a = await vender();
  assert.equal((await gerente.post(`/api/pos/ventas/${a.id}/anular`, { motivo: 'Error al cobrar' })).status, 200);
  // mes anterior: nadie anula, ni el dueño; el mensaje manda a contabilidad
  const viejo = await vender(); await retrasar(viejo.id, 45);
  for (const cli of [gerente, dueno]) {
    const r = await cli.post(`/api/pos/ventas/${viejo.id}/anular`, { motivo: 'Error al cobrar', autorizacion: { email: 'do@origen.hn', password: 'ClaveDueno123' } });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /contabilidad/i);
  }
  if (Number(hoy.slice(8)) === 1) return;     // el día 1 no existe «día anterior del mismo mes»
  // día anterior del mismo mes
  const b = await vender(); await retrasar(b.id, 1);
  let r = await gerente.post(`/api/pos/ventas/${b.id}/anular`, { motivo: 'Error al cobrar' });
  assert.equal(r.status, 403); assert.equal(r.body.codigo, 'requiere_autorizacion');
  r = await gerente.post(`/api/pos/ventas/${b.id}/anular`, { motivo: 'Error al cobrar', autorizacion: { email: 'g@origen.hn', password: 'ClaveSegura123' } });
  assert.equal(r.status, 403); assert.equal(r.body.codigo, 'autorizacion_invalida');          // un gerente no autoriza
  r = await gerente.post(`/api/pos/ventas/${b.id}/anular`, { motivo: 'Error al cobrar', autorizacion: { email: 'a@origen.hn', password: 'ClaveSegura123' } });
  assert.equal(r.status, 403);                                                                  // ni un administrador de empresa
  r = await gerente.post(`/api/pos/ventas/${b.id}/anular`, { motivo: 'Error al cobrar', autorizacion: { email: 'do@origen.hn', password: 'mala' } });
  assert.equal(r.status, 403);
  assert.equal((await gerente.get(`/api/pos/ventas/${b.id}`)).body.estado, 'pagada');
  assert.ok((await t.db.query(`select 1 from core.auditoria where accion = 'anulacion_autorizacion_fallida'`)).rowCount >= 1);
  r = await gerente.post(`/api/pos/ventas/${b.id}/anular`, { motivo: 'Error al cobrar', autorizacion: { email: 'do@origen.hn', password: 'ClaveDueno123' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const bit = (await t.db.query(`select detalle from core.auditoria where accion = 'venta_anulada' and entidad_id = $1`, [b.id])).rows[0].detalle;
  assert.equal(bit.autorizado_por, 'Dueña Origen');
  // el dueño que anula directamente queda como su propio autorizador
  const c = await vender(); await retrasar(c.id, 1);
  assert.equal((await dueno.post(`/api/pos/ventas/${c.id}/anular`, { motivo: 'Error al cobrar' })).status, 200);
  assert.equal((await t.db.query(`select detalle from core.auditoria where accion = 'venta_anulada' and entidad_id = $1`, [c.id])).rows[0].detalle.autorizado_por, 'Dueño');
});

test('notas de crédito: apagadas por defecto (el negocio no las usa); se encienden con core.config pos.usar_notas_credito', async () => {
  const v = await vender();
  const r = await gerente.post(`/api/pos/ventas/${v.id}/nota-credito`, { motivo: 'Devolución', monto: 10 });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /no están habilitadas/);
  assert.equal((await gerente.get('/api/auth/yo')).status, 200);
  const yo = await (await fetch(`${t.base}/api/auth/yo`, { headers: { authorization: `Bearer ${await t.login('origen', 'g@origen.hn', 'ClaveSegura123')}`, 'x-empresa': 'origen' } })).json();
  assert.equal(yo.contexto.usar_notas_credito, false);
  await t.activarNotasCredito('origen');
  assert.equal((await gerente.post(`/api/pos/ventas/${v.id}/nota-credito`, { motivo: 'Devolución', monto: 10 })).status, 201);
  const yo2 = await (await fetch(`${t.base}/api/auth/yo`, { headers: { authorization: `Bearer ${await t.login('origen', 'g@origen.hn', 'ClaveSegura123')}`, 'x-empresa': 'origen' } })).json();
  assert.equal(yo2.contexto.usar_notas_credito, true);
});
