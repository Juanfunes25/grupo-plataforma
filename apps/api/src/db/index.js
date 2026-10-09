import fs from 'node:fs';
import path from 'node:path';

// Interfaz común para Postgres real (Supabase) y PGlite (embebido):
//   db.query(sql, params) → { rows, rowCount }
//   db.exec(sql)          → ejecuta varias sentencias
//   db.tx(async (q) => …) → q.query / q.exec dentro de una transacción
// Tipos: numeric/int8 llegan como Number y date como 'YYYY-MM-DD' en ambos.

const OID = { INT8: 20, NUMERIC: 1700, DATE: 1082 };

export async function abrirDb(config) {
  if (config.driver === 'pg') return abrirPg(config);
  return abrirPglite(config);
}

async function abrirPg({ databaseUrl }) {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(OID.INT8, (v) => Number(v));
  pg.types.setTypeParser(OID.NUMERIC, (v) => parseFloat(v));
  pg.types.setTypeParser(OID.DATE, (v) => v);
  const local = /localhost|127\.0\.0\.1/.test(databaseUrl);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,   // sin esto, si la base no responde la petición se queda colgada para siempre
    ssl: local ? false : { rejectUnauthorized: false }, // Supabase pooler
  });
  pool.on('error', (e) => console.error('[db] error en conexión inactiva:', e.message));
  const envolver = (c) => ({
    query: (sql, params) => c.query(sql, params),
    exec: (sql) => c.query(sql),
  });
  return {
    driver: 'pg',
    query: (sql, params) => pool.query(sql, params),
    exec: (sql) => pool.query(sql),
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('begin');
        const r = await fn(envolver(c));
        await c.query('commit');
        return r;
      } catch (e) {
        await c.query('rollback').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
    stats: () => ({ total: pool.totalCount, ociosas: pool.idleCount, esperando: pool.waitingCount, maximo: 10 }),
  };
}

async function abrirPglite({ dataDir }) {
  const { PGlite } = await import('@electric-sql/pglite');
  const enMemoria = dataDir === ':memory:';
  if (!enMemoria) fs.mkdirSync(path.dirname(dataDir), { recursive: true });
  const pg = new PGlite(enMemoria ? undefined : dataDir);
  // PGlite (0.2.x) solo aplica los parsers por consulta, no en el constructor.
  const opciones = { parsers: { [OID.INT8]: (v) => Number(v), [OID.NUMERIC]: (v) => parseFloat(v), [OID.DATE]: (v) => v } };
  await pg.waitReady;
  const envolver = (t) => ({
    query: async (sql, params) => {
      const r = await t.query(sql, params, opciones);
      return { rows: r.rows, rowCount: Math.max(r.affectedRows ?? 0, r.rows.length) };
    },
    exec: (sql) => t.exec(sql),
  });
  return {
    driver: 'pglite',
    query: async (sql, params) => {
      const r = await pg.query(sql, params, opciones);
      return { rows: r.rows, rowCount: Math.max(r.affectedRows ?? 0, r.rows.length) };
    },
    exec: (sql) => pg.exec(sql),
    tx: (fn) => pg.transaction((t) => fn(envolver(t))),
    close: () => pg.close(),
  };
}
