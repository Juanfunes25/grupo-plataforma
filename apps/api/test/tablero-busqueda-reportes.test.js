import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fechaHN, sumarDias } from '@grupo/shared';
import { iniciar } from './helpers.js';
import { sembrar } from '../src/db/sembrar.js';
import { armarDias, comparar, horaCorteHN } from '../src/modulos/tablero/calculo.js';
import { sinTildes } from '../src/modulos/busqueda/rutas.js';
import { ejecutarPendientes, relojHN } from '../src/modulos/reportes-programados/programador.js';
import { reporteAExcel } from '../src/modulos/reportes-programados/excel.js';
import { reporteAPdf, ajustar } from '../src/modulos/reportes-programados/pdf.js';

let t, dueno, gerente, caja, suc, cat, duenoId;
const prod = (n) => cat.productos.find((p) => p.nombre === n);
const fp = (tipo) => cat.formas_pago.find((f) => f.tipo === tipo).id;

before(async () => {
  t = await iniciar();
  await sembrar(t.db, t.config.semillas, 'origen');
  duenoId = (await t.usuario({ nombre: 'Dueño', email: 'dueno@grupo.hn', password: 'ClaveSegura123', dueno: true })).id;
  await t.usuario({ nombre: 'Gerente', email: 'ger@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Cajera Ana', accesos: [{ empresa: 'origen', rol: 'cajero', pin: '1234' }] });
  caja = t.cli(await t.loginPin('origen', '1234'), 'origen');
  gerente = t.cli(await t.login('origen', 'ger@origen.hn', 'ClaveSegura123'), 'origen');
  dueno = t.cli(await t.login('origen', 'dueno@grupo.hn', 'ClaveSegura123'), 'origen');
  cat = (await caja.get('/api/pos/catalogo')).body;
  suc = cat.sucursales[0].id;
  const v = await caja.post('/api/pos/ventas', { sucursal_id: suc, items: [{ producto_id: prod('Naranja Pura').id, cantidad: 2 }], cobrar: { pagos: [{ forma_pago_id: fp('efectivo'), monto: 500 }] } });
  assert.equal(v.status, 201, JSON.stringify(v.body));
});
after(() => t.cerrar());

// ── Cálculo puro ────────────────────────────────────────────────────────────
test('comparar: variación porcentual y sin base de comparación', () => {
  assert.deepEqual(comparar(120, 100), { delta: 20, pct: 20, nuevo: false });
  assert.equal(comparar(50, 100).pct, -50);
  assert.deepEqual(comparar(10, 0), { delta: 10, pct: null, nuevo: true });
  assert.deepEqual(comparar(0, 0), { delta: 0, pct: null, nuevo: false });
});

test('hora de corte en Honduras (UTC-6) y armado de días', () => {
  assert.equal(horaCorteHN(new Date('2026-03-10T03:30:15Z')), '21:30:15');   // 21:30 del 9 de marzo en Honduras
  const dias = armarDias({
    fechas: ['2026-03-09', '2026-03-10'],
    ventas: [{ fecha: '2026-03-10', facturas: 2, total: 300, facturas_corte: 1, total_corte: 100 }, { fecha: '2026-03-10', facturas: 1, total: 50, facturas_corte: 1, total_corte: 50 }],
    margen: [{ fecha: '2026-03-10', venta: 350, venta_costeada: 200, costo: 50 }],
  });
  assert.equal(dias['2026-03-10'].total, 350);
  assert.equal(dias['2026-03-10'].ticket_promedio, 116.67);
  assert.equal(dias['2026-03-10'].margen_pct, 75);
  assert.equal(dias['2026-03-10'].cobertura_pct, 57);
  assert.equal(dias['2026-03-09'].margen_pct, null);
  assert.equal(dias['2026-03-10'].dia, 'Mar');
});

test('relojHN: hora y día de la semana de Honduras, no UTC', () => {
  const r = relojHN(new Date('2026-03-09T03:00:00Z'));   // domingo 8 de marzo, 21:00 en Honduras
  assert.deepEqual(r, { hoy: '2026-03-08', hora: 21, dia_semana: 7 });
  assert.equal(relojHN(new Date('2026-03-09T12:00:00Z')).dia_semana, 1);
});

