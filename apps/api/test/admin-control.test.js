import { fechaHN } from '@grupo/shared';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from './helpers.js';
import { sembrar } from '../src/db/sembrar.js';

// Control (Italo Facturación → plataforma): CAI/emisión, bitácora, usuarios y sucursales.
let t, dueno, admin, ger, caja, sucA;
const cai = (o = {}) => ({ cai: '2F4851-96A881-B76670-CE6CCE-48D250-32', punto_emision_codigo: '001', punto_venta_codigo: '001', tipo_documento_codigo: '01',
  correlativo_desde: 1, correlativo_hasta: 100, correlativo_actual: 1, fecha_limite_emision: '2030-12-31', es_borrador: false, ...o });

before(async () => {
  t = await iniciar();
  await sembrar(t.db, t.config.semillas, 'origen');
  await t.usuario({ nombre: 'Dueño', email: 'dueno@grupo.hn', password: 'ClaveSegura123', dueno: true });
  await t.usuario({ nombre: 'Admin Origen', email: 'adm@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'admin' }] });
  await t.usuario({ nombre: 'Manager', email: 'ger@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Cajera', accesos: [{ empresa: 'origen', rol: 'cajero', pin: '1234' }] });
  dueno = t.cli(await t.login('origen', 'dueno@grupo.hn', 'ClaveSegura123'), 'origen');
  admin = t.cli(await t.login('origen', 'adm@origen.hn', 'ClaveSegura123'), 'origen');
  ger = t.cli(await t.login('origen', 'ger@origen.hn', 'ClaveSegura123'), 'origen');
  caja = t.cli(await t.loginPin('origen', '1234'), 'origen');
  sucA = (await dueno.get('/api/admin/sucursales')).body[0].id;
});
after(() => t.cerrar());

test('CAI: estado reducido para el cajero, CAI repetido, rango ya usado y volver a borrador', async () => {
  const lista = (await admin.get('/api/pos/puntos-emision')).body;
  const pe = lista.find((p) => p.sucursal_id === sucA);
  const red = await caja.get(`/api/pos/puntos-emision/sucursal/${sucA}/estado`);
  assert.equal(red.status, 200);
  assert.equal(red.body.es_borrador, true);
  assert.equal(red.body.cai, undefined);                 // el cajero no ve el CAI completo
  assert.equal((await caja.put(`/api/pos/puntos-emision/${pe.id}`, cai())).status, 403);
  const ok = await admin.put(`/api/pos/puntos-emision/${pe.id}`, cai());
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.porcentaje_usado, 0);
  assert.equal(ok.body.alerta, false);

  // alertas: ≥90 % del rango o ≤15 días
  const casi = await admin.put(`/api/pos/puntos-emision/${pe.id}`, { correlativo_actual: 95 });
  assert.equal(casi.body.alerta, true);
  assert.equal(casi.body.porcentaje_usado, 94);
  const pronto = await admin.put(`/api/pos/puntos-emision/${pe.id}`, { fecha_limite_emision: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10) });
  assert.ok(pronto.body.dias_restantes <= 6);
  assert.equal((await caja.get(`/api/pos/puntos-emision/sucursal/${sucA}/estado`)).body.alerta, true);
  assert.equal((await admin.put(`/api/pos/puntos-emision/${pe.id}`, { correlativo_actual: 50 })).status, 400);   // no retrocede

  // un segundo punto de emisión no puede repetir el mismo CAI
  const otra = (await admin.post('/api/admin/sucursales', { nombre: 'Origen Dos', alias: 'dos' })).body;
  const pe2 = (await admin.get('/api/pos/puntos-emision')).body.find((p) => p.sucursal_id === otra.id);
  const dup = await admin.put(`/api/pos/puntos-emision/${pe2.id}`, cai());
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /CAI/);

  // el rango no puede pisar facturas ya emitidas con ese prefijo
  await t.db.query(`update pos.puntos_emision set es_borrador = true where id = $1`, [pe2.id]);
  await t.db.query(`insert into pos.ventas (empresa_id, sucursal_id, estado, numero_factura, total) select empresa_id, $1, 'pagada', '002-001-01-00000005', 10 from core.sucursales where id = $1`, [otra.id]);
  const choque = await admin.put(`/api/pos/puntos-emision/${pe2.id}`, cai({ cai: 'AAAAAA-BBBBBB-CCCCCC-DDDDDD-EEEEEE-FF', punto_emision_codigo: '002', correlativo_actual: 1, correlativo_hasta: 50 }));
  assert.equal(choque.status, 409);
  assert.match(choque.body.error, /ya existe/);

  // volver a borrador deja constancia
  const b = await admin.put(`/api/pos/puntos-emision/${pe.id}`, { es_borrador: true });
  assert.equal(b.body.es_borrador, true);
  const ult = (await t.db.query(`select accion, detalle from core.auditoria where entidad = 'punto_emision' and entidad_id = $1 order by id desc limit 1`, [pe.id])).rows[0];
  assert.equal(ult.accion, 'cai_vuelto_a_borrador');
  assert.ok(ult.detalle.cambios.es_borrador);
});

