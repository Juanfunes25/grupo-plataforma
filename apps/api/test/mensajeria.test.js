// Correo y avisos: servicio de correo (cola, reintentos, límite), factura y cotizaciones por correo,
// resumen diario idempotente, alertas agrupadas con pausa y la pantalla de Administración.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fechaHN } from '@grupo/shared';
import { iniciar } from './helpers.js';
import { sembrar } from '../src/db/sembrar.js';
import { configurarCorreo, enviarCorreo, procesarCola, normalizarDestinatarios, plantillaCorreo, correoConfigurado } from '../src/lib/correo.js';
import { enviarResumenDiario, armarResumen, htmlResumen, diaDelResumen } from '../src/modulos/mensajeria/resumen.js';
import { evaluarAlertas, registrarErrorGrave, avisarErroresGraves } from '../src/modulos/mensajeria/alertas.js';
import { empresasActivas } from '../src/modulos/mensajeria/resumen.js';
import { normalizarCotizacion } from '../src/modulos/mensajeria/envios.js';
import { generarPdfDocumento } from '../src/modulos/mensajeria/pdfSimple.js';

let t, dueno, adminI, caja, gerOrigen, cat, enviados, falla;
const transporte = { sendMail: async (m) => { if (falla) throw new Error(falla); enviados.push(m); } };
const efectivo = () => cat.formas_pago.find((f) => f.tipo === 'efectivo').id;
const MANANA = new Date('2026-10-09T14:00:00Z');   // 08:00 en Honduras (UTC-6)
const MADRUGADA = new Date('2026-10-09T11:00:00Z'); // 05:00 en Honduras

