import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from './helpers.js';
import { ITEMS_CHECKLIST, UMBRAL_RTN_OBLIGATORIO, problemaAgenda, rtnLuceValido, saldoPendiente, situacionEvento, subtotalCotizacion, totalCotizacion } from '../src/modulos/cotizaciones/calculo.js';

let t, ger, caja, origen, sucPrincipal;
const base = (o = {}) => ({
  nombre_cliente: 'María García', telefono_cliente: '9999-0000', email_cliente: 'maria@correo.hn', nombre_evento: 'Boda García',
  fecha_evento: '2030-06-15', hora_evento: '15:30', lugar: 'Salón Los Andes', cantidad_copitas: 100, precio_copita: 50, costo_servicio: 500, descuento: 100, notas: 'Sabores: fresa y pistacho', ...o,
});

before(async () => {
  t = await iniciar();
  await t.usuario({ nombre: 'Gerente Italo', email: 'ger@italo.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'italo', rol: 'gerente' }, { empresa: 'origen', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Cajero Italo', accesos: [{ empresa: 'italo', rol: 'cajero', pin: '4321' }] });
  ger = t.cli(await t.login('italo', 'ger@italo.hn', 'ClaveSegura123'), 'italo');
  caja = t.cli(await t.loginPin('italo', '4321'), 'italo');
  origen = t.cli(await t.login('origen', 'ger@italo.hn', 'ClaveSegura123'), 'origen');
  sucPrincipal = await t.db.query(`select s.id from core.sucursales s join core.empresas e on e.id = s.empresa_id where e.codigo = 'italo' order by s.orden limit 1`).then((r) => r.rows[0].id);
});
after(() => t.cerrar());

test('reglas puras: total, saldo, RTN, agenda y situación del evento', () => {
  const c = { cantidad_copitas: 100, precio_copita: 50, costo_servicio: 500, descuento: 100, anticipo: 1000, estado: 'aceptada', checklist: {}, fecha_evento: '2030-06-15' };
  assert.equal(subtotalCotizacion(c, [{ cantidad: 2, precio_unitario: 250 }]), 6000);
  assert.equal(totalCotizacion(c), 5400);
  assert.equal(saldoPendiente(c, 5400), 4400);
  assert.equal(saldoPendiente({ ...c, checklist: { cobro: { hecho: true } } }, 5400), 0);
  assert.equal(saldoPendiente({ ...c, estado: 'facturada' }, 5400), 0);
  assert.ok(rtnLuceValido('0801-1990-123456') && !rtnLuceValido('123'));
  assert.match(problemaAgenda({ fecha_evento: '2030-13-45' }), /Fecha/);
  assert.match(problemaAgenda({ hora_evento: '25:00' }), /Hora/);
  assert.match(problemaAgenda({ anticipo: 9999 }, 100), /anticipo/);
  assert.equal(problemaAgenda({ fecha_evento: '2030-01-01', hora_evento: '09:00', anticipo: 10 }, 100), null);
  assert.equal(situacionEvento({ ...c, estado: 'borrador' }, '2030-06-14'), null);
  assert.equal(situacionEvento(c, '2030-06-14').tipo, 'urgente');
  assert.equal(situacionEvento(c, '2030-05-01').tipo, 'en-curso');
  assert.equal(situacionEvento(c, '2030-07-01').tipo, 'vencido');
  const todo = Object.fromEntries(ITEMS_CHECKLIST.map((i) => [i.clave, { hecho: true }]));
  assert.equal(situacionEvento({ ...c, checklist: todo }, '2030-05-01').tipo, 'listo');
  assert.equal(situacionEvento({ ...c, checklist: todo, realizado: true }, '2030-07-01').tipo, 'cerrado');
  assert.equal(UMBRAL_RTN_OBLIGATORIO, 10000);
});

test('solo Italo (módulo encendido) y solo quien tiene cotizaciones:ver', async () => {
  assert.equal((await origen.get('/api/cotizaciones')).status, 403);   // Origen no tiene el módulo
  assert.equal((await caja.get('/api/cotizaciones')).status, 403);     // el cajero no ve cotizaciones
  assert.equal((await ger.get('/api/cotizaciones')).status, 200);
});

