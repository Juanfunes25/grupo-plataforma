import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export function leerConfig(env = process.env) {
  const produccion = env.NODE_ENV === 'production';
  const databaseUrl = env.DATABASE_URL || '';
  return {
    produccion,
    puerto: num(env.PORT, 4300),
    // Con DATABASE_URL usa Postgres/Supabase; sin ella corre un Postgres embebido
    // (PGlite) en ./data — ideal para probar en la laptop sin instalar nada.
    driver: databaseUrl ? 'pg' : 'pglite',
    databaseUrl,
    dataDir: env.PGLITE_DIR || path.join(aqui, '..', '..', '..', 'data', 'pglite'),
    migraciones: path.join(aqui, '..', '..', '..', 'supabase', 'migrations'),
    semillas: path.join(aqui, '..', '..', '..', 'supabase', 'seeds'),
    webDist: path.resolve(env.WEB_DIST || path.join(aqui, '..', '..', 'web', 'dist')),
    // Secreto con el que el API firma las sesiones (obligatorio en producción).
    jwtSecret: env.APP_JWT_SECRET || (produccion ? '' : 'dev-secreto-solo-para-desarrollo-local-0123456789'),
    sesionHoras: num(env.SESION_HORAS, 12),
    // Pepper del PIN: cambiarlo invalida todos los PIN (hay que reasignarlos).
    pinPepper: env.PIN_PEPPER || env.APP_JWT_SECRET || 'dev-pepper-solo-para-desarrollo-local',
    // Si hay Supabase Auth, el correo+contraseña se valida contra él.
    supabaseUrl: env.SUPABASE_URL || '',
    supabaseAnonKey: env.SUPABASE_ANON_KEY || '',
    origenesPermitidos: (env.FRONTEND_ORIGIN || 'http://localhost:5180').split(',').map((s) => s.trim()).filter(Boolean),
    smtp: { user: env.GMAIL_USER || '', pass: env.GMAIL_APP_PASSWORD || '' },
    // Llave con la que se cifran los secretos de la verificación en dos pasos. Si falta se usa APP_JWT_SECRET.
    // Fíjala ANTES de rotar APP_JWT_SECRET para no perder los 2FA ya activados (docs/SEGURIDAD.md).
    mfaKey: env.MFA_KEY || '',
    // Versión que muestra «Estado del sistema» (commit del despliegue si la plataforma lo da).
    version: env.APP_VERSION || env.RENDER_GIT_COMMIT || env.RAILWAY_GIT_COMMIT_SHA || env.GIT_COMMIT || '',
    // Límite del plan de base de datos (MB) para avisar cuando se acerque (Supabase gratis = 500).
    dbLimiteMb: num(env.DB_LIMITE_MB, 500),
    // Caché de respuestas de lectura pesadas (catálogo, tableros). Se apaga con CACHE_API=0.
    cacheApi: env.CACHE_API !== '0' && env.NODE_ENV !== 'test',
  };
}

export function validarConfig(c) {
  const faltan = [];
  if (c.produccion && !c.jwtSecret) faltan.push('APP_JWT_SECRET');
  if (c.produccion && c.jwtSecret && c.jwtSecret.length < 32) faltan.push('APP_JWT_SECRET (mínimo 32 caracteres)');
  if (c.produccion && c.driver !== 'pg') faltan.push('DATABASE_URL');
  if (faltan.length) throw new Error(`Faltan variables de entorno: ${faltan.join(', ')}`);
}
