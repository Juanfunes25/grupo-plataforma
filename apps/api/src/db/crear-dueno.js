import { fileURLToPath } from 'node:url';
import { leerConfig } from '../config.js';
import { abrirDb } from './index.js';
import { hashSecreto } from '../auth/passwords.js';

/**
 * Crea (o actualiza la contraseña de) un DUEÑO DEL GRUPO: ve todas las empresas,
 * presentes y futuras. Es el primer paso después de migrar una base nueva.
 *   npm run crear-dueno -- correo@dominio.com "Nombre Apellido" "contraseña-larga"
 */
export async function crearDueno(db, { email, nombre, password }) {
  if (!/^\S+@\S+\.\S+$/.test(email ?? '')) throw new Error('Correo inválido');
  if ((password ?? '').length < 10) throw new Error('La contraseña debe tener al menos 10 caracteres');
  const { rows } = await db.query(
    `insert into core.usuarios (email, nombre, password_hash, es_dueno_grupo)
     values ($1, $2, $3, true)
     on conflict (email) do update set password_hash = excluded.password_hash, es_dueno_grupo = true, activo = true, token_version = core.usuarios.token_version + 1
     returning id`,
    [email.toLowerCase(), nombre, hashSecreto(password)]);
  return rows[0].id;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [email, nombre, password] = process.argv.slice(2);
  if (!email || !nombre || !password) {
    console.error('Uso: npm run crear-dueno -- correo@dominio.com "Nombre Apellido" "contraseña-larga"');
    process.exit(1);
  }
  const db = await abrirDb(leerConfig());
  try {
    await crearDueno(db, { email, nombre, password });
    console.log(`Listo: ${email} es dueño del grupo (entra a todas las empresas).`);
  } catch (e) {
    console.error('No se pudo crear:', e.message);
    process.exitCode = 1;
  }
  await db.close();
}
