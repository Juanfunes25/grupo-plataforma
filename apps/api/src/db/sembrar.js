import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { leerConfig } from '../config.js';
import { abrirDb } from './index.js';

/** Ejecuta supabase/seeds/<nombre>.sql (idempotente). Uso: npm run seed:origen */
export async function sembrar(db, carpeta, nombre) {
  const archivo = path.join(carpeta, `${nombre}_demo.sql`);
  if (!fs.existsSync(archivo)) throw new Error(`No existe la semilla ${archivo}`);
  await db.tx((q) => q.exec(fs.readFileSync(archivo, 'utf8')));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const nombre = process.argv[2];
  if (!nombre) { console.error('Uso: node sembrar.js <origen>'); process.exit(1); }
  const config = leerConfig();
  const db = await abrirDb(config);
  await sembrar(db, config.semillas, nombre);
  console.log(`Semilla "${nombre}" aplicada.`);
  await db.close();
}
