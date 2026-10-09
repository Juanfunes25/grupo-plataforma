// Instalación de la app (PWA) y actualizaciones: estado compartido entre main.jsx y las pantallas.
import { useEffect, useState } from 'react';

const estado = { evento: null, actualizar: null, hayNueva: false };
const avisar = () => window.dispatchEvent(new CustomEvent('grupo:app'));

/** Se llama una vez al arrancar: guarda el evento de «instalar» del navegador (Chrome/Edge/Android) para ofrecerlo en nuestra pantalla. */
export function vigilarInstalacion() {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); estado.evento = e; avisar(); });
  window.addEventListener('appinstalled', () => { estado.evento = null; avisar(); });
}
/** main.jsx registra aquí la función que aplica la versión nueva y marca que hay una lista. */
export function registrarActualizacion(fn) { estado.actualizar = fn; }
export function hayVersionNueva() { estado.hayNueva = true; avisar(); }
export function aplicarVersionNueva() { try { estado.actualizar?.(true); } catch { window.location.reload(); } }

export const estaInstalada = () => {
  try { return window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches || window.navigator.standalone === true; } catch { return false; }
};
export function plataforma() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Windows/.test(ua)) return 'windows';
  return 'otro';
}
export async function instalarAhora() {
  const e = estado.evento; if (!e) return false;
  e.prompt(); const r = await e.userChoice.catch(() => null); estado.evento = null; avisar();
  return r?.outcome === 'accepted';
}
export function useEstadoApp() {
  const [, f] = useState(0);
  useEffect(() => { const h = () => f((n) => n + 1); window.addEventListener('grupo:app', h); return () => window.removeEventListener('grupo:app', h); }, []);
  return { puedeInstalar: Boolean(estado.evento), hayNueva: estado.hayNueva, instalada: estaInstalada() };
}
