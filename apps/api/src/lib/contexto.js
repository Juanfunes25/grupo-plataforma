import { permisosDe, modulosVisibles } from '@grupo/shared';
import { verificarSesion } from '../auth/tokens.js';
import { crearPolitica } from '../auth/politica.js';
import { ErrorHttp, malaPeticion, noAutenticado, prohibido } from './http.js';

const TTL = 15_000;
const VACIO = Object.freeze([]);   // mismo arreglo siempre: permite reconocer que el acceso no cambió

/**
 * Autenticación + contexto de empresa. Cada petición de negocio lleva
 *   Authorization: Bearer <sesión>   y   X-Empresa: <codigo>
 * y aquí se resuelve QUIÉN es, EN QUÉ empresa actúa, con QUÉ rol/permisos y
 * sobre CUÁLES sucursales. Todo módulo se apoya en req.ctx; ninguno confía en
 * datos de empresa que mande el cliente en el cuerpo.
 */
export function crearContexto({ db, config }) {
  const cacheUsuarios = new Map();
  let cacheEmpresas = { ts: 0, lista: [] };
  const cacheAccesos = new Map();
  const cacheSesiones = new Map();    // sesiones abiertas (core.sesiones_activas): se consulta si fue cerrada a distancia
  const cachePermisos = new Map();    // permisos y módulos ya calculados por (usuario, empresa)
  const politica = crearPolitica(db);   // política de seguridad vigente (2FA obligatoria, largo del PIN)
  const ultimoToque = new Map();      // sesión → última vez que se anotó su actividad (como máximo una vez por minuto)

  const invalidar = () => { cacheUsuarios.clear(); cacheAccesos.clear(); cachePermisos.clear(); cacheEmpresas = { ts: 0, lista: [] }; };
  /** Cierre remoto: la sesión deja de valer en esta misma petición, sin esperar al caché. */
  const invalidarSesion = (sid) => { if (sid) cacheSesiones.delete(sid); else cacheSesiones.clear(); };

  async function empresas() {
    if (Date.now() - cacheEmpresas.ts > TTL * 4) {
      const { rows } = await db.query('select * from core.empresas where activo order by orden');
      const mods = await db.query('select empresa_id, modulo from core.empresa_modulos where activo');
      cacheEmpresas = {
        ts: Date.now(),
        lista: rows.map((e) => ({ ...e, modulos: mods.rows.filter((m) => m.empresa_id === e.id).map((m) => m.modulo) })),
      };
    }
    return cacheEmpresas.lista;
  }

  async function usuario(id) {
    const c = cacheUsuarios.get(id);
    if (c && Date.now() - c.ts < TTL) return c.u;
    const { rows } = await db.query(
      `select u.id, u.email, u.nombre, u.es_dueno_grupo, u.token_version, u.activo,
              exists (select 1 from core.usuarios_mfa m where m.usuario_id = u.id and m.confirmado) as mfa_activo
         from core.usuarios u where u.id = $1`, [id]);
    const u = rows[0] ?? null;
    cacheUsuarios.set(id, { ts: Date.now(), u });
    return u;
  }

  async function acceso(usuarioId, empresaId) {
    const k = `${usuarioId}:${empresaId}`;
    const c = cacheAccesos.get(k);
    if (c && Date.now() - c.ts < TTL) return c.a;
    const { rows } = await db.query(
      'select rol, sucursal_ids, permisos_extra, permisos_quitados from core.accesos where usuario_id = $1 and empresa_id = $2 and activo',
      [usuarioId, empresaId]);
    const a = rows[0] ?? null;
    cacheAccesos.set(k, { ts: Date.now(), a });
    return a;
  }

  async function sesion(sid) {
    const c = cacheSesiones.get(sid);
    if (c && Date.now() - c.ts < 5_000) return c.s;
    const s = (await db.query('select revocada_at, expira_at from core.sesiones_activas where id = $1', [sid])).rows[0] ?? null;
    cacheSesiones.set(sid, { ts: Date.now(), s });
    return s;
  }
  function tocarSesion(sid, ip) {
    const ahora = Date.now();
    if (ahora - (ultimoToque.get(sid) ?? 0) < 60_000) return;
    ultimoToque.set(sid, ahora);
    if (ultimoToque.size > 5000) ultimoToque.clear();
    db.query('update core.sesiones_activas set ultimo_uso = now(), ip = coalesce($2, ip) where id = $1', [sid, ip || null]).catch(() => {});
  }

  /** Empresas a las que el usuario puede entrar, con su rol en cada una. */
  async function empresasDe(u) {
    const todas = await empresas();
    if (u.es_dueno_grupo) return todas.map((e) => ({ ...e, rol: 'dueno' }));
    const { rows } = await db.query('select empresa_id, rol from core.accesos where usuario_id = $1 and activo', [u.id]);
    return todas.filter((e) => rows.some((r) => r.empresa_id === e.id)).map((e) => ({ ...e, rol: rows.find((r) => r.empresa_id === e.id).rol }));
  }

  // req.ip respeta `trust proxy`: no se puede falsear con un X-Forwarded-For puesto por el cliente.
  const ipDe = (req) => req.ip || req.socket?.remoteAddress || '';

  /** Middleware: exige sesión válida → req.auth */
  async function autenticar(req, _res, next) {
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Bearer ')) throw noAutenticado('Falta iniciar sesión');
    let s;
    try { s = await verificarSesion(config, h.slice(7)); } catch { throw noAutenticado('Tu sesión venció; entra de nuevo'); }
    const u = await usuario(s.usuarioId);
    if (!u || !u.activo || u.token_version !== s.tokenVersion) throw noAutenticado('Tu sesión ya no es válida; entra de nuevo');
    if (s.sesionId) {
      const ses = await sesion(s.sesionId);
      if (!ses || ses.revocada_at) throw noAutenticado('Esta sesión fue cerrada; entra de nuevo');
      tocarSesion(s.sesionId, ipDe(req));
    }
    req.auth = { usuario: u, empresaFija: s.empresaFija, via: s.via, ip: ipDe(req), sesionId: s.sesionId };
    next();
  }

  /** Middleware: exige empresa activa (X-Empresa) y arma req.ctx */
  async function conEmpresa(req, _res, next) {
    const codigo = String(req.headers['x-empresa'] ?? req.auth.empresaFija ?? '').toLowerCase();
    if (!codigo) throw malaPeticion('Falta indicar la empresa (X-Empresa)');
    if (req.auth.empresaFija && req.auth.empresaFija !== codigo) throw prohibido('Tu acceso por PIN es solo para una empresa');
    const emp = (await empresas()).find((e) => e.codigo === codigo);
    if (!emp) throw new ErrorHttp(404, 'Empresa no encontrada');
    const u = req.auth.usuario;
    let rol, extra = VACIO, quitados = VACIO, sucursalIds = VACIO;
    if (u.es_dueno_grupo) {
      rol = 'dueno';
    } else {
      const a = await acceso(u.id, emp.id);
      if (!a) throw prohibido(`No tienes acceso a ${emp.nombre}`);
      ({ rol, permisos_extra: extra, permisos_quitados: quitados, sucursal_ids: sucursalIds } = a);
    }
    // Permisos y módulos se calculan una vez por (usuario, empresa) mientras no cambie el acceso ni la empresa.
    const kp = `${u.id}:${emp.id}`;
    let calc = cachePermisos.get(kp);
    if (!calc || calc.emp !== emp || calc.rol !== rol || calc.extra !== extra || calc.quitados !== quitados) {
      const permisos = permisosDe(rol, extra, quitados);
      calc = { emp, rol, extra, quitados, permisos, modulos: modulosVisibles(emp.modulos, permisos) };
      if (cachePermisos.size > 2000) cachePermisos.clear();
      cachePermisos.set(kp, calc);
    }
    req.ctx = {
      usuario: u, empresa: emp, rol, permisos: calc.permisos, sucursalIds,
      modulos: calc.modulos,
      ip: req.auth.ip, via: req.auth.via, sesionId: req.auth.sesionId,
    };
    next();
  }

  return { autenticar, conEmpresa, invalidar, invalidarSesion, empresas, empresasDe, usuario, politica };
}

