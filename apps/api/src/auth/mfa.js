import crypto from 'node:crypto';

// ─── TOTP (RFC 6238) con la librería estándar de Node: HMAC-SHA1, 6 dígitos, paso de 30 s ───
// Compatible con Google Authenticator, Microsoft Authenticator, Authy, 1Password, etc.

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PASO_S = 30;

export function base32(buf) {
  let bits = 0, valor = 0, out = '';
  for (const b of buf) {
    valor = (valor << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(valor >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(valor << (5 - bits)) & 31];
  return out;
}
export function desdeBase32(texto) {
  const limpio = String(texto).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, valor = 0; const out = [];
  for (const c of limpio) {
    valor = (valor << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((valor >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const nuevoSecretoTotp = () => base32(crypto.randomBytes(20));   // 160 bits, como pide la RFC

export function codigoTotp(secretoB32, paso) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(paso));
  const h = crypto.createHmac('sha1', desdeBase32(secretoB32)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const n = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

export const pasoActual = (ahoraMs = Date.now()) => Math.floor(ahoraMs / 1000 / PASO_S);

/**
 * Verifica un código admitiendo ±1 paso (reloj del teléfono algo desfasado).
 * Devuelve el paso aceptado o null. `ultimoPaso` impide reutilizar un código ya usado.
 */
export function verificarTotp(secretoB32, codigo, { ahoraMs = Date.now(), ultimoPaso = null, ventana = 1 } = {}) {
  const c = String(codigo ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const p0 = pasoActual(ahoraMs);
  for (let d = -ventana; d <= ventana; d++) {
    const p = p0 + d;
    if (ultimoPaso !== null && p <= Number(ultimoPaso)) continue;
    const esperado = Buffer.from(codigoTotp(secretoB32, p));
    if (crypto.timingSafeEqual(esperado, Buffer.from(c))) return p;
  }
  return null;
}

export const uriOtpauth = ({ secreto, cuenta, emisor = 'Grupo Plataforma' }) =>
  `otpauth://totp/${encodeURIComponent(`${emisor}:${cuenta}`)}?secret=${secreto}&issuer=${encodeURIComponent(emisor)}&algorithm=SHA1&digits=6&period=${PASO_S}`;

// ─── Cifrado del secreto en reposo (AES-256-GCM) ───
// La llave sale de MFA_KEY; si no existe, del APP_JWT_SECRET. Para rotar APP_JWT_SECRET sin perder los 2FA ya
// activados, fija MFA_KEY con el valor ANTERIOR antes de cambiarlo (ver docs/SEGURIDAD.md).
const llave = (config) => crypto.createHash('sha256').update(`mfa-v1:${config.mfaKey || config.jwtSecret}`).digest();

export function cifrarSecreto(config, texto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', llave(config), iv);
  const ct = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}
export function descifrarSecreto(config, guardado) {
  const [v, iv, tag, ct] = String(guardado).split('.');
  if (v !== 'v1') throw new Error('formato de secreto desconocido');
  const d = crypto.createDecipheriv('aes-256-gcm', llave(config), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

// ─── Códigos de recuperación: 10 códigos de un solo uso, formato XXXXX-XXXXX ───
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sin 0/O/1/I para que se lean bien al copiarlos
export function generarCodigosRecuperacion(n = 10) {
  return Array.from({ length: n }, () => {
    const b = crypto.randomBytes(10);
    const s = Array.from(b, (x) => ALFABETO[x % ALFABETO.length]).join('');
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}
export const normalizarCodigoRecuperacion = (t) => {
  const s = String(t ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 10 ? `${s.slice(0, 5)}-${s.slice(5)}` : null;
};