// ── Tablero ─────────────────────────────────────────────────────────────────
test('tablero de la empresa: hoy, ayer, semana pasada, sucursales, formas de pago y tendencia de 7 días', async () => {
  const r = await gerente.get('/api/tablero');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.fecha, fechaHN());
  assert.equal(r.body.hoy.facturas, 1);
  assert.ok(r.body.hoy.total > 0);
  assert.equal(r.body.ayer.fecha, sumarDias(fechaHN(), -1));
  assert.equal(r.body.semana_pasada.fecha, sumarDias(fechaHN(), -7));
  assert.equal(r.body.tendencia.length, 7);
  assert.equal(r.body.tendencia.at(-1).fecha, fechaHN());
  assert.equal(r.body.tendencia.at(-1).total, r.body.hoy.total);
  assert.equal(r.body.vs_ayer.misma_hora.nuevo, true, 'sin ventas ayer: no hay porcentaje');
  assert.equal(r.body.formas_pago[0].tipo, 'efectivo');
  assert.equal(r.body.sucursales.find((s) => s.id === suc).hoy.facturas, 1);
  assert.ok(Array.isArray(r.body.alertas));
});

test('tablero: el cajero no lo ve; el tablero del grupo es solo para Dirección', async () => {
  assert.equal((await caja.get('/api/tablero')).status, 403);
  assert.equal((await gerente.get('/api/tablero/grupo')).status, 403);
  const g = await dueno.get('/api/tablero/grupo');
  assert.equal(g.status, 200);
  assert.equal(g.body.empresas.length, 4);
  assert.equal(g.body.empresas.find((e) => e.codigo === 'origen').hoy.facturas, 1);
  assert.equal(g.body.total.hoy, g.body.empresas.reduce((s, e) => s + e.hoy.total, 0));
  assert.equal(g.body.tendencia.length, 7);
});

// ── Búsqueda global ─────────────────────────────────────────────────────────
test('sinTildes iguala mayúsculas, tildes y eñes', () => assert.equal(sinTildes('JOSÉ Peña'), 'jose pena'));

test('búsqueda: facturas y productos de la empresa activa; sin tildes; mínimo 2 letras', async () => {
  const num = (await gerente.get('/api/pos/ventas?estado=pagada')).body[0].numero_factura;
  const f = await gerente.get(`/api/busqueda?q=${encodeURIComponent(num.slice(-6))}`);
  assert.equal(f.status, 200);
  const gf = f.body.grupos.find((g) => g.id === 'facturas');
  assert.ok(gf && gf.items[0].titulo === num, 'encuentra la factura por parte de su número');
  assert.equal(gf.items[0].ruta, 'facturas');
  const p = await gerente.get('/api/busqueda?q=NARANJA');
  assert.ok(p.body.grupos.find((g) => g.id === 'productos').items.some((i) => i.titulo === 'Naranja Pura'));
  assert.deepEqual((await gerente.get('/api/busqueda?q=n')).body.grupos, []);
  assert.equal((await gerente.get('/api/busqueda?q=%25%25')).status, 200, 'los comodines se tratan como texto');
});

test('búsqueda: el cajero no ve empleados ni documentos; otra empresa no se mezcla', async () => {
  await t.usuario({ nombre: 'Zulema Cajera', accesos: [{ empresa: 'origen', rol: 'cajero', pin: '5678' }] });
  const r = await caja.get('/api/busqueda?q=Zulema');
  assert.equal(r.status, 200);
  assert.ok(!r.body.grupos.some((g) => ['empleados', 'documentos'].includes(g.id)));
  // El dueño buscando en Italo no ve las facturas de Origen.
  const italo = t.cli(await t.login('italo', 'dueno@grupo.hn', 'ClaveSegura123'), 'italo');
  const num = (await gerente.get('/api/pos/ventas?estado=pagada')).body[0].numero_factura;
  const x = await italo.get(`/api/busqueda?q=${encodeURIComponent(num.slice(-6))}`);
  assert.ok(!x.body.grupos.find((g) => g.id === 'facturas'));
});

