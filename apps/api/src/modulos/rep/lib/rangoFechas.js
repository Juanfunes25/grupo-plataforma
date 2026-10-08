import { hoyNegocio } from './fechaNegocio.js';
/**
 * Un mismo selector de rango para Rotacion, el ranking de insumos despachados y la
 * produccion por período: los tres aceptan las dos formas de pedirlo:
 *   - ?dias=30[&hasta=AAAA-MM-DD]: los ultimos N dias (los presets de la pantalla).
 *   - ?desde=AAAA-MM-DD&hasta=AAAA-MM-DD: un periodo calendarizado exacto, para cuando el
 *     dueño quiere comparar una fecha puntual contra otra (una quincena, una promocion).
 */

export const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

function diasEntreISO(desdeISO, hastaISO) {
  return Math.round((new Date(`${hastaISO}T00:00:00`) - new Date(`${desdeISO}T00:00:00`)) / 86400000);
}

/** Devuelve { error } si algo no es valido, o { desde, hasta } si esta todo bien. */
export function resolverRango(query) {
  const hoyReal = hoyNegocio();

  if (query.desde) {
    const desde = query.desde;
    const hasta = query.hasta || hoyReal;
    if (!FECHA_ISO.test(desde) || !FECHA_ISO.test(hasta)) {
      return { error: 'Fechas invalidas' };
    }
    if (desde > hasta) return { error: 'La fecha "desde" no puede ser posterior a "hasta"' };
    // Un rango de años sobre Turso (cada consulta es un viaje de red) se nota, y no hay
    // reporte real que necesite mas de medio año de un saque.
    if (diasEntreISO(desde, hasta) > 180) {
      return { error: 'El período no puede superar los 180 días' };
    }
    return { desde, hasta };
  }

  const dias = Math.min(Math.max(Number(query.dias) || 30, 7), 180);
  const hasta = query.hasta || hoyReal;
  const d = new Date(`${hasta}T00:00:00`);
  d.setDate(d.getDate() - (dias - 1));
  return { desde: d.toISOString().slice(0, 10), hasta };
}
