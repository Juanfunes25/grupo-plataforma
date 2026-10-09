// Cola de ventas sin conexión de ESTA caja: se guarda en IndexedDB (sobrevive a cerrar el navegador y a reiniciar la computadora).
// La lógica (orden, reintentos, idempotencia) está en @grupo/shared/colaOffline.js y se prueba allá; aquí solo el almacenamiento,
// el envío al servidor y los avisos a la pantalla.
import { useEffect, useState } from 'react';
import { almacenEnMemoria, crearCola } from '@grupo/shared';
import { post } from '../api.js';
import { idDispositivo } from '../antifraude/dispositivo.js';

const EVENTO = 'grupo:cola-pos';
const BD = 'grupo-pos', VERSION = 1;

let persistente = true;

function abrirBd() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('sin IndexedDB')); return; }
    const r = indexedDB.open(BD, VERSION);
    r.onupgradeneeded = () => {
      const bd = r.result;
      if (!bd.objectStoreNames.contains('cola')) bd.createObjectStore('cola', { keyPath: 'id' });
      if (!bd.objectStoreNames.contains('meta')) bd.createObjectStore('meta', { keyPath: 'k' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function almacenIndexedDb() {
  let promesa = null;
  const bd = () => (promesa ??= abrirBd());
  const tx = async (tienda, modo, fn) => {
    const db = await bd();
    return new Promise((resolve, reject) => {
      const t = db.transaction(tienda, modo);
      const res = fn(t.objectStore(tienda));
      t.oncomplete = () => resolve(res?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  };
  return {
    todos: () => tx('cola', 'readonly', (s) => s.getAll()).then((x) => x ?? []),
    poner: (it) => tx('cola', 'readwrite', (s) => s.put(it)),
    borrar: (id) => tx('cola', 'readwrite', (s) => s.delete(id)),
    meta: (k) => tx('meta', 'readonly', (s) => s.get(k)).then((x) => x?.v),
    ponerMeta: (k, v) => tx('meta', 'readwrite', (s) => s.put({ k, v })),
  };
}

/** IndexedDB si se puede; si el navegador no lo deja (ventana privada, bloqueado) queda en memoria y la pantalla avisa que se perdería al cerrar. */
function almacenSeguro() {
  const idb = almacenIndexedDb(); const mem = almacenEnMemoria();
  let usar = idb; let probado = false;
  const prueba = async () => { if (probado) return; probado = true; try { await idb.meta('x'); } catch { usar = mem; persistente = false; } };
  const envolver = (nombre) => async (...a) => { await prueba(); return usar[nombre](...a); };
  return { todos: envolver('todos'), poner: envolver('poner'), borrar: envolver('borrar'), meta: envolver('meta'), ponerMeta: envolver('ponerMeta') };
}

let colaUnica = null;
let sincronizando = false;

export function cola() {
  if (!colaUnica) {
    const almacen = almacenSeguro();
    const avisado = {
      ...almacen,
      poner: async (it) => { await almacen.poner(it); avisarCambio(); },
      borrar: async (id) => { await almacen.borrar(id); avisarCambio(); },
    };
    colaUnica = crearCola({
      almacen: avisado,
      // La venta se manda a la empresa en la que se hizo, aunque el usuario ya haya cambiado de empresa en pantalla.
      enviar: (payload, item) => post('/pos/ventas', payload, { empresa: item.empresa, espera: 25_000 }),
    });
  }
  return colaUnica;
}

export const codigoCaja = () => String(idDispositivo()).slice(-4).toUpperCase();

async function resumenActual() {
  try { return { ...(await cola().resumen()), sincronizando, persistente }; } catch { return { pendientes: 0, revisar: 0, total: 0, sincronizando, persistente }; }
}
function avisarCambio() {
  resumenActual().then((r) => { try { window.dispatchEvent(new CustomEvent(EVENTO, { detail: r })); } catch { /* */ } });
}

/** Manda ya lo que haya en cola. Devuelve lo que devolvió la cola ({ enviadas, detenida, pendientes, revisar }). */
export async function sincronizarAhora() {
  sincronizando = true; avisarCambio();
  try { return await cola().sincronizar(); } finally { sincronizando = false; avisarCambio(); }
}

/** { pendientes, revisar, total, sincronizando, persistente } siempre al día. */
export function useResumenCola() {
  const [r, setR] = useState({ pendientes: 0, revisar: 0, total: 0, sincronizando: false, persistente: true });
  useEffect(() => {
    let vivo = true;
    const f = (e) => { if (vivo) setR(e.detail); };
    window.addEventListener(EVENTO, f);
    resumenActual().then((x) => { if (vivo) setR(x); });
    return () => { vivo = false; window.removeEventListener(EVENTO, f); };
  }, []);
  return r;
}
