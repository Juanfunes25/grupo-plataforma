import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from './helpers.js';
import { sembrar } from '../src/db/sembrar.js';
import { calcularCuadre, totalConteo } from '../src/modulos/pos/cierre-calculo.js';
import { fechaHN } from '@grupo/shared';

let t, caja, gerente, dueno, cat, suc, hasta1;
const prod = (n) => cat.productos.find((p) => p.nombre === n);
const fp = (tipo) => cat.formas_pago.find((f) => f.tipo === tipo).id;
const vender = (cli, tipo, monto = 100) =>
  cli.post('/api/pos/ventas', { sucursal_id: suc, items: [{ producto_id: prod('Naranja Pura').id, cantidad: 1 }], cobrar: { pagos: [{ forma_pago_id: fp(tipo), monto }] } });
const consulta = (desde, hasta) => `sucursal_id=${suc}&desde=${encodeURIComponent(desde.toISOString())}&hasta=${encodeURIComponent(hasta.toISOString())}`;
const hace = (min) => new Date(Date.now() - min * 60_000);
const enUnMinuto = () => new Date(Date.now() + 60_000);

before(async () => {
  t = await iniciar();
  await sembrar(t.db, t.config.semillas, 'origen');
  await t.usuario({ nombre: 'Dueño', email: 'dueno@grupo.hn', password: 'ClaveSegura123', dueno: true });
  await t.usuario({ nombre: 'Gerente', email: 'ger@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Cajera Ana', accesos: [{ empresa: 'origen', rol: 'cajero', pin: '1234' }] });
  caja = t.cli(await t.loginPin('origen', '1234'), 'origen');
  gerente = t.cli(await t.login('origen', 'ger@origen.hn', 'ClaveSegura123'), 'origen');
  dueno = t.cli(await t.login('origen', 'dueno@grupo.hn', 'ClaveSegura123'), 'origen');
  cat = (await caja.get('/api/pos/catalogo')).body;
  suc = cat.sucursales[0].id;
});
after(() => t.cerrar());

test('cálculo del cuadre: tarjeta contra los POS, efectivo contra fondo + ventas + ingresos − salidas; el conteo suma', () => {
  const c = calcularCuadre({ tarjeta: 200, efectivo: 500 }, { pos_bancos: { BAC: 120, Ficohsa: 70 }, fondo_caja: 100, salidas: 20, ingresos: 10, efectivo_contado: 585 });
  assert.equal(c.tarjeta_reportada, 190);
  assert.equal(c.diferencia_tarjeta, -10);
  assert.equal(c.efectivo_esperado, 590);
  assert.equal(c.diferencia_efectivo, -5);
  assert.equal(c.diferencia_total, -15);
  assert.equal(totalConteo({ 500: 1, 100: 2, 0.5: 3 }), 701.5);
});

test('caja chica: el cajero registra sin turno abierto, no puede fechar atrás, y todo suma por categoría', async () => {
  const r = await caja.post('/api/pos/caja-chica', { sucursal_id: suc, tipo: 'salida', categoria: 'Transportes', monto: 20, concepto: 'Taxi a banco' });
  assert.equal(r.status, 201);
  assert.equal(r.body.turno_id, null, 'sin turno abierto, el movimiento queda suelto');
  assert.equal(r.body.fecha, fechaHN());
  assert.equal((await caja.post('/api/pos/caja-chica', { sucursal_id: suc, monto: 5, concepto: 'x', fecha: '2024-01-01' })).status, 400);
  assert.equal((await caja.post('/api/pos/caja-chica', { sucursal_id: suc, monto: 5, categoria: 'Inventada', concepto: 'Cosa' })).status, 400);
  assert.equal((await caja.post('/api/pos/caja-chica', { sucursal_id: suc, monto: 0, concepto: 'Cosa' })).status, 400);
  // la gerente sí puede registrar un gasto de un día anterior (no entra en el efectivo de hoy)
  const ayer = new Date(Date.now() - 36 * 3600_000).toISOString().slice(0, 10);
  assert.equal((await gerente.post('/api/pos/caja-chica', { sucursal_id: suc, categoria: 'Agua', monto: 33, concepto: 'Recibo de agua', fecha: ayer })).status, 201);
  const l = (await gerente.get(`/api/pos/caja-chica?sucursal_id=${suc}&desde=${ayer}&hasta=${fechaHN()}`)).body;
  assert.equal(l.items.length, 2);
  assert.equal(l.totales.salidas, 53);
  assert.deepEqual(l.por_categoria.map((c) => c.categoria).sort(), ['Agua', 'Transportes']);
  assert.ok(l.categorias.includes('Telefonía e internet'));
});

