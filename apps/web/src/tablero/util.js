// Utilidades del tablero: formato de hora, ruta de módulos y hooks de actualización (botón, deslizar y automática).
import { useCallback, useEffect, useRef, useState } from 'react';
import { get } from '../api.js';

/** '14:30' → '2:30 p. m.' */
export function hora12(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}

/** Módulos candidatos para cada tipo de alerta (el inventario cambia de nombre según la empresa). */
const CANDIDATOS = {
  inventario: ['inventario', 'rep_inventario', 'prod_insumos', 'dis_inventario'],
  cierres: ['cierres'], cai: ['cai'], antifraude: ['antifraude'], documentos: ['documentos'],
};
/** Ruta del módulo para ir de una alerta (o null si el usuario no lo tiene). */
export function moduloDeAlerta(modulos, id) {
  for (const c of CANDIDATOS[id] ?? [id]) { const m = modulos.find((x) => x.id === c); if (m) return m; }
  return null;
}

/** Variación como texto corto: «+12 %», «−5 %», «nuevo» o «—». */
export function textoVariacion(v) {
  if (!v) return '—';
  if (v.pct === null) return v.nuevo ? 'nuevo' : '—';
  return `${v.pct > 0 ? '+' : v.pct < 0 ? '−' : ''}${Math.abs(v.pct).toLocaleString('es-HN', { maximumFractionDigits: 1 })} %`;
}
export const tonoVariacion = (v) => (!v || v.pct === null ? (v?.nuevo ? 'ok' : 'nd') : v.pct > 0.05 ? 'ok' : v.pct < -0.05 ? 'mal' : 'nd');

/**
 * Carga un tablero: esqueleto la primera vez, actualización silenciosa después (botón, deslizar hacia abajo,
 * cada 2 minutos y al volver a la pestaña). `recargar()` devuelve una promesa para animar el indicador.
 */
export function useTableroDatos(ruta, deps = []) {
  const [est, setEst] = useState({ datos: null, error: null, cargando: true, actualizando: false });
  const n = useRef(0);
  const cargar = useCallback(async () => {
    const mi = ++n.current;
    setEst((e) => ({ ...e, error: null, actualizando: e.datos !== null, cargando: e.datos === null }));
    try {
      const d = await get(ruta);
      if (mi === n.current) setEst({ datos: d, error: null, cargando: false, actualizando: false });
    } catch (e) {
      if (mi === n.current) setEst((s) => ({ ...s, error: e.message, cargando: false, actualizando: false }));
    }
  }, [ruta, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { cargar(); }, [cargar]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') cargar(); }, 120_000);
    const v = () => { if (document.visibilityState === 'visible') cargar(); };
    document.addEventListener('visibilitychange', v);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', v); };
  }, [cargar]);
  return { ...est, recargar: cargar };
}

/**
 * «Deslizar para actualizar»: con la página arriba del todo, jalar hacia abajo ≥ 64 px dispara `alRefrescar`.
 * Devuelve { tiro, ocupado } para dibujar el indicador. Solo táctil (en escritorio no hace nada).
 */
export function useDeslizar(alRefrescar) {
  const [tiro, setTiro] = useState(0);
  const [ocupado, setOcupado] = useState(false);
  const est = useRef({ y0: 0, activo: false, tiro: 0 });
  const accion = useRef(alRefrescar);
  accion.current = alRefrescar;
  useEffect(() => {
    document.documentElement.classList.add('tb-sin-recarga');   // evita que el navegador recargue la página con el mismo gesto
    const ini = (e) => { if (window.scrollY > 0 || e.touches.length !== 1 || e.target.closest?.('input, select, textarea, [role="dialog"]')) return; est.current = { y0: e.touches[0].clientY, activo: true, tiro: 0 }; };
    const mov = (e) => {
      const s = est.current;
      if (!s.activo) return;
      const dy = e.touches[0].clientY - s.y0;
      if (window.scrollY > 0 || dy <= 0) { s.activo = dy > 0 && window.scrollY === 0 ? s.activo : false; s.tiro = 0; setTiro(0); return; }
      s.tiro = Math.min(96, dy * 0.45); setTiro(s.tiro);
    };
    const fin = async () => {
      const s = est.current;
      if (!s.activo) return;
      s.activo = false;
      const llego = s.tiro >= 64;
      s.tiro = 0; setTiro(0);
      if (!llego) return;
      setOcupado(true);
      try { await accion.current(); } finally { setOcupado(false); }
    };
    window.addEventListener('touchstart', ini, { passive: true });
    window.addEventListener('touchmove', mov, { passive: true });
    window.addEventListener('touchend', fin);
    window.addEventListener('touchcancel', fin);
    return () => {
      document.documentElement.classList.remove('tb-sin-recarga');
      window.removeEventListener('touchstart', ini); window.removeEventListener('touchmove', mov);
      window.removeEventListener('touchend', fin); window.removeEventListener('touchcancel', fin);
    };
  }, []);
  return { tiro, ocupado };
}
