import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from './helpers.js';
import { sembrar } from '../src/db/sembrar.js';

let t, caja, gerente, dueno, ecoDueno, cat, suc;
const prod = (n) => cat.productos.find((p) => p.nombre === n);
const efectivo = () => cat.formas_pago.find((f) => f.tipo === 'efectivo').id;
const vender = (cli, nombre = 'Naranja Pura', cant = 1, extra = {}) =>
  cli.post('/api/pos/ventas', { items: [{ producto_id: prod(nombre).id, cantidad: cant, ...(extra.item ?? {}) }], cobrar: { pagos: [{ forma_pago_id: efectivo(), monto: 1000 }] }, ...extra.cuerpo });
const alertas = async (q = '') => (await dueno.get(`/api/antifraude/alertas${q}`)).body;
const deTipo = (lista, tipo) => lista.filter((a) => a.tipo === tipo);
const conDispositivo = async (path, token, dispositivo, body) => {
  const r = await fetch(t.base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-empresa': 'origen', 'x-dispositivo': dispositivo, 'user-agent': 'Prueba/1.0' }, body: body ? JSON.stringify(body) : undefined });
  return r.status;
};

before(async () => {
  t = await iniciar();
  await t.activarNotasCredito('origen');
  await sembrar(t.db, t.config.semillas, 'origen');
  await t.usuario({ nombre: 'Dueño', email: 'dueno@grupo.hn', password: 'ClaveSegura123', dueno: true });
  await t.usuario({ nombre: 'Gerente', email: 'ger@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Cajera Ana', accesos: [{ empresa: 'origen', rol: 'cajero', pin: '1234' }] });
  caja = t.cli(await t.loginPin('origen', '1234'), 'origen');
  gerente = t.cli(await t.login('origen', 'ger@origen.hn', 'ClaveSegura123'), 'origen');
  const token = await t.login('origen', 'dueno@grupo.hn', 'ClaveSegura123');
  dueno = t.cli(token, 'origen');
  ecoDueno = t.cli(token, 'ecostone');
  cat = (await caja.get('/api/pos/catalogo')).body;
  suc = cat.sucursales[0].id;
});
after(() => t.cerrar());

test('permisos y módulo: solo dueño/admin; EcoStone no tiene antifraude', async () => {
  assert.equal((await caja.get('/api/antifraude/alertas')).status, 403);
  assert.equal((await gerente.get('/api/antifraude/alertas')).status, 403);
  assert.equal((await gerente.get('/api/antifraude/reglas')).status, 403);
  assert.equal((await dueno.get('/api/antifraude/alertas')).status, 200);
  const eco = await ecoDueno.get('/api/antifraude/alertas');
  assert.equal(eco.status, 404);
  assert.equal(eco.body.codigo, 'modulo_inactivo');
  // lo que necesita cualquier usuario: ¿hay vigilancia y cuándo bloquear?
  const s = (await caja.get('/api/antifraude/sesion')).body;
  assert.deepEqual(s, { activo: true, minutos_bloqueo: 10 });
  assert.equal((await gerente.get('/api/antifraude/sesion')).body.minutos_bloqueo, 20);
  assert.equal((await ecoDueno.get('/api/antifraude/sesion')).body.activo, false);
  // en una empresa sin el módulo los eventos se ignoran en silencio
  assert.equal((await ecoDueno.post('/api/antifraude/evento', { accion: 'pantalla.ver', detalle: { pantalla: 'x' } })).status, 204);
  assert.equal((await t.db.query(`select count(*)::int as n from core.auditoria where accion = 'pantalla.ver' and empresa_id = (select id from core.empresas where codigo = 'ecostone')`)).rows[0].n, 0);
});

test('doble factura: mismos productos y total en pocos minutos levanta alerta', async () => {
  assert.equal((await vender(caja, 'Green Detox', 1)).status, 201);
  assert.equal((await vender(caja, 'Naranja Pura', 2)).status, 201);
  assert.equal(deTipo(await alertas(), 'venta.doble_factura').length, 0);
  assert.equal((await vender(caja, 'Naranja Pura', 2)).status, 201);        // idéntica a la anterior
  const a = deTipo(await alertas(), 'venta.doble_factura');
  assert.equal(a.length, 1);
  assert.equal(a[0].estado, 'pendiente');
  assert.equal(a[0].usuario_nombre, 'Cajera Ana');
  assert.match(a[0].titulo, /Posible doble factura/);
});

test('tercera edad: el mismo carné usado más de 3 veces en el día alerta (severidad alta)', async () => {
  const cuerpo = { tercera_edad: { nombre: 'Don José Pérez', identidad: '0801-1948-00456' } };
  for (let i = 0; i < 4; i++) { const r = await vender(caja, 'Naranja Pura', 1, { item: { descuento_porcentaje: 25 }, cuerpo }); assert.equal(r.status, 201, JSON.stringify(r.body)); }
  const a = deTipo(await alertas(), 'tercera_edad.carne_repetido');
  assert.equal(a.length, 1);
  assert.equal(a[0].severidad, 'alta');
  assert.match(a[0].titulo, /0801-1948-00456/);
});

test('bandeja: estados pendiente → investigando → resuelta, con nota; el contador baja', async () => {
  const antes = (await dueno.get('/api/antifraude/alertas/pendientes')).body;
  assert.ok(antes.pendientes >= 2);
  const lista = await alertas();
  const id = deTipo(lista, 'venta.doble_factura')[0].id;
  const inv = await dueno.put(`/api/antifraude/alertas/${id}/estado`, { estado: 'investigando', nota: 'Revisando cámaras' });
  assert.equal(inv.body.estado, 'investigando');
  assert.equal((await dueno.get('/api/antifraude/alertas/pendientes')).body.pendientes, antes.pendientes);   // sigue abierta
  const res = await dueno.put(`/api/antifraude/alertas/${id}/estado`, { estado: 'resuelta', nota: 'Era un pedido doble real' });
  assert.equal(res.body.estado, 'resuelta');
  assert.equal(res.body.nota_revision, 'Era un pedido doble real');
  assert.equal((await dueno.get('/api/antifraude/alertas/pendientes')).body.pendientes, antes.pendientes - 1);
  assert.equal((await alertas('?solo_pendientes=1')).some((a) => a.id === id), false);
  assert.equal((await alertas('?estado=resuelta')).some((a) => a.id === id), true);
  assert.equal((await dueno.put(`/api/antifraude/alertas/${id}/estado`, { estado: 'inventado' })).status, 400);
  assert.equal((await dueno.put(`/api/antifraude/alertas/999999/estado`, { estado: 'resuelta' })).status, 404);
  assert.equal((await caja.put(`/api/antifraude/alertas/${id}/estado`, { estado: 'resuelta' })).status, 403);
  // quedó en la bitácora
  assert.equal((await t.db.query(`select count(*)::int as n from core.auditoria where accion = 'alerta_revisada' and entidad_id = $1`, [String(id)])).rows[0].n, 2);
  // notificaciones en vivo: solo lo posterior al último id visto
  const nuevas = (await dueno.get('/api/antifraude/alertas/nuevas?desde_id=0')).body;
  assert.ok(nuevas.length > 0);
  assert.equal((await dueno.get(`/api/antifraude/alertas/nuevas?desde_id=${nuevas[0].id}`)).body.length, 0);
});

test('las alertas son de cada empresa: Italo no ve las de Origen', async () => {
  const italo = t.cli(await t.login('origen', 'dueno@grupo.hn', 'ClaveSegura123'), 'italo');
  assert.equal((await italo.get('/api/antifraude/alertas')).body.length, 0);
  assert.equal((await italo.get('/api/antifraude/alertas/pendientes')).body.pendientes, 0);
});

test('reglas: se ajustan por empresa, se validan y quedan en la bitácora', async () => {
  const r0 = (await dueno.get('/api/antifraude/reglas')).body;
  assert.equal(r0.max_usos_carne_dia, 3);
  assert.equal(r0.minutos_bloqueo_cajero, 10);
  const r1 = (await dueno.put('/api/antifraude/reglas', { minutos_bloqueo_cajero: 5, intentos_login: '4', inventada: 9, minutos_hueco: -3 })).body;
  assert.equal(r1.minutos_bloqueo_cajero, 5);
  assert.equal(r1.intentos_login, 4);
  assert.equal(r1.minutos_hueco, 45);                    // negativo: se ignora
  assert.equal(r1.inventada, undefined);
  assert.equal((await caja.get('/api/antifraude/sesion')).body.minutos_bloqueo, 5);
  assert.equal((await gerente.put('/api/antifraude/reglas', { intentos_login: 1 })).status, 403);
  assert.equal((await t.db.query(`select count(*)::int as n from core.auditoria where accion = 'antifraude_reglas'`)).rows[0].n, 1);
  await dueno.put('/api/antifraude/reglas', { intentos_login: 5, minutos_bloqueo_cajero: 10 });
});

test('intentos fallidos de entrar: al llegar al límite levanta una alerta (una vez)', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await t.cli().post('/api/auth/login', { empresa: 'origen', email: 'ger@origen.hn', password: 'mala-clave' })).status, 401);
  const a = deTipo(await alertas(), 'sesion.login_fallido');
  assert.equal(a.length, 1);
  assert.match(a[0].titulo, /5 intentos fallidos de entrar como "ger@origen.hn"/);
  assert.equal(a[0].severidad, 'alta');
  const uso = (await dueno.get('/api/antifraude/uso')).body;
  assert.ok(uso.login_fallidos.length >= 5);
});

