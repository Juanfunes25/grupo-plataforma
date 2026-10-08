/**
 * "Hoy" y "qué hora es" según el reloj de Honduras, no el del servidor.
 *
 * El servidor de Render corre en UTC. Honduras es UTC-6 todo el año (no mueve el reloj),
 * así que `new Date().toISOString().slice(0,10)` devuelve el día SIGUIENTE desde las 6 de la
 * tarde hora local, y `getHours()` viene 6 horas adelantado. Las dos cosas rompen cualquier
 * cuenta que dependa del día: una salida marcada a las 7pm quedaba fechada mañana, y el
 * aviso de "tiendas sin abrir" comparaba contra una hora que no era la de acá.
 *
 * El frontend ya tenía esta corrección (frontend/src/fechaLocal.js); esta es la misma idea
 * del lado del servidor, para que una llamada sin fecha explícita caiga igual en el día
 * correcto.
 */

export const ZONA = 'America/Tegucigalpa';

// 'en-CA' formatea como YYYY-MM-DD, que es justo el formato con el que se guardan las
// fechas. Se usa Intl y no un offset fijo a mano para no tener que mantener la regla si
// algún día cambia.
const FORMATO_FECHA = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const FORMATO_HORA = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONA,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** El día de hoy en Honduras, como "2026-08-25". */
export function hoyNegocio(ahora = new Date()) {
  return FORMATO_FECHA.format(ahora);
}

/** Minutos desde la medianoche en Honduras: 8:30 de la mañana -> 510. */
export function minutosDelDia(ahora = new Date()) {
  const [hora, minuto] = FORMATO_HORA.format(ahora).split(':').map(Number);
  return hora * 60 + minuto;
}
