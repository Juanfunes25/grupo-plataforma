// QA · seguridad y aislamiento. Pruebas escritas al revisar la plataforma de punta a punta:
//  · ninguna ruta de negocio responde a un usuario SIN permisos (barrido automático de TODAS las rutas del API);
//  · un administrador de una empresa no puede tomar la cuenta del dueño ni abrirse la Dirección del Grupo;
//  · un usuario de otra empresa recibe 403 en todo, aunque conozca los ids.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PERMISOS } from '@grupo/shared';

// Registro de rutas: se engancha al Router de Express ANTES de cargar la aplicación.
const proto = Object.getPrototypeOf(Object.getPrototypeOf(express.Router()));
const registro = []; const montajes = new Map(); let nIds = 0;
const idDe = (r) => (r.__qaid ??= ++nIds);
for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
  const orig = proto[m];
  proto[m] = function (p, ...h) { if (typeof p === 'string') registro.push({ rid: idDe(this), m: m.toUpperCase(), p }); return orig.call(this, p, ...h); };
}
const origUse = proto.use;
proto.use = function (...a) {
  if (typeof a[0] === 'string') { for (const x of a.slice(1).flat()) if (x?.stack) montajes.set(idDe(x), { padre: idDe(this), p: a[0] }); }
  else { for (const x of a.flat()) if (x?.stack) montajes.set(idDe(x), { padre: idDe(this), p: '' }); }
  return origUse.apply(this, a);
};
const { iniciar } = await import('./helpers.js');

const prefijo = (rid) => { let p = '', cur = rid; while (montajes.has(cur)) { const m = montajes.get(cur); p = m.p + p; cur = m.padre; } return p; };

