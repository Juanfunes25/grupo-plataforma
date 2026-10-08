import crypto from 'node:crypto';

// scrypt (en Node, sin dependencias). Formato: scrypt$<salt-hex>$<hash-hex>
const N = 16384, KEYLEN = 32;

export function hashSecreto(secreto) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(secreto), salt, KEYLEN, { N });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verificarSecreto(secreto, guardado) {
  if (!guardado || typeof guardado !== 'string') return false;
  const [tipo, saltHex, hashHex] = guardado.split('$');
  if (tipo !== 'scrypt' || !saltHex || !hashHex) return false;
  const esperado = Buffer.from(hashHex, 'hex');
  const calculado = crypto.scryptSync(String(secreto), Buffer.from(saltHex, 'hex'), esperado.length, { N });
  return crypto.timingSafeEqual(esperado, calculado);
}
