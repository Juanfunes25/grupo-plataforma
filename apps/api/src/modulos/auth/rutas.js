import { Router } from 'express';
import { z } from 'zod';
import { ROLES_CON_PIN, permisosDe } from '@grupo/shared';
import { hashSecreto, verificarSecreto } from '../../auth/passwords.js';
import { firmarDesafio, firmarSesion } from '../../auth/tokens.js';
import { problemaClave } from '../../auth/politica.js';
import { auditarSeguridad, crearSesion, revocarSesiones, rutasSesiones } from './sesiones.js';
import { esDireccion, estadoMfa, rutasMfa } from './mfa.js';
import { loginSupabase } from '../../auth/supabase.js';
import { hashPin, hashPinAnterior, PIN_RE } from '../../auth/pin.js';
import { crearLimitador } from '../../lib/limitador.js';
import { auditar } from '../../lib/auditoria.js';
import { ErrorHttp, malaPeticion, validar } from '../../lib/http.js';
import { vigilarDispositivo, vigilarLoginFallido } from '../antifraude/vigilancia.js';

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
  const limMfa = crearLimitador({ max: 6, ventanaMs: 10 * 60_000 });   // intentos del código de 6 dígitos, por persona
  r.limitadores = { limLogin, limPin, limMfa };

  const ipDe = (req) => req.ip || req.socket?.remoteAddress || '';

  const EMPRESA_GRUPO = { id: null, codigo: 'grupo', nombre: 'Dirección del Grupo', esGrupo: true };

  async function empresaPorCodigo(codigo) {
    if (String(codigo ?? '').toLowerCase() === 'grupo') return EMPRESA_GRUPO;
    const e = (await ctxMgr.empresas()).find((x) => x.codigo === String(codigo ?? '').toLowerCase());
    if (!e) throw new ErrorHttp(404, 'Empresa no encontrada');
    return e;
  }

  async function respuestaSesion(u, empresa, via, fija, req) {
    const sesionId = await crearSesion(db, config, { usuario: u, via, empresaCodigo: empresa.codigo, req });
    const token = await firmarSesion(config, {
      usuarioId: u.id, tokenVersion: u.token_version, via, empresaCodigo: fija ? empresa.codigo : undefined, sesionId });
    await db.query('update core.usuarios set ultimo_acceso = now() where id = $1', [u.id]);
    return { token, usuario: { id: u.id, nombre: u.nombre, email: u.email, usuario: u.usuario, es_dueno_grupo: u.es_dueno_grupo }, empresa: empresa.codigo };
  }

  // ── Correo + contraseña (dueños, administradores, gerentes) ───────────────
  r.post('/login', async (req, res) => {
    const { empresa: cod, email: ident0, usuario: usr0, password } = validar(z.object({
      empresa: z.string().min(1), email: z.string().trim().toLowerCase().min(1).max(200).optional(), usuario: z.string().trim().toLowerCase().min(1).max(200).optional(),
      password: z.string().min(1).max(200),
    }).refine((b) => b.email || b.usuario, { message: 'Escribe tu usuario o correo' }), req.body);
    const email = ident0 ?? usr0;   // puede ser el correo o el nombre de usuario
    const emp = await empresaPorCodigo(cod);
    const clave = `${ipDe(req)}|${email}`;
    if (limLogin.bloqueado(clave)) throw new ErrorHttp(429, 'Demasiados intentos. Espera unos minutos.');

    const { rows } = await db.query('select * from core.usuarios where (email = $1 or usuario = $1) and activo', [email]);
    const u = rows[0];
    let ok = false;
    if (u) {
      if (config.supabaseUrl && u.auth_user_id && u.email) ok = Boolean(await loginSupabase(config, u.email, password));
      else ok = verificarSecreto(password, u.password_hash);
    } else {
      verificarSecreto(password, 'scrypt$00$00'); // gasta tiempo similar: no revela si el correo existe
    }
    if (!ok) {
      limLogin.fallo(clave);
      await auditar(db, null, 'login_fallido', 'usuario', u?.id ?? null, { email }, { empresaId: emp.id, ip: ipDe(req) });
      await vigilarLoginFallido(db, { empresa: emp, clave: email, ip: ipDe(req), via: 'password' });   // antifraude
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

    // Segundo paso: con 2FA activa la contraseña sola no basta; si la política la exige y aún no la tiene, se configura ahora.
    const mfa = await estadoMfa(db, u.id);
    if (mfa.confirmado) {
      return res.json({ requiere_2fa: true, desafio: await firmarDesafio(config, { usuarioId: u.id, empresaCodigo: emp.codigo, fase: 'verificar' }) });
    }
    if ((await ctxMgr.politica.obtener()).mfa_obligatoria_direccion && await esDireccion(db, u)) {
      return res.json({ requiere_configurar_2fa: true, desafio: await firmarDesafio(config, { usuarioId: u.id, empresaCodigo: emp.codigo, fase: 'configurar' }) });
    }
    res.json(await completarLogin(req, u, emp, { mfa: false }));
  });

  /** Último tramo del login con correo: bitácora, antifraude y la sesión. Lo comparten el login simple y el de dos pasos. */
  async function completarLogin(req, u, emp, { mfa }) {
    await auditar(db, null, 'login', 'usuario', u.id, { via: 'password', ...(mfa ? { mfa: true } : {}) }, { empresaId: emp.id, usuarioId: u.id, usuarioNombre: u.nombre, ip: ipDe(req) });
    await vigilarDispositivo(db, { empresa: emp, usuario: u, dispositivo: req.headers['x-dispositivo'], navegador: req.headers['user-agent'], ip: ipDe(req) });   // antifraude
    return respuestaSesion(u, emp, 'password', false, req);
  }
  const mfaRutas = rutasMfa({
    db, config, ctxMgr, limitadorMfa: limMfa,
    emitirSesion: async (req, u, empresaCodigo, opc) => completarLogin(req, u, await empresaPorCodigo(empresaCodigo), opc),
  });
  r.use(mfaRutas.publicas);

  // ── PIN (mostrador, cocina, bodega): solo sirve en UNA empresa y para UNA persona ───────────
  // Lista pública para la pantalla de entrada: tiendas y nombres de quienes entran con PIN (solo nombre; nunca datos sensibles).
  r.get('/pin/opciones', async (req, res) => {
    const emp = await empresaPorCodigo(validar(z.string().min(1), req.query.empresa));
    if (emp.esGrupo) return res.json({ sucursales: [], usuarios: [] });
    const [suc, usu] = await Promise.all([
      db.query('select id, nombre, color from core.sucursales where empresa_id = $1 and activo order by orden, nombre', [emp.id]),
      db.query(`select u.id, u.nombre, a.rol, a.sucursal_ids from core.accesos a join core.usuarios u on u.id = a.usuario_id
                 where a.empresa_id = $1 and a.activo and u.activo and a.pin_hash is not null and a.rol = any($2::text[]) order by u.nombre`, [emp.id, ROLES_CON_PIN]),
    ]);
    res.json({ sucursales: suc.rows, usuarios: usu.rows });
  });
  r.post('/pin', async (req, res) => {
    const { empresa: cod, usuario_id: usuarioId, sucursal_id: sucursalId, pin } = validar(z.object({
      empresa: z.string().min(1), usuario_id: z.string().uuid('Elige quién eres'), sucursal_id: z.string().uuid().optional(), pin: z.string().regex(PIN_RE, 'El PIN son 4 a 8 dígitos'),
    }), req.body);
    const emp = await empresaPorCodigo(cod);
    if (emp.esGrupo) throw malaPeticion('La dirección del grupo entra con correo y contraseña');
    const clave = `${ipDe(req)}|${emp.codigo}|${usuarioId}`;
    if (limPin.bloqueado(clave) || limPin.bloqueado(`${ipDe(req)}|${emp.codigo}`)) throw new ErrorHttp(429, 'Demasiados intentos. Espera unos minutos.');
    const nuevo = hashPin(config, emp.id, pin);
    const viejo = hashPinAnterior(config, emp.id, pin);
    const { rows } = await db.query(
      `select u.*, a.id as acceso_id, a.pin_hash as pin_guardado, a.sucursal_ids from core.accesos a join core.usuarios u on u.id = a.usuario_id
        where a.empresa_id = $1 and a.usuario_id = $2 and a.pin_hash = any($3::text[]) and a.activo and u.activo and a.rol = any($4::text[])`,
      [emp.id, usuarioId, viejo ? [nuevo, viejo] : [nuevo], ROLES_CON_PIN]);
    const u = rows[0];
    // Rotación del pepper: el PIN entra con el anterior y se re-guarda con el nuevo (nadie tiene que cambiar su PIN).
    if (u && u.pin_guardado !== nuevo) await db.query('update core.accesos set pin_hash = $1 where id = $2', [nuevo, u.acceso_id]).catch(() => {});
    if (!u) {
      limPin.fallo(clave); limPin.fallo(`${ipDe(req)}|${emp.codigo}`);
      await auditar(db, null, 'pin_fallido', 'usuario', usuarioId, {}, { empresaId: emp.id, ip: ipDe(req) });
      await vigilarLoginFallido(db, { empresa: emp, clave: ipDe(req), ip: ipDe(req), via: 'pin' });   // antifraude
      throw new ErrorHttp(401, 'PIN incorrecto');
    }
    // La tienda elegida tiene que ser una de las suyas (sin tiendas asignadas = puede entrar a cualquiera de la empresa).
    if (sucursalId && u.sucursal_ids?.length && !u.sucursal_ids.includes(sucursalId)) throw new ErrorHttp(403, 'Esa persona no trabaja en esa tienda');
    limPin.exito(clave);
    await auditar(db, null, 'login', 'usuario', u.id, { via: 'pin', sucursal_id: sucursalId ?? null }, { empresaId: emp.id, usuarioId: u.id, usuarioNombre: u.nombre, ip: ipDe(req) });
    await vigilarDispositivo(db, { empresa: emp, usuario: u, dispositivo: req.headers['x-dispositivo'], navegador: req.headers['user-agent'], ip: ipDe(req) });   // antifraude
    res.json(await respuestaSesion(u, emp, 'pin', true, req));
  });

  // ── Quién soy y qué puedo hacer ──────────────────────────────────────────
  r.get('/yo', ctxMgr.autenticar, async (req, res) => {
    const u = req.auth.usuario;
    let empresas = await ctxMgr.empresasDe(u);
    if (req.auth.empresaFija) empresas = empresas.filter((e) => e.codigo === req.auth.empresaFija);
    const salida = {
      usuario: { id: u.id, nombre: u.nombre, email: u.email, usuario: u.usuario, es_dueno_grupo: u.es_dueno_grupo, mfa_activo: Boolean(u.mfa_activo) },
      via: req.auth.via,
      empresas: empresas.map((e) => ({ codigo: e.codigo, nombre: e.nombre, color: e.color, logo: e.logo, lema: e.lema, rol: e.rol })),
    };
    if (req.headers['x-empresa']) {
      await ctxMgr.conEmpresa(req, res, () => {});
      const c = req.ctx;
      const suc = (await db.query('select id, nombre, alias, tipo, color from core.sucursales where empresa_id = $1 and activo order by orden, nombre', [c.empresa.id])).rows;
      const cfgPos = (await db.query(`select valor from core.config where empresa_id = $1 and clave = 'pos'`, [c.empresa.id])).rows[0]?.valor ?? {};
      salida.contexto = {
        usar_notas_credito: cfgPos.usar_notas_credito === true,   // el negocio hoy no las usa: la interfaz las oculta
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
    const motivo = problemaClave(nueva, { email: u.email, nombre: u.nombre });
    if (motivo) throw malaPeticion(motivo);
    if (actual === nueva) throw malaPeticion('La nueva contraseña debe ser distinta a la actual');
    await db.query('update core.usuarios set password_hash = $1, token_version = token_version + 1 where id = $2', [hashSecreto(nueva), u.id]);
    await revocarSesiones(db, ctxMgr, u.id, { motivo: 'cambio de contraseña' });
    await auditarSeguridad(db, ctxMgr, req, u, 'password_cambiada', 'usuario', u.id);
    ctxMgr.invalidar();
    res.json({ ok: true, mensaje: 'Contraseña cambiada. Vuelve a entrar.' });
  });

  // Sesiones («Mis sesiones», cerrar sesión de verdad) y gestión propia del 2FA: requieren sesión.
  r.use(ctxMgr.autenticar, rutasSesiones({ db, ctxMgr }), mfaRutas.privadas);

  return r;
}
