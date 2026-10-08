import { Router } from 'express';
import { z } from 'zod';
import { ROLES_CON_PIN, permisosDe } from '@grupo/shared';
import { hashSecreto, verificarSecreto } from '../../auth/passwords.js';
import { firmarSesion } from '../../auth/tokens.js';
import { loginSupabase } from '../../auth/supabase.js';
import { hashPin, PIN_RE } from '../../auth/pin.js';
import { crearLimitador } from '../../lib/limitador.js';
import { auditar } from '../../lib/auditoria.js';
import { ErrorHttp, malaPeticion, validar } from '../../lib/http.js';

const FALLA_CRED = 'Correo o contraseña incorrectos';

export function rutasPublicas({ db, ctxMgr }) {
  const r = Router();
  // Pantalla de selección de empresa: solo datos de marca, nada sensible.
  r.get('/empresas', async (_req, res) => {
    const lista = await ctxMgr.empresas();
    res.json([
      ...lista.map((e) => ({ codigo: e.codigo, nombre: e.nombre, color: e.color, logo: e.logo, lema: e.lema, tipo_negocio: e.tipo_negocio })),
      // Entrada de dirección: consolidado de todas las empresas (exige grupo:ver).
      { codigo: 'grupo', nombre: 'Dirección del Grupo', color: '#c9a227', logo: 'grupo', lema: 'Consolidado de todas las empresas', tipo_negocio: 'holding' },
    ]);
  });
  return r;
}