test('sucursales: color único por empresa, color automático y no se desactiva la última', async () => {
  const a = (await admin.post('/api/admin/sucursales', { nombre: 'Origen Tres', alias: 'tres', color: '#2e9e8f' }));
  assert.equal(a.status, 201);
  assert.equal(a.body.color, '#2e9e8f');
  assert.equal(a.body.punto_emision.es_borrador, true);
  const dup = await admin.post('/api/admin/sucursales', { nombre: 'Origen Cuatro', alias: 'cuatro', color: '#2E9E8F' });
  assert.equal(dup.status, 409);
  const auto = (await admin.post('/api/admin/sucursales', { nombre: 'Origen Cinco', alias: 'cinco' })).body;
  assert.match(auto.color, /^#[0-9a-f]{6}$/);
  const usados = (await admin.get('/api/admin/sucursales')).body.filter((s) => s.activo).map((s) => s.color);
  assert.equal(new Set(usados).size, usados.length);
  assert.equal((await admin.put(`/api/admin/sucursales/${auto.id}`, { color: '#2e9e8f' })).status, 409);
  assert.equal((await admin.put(`/api/admin/sucursales/${auto.id}`, { color: '#112233' })).status, 200);
  const lista = (await admin.get('/api/admin/sucursales')).body;
  assert.equal(lista.find((s) => s.id === auto.id).cai_estado, 'borrador');
  // desactivar todas menos una; la última no se deja
  for (const s of lista.filter((x) => x.activo).slice(1)) assert.equal((await admin.put(`/api/admin/sucursales/${s.id}`, { activo: false })).status, 200);
  const unica = (await admin.get('/api/admin/sucursales')).body.find((s) => s.activo);
  const x = await admin.put(`/api/admin/sucursales/${unica.id}`, { activo: false });
  assert.equal(x.status, 409);
  assert.match(x.body.error, /única sucursal/);
  const ed = (await t.db.query(`select detalle from core.auditoria where accion = 'sucursal_editada' order by id desc limit 1`)).rows[0];
  assert.ok(ed.detalle.cambios);
});

test('usuarios: rol, PIN, sucursal fija, desactivar y restablecer clave; cada cambio queda con antes y después', async () => {
  const suc = (await admin.get('/api/admin/sucursales')).body.find((s) => s.activo);
  const nuevo = await admin.post('/api/admin/usuarios', { nombre: 'Luis Ventas', rol: 'ventas', pin: '5678', sucursal_ids: [suc.id] });
  assert.equal(nuevo.status, 201, JSON.stringify(nuevo.body));
  assert.equal((await admin.post('/api/admin/usuarios', { nombre: 'Otro', rol: 'cajero', pin: '5678' })).status, 409);   // PIN único en la empresa
  assert.equal((await admin.post('/api/admin/usuarios', { nombre: 'Jefe', rol: 'admin', email: 'jefe@x.hn', password: 'ClaveSegura123' })).status, 403);   // solo el dueño crea administradores
  const u = (await admin.get('/api/admin/usuarios')).body.find((x) => x.nombre === 'Luis Ventas');
  assert.deepEqual(u.sucursal_ids, [suc.id]);
  assert.equal(u.tiene_pin, true);
  assert.equal((await admin.put(`/api/admin/usuarios/${u.id}`, { rol: 'cajero', activo: false })).status, 200);
  const ev = (await t.db.query(`select detalle from core.auditoria where accion = 'usuario_editado' and entidad_id = $1 order by id desc limit 1`, [u.id])).rows[0];
  assert.deepEqual(ev.detalle.cambios.rol, { antes: 'ventas', despues: 'cajero' });
  assert.deepEqual(ev.detalle.cambios.activo, { antes: true, despues: false });
  await assert.rejects(t.loginPin('origen', '5678'));                                             // desactivado: no entra
  await admin.put(`/api/admin/usuarios/${u.id}`, { activo: true });
  assert.equal((await admin.post(`/api/admin/usuarios/${u.id}/pin`, { pin: '12' })).status, 400);
  assert.equal((await admin.post(`/api/admin/usuarios/${u.id}/pin`, { pin: null })).status, 200);
  const g = (await admin.get('/api/admin/usuarios')).body.find((x) => x.nombre === 'Manager');
  assert.equal((await admin.post(`/api/admin/usuarios/${g.id}/password`, { password: 'NuevaClave456' })).status, 200);
  assert.equal((await ger.get('/api/admin/usuarios')).status, 401);   // sus sesiones anteriores se cerraron
  ger = t.cli(await t.login('origen', 'ger@origen.hn', 'NuevaClave456'), 'origen');
  assert.equal((await ger.get('/api/admin/usuarios')).status, 403);   // el manager no administra usuarios
});

test('bitácora: filtros por acción, usuario, texto y fechas; paginación; verificación de integridad', async () => {
  const todo = (await admin.get('/api/admin/auditoria')).body;
  assert.ok(todo.length > 5);
  assert.ok(todo.every((a) => a.hash && a.hash.length === 64));
  assert.ok(todo.every((a) => a.hash_anterior !== undefined));
  const ped = (await admin.get('/api/admin/auditoria?accion=usuario_')).body;
  assert.ok(ped.length >= 2 && ped.every((a) => a.accion.startsWith('usuario_')));
  const quien = (await admin.get('/api/admin/auditoria/usuarios')).body;
  const yo = quien.find((x) => x.nombre === 'Admin Origen');
  assert.ok(yo);
  assert.ok((await admin.get(`/api/admin/auditoria?usuario_id=${yo.id}`)).body.every((a) => a.usuario_id === yo.id));
  const busq = (await admin.get('/api/admin/auditoria?q=Luis')).body;
  assert.ok(busq.length >= 1 && busq.every((a) => JSON.stringify(a).includes('Luis')));
  assert.equal((await admin.get('/api/admin/auditoria?q=zzz-no-existe-zzz')).body.length, 0);
  const hoy = fechaHN();
  assert.ok((await admin.get(`/api/admin/auditoria?desde=${hoy}&hasta=${hoy}`)).body.length >= 1);
  assert.equal((await admin.get('/api/admin/auditoria?desde=2001-01-01&hasta=2001-01-02')).body.length, 0);
  assert.equal((await admin.get('/api/admin/auditoria?desde=mañana')).status, 400);
  const p1 = (await admin.get('/api/admin/auditoria?limite=3')).body;
  const p2 = (await admin.get(`/api/admin/auditoria?limite=3&antes_de=${p1[2].id}`)).body;
  assert.equal(p1.length, 3);
  assert.ok(p2.every((a) => a.id < p1[2].id));
  const suc = (await admin.get(`/api/admin/auditoria?sucursal_id=${sucA}`)).body;
  assert.ok(suc.every((a) => a.sucursal_id === sucA));
  assert.equal((await caja.get('/api/admin/auditoria')).status, 403);
  assert.equal((await ger.get('/api/admin/auditoria')).status, 403);
  const v = (await admin.get('/api/admin/auditoria/verificar')).body;
  assert.equal(v.integra, true);
  assert.ok(v.total >= todo.length);
  // inalterable: ni siquiera con SQL directo se puede editar
  await assert.rejects(t.db.query(`update core.auditoria set accion = 'x' where id = $1`, [todo[0].id]), /inalterable/);
});
