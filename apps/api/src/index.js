import { leerConfig, validarConfig } from './config.js';
import { abrirDb } from './db/index.js';
import { migrar } from './db/migrar.js';
import { crearApp } from './app.js';
import { sembrarSiVacio } from './modulos/rinv/siembra.js';
import { sembrarCatalogoItaloSiVacio } from './db/italo-catalogo.js';
import { sembrarEcostoneSiVacio } from './db/ecostone-datos.js';
import { iniciarMensajeria } from './modulos/mensajeria/planificador.js';

const config = leerConfig();
validarConfig(config);
const db = await abrirDb(config);

console.log(`[db] ${config.driver === 'pg' ? 'Postgres/Supabase' : 'PGlite embebido en ' + config.dataDir}`);
const hechas = await migrar(db, config.migraciones);
if (hechas.length) console.log(`[db] ${hechas.length} migración(es) aplicada(s)`);

// Inventario de reposición: carga idempotente de los datos reales de Italo la primera vez (si no, no hace nada).
await sembrarSiVacio(db).catch((e) => console.error('[rinv] no se pudo sembrar:', e.message));

// Catálogo y clientes reales de Italo (export de WizPOS): se cargan solos la primera vez, si Italo aún no tiene productos.
await sembrarCatalogoItaloSiVacio(db, { log: console.log }).catch((e) => console.error('[italo] no se pudo cargar el catálogo:', e.message));

// Datos reales de EcoStone (piedra, insumos, recetas, clientes): se cargan solos la primera vez, si EcoStone aún no tiene productos.
await sembrarEcostoneSiVacio(db, { log: console.log }).catch((e) => console.error('[ecostone] no se pudieron cargar los datos:', e.message));

const app = crearApp({ db, config });

// Correo y avisos (cola de envíos, resumen diario y alertas por correo): temporizador interno, sin cron externo.
iniciarMensajeria({ db, config });
const servidor = app.listen(config.puerto, () => console.log(`[api] escuchando en :${config.puerto}`));

const cerrar = async () => { servidor.close(); await db.close().catch(() => {}); process.exit(0); };
process.on('SIGTERM', cerrar);
process.on('SIGINT', cerrar);
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
