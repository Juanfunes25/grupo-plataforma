import { leerConfig, validarConfig } from './config.js';
import { abrirDb } from './db/index.js';
import { migrar } from './db/migrar.js';
import { crearApp } from './app.js';

const config = leerConfig();
validarConfig(config);
const db = await abrirDb(config);

console.log(`[db] ${config.driver === 'pg' ? 'Postgres/Supabase' : 'PGlite embebido en ' + config.dataDir}`);
const hechas = await migrar(db, config.migraciones);
if (hechas.length) console.log(`[db] ${hechas.length} migración(es) aplicada(s)`);

const app = crearApp({ db, config });
const servidor = app.listen(config.puerto, () => console.log(`[api] escuchando en :${config.puerto}`));

const cerrar = async () => { servidor.close(); await db.close().catch(() => {}); process.exit(0); };
process.on('SIGTERM', cerrar);
process.on('SIGINT', cerrar);
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
