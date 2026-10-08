import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { leerConfig } from '../config.js';
import { abrirDb } from './index.js';

/** Aplica en orden las migraciones pendientes de supabase/migrations. Idempotente. */
export async function migrar(db, carpeta, log = console.log) {
  await db.exec(`create table if not exists public._migraciones (
    nombre text primary key, aplicada_at timestamptz not null default now())`);
  const hechas = new Set((await db.query('select nombre from public._migraciones')).rows.map((r) => r.nombre));
  const archivos = fs.readdirSync(carpeta).filter((f) => f.endsWith('.sql')).sort();
  const aplicadas = [];
  for (const f of archivos) {
    if (hechas.has(f)) continue;
    const sql = fs.readFileSync(path.join(carpeta, f), 'utf8');
    await db.tx(async (q) => {
      await q.exec(sql);
      await q.query('insert into public._migraciones (nombre) values ($1)', [f]);
    });
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
