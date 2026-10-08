// Utilidades de Reposición: fechas locales (Honduras), cola sin señal (IndexedDB) y caché
// «mostrar ya, refrescar atrás». Portado de offline.js, cache.js, fechaLocal.js y foto.js del original.
import { fechaHN, sumarDias as sumar } from '@grupo/shared';
import { api, empresaActual } from '../api.js';

export const hoyIso = () => fechaHN();
export const sumarDias = sumar;
export const diaAnterior = (f) => sumar(f, -1);

/** «lun 18 ago». Parseada como fecha local para no correrse un día. */
export function fechaCorta(f) {
  if (!f) return '—';
  const [y, m, d] = String(f).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-HN', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
}

/** «hoy 8:03 p. m.», «ayer 9:15 p. m.»: lo primero que importa al abrir un pedido es QUÉ DÍA se subió. */
export function cuandoTexto(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hora = d.toLocaleTimeString('es-HN', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Tegucigalpa' });
  const dia = fechaHN(d); const hoy = fechaHN();
  if (dia === hoy) return `hoy ${hora}`;
  if (dia === sumar(hoy, -1)) return `ayer ${hora}`;
  return `${fechaCorta(dia)} ${hora}`;
}
export const horaCorta = (iso) => (iso ? new Date(iso).toLocaleTimeString('es-HN', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Tegucigalpa' }) : '');
export const kg = (g) => Math.round(Number(g || 0) / 100) / 10;
export const idCliente = () => (globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
export const vibrar = (ms = 12) => { try { navigator.vibrate?.(ms); } catch { /* extra, nunca crítico */ } };

// ── Caché de lecturas (se pinta al instante, se refresca atrás) ─────────────────────────────
const PREFIJO = 'rep.cache.';
const clave = (k) => `${PREFIJO}${empresaActual() ?? ''}.${k}`;
export function leerCache(k) {
  try { const b = localStorage.getItem(clave(k)); return b ? JSON.parse(b) : null; } catch { return null; }
}
export function guardarCache(k, datos) {
  try { localStorage.setItem(clave(k), JSON.stringify({ datos, ts: Date.now() })); } catch { /* lleno o bloqueado */ }
}
export function haceCuanto(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'hace un momento';
  const m = Math.round(s / 60);
  return m < 60 ? `hace ${m} min` : `hace ${Math.round(m / 60)} h`;
}

// ── Cola sin señal (IndexedDB) ──────────────────────────────────────────────────────────────
const DB = 'grupo-rep-offline';
const STORE = 'pendientes';
const abrir = () => new Promise((ok, mal) => {
  if (typeof indexedDB === 'undefined') return mal(new Error('sin indexedDB'));
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true }); };
  r.onsuccess = () => ok(r.result);
  r.onerror = () => mal(r.error);
});
const tx = async (modo, fn) => {
  const db = await abrir();
  return new Promise((ok, mal) => { const t = db.transaction(STORE, modo); const res = fn(t.objectStore(STORE)); t.oncomplete = () => ok(res?.result); t.onerror = () => mal(t.error); });
};
/** Encola algo (tipo, ruta, método, cuerpo) para reenviarlo cuando vuelva la señal. */
export async function encolar(tipo, pedido) {
  try { await tx('readwrite', (s) => s.add({ tipo, empresa: empresaActual(), pedido, ts: Date.now() })); return true; } catch { return false; }
}
export async function pendientes(tipo) {
  try { const todos = await tx('readonly', (s) => s.getAll()); return (todos || []).filter((p) => (!tipo || p.tipo === tipo) && p.empresa === empresaActual()); } catch { return []; }
}
export const contarPendientes = async (tipo) => (await pendientes(tipo)).length;
/** Reintenta lo encolado. Devuelve cuántos siguen pendientes. Un error del servidor (no de red) descarta el pedido para no atascar la cola. */
export async function sincronizar() {
  const lista = await pendientes();
  let quedan = 0;
  for (const p of lista) {
    try {
      await api(p.pedido.ruta, { metodo: p.pedido.metodo, cuerpo: p.pedido.cuerpo });
      await tx('readwrite', (s) => s.delete(p.id));
    } catch (e) {
      if (e.codigo === 'sin_red') quedan += 1;
      else if (e.status >= 400 && e.status < 500 && e.status !== 401) await tx('readwrite', (s) => s.delete(p.id)).catch(() => {});
      else quedan += 1;
    }
  }
  return quedan;
}
/** POST que, sin señal, queda en cola y avisa `offline: true`. */
export async function postConCola(tipo, ruta, cuerpo) {
  try { return await api(ruta, { metodo: 'POST', cuerpo }); }
  catch (e) {
    if (e.codigo === 'sin_red' && await encolar(tipo, { ruta, metodo: 'POST', cuerpo })) return { ok: true, offline: true };
    throw e;
  }
}
/** Escucha el regreso de la señal; devuelve cómo dejar de escuchar. */
export function alVolverLaSenal(fn) {
  window.addEventListener('online', fn);
  return () => window.removeEventListener('online', fn);
}

// ── Foto: reducir antes de subir (una de cámara pesa 3-6 MB y el servidor acepta menos) ────
export function reducirFoto(archivo, ladoMaximo = 1400) {
  return new Promise((ok, mal) => {
    const url = URL.createObjectURL(archivo);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const e = Math.min(1, ladoMaximo / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * e); c.height = Math.round(img.height * e);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      ok(c.toDataURL('image/jpeg', 0.72).split(',')[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(url); mal(new Error('No se pudo leer la foto')); };
    img.src = url;
  });
}

// ── Estados ─────────────────────────────────────────────────────────────────────────────────
export const ESTADOS_HECHOS = ['enviado', 'recibido'];
export const ESTADOS_RESUELTOS = [...ESTADOS_HECHOS, 'no_disponible'];
export const ORDEN_ESTADO = { pedido: 0, pendiente: 0, preparado: 1, enviado: 2, recibido: 3, no_disponible: 3 };
export const ETIQUETA_ESTADO = { pedido: 'Pendiente', pendiente: 'Pendiente', preparado: 'En preparación', enviado: 'Despachado', recibido: 'Entregado', no_disponible: 'Sin stock' };
export const TONO_ESTADO = { pedido: 'aviso', pendiente: 'aviso', preparado: 'info', enviado: 'ok', recibido: 'ok', no_disponible: '' };

export function textoUltimaProduccion(dato, hoy) {
  if (!dato) return null;
  const dias = Math.round((new Date(`${hoy}T12:00:00`) - new Date(`${dato.fecha}T12:00:00`)) / 86400000);
  const cuando = dias <= 0 ? 'hoy' : dias === 1 ? 'ayer' : `hace ${dias} días`;
  return `Se produjo ${cuando}: ${dato.kg} kg`;
}

/** Agrupa pedidos por sucursal («tableros»). */
export function agruparPedidosPorSucursal(pedidos) {
  const mapa = new Map();
  for (const p of pedidos) {
    if (!mapa.has(p.sucursal_id)) mapa.set(p.sucursal_id, { id: p.sucursal_id, nombre: p.sucursal_nombre, pedidos: [], totalItems: 0, ultimaHora: null });
    const b = mapa.get(p.sucursal_id);
    b.pedidos.push(p); b.totalItems += p.items.length;
    if (!b.ultimaHora || p.creado_en > b.ultimaHora) b.ultimaHora = p.creado_en;
  }
  return [...mapa.values()].map((b) => ({
    ...b,
    estadoGeneral: b.pedidos.reduce((peor, p) => (ORDEN_ESTADO[p.estado] < ORDEN_ESTADO[peor] ? p.estado : peor), 'recibido'),
  })).sort((a, b) => ORDEN_ESTADO[a.estadoGeneral] - ORDEN_ESTADO[b.estadoGeneral]);
}