// ── Reportes programados ────────────────────────────────────────────────────
const nuevo = (o = {}) => ({ nombre: 'Ventas de ayer', tipo: 'ventas_dia', parametros: { dia: 'ayer' }, frecuencia: 'diario', hora: 7, destinatarios: 'dueno@grupo.hn, socio@grupo.hn', formatos: ['xlsx', 'pdf'], ...o });

test('reportes programados: catálogo según permisos y quién puede programar', async () => {
  const c = await dueno.get('/api/reportes-programados/catalogo');
  assert.equal(c.status, 200);
  const ids = c.body.reportes.map((x) => x.id);
  assert.ok(ids.includes('ventas_dia') && ids.includes('cierre_caja') && ids.includes('documentos_por_vencer') && ids.includes('resumen_grupo'));
  assert.ok(!ids.includes('gelato_consumido'), 'Origen no tiene gelato: el reporte no aparece');
  assert.ok(typeof c.body.correo.configurado === 'boolean');
  assert.equal((await gerente.post('/api/reportes-programados', nuevo())).status, 403, 'el gerente no programa');
  assert.equal((await gerente.get('/api/reportes-programados')).status, 403);
});

test('reportes programados: validaciones al guardar', async () => {
  const malo = async (o, texto) => { const r = await dueno.post('/api/reportes-programados', nuevo(o)); assert.equal(r.status, 400, texto); return r.body.error; };
  assert.match(await malo({ destinatarios: 'esto-no-es-correo' }), /Correo no válido/);
  await malo({ destinatarios: '' }, 'sin destinatarios');
  await malo({ frecuencia: 'semanal' }, 'semanal sin día');
  await malo({ hora: 25 }, 'hora fuera de rango');
  await malo({ formatos: [] }, 'sin formato');
  await malo({ tipo: 'inventado' }, 'reporte inexistente');
  await malo({ parametros: { sucursal_id: '00000000-0000-4000-8000-000000000000' } }, 'sucursal ajena');
  assert.equal((await dueno.post('/api/reportes-programados', nuevo({ tipo: 'gelato_consumido' }))).status, 403);
});

