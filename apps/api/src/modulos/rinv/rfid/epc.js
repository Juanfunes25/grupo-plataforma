/**
 * El formato de EPC que usa la heladería. Un EPC UHF (EPCglobal C1G2) es un número hexadecimal;
 * acá se usan 96 bits = 24 caracteres hex, armados así:
 *
 *    TT VV RRRR LLLLLLLL SSSS CCCC
 *    │  │  │    │        │    └─ CRC-16 de los 10 bytes anteriores (descarta basura y tags ajenos)
 *    │  │  │    │        └────── secuencia: varias bandejas del mismo lote (1, 2, 3...)
 *    │  │  │    └─────────────── lote: código de la tanda (helado), del lote Mec3 (insumo) o serie (bandeja)
 *    │  │  └──────────────────── referencia: código del sabor (helado) o del insumo; 0 en bandejas
 *
 * En la plataforma los ids son uuid y no caben en el EPC: «código» es el número estable que
 * rinv.rfid_refs le asigna a cada sabor, insumo, tanda o lote (ver rfid.js).
 *    │  └─────────────────────── versión del formato (hoy 01)
 *    └────────────────────────── tipo: A1 helado, B1 insumo, C1 bandeja identificadora
 *
 * El CRC importa en la práctica: en una cocina hay tags de otras cosas (ropa, cajas de proveedores)
 * y el lector los lee igual. Si el CRC no cierra, ese EPC no es nuestro y se ignora.
 */

export const TIPOS = {
  helado: 0xa1,
  insumo: 0xb1,
  bandeja: 0xc1,
};
const TIPO_POR_BYTE = Object.fromEntries(Object.entries(TIPOS).map(([nombre, byte]) => [byte, nombre]));
const VERSION = 0x01;
export const LARGO_EPC_HEX = 24;

const MAX = { referencia: 0xffff, lote: 0xffffffff, secuencia: 0xffff };

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) sobre un arreglo de bytes. */
export function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

const hex = (n, digitos) => n.toString(16).toUpperCase().padStart(digitos, '0');

/** Deja un EPC como lo guarda la base: mayúsculas, sin espacios ni prefijo 0x. Null si no es hex. */
export function normalizarEpc(texto) {
  const limpio = String(texto ?? '').replace(/\s+/g, '').replace(/^0x/i, '').toUpperCase();
  return /^[0-9A-F]{8,}$/.test(limpio) && limpio.length % 2 === 0 ? limpio : null;
}

export function codificarEpc({ tipo, referencia = 0, lote = 0, secuencia = 1 }) {
  if (!(tipo in TIPOS)) throw new Error(`Tipo de tag desconocido: ${tipo}`);
  for (const [nombre, valor] of Object.entries({ referencia, lote, secuencia })) {
    if (!Number.isInteger(valor) || valor < 0 || valor > MAX[nombre]) throw new Error(`${nombre} fuera de rango: ${valor}`);
  }
  const cuerpo = hex(TIPOS[tipo], 2) + hex(VERSION, 2) + hex(referencia, 4) + hex(lote, 8) + hex(secuencia, 4);
  return cuerpo + hex(crc16(bytesDe(cuerpo)), 4);
}

function bytesDe(hexa) {
  return Array.from({ length: hexa.length / 2 }, (_, i) => parseInt(hexa.slice(i * 2, i * 2 + 2), 16));
}

/**
 * Lee un EPC. `propio: false` significa que no es de este sistema (largo, versión, tipo o CRC
 * no cierran) y nadie debería actuar sobre él.
 */
export function decodificarEpc(texto) {
  const epc = normalizarEpc(texto);
  if (!epc) return { propio: false, motivo: 'no es hexadecimal' };
  if (epc.length !== LARGO_EPC_HEX) return { propio: false, epc, motivo: `largo ${epc.length}, se esperaba ${LARGO_EPC_HEX}` };
  const bytes = bytesDe(epc);
  const tipo = TIPO_POR_BYTE[bytes[0]];
  if (!tipo) return { propio: false, epc, motivo: 'tipo desconocido' };
  if (bytes[1] !== VERSION) return { propio: false, epc, motivo: 'versión desconocida' };
  const crcLeido = (bytes[10] << 8) | bytes[11];
  if (crc16(bytes.slice(0, 10)) !== crcLeido) return { propio: false, epc, motivo: 'CRC no coincide' };
  return {
    propio: true,
    epc,
    tipo,
    referencia: (bytes[2] << 8) | bytes[3],
    lote: ((bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]) >>> 0,
    secuencia: (bytes[8] << 8) | bytes[9],
  };
}

/** Los primeros 16 caracteres (tipo, versión, referencia, lote): lo que comparten las bandejas de un mismo lote. */
export const prefijoDeLote = ({ tipo, referencia = 0, lote = 0 }) => codificarEpc({ tipo, referencia, lote, secuencia: 0 }).slice(0, 16);