test('crear: total con partidas, número correlativo por empresa y validaciones', async () => {
  const r = await ger.post('/api/cotizaciones', base({ partidas: [{ descripcion: 'Carrito de gelato', cantidad: 1, precio_unitario: 1500 }] }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.numero, 1);
  assert.equal(r.body.subtotal, 7000);   // 100×50 + 500 + 1500
  assert.equal(r.body.total, 6900);
  assert.equal(r.body.estado, 'borrador');
  assert.equal(r.body.partidas.length, 1);
  assert.equal((await ger.post('/api/cotizaciones', base())).body.numero, 2);

  const malo = async (o, patron) => { const x = await ger.post('/api/cotizaciones', base(o)); assert.equal(x.status, 400, JSON.stringify(x.body)); assert.match(x.body.error, patron); };
  await malo({ nombre_cliente: '' }, /cliente/i);
  await malo({ rtn_cliente: '12345' }, /RTN/);
  await malo({ anticipo: 999999 }, /anticipo/i);
  await malo({ descuento: 999999 }, /descuento/i);
  await malo({ fecha_evento: '2030-02-31x' }, /./);
  await malo({ cantidad_copitas: 0 }, /copitas|partida/i);
  await malo({ estado: 'aceptada', fecha_evento: null }, /fecha/i);
  await malo({ estado: 'facturada' }, /./);   // «facturada» solo con Facturar
});

test('lista y filtro por estado; el detalle trae partidas y situación', async () => {
  const todas = (await ger.get('/api/cotizaciones')).body;
  assert.ok(todas.length >= 2);
  assert.equal((await ger.get('/api/cotizaciones?estado=aceptada')).body.length, 0);
  const una = (await ger.get(`/api/cotizaciones/${todas[0].id}`)).body;
  assert.ok(Array.isArray(una.partidas));
  assert.equal(una.pasos_total, ITEMS_CHECKLIST.length);
  assert.equal((await ger.get('/api/cotizaciones/00000000-0000-4000-8000-000000000000')).status, 404);
});

test('aceptar agenda el evento: exige fecha, marca el anticipo y habilita el seguimiento', async () => {
  const c = (await ger.post('/api/cotizaciones', base({ fecha_evento: null, anticipo: 0 }))).body;
  assert.equal((await ger.put(`/api/cotizaciones/${c.id}/seguimiento`, { realizado: true })).status, 409);   // aún no está aceptada
  const sinFecha = await ger.put(`/api/cotizaciones/${c.id}`, { estado: 'aceptada' });
  assert.equal(sinFecha.status, 400);
  assert.match(sinFecha.body.error, /fecha/i);
  const ok = await ger.put(`/api/cotizaciones/${c.id}`, { estado: 'aceptada', fecha_evento: '2030-06-15', hora_evento: '14:00', sucursal_id: sucPrincipal, anticipo: 1000 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.estado, 'aceptada');
  assert.equal(ok.body.checklist.anticipo.hecho, true);
  assert.equal(ok.body.saldo, ok.body.total - 1000);

  const paso = await ger.put(`/api/cotizaciones/${c.id}/seguimiento`, { item: 'sabores', hecho: true });
  assert.equal(paso.body.checklist.sabores.hecho, true);
  assert.equal(paso.body.checklist.sabores.por, 'Gerente Italo');
  assert.equal(paso.body.pasos_hechos, 2);
  assert.equal((await ger.put(`/api/cotizaciones/${c.id}/seguimiento`, { item: 'inventado', hecho: true })).status, 400);
  const repro = await ger.put(`/api/cotizaciones/${c.id}/seguimiento`, { fecha_evento: '2030-06-22', hora_evento: '16:00', lugar: 'Hotel', notas_seguimiento: 'Llevar 2 carritos' });
  assert.equal(repro.body.fecha_evento, '2030-06-22');
  assert.equal((await ger.put(`/api/cotizaciones/${c.id}/seguimiento`, { fecha_evento: '' })).status, 400);
  assert.equal((await ger.put(`/api/cotizaciones/${c.id}/seguimiento`, { anticipo: 99999 })).status, 400);
  assert.equal((await ger.put(`/api/cotizaciones/${c.id}/seguimiento`, {})).status, 400);

  const acciones = (await t.db.query(`select accion from core.auditoria where entidad = 'cotizacion' and entidad_id = $1`, [c.id])).rows.map((x) => x.accion);
  for (const a of ['cotizacion_creada', 'cotizacion_aceptada', 'evento_seguimiento', 'evento_reprogramado']) assert.ok(acciones.includes(a), a);
  const agendadas = (await ger.get('/api/cotizaciones?estado=aceptada')).body;
  assert.equal(agendadas.length, 1);
});

test('editar reemplaza partidas; eliminar solo borradores', async () => {
  const c = (await ger.post('/api/cotizaciones', base({ partidas: [{ descripcion: 'Toppings', cantidad: 2, precio_unitario: 100 }] }))).body;
  const e = await ger.put(`/api/cotizaciones/${c.id}`, { cantidad_copitas: 50, partidas: [] });
  assert.equal(e.body.partidas.length, 0);
  assert.equal(e.body.nombre_evento, 'Boda García');   // editar parcialmente no borra lo que no se manda
  assert.equal(e.body.lugar, 'Salón Los Andes');
  assert.equal(e.body.total, 50 * 50 + 500 - 100);
  assert.equal((await ger.put(`/api/cotizaciones/${c.id}`, { estado: 'rechazada' })).body.estado, 'rechazada');
  assert.equal((await ger.del(`/api/cotizaciones/${c.id}`)).status, 409);   // ya no es borrador
  await ger.put(`/api/cotizaciones/${c.id}`, { estado: 'borrador' });
  assert.equal((await ger.del(`/api/cotizaciones/${c.id}`)).status, 204);
  assert.equal((await ger.get(`/api/cotizaciones/${c.id}`)).status, 404);
});

test('documento imprimible trae empresa, validez y condiciones; el correo está pendiente de configurar', async () => {
  const c = (await ger.get('/api/cotizaciones')).body[0];
  const d = (await ger.get(`/api/cotizaciones/${c.id}/documento`)).body;
  assert.equal(d.empresa.nombre, 'Italo Gelateria');
  assert.equal(d.dias_validez, 15);
  assert.ok(d.condiciones.length >= 3);
  assert.equal(d.cotizacion.id, c.id);
  const env = await ger.post(`/api/cotizaciones/${c.id}/enviar`);
  assert.equal(env.status, 501);
  assert.equal(env.body.codigo, 'correo_pendiente');
  const sinCorreo = (await ger.post('/api/cotizaciones', base({ email_cliente: '' }))).body;
  assert.equal((await ger.post(`/api/cotizaciones/${sinCorreo.id}/enviar`)).status, 400);
});

test('facturar: emite la factura real con los mismos montos, enlaza al cliente y cierra la cotización', async () => {
  const c = (await ger.post('/api/cotizaciones', base({ cantidad_copitas: 20, precio_copita: 50, costo_servicio: 0, descuento: 0, anticipo: 200, estado: 'aceptada' }))).body;   // L1,000
  assert.equal((await caja.post(`/api/cotizaciones/${c.id}/facturar`, { forma_pago: 'efectivo' })).status, 403);
  assert.equal((await ger.post(`/api/cotizaciones/${c.id}/facturar`, { forma_pago: 'cheque' })).status, 400);
  assert.equal((await ger.post(`/api/cotizaciones/${c.id}/facturar`, { forma_pago: 'transferencia', rtn: '123' })).status, 400);
  const f = await ger.post(`/api/cotizaciones/${c.id}/facturar`, { sucursal_id: sucPrincipal, forma_pago: 'transferencia' });
  assert.equal(f.status, 201, JSON.stringify(f.body));
  assert.match(f.body.factura.numero_factura, /^BORRADOR-/);   // el punto de emisión de Italo sigue en borrador
  assert.equal(f.body.factura.total, 1000);
  assert.equal(f.body.cotizacion.estado, 'facturada');
  assert.equal(f.body.cotizacion.saldo, 0);
  assert.equal(f.body.cotizacion.checklist.cobro.hecho, true);
  const v = (await t.db.query('select * from pos.ventas where id = $1', [f.body.factura.id])).rows[0];
  assert.equal(v.estado, 'pagada');
  assert.equal(v.canal, 'evento');
  assert.equal(v.total, 1000);
  const pagos = (await t.db.query('select sum(monto)::numeric as m from pos.venta_pagos where venta_id = $1', [v.id])).rows[0];
  assert.equal(pagos.m, 1000);
  assert.ok(v.cliente_id);   // se creó/enlazó el cliente en terceros
  // ya facturada: no se edita, no se refactura
  assert.equal((await ger.put(`/api/cotizaciones/${c.id}`, { notas: 'x' })).status, 409);
  assert.equal((await ger.post(`/api/cotizaciones/${c.id}/facturar`, { forma_pago: 'efectivo' })).status, 409);
  assert.equal((await ger.put(`/api/cotizaciones/${c.id}`, { estado: 'borrador' })).status, 409);
  const acciones = (await t.db.query(`select accion from core.auditoria where entidad = 'cotizacion' and entidad_id = $1`, [c.id])).rows.map((x) => x.accion);
  assert.ok(acciones.includes('cotizacion_facturada'));
});

test('facturar con descuento y partidas cuadra al centavo; sobre L10,000 exige RTN; rechazadas no se facturan', async () => {
  const grande = (await ger.post('/api/cotizaciones', base({ cantidad_copitas: 300, precio_copita: 45, costo_servicio: 800, descuento: 333.33, anticipo: 0, partidas: [{ descripcion: 'Carrito', cantidad: 1, precio_unitario: 1200 }] }))).body;
  assert.equal(grande.total, 300 * 45 + 800 + 1200 - 333.33);
  const sinRtn = await ger.post(`/api/cotizaciones/${grande.id}/facturar`, { sucursal_id: sucPrincipal, forma_pago: 'tarjeta' });
  assert.equal(sinRtn.status, 400);
  assert.match(sinRtn.body.error, /RTN/);
  const ok = await ger.post(`/api/cotizaciones/${grande.id}/facturar`, { sucursal_id: sucPrincipal, forma_pago: 'tarjeta', rtn: '08011990123456' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.factura.total, grande.total);
  const v = (await t.db.query('select subtotal_gravado_15, isv_total, total, descuento from pos.ventas where id = $1', [ok.body.factura.id])).rows[0];
  assert.equal(Math.round((v.subtotal_gravado_15 + v.isv_total) * 100) / 100, v.total);   // base + ISV = total
  assert.equal(v.descuento, 333.33);
  const rech = (await ger.post('/api/cotizaciones', base({ estado: 'rechazada' }))).body;
  assert.equal((await ger.post(`/api/cotizaciones/${rech.id}/facturar`, { sucursal_id: sucPrincipal, forma_pago: 'efectivo' })).status, 409);
});
