import crypto from 'node:crypto';

/** HMAC del PIN, atado a la empresa: el mismo PIN en dos empresas da hashes distintos. */
export function hashPin(config, empresaId, pin) {
  return crypto.createHmac('sha256', config.pinPepper).update(`${empresaId}:${pin}`).digest('hex');
}
/** Hash con el pepper anterior (rotación en curso) o null si no hay. */
export const hashPinAnterior = (config, empresaId, pin) =>
  config.pinPepperAnterior ? crypto.createHmac('sha256', config.pinPepperAnterior).update(`${empresaId}:${pin}`).digest('hex') : null;
export const PIN_RE = /^\d{4,8}$/;
