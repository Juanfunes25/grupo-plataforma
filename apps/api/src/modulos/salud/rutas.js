import fs from 'node:fs';
import os from 'node:os';
import { Router } from 'express';
import { z } from 'zod';
import { fechaHN } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { conflicto, prohibido, validar } from '../../lib/http.js';
import { exportarEmpresaBuffer } from '../../db/respaldo.js';

const inicio = Date.now();
const MB = 1024 * 1024;

/** /api/salud: lo mínimo para un monitor externo (UptimeRobot, Better Stack). Sin datos sensibles. */
export function rutasSaludPublica({ db, config }) {
  const r = Router();
  r.get('/', async (_req, res) => {
    const t0 = Date.now();
    try {
      await db.query('select 1');
      res.json({ ok: true, base: 'ok', ms: Date.now() - t0, version: config.version || null, arranque_hace_s: Math.round((Date.now() - inicio) / 1000) });
    } catch { res.status(503).json({ ok: false, base: 'sin respuesta' }); }
  });
  return r;
}

async function intentar(fn, defecto = null) { try { return await fn(); } catch { return defecto; } }

/** Foto completa del sistema para el dueño. Cada pieza falla por separado: una consulta que no existe en PGlite no tumba la pantalla. */
export async function estadoSistema({ db, config, errores }) {
  const t0 = Date.now();
  await db.query('select 1');
  const latencia = Date.now() - t0;

  const tamano = await intentar(async () => Number((await db.query('select pg_database_size(current_database()) as b')).rows[0].b));
  const tablas = await intentar(async () => (await db.query(
    `select schemaname || '.' || relname as tabla, pg_total_relation_size(relid)::bigint as bytes, n_live_tup::bigint as filas
       from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 8`)).rows.map((x) => ({ tabla: x.tabla, mb: Math.round(Number(x.bytes) / MB * 10) / 10, filas: Number(x.filas) })), []);

  const aplicadas = (await db.query('select nombre, aplicada_at from public._migraciones order by nombre')).rows;
  const enDisco = await intentar(() => fs.readdirSync(config.migraciones).filter((f) => f.endsWith('.sql')).sort(), []);
  const pendientes = enDisco.filter((f) => !aplicadas.some((a) => a.nombre === f));

  const disco = config.driver === 'pglite' ? await intentar(() => { const s = fs.statfsSync(config.dataDir); return { libre_mb: Math.round(Number(s.bavail) * Number(s.bsize) / MB), total_mb: Math.round(Number(s.blocks) * Number(s.bsize) / MB) }; }) : null;

  const resumenErrores = await errores.resumen();
  const caidas = (await errores.recientes({ origen: 'caida', limite: 10 })).map((c) => ({ cuando: c.created_at, mensaje: c.mensaje }));
  const avisosPend = (await errores.recientes({ origen: 'aviso', limite: 5 })).map((c) => ({ cuando: c.created_at, mensaje: c.mensaje }));

  const respaldos = (await db.query(`select clave, valor, updated_at from core.sistema_estado where clave like 'respaldo:%' order by clave`)).rows
    .map((r) => ({ empresa: r.clave.slice('respaldo:'.length), fecha: r.valor?.at ?? r.updated_at, por: r.valor?.por ?? null, tablas: r.valor?.tablas ?? null }));

  const dir = (await db.query(
    `select count(*)::int as total, count(*) filter (where exists (select 1 from core.usuarios_mfa m where m.usuario_id = u.id and m.confirmado))::int as con_2fa
       from core.usuarios u where u.activo and (u.es_dueno_grupo or exists (select 1 from core.accesos a where a.usuario_id = u.id and a.activo and a.rol in ('dueno','admin')))`)).rows[0];
  const pol = (await db.query('select mfa_obligatoria_direccion from core.seguridad_politica where id')).rows[0];
  const sesiones = (await db.query(`select count(*)::int as n from core.sesiones_activas where revocada_at is null and expira_at > now()`)).rows[0].n;
  const ultimoLatido = (await db.query(`select valor from core.sistema_estado where clave = 'latido'`)).rows[0]?.valor?.at ?? null;

  const correoOk = await intentar(async () => (await import('../../lib/correo.js')).correoConfigurado(), Boolean(config.smtp.user && config.smtp.pass));
  const mem = process.memoryUsage();

  // Semáforo: cada chequeo dice qué pasa y, si no está bien, qué hacer.
  const chequeos = [];
  const c = (id, titulo, estado, detalle) => chequeos.push({ id, titulo, estado, detalle });
  c('base', 'Base de datos', latencia > 1500 ? 'aviso' : 'ok', `Responde en ${latencia} ms.`);
  if (tamano !== null) {
    const pct = Math.round((tamano / MB) / config.dbLimiteMb * 100);
    c('espacio', 'Espacio de la base de datos', pct >= 90 ? 'critico' : pct >= 75 ? 'aviso' : 'ok', `${Math.round(tamano / MB * 10) / 10} MB de ${config.dbLimiteMb} MB del plan (${pct} %).${pct >= 75 ? ' Conviene limpiar o subir de plan antes de quedarte sin espacio.' : ''}`);
  }
  c('migraciones', 'Migraciones', pendientes.length ? 'critico' : 'ok', pendientes.length ? `Pendientes: ${pendientes.join(', ')}.` : `${aplicadas.length} aplicadas, base al día.`);
  const e24 = resumenErrores.por_origen.find((x) => x.origen === 'servidor')?.veces24 ?? 0;
  c('errores_servidor', 'Errores del servidor (24 h)', e24 >= 50 ? 'critico' : e24 >= 10 ? 'aviso' : 'ok', e24 ? `${e24} errores internos en las últimas 24 horas.` : 'Sin errores internos.');
  const eNav = resumenErrores.por_origen.find((x) => x.origen === 'navegador')?.veces24 ?? 0;
  c('errores_navegador', 'Errores en los navegadores (24 h)', eNav >= 50 ? 'aviso' : 'ok', eNav ? `${eNav} errores de pantalla reportados.` : 'Sin errores de pantalla.');
  const nCaidas = resumenErrores.por_origen.find((x) => x.origen === 'caida')?.h24 ?? 0;
  c('caidas', 'Caídas (24 h)', nCaidas >= 3 ? 'critico' : nCaidas ? 'aviso' : 'ok', nCaidas ? `${nCaidas} caída(s) o reinicio(s) con interrupción.` : 'Sin caídas detectadas.');
  c('correo', 'Correo para avisos', correoOk ? 'ok' : 'aviso', correoOk ? 'Gmail configurado.' : 'Pendiente de configurar: faltan GMAIL_USER y GMAIL_APP_PASSWORD. Sin esto no salen los avisos por correo.');
  c('secretos', 'Llaves del servidor', config.produccion && config.jwtSecret.length < 32 ? 'critico' : config.produccion && !process.env.PIN_PEPPER ? 'aviso' : 'ok',
    !config.produccion ? 'Modo desarrollo (llaves de prueba).' : !process.env.PIN_PEPPER ? 'PIN_PEPPER no está definido: los PIN dependen de APP_JWT_SECRET, lo que complica rotar llaves. Define PIN_PEPPER.' : 'APP_JWT_SECRET y PIN_PEPPER definidos.');
  const ultimo = respaldos.reduce((m, r) => (!m || new Date(r.fecha) > new Date(m) ? r.fecha : m), null);
  const dias = ultimo ? Math.floor((Date.now() - new Date(ultimo).getTime()) / 86_400_000) : null;
  c('respaldo', 'Copia exportable', dias === null ? 'aviso' : dias > 30 ? 'aviso' : 'ok',
    dias === null ? 'Aún no has descargado ninguna copia exportable. Supabase respalda la base por su lado, pero esta copia es tuya y sirve fuera de Supabase.' : `Última copia hace ${dias} día(s).`);
  c('dos_pasos', 'Verificación en dos pasos (dirección)', dir.con_2fa === dir.total ? 'ok' : 'aviso', `${dir.con_2fa} de ${dir.total} personas de dirección la tienen activa.${pol?.mfa_obligatoria_direccion ? ' Es obligatoria.' : ''}`);

  const peor = chequeos.some((x) => x.estado === 'critico') ? 'critico' : chequeos.some((x) => x.estado === 'aviso') ? 'aviso' : 'ok';
  return {
    general: peor, generado_at: new Date().toISOString(), chequeos,
    servidor: { version: config.version || null, node: process.version, entorno: config.produccion ? 'producción' : 'desarrollo', arranque_hace_s: Math.round((Date.now() - inicio) / 1000),
      memoria_mb: Math.round(mem.rss / MB), heap_mb: Math.round(mem.heapUsed / MB), cpus: os.cpus().length, ultimo_latido: ultimoLatido },
    base: { motor: config.driver === 'pg' ? 'Postgres (Supabase)' : 'PGlite local', latencia_ms: latencia, tamano_mb: tamano === null ? null : Math.round(tamano / MB * 10) / 10,
      limite_mb: config.dbLimiteMb, tablas_grandes: tablas, conexiones: db.stats?.() ?? null, disco },
    migraciones: { aplicadas: aplicadas.length, ultima: aplicadas.at(-1)?.nombre ?? null, pendientes },
    errores: resumenErrores, caidas, avisos_pendientes: avisosPend, respaldos, sesiones_abiertas: sesiones,
  };
}