test('dispositivos: uno nuevo y el uso simultáneo desde dos equipos alertan', async () => {
  const token = await t.loginPin('origen', '1234');
  assert.equal(await conDispositivo('/api/antifraude/evento', token, 'aaaaaaaa11111111', { accion: 'sesion.inicio' }), 204);
  assert.equal(deTipo(await alertas(), 'sesion.dispositivo_nuevo').length, 0);     // el primero de la persona no alerta
  assert.equal(await conDispositivo('/api/antifraude/evento', token, 'bbbbbbbb22222222', { accion: 'pantalla.ver', detalle: { pantalla: 'Facturación' } }), 204);
  const nuevo = deTipo(await alertas(), 'sesion.dispositivo_nuevo');
  assert.equal(nuevo.length, 1);
  assert.match(nuevo[0].titulo, /Cajera Ana entró desde un dispositivo nuevo/);
  assert.equal(deTipo(await alertas(), 'sesion.simultanea').length, 1);            // los dos hablaron en menos de 3 min
  const disp = (await dueno.get('/api/antifraude/dispositivos')).body;
  assert.equal(disp.filter((d) => d.usuario === 'Cajera Ana').length, 2);
});

test('eventos de uso: solo prefijos permitidos; alimentan la línea de tiempo, el uso y los indicadores', async () => {
  assert.equal((await caja.post('/api/antifraude/evento', { accion: 'venta.facturar' })).status, 400);
  assert.equal((await caja.post('/api/antifraude/evento', { accion: 'pantalla.ver', detalle: { pantalla: 'Cierre de caja', objeto: { x: 1 } } })).status, 204);
  assert.equal((await caja.post('/api/antifraude/evento', { accion: 'orden.quitar_producto', detalle: { producto: 'Naranja Pura', cantidad: 2, monto: 150 } })).status, 204);
  const usuarios = (await dueno.get('/api/antifraude/usuarios')).body;
  const ana = usuarios.find((u) => u.nombre === 'Cajera Ana');
  assert.ok(ana && usuarios.some((u) => u.nombre === 'Dueño'));
  const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Tegucigalpa' }).format(new Date());

  const lt = (await dueno.get(`/api/antifraude/linea-tiempo?usuario_id=${ana.id}&fecha=${hoy}`)).body;
  assert.ok(lt.resumen.facturas >= 7);
  assert.equal(lt.resumen.tercera_edad, 4);
  assert.ok(lt.items.some((i) => i.accion === 'pantalla.ver') && lt.items.some((i) => i.accion === 'venta_cobrada'));
  assert.deepEqual(lt.items.map((i) => i.momento), [...lt.items.map((i) => i.momento)].sort());

  const uso = (await dueno.get('/api/antifraude/uso')).body;
  assert.ok(uso.pantallas.some((p) => p.usuario === 'Cajera Ana' && p.pantalla === 'Cierre de caja'));
  assert.ok(uso.eventos.every((e) => e.detalle?.objeto === undefined));              // el detalle se acota a valores simples

  const ind = (await dueno.get(`/api/antifraude/indicadores?desde=${hoy}&hasta=${hoy}`)).body;
  const f = ind.cajeros.find((c) => c.nombre === 'Cajera Ana');
  assert.ok(f.facturas >= 7);
  assert.equal(f.desc_25, 4);
  assert.equal(f.quitados, 2);
  assert.ok(f.pct_efectivo === 100 && f.pantallas >= 1);
  assert.ok(Array.isArray(f.senales) && typeof ind.totales.facturas === 'number');
  assert.equal((await dueno.get('/api/antifraude/indicadores')).status, 400);          // falta el rango
});

