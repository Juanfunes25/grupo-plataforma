import { Router } from 'express';
import { z } from 'zod';
import { hashSecreto, verificarSecreto } from '../../auth/passwords.js';
import { cifrarSecreto, descifrarSecreto, generarCodigosRecuperacion, nuevoSecretoTotp, normalizarCodigoRecuperacion, uriOtpauth, verificarTotp } from '../../auth/mfa.js';
import { verificarDesafio } from '../../auth/tokens.js';
import { auditar } from '../../lib/auditoria.js';
import { ErrorHttp, malaPeticion, noAutenticado, prohibido, validar } from '../../lib/http.js';

const ROLES_DIRECCION_2FA = ['dueno', 'admin'];

/** ¿Esta persona es «de dirección» (dueño del grupo o dueño/administrador en alguna empresa)? */
export async function esDireccion(db, u) {
  if (u.es_dueno_grupo) return true;
  const r = await db.query(`select 1 from core.accesos where usuario_id = $1 and activo and rol = any($2::text[]) limit 1`, [u.id, ROLES_DIRECCION_2FA]);
  return r.rowCount > 0;
}

/** Estado del 2FA de una persona: { confirmado, pendiente }. */
export async function estadoMfa(db, usuarioId) {
  const m = (await db.query('select confirmado from core.usuarios_mfa where usuario_id = $1', [usuarioId])).rows[0];
  return { confirmado: Boolean(m?.confirmado), pendiente: Boolean(m && !m.confirmado) };
}

async function codigosRestantes(db, usuarioId) {
  return (await db.query('select count(*)::int as n from core.mfa_recuperacion where usuario_id = $1 and usado_at is null', [usuarioId])).rows[0].n;
}

/**
 * Comprueba un código del segundo paso: el de 6 dígitos de la app, o uno de recuperación (un solo uso).
 * Devuelve 'totp' | 'recuperacion' | null. Lleva la cuenta de intentos fallidos con el limitador.
 */
export async function comprobarSegundoPaso(db, config, usuarioId, codigo, { permitirRecuperacion = true } = {}) {
  const m = (await db.query('select secreto_cifrado, ultimo_paso, confirmado from core.usuarios_mfa where usuario_id = $1', [usuarioId])).rows[0];
  if (!m?.confirmado) return null;
  const paso = verificarTotp(descifrarSecreto(config, m.secreto_cifrado), codigo, { ultimoPaso: m.ultimo_paso });
  if (paso !== null) {
    // Condicional: dos peticiones simultáneas con el mismo código no pasan las dos.
    const r = await db.query('update core.usuarios_mfa set ultimo_paso = $2 where usuario_id = $1 and (ultimo_paso is null or ultimo_paso < $2)', [usuarioId, paso]);
    return r.rowCount ? 'totp' : null;
  }
  if (!permitirRecuperacion) return null;
  const rec = normalizarCodigoRecuperacion(codigo);
  if (!rec) return null;
  const { rows } = await db.query('select id, codigo_hash from core.mfa_recuperacion where usuario_id = $1 and usado_at is null', [usuarioId]);
  for (const f of rows) {
    if (verificarSecreto(rec, f.codigo_hash)) {
      const r = await db.query('update core.mfa_recuperacion set usado_at = now() where id = $1 and usado_at is null', [f.id]);
      return r.rowCount ? 'recuperacion' : null;
    }
  }
  return null;
}

async function guardarCodigosNuevos(q, usuarioId) {
  const codigos = generarCodigosRecuperacion(10);
  await q.query('delete from core.mfa_recuperacion where usuario_id = $1', [usuarioId]);
  for (const c of codigos) await q.query('insert into core.mfa_recuperacion (usuario_id, codigo_hash) values ($1,$2)', [usuarioId, hashSecreto(c)]);
  return codigos;
}

async function prepararSecreto(db, config, u) {
  const secreto = nuevoSecretoTotp();
  await db.query(
    `insert into core.usuarios_mfa (usuario_id, secreto_cifrado, confirmado) values ($1,$2,false)
     on conflict (usuario_id) do update set secreto_cifrado = excluded.secreto_cifrado, confirmado = false, confirmado_at = null, ultimo_paso = null
      where core.usuarios_mfa.confirmado = false`, [u.id, cifrarSecreto(config, secreto)]);
  const fila = (await db.query('select secreto_cifrado, confirmado from core.usuarios_mfa where usuario_id = $1', [u.id])).rows[0];
  if (fila.confirmado) throw malaPeticion('Ya tienes la verificación en dos pasos activa');
  return { secreto, uri: uriOtpauth({ secreto, cuenta: u.email ?? u.nombre }) };
}

