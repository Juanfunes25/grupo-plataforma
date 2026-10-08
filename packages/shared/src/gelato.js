// Operación de gelato (Italo): reglas de «qué noche» y «a dónde entra cada persona».
// Puras y sin dependencias: las usan el API (tablero) y la web (inicio por rol).
import { TZ_HN, fechaHN, sumarDias } from './formato.js';

/** Hora (0-23) en Honduras. */
export function horaDeHN(d = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ_HN, hour: '2-digit', hourCycle: 'h23' }).format(d));
}

/**
 * Hora a partir de la cual «la noche» ya es la de hoy. Las tiendas pesan de noche y fábrica despacha a la mañana
 * siguiente, así que antes de esta hora quien abre el despacho o el tablero quiere ver el reporte de ANOCHE.
 * (Pendiente de confirmar con el dueño: ver PREGUNTAS-ABIERTAS.)
 */
export const HORA_CAMBIO_DE_NOCHE = 12;

/** La noche de trabajo vigente: { fecha, esHoy }. Antes de las 12:00 es la de ayer. */
export function nocheDeTrabajo(d = new Date(), horaCambio = HORA_CAMBIO_DE_NOCHE) {
  const hoy = fechaHN(d);
  return horaDeHN(d) < horaCambio ? { fecha: sumarDias(hoy, -1), esHoy: false } : { fecha: hoy, esHoy: true };
}

/**
 * Ruta (relativa a la empresa) a la que entra cada persona de una empresa con gelato.
 *   dueño / administrador / manager → tablero · despachador → despacho · producción → cargar producción · tienda → pesaje.
 * `modulos` son los módulos VISIBLES del usuario (ids o { id }). `null` si no maneja gelato: entonces rige el inicio normal.
 */
const ENTRADAS = [['rep:costeo', 'rep_tablero', 'gelato'], ['rep:despachar', 'rep_despacho', 'despacho'], ['rep:producir', 'rep_produccion', 'gelato-produccion'], ['rep:pesar', 'rep_pesaje', 'pesaje']];
export function inicioGelato(modulos, permisos) {
  const ids = new Set((modulos ?? []).map((m) => (typeof m === 'string' ? m : m.id)));
  const tiene = (p) => (permisos instanceof Set ? permisos.has(p) : (permisos ?? []).includes(p));
  return ENTRADAS.find(([p, id]) => tiene(p) && ids.has(id))?.[2] ?? null;
}