let t, ceroPermisos, otraEmpresa, adminOrigen;
before(async () => {
  t = await iniciar();
  await t.usuario({ nombre: 'Dueño', email: 'dueno@grupo.hn', password: 'ClaveSegura123', dueno: true });
  const u0 = await t.usuario({ nombre: 'Sin permisos', email: 'cero@italo.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'italo', rol: 'cajero' }] });
  await t.db.query('update core.accesos set permisos_quitados = $1::text[] where usuario_id = $2', [Object.keys(PERMISOS), u0.id]);
  await t.usuario({ nombre: 'Admin Origen', email: 'admin@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'admin' }] });
  await t.usuario({ nombre: 'Dueño Italo', email: 'dueno@italo.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'italo', rol: 'dueno' }, { empresa: 'origen', rol: 'solo_lectura' }] });
  ceroPermisos = t.cli(await t.login('italo', 'cero@italo.hn', 'ClaveSegura123'), 'italo');
  adminOrigen = t.cli(await t.login('origen', 'admin@origen.hn', 'ClaveSegura123'), 'origen');
  otraEmpresa = t.cli(await t.login('origen', 'admin@origen.hn', 'ClaveSegura123'), 'italo');   // pide Italo con un token de Origen
});
after(() => t.cerrar());

const ID = '00000000-0000-4000-8000-000000000001';
const rutasNegocio = () => registro
  .map((r) => ({ m: r.m, path: ('/api' + prefijo(r.rid) + (r.p === '/' ? '' : r.p)).replace('/api/api', '/api').replace(/\/\/+/g, '/') }))
  .filter((r) => r.path.startsWith('/api/') && !/^\/api\/(auth|publico|health)\b/.test(r.path));

async function llamar(cli, token, m, path) {
  const p = path.replace(/:[A-Za-z_]+/g, (x) => (/codigo|alias/i.test(x) ? 'x' : ID));
  if (m === 'GET') return cli.get(p);
  if (m === 'DELETE') return cli.del(p);
  if (m === 'POST') return cli.post(p, {});
  if (m === 'PUT') return cli.put(p, {});
  const r = await fetch(t.base + p, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-empresa': 'italo' }, body: '{}' });
  return { status: r.status };
}

// Rutas que cualquier usuario autenticado puede llamar a propósito (no devuelven datos del negocio).
const ABIERTAS = new Set(['GET /api/admin/roles', 'GET /api/antifraude/sesion', 'POST /api/antifraude/evento']);

test('el barrido cubre todo el API (si falla, el registro de rutas dejó de funcionar)', () => {
  assert.ok(rutasNegocio().length > 300, `solo se vieron ${rutasNegocio().length} rutas`);
});

test('un usuario SIN permisos recibe 403 en TODAS las rutas de negocio (salvo las abiertas a propósito)', async () => {
  const token = await t.login('italo', 'cero@italo.hn', 'ClaveSegura123');
  const abiertas = [];
  for (const r of rutasNegocio()) {
    if (ABIERTAS.has(`${r.m} ${r.path}`)) continue;
    const x = await llamar(ceroPermisos, token, r.m, r.path);
    if (x.status !== 403) abiertas.push(`${x.status} ${r.m} ${r.path}`);
  }
  assert.deepEqual(abiertas, [], `rutas sin requierePermiso:\n${abiertas.join('\n')}`);
});

test('un token de otra empresa no entra a Italo en ninguna ruta', async () => {
  const token = await t.login('origen', 'admin@origen.hn', 'ClaveSegura123');
  const abiertas = [];
  for (const r of rutasNegocio()) {
    const x = await llamar(otraEmpresa, token, r.m, r.path);
    if (x.status !== 403) abiertas.push(`${x.status} ${r.m} ${r.path}`);
  }
  assert.deepEqual(abiertas, []);
});

test('un administrador NO puede tomar la cuenta del dueño del grupo agregándolo como usuario', async () => {
  const r = await adminOrigen.post('/api/admin/usuarios', { nombre: 'Intruso', email: 'dueno@grupo.hn', password: 'Hackeado-12345', rol: 'solo_lectura' });
  assert.ok([201, 403, 409].includes(r.status));
  const lg = await t.cli().post('/api/auth/login', { empresa: 'origen', email: 'dueno@grupo.hn', password: 'Hackeado-12345' });
  assert.equal(lg.status, 401, 'la contraseña del dueño NO debe cambiar');
  await t.login('origen', 'dueno@grupo.hn', 'ClaveSegura123');   // sigue entrando con la suya
});

test('un administrador NO puede restablecer la clave de quien es dueño en otra empresa', async () => {
  const id = (await t.db.query(`select id from core.usuarios where email = 'dueno@italo.hn'`)).rows[0].id;
  const r = await adminOrigen.post(`/api/admin/usuarios/${id}/password`, { password: 'Hackeado-98765' });
  assert.equal(r.status, 403);
  const rn = await adminOrigen.put(`/api/admin/usuarios/${id}`, { nombre: 'Renombrado' });
  assert.equal(rn.status, 403);
  await t.login('italo', 'dueno@italo.hn', 'ClaveSegura123');
});

test('un administrador no se abre la Dirección del Grupo dándose (o dando) grupo:ver', async () => {
  const r = await adminOrigen.post('/api/admin/usuarios', { nombre: 'Espía', email: 'espia@origen.hn', password: 'Espia-12345', rol: 'gerente', permisos_extra: ['grupo:ver'] });
  assert.equal(r.status, 403);
  // sí puede dar permisos normales de su empresa
  const ok = await adminOrigen.post('/api/admin/usuarios', { nombre: 'Gerente 2', email: 'g2@origen.hn', password: 'Gerente-12345', rol: 'gerente', permisos_extra: ['fin:ver'] });
  assert.equal(ok.status, 201);
  // y el dueño del grupo sí puede dar grupo:ver
  const dueno = t.cli(await t.login('origen', 'dueno@grupo.hn', 'ClaveSegura123'), 'origen');
  const u = (await t.db.query(`select id from core.usuarios where email = 'g2@origen.hn'`)).rows[0].id;
  assert.equal((await dueno.put(`/api/admin/usuarios/${u}`, { permisos_extra: ['grupo:ver'] })).status, 200);
});

test('entradas hostiles: caracteres nulos, fechas imposibles y números gigantes dan 400, nunca 500', async () => {
  const dueno = t.cli(await t.login('origen', 'dueno@grupo.hn', 'ClaveSegura123'), 'origen');
  for (const [m, ruta, cuerpo] of [
    ['post', '/api/terceros', { nombre: 'Mal\u0000nombre' }],
    ['post', '/api/pos/catalogo/admin/categorias', { nombre: 'Cat\u0000' }],
    ['post', '/api/inv/insumos', { nombre: 'Ins\u0000umo', unidad: 'kg', costo_actual: 1e30 }],
    ['post', '/api/documentos/tipos', { nombre: 'Tipo\u0000' }],
  ]) {
    const r = await dueno[m](ruta, cuerpo);
    assert.ok(r.status >= 400 && r.status < 500, `${m} ${ruta} → ${r.status} ${JSON.stringify(r.body)}`);
  }
  for (const ruta of ['/api/pos/dashboard?desde=0001-01-01&hasta=9999-12-31', '/api/pos/reportes/resumen?desde=2026-02-30&hasta=x', '/api/pos/ventas?limite=-1', '/api/admin/auditoria?antes_de=99999999999999999999']) {
    const r = await dueno.get(ruta);
    assert.ok(r.status < 500, `${ruta} → ${r.status}`);
  }
});

test('encabezados de seguridad en el API y la web', async () => {
  const r = await fetch(`${t.base}/api/health`);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(r.headers.get('referrer-policy'), 'same-origin');
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  // un origen que no es el de la plataforma recibe 403 limpio (antes: 500 con traza en el log)
  const c = await fetch(`${t.base}/api/health`, { headers: { origin: 'https://sitio-malo.example' } });
  assert.equal(c.status, 403);
});
