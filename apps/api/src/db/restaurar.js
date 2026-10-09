import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { leerConfig } from '../config.js';
import { abrirDb } from './index.js';
import { migrar } from './migrar.js';
import { restaurarZip } from './respaldo.js';

/**
 * Restaura respaldos exportados desde «Estado del sistema» (ZIP) sobre una base NUEVA.
 *
 *   node apps/api/src/db/restaurar.js italo.zip origen.zip ecostone.zip diserco.zip --limpiar --confirmo=BORRAR-Y-RESTAURAR
 *
 * Destino: DATABASE_URL (Supabase/Postgres) o, sin ella, la base local PGlite (PGLITE_DIR).
 *   --limpiar      vacía las tablas de la plataforma antes del PRIMER archivo (los siguientes se suman). Exige --confirmo.
 *   --confirmo=…   la frase BORRAR-Y-RESTAURAR: evita borrar una base por descuido.
 *   --sin-replica  no usa session_replication_role=replica (si tu proveedor no lo permite se prueba solo).
 *   --solo-revisar valida los ZIP (suma de control y migraciones) sin escribir nada.
 */
export async function restaurarArchivos(db, config, archivos, { limpiar = false, sinReplica = false, soloRevisar = false, log = console.log } = {}) {
  await migrar(db, config.migraciones, () => {});
  const informes = [];
  let primero = true;
  for (const f of archivos) {
    const buf = fs.readFileSync(f);
    if (soloRevisar) {
      const { leerZip } = await import('../lib/zip.js');
      const m = JSON.parse(leerZip(buf).get('manifiesto.json').toString('utf8'));
      log(`✓ ${path.basename(f)}: ${m.empresa.nombre}, ${m.tablas.reduce((a, t) => a + t.filas, 0)} filas en ${m.tablas.length} tablas, generado ${m.generado_at}`);
      continue;
    }
    log(`Restaurando ${path.basename(f)}…`);
    const r = await restaurarZip(db, buf, { limpiar: limpiar && primero, sinReplica, log: (m) => log(`  ${m}`) });
    primero = false;
    informes.push(r);
    log(`✓ ${r.empresa.nombre}: ${r.tablas.reduce((a, t) => a + t.cargadas, 0)} filas cargadas`);
  }
  return informes;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const archivos = args.filter((a) => !a.startsWith('--'));
  const bandera = (n) => args.includes(`--${n}`);
  if (!archivos.length) { console.error('Uso: node apps/api/src/db/restaurar.js respaldo.zip [otro.zip…] [--limpiar --confirmo=BORRAR-Y-RESTAURAR] [--sin-replica] [--solo-revisar]'); process.exit(1); }
  if (bandera('limpiar') && !args.includes('--confirmo=BORRAR-Y-RESTAURAR')) {
    console.error('--limpiar BORRA todas las tablas de la plataforma en el destino. Si de verdad quieres hacerlo agrega --confirmo=BORRAR-Y-RESTAURAR');
    process.exit(1);
  }
  const config = leerConfig();
  console.log(`Destino: ${config.driver === 'pg' ? 'Postgres/Supabase (DATABASE_URL)' : `PGlite local (${config.dataDir})`}`);
  const db = await abrirDb(config);
  try {
    await restaurarArchivos(db, config, archivos, { limpiar: bandera('limpiar'), sinReplica: bandera('sin-replica'), soloRevisar: bandera('solo-revisar') });
    console.log('Listo. Revisa los totales en la plataforma y recuerda reasignar contraseñas si el respaldo no incluía claves.');
  } catch (e) {
    console.error(`No se pudo restaurar: ${e.message}`);
    process.exitCode = 1;
  } finally { await db.close(); }
}