export function rutasAuth({ db, config, ctxMgr }) {
  const r = Router();
  const limLogin = crearLimitador({ max: 6, ventanaMs: 10 * 60_000 });
  const limPin = crearLimitador({ max: 8, ventanaMs: 10 * 60_000 });
  r.limitadores = { limLogin, limPin };

  const ipDe = (req) => req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.socket?.remoteAddress || '';

  const EMPRESA_GRUPO = { id: null, codigo: 'grupo', nombre: 'Dirección del Grupo', esGrupo: true };

  async function empresaPorCodigo(codigo) {
    if (String(codigo ?? '').toLowerCase() === 'grupo') return EMPRESA_GRUPO;
    const e = (await ctxMgr.empresas()).find((x) => x.codigo === String(codigo ?? '').toLowerCase());
    if (!e) throw new ErrorHttp(404, 'Empresa no encontrada');
    return e;
  }

  async function respuestaSesion(u, empresa, via, fija) {
    const token = await firmarSesion(config, {
      usuarioId: u.id, tokenVersion: u.token_version, via, empresaCodigo: fija ? empresa.codigo : undefined });
    await db.query('update core.usuarios set ultimo_acceso = now() where id = $1', [u.id]);
    return { token, usuario: { id: u.id, nombre: u.nombre, email: u.email, es_dueno_grupo: u.es_dueno_grupo }, empresa: empresa.codigo };
  }

  // ── Correo + contraseña (dueños, administradores, gerentes) ───────────────
  r.post('/login', async (req, res) => {
    const { empresa: cod, email, password } = validar(z.object({
      empresa: z.string().min(1), email: z.string().trim().toLowerCase().email('correo inválido'), password: z.string().min(1).max(200),
    }), req.body);
    const emp = await empresaPorCodigo(cod);
    const clave = `${ipDe(req)}|${email}`;
    if (limLogin.bloqueado(clave)) throw new ErrorHttp(429, 'Demasiados intentos. Espera unos minutos.');

    const { rows } = await db.query('select * from core.usuarios where email = $1 and activo', [email]);
    const u = rows[0];
    let ok = false;
    if (u) {
      if (config.supabaseUrl && u.auth_user_id) ok = Boolean(await loginSupabase(config, email, password));
      else ok = verificarSecreto(password, u.password_hash);
    } else {
      verificarSecreto(password, 'scrypt$00$00'); // gasta tiempo similar: no revela si el correo existe
    }
    if (!ok) {
      limLogin.fallo(clave);
      await auditar(db, null, 'login_fallido', 'usuario', u?.id ?? null, { email }, { empresaId: emp.id, ip: ipDe(req) });
      throw new ErrorHttp(401, FALLA_CRED);
    }
    if (emp.esGrupo) {
      // La entrada de dirección la usa el dueño del grupo o quien tenga grupo:ver en alguna empresa.
      const ac = (await db.query('select rol, permisos_extra, permisos_quitados from core.accesos where usuario_id = $1 and activo', [u.id])).rows;
      if (!u.es_dueno_grupo && !ac.some((a) => permisosDe(a.rol, a.permisos_extra, a.permisos_quitados).has('grupo:ver'))) {
        throw new ErrorHttp(403, 'Tu usuario no tiene acceso a la dirección del grupo');
      }
    } else if (!u.es_dueno_grupo) {
      const a = await db.query('select 1 from core.accesos where usuario_id = $1 and empresa_id = $2 and activo', [u.id, emp.id]);
      if (!a.rowCount) throw new ErrorHttp(403, `Tu usuario no tiene acceso a ${emp.nombre}`);
    }
    limLogin.exito(clave);
    await auditar(db, null, 'login', 'usuario', u.id, { via: 'password' }, { empresaId: emp.id, usuarioId: u.id, usuarioNombre: u.nombre, ip: ipDe(req) });
    res.json(await respuestaSesion(u, emp, 'password', false));
  });

  // ── PIN (mostrador, cocina, bodega): solo sirve en UNA empresa ───────────
  r.post('/pin', async (req, res) => {
    const { empresa: cod, pin } = validar(z.object({ empresa: z.string().min(1), pin: z.string().regex(PIN_RE, 'El PIN son 4 a 8 dígitos') }), req.body);
    const emp = await empresaPorCodigo(cod);
    if (emp.esGrupo) throw malaPeticion('La dirección del grupo entra con correo y contraseña');
    const clave = `${ipDe(req)}|${emp.codigo}`;
    if (limPin.bloqueado(clave)) throw new ErrorHttp(429, 'Demasiados intentos. Espera unos minutos.');
    const { rows } = await db.query(
      `select u.* from core.accesos a join core.usuarios u on u.id = a.usuario_id
        where a.empresa_id = $1 and a.pin_hash = $2 and a.activo and u.activo and a.rol = any($3::text[])`,
      [emp.id, hashPin(config, emp.id, pin), ROLES_CON_PIN]);
    const u = rows[0];
    if (!u) {
      limPin.fallo(clave);
      await auditar(db, null, 'pin_fallido', 'usuario', null, {}, { empresaId: emp.id, ip: ipDe(req) });
      throw new ErrorHttp(401, 'PIN incorrecto');
    }
    limPin.exito(clave);
    await auditar(db, null, 'login', 'usuario', u.id, { via: 'pin' }, { empresaId: emp.id, usuarioId: u.id, usuarioNombre: u.nombre, ip: ipDe(req) });
    res.json(await respuestaSesion(u, emp, 'pin', true));
  });

  // ── Quién soy y qué puedo hacer ──────────────────────────────────────────
  r.get('/yo', ctxMgr.autenticar, async (req, res) => {
    const u = req.auth.usuario;
    let empresas = await ctxMgr.empresasDe(u);
    if (req.auth.empresaFija) empresas = empresas.filter((e) => e.codigo === req.auth.empresaFija);
    const salida = {
      usuario: { id: u.id, nombre: u.nombre, email: u.email, es_dueno_grupo: u.es_dueno_grupo },
      via: req.auth.via,
      empresas: empresas.map((e) => ({ codigo: e.codigo, nombre: e.nombre, color: e.color, logo: e.logo, lema: e.lema, rol: e.rol })),
    };
    if (req.headers['x-empresa']) {
      await ctxMgr.conEmpresa(req, res, () => {});
      const c = req.ctx;
      const suc = (await db.query('select id, nombre, alias, tipo, color from core.sucursales where empresa_id = $1 and activo order by orden, nombre', [c.empresa.id])).rows;
      salida.contexto = {
        empresa: { codigo: c.empresa.codigo, nombre: c.empresa.nombre, razon_social: c.empresa.razon_social, color: c.empresa.color, logo: c.empresa.logo, tipo_negocio: c.empresa.tipo_negocio, isv_tasa: c.empresa.isv_tasa },
        rol: c.rol,
        permisos: [...c.permisos],
        modulos: c.modulos,
        sucursales: c.sucursalIds.length ? suc.filter((s) => c.sucursalIds.includes(s.id)) : suc,
      };
    }
    res.json(salida);
  });

  r.post('/cambiar-password', ctxMgr.autenticar, async (req, res) => {
    const { actual, nueva } = validar(z.object({ actual: z.string().min(1), nueva: z.string().min(8, 'Mínimo 8 caracteres').max(200) }), req.body);
    const u = (await db.query('select * from core.usuarios where id = $1', [req.auth.usuario.id])).rows[0];
    if (config.supabaseUrl && u.auth_user_id) throw malaPeticion('Tu contraseña se cambia desde Supabase Auth');
    if (!verificarSecreto(actual, u.password_hash)) throw new ErrorHttp(401, 'La contraseña actual no es correcta');
    await db.query('update core.usuarios set password_hash = $1, token_version = token_version + 1 where id = $2', [hashSecreto(nueva), u.id]);
    ctxMgr.invalidar();
    res.json({ ok: true, mensaje: 'Contraseña cambiada. Vuelve a entrar.' });
  });

  return r;
}
