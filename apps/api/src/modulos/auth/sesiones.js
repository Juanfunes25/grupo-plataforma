import { Router } from 'express';
import { auditar } from '../../lib/auditoria.js';
import { noEncontrado, uuid, validar } from '../../lib/http.js';

/**
 * Registra en la bitácora un evento de seguridad de una persona. La empresa sale del código dado o del encabezado X-Empresa;
 * así el evento aparece en la bitácora de esa empresa (con empresa vacía no lo vería nadie).
 */
export async function auditarSeguridad(db, ctxMgr, req, usuario, accion, entidad, entidadId, detalle = {}, empresaCodigo = null) {
  const cod = String(empresaCodigo ?? req.headers['x-empresa'] ?? '').toLowerCase();
  const emp = cod ? (await ctxMgr.empresas()).find((e) => e.codigo === cod) : null;
  await auditar(db, null, accion, entidad, entidadId, detalle, {
    empresaId: emp?.id ?? null, usuarioId: usuario.id, usuarioNombre: usuario.nombre, ip: req.ip || req.socket?.remoteAddress || null });
}

/** «Chrome en Windows», «Safari en iPhone»… para que la persona reconozca el equipo en su lista de sesiones. */
export function nombreNavegador(ua = '') {
  const u = String(ua);
  const nav = /Edg\//.test(u) ? 'Edge' : /OPR\/|Opera/.test(u) ? 'Opera' : /Firefox\//.test(u) ? 'Firefox'
    : /CriOS\/|Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : u ? 'Navegador' : 'Desconocido';
  const so = /Windows/.test(u) ? 'Windows' : /Android/.test(u) ? 'Android' : /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad'
    : /Mac OS X|Macintosh/.test(u) ? 'Mac' : /CrOS/.test(u) ? 'Chromebook' : /Linux/.test(u) ? 'Linux' : '';
  return so ? `${nav} en ${so}` : nav;
}

/** Abre la fila de la sesión y devuelve su id (va dentro del token como `sid`). */
export async function crearSesion(db, config, { usuario, via, empresaCodigo, req }) {
  const fila = (await db.query(
    `insert into core.sesiones_activas (usuario_id, via, empresa_codigo, dispositivo, navegador, ip, expira_at)
     values ($1,$2,$3,$4,$5,$6, now() + ($7 || ' hours')::interval) returning id`,
    [usuario.id, via, empresaCodigo ?? null, String(req.headers['x-dispositivo'] ?? '').slice(0, 80) || null,
      nombreNavegador(req.headers['user-agent']), req.ip || req.socket?.remoteAddress || null, String(config.sesionHoras)])).rows[0];
  // Limpieza barata: sesiones vencidas hace más de 30 días.
  db.query(`delete from core.sesiones_activas where expira_at < now() - interval '30 days'`).catch(() => {});
  return fila.id;
}

/** Revoca una o varias sesiones de un usuario (todas menos `excepto`). Devuelve cuántas cerró. */
export async function revocarSesiones(db, ctxMgr, usuarioId, { id = null, excepto = null, motivo }) {
  const { rows } = await db.query(
    `update core.sesiones_activas set revocada_at = now(), revocada_motivo = $4
      where usuario_id = $1 and revocada_at is null and expira_at > now()
        and ($2::uuid is null or id = $2) and ($3::uuid is null or id <> $3)
      returning id`, [usuarioId, id, excepto, motivo]);
  for (const r of rows) ctxMgr.invalidarSesion(r.id);
  return rows.length;
}

/** «Mis sesiones»: dispositivos con sesión abierta y cierre remoto. Se monta en /api/auth (ya con autenticación). */
export function rutasSesiones({ db, ctxMgr }) {
  const r = Router();

  r.get('/sesiones', async (req, res) => {
    const { rows } = await db.query(
      `select id, via, empresa_codigo, navegador, ip, creada_at, ultimo_uso, expira_at, dispositivo
         from core.sesiones_activas where usuario_id = $1 and revocada_at is null and expira_at > now()
        order by ultimo_uso desc limit 50`, [req.auth.usuario.id]);
    res.json(rows.map((s) => ({ ...s, actual: s.id === req.auth.sesionId, dispositivo: undefined, este_equipo: Boolean(s.dispositivo) && s.dispositivo === String(req.headers['x-dispositivo'] ?? '') })));
  });

  r.delete('/sesiones/:id', async (req, res) => {
    const id = validar(uuid, req.params.id);
    const n = await revocarSesiones(db, ctxMgr, req.auth.usuario.id, { id, motivo: 'cerrada por la persona' });
    if (!n) throw noEncontrado('Esa sesión ya no está abierta');
    await auditarSeguridad(db, ctxMgr, req, req.auth.usuario, 'sesion_cerrada', 'sesion', id, { propia: true, actual: id === req.auth.sesionId });
    res.json({ ok: true, cerrada_la_actual: id === req.auth.sesionId });
  });

  r.post('/sesiones/cerrar-otras', async (req, res) => {
    const n = await revocarSesiones(db, ctxMgr, req.auth.usuario.id, { excepto: req.auth.sesionId, motivo: 'cerradas por la persona desde otro equipo' });
    if (n) await auditarSeguridad(db, ctxMgr, req, req.auth.usuario, 'sesiones_cerradas', 'usuario', req.auth.usuario.id, { cantidad: n });
    res.json({ ok: true, cerradas: n });
  });

  // Cerrar sesión de verdad: la del equipo actual deja de valer en el servidor, no solo en el navegador.
  r.post('/salir', async (req, res) => {
    if (req.auth.sesionId) await revocarSesiones(db, ctxMgr, req.auth.usuario.id, { id: req.auth.sesionId, motivo: 'salió' });
    res.json({ ok: true });
  });

  return r;
}
