// Llamadas al API de inventario de reposición (/api/rinv) y la cola «sin señal»: lo que se hace sin internet
// queda guardado en el dispositivo y se envía solo al volver (cada acción lleva su cliente_id, así que un
// reintento nunca aplica dos veces el mismo movimiento).
import { api, empresaActual, get, post, qs } from '../api.js';

export const rget = (ruta, o) => get(`/rinv${ruta}`, o);
export const rpost = (ruta, cuerpo, o) => post(`/rinv${ruta}`, cuerpo, o);
export const rpatch = (ruta, cuerpo) => api(`/rinv${ruta}`, { metodo: 'PATCH', cuerpo });
export const rdel = (ruta) => api(`/rinv${ruta}`, { metodo: 'DELETE' });
export { qs };

/** Id propio por acción: permite reconocer un reintento. */
export function idCliente() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

const CLAVE_COLA = 'rinv.cola.v1';
const leerCola = () => { try { return JSON.parse(localStorage.getItem(CLAVE_COLA) || '[]'); } catch { return []; } };
const guardarCola = (c) => { try { localStorage.setItem(CLAVE_COLA, JSON.stringify(c)); } catch { /* sin almacenamiento: no se puede encolar */ } };
export const contarPendientes = () => leerCola().length;

/** Escribe; si no hay señal, lo encola y responde {ok:true, offline:true}. Un error real del servidor sí se propaga. */
export async function escribirConCola(metodo, ruta, cuerpo) {
  try {
    return await api(`/rinv${ruta}`, { metodo, cuerpo });
  } catch (e) {
    if (e.codigo === 'sin_red') {
      guardarCola([...leerCola(), { metodo, ruta, cuerpo, empresa: empresaActual(), ts: Date.now() }]);
      window.dispatchEvent(new Event('rinv:cola'));
      return { ok: true, offline: true };
    }
    throw e;
  }
}

let sincronizando = false;
/** Reenvía lo encolado, en orden. Devuelve cuántos quedan pendientes. */
export async function sincronizarCola() {
  if (sincronizando) return contarPendientes();
  sincronizando = true;
  try {
    const cola = leerCola();
    const quedan = [];
    let cortado = false;
    for (const p of cola) {
      if (cortado) { quedan.push(p); continue; }
      try { await api(`/rinv${p.ruta}`, { metodo: p.metodo, cuerpo: p.cuerpo, empresa: p.empresa }); }
      catch (e) {
        if (e.codigo === 'sin_red' || e.status >= 500) { quedan.push(p); cortado = e.codigo === 'sin_red'; }
        // un rechazo real (400-409) no se reintenta: quedaría trabado para siempre
      }
    }
    guardarCola(quedan);
    window.dispatchEvent(new Event('rinv:cola'));
    return quedan.length;
  } finally { sincronizando = false; }
}

// Cache «mostrar ya, refrescar atrás»
const PRE = 'rinv.cache.';
export const leerCache = (k) => { try { return JSON.parse(localStorage.getItem(PRE + k)); } catch { return null; } };
export const guardarCache = (k, datos) => { try { localStorage.setItem(PRE + k, JSON.stringify({ datos, ts: Date.now() })); } catch { /* lleno */ } };
