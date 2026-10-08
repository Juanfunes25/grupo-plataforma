import { SignJWT, jwtVerify } from 'jose';

const enc = (s) => new TextEncoder().encode(s);

/** Sesión del API: sub = usuario, tv = token_version, emp = empresa fija (login por PIN). */
export async function firmarSesion(config, { usuarioId, tokenVersion, empresaCodigo, via }) {
  const jwt = new SignJWT({ tv: tokenVersion, via, ...(empresaCodigo ? { emp: empresaCodigo } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(usuarioId)
    .setIssuedAt()
    .setIssuer('grupo-plataforma')
    .setExpirationTime(`${config.sesionHoras}h`);
  return jwt.sign(enc(config.jwtSecret));
}

export async function verificarSesion(config, token) {
  const { payload } = await jwtVerify(token, enc(config.jwtSecret), { issuer: 'grupo-plataforma', algorithms: ['HS256'] });
  return { usuarioId: payload.sub, tokenVersion: payload.tv, empresaFija: payload.emp ?? null, via: payload.via };
}
