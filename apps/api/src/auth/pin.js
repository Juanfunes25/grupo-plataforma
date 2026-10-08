import crypto from 'node:crypto';

/** HMAC del PIN, atado a la empresa: el mismo PIN en dos empresas da hashes distintos. */
export function hashPin(config, empresaId, pin) {
  return crypto.createHmac('sha256', config.pinPepper).update(`${empresaId}:${pin}`).digest('hex');
}
export const PIN_RE = /^\d{4,8}$/;
