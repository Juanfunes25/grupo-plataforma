import { SignJWT, jwtVerify } from 'jose';

const enc = (s) => new TextEncoder().encode(s);

/** Sesión del API: sub = usuario, tv = token_version, emp = empresa fija (login por PIN), sid = fila de core.sesiones_activas. */
export async function firmarSesion(config, { usuarioId, tokenVersion, empresaCodigo, via, sesionId }) {
  const jwt = new SignJWT({ tv: tokenVersion, via, ...(empresaCodigo ? { emp: empresaCodigo } : {}), ...(sesionId ? { sid: sesionId } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(usuarioId)
    .setIssuedAt()
    .setIssuer('grupo-plataforma')
    .setExpirationTime(`${config.sesionHoras}h`);
  return jwt.sign(enc(config.jwtSecret));
}

export async function verificarSesion(config, token) {
  const { payload } = await jwtVerify(token, enc(config.jwtSecret), { issuer: 'grupo-plataforma', algorithms: ['HS256'] });
  // Un desafío de verificación en dos pasos (paso intermedio del login) NUNCA sirve como sesión.
  if (payload.prop || !['password', 'pin'].includes(payload.via)) throw new Error('no es una sesión');
  return { usuarioId: payload.sub, tokenVersion: payload.tv, empresaFija: payload.emp ?? null, via: payload.via, sesionId: payload.sid ?? null };
}

/**
 * Desafío del segundo paso: lo emite el login cuando la contraseña ya fue correcta pero falta el código.
 * Dura 5 minutos y solo sirve en /auth/login-2fa y /auth/2fa/configurar*.
 * fase 'verificar' = ya tiene 2FA; 'configurar' = la política la exige y aún no la tiene.
 */
export async function firmarDesafio(config, { usuarioId, empresaCodigo, fase }) {
  return new SignJWT({ prop: 'mfa', fase, emp: empresaCodigo })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(usuarioId)
    .setIssuedAt()
    .setIssuer('grupo-plataforma')
    .setExpirationTime('5m')
    .sign(enc(config.jwtSecret));
}

export async function verificarDesafio(config, token) {
  const { payload } = await jwtVerify(token, enc(config.jwtSecret), { issuer: 'grupo-plataforma', algorithms: ['HS256'] });
  if (payload.prop !== 'mfa') throw new Error('no es un desafío');
  return { usuarioId: payload.sub, empresaCodigo: payload.emp, fase: payload.fase };
}
