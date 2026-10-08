import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from './helpers.js';
import { sembrar } from '../src/db/sembrar.js';

// Paridad del POS con Italo Facturación: RTN sobre el umbral, tercera edad al cobrar, descarte con motivo, ticket original/copia,
// PDF, listado de facturas, sincronización en vivo y estado del CAI.
let t, caja, gerente, dueno, cat, suc, tokenCaja;
const parchear = async (ruta, cuerpo) => { const r = await fetch(t.base + ruta, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenCaja}`, 'x-empresa': 'origen' }, body: JSON.stringify(cuerpo) }); return { status: r.status }; };
const prod = (n) => cat.productos.find((p) => p.nombre === n);
const forma = (tipo) => cat.formas_pago.find((f) => f.tipo === tipo).id;
const item = (nombre, cantidad = 1, extra = {}) => ({ producto_id: prod(nombre).id, cantidad, ...extra });
const pagoEf = (monto) => [{ forma_pago_id: forma('efectivo'), monto }];

before(async () => {
  t = await iniciar();
  await t.activarNotasCredito('origen');
  await sembrar(t.db, t.config.semillas, 'origen');
  await t.usuario({ nombre: 'Dueño', email: 'dueno@grupo.hn', password: 'ClaveSegura123', dueno: true });
  await t.usuario({ nombre: 'Gerente', email: 'ger@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Cajera Ana', accesos: [{ empresa: 'origen', rol: 'cajero', pin: '1234' }] });
  tokenCaja = await t.loginPin('origen', '1234');
  caja = t.cli(tokenCaja, 'origen');
  gerente = t.cli(await t.login('origen', 'ger@origen.hn', 'ClaveSegura123'), 'origen');
  dueno = t.cli(await t.login('origen', 'dueno@grupo.hn', 'ClaveSegura123'), 'origen');
  cat = (await caja.get('/api/pos/catalogo')).body;
  suc = cat.sucursales[0].id;
});
after(() => t.cerrar());

test('RTN obligatorio sobre L 10,000: sin RTN no se cobra; con un cliente con RTN sí; Consumidor Final no basta', async () => {
  // En la etapa de pruebas la migración 0026 deja el RTN como aviso; aquí se vuelve a exigir para comprobar la regla.
  const empId = (await t.db.query(`select id from core.empresas where codigo = 'origen'`)).rows[0].id;
  await t.db.query(`insert into core.config (empresa_id, clave, valor) values ($1, 'pos', '{"rtn_bloqueante": true}'::jsonb) on conflict (empresa_id, clave) do update set valor = core.config.valor || '{"rtn_bloqueante": true}'::jsonb`, [empId]);
  cat = (await caja.get('/api/pos/catalogo')).body;
  assert.equal(cat.config.umbral_rtn, 10000);
  const grande = { items: [item('Naranja Pura', 200)], cobrar: { pagos: pagoEf(20000) } };       // 200 × 75 = 15,000
  const sin = await caja.post('/api/pos/ventas', grande);
  assert.equal(sin.status, 400);
  assert.match(sin.body.error, /RTN/);
  assert.equal((await caja.get('/api/pos/ventas?estado=abierta')).body.length, 0, 'la venta rechazada no deja una orden a medias');
  // un cliente sin RTN tampoco sirve
  const sinRtn = (await caja.post('/api/terceros', { nombre: 'Pedro Sin RTN', es_cliente: true })).body;
  assert.equal((await caja.post('/api/pos/ventas', { ...grande, cliente_id: sinRtn.id })).status, 400);
  // RTN mal escrito (13 dígitos): el directorio lo rechaza antes de llegar a la venta
  assert.equal((await caja.post('/api/terceros', { nombre: 'RTN corto', rtn: '0801199012345', es_cliente: true })).status, 400);
  const con = (await caja.post('/api/terceros', { nombre: 'Hotel Central SA', rtn: '08011990123456', es_cliente: true })).body;
  const ok = await caja.post('/api/pos/ventas', { ...grande, cliente_id: con.id });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.cliente.rtn, '08011990123456');
  // exactamente en el umbral NO exige RTN (la ley dice "mayor a")
  const justo = await caja.post('/api/pos/ventas', { items: [item('Naranja Pura', 133)], cobrar: { pagos: pagoEf(20000) } });      // 133 × 75 = 9,975
  assert.equal(justo.status, 201, JSON.stringify(justo.body));
  assert.equal((await caja.post('/api/pos/ventas', { items: [item('Naranja Pura', 134)], cobrar: { pagos: pagoEf(20000) } })).status, 400);   // 10,050
  // el umbral se puede ajustar por empresa
  const emp = (await t.db.query(`select id from core.empresas where codigo = 'origen'`)).rows[0].id;
  await t.db.query(`insert into core.config (empresa_id, clave, valor) values ($1, 'pos', '{"umbral_rtn": 500}'::jsonb) on conflict (empresa_id, clave) do update set valor = core.config.valor || '{"umbral_rtn": 500}'::jsonb`, [emp]);
  assert.equal((await caja.get('/api/pos/catalogo')).body.config.umbral_rtn, 500);
  assert.equal((await caja.post('/api/pos/ventas', { items: [item('Naranja Pura', 10)], cobrar: { pagos: pagoEf(1000) } })).status, 400);
  await t.db.query(`update core.config set valor = valor - 'umbral_rtn' where empresa_id = $1 and clave = 'pos'`, [emp]);
  await t.db.query(`update core.config set valor = valor || '{"rtn_bloqueante": false}'::jsonb where empresa_id = $1 and clave = 'pos'`, [emp]);   // vuelve al estado de pruebas de 0026
});

test('orden abierta: se puede volver a Consumidor Final y guardar el carné de tercera edad a medias; el carné se exige al COBRAR', async () => {
  const cli = (await caja.post('/api/terceros', { nombre: 'Maria Exenta', es_cliente: true, exento_impuestos: true })).body;
  const r = await dueno.post('/api/pos/ventas', { items: [item('Naranja Pura', 2, { descuento_porcentaje: 25 })], cliente_id: cli.id });   // guardar sin carné: válido
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.id;
  assert.equal(r.body.cliente.exento_impuestos, true);
  // volver a Consumidor Final (null explícito) funciona
  const p = await dueno.put(`/api/pos/ventas/${id}`, { cliente_id: null });
  assert.equal(p.status, 200);
  assert.equal(p.body.cliente.es_consumidor_final, true);
  // cobrar sin carné: rechazado
  const mal = await dueno.post(`/api/pos/ventas/${id}/cobrar`, { pagos: pagoEf(500) });
  assert.equal(mal.status, 400);
  assert.match(mal.body.error, /tercera edad/);
  // carné demasiado corto no pasa; uno de 5+ caracteres sí
  assert.equal((await dueno.put(`/api/pos/ventas/${id}`, { items: [item('Naranja Pura', 2, { descuento_porcentaje: 25 })], tercera_edad: { nombre: 'Ana Luz', identidad: '12' } })).status, 400);
  const ok = await dueno.put(`/api/pos/ventas/${id}`, { items: [item('Naranja Pura', 2, { descuento_porcentaje: 25 })], tercera_edad: { nombre: 'Ana Luz', identidad: 'A-12345' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const cobro = await dueno.post(`/api/pos/ventas/${id}/cobrar`, { pagos: pagoEf(500) });
  assert.equal(cobro.status, 200, JSON.stringify(cobro.body));
  assert.equal(cobro.body.descuento, 37.5);
  assert.equal(cobro.body.total, 112.5);
});

test('descartar una orden: cualquier cajero, con motivo; queda en la bitácora y las grandes levantan alerta', async () => {
  const chica = (await caja.post('/api/pos/ventas', { items: [item('Naranja Pura')] })).body;
  assert.equal((await caja.post(`/api/pos/ventas/${chica.id}/descartar`, {})).status, 400);                        // sin motivo
  assert.equal((await caja.post(`/api/pos/ventas/${chica.id}/descartar`, { motivo: 'Error al digitar la orden' })).status, 204);
  assert.equal((await caja.get(`/api/pos/ventas/${chica.id}`)).status, 404);
  const grande = (await caja.post('/api/pos/ventas', { items: [item('Naranja Pura', 4)] })).body;                     // L 300
  assert.equal((await caja.post(`/api/pos/ventas/${grande.id}/descartar`, { motivo: 'El cliente se arrepintió' })).status, 204);
  const aud = (await dueno.get('/api/admin/auditoria?limite=100')).body.filter((a) => a.accion === 'orden_descartada');
  assert.equal(aud.length, 2);
  assert.equal(aud[0].detalle.motivo, 'El cliente se arrepintió');
  assert.deepEqual(aud[0].detalle.items, ['4× Naranja Pura']);
  const alertas = (await t.db.query(`select tipo, severidad from af.alertas where tipo = 'descartar_orden'`)).rows;
  assert.equal(alertas.length, 1, 'solo la de L 300 pasa el umbral de L 150');
  // una factura ya cobrada no se descarta
  const pagada = (await caja.post('/api/pos/ventas', { items: [item('Naranja Pura')], cobrar: { pagos: pagoEf(100) } })).body;
  assert.equal((await caja.post(`/api/pos/ventas/${pagada.id}/descartar`, { motivo: 'Probando eso' })).status, 409);
});

test('ticket: la 1.ª impresión es original, las demás salen COPIA #n; el motivo queda en la bitácora; HTML listo para la térmica', async () => {
  const v = (await caja.post('/api/pos/ventas', { items: [item('Naranja Pura')], cobrar: { pagos: pagoEf(100) } })).body;
  const original = (await caja.get(`/api/pos/ventas/${v.id}/ticket?columnas=48`)).body;
  assert.equal(original.copia, 0);
  assert.doesNotMatch(original.lineas.join('\n'), /COPIA/);
  assert.match(original.lineas.join('\n'), /Efectivo recibido/);
  assert.match(original.lineas.join('\n'), /Cambio/);
  // aunque la pidan como "normal", la 2.ª vez ya es copia
  const segunda = (await caja.get(`/api/pos/ventas/${v.id}/ticket?columnas=48`)).body;
  assert.equal(segunda.copia, 1);
  assert.match(segunda.lineas.join('\n'), /REIMPRESION #1/);
  // reimpresión con la UI nueva: exige motivo
  assert.equal((await caja.get(`/api/pos/ventas/${v.id}/ticket?motivo=reimpresion`)).status, 400);
  const tercera = await caja.get(`/api/pos/ventas/${v.id}/ticket?motivo=reimpresion&razon=${encodeURIComponent('El papel se trabó')}&formato=html&columnas=32`);
  assert.equal(tercera.status, 200);
  assert.match(tercera.body, /@page \{ size: 58mm/);
  assert.match(tercera.body, /REIMPRESION #2/);
  const fila = (await t.db.query('select impresiones, reimpresiones from pos.ventas where id = $1', [v.id])).rows[0];
  assert.deepEqual(fila, { impresiones: 3, reimpresiones: 2 });
  const aud = (await dueno.get('/api/admin/auditoria?limite=100')).body.filter((a) => a.accion === 'factura_reimpresa' && a.entidad_id === v.id);
  assert.equal(aud.length, 2);
  assert.ok(aud.some((a) => a.detalle.motivo === 'El papel se trabó'));
  // la 2.ª copia de la misma factura levanta alerta de reimpresión repetida
  const al = (await t.db.query(`select severidad from af.alertas where tipo = 'reimpresion_repetida'`)).rows;
  assert.equal(al.length, 1);
  // quien no puede reimprimir no puede sacar copias
  await t.usuario({ nombre: 'Solo ventas', accesos: [{ empresa: 'origen', rol: 'cajero', pin: '5678' }] });
  const id = (await t.db.query(`select id from core.usuarios where nombre = 'Solo ventas'`)).rows[0].id;
  await t.db.query(`update core.accesos set permisos_quitados = '{pos:reimprimir}' where usuario_id = $1`, [id]);
  const sinPermiso = t.cli(await t.loginPin('origen', '5678'), 'origen');
  assert.equal((await sinPermiso.get(`/api/pos/ventas/${v.id}/ticket`)).status, 403);
});

test('PDF de la factura: archivo válido con los datos fiscales; ticket de prueba de la impresora', async () => {
  const cli = (await caja.post('/api/terceros', { nombre: 'Café Ñandú', rtn: '05019876543210', es_cliente: true })).body;
  const v = (await caja.post('/api/pos/ventas', { cliente_id: cli.id, items: [item('Naranja Pura', 2)], cobrar: { pagos: pagoEf(200) } })).body;
  const r = await fetch(`${t.base}/api/pos/ventas/${v.id}/pdf`, { headers: { authorization: `Bearer ${tokenCaja}`, 'x-empresa': 'origen' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  assert.match(buf.toString('latin1'), /%%EOF\s*$/);
  const texto = buf.toString('latin1');
  assert.ok(texto.includes(v.numero_factura), 'trae el número de factura');
  assert.ok(texto.includes('05019876543210'), 'trae el RTN del cliente');
  assert.ok(texto.includes('SIN VALIDEZ FISCAL'), 'en modo borrador lo dice');
  // tabla de referencias coherente: startxref apunta a "xref"
  const pos = Number(/startxref\n(\d+)/.exec(texto)[1]);
  assert.equal(texto.slice(pos, pos + 4), 'xref');
  const prueba = (await caja.get(`/api/pos/ventas/impresora/prueba?columnas=32&sucursal_id=${suc}`)).body;
  assert.equal(prueba.columnas, 32);
  assert.ok(prueba.lineas.some((l) => l.length === 32 && /^\d+$/.test(l)));
  assert.ok((await caja.get('/api/pos/ventas/impresora/prueba?formato=html')).body.includes('PRUEBA DE IMPRESORA'));
});

test('listado de facturas: cliente, RTN, pagos por forma, acreditado, búsqueda por cliente/RTN y anuladas', async () => {
  const mixto = (await caja.post('/api/pos/ventas', { items: [item('Naranja Pura', 2)], cobrar: { pagos: [{ forma_pago_id: forma('tarjeta'), monto: 100 }, { forma_pago_id: forma('efectivo'), monto: 50 }] } })).body;
  await gerente.post(`/api/pos/ventas/${mixto.id}/nota-credito`, { motivo: 'Devolución parcial', monto: 40 });
  const l = (await gerente.get('/api/pos/ventas?estado=facturadas&limite=200')).body;
  const f = l.find((x) => x.id === mixto.id);
  assert.deepEqual(f.pagos.map((p) => [p.forma, p.monto]), [['Efectivo', 50], ['Tarjeta', 100]]);
  assert.equal(f.acreditado, 40);
  assert.ok(l.every((x) => x.estado !== 'abierta'));
  assert.equal(f.sucursal_id, suc);
  assert.ok((await gerente.get('/api/pos/ventas?q=Hotel%20Central')).body.some((x) => x.cliente_rtn === '08011990123456'));
  assert.ok((await gerente.get('/api/pos/ventas?q=0501987')).body.some((x) => x.cliente === 'Café Ñandú'));
  await gerente.post(`/api/pos/ventas/${mixto.id}/anular`, { motivo: 'Prueba' });
  assert.ok((await gerente.get('/api/pos/ventas?estado=anulada')).body.some((x) => x.id === mixto.id));
  assert.equal((await gerente.get(`/api/pos/ventas/${mixto.id}`)).body.cliente.es_consumidor_final, true);
});

test('sincronización en vivo: la huella de ventas y la del catálogo cambian cuando alguien guarda, cobra o edita', async () => {
  const h0 = (await caja.get(`/api/pos/ventas/cambios?sucursal_id=${suc}`)).body;
  const o = (await caja.post('/api/pos/ventas', { items: [item('Naranja Pura')] })).body;
  const h1 = (await caja.get(`/api/pos/ventas/cambios?sucursal_id=${suc}`)).body;
  assert.equal(h1.abiertas, h0.abiertas + 1);
  assert.notEqual(h1.huella, h0.huella);
  await caja.post(`/api/pos/ventas/${o.id}/descartar`, { motivo: 'Ya no va' });
  const h2 = (await caja.get(`/api/pos/ventas/cambios?sucursal_id=${suc}`)).body;
  assert.equal(h2.abiertas, h0.abiertas);
  const v0 = (await caja.get('/api/pos/catalogo/version')).body.v;
  assert.equal((await caja.get('/api/pos/catalogo/version')).body.v, v0, 'sin cambios, la misma huella');
  assert.equal((await parchear(`/api/pos/catalogo/productos/${prod('Naranja Pura').id}/disponible`, { disponible: false })).status, 200);
  const v1 = (await caja.get('/api/pos/catalogo/version')).body.v;
  assert.notEqual(v1, v0);
  await parchear(`/api/pos/catalogo/productos/${prod('Naranja Pura').id}/disponible`, { disponible: true });
  assert.equal((await caja.get('/api/pos/catalogo/version')).body.v, v0);
});

test('CAI: el catálogo avisa cuando el rango se agota o vence, y una sucursal sin punto de emisión no aparece en fiscal', async () => {
  assert.equal(cat.fiscal[suc].agotado, false);
  assert.equal(cat.fiscal[suc].vencido, false);
  const pe = (await t.db.query('select * from pos.puntos_emision where sucursal_id = $1', [suc])).rows[0];
  await t.db.query(`update pos.puntos_emision set es_borrador = false, cai = '2F4851-96A881-B76670-CE6CCE-48D250-32', correlativo_desde = 1, correlativo_hasta = 100, correlativo_actual = 95, fecha_limite_emision = (current_date + 5) where id = $1`, [pe.id]);
  let f = (await caja.get('/api/pos/catalogo')).body.fiscal[suc];
  assert.equal(f.alerta, true);
  assert.equal(f.restantes, 6);
  assert.ok(f.dias_restantes <= 5);
  await t.db.query('update pos.puntos_emision set fecha_limite_emision = (current_date - 1) where id = $1', [pe.id]);
  f = (await caja.get('/api/pos/catalogo')).body.fiscal[suc];
  assert.equal(f.vencido, true);
  await t.db.query('update pos.puntos_emision set activo = false where id = $1', [pe.id]);
  assert.equal((await caja.get('/api/pos/catalogo')).body.fiscal[suc], undefined);
});

test('eventos del POS a la bitácora: solo los conocidos', async () => {
  assert.equal((await caja.post('/api/pos/ventas/evento', { accion: 'orden.quitar_producto', detalle: { producto: 'Naranja Pura', cantidad: 2, monto: 150 }, sucursal_id: suc })).status, 204);
  assert.equal((await caja.post('/api/pos/ventas/evento', { accion: 'orden.descuento', detalle: { porcentaje: 25 } })).status, 204);
  assert.equal((await caja.post('/api/pos/ventas/evento', { accion: 'hackear.todo', detalle: {} })).status, 400);
  const aud = (await dueno.get('/api/admin/auditoria?limite=200')).body.map((a) => a.accion);
  assert.ok(aud.includes('orden.quitar_producto') && aud.includes('orden.descuento'));
});
