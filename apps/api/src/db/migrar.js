import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { leerConfig } from '../config.js';
import { abrirDb } from './index.js';

/** Aplica en orden las migraciones pendientes de supabase/migrations. Idempotente. */
export async function migrar(db, carpeta, log = console.log) {
  await db.tx(async (q) => {
    await q.query('select pg_advisory_xact_lock(727274)');   // arranques simultáneos: uno crea la tabla, los demás esperan
    await q.exec(`create table if not exists public._migraciones (
      nombre text primary key, aplicada_at timestamptz not null default now())`);
    // En Supabase el esquema public se expone por la API REST: sin RLS (y sin políticas) esta tabla quedaría legible con la llave anónima.
    await q.exec('alter table public._migraciones enable row level security');
  });
  const hechas = new Set((await db.query('select nombre from public._migraciones')).rows.map((r) => r.nombre));
  const archivos = fs.readdirSync(carpeta).filter((f) => f.endsWith('.sql')).sort();
  const aplicadas = [];
  for (const f of archivos) {
    if (hechas.has(f)) continue;
    const sql = fs.readFileSync(path.join(carpeta, f), 'utf8');
    const hecha = await db.tx(async (q) => {
      // Dos instancias que arrancan a la vez (un despliegue que se traslapa) no deben aplicar la misma migración dos veces.
      await q.query('select pg_advisory_xact_lock(727274)');
      if ((await q.query('select 1 from public._migraciones where nombre = $1', [f])).rowCount) return false;
      await q.exec(sql);
      await q.query('insert into public._migraciones (nombre) values ($1)', [f]);
      return true;
    });
    if (!hecha) continue;
    log(`  ✓ migración ${f}`);
    aplicadas.push(f);
  }
  return aplicadas;
}

// Uso directo: npm run migrate
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = leerConfig();
  const db = await abrirDb(config);
  console.log(`Migrando (${config.driver})…`);
  const hechas = await migrar(db, config.migraciones);
  console.log(hechas.length ? `Listo: ${hechas.length} migración(es) aplicada(s).` : 'Base al día, nada que aplicar.');
  await db.close();
}