before(async () => {
  t = await iniciar();
  await sembrar(t.db, t.config.semillas, 'origen');
  await t.usuario({ nombre: 'Dueño', email: 'dueno@grupo.hn', password: 'ClaveSegura123', dueno: true });
  await t.usuario({ nombre: 'Admin Italo', email: 'admin@italo.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'italo', rol: 'admin' }] });
  await t.usuario({ nombre: 'Gerente Origen', email: 'g@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Cajera', accesos: [{ empresa: 'origen', rol: 'cajero', pin: '1234' }] });
  dueno = t.cli(await t.login('italo', 'dueno@grupo.hn', 'ClaveSegura123'), 'italo');
  adminI = t.cli(await t.login('italo', 'admin@italo.hn', 'ClaveSegura123'), 'italo');
  gerOrigen = t.cli(await t.login('origen', 'g@origen.hn', 'ClaveSegura123'), 'origen');
  caja = t.cli(await t.loginPin('origen', '1234'), 'origen');
  cat = (await caja.get('/api/pos/catalogo')).body;
  enviados = []; falla = null;
});
after(() => t.cerrar());
const limpiar = async () => { enviados.length = 0; falla = null; await t.db.query('delete from msg.avisos_estado'); await t.db.query('delete from msg.correos'); };

test('sin Gmail configurado: queda «pendiente de configurar», sin lanzar y sin perder el correo', async () => {
  assert.equal(correoConfigurado(), false);
  const r = await enviarCorreo({ empresaId: await t.empresaId('italo'), para: 'cliente@correo.hn', asunto: 'Hola', html: '<p>Hola</p>' });
  assert.equal(r.ok, false); assert.equal(r.pendiente, true); assert.match(r.error, /configurar/i);
  const fila = (await t.db.query('select estado, ultimo_error, para from msg.correos where id = $1', [r.id])).rows[0];
  assert.equal(fila.estado, 'pendiente'); assert.deepEqual(fila.para, ['cliente@correo.hn']);
  // Al configurarse, la cola lo manda solo
  await t.db.query(`update msg.correos set proximo_intento = now() where id = $1`, [r.id]);
  configurarCorreo({ transporte });
  assert.equal(await procesarCola(), 1);
  assert.equal(enviados.length, 1);
  assert.equal((await t.db.query('select estado from msg.correos where id = $1', [r.id])).rows[0].estado, 'enviado');
});

test('destinatarios, plantilla con el nombre de la empresa y HTML escapado', async () => {
  assert.deepEqual(normalizarDestinatarios('A@x.com, b@y.hn; a@x.com malo').validos, ['a@x.com', 'b@y.hn']);
  assert.deepEqual(normalizarDestinatarios('malo').invalidos, ['malo']);
  const sin = await enviarCorreo({ para: 'no-es-correo', asunto: 'x', html: 'x' });
  assert.equal(sin.ok, false); assert.equal(sin.pendiente, false); assert.match(sin.error, /no válido/);
  const html = plantillaCorreo({ empresa: { nombre: 'Italo <Gelatería>', color: '#c5603c' }, titulo: 'Título', cuerpo: '<p>Contenido</p>' });
  assert.match(html, /Italo &lt;Gelatería&gt;/); assert.match(html, /#c5603c/); assert.match(html, /Contenido/);
  await limpiar();
  await enviarCorreo({ empresaId: await t.empresaId('origen'), para: 'a@x.com', asunto: 'Origen', html: '<p>x</p>' });
  assert.match(enviados[0].html, /Origen/); assert.ok(enviados[0].text.length > 0);
});

test('falla de Gmail: reintentos espaciados y, agotados, «fallido»; el reintento manual lo vuelve a intentar', async () => {
  await limpiar();
  falla = 'Invalid login: 535 Username and Password not accepted';
  const r = await enviarCorreo({ para: 'a@x.com', asunto: 'Falla', html: '<p>x</p>', adjuntos: [{ nombre: 'a.pdf', mime: 'application/pdf', contenido: Buffer.from('%PDF-1.4') }] });
  assert.equal(r.ok, false); assert.equal(r.pendiente, true); assert.match(r.error, /GMAIL_APP_PASSWORD/);
  for (let i = 0; i < 4; i += 1) {
    await t.db.query(`update msg.correos set proximo_intento = now() where id = $1`, [r.id]);
    await procesarCola();
  }
  const f = (await t.db.query('select estado, intentos from msg.correos where id = $1', [r.id])).rows[0];
  assert.equal(f.estado, 'fallido'); assert.equal(f.intentos, 5);
  assert.equal((await t.db.query('select count(*)::int n from msg.adjuntos where correo_id = $1', [r.id])).rows[0].n, 1, 'conserva el adjunto para poder reintentar');
  falla = null;
  const re = await dueno.post(`/api/mensajeria/historial/${r.id}/reintentar`);
  assert.equal(re.status, 200); assert.equal(re.body.ok, true);
  assert.equal(enviados.at(-1).attachments[0].filename, 'a.pdf');
  assert.equal((await t.db.query('select count(*)::int n from msg.adjuntos where correo_id = $1', [r.id])).rows[0].n, 0, 'ya salió: no guarda los bytes');
});

test('factura por correo: PDF adjunto, leyenda de BORRADOR, correo editable y bitácora', async () => {
  await limpiar();
  const prod = cat.productos.find((p) => p.nombre === 'Naranja Pura');
  const v = (await caja.post('/api/pos/ventas', { items: [{ producto_id: prod.id, cantidad: 1 }], cobrar: { pagos: [{ forma_pago_id: efectivo(), monto: 100 }] } })).body;
  assert.ok(v.id, JSON.stringify(v));
  assert.equal((await gerOrigen.post(`/api/pos/ventas/${v.id}/correo`, {})).status, 400, 'sin correo del cliente pide uno');
  assert.equal((await gerOrigen.post(`/api/pos/ventas/${v.id}/correo`, { email: 'malo' })).status, 400);
  const r = await gerOrigen.post(`/api/pos/ventas/${v.id}/correo`, { email: 'Cliente@Correo.hn', mensaje: 'Gracias por su visita' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.ok, true); assert.equal(r.body.destino, 'cliente@correo.hn');
  const m = enviados.at(-1);
  assert.deepEqual(m.to, ['cliente@correo.hn']);
  assert.match(m.subject, /Comprobante \(borrador\)/);
  assert.match(m.html, /BORRADOR – SIN VALOR FISCAL/); assert.match(m.html, /Gracias por su visita/);
  assert.match(m.attachments[0].filename, /BORRADOR\.pdf$/);
  assert.equal(m.attachments[0].content.subarray(0, 5).toString(), '%PDF-');
  const bit = (await t.db.query(`select detalle from core.auditoria where accion = 'factura_enviada_correo' and entidad_id = $1`, [v.id])).rows;
  assert.equal(bit.length, 1); assert.equal(bit[0].detalle.destino, 'cliente@correo.hn'); assert.equal(bit[0].detalle.borrador, true);
  // el cajero sin permiso de reportes igual puede vender, y una orden abierta no se envía
  const abierta = (await caja.post('/api/pos/ventas', { items: [{ producto_id: prod.id, cantidad: 1 }] })).body;
  assert.equal((await caja.post(`/api/pos/ventas/${abierta.id}/correo`, { email: 'a@x.com' })).status, 409);
});

test('cotización de Italo por correo: PDF adjunto y pasa de borrador a enviada', async () => {
  await limpiar();
  const c = (await adminI.post('/api/cotizaciones', {
    nombre_cliente: 'María García', email_cliente: 'maria@correo.hn', nombre_evento: 'Boda García', fecha_evento: '2030-06-15', lugar: 'Salón',
    cantidad_copitas: 100, precio_copita: 50, costo_servicio: 500, descuento: 100, partidas: [{ descripcion: 'Carrito de gelato', cantidad: 1, precio_unitario: 1500 }],
  })).body;
  const r = await adminI.post(`/api/cotizaciones/${c.id}/enviar`, { mensaje: 'Quedamos atentos' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.ok, true);
  const m = enviados.at(-1);
  assert.deepEqual(m.to, ['maria@correo.hn']);
  assert.match(m.subject, /Cotización de evento 0001/); assert.match(m.html, /Boda García/); assert.match(m.html, /6,900\.00/);
  assert.equal(m.attachments[0].content.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await adminI.get(`/api/cotizaciones/${c.id}`)).body.estado, 'enviada');
  // sin correo en la ficha pero con el que se escribe en el botón
  const s = (await adminI.post('/api/cotizaciones', { nombre_cliente: 'Sin correo', nombre_evento: 'Fiesta', cantidad_copitas: 10, precio_copita: 50, email_cliente: '' })).body;
  assert.equal((await adminI.post(`/api/cotizaciones/${s.id}/enviar`, {})).status, 400);
  assert.equal((await adminI.post(`/api/cotizaciones/${s.id}/enviar`, { email: 'otro@correo.hn' })).body.ok, true);
});

test('normalizar cotizaciones y PDF simple (EcoStone, DISERCO)', () => {
  const eco = normalizarCotizacion('eco', { numero: 7, nombre_cliente: 'Constructora', proyecto: 'Torre', lineas: [{ descripcion: 'Piedra caja 1 m²', cantidad: 10, unidad: 'caja', precio_unitario: 100, monto: 1000 }], subtotal: 1000, isv: 150, total: 1150, vigencia_dias: 15 });
  assert.equal(eco.codigo, '0007'); assert.equal(eco.total, 1150); assert.equal(eco.lineas[0].monto, 1000);
  const dis = normalizarCotizacion('diserco', { codigo: 'COT-2026-001', nombre_cliente: 'Hotel', lineas: [{ descripcion: 'Epóxico', cantidad: 100, unidad: 'm2', precio_unitario: 400, monto: 40000 }], total: 46000, subtotal: 40000, isv: 6000 });
  assert.equal(dis.codigo, 'COT-2026-001');
  const pdf = generarPdfDocumento({ empresa: { nombre: 'DISERCO' }, titulo: 'Cotización', datos: [['Cliente', 'Hotel']], columnas: [{ cabeza: 'Descripción', ancho: 300 }, { cabeza: 'Monto', ancho: 100, derecha: true }], filas: Array.from({ length: 80 }, (_, i) => [`Línea ${i} con tildes áéíóú ñ`, 'L 1.00']), totales: [['TOTAL', 'L 80.00', true]] });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-'); assert.match(pdf.toString('latin1'), /Página 2 de /);
});

test('Administración: solo dueño y administrador; el dueño del grupo ve las reglas del grupo', async () => {
  assert.equal((await caja.get('/api/mensajeria/estado')).status, 403);
  assert.equal((await gerOrigen.get('/api/mensajeria/estado')).status, 403);
  const a = (await adminI.get('/api/mensajeria/estado')).body;
  assert.equal(a.configurado, true);   // el transporte falso de la prueba
  assert.ok(a.pasos.length >= 4); assert.deepEqual(a.variables, ['GMAIL_USER', 'GMAIL_APP_PASSWORD']);
  assert.ok(!a.reglas.some((x) => x.tipo === 'resumen_diario'), 'el admin de una empresa no ve el resumen del grupo');
  assert.ok(a.reglas.some((x) => x.tipo === 'tienda_sin_pesar'), 'Italo tiene gelato');
  const d = (await dueno.get('/api/mensajeria/estado')).body;
  assert.ok(d.reglas.some((x) => x.tipo === 'resumen_diario' && x.hora === 7));
  assert.equal((await adminI.put('/api/mensajeria/avisos/resumen_diario', { activo: true, horas_entre: 24 })).status, 404, 'el admin ni ve ese aviso');
  assert.equal((await adminI.put('/api/mensajeria/avisos/no_existe', { activo: true, horas_entre: 24 })).status, 404);
  // origen no tiene gelato: ese aviso no existe allí
  assert.equal((await t.cli(await t.login('origen', 'dueno@grupo.hn', 'ClaveSegura123'), 'origen').put('/api/mensajeria/avisos/tienda_sin_pesar', { activo: true, horas_entre: 24 })).status, 404);
  // guardar con validación de correos
  assert.equal((await adminI.put('/api/mensajeria/avisos/cai', { activo: true, destinatarios: ['malo'], horas_entre: 24 })).status, 400);
  const ok = await adminI.put('/api/mensajeria/avisos/cai', { activo: true, destinatarios: 'Uno@x.com, dos@x.com', horas_entre: 48 });
  assert.equal(ok.status, 200); assert.deepEqual(ok.body.destinatarios, ['uno@x.com', 'dos@x.com']); assert.equal(ok.body.horas_entre, 48);
  assert.equal((await dueno.put('/api/mensajeria/avisos/resumen_diario', { activo: true, destinatarios: ['yo@x.com'], hora: 6, horas_entre: 24 })).body.hora, 6);
  assert.equal((await dueno.put('/api/mensajeria/avisos/resumen_diario', { activo: true, destinatarios: [], hora: 7, horas_entre: 24 })).status, 200);
  assert.equal((await t.db.query(`select count(*)::int n from core.auditoria where accion = 'aviso_configurado'`)).rows[0].n >= 3, true);
});

test('correo de prueba, historial con filtros y alcance por empresa', async () => {
  await limpiar();
  const p = await adminI.post('/api/mensajeria/prueba', { para: 'yo@correo.hn' });
  assert.equal(p.status, 200); assert.equal(p.body.ok, true);
  assert.match(enviados.at(-1).subject, /Prueba de correo – Italo/);
  falla = 'ECONNRESET'; const mala = await adminI.post('/api/mensajeria/prueba', { para: 'otro@correo.hn' }); falla = null;
  assert.equal(mala.body.ok, false); assert.equal(mala.body.pendiente, true);
  const h = (await adminI.get('/api/mensajeria/historial')).body;
  assert.equal(h.length, 2);
  assert.deepEqual((await adminI.get('/api/mensajeria/historial?estado=pendiente')).body.map((x) => x.para[0]), ['otro@correo.hn']);
  // otra empresa no ve ni reintenta los de Italo
  const o = t.cli(await t.login('origen', 'dueno@grupo.hn', 'ClaveSegura123'), 'origen');
  assert.equal((await o.get('/api/mensajeria/historial')).body.length, 0);
  assert.equal((await o.post(`/api/mensajeria/historial/${h[0].id}/reintentar`)).status, 404);
});

test('resumen diario: a su hora, una sola vez por día, con ventas, cierres y vencimientos', async () => {
  await limpiar();
  await t.db.query(`delete from msg.avisos`);
  assert.equal(diaDelResumen(MANANA, 7), '2026-10-08'); assert.equal(diaDelResumen(MANANA, 21), '2026-10-09');
  // datos del día anterior en Origen (hora de Honduras)
  const prod = cat.productos.find((p) => p.nombre === 'Naranja Pura');
  const v = (await caja.post('/api/pos/ventas', { items: [{ producto_id: prod.id, cantidad: 2 }], cobrar: { pagos: [{ forma_pago_id: efectivo(), monto: 200 }] } })).body;
  await t.db.query(`update pos.ventas set fecha_emision = '2026-10-08T18:00:00Z' where empresa_id = (select id from core.empresas where codigo = 'origen')`);
  const nVentas = (await t.db.query(`select count(*)::int n from pos.ventas where estado = 'pagada' and fecha_emision = '2026-10-08T18:00:00Z'`)).rows[0].n;
  const datos = await armarResumen(t.db, { fecha: '2026-10-08', ahora: MANANA });
  const origen = datos.empresas.find((e) => e.empresa.nombre.startsWith('Origen'));
  assert.equal(origen.ventas.facturas, nVentas); assert.ok(origen.ventas.total > 0);
  assert.deepEqual(origen.cierres.sin_cierre.length, 1, 'vendió y no cerró caja');
  const html = htmlResumen(datos);
  assert.match(html, /Ventas:/); assert.match(html, /no hicieron cierre/);

  assert.deepEqual(await enviarResumenDiario({ db: t.db, ahora: MADRUGADA }), { enviado: false, motivo: 'aún no es la hora' });
  const r1 = await enviarResumenDiario({ db: t.db, ahora: MANANA });
  assert.equal(r1.enviado, true, JSON.stringify(r1)); assert.deepEqual(r1.destinatarios, ['dueno@grupo.hn']);
  assert.match(enviados.at(-1).subject, /Resumen del día 2026-10-08/);
  assert.equal((await enviarResumenDiario({ db: t.db, ahora: new Date(MANANA.getTime() + 3_600_000) })).motivo, 'ya enviado hoy');
  assert.equal(enviados.length, 1);
  // al día siguiente sí; si se apaga, no
  const manana2 = new Date(MANANA.getTime() + 86_400_000);
  assert.equal((await enviarResumenDiario({ db: t.db, ahora: manana2 })).enviado, true);
  await dueno.put('/api/mensajeria/avisos/resumen_diario', { activo: false, hora: 7, horas_entre: 24 });
  assert.equal((await enviarResumenDiario({ db: t.db, ahora: new Date(manana2.getTime() + 86_400_000) })).motivo, 'desactivado');
  await dueno.put('/api/mensajeria/avisos/resumen_diario', { activo: true, hora: 7, horas_entre: 24 });
  // botón «enviar ahora»
  const ahora = await dueno.post('/api/mensajeria/resumen/enviar-ahora', { para: 'socio@correo.hn' });
  assert.equal(ahora.body.enviado, true); assert.deepEqual(enviados.at(-1).to, ['socio@correo.hn']);
  assert.equal((await adminI.post('/api/mensajeria/resumen/enviar-ahora', {})).status, 403);
});

test('alertas: un correo agrupado por tipo y empresa, en pausa N horas, solo lo nuevo en antifraude y caja', async () => {
  await limpiar(); await t.db.query('delete from msg.avisos');
  const empresas = await empresasActivas(t.db);
  const italo = empresas.find((e) => e.codigo === 'italo');
  const hoy = fechaHN(MANANA);
  // 1) tienda sin pesar en la mañana de despacho
  const suc = (await t.db.query(`select id from core.sucursales where empresa_id = $1 and alias = 'mackey'`, [italo.id])).rows[0].id;
  const sabor = (await t.db.query(`insert into rep.sabores (empresa_id, nombre) values ($1,'Fresa') returning id`, [italo.id])).rows[0].id;
  await t.db.query(`insert into rep.sucursal_sabores (sucursal_id, sabor_id, empresa_id) values ($1,$2,$3)`, [suc, sabor, italo.id]);
  // 2) CAI real por vencer  3) documento por vencer  4) alerta alta de antifraude  5) cierre descuadrado
  await t.db.query(`update pos.puntos_emision set es_borrador = false, cai = 'AAAAAA-BBBBBB-CCCCCC-DDDDDD-EEEEEE-FF', fecha_limite_emision = $2::date + 5 where empresa_id = $1 and sucursal_id = $3`, [italo.id, hoy, suc]);
  await t.db.query(`insert into doc.documentos (empresa_id, tipo, titulo, fecha_vencimiento, dias_aviso) values ($1,'permiso_operacion','Permiso de operación Mackey', $2::date + 10, 30)`, [italo.id, hoy]);
  await t.db.query(`insert into af.alertas (empresa_id, tipo, severidad, titulo, sucursal_id) values ($1,'descuento_alto','alta','Descuentos fuera de lo normal', $2)`, [italo.id, suc]);
  const cajero = (await t.db.query(`select id from core.usuarios limit 1`)).rows[0].id;
  await t.db.query(`insert into pos.cierres_caja (empresa_id, sucursal_id, fecha, fecha_inicio, fecha_fin, cajero_id, total_ventas, diferencia, created_at) values ($1,$2,$3::date - 1, $5::timestamptz - interval '10 hours', $5::timestamptz - interval '2 hours', $4, 1000, -120, $5::timestamptz - interval '2 hours')`, [italo.id, suc, hoy, cajero, MANANA.toISOString()]);   // relativo a MANANA, no al reloj real: si no, la prueba falla pasada esa hora

  const out = await evaluarAlertas({ db: t.db, empresas, ahora: MANANA });
  const tipos = out.filter((o) => o.empresa === 'italo').map((o) => o.tipo).sort();
  assert.deepEqual(tipos, ['antifraude', 'cai', 'descuadre_caja', 'documentos', 'tienda_sin_pesar']);
  const asuntos = enviados.map((m) => m.subject);
  assert.ok(asuntos.some((s) => /tiendas? sin pesar/.test(s)), asuntos.join(' / '));
  assert.ok(enviados.find((m) => /sin pesar/.test(m.subject)).html.includes('Mackey'));
  assert.ok(enviados.find((m) => /CAI/.test(m.subject)).html.includes('vence en 5 días'));
  assert.ok(enviados.find((m) => /faltante de L/.test(m.html)));
  // nada se repite dentro de la pausa, aunque haya más alertas nuevas
  const antes = enviados.length;
  assert.deepEqual(await evaluarAlertas({ db: t.db, empresas, ahora: new Date(MANANA.getTime() + 30 * 60_000) }), []);
  assert.equal(enviados.length, antes);
  // pasada la pausa: lo que ya se avisó (antifraude, caja) no vuelve; CAI, documentos y tiendas (otra mañana) sí
  const luego = await evaluarAlertas({ db: t.db, empresas, ahora: new Date(MANANA.getTime() + 25 * 3_600_000) });
  assert.deepEqual(luego.filter((o) => o.empresa === 'italo').map((o) => o.tipo).sort(), ['cai', 'documentos', 'tienda_sin_pesar']);
  // nueva alerta alta: solo esa
  await t.db.query(`insert into af.alertas (empresa_id, tipo, severidad, titulo) values ($1,'anulaciones','alta','Muchas anulaciones')`, [italo.id]);
  const nuevo = await evaluarAlertas({ db: t.db, empresas, ahora: new Date(MANANA.getTime() + 30 * 3_600_000), tipos: ['antifraude'] });
  assert.equal(nuevo.length, 1);
  const ult = enviados.at(-1).html; assert.ok(ult.includes('Muchas anulaciones') && !ult.includes('Descuentos fuera'));
  // un destinatario propio y una regla apagada
  await adminI.put('/api/mensajeria/avisos/cai', { activo: false, destinatarios: ['cai@x.com'], horas_entre: 24 });
  const apagado = await evaluarAlertas({ db: t.db, empresas, ahora: new Date(MANANA.getTime() + 80 * 3_600_000), tipos: ['cai'] });
  assert.equal(apagado.length, 0);
});

test('errores graves: se agrupan en un solo correo', async () => {
  await limpiar();
  registrarErrorGrave({ method: 'GET', originalUrl: '/api/x?a=1', ctx: { empresa: { nombre: 'Italo' } } }, new Error('boom'));
  registrarErrorGrave({ method: 'POST', originalUrl: '/api/y' }, new Error('otro'));
  const r = await avisarErroresGraves({ db: t.db, ahora: MANANA });
  assert.equal(r.ok, true); assert.match(enviados[0].subject, /2 errores graves/); assert.match(enviados[0].html, /GET \/api\/x/);
  assert.equal(await avisarErroresGraves({ db: t.db, ahora: MANANA }), null);
});
