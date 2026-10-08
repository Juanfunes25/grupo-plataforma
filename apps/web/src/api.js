// Cliente del API. Guarda la sesión en localStorage y manda siempre
// Authorization + X-Empresa. Si el servidor dice 401, avisa para cerrar sesión.
import { idDispositivo } from './antifraude/dispositivo.js';
const CLAVE = 'grupo.sesion.v1';

export const almacen = {
  leer() { try { return JSON.parse(localStorage.getItem(CLAVE) || 'null'); } catch { return null; } },
  guardar(s) { try { s ? localStorage.setItem(CLAVE, JSON.stringify(s)) : localStorage.removeItem(CLAVE); } catch { /* modo privado */ } },
};

let empresaActiva = null;
export const fijarEmpresa = (c) => { empresaActiva = c; };
export const empresaActual = () => empresaActiva;

export class ErrorApi extends Error {
  constructor(mensaje, status, codigo) { super(mensaje); this.status = status; this.codigo = codigo; }
}

export async function api(ruta, { metodo = 'GET', cuerpo, empresa, sinSesion = false } = {}) {
  const s = almacen.leer();
  const headers = { 'content-type': 'application/json', 'x-dispositivo': idDispositivo() };   // antifraude: qué equipo es
  if (!sinSesion && s?.token) headers.authorization = `Bearer ${s.token}`;
  const emp = empresa !== undefined ? empresa : empresaActiva;   // null = sin encabezado de empresa
  if (emp && emp !== 'grupo') headers['x-empresa'] = emp;
  let r;
  try {
    r = await fetch(`/api${ruta}`, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  } catch {
    throw new ErrorApi('Sin conexión con el servidor. Revisa tu internet.', 0, 'sin_red');
  }
  let datos = null;
  try { datos = await r.json(); } catch { /* sin cuerpo */ }
  if (!r.ok) {
    if (r.status === 401 && !sinSesion) window.dispatchEvent(new Event('grupo:sesion-vencida'));
    throw new ErrorApi(datos?.error || `Error ${r.status}`, r.status, datos?.codigo);
  }
  return datos;
}
export const get = (ruta, o) => api(ruta, o);
export const post = (ruta, cuerpo = {}, o) => api(ruta, { metodo: 'POST', cuerpo, ...o });
export const put = (ruta, cuerpo = {}, o) => api(ruta, { metodo: 'PUT', cuerpo, ...o });
export const patch = (ruta, cuerpo = {}, o) => api(ruta, { metodo: 'PATCH', cuerpo, ...o });

export const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};
