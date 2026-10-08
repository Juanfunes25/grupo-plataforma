import { leerConfig, validarConfig } from './config.js';
import { abrirDb } from './db/index.js';
import { migrar } from './db/migrar.js';
import { crearApp } from './app.js';
import { sembrarSiVacio } from './modulos/rinv/siembra.js';

const config = leerConfig();
validarConfig(config);
const db = await abrirDb(config);

console.log(`[db] ${config.driver === 'pg' ? 'Postgres/Supabase' : 'PGlite embebido en ' + config.dataDir}`);
const hechas = await migrar(db, config.migraciones);
if (hechas.length) console.log(`[db] ${hechas.length} migración(es) aplicada(s)`);

// Inventario de reposición: carga idempotente de los datos reales de Italo la primera vez (si no, no hace nada).
await sembrarSiVacio(db).catch((e) => console.error('[rinv] no se pudo sembrar:', e.message));

const app = crearApp({ db, config });
const servidor = app.listen(config.puerto, () => console.log(`[api] escuchando en :${config.puerto}`));

const cerrar = async () => { servidor.close(); await db.close().catch(() => {}); process.exit(0); };
process.on('SIGTERM', cerrar);
process.on('SIGINT', cerrar);
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
