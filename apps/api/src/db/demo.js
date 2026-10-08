import { leerConfig } from '../config.js';
import { abrirDb } from './index.js';
import { migrar } from './migrar.js';
import { sembrar } from './sembrar.js';
import { crearDueno } from './crear-dueno.js';
import { hashSecreto } from '../auth/passwords.js';
import { hashPin } from '../auth/pin.js';

/**
 * Prepara una base LOCAL de demostración (PGlite) con datos de Origen y usuarios
 * de prueba. Nunca se usa contra Supabase/producción.
 *   npm run demo            → deja la base lista y sale
 */
export async function prepararDemo(db, config) {
  await migrar(db, config.migraciones, () => {});
  await sembrar(db, config.semillas, 'origen');
  await crearDueno(db, { email: 'dueno@grupo.hn', nombre: 'Juan Carlos (demo)', password: 'Demo-Grupo-2026' });
  const emp = async (c) => (await db.query('select id from core.empresas where codigo = $1', [c])).rows[0].id;
  const origen = await emp('origen');
  const nuevo = async (nombre, email, password, rol, pin) => {
    const u = (await db.query(
      `insert into core.usuarios (nombre, email, password_hash) values ($1,$2,$3)
       on conflict (email) do update set nombre = excluded.nombre returning id`, [nombre, email, password ? hashSecreto(password) : null])).rows[0];
    await db.query(
      `insert into core.accesos (usuario_id, empresa_id, rol, pin_hash) values ($1,$2,$3,$4) on conflict (usuario_id, empresa_id) do nothing`,
      [u.id, origen, rol, pin ? hashPin(config, origen, pin) : null]);
  };
  await nuevo('Gerente Origen (demo)', 'gerente@origen.hn', 'Demo-Grupo-2026', 'gerente', '2468');
  await nuevo('Caja 1 (demo)', null, null, 'cajero', '1111');
  await nuevo('Cocina (demo)', null, null, 'produccion', '2222');
}

if (process.argv[1]?.endsWith('demo.js')) {
  const config = leerConfig();
  if (config.driver !== 'pglite') { console.error('El modo demo solo corre sobre la base local embebida (quita DATABASE_URL).'); process.exit(1); }
  const db = await abrirDb(config);
  await prepararDemo(db, config);
  console.log('Demo lista. Dueño: dueno@grupo.hn / Demo-Grupo-2026 · Gerente Origen: gerente@origen.hn (mismo pass, PIN 2468) · Caja PIN 1111 · Cocina PIN 2222');
  await db.close();
}
