import { leerConfig, validarConfig } from './config.js';
import { abrirDb } from './db/index.js';
import { migrar } from './db/migrar.js';
import { crearApp } from './app.js';
import { sembrarSiVacio } from './modulos/rinv/siembra.js';
import { sembrarCatalogoItaloSiVacio } from './db/italo-catalogo.js';
import { sembrarEcostoneSiVacio } from './db/ecostone-datos.js';
import { iniciarVigilancia } from './modulos/salud/vigilancia.js';
import { iniciarMensajeria } from './modulos/mensajeria/planificador.js';
import { semillasPendientes } from './db/arranque.js';

const config = leerConfig();
validarConfig(config);
const db = await abrirDb(config);

console.log(`[db] ${config.driver === 'pg' ? 'Postgres/Supabase' : 'PGlite embebido en ' + config.dataDir}`);
const hechas = await migrar(db, config.migraciones);
if (hechas.length) console.log(`[db] ${hechas.length} migración(es) aplicada(s)`);

// Cargas iniciales (solo la primera vez; después no hacen nada). Se revisa con UNA consulta qué falta y solo se llama a lo pendiente.
const pendientes = await semillasPendientes(db).catch((e) => { console.error('[db] no se pudo revisar las cargas iniciales:', e.message); return { rinv: true, italo: true, ecostone: true }; });
// Inventario de reposición: carga idempotente de los datos reales de Italo la primera vez.
if (pendientes.rinv) await sembrarSiVacio(db).catch((e) => console.error('[rinv] no se pudo sembrar:', e.message));
// Catálogo y clientes reales de Italo (export de WizPOS), si Italo aún no tiene productos.
if (pendientes.italo) await sembrarCatalogoItaloSiVacio(db, { log: console.log }).catch((e) => console.error('[italo] no se pudo cargar el catálogo:', e.message));
// Datos reales de EcoStone (piedra, insumos, recetas, clientes), si EcoStone aún no tiene productos.
if (pendientes.ecostone) await sembrarEcostoneSiVacio(db, { log: console.log }).catch((e) => console.error('[ecostone] no se pudieron cargar los datos:', e.message));

const app = crearApp({ db, config });

// Correo y avisos (cola de envíos, resumen diario y alertas por correo): temporizador interno, sin cron externo.
iniciarMensajeria({ db, config });
// Latido cada minuto, caídas detectadas al arrancar y aviso por correo si se repiten (Estado del sistema).
iniciarVigilancia({ db, config, errores: app.locals.errores });
const servidor = app.listen(config.puerto, () => console.log(`[api] escuchando en :${config.puerto}`));

const cerrar = async () => { servidor.close(); await db.close().catch(() => {}); process.exit(0); };
process.on('SIGTERM', cerrar);
process.on('SIGINT', cerrar);
process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e); app.locals.errores.registrar({ origen: 'servidor', mensaje: `unhandledRejection: ${e?.message ?? e}`, pila: e?.stack }); });
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e); app.locals.errores.registrar({ origen: 'servidor', mensaje: `uncaughtException: ${e?.message ?? e}`, pila: e?.stack }).finally(() => process.exit(1)); });
