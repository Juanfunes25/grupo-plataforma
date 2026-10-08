/** Utilidades de días de la semana, compartidas por los módulos de planificación. */

export const DIAS_SEMANA = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
export const DIAS_CORTOS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

export function diasEntre(desdeISO, hastaISO) {
  return Math.round((new Date(`${hastaISO}T00:00:00`) - new Date(`${desdeISO}T00:00:00`)) / 86400000);
}

export function sumarDias(fechaISO, n) {
  const d = new Date(`${fechaISO}T00:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0 = lunes ... 6 = domingo (no el getDay() nativo, que arranca en domingo) - mismo criterio
 *  que ya usa el módulo de horarios de empleados (routes/turno.js). */
export function diaSemanaDe(fechaISO) {
  return (new Date(`${fechaISO}T00:00:00`).getDay() + 6) % 7;
}