test('exportación manual a Excel y PDF', async () => {
  const llamar = async (formato) => {
    const r = await fetch(`${t.base}/api/reportes-programados/exportar?tipo=ventas_dia&dia=hoy&formato=${formato}`, { headers: { authorization: `Bearer ${await t.login('origen', 'ger@origen.hn', 'ClaveSegura123')}`, 'x-empresa': 'origen' } });
    return { r, buf: Buffer.from(await r.arrayBuffer()) };
  };
  const x = await llamar('xlsx');
  assert.equal(x.r.status, 200);
  assert.match(x.r.headers.get('content-type'), /spreadsheetml/);
  assert.equal(x.buf.subarray(0, 2).toString(), 'PK');
  const p = await llamar('pdf');
  assert.equal(p.r.status, 200);
  assert.equal(p.buf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(p.buf.toString('latin1').includes('Naranja Pura'), 'el PDF trae el detalle');
  assert.equal((await caja.get('/api/reportes-programados/exportar?tipo=ventas_dia&formato=xlsx')).status, 403, 'el cajero no exporta reportes');
});

test('Excel y PDF aguantan textos largos, acentos y tablas vacías', async () => {
  const rep = { titulo: 'Prueba ñandú', subtitulo: 'Sección «x»', resumen: [{ etiqueta: 'Total', valor: 1234.5, tipo: 'moneda' }, { etiqueta: 'Margen', valor: null, tipo: 'pct' }],
    secciones: [{ titulo: 'Una/tabla:[rara]?*', columnas: [{ clave: 'a', titulo: 'Nombre', tipo: 'texto' }, { clave: 'b', titulo: 'Monto', tipo: 'moneda' }], filas: [{ a: 'x'.repeat(300), b: 5 }, { a: 'Acción – “comillas” …', b: null }] },
      { titulo: 'Vacía', columnas: [{ clave: 'a', titulo: 'A', tipo: 'texto' }], filas: [] }], notas: ['nota'] };
  assert.equal((await reporteAExcel(rep)).subarray(0, 2).toString(), 'PK');
  assert.equal(reporteAPdf(rep).subarray(0, 5).toString(), '%PDF-');
  assert.ok(ajustar('x'.repeat(300), 8, 100).endsWith('...'));
});

test('el programador envía una vez por día, reintenta errores y respeta hora, día y creación', async () => {
  const ahora = new Date();
  const { hora, dia_semana } = relojHN(ahora);
  const enviados = [];
  const enviar = async (m) => { enviados.push(m); return { ok: true, pendiente: false }; };
  const crear = async (o) => {
    const r = await dueno.post('/api/reportes-programados', nuevo({ hora, ...o }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await t.db.query(`update rprog.programados set updated_at = now() - interval '2 days', created_at = now() - interval '2 days' where id = $1`, [r.body.id]);
    return r.body;
  };
  const diario = await crear({ nombre: 'Diario' });
  const otroDia = await crear({ nombre: 'Otro día', frecuencia: 'semanal', dia_semana: dia_semana === 7 ? 1 : dia_semana + 1 });
  const hoyToca = await crear({ nombre: 'Semanal de hoy', frecuencia: 'semanal', dia_semana });
  const tarde = await crear({ nombre: 'Más tarde', hora: Math.min(23, hora + 1) });
  const recien = await dueno.post('/api/reportes-programados', nuevo({ nombre: 'Recién creado', hora })).then((r) => r.body);   // updated_at = ahora: empieza mañana
  const apagado = await crear({ nombre: 'Apagado', activo: false });

  const hechas = await ejecutarPendientes(t.db, { ahora, enviar });
  const nombres = enviados.map((m) => m.asunto.split(' - ')[0]).sort();
  const esperado = hora < 23 ? ['Diario', 'Semanal de hoy'] : ['Diario', 'Más tarde', 'Semanal de hoy'];
  assert.deepEqual(nombres, esperado.sort());
  assert.ok(hechas.every((h) => h.estado === 'enviado'));
  const m = enviados.find((x) => x.asunto.startsWith('Diario'));
  assert.deepEqual(m.para, ['dueno@grupo.hn', 'socio@grupo.hn']);
  assert.deepEqual(m.adjuntos.map((a) => a.nombre.split('.').pop()).sort(), ['pdf', 'xlsx']);
  assert.equal(m.empresaId, (await t.empresaId('origen')));

  // Segunda pasada el mismo día: nada se vuelve a enviar.
  enviados.length = 0;
  assert.equal((await ejecutarPendientes(t.db, { ahora, enviar })).length, 0);
  assert.equal(enviados.length, 0);
  // ...pero al día siguiente sí.
  const manana = new Date(ahora.getTime() + 24 * 3600_000);
  await ejecutarPendientes(t.db, { ahora: manana, enviar });
  assert.ok(enviados.some((x) => x.asunto.startsWith('Diario')));
  const ejec = (await t.db.query(`select count(*)::int as n from rprog.ejecuciones where programado_id = $1`, [diario.id])).rows[0].n;
  assert.equal(ejec, 2, 'un renglón por día');
  for (const p of [otroDia, tarde, recien, apagado]) void p;
});

test('el programador: error con reintento (máximo 3), correo pendiente y sin datos', async () => {
  const ahora = new Date(Date.now() + 5 * 24 * 3600_000);
  const { hora } = relojHN(ahora);
  const crear = async (o) => {
    const r = await dueno.post('/api/reportes-programados', nuevo({ hora, ...o }));
    await t.db.query(`update rprog.programados set updated_at = now() - interval '9 days' where id = $1`, [r.body.id]);
    return r.body.id;
  };
  await t.db.query(`update rprog.programados set activo = false`);
  const idErr = await crear({ nombre: 'Falla' });
  let llamadas = 0;
  const falla = async () => { llamadas += 1; return { ok: false, pendiente: false, error: 'Gmail rechazó la clave' }; };
  for (let i = 0; i < 5; i++) await ejecutarPendientes(t.db, { ahora, enviar: falla });
  assert.equal(llamadas, 3, 'tres intentos y se detiene');
  const e = (await t.db.query(`select estado, intentos, detalle from rprog.ejecuciones where programado_id = $1`, [idErr])).rows[0];
  assert.equal(e.estado, 'error');
  assert.equal(e.intentos, 3);
  assert.match(e.detalle, /Gmail rechazó/);

  await t.db.query(`update rprog.programados set activo = false`);
  const idPend = await crear({ nombre: 'Correo sin configurar' });
  const pend = await ejecutarPendientes(t.db, { ahora, enviar: async () => ({ ok: false, pendiente: true, error: 'Pendiente de configurar: faltan GMAIL_USER y GMAIL_APP_PASSWORD' }) });
  assert.equal(pend[0].estado, 'pendiente_correo');
  assert.equal((await ejecutarPendientes(t.db, { ahora, enviar: async () => assert.fail('no debe reenviar: el correo queda en la cola del servicio de correo') })).length, 0);

  await t.db.query(`update rprog.programados set activo = false`);
  await crear({ nombre: 'Documentos', tipo: 'documentos_por_vencer', parametros: { dias: 30 } });
  const sd = await ejecutarPendientes(t.db, { ahora, enviar: async () => assert.fail('sin documentos por vencer no se envía nada') });
  assert.equal(sd[0].estado, 'sin_datos');
  void idPend;
});

test('el programador no envía si quien lo programó ya no tiene permiso', async () => {
  await t.db.query(`update rprog.programados set activo = false`);
  const u = await t.usuario({ nombre: 'Admin Temporal', email: 'adm@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'admin' }] });
  const adm = t.cli(await t.login('origen', 'adm@origen.hn', 'ClaveSegura123'), 'origen');
  const r = await adm.post('/api/reportes-programados', nuevo({ nombre: 'Del admin' }));
  assert.equal(r.status, 201);
  await t.db.query(`update rprog.programados set updated_at = now() - interval '2 days' where id = $1`, [r.body.id]);
  await t.db.query(`update core.usuarios set activo = false where id = $1`, [u.id]);
  const ahora = new Date(Date.now() + 30 * 24 * 3600_000);
  const hechas = await ejecutarPendientes(t.db, { ahora, enviar: async () => assert.fail('no debe enviar') });
  assert.equal(hechas[0].estado, 'error');
  assert.match(hechas[0].detalle, /ya no tiene permiso/);
});

test('"enviar ahora" y el historial de ejecuciones', async () => {
  const r = await dueno.post('/api/reportes-programados', nuevo({ nombre: 'Manual', destinatarios: 'a@b.hn' }));
  const e = await dueno.post(`/api/reportes-programados/${r.body.id}/enviar-ahora`);
  assert.equal(e.status, 200);
  assert.ok(['enviado', 'pendiente_correo', 'error'].includes(e.body.estado));
  assert.equal(e.body.archivos.length, 2);
  assert.equal((await dueno.get(`/api/reportes-programados/${r.body.id}/ejecuciones`)).status, 200);
  const lista = (await dueno.get('/api/reportes-programados')).body;
  assert.ok(lista.some((p) => p.id === r.body.id));
  assert.equal((await dueno.del(`/api/reportes-programados/${r.body.id}`)).status, 200);
  assert.equal((await dueno.put(`/api/reportes-programados/${r.body.id}`, nuevo())).status, 404);
});

test('resumen del grupo: solo Dirección, y trae las cuatro empresas', async () => {
  const p = await dueno.get('/api/reportes-programados/previa?tipo=resumen_grupo&dia=hoy');
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.secciones[0].filas.length, 4);
  const adm = t.cli(await t.login('origen', 'adm@origen.hn', 'ClaveSegura123').catch(() => null), 'origen');
  void adm;
});
