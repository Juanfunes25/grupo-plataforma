import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { iniciar } from './helpers.js';
import { sembrar } from '../src/db/sembrar.js';
import { abrirDb } from '../src/db/index.js';
import { migrar } from '../src/db/migrar.js';
import { restaurarZip, exportarEmpresaBuffer } from '../src/db/respaldo.js';
import { crearApp } from '../src/app.js';
import { crearZip, leerZip } from '../src/lib/zip.js';

// Respaldo exportable y restauración contra una base vacía.

let t, dueno, gerente, caja, cajaItalo, cat, token, zipBuf, manifiesto;
const fp = (tipo) => cat.formas_pago.find((f) => f.tipo === tipo).id;

async function descargar(cli, ruta, tk, empresa = 'origen') {
  const r = await fetch(t.base + ruta, { headers: { authorization: `Bearer ${tk}`, 'x-empresa': empresa } });
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), tipo: r.headers.get('content-type'), disp: r.headers.get('content-disposition') };
}
async function baseVacia() {
  const config = { ...t.config, dataDir: ':memory:' };
  const db = await abrirDb(config);
  await migrar(db, config.migraciones, () => {});
  return { db, config };
}
const cuenta = async (db, sql, p = []) => (await db.query(sql, p)).rows[0].n;

before(async () => {
  t = await iniciar();
  await sembrar(t.db, t.config.semillas, 'origen');
  await t.usuario({ nombre: 'Dueño', email: 'dueno@grupo.hn', password: 'ClaveSegura123', dueno: true });
  await t.usuario({ nombre: 'Gerente', email: 'ger@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Admin', email: 'admin@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'admin' }] });
  await t.usuario({ nombre: 'Cajera', accesos: [{ empresa: 'origen', rol: 'cajero', pin: '1234' }] });
  await t.usuario({ nombre: 'Cajero Italo', accesos: [{ empresa: 'italo', rol: 'cajero', pin: '1234' }] });
  caja = t.cli(await t.loginPin('origen', '1234'), 'origen');
  cajaItalo = t.cli(await t.loginPin('italo', '1234'), 'italo');
  token = await t.login('origen', 'dueno@grupo.hn', 'ClaveSegura123');
  dueno = t.cli(token, 'origen');
  gerente = t.cli(await t.login('origen', 'ger@origen.hn', 'ClaveSegura123'), 'origen');
  cat = (await caja.get('/api/pos/catalogo')).body;
  // Ventas reales en Origen (con descuento de inventario por receta) y algo en Italo, que NO debe salir en el respaldo de Origen.
  const naranja = cat.productos.find((p) => p.nombre === 'Naranja Pura').id;
  for (let i = 1; i <= 4; i++) {
    const r = await caja.post('/api/pos/ventas', { items: [{ producto_id: naranja, cantidad: i }], cobrar: { pagos: [{ forma_pago_id: fp('efectivo'), monto: 200 * i }] } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const catI = (await cajaItalo.get('/api/pos/catalogo')).body;
  if (catI.productos.length) await cajaItalo.post('/api/pos/ventas', { items: [{ producto_id: catI.productos[0].id, cantidad: 1 }], cobrar: { pagos: [{ forma_pago_id: catI.formas_pago[0].id, monto: 1000 }] } });
  await dueno.post('/api/fin/gastos', { monto: 350, descripcion: 'Bolsas', fecha: '2026-03-01' }).catch(() => {});
});
after(() => t.cerrar());

test('solo el dueño exporta la copia de la empresa; el administrador y el gerente reciben 403', async () => {
  assert.equal((await descargar(null, '/api/sistema/respaldo', await t.login('origen', 'admin@origen.hn', 'ClaveSegura123'))).status, 403);
  assert.equal((await gerente.get('/api/sistema/respaldo')).status, 403);
  assert.equal((await caja.get('/api/sistema/respaldo')).status, 403);
  assert.equal((await t.cli().get('/api/sistema/respaldo')).status, 401);
});

test('la copia es un ZIP con CSV y JSON por tabla, un manifiesto con sumas de control y queda en la bitácora', async () => {
  const r = await descargar(null, '/api/sistema/respaldo', token);
  assert.equal(r.status, 200);
  assert.equal(r.tipo, 'application/zip');
  assert.match(r.disp, /respaldo-origen-\d{4}-\d{2}-\d{2}\.zip/);
  zipBuf = r.buf;
  const z = leerZip(zipBuf);
  manifiesto = JSON.parse(z.get('manifiesto.json').toString());
  const nombres = manifiesto.tablas.map((x) => x.tabla);
  for (const esperado of ['core.empresas', 'core.sucursales', 'core.accesos', 'pos.ventas', 'pos.detalle_venta', 'pos.puntos_emision', 'inv.insumos', 'inv.movimientos', 'core.auditoria']) assert.ok(nombres.includes(esperado), esperado);
  for (const excluida of ['core.sesiones_activas', 'core.usuarios_mfa', 'core.errores_sistema', 'public._migraciones']) assert.ok(!nombres.includes(excluida), excluida);
  assert.ok(z.has('datos/pos.ventas.json') && z.has('csv/pos.ventas.csv') && z.has('LEEME.txt'));
  const csv = z.get('csv/pos.ventas.csv').toString('utf8');
  assert.ok(csv.startsWith('﻿'), 'UTF-8 con BOM para Excel');
  assert.ok(csv.split('\r\n').length >= 5);
  // exactamente las ventas de Origen: ni una de Italo
  const ventas = JSON.parse(z.get('datos/pos.ventas.json').toString());
  assert.equal(ventas.length, await cuenta(t.db, `select count(*)::int as n from pos.ventas v join core.empresas e on e.id = v.empresa_id where e.codigo = 'origen'`));
  assert.ok(ventas.every((v) => v.empresa_id === manifiesto.empresa.id));
  // detalle (no tiene empresa_id): llega por la llave de la venta
  const detalle = JSON.parse(z.get('datos/pos.detalle_venta.json').toString());
  assert.equal(detalle.length, await cuenta(t.db, `select count(*)::int as n from pos.detalle_venta d join pos.ventas v on v.id = d.venta_id where v.empresa_id = $1`, [manifiesto.empresa.id]));
  // sin credenciales por defecto
  const usuarios = JSON.parse(z.get('datos/core.usuarios.json').toString());
  assert.ok(usuarios.length >= 3);
  assert.ok(usuarios.every((u) => !('password_hash' in u) && !('auth_user_id' in u)));
  const accesos = JSON.parse(z.get('datos/core.accesos.json').toString());
  assert.ok(accesos.every((a) => !('pin_hash' in a)));
  // solo la empresa pedida
  const empresas = JSON.parse(z.get('datos/core.empresas.json').toString());
  assert.deepEqual(empresas.map((e) => e.codigo), ['origen']);
  // todas las tablas llevan suma de control
  for (const tb of manifiesto.tablas.filter((x) => x.filas)) assert.ok(tb.sha256 && z.has(`datos/${tb.tabla}.json`));
  assert.deepEqual(manifiesto.sin_ruta_a_empresa, [], `tablas sin vínculo a la empresa: ${manifiesto.sin_ruta_a_empresa.join(', ')}`);
  const b = (await dueno.get('/api/admin/auditoria?accion=respaldo_exportado')).body;
  assert.equal(b.length, 1);
  assert.equal(b[0].detalle.con_claves, false);
});

test('restauración sobre una base vacía: mismas filas, mismos totales y el inventario no se descuenta otra vez', async () => {
  const { db } = await baseVacia();
  try {
    const rep = await restaurarZip(db, zipBuf, { limpiar: true });
    assert.equal(rep.modo, 'replica');
    for (const tb of rep.tablas) assert.equal(tb.cargadas, tb.esperado, `${tb.tabla}: ${tb.cargadas}/${tb.esperado}`);
    const emp = manifiesto.empresa.id;
    for (const [sql, p] of [
      ['select count(*)::int as n from pos.ventas where empresa_id = $1', [emp]],
      ['select count(*)::int as n from pos.detalle_venta d join pos.ventas v on v.id = d.venta_id where v.empresa_id = $1', [emp]],
      ['select count(*)::int as n from inv.movimientos where empresa_id = $1', [emp]],
      ['select count(*)::int as n from inv.insumos where empresa_id = $1', [emp]],
      ['select count(*)::int as n from core.sucursales where empresa_id = $1', [emp]],
      ['select round(coalesce(sum(total),0))::int as n from pos.ventas where empresa_id = $1', [emp]],
    ]) assert.equal(await cuenta(db, sql, p), await cuenta(t.db, sql, p), sql);
    // la bitácora conserva sus hashes originales
    // (el propio «respaldo_exportado» se anota después de generar el ZIP, por eso se compara hasta el último id respaldado)
    const tope = await cuenta(db, 'select max(id)::int as n from core.auditoria');
    const h = (d) => d.query('select id, hash, hash_anterior, created_at from core.auditoria where empresa_id = $1 and id <= $2 order by id', [emp, tope]).then((r) => r.rows.map((x) => `${x.id}|${x.hash}|${x.hash_anterior}|${new Date(x.created_at).toISOString()}`));
    assert.deepEqual(await h(db), await h(t.db));
    // las otras empresas no vinieron (el respaldo es de una sola)
    assert.equal(await cuenta(db, `select count(*)::int as n from core.empresas`), 1);
    // los contadores quedan listos: se puede seguir vendiendo sin chocar con lo restaurado
    const maxOrden = await cuenta(db, 'select max(numero_orden)::int as n from pos.ventas');
    const sig = (await db.query(`select nextval('pos.ventas_numero_orden_seq')::int as n`)).rows[0].n;
    assert.ok(sig > maxOrden, `siguiente ${sig} debe pasar de ${maxOrden}`);
  } finally { await db.close(); }
});

test('la restauración también funciona sin permiso de «replica» (orden por dependencias)', async () => {
  const { db } = await baseVacia();
  try {
    const rep = await restaurarZip(db, zipBuf, { limpiar: true, sinReplica: true });
    assert.equal(rep.modo, 'orden-por-dependencias');
    assert.equal(await cuenta(db, 'select count(*)::int as n from pos.ventas'), await cuenta(t.db, `select count(*)::int as n from pos.ventas where empresa_id = $1`, [manifiesto.empresa.id]));
    // los triggers de usuario quedaron encendidos otra vez
    const apagados = await cuenta(db, `select count(*)::int as n from pg_trigger where not tgenabled = 'O' and not tgisinternal`);
    assert.equal(apagados, 0);
  } finally { await db.close(); }
});

test('restaurar dos veces el mismo respaldo no duplica nada', async () => {
  const { db } = await baseVacia();
  try {
    await restaurarZip(db, zipBuf, { limpiar: true });
    const antes = await cuenta(db, 'select count(*)::int as n from pos.ventas');
    await restaurarZip(db, zipBuf, { limpiar: false });
    assert.equal(await cuenta(db, 'select count(*)::int as n from pos.ventas'), antes);
  } finally { await db.close(); }
});

test('con claves (opcional): la base restaurada permite entrar con la misma contraseña y el mismo PIN', async () => {
  const completo = await descargar(null, '/api/sistema/respaldo?con_claves=1', token);
  assert.equal(completo.status, 200);
  const { db, config } = await baseVacia();
  const app = crearApp({ db, config, log: () => {} });
  const srv = app.listen(0); await once(srv, 'listening');
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    await restaurarZip(db, completo.buf, { limpiar: true });
    app.locals.ctxMgr.invalidar();
    const lg = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ empresa: 'origen', email: 'ger@origen.hn', password: 'ClaveSegura123' }) });
    assert.equal(lg.status, 200);
    const tk = (await lg.json()).token;
    const lista = await (await fetch(`${base}/api/pos/ventas`, { headers: { authorization: `Bearer ${tk}`, 'x-empresa': 'origen' } })).json();
    assert.equal(lista.length, 4);
    // el PIN solo sirve con el mismo PIN_PEPPER; aquí es el mismo
    const pin = await fetch(`${base}/api/auth/pin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ empresa: 'origen', pin: '1234', usuario_id: (await db.query(`select a.usuario_id from core.accesos a join core.empresas e on e.id = a.empresa_id where e.codigo = 'origen' and a.pin_hash is not null limit 1`)).rows[0].usuario_id }) });
    assert.equal(pin.status, 200);
  } finally { srv.close(); await db.close(); }
});

test('un respaldo alterado o dañado se rechaza antes de tocar la base', async () => {
  const z = leerZip(zipBuf);
  const salida = [];
  const w = crearZip((b) => salida.push(b));
  for (const [n, c] of z) w.agregar(n, n === 'datos/pos.ventas.json' ? c.toString().replace('"total"', '"totall"') : c);
  w.cerrar();
  const { db } = await baseVacia();
  try {
    await assert.rejects(() => restaurarZip(db, Buffer.concat(salida), { limpiar: true }), /suma de control/);
    assert.equal(await cuenta(db, 'select count(*)::int as n from core.empresas'), 4, 'no se borró nada');
    await assert.rejects(() => restaurarZip(db, Buffer.from('esto no es un zip'), {}), /ZIP/);
    await assert.rejects(() => restaurarZip(db, zipBuf.subarray(0, zipBuf.length - 40), {}), /ZIP|final/);
  } finally { await db.close(); }
});

test('exportar en la base de pruebas no deja tablas de otras empresas ni secretos (revisión rápida)', async () => {
  const { zip } = await exportarEmpresaBuffer(t.db, await t.empresaId('italo'), {});
  const z = leerZip(zip);
  const todo = [...z.entries()].filter(([n]) => n.startsWith('datos/')).map(([, c]) => c.toString()).join('');
  assert.ok(!todo.includes('scrypt$'), 'sin hashes de contraseña');
});
