import crypto from 'node:crypto';
import { MAX_ARCHIVO_BYTES } from '@grupo/shared';
import { ErrorHttp, malaPeticion } from '../../lib/http.js';

// Tipo real del archivo por su contenido (firma / magic bytes). La extensión que mande el
// cliente solo se acepta si coincide con lo que el archivo ES: un .exe renombrado a .pdf no entra.
const KINDS = {
  pdf:  { exts: ['pdf'],         mime: 'application/pdf', ver: true },
  jpeg: { exts: ['jpg', 'jpeg'], mime: 'image/jpeg', ver: true },
  png:  { exts: ['png'],         mime: 'image/png', ver: true },
  gif:  { exts: ['gif'],         mime: 'image/gif', ver: true },
  webp: { exts: ['webp'],        mime: 'image/webp', ver: true },
  docx: { exts: ['docx'],        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xlsx: { exts: ['xlsx'],        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  ole:  { exts: ['doc', 'xls'],  mime: null },     // Word/Excel 97-2003 (contenedor OLE): el mime sale de la extensión
};
const MIME_OLE = { doc: 'application/msword', xls: 'application/vnd.ms-excel' };

const empieza = (b, ...bytes) => b.length >= bytes.length && bytes.every((x, i) => b[i] === x);

/** Devuelve 'pdf' | 'jpeg' | … según el contenido, o null si no es un tipo permitido. */
export function detectarTipo(buf) {
  if (buf.length < 8) return null;
  if (buf.subarray(0, 1024).includes('%PDF-')) return 'pdf';
  if (empieza(buf, 0xff, 0xd8, 0xff)) return 'jpeg';
  if (empieza(buf, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (buf.subarray(0, 6).toString('latin1') === 'GIF87a' || buf.subarray(0, 6).toString('latin1') === 'GIF89a') return 'gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (empieza(buf, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return 'ole';
  if (empieza(buf, 0x50, 0x4b, 0x03, 0x04)) {           // ZIP: docx / xlsx llevan estas rutas internas (los nombres van sin comprimir)
    if (buf.includes('word/') && buf.includes('[Content_Types].xml')) return 'docx';
    if (buf.includes('xl/') && buf.includes('[Content_Types].xml')) return 'xlsx';
  }
  return null;
}

/** Nombre seguro para mostrar y para el encabezado de descarga (sin rutas ni caracteres de control). */
export function limpiarNombre(nombre) {
  const base = String(nombre ?? '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>|?*:]/g, '').trim();
  return (base || 'documento').slice(0, 150);
}

/** Valida tamaño + contenido + extensión. Devuelve { nombre, extension, mime, tamano, sha256 }. */
export function validarArchivo(buf, nombreCrudo) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw malaPeticion('No llegó ningún archivo', 'sin_archivo');
  if (buf.length > MAX_ARCHIVO_BYTES) throw new ErrorHttp(413, 'El archivo supera el máximo de 15 MB', 'archivo_grande');
  const nombre = limpiarNombre(nombreCrudo);
  const kind = detectarTipo(buf);
  if (!kind) throw malaPeticion('Tipo de archivo no permitido. Sube PDF, imagen (JPG, PNG, WebP, GIF), Word o Excel.', 'tipo_no_permitido');
  const k = KINDS[kind];
  const punto = nombre.lastIndexOf('.');
  const extNombre = punto > 0 ? nombre.slice(punto + 1).toLowerCase() : '';
  let extension = extNombre;
  let final = nombre;
  if (!extNombre) { extension = k.exts[0]; final = `${nombre}.${extension}`; }      // foto de la cámara sin extensión
  else if (!k.exts.includes(extNombre)) throw malaPeticion(`El contenido del archivo no corresponde a su extensión .${extNombre}`, 'extension_no_coincide');
  return {
    nombre: final, extension, mime: kind === 'ole' ? MIME_OLE[extension] : k.mime, tamano: buf.length, previsualizable: Boolean(k.ver),
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  };
}

export const esPrevisualizable = (mime) => mime === 'application/pdf' || /^image\/(jpeg|png|gif|webp)$/.test(mime);

/** pg devuelve Buffer; PGlite, Uint8Array. */
export const aBuffer = (x) => (Buffer.isBuffer(x) ? x : Buffer.from(x.buffer, x.byteOffset, x.byteLength));
