// Cliente del módulo Documentos (subida y descarga de archivos). El resto de llamadas usa api.js.
import { MAX_ARCHIVO_BYTES, EXTENSIONES_DOC } from '@grupo/shared';
import { almacen, empresaActual, ErrorApi, qs } from '../api.js';
import { idDispositivo } from '../antifraude/dispositivo.js';

const cabeceras = (empresa) => {
  const s = almacen.leer();
  const h = { 'x-dispositivo': idDispositivo() };
  if (s?.token) h.authorization = `Bearer ${s.token}`;
  const emp = empresa ?? empresaActual();
  if (emp && emp !== 'grupo') h['x-empresa'] = emp;
  return h;
};

async function leerError(r) {
  let d = null;
  try { d = await r.json(); } catch { /* sin cuerpo */ }
  if (r.status === 401) window.dispatchEvent(new Event('grupo:sesion-vencida'));
  return new ErrorApi(d?.error || (r.status === 413 ? 'El archivo supera el máximo de 15 MB' : `Error ${r.status}`), r.status, d?.codigo);
}

/** Revisa en el navegador (el servidor vuelve a revisar el contenido real). Devuelve un texto de error o null. */
export function problemaConArchivo(f) {
  if (!f) return 'Elige un archivo';
  if (f.size === 0) return `«${f.name}» está vacío`;
  if (f.size > MAX_ARCHIVO_BYTES) return `«${f.name}» pesa ${(f.size / 1048576).toFixed(1)} MB; el máximo es 15 MB`;
  const ext = f.name.includes('.') ? f.name.split('.').pop().toLowerCase() : '';
  if (ext && !EXTENSIONES_DOC.includes(ext)) return `«${f.name}»: solo se aceptan PDF, imágenes, Word y Excel`;
  return null;
}

async function enviar(ruta, archivo, params, empresa) {
  const falla = problemaConArchivo(archivo);
  if (falla) throw new ErrorApi(falla, 400, 'archivo');
  let r;
  try {
    r = await fetch(`/api/documentos${ruta}${qs({ ...params, nombre: archivo.name })}`, {
      method: 'POST', headers: { ...cabeceras(empresa), 'content-type': archivo.type || 'application/octet-stream' }, body: archivo,
    });
  } catch { throw new ErrorApi('Sin conexión con el servidor. Revisa tu internet.', 0, 'sin_red'); }
  if (!r.ok) throw await leerError(r);
  return r.json();
}

/** Crea el documento Y sube su primer archivo. params: tipo, titulo, empleado_id, sucursal_id, fecha_vencimiento… */
export const subirNuevo = (archivo, params, empresa) => enviar('/subir', archivo, params, empresa);
/** Sube una versión nueva (la anterior queda en el historial). params opcionales: nota, fecha_vencimiento, fecha_emision, numero. */
export const subirVersion = (id, archivo, params = {}, empresa) => enviar(`/${id}/archivo`, archivo, params, empresa);

/** Baja el archivo (con la sesión) como Blob. */
export async function bajarBlob(id, { version, empresa } = {}) {
  let r;
  try { r = await fetch(`/api/documentos/${id}/archivo${qs({ version, inline: 1 })}`, { headers: cabeceras(empresa) }); }
  catch { throw new ErrorApi('Sin conexión con el servidor. Revisa tu internet.', 0, 'sin_red'); }
  if (!r.ok) throw await leerError(r);
  return { blob: await r.blob(), tipo: r.headers.get('content-type') };
}

/** Descarga al equipo con el nombre original. */
export async function descargar(id, nombre, opciones = {}) {
  const { blob } = await bajarBlob(id, opciones);
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: nombre || 'documento' });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export const esVisible = (mime) => mime === 'application/pdf' || /^image\/(jpeg|png|gif|webp)$/.test(mime ?? '');
export const tamanoLegible = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export const ESTADO_INFO = {
  vigente: { texto: 'Vigente', clase: 'ok' }, por_vencer: { texto: 'Por vencer', clase: 'aviso' },
  vencido: { texto: 'Vencido', clase: 'mal' }, archivado: { texto: 'Archivado', clase: '' },
};
/** «vence en 12 días» / «venció hace 3 días» / «sin vencimiento». */
export function textoVence(d) {
  if (!d.fecha_vencimiento) return 'Sin vencimiento';
  const n = d.dias_restantes;
  if (n === 0) return 'Vence hoy';
  if (n > 0) return `Vence en ${n} día${n === 1 ? '' : 's'}`;
  return `Venció hace ${-n} día${n === -1 ? '' : 's'}`;
}
export const fechaCorta = (f) => (f ? new Date(`${f}T12:00:00`).toLocaleDateString('es-HN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