/** Exige un permiso en la empresa activa. */
export const requierePermiso = (...ps) => (req, _res, next) => {
  if (!ps.some((p) => req.ctx.permisos.has(p))) throw prohibido();
  next();
};

/**
 * Resuelve la sucursal sobre la que se opera, validando que pertenezca a la
 * empresa activa y que el usuario pueda usarla. Sin id: usa la única posible.
 */
export async function resolverSucursal(q, ctx, sucursalId) {
  const { rows } = await q.query('select * from core.sucursales where empresa_id = $1 and activo order by orden, nombre', [ctx.empresa.id]);
  const permitidas = ctx.sucursalIds.length ? rows.filter((s) => ctx.sucursalIds.includes(s.id)) : rows;
  if (sucursalId) {
    const s = permitidas.find((x) => x.id === sucursalId);
    if (!s) throw prohibido('Esa sucursal no existe o no tienes acceso a ella');
    return s;
  }
  if (permitidas.length === 1) return permitidas[0];
  throw malaPeticion('Elige la sucursal');
}

/** Ids de sucursal que el usuario puede ver en la empresa activa. */
export async function sucursalesPermitidas(q, ctx) {
  const { rows } = await q.query('select id, nombre, alias, tipo, color from core.sucursales where empresa_id = $1 and activo order by orden, nombre', [ctx.empresa.id]);
  return ctx.sucursalIds.length ? rows.filter((s) => ctx.sucursalIds.includes(s.id)) : rows;
}