test('fuera de horario: quien no es dueño/admin y usa el sistema fuera de las horas normales alerta', async () => {
  await dueno.put('/api/antifraude/reglas', { hora_apertura: 0, hora_cierre: 0 });       // toda hora es "fuera"
  await caja.post('/api/antifraude/evento', { accion: 'pantalla.ver', detalle: { pantalla: 'Facturación' } });
  await dueno.post('/api/antifraude/evento', { accion: 'pantalla.ver', detalle: { pantalla: 'Antifraude' } });   // el dueño no alerta
  const a = deTipo(await alertas(), 'horario.fuera');
  assert.equal(a.length, 1);
  assert.equal(a[0].usuario_nombre, 'Cajera Ana');
  await dueno.put('/api/antifraude/reglas', { hora_apertura: 9, hora_cierre: 24 });
});

test('arqueo sorpresa: compara lo contado contra fondo + efectivo − salidas; el diferencia genera alerta; solo con permiso', async () => {
  assert.equal((await caja.post('/api/antifraude/arqueos', { sucursal_id: suc, contado: 10 })).status, 403);
  const efe = (await t.db.query(`select coalesce(sum(p.monto),0)::numeric as m from pos.venta_pagos p join pos.formas_pago f on f.id = p.forma_pago_id join pos.ventas v on v.id = p.venta_id where v.estado = 'pagada' and f.tipo = 'efectivo'`)).rows[0].m;
  assert.ok(efe > 0);
  await caja.post('/api/pos/turno/movimiento', { tipo: 'salida', monto: 25, concepto: 'Hielo' });
  const ok = await dueno.post('/api/antifraude/arqueos', { sucursal_id: suc, contado: efe - 25 + 100, fondo_caja: 100, nota: 'Visita sin aviso' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.esperado, efe - 25 + 100);
  assert.equal(ok.body.diferencia, 0);
  assert.equal(ok.body.salidas, 25);
  assert.match(ok.body.cajeros_turno, /Cajera Ana/);
  assert.equal(deTipo(await alertas(), 'arqueo.descuadre').length, 0);                    // cuadra: sin alerta
  const falta = await dueno.post('/api/antifraude/arqueos', { sucursal_id: suc, contado: efe - 25 + 100 - 40, fondo_caja: 100 });
  assert.equal(falta.body.diferencia, -40);
  const al = deTipo(await alertas(), 'arqueo.descuadre');
  assert.equal(al.length, 1);
  assert.equal(al[0].severidad, 'alta');
  assert.match(al[0].titulo, /faltan L 40.00/);
  const hist = (await dueno.get('/api/antifraude/arqueos')).body;
  assert.equal(hist.length, 2);
  assert.equal((await dueno.post('/api/antifraude/arqueos', { sucursal_id: suc, contado: -5 })).status, 400);
});

test('revisión: cierre con faltante, orden estacionada y análisis del periodo', async () => {
  // orden armada y sin cobrar, con el umbral de "estacionada" en 0 minutos
  await dueno.put('/api/antifraude/reglas', { minutos_orden_estacionada: 0 });
  // cierre de turno con faltante
  const cierre = await caja.post('/api/pos/turno/cerrar', { efectivo_contado: 0 });
  assert.equal(cierre.status, 200, JSON.stringify(cierre.body));
  const orden = await caja.post('/api/pos/ventas', { items: [{ producto_id: prod('Naranja Pura').id, cantidad: 3 }] });
  assert.equal(orden.status, 201);
  assert.equal((await dueno.post('/api/antifraude/revisar')).status, 200);
  const lista = await alertas();
  assert.equal(deTipo(lista, 'orden.estacionada').length, 1);
  assert.match(deTipo(lista, 'orden.estacionada')[0].titulo, /abierta hace/);
  const d = deTipo(lista, 'cierre.descuadre');
  assert.equal(d.length, 1);
  assert.equal(d[0].severidad, 'alta');
  assert.equal(d[0].usuario_nombre, 'Cajera Ana');
  await dueno.post('/api/antifraude/revisar');                                              // no se repite
  assert.equal(deTipo(await alertas(), 'cierre.descuadre').length, 1);
  assert.equal(deTipo(await alertas(), 'orden.estacionada').length, 1);

  const an = (await dueno.get('/api/antifraude/analisis')).body;
  assert.ok(Array.isArray(an.alertas) && an.alertas.some((x) => x.tipo === 'descuadre_caja'));
  const tend = (await dueno.get('/api/antifraude/tendencia')).body;
  const ana = tend.find((x) => x.nombre === 'Cajera Ana');
  assert.ok(ana && ana.total >= 3 && ana.semanas.length === 4 && ana.semanas[3] === ana.total);
});

test('anular una factura y emitir una nota de crédito quedan como alertas para revisar', async () => {
  const v = (await vender(caja, 'Green Detox', 1)).body;
  const an = await dueno.post(`/api/pos/ventas/${v.id}/anular`, { motivo: 'Cliente se arrepintió' });
  assert.equal(an.status, 200, JSON.stringify(an.body));
  const v2 = (await vender(caja, 'Naranja Pura', 5)).body;
  assert.equal((await dueno.post(`/api/pos/ventas/${v2.id}/nota-credito`, { motivo: 'Devolución parcial', monto: 50 })).status, 201);
  const lista = await alertas();
  assert.equal(deTipo(lista, 'venta.anular').length, 1);
  assert.equal(deTipo(lista, 'venta.nota_credito').length, 1);
  assert.match(deTipo(lista, 'venta.nota_credito')[0].titulo, /L 50.00/);
});

test('integridad de la bitácora: íntegra; si alguien la altera directo en la base, se detecta y se alerta', async () => {
  const ok = (await dueno.get('/api/antifraude/integridad')).body;
  assert.equal(ok.integra, true);
  assert.ok(ok.total > 20);
  await t.db.exec('alter table core.auditoria disable trigger auditoria_sin_update');
  await t.db.query(`update core.auditoria set detalle = '{"alterado":true}'::jsonb where id = (select min(id) from core.auditoria)`);
  await t.db.exec('alter table core.auditoria enable trigger auditoria_sin_update');
  const mal = (await dueno.get('/api/antifraude/integridad')).body;
  assert.equal(mal.integra, false);
  await dueno.post('/api/antifraude/revisar');
  const a = deTipo(await alertas(), 'bitacora.alterada');
  assert.equal(a.length, 1);
  assert.equal(a[0].severidad, 'alta');
});