test('cierre de caja: resumen por forma de pago, cierre ciego del cajero y validaciones', async () => {
  const desde = hace(60);
  assert.equal((await vender(caja, 'efectivo', 100)).status, 201);       // L75 netos, L25 de cambio
  assert.equal((await vender(caja, 'tarjeta', 75)).status, 201);
  assert.equal((await vender(caja, 'transferencia', 75)).status, 201);
  hasta1 = new Date();

  const g = (await gerente.get(`/api/pos/cierres/resumen?${consulta(desde, hasta1)}`)).body;
  assert.equal(g.ciego, false);
  assert.equal(g.cantidad_facturas, 3);
  assert.equal(g.total_ventas, 225);
  assert.deepEqual([g.efectivo, g.tarjeta, g.transferencia], [75, 75, 75], 'el efectivo es neto del cambio');
  assert.equal(g.salidas_sugeridas, 20, 'la caja chica de hoy se sugiere como salidas');
  assert.equal(g.turnos_abiertos.length, 1, 'el turno se abrió solo al primer cobro');
  const c = (await caja.get(`/api/pos/cierres/resumen?${consulta(desde, hasta1)}`)).body;
  assert.equal(c.ciego, true);
  assert.equal(c.total_ventas, undefined, 'el cajero no recibe lo que dice el sistema');
  assert.equal(c.efectivo, undefined);
  assert.equal(c.cantidad_facturas, 3);

  const cuerpo = { sucursal_id: suc, fecha_inicio: desde.toISOString(), fecha_fin: hasta1.toISOString(), pos: { BAC: 50, Ficohsa: 25 }, fondo_caja: 100, salidas: 20, efectivo_contado: 155 };
  assert.equal((await gerente.post('/api/pos/cierres', { ...cuerpo, pos: { BAC: 50 } })).status, 400, 'falta el POS de Ficohsa');
  assert.equal((await gerente.post('/api/pos/cierres', { ...cuerpo, pos: { BAC: 50, Ficohsa: 25, Visa: 1 } })).status, 400, 'banco no configurado');
  const sinObs = await gerente.post('/api/pos/cierres', { ...cuerpo, efectivo_contado: 140 });
  assert.equal(sinObs.status, 400);
  assert.match(sinObs.body.error, /no cuadra/i);
  const conteoMal = await gerente.post('/api/pos/cierres', { ...cuerpo, conteo: { 100: 1, 50: 1 } });
  assert.equal(conteoMal.status, 400);
  assert.match(conteoMal.body.error, /conteo/i);
  assert.equal((await gerente.post('/api/pos/cierres', { ...cuerpo, conteo: { 7: 1 } })).status, 400);
  assert.equal((await t.db.query('select count(*)::int n from pos.cierres_caja')).rows[0].n, 0, 'nada de lo anterior guardó un cierre');
});

test('cierre de caja: guarda el desglose, cierra el turno abierto y no rompe el flujo automático', async () => {
  const desde = hace(60);
  const cuerpo = { sucursal_id: suc, fecha_inicio: desde.toISOString(), fecha_fin: hasta1.toISOString(), pos: { BAC: 50, Ficohsa: 25 }, fondo_caja: 100, salidas: 20, efectivo_contado: 155,
    conteo: { 100: 1, 50: 1, 5: 1 } };
  const r = await gerente.post('/api/pos/cierres', cuerpo);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.descuadre, false);
  assert.equal(r.body.turnos_cerrados, 1);
  assert.deepEqual([r.body.efectivo_sistema, r.body.tarjeta_sistema, r.body.transferencia_sistema, r.body.total_ventas], [75, 75, 75, 225]);
  assert.deepEqual([r.body.efectivo_esperado, r.body.diferencia_efectivo, r.body.diferencia_tarjeta, r.body.diferencia], [155, 0, 0, 0]);
  assert.deepEqual(r.body.pos_bancos, { BAC: 50, Ficohsa: 25 });
  assert.equal(r.body.desglose_pagos.length, 3);
  assert.equal(r.body.cantidad_facturas, 3);
  assert.match(r.body.factura_desde, /^BORRADOR|\d/);

  const turnos = (await t.db.query('select estado, cierre_id, efectivo_contado, diferencia from pos.turnos')).rows;
  assert.equal(turnos.length, 1);
  assert.equal(turnos[0].estado, 'cerrado');
  assert.equal(turnos[0].cierre_id, r.body.id);
  assert.equal(turnos[0].efectivo_contado, 155);
  assert.equal(turnos[0].diferencia, 0);

  // mismo rango otra vez, o uno que se traslapa: 409
  const dup = await gerente.post('/api/pos/cierres', cuerpo);
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /Ya existe un cierre/);
  assert.equal((await gerente.post('/api/pos/cierres', { ...cuerpo, fecha_inicio: hace(10).toISOString(), fecha_fin: enUnMinuto().toISOString() })).status, 409);
  // un cierre es inalterable
  await assert.rejects(t.db.query('update pos.cierres_caja set efectivo_contado = 0'), /no se puede modificar/);
  await assert.rejects(t.db.query('delete from pos.cierres_caja'), /no se puede modificar/);

  // el flujo automático sigue: el siguiente cobro abre otro turno solo
  assert.equal((await vender(caja, 'efectivo', 75)).status, 201);
  const act = (await caja.get(`/api/pos/turno/actual?sucursal_id=${suc}`)).body;
  assert.ok(act.turno, 'se abrió un turno nuevo');
  assert.equal(Number(act.turno.fondo_inicial), 0);
});

