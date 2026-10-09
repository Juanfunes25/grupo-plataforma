// Color de acento por empresa con contraste AA garantizado en botones y textos.
// Fija en :root: --acento (marca), --acento-texto (texto sobre el color puro),
// --acento-btn / --acento-btn-texto (botón primario: se oscurece lo justo para que el texto sea legible).
const OSCURO = '#0e1320';
const aRgb = (hex) => {
  const h = String(hex || '').replace('#', '');
  const t = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(t, 16);
  return Number.isFinite(n) && t.length === 6 ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [197, 96, 60];
};
const aHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const lum = (rgb) => {
  const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contraste = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

export function calcularAcento(hex) {
  const rgb = aRgb(hex);
  const blanco = [255, 255, 255];
  const oscuro = aRgb(OSCURO);
  const texto = contraste(rgb, blanco) >= contraste(rgb, oscuro) ? '#ffffff' : OSCURO;
  let btn = rgb; let btnTexto = '#ffffff';
  if (lum(rgb) >= 0.3) btnTexto = OSCURO; // colores claros (oro, naranja vivo): texto oscuro
  else { let f = 1; while (contraste(btn, blanco) < 4.5 && f > 0.4) { f -= 0.03; btn = rgb.map((v) => v * f); } }
  return { color: aHex(rgb), texto, btn: aHex(btn), btnTexto };
}

export function aplicarAcento(hex) {
  const a = calcularAcento(hex);
  const s = document.documentElement.style;
  s.setProperty('--acento', a.color); s.setProperty('--acento-texto', a.texto);
  s.setProperty('--acento-btn', a.btn); s.setProperty('--acento-btn-texto', a.btnTexto);
}

// ── Tema (claro / oscuro / automático) ── la lógica vive en preferencias.js; estas funciones se conservan por compatibilidad.
import { aplicarPreferencias, guardarPref, leerPref } from './preferencias.js';
export const leerTema = () => leerPref('tema');
export const aplicarTema = () => aplicarPreferencias();
export const guardarTema = (t) => guardarPref('tema', t);
