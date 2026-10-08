import { useEffect, useRef } from 'react';
import { get, qs } from '../api.js';

/**
 * Sincronización "en vivo" por consulta periódica liviana (no hay websockets): cada `cada` ms pregunta una huella barata y solo
 * cuando CAMBIA ejecuta `alCambiar`. Se pausa con la pestaña oculta y se pone al día al volver. La primera huella solo se recuerda.
 */
export function useHuella(obtener, alCambiar, { cada = 8000, activo = true, claves = [] } = {}) {
  const fnObtener = useRef(obtener); fnObtener.current = obtener;
  const fnCambio = useRef(alCambiar); fnCambio.current = alCambiar;
  useEffect(() => {
    if (!activo) return undefined;
    let ultima = null, vivo = true, ocupado = false;
    const tic = async () => {
      if (!vivo || ocupado || document.hidden) return;
      ocupado = true;
      try {
        const h = await fnObtener.current();
        if (ultima !== null && h !== ultima) await fnCambio.current();
        ultima = h;
      } catch { /* sin red: se reintenta en el siguiente tic */ } finally { ocupado = false; }
    };
    tic();
    const id = setInterval(tic, cada);
    const visible = () => { if (!document.hidden) tic(); };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', tic);
    return () => { vivo = false; clearInterval(id); document.removeEventListener('visibilitychange', visible); window.removeEventListener('online', tic); };
  }, [activo, cada, ...claves]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Avisa cuando cambian las órdenes abiertas / cobros / anulaciones de la sucursal (o de todas si no se indica). */
export function useCambiosVentas(sucursalId, alCambiar, opciones = {}) {
  useHuella(async () => (await get(`/pos/ventas/cambios${qs({ sucursal_id: sucursalId })}`)).huella, alCambiar, { ...opciones, claves: [sucursalId] });
}

/** Avisa cuando cambia el catálogo (precios, productos, "se acabó", categorías, opciones) hecho desde otra caja o pantalla. */
export function useCatalogoVivo(alCambiar, opciones = {}) {
  useHuella(async () => (await get('/pos/catalogo/version')).v, alCambiar, { cada: 15000, ...opciones });
}
