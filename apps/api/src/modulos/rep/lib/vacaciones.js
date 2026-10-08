import { diasEntre } from './fechasSemana.js';

/** Lo que gana cada empleado por año trabajado, a criterio del dueño: parejo para todos. */
export const DIAS_POR_ANIO = 12;

/**
 * Meses COMPLETOS entre dos fechas, comparando el dia del mes - no dividiendo dias entre 30.
 *
 * Quien entro un 15 no cumple el mes el 14 del mes siguiente, aunque hayan pasado 30 dias.
 * El dia que se cumple el mes si cuenta (entro el 15, el 15 del mes que viene ya sumo).
 */
export function mesesCumplidos(fechaIngreso, hoy) {
  const [anioIngreso, mesIngreso, diaIngreso] = fechaIngreso.split('-').map(Number);
  const [anioHoy, mesHoy, diaHoy] = hoy.split('-').map(Number);
  let meses = (anioHoy - anioIngreso) * 12 + (mesHoy - mesIngreso);
  if (diaHoy < diaIngreso) meses--;
  return Math.max(0, meses);
}

/**
 * Dias de vacaciones que tiene ganados alguien a hoy.
 *
 * Son 12 al año, repartidos en UNO POR MES cumplido, y se ACUMULAN: no se reinician en el
 * aniversario ni a fin de año. Quien lleva tres años y nunca salio tiene 36 esperandolo.
 *
 * Que sea mes a mes y no un salto de 12 el dia del aniversario es a pedido del dueño ("un
 * dia al mes, para que sea mas facil"): asi el saldo sube parejo y se puede dar un dia en
 * marzo sin tener que pensar si ya lo gano.
 */
export function diasGanados(meses) {
  return Math.round((meses * DIAS_POR_ANIO) / 12);
}

/**
 * Dias que consume una vacacion del dia X al dia Y, contando los dos extremos.
 *
 * Son dias CORRIDOS de calendario (a pedido del dueño): del lunes al domingo son 7, no 6.
 * Lo que se guarda es este mismo numero, sin reinterpretarlo despues.
 */
export function diasDeVacacion(fechaInicio, fechaFin) {
  return diasEntre(fechaInicio, fechaFin) + 1;
}

const sumaDias = (filas) => filas.reduce((total, v) => total + Number(v.dias || 0), 0);

/**
 * El resumen que mira el dueño por cada empleado: cuanto lleva, cuanto gano en todo ese
 * tiempo, cuanto ya se tomo y cuanto le queda.
 *
 * Como los dias se acumulan, la cuenta es de toda la historia y no de un periodo: ganados
 * desde que entro, menos TODO lo que se tomo desde que entro.
 *
 * Sin fecha de ingreso NO se inventa una antiguedad ni un saldo: se devuelve el historial de
 * lo que igual se le fue dando y una marca para pedir el dato. Un saldo inventado en una
 * liquidacion es peor que un saldo que falta y avisa que falta.
 */
export function resumenVacaciones({ fechaIngreso, vacaciones = [], hoy }) {
  const historial = [...vacaciones].sort((a, b) => b.fecha_inicio.localeCompare(a.fecha_inicio));
  const tomados = sumaDias(historial);

  if (!fechaIngreso) {
    return { sinFechaIngreso: true, historial, tomados };
  }

  const meses = mesesCumplidos(fechaIngreso, hoy);
  const ganados = diasGanados(meses);

  return {
    sinFechaIngreso: false,
    meses,
    anios: Math.floor(meses / 12),
    mesesSueltos: meses % 12,
    ganados,
    tomados,
    saldo: ganados - tomados,
    historial,
  };
}
