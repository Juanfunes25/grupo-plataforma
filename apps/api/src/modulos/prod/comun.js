// Utilidades de Producción de gelato (Italo): números, fechas y el selector de rango del original.
import { fechaHN, sumarDias } from '@grupo/shared';

export const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
export const redondear = (n, decimales = 4) => {
  const f = 10 ** decimales;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
};
export const round2 = (n) => redondear(n, 2);

export const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;
export const hoyHN = () => fechaHN();
export { sumarDias };

/** Sin tildes, mayúsculas y un solo espacio: para comparar nombres de insumo/sabor. */
export const normalizarNombre = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase().replace(/\s+/g, ' ');

export const DIAS_SEMANA = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
export const DIAS_CORTOS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
/** 0 = lunes … 6 = domingo (no el getDay() nativo). */
export const diaSemanaDe = (fechaISO) => (new Date(`${fechaISO}T00:00:00Z`).getUTCDay() + 6) % 7;
export const diasEntre = (desde, hasta) => Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86400000);

/**
 * Un mismo selector de rango para el reporte de producción y el plan: los últimos N días
 * (?dias=30[&hasta=]) o un período exacto (?desde=&hasta=). Máximo 180 días, como el original.
 * Devuelve { error } o { desde, hasta }.
 */
export function resolverRango(query, hoy = hoyHN()) {
  if (query.desde) {
    const desde = String(query.desde);
    const hasta = String(query.hasta || hoy);
    if (!FECHA_ISO.test(desde) || !FECHA_ISO.test(hasta)) return { error: 'Fechas inválidas' };
    if (desde > hasta) return { error: 'La fecha «desde» no puede ser posterior a «hasta»' };
    if (diasEntre(desde, hasta) > 180) return { error: 'El período no puede superar los 180 días' };
    return { desde, hasta };
  }
  const dias = Math.min(Math.max(Number(query.dias) || 30, 7), 180);
  const hasta = String(query.hasta || hoy);
  if (!FECHA_ISO.test(hasta)) return { error: 'Fechas inválidas' };
  return { desde: sumarDias(hasta, -(dias - 1)), hasta };
}