/** /api/sistema/*: Estado del sistema, errores y respaldos. Solo el dueño. */
export function rutasSistema({ db, config, errores }) {
  const r = Router();
  const soloDueno = [requierePermiso('sistema:ver')];
  const exportando = new Set();

  r.get('/estado', ...soloDueno, async (req, res) => {
    if (!req.ctx.usuario.es_dueno_grupo) throw prohibido('Solo el dueño del grupo ve el estado del sistema');
    res.json(await estadoSistema({ db, config, errores }));
  });

  r.get('/errores', ...soloDueno, async (req, res) => {
    if (!req.ctx.usuario.es_dueno_grupo) throw prohibido('Solo el dueño del grupo ve los errores del sistema');
    const q = validar(z.object({ origen: z.enum(['servidor', 'navegador', 'caida', 'aviso']).optional(), limite: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    res.json(await errores.recientes({ origen: q.origen ?? null, limite: q.limite }));
  });

  // Copia exportable de la empresa activa: ZIP con CSV y JSON por tabla. Solo el dueño; queda en la bitácora.
  r.get('/respaldo', ...soloDueno, async (req, res) => {
    if (req.ctx.rol !== 'dueno') throw prohibido('Solo el dueño exporta la copia de la empresa');
    const q = validar(z.object({ con_claves: z.enum(['0', '1']).default('0') }), req.query);
    const emp = req.ctx.empresa;
    if (exportando.has(emp.id)) throw conflicto('Ya hay una copia de esta empresa generándose; espera a que termine');
    exportando.add(emp.id);
    try {
      const { zip, manifiesto } = await exportarEmpresaBuffer(db, emp.id, { conClaves: q.con_claves === '1', version: config.version });
      const filas = manifiesto.tablas.reduce((a, t) => a + t.filas, 0);
      await db.query(
        `insert into core.sistema_estado (clave, valor, updated_at) values ($1, $2::jsonb, now())
         on conflict (clave) do update set valor = excluded.valor, updated_at = now()`,
        [`respaldo:${emp.codigo}`, JSON.stringify({ at: new Date().toISOString(), por: req.ctx.usuario.nombre, tablas: manifiesto.tablas.length, filas, bytes: zip.length, con_claves: q.con_claves === '1' })]);
      await auditar(db, req.ctx, 'respaldo_exportado', 'empresa', emp.id, { tablas: manifiesto.tablas.length, filas, bytes: zip.length, con_claves: q.con_claves === '1' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="respaldo-${emp.codigo}-${fechaHN()}.zip"`);
      res.setHeader('Content-Length', String(zip.length));
      res.end(zip);
    } finally { exportando.delete(emp.id); }
  });

  return r;
}
