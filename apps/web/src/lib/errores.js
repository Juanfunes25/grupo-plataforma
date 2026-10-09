// Reporta al servidor los errores de pantalla (script que falla, promesa rechazada, pantalla que se rompe).
// Con tope por sesión para no inundar; nunca debe causar un error propio.
let enviados = 0;
const vistos = new Set();

export function reportarError(tipo, error, extra = {}) {
  try {
    if (enviados >= 20) return;
    const mensaje = String(error?.message ?? error ?? 'Error sin mensaje').slice(0, 500);
    const clave = `${tipo}|${mensaje}`;
    if (vistos.has(clave)) return;
    vistos.add(clave); enviados++;
    const cuerpo = JSON.stringify({ tipo, mensaje, pila: String(error?.stack ?? '').slice(0, 3000), ruta: location.pathname, version: typeof __VERSION__ !== 'undefined' ? __VERSION__ : '', empresa: (location.pathname.split('/')[1] || ''), ...extra });
    if (navigator.sendBeacon) navigator.sendBeacon('/api/errores-cliente', new Blob([cuerpo], { type: 'application/json' }));
    else fetch('/api/errores-cliente', { method: 'POST', headers: { 'content-type': 'application/json' }, body: cuerpo, keepalive: true }).catch(() => {});
  } catch { /* nunca romper por reportar */ }
}

window.addEventListener('error', (e) => { if (e.error || e.message) reportarError('error', e.error ?? e.message); });
window.addEventListener('unhandledrejection', (e) => reportarError('promesa', e.reason));