test('cierre ciego del cajero: no ve el sistema, pero el descuadre queda registrado y avisado', async () => {
  const r = await caja.post('/api/pos/cierres', { sucursal_id: suc, fecha_inicio: hasta1.toISOString(), fecha_fin: enUnMinuto().toISOString(), pos: { BAC: 0, Ficohsa: 0 }, efectivo_contado: 70 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.descuadre, true, 'faltan L5 de efectivo');
  assert.equal(r.body.cierre_ciego, true);
  assert.equal(r.body.diferencia, undefined, 'el cajero no recibe la diferencia ni lo que dijo el sistema');
  assert.equal(r.body.efectivo_sistema, undefined);
  assert.equal(r.body.turnos_cerrados, 1);
  const guardado = (await t.db.query('select diferencia_efectivo, alertas from pos.cierres_caja where id = $1', [r.body.id])).rows[0];
  assert.equal(guardado.diferencia_efectivo, -5);
  assert.equal(guardado.alertas[0].tipo, 'descuadre');
  const acciones = (await t.db.query(`select accion from core.auditoria where entidad = 'cierre'`)).rows.map((x) => x.accion);
  assert.ok(acciones.includes('cierre_caja') && acciones.includes('cierre_alerta_descuadre'));
  // el cajero no abre el historial de todos
  assert.equal((await caja.get('/api/pos/cierres')).status, 403);
});

test('historial, detalle con desglose y ticket del cierre', async () => {
  const lista = (await gerente.get(`/api/pos/cierres?sucursal_id=${suc}`)).body;
  assert.equal(lista.length, 2);
  assert.equal(lista[0].cajero, 'Cajera Ana');
  const primero = lista[1];
  const d = (await gerente.get(`/api/pos/cierres/${primero.id}`)).body;
  assert.equal(d.facturas.length, 3);
  assert.equal(d.desglose.tarjeta.length, 1);
  assert.equal(d.desglose.transferencia.length, 1);
  assert.equal(d.turnos_cerrados_lista.length, 1);
  assert.deepEqual(d.config.bancos, ['BAC', 'Ficohsa']);
  const tk = (await gerente.get(`/api/pos/cierres/${primero.id}/ticket?columnas=42`)).body.lineas.join('\n');
  for (const frag of ['CIERRE DE CAJA', 'POS BAC', 'POS Ficohsa', 'Esperado en caja', 'CONTEO DE BILLETES', '1 x L 100', 'FACTURAS CON TARJETA', 'Firma supervisor']) assert.ok(tk.includes(frag), frag);
  assert.ok(tk.split('\n').every((l) => l.length <= 42), 'cabe en 42 columnas');
  // la cajera solo ve sus cierres y sin el sistema; el de la gerente no es suyo
  assert.equal((await caja.get(`/api/pos/cierres/${primero.id}`)).status, 404);
  const suyo = (await caja.get(`/api/pos/cierres/${lista[0].id}`)).body;
  assert.equal(suyo.tarjeta_sistema, undefined);
  const tkCiego = (await caja.get(`/api/pos/cierres/${lista[0].id}/ticket`)).body.lineas.join('\n');
  assert.ok(!tkCiego.includes('Esperado en caja') && !tkCiego.includes('TOTAL VENTAS'));
  // el dueño del grupo sí lo ve
  assert.equal((await dueno.get(`/api/pos/cierres/${primero.id}`)).status, 200);
});

test('reportes completo: KPIs con periodo anterior, formas de pago, ISV por tipo, gastos y libro', async () => {
  const hoy = fechaHN();
  const r = await gerente.get(`/api/pos/reportes/completo?desde=${hoy}&hasta=${hoy}&sucursal_id=${suc}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body;
  assert.equal(d.kpis.facturas, 4);
  assert.equal(d.kpis.ventas, 300);
  assert.equal(d.kpis.ticket_promedio, 75);
  assert.equal(d.kpis_anterior.facturas, 0);
  assert.equal(d.rango_anterior.hasta < d.desde, true);
  const formas = Object.fromEntries(d.por_forma_pago.map((f) => [f.tipo, f.monto]));
  assert.deepEqual([formas.efectivo, formas.tarjeta, formas.transferencia], [150, 75, 75], 'efectivo neto del cambio');
  assert.equal(d.por_sucursal.length, 1);
  assert.equal(d.por_cajero[0].facturas, 4);
  assert.equal(d.productos[0].nombre, 'Naranja Pura');
  assert.equal(d.productos[0].cantidad, 4);
  assert.equal(d.por_categoria.length, 1);
  assert.equal(d.por_hora.length, 24);
  assert.equal(d.calor.length, 7);
  assert.equal(d.por_dia.length, 1);
  assert.equal(d.isv.borrador.facturas, 4, 'sin CAI real todo sale como borrador');
  assert.equal(d.isv.fiscal.facturas, 0);
  assert.equal(d.libro_ventas.length, 4);
  assert.equal(d.gastos.total, 20, 'solo la salida de hoy (la de ayer queda fuera del rango)');
  assert.equal(d.gastos_por_tipo[0].tipo, 'Transportes');
  assert.equal(d.anuladas.length, 0);
  // validaciones y permisos
  assert.equal((await gerente.get(`/api/pos/reportes/completo?desde=${hoy}&hasta=2020-01-01`)).status, 400);
  assert.equal((await gerente.get('/api/pos/reportes/completo')).status, 400);
  assert.equal((await caja.get(`/api/pos/reportes/completo?desde=${hoy}&hasta=${hoy}`)).status, 403);
});

test('reportes completo: anulaciones y notas de crédito entran en sus secciones', async () => {
  const v = (await vender(caja, 'efectivo', 75)).body;
  const nc = await gerente.post(`/api/pos/ventas/${v.id}/nota-credito`, { motivo: 'Devolución parcial', monto: 25 });
  assert.equal(nc.status, 201);
  const v2 = (await vender(caja, 'efectivo', 75)).body;
  assert.equal((await gerente.post(`/api/pos/ventas/${v2.id}/anular`, { motivo: 'Error de digitación' })).status, 200);
  const hoy = fechaHN();
  const d = (await gerente.get(`/api/pos/reportes/completo?desde=${hoy}&hasta=${hoy}`)).body;
  assert.equal(d.kpis.anuladas, 1);
  assert.equal(d.kpis.monto_anulado, 75);
  assert.equal(d.kpis.notas_credito, 25);
  assert.equal(d.kpis.ventas_netas, d.kpis.ventas - 25);
  assert.equal(d.anuladas[0].motivo, 'Error de digitación');
  assert.equal(d.notas_credito[0].tipo, 'Parcial');
  assert.equal(d.libro_ventas.filter((x) => x.anulada).length, 1);
  assert.equal(d.isv.borrador.anuladas, 1);
});

test('dashboard: KPIs, formas de pago, sucursales, productos y tendencia; solo con permiso de reportes', async () => {
  const hoy = fechaHN();
  const r = await gerente.get(`/api/pos/dashboard?desde=${hoy}&hasta=${hoy}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body;
  assert.equal(d.cantidad_facturas, 5);
  assert.equal(d.total, 375);
  assert.equal(d.ticket_promedio, 75);
  assert.equal(d.hoy.total, 375);
  assert.equal(d.anuladas.n, 1);
  assert.equal(d.formas_pago.reduce((s, f) => s + f.porcentaje, 0) > 99, true);
  assert.equal(d.por_sucursal[0].facturas, 5);
  assert.equal(d.top_productos[0].nombre, 'Naranja Pura');
  assert.equal(d.tendencia_diaria.length, 1);
  assert.equal(d.por_categoria.length, 1);
  assert.equal(d.anterior.facturas, 0);
  assert.equal((await caja.get('/api/pos/dashboard')).status, 403);
  // sin fechas usa el mes en curso
  assert.equal((await gerente.get('/api/pos/dashboard')).body.desde, `${hoy.slice(0, 8)}01`);
});
