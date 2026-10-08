// Contador de alertas abiertas para el menú: una sola consulta compartida (cada 30 s) aunque
// varios componentes lo muestren.
import { useEffect, useSyncExternalStore } from 'react';
import { get } from '../api.js';

let estado = { pendientes: 0, altas: 0 };
const oyentes = new Set();
let usuarios = 0;
let timer = null;

const publicar = (nuevo) => { estado = nuevo; oyentes.forEach((f) => f()); };

export async function refrescarPendientes() {
  try {
    const r = await get('/antifraude/alertas/pendientes');
    if (r.pendientes !== estado.pendientes || r.altas !== estado.altas) publicar({ pendientes: r.pendientes, altas: r.altas });
  } catch { /* se reintenta en el próximo ciclo */ }
}

/** `activo` = el usuario puede ver el antifraude en esta empresa. */
export function useAlertasPendientes(activo = true) {
  useEffect(() => {
    if (!activo) return undefined;
    usuarios += 1;
    if (usuarios === 1) { refrescarPendientes(); timer = setInterval(refrescarPendientes, 30_000); }
    return () => { usuarios -= 1; if (usuarios === 0) { clearInterval(timer); timer = null; } };
  }, [activo]);
  return useSyncExternalStore((f) => { oyentes.add(f); return () => oyentes.delete(f); }, () => estado);
}