async function confirmar(db, config, u, codigo) {
  const m = (await db.query('select secreto_cifrado, confirmado from core.usuarios_mfa where usuario_id = $1', [u.id])).rows[0];
  if (!m || m.confirmado) throw malaPeticion('Primero genera el código QR para configurar la verificación');
  const paso = verificarTotp(descifrarSecreto(config, m.secreto_cifrado), codigo);
  if (paso === null) throw new ErrorHttp(400, 'Ese código no es correcto. Revisa la hora de tu teléfono y vuelve a intentar.', 'codigo_incorrecto');
  return db.tx(async (q) => {
    await q.query('update core.usuarios_mfa set confirmado = true, confirmado_at = now(), ultimo_paso = $2 where usuario_id = $1', [u.id, paso]);
    return guardarCodigosNuevos(q, u.id);
  });
}

/**
 * Rutas de la verificación en dos pasos.
 *  Públicas (llevan el desafío del login): POST /login-2fa · /2fa/configurar · /2fa/configurar-confirmar
 *  Con sesión: GET /2fa/estado · POST /2fa/iniciar · /2fa/activar · /2fa/desactivar · /2fa/codigos-nuevos
 */
export function rutasMfa({ db, config, ctxMgr, limitadorMfa, emitirSesion }) {
  const publicas = Router();
  const privadas = Router();
  const ipDe = (req) => req.ip || req.socket?.remoteAddress || '';

  async function desafio(req) {
    const { desafio: token } = validar(z.object({ desafio: z.string().min(10).max(2000) }).passthrough(), req.body);
    let d;
    try { d = await verificarDesafio(config, token); } catch { throw noAutenticado('El paso de verificación venció; vuelve a escribir tu contraseña'); }
    const u = await ctxMgr.usuario(d.usuarioId);
    if (!u || !u.activo) throw noAutenticado();
    return { u, d };
  }
  const limitar = (u) => { if (limitadorMfa.bloqueado(u.id)) throw new ErrorHttp(429, 'Demasiados intentos. Espera unos minutos.'); };

  // Segundo paso del login (ya tiene 2FA).
  publicas.post('/login-2fa', async (req, res) => {
    const { codigo } = validar(z.object({ codigo: z.string().trim().min(6).max(20) }).passthrough(), req.body);
    const { u, d } = await desafio(req);
    if (d.fase !== 'verificar') throw malaPeticion('Este paso no corresponde');
    limitar(u);
    const via = await comprobarSegundoPaso(db, config, u.id, codigo);
    if (!via) {
      limitadorMfa.fallo(u.id);
      await auditar(db, null, 'login_2fa_fallido', 'usuario', u.id, {}, { usuarioId: u.id, usuarioNombre: u.nombre, ip: ipDe(req) });
      throw new ErrorHttp(401, 'Código incorrecto', 'codigo_incorrecto');
    }
    limitadorMfa.exito(u.id);
    if (via === 'recuperacion') await auditar(db, null, 'mfa_codigo_recuperacion_usado', 'usuario', u.id, { restantes: await codigosRestantes(db, u.id) }, { usuarioId: u.id, usuarioNombre: u.nombre, ip: ipDe(req) });
    const out = await emitirSesion(req, u, d.empresaCodigo, { mfa: true });
    res.json(via === 'recuperacion' ? { ...out, aviso: `Usaste un código de recuperación. Te quedan ${await codigosRestantes(db, u.id)}.` } : out);
  });

  // Configuración obligatoria durante el login (la política la exige y aún no la tiene).
  publicas.post('/2fa/configurar', async (req, res) => {
    const { u, d } = await desafio(req);
    if (d.fase !== 'configurar') throw malaPeticion('Este paso no corresponde');
    limitar(u);
    res.json(await prepararSecreto(db, config, u));
  });
  publicas.post('/2fa/configurar-confirmar', async (req, res) => {
    const { codigo } = validar(z.object({ codigo: z.string().trim().length(6) }).passthrough(), req.body);
    const { u, d } = await desafio(req);
    if (d.fase !== 'configurar') throw malaPeticion('Este paso no corresponde');
    limitar(u);
    let codigos;
    try { codigos = await confirmar(db, config, u, codigo); } catch (e) { if (e.codigo === 'codigo_incorrecto') limitadorMfa.fallo(u.id); throw e; }
    limitadorMfa.exito(u.id);
    await auditar(db, null, 'mfa_activado', 'usuario', u.id, { obligatorio: true }, { usuarioId: u.id, usuarioNombre: u.nombre, ip: ipDe(req) });
    res.json({ ...(await emitirSesion(req, u, d.empresaCodigo, { mfa: true })), codigos_recuperacion: codigos });
  });

  // ── Con sesión ──
  privadas.get('/2fa/estado', async (req, res) => {
    const u = req.auth.usuario;
    const { confirmado } = await estadoMfa(db, u.id);
    const pol = await ctxMgr.politica.obtener();
    const direccion = await esDireccion(db, u);
    res.json({
      disponible: req.auth.via !== 'pin',    // el PIN de mostrador no lleva 2FA
      activo: confirmado,
      obligatoria: Boolean(pol.mfa_obligatoria_direccion && direccion),
      es_direccion: direccion,
      codigos_restantes: confirmado ? await codigosRestantes(db, u.id) : 0,
    });
  });
  const soloCorreo = (req) => { if (req.auth.via === 'pin') throw prohibido('La verificación en dos pasos es para quienes entran con correo y contraseña'); };

  privadas.post('/2fa/iniciar', async (req, res) => {
    soloCorreo(req);
    res.json(await prepararSecreto(db, config, req.auth.usuario));
  });
  privadas.post('/2fa/activar', async (req, res) => {
    soloCorreo(req);
    const { codigo } = validar(z.object({ codigo: z.string().trim().length(6) }), req.body);
    const u = req.auth.usuario;
    limitar(u);
    let codigos;
    try { codigos = await confirmar(db, config, u, codigo); } catch (e) { if (e.codigo === 'codigo_incorrecto') limitadorMfa.fallo(u.id); throw e; }
    limitadorMfa.exito(u.id);
    await auditar(db, null, 'mfa_activado', 'usuario', u.id, { obligatorio: false }, { usuarioId: u.id, usuarioNombre: u.nombre, ip: req.auth.ip });
    ctxMgr.invalidar();
    res.json({ ok: true, codigos_recuperacion: codigos });
  });
  privadas.post('/2fa/codigos-nuevos', async (req, res) => {
    soloCorreo(req);
    const { codigo } = validar(z.object({ codigo: z.string().trim().min(6).max(20) }), req.body);
    const u = req.auth.usuario;
    limitar(u);
    if (!(await comprobarSegundoPaso(db, config, u.id, codigo, { permitirRecuperacion: false }))) { limitadorMfa.fallo(u.id); throw new ErrorHttp(400, 'Código incorrecto', 'codigo_incorrecto'); }
    limitadorMfa.exito(u.id);
    const codigos = await db.tx((q) => guardarCodigosNuevos(q, u.id));
    await auditar(db, null, 'mfa_codigos_regenerados', 'usuario', u.id, {}, { usuarioId: u.id, usuarioNombre: u.nombre, ip: req.auth.ip });
    res.json({ ok: true, codigos_recuperacion: codigos });
  });
  privadas.post('/2fa/desactivar', async (req, res) => {
    soloCorreo(req);
    const { password, codigo } = validar(z.object({ password: z.string().min(1).max(200), codigo: z.string().trim().min(6).max(20) }), req.body);
    const u = req.auth.usuario;
    limitar(u);
    const pol = await ctxMgr.politica.obtener();
    if (pol.mfa_obligatoria_direccion && await esDireccion(db, u)) throw prohibido('La verificación en dos pasos es obligatoria para tu cargo; no se puede desactivar');
    const fila = (await db.query('select password_hash, auth_user_id from core.usuarios where id = $1', [u.id])).rows[0];
    const claveOk = (config.supabaseUrl && fila.auth_user_id) ? true : verificarSecreto(password, fila.password_hash);
    if (!claveOk || !(await comprobarSegundoPaso(db, config, u.id, codigo))) { limitadorMfa.fallo(u.id); throw new ErrorHttp(400, 'La contraseña o el código no son correctos', 'codigo_incorrecto'); }
    limitadorMfa.exito(u.id);
    await db.tx(async (q) => {
      await q.query('delete from core.usuarios_mfa where usuario_id = $1', [u.id]);
      await q.query('delete from core.mfa_recuperacion where usuario_id = $1', [u.id]);
    });
    await auditar(db, null, 'mfa_desactivado', 'usuario', u.id, {}, { usuarioId: u.id, usuarioNombre: u.nombre, ip: req.auth.ip });
    ctxMgr.invalidar();
    res.json({ ok: true });
  });

  return { publicas, privadas };
}
