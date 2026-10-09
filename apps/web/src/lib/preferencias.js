// Preferencias de apariencia POR DISPOSITIVO (localStorage con try/catch: sin almacenamiento todo sigue funcionando).
// tema: auto | claro | oscuro · contraste: normal | alto · letra: normal | grande | enorme · densidad: comoda | compacta · quiosco: si | no
import { useEffect, useState } from 'react';

const CLAVES = { tema: 'grupo.tema', contraste: 'grupo.contraste', letra: 'grupo.letra', densidad: 'grupo.densidad', quiosco: 'grupo.quiosco' };
export const OPCIONES = {
  tema: [['auto', 'Automático'], ['claro', 'Claro'], ['oscuro', 'Oscuro']],
  contraste: [['normal', 'Normal'], ['alto', 'Alto contraste (para el sol)']],
  letra: [['normal', 'Normal'], ['grande', 'Grande'], ['enorme', 'Muy grande']],
  densidad: [['comoda', 'Cómoda'], ['compacta', 'Compacta']],
};
const DEFECTO = { tema: 'oscuro', contraste: 'normal', letra: 'normal', densidad: 'comoda', quiosco: 'no' };
const VALIDOS = { tema: ['auto', 'claro', 'oscuro'], contraste: ['normal', 'alto'], letra: ['normal', 'grande', 'enorme'], densidad: ['comoda', 'compacta'], quiosco: ['si', 'no'] };
const COLOR_BARRA = { claro: '#f3f1ed', oscuro: '#0e1320' };

export function leerPref(k) {
  try { const v = localStorage.getItem(CLAVES[k]); return VALIDOS[k].includes(v) ? v : DEFECTO[k]; } catch { return DEFECTO[k]; }
}
const sistemaClaro = () => { try { return window.matchMedia('(prefers-color-scheme: light)').matches; } catch { return false; } };
/** Tema efectivo (claro u oscuro) a partir de la preferencia. */
export const temaEfectivo = (t = leerPref('tema')) => (t === 'auto' ? (sistemaClaro() ? 'claro' : 'oscuro') : t);

/** Pinta el <html> con las preferencias vigentes (se llama al arrancar y en cada cambio). */
export function aplicarPreferencias() {
  const h = document.documentElement;
  const t = temaEfectivo();
  h.dataset.tema = t;
  h.dataset.contraste = leerPref('contraste');
  h.dataset.letra = leerPref('letra');
  h.dataset.densidad = leerPref('densidad');
  h.dataset.quiosco = leerPref('quiosco');
  const m = document.querySelector('meta[name="theme-color"]');
  if (m && !h.dataset.colorBarraEmpresa) m.content = COLOR_BARRA[t];
}
export function guardarPref(k, v) {
  if (!VALIDOS[k]?.includes(v)) return;
  try { localStorage.setItem(CLAVES[k], v); } catch { /* sin almacenamiento */ }
  aplicarPreferencias();
  window.dispatchEvent(new CustomEvent('grupo:prefs'));
}
/** Si el tema es «automático», sigue los cambios del sistema (por ejemplo, el modo oscuro de la noche). */
export function vigilarSistema() {
  try {
    const m = window.matchMedia('(prefers-color-scheme: light)');
    m.addEventListener('change', () => { if (leerPref('tema') === 'auto') aplicarPreferencias(); });
  } catch { /* navegador sin matchMedia */ }
}
/** Hook: lee una preferencia y se actualiza cuando cambia. */
export function usePref(k) {
  const [v, setV] = useState(() => leerPref(k));
  useEffect(() => { const f = () => setV(leerPref(k)); window.addEventListener('grupo:prefs', f); return () => window.removeEventListener('grupo:prefs', f); }, [k]);
  return [v, (n) => guardarPref(k, n)];
}

/** Color de la barra del sistema = color de la empresa activa (o el del tema si no hay). */
export function fijarColorBarra(hex) {
  const h = document.documentElement; const m = document.querySelector('meta[name="theme-color"]');
  if (hex) h.dataset.colorBarraEmpresa = '1'; else delete h.dataset.colorBarraEmpresa;
  if (m) m.content = hex || COLOR_BARRA[temaEfectivo()];
}
/** Cada empresa se instala como su propia app: manifiesto, icono de iPhone y color propios. */
export function fijarAppEmpresa(codigo) {
  const cod = ['italo', 'origen', 'ecostone', 'diserco', 'grupo'].includes(codigo) ? codigo : null;
  const man = document.querySelector('link[rel="manifest"]');
  if (man) { if (!man.dataset.original) man.dataset.original = man.getAttribute('href'); man.setAttribute('href', cod ? `/manifiestos/${cod}.webmanifest` : man.dataset.original); }
  let ap = document.querySelector('link[rel="apple-touch-icon"]');
  if (!ap) { ap = document.createElement('link'); ap.rel = 'apple-touch-icon'; document.head.appendChild(ap); }
  ap.href = `/icons/${cod ?? 'base'}-180.png`;
}
