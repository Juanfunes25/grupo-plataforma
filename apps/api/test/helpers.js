import { once } from 'node:events';
import { leerConfig } from '../src/config.js';
import { abrirDb } from '../src/db/index.js';
import { migrar } from '../src/db/migrar.js';
import { crearApp } from '../src/app.js';
import { hashSecreto } from '../src/auth/passwords.js';
import { hashPin } from '../src/auth/pin.js';

/** Levanta el API completo sobre un Postgres embebido en memoria. */
export async function iniciar() {
  const config = { ...leerConfig({ NODE_ENV: 'test' }), driver: 'pglite', dataDir: ':memory:', webDist: '/no-existe' };
  // TEST_PG_ADMIN_URL=postgres://usuario:clave@host:puerto → corre las pruebas contra un Postgres REAL
  // (una base nueva por llamada): detecta lo que PGlite pasa por alto (concurrencia real, permisos).
  let borrarBase = null;
  if (process.env.TEST_PG_ADMIN_URL) {
    const pg = (await import('pg')).default;
    const nombre = `qa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const admin = new pg.Client({ connectionString: process.env.TEST_PG_ADMIN_URL + '/postgres' });
    await admin.connect(); await admin.query(`create database ${nombre}`); await admin.end();
    config.driver = 'pg'; config.databaseUrl = `${process.env.TEST_PG_ADMIN_URL}/${nombre}`;
    borrarBase = async () => { const a = new pg.Client({ connectionString: process.env.TEST_PG_ADMIN_URL + '/postgres' }); a.on('error', () => {}); try { await a.connect(); await a.query(`drop database if exists ${nombre}`); } catch {} finally { await a.end().catch(() => {}); } };
  }
  const db = await abrirDb(config);
  await migrar(db, config.migraciones, () => {});
  const app = crearApp({ db, config, log: process.env.QA_LOG ? console.error : () => {} });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  /** Cliente: cli(token, empresa).get/post/put/del → { status, body } */
  const cli = (token, empresa) => {
    const llamar = async (method, ruta, body) => {
      const r = await fetch(base + ruta, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(empresa ? { 'x-empresa': empresa } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const txt = await r.text();
      let json; try { json = txt ? JSON.parse(txt) : null; } catch { json = txt; }
      return { status: r.status, body: json };
    };
    return { get: (p) => llamar('GET', p), post: (p, b = {}) => llamar('POST', p, b), put: (p, b = {}) => llamar('PUT', p, b), del: (p) => llamar('DELETE', p) };
  };

  const empresaId = async (codigo) => (await db.query('select id from core.empresas where codigo = $1', [codigo])).rows[0].id;
  const sucursalId = async (empresa, alias) =>
    (await db.query('select s.id from core.sucursales s join core.empresas e on e.id = s.empresa_id where e.codigo = $1 and s.alias = $2', [empresa, alias])).rows[0].id;

  /** Crea usuario + acceso directamente en la BD (atajo de pruebas). */
  async function usuario({ nombre, email = null, password = null, dueno = false, accesos = [] }) {
    const u = (await db.query(
      'insert into core.usuarios (nombre, email, password_hash, es_dueno_grupo) values ($1,$2,$3,$4) returning *',
      [nombre, email, password ? hashSecreto(password) : null, dueno])).rows[0];
    for (const a of accesos) {
      const eid = await empresaId(a.empresa);
      await db.query(
        `insert into core.accesos (usuario_id, empresa_id, rol, sucursal_ids, pin_hash) values ($1,$2,$3,$4::uuid[],$5)`,
        [u.id, eid, a.rol, a.sucursal_ids ?? [], a.pin ? hashPin(config, eid, a.pin) : null]);
    }
    return u;
  }

  async function login(empresa, email, password) {
    const r = await cli().post('/api/auth/login', { empresa, email, password });
    if (r.status !== 200) throw new Error(`login falló: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.token;
  }
  async function loginPin(empresa, pin) {
    const r = await cli().post('/api/auth/pin', { empresa, pin });
    if (r.status !== 200) throw new Error(`pin falló: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.token;
  }

  return {
    db, config, app, base, cli, usuario, login, loginPin, empresaId, sucursalId,
    cerrar: async () => { server.close(); await db.close(); if (borrarBase) await borrarBase(); },
  };
}
