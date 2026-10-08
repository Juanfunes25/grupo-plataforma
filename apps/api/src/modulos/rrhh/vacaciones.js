// Vacaciones según el Código del Trabajo de Honduras (art. 346): vacaciones remuneradas
// después de cada año de trabajo continuo, con esta escala:
//   1 año → 10 días · 2 años → 12 · 3 años → 15 · 4 años o más → 20
// El derecho a cada período nace al CUMPLIR el año de servicio. Los días tomados se descuentan
// del período más antiguo con saldo (primero en entrar, primero en salir).
//
// Supuestos de negocio (validar con el contador/abogado laboral; están en una sola constante):
//  - Los días de la escala son días hábiles; por defecto se cuentan lunes a sábado (sin domingos).
//    Quien registra puede escoger "corridos" o escribir el número exacto.
//  - Cada período se debe gozar dentro de los 12 meses siguientes a ganarse (PLAZO_MESES);
//    pasado ese plazo queda "vencido" y se avisa antes con AVISO_DIAS de anticipación.
import { sumarDias } from '@grupo/shared';

export const ESCALA_LEY = [[1, 10], [2, 12], [3, 15], [4, 20]];
export const PLAZO_MESES = 12;
export const AVISO_DIAS = 60;

/** Días de vacaciones que da el año de servicio número `anio` (1, 2, 3, 4 o más). */
export function diasLey(anio) {
  if (!(anio >= 1)) return 0;
  return anio >= 4 ? 20 : ESCALA_LEY[anio - 1][1];
}

const partes = (f) => f.split('-').map(Number);
const pad = (n) => String(n).padStart(2, '0');

/** Suma meses a una fecha YYYY-MM-DD respetando fin de mes (31 ene + 1 mes = 28/29 feb; 29 feb + 1 año = 28 feb). */
export function sumarMeses(fecha, meses) {
  const [y, m, d] = partes(fecha);
  const total = (y * 12 + (m - 1)) + meses;
  const ny = Math.floor(total / 12), nm = (total % 12) + 1;
  const ultimo = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad(nm)}-${pad(Math.min(d, ultimo))}`;
}

/** Meses completos entre dos fechas (el día del mes cuenta: quien entró un 15 cumple el mes el 15). */
export function mesesCumplidos(desde, hasta) {
  const [y1, m1, d1] = partes(desde), [y2, m2, d2] = partes(hasta);
  let m = (y2 - y1) * 12 + (m2 - m1);
  const ultimo = new Date(Date.UTC(y2, m2, 0)).getUTCDate();
  if (d2 < d1 && !(d2 === ultimo && d1 > ultimo)) m -= 1;
  return Math.max(0, m);
}

export function diferenciaDias(desde, hasta) {
  const a = Date.UTC(...partes(desde).map((v, i) => (i === 1 ? v - 1 : v)));
  const b = Date.UTC(...partes(hasta).map((v, i) => (i === 1 ? v - 1 : v)));
  return Math.round((b - a) / 86_400_000);
}

/** Días que consume una vacación de `desde` a `hasta` (ambos extremos). modo: 'habiles' (lun–sáb) o 'corridos'. */
export function contarDias(desde, hasta, modo = 'habiles') {
  let n = 0;
  for (let f = desde; f <= hasta; f = sumarDias(f, 1)) {
    if (modo === 'corridos') { n += 1; continue; }
    const [y, m, d] = partes(f);
    if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() !== 0) n += 1;
  }
  return n;
}

/**
 * Cuadro de vacaciones de un empleado.
 *  ingreso: fecha de ingreso; hoy: fecha de referencia (o fecha de baja si ya salió).
 *  tomadas: [{ dias, estado }] — cuentan las 'aprobada' y 'tomada' (las solicitadas aún no gastan saldo).
 */
export function calcularVacaciones({ ingreso, hoy, tomadas = [], avisoDias = AVISO_DIAS }) {
  const gastan = tomadas.filter((v) => v.estado === 'aprobada' || v.estado === 'tomada');
  const totalTomados = gastan.reduce((s, v) => s + Number(v.dias || 0), 0);
  const solicitados = tomadas.filter((v) => v.estado === 'solicitada').reduce((s, v) => s + Number(v.dias || 0), 0);
  if (!ingreso) {
    return { sin_fecha_ingreso: true, tomados: totalTomados, solicitados, ganados: 0, pendientes: 0, periodos: [], por_vencer: 0, vencidas: 0 };
  }
  const meses = Math.max(0, mesesCumplidos(ingreso, hoy));
  const anios = Math.floor(meses / 12);

  let restante = totalTomados;
  const periodos = [];
  for (let k = 1; k <= anios; k++) {
    const derecho = sumarMeses(ingreso, k * 12);
    const vence = sumarMeses(derecho, PLAZO_MESES);
    const dias = diasLey(k);
    const usados = Math.min(dias, restante);
    restante -= usados;
    const pendientes = dias - usados;
    const faltan = diferenciaDias(hoy, vence);
    const estado = pendientes === 0 ? 'tomado' : faltan < 0 ? 'vencido' : faltan <= avisoDias ? 'por_vencer' : 'vigente';
    periodos.push({ numero: k, desde: sumarMeses(ingreso, (k - 1) * 12), derecho, vence, dias_ley: dias, tomados: usados, pendientes, estado, dias_para_vencer: faltan });
  }
  const ganados = periodos.reduce((s, p) => s + p.dias_ley, 0);
  const adelantados = restante; // tomó más de lo ganado (adelanto)
  // Lo que va acumulando el año en curso (proporcional; sirve para liquidaciones).
  const enCurso = anios + 1;
  const mesesEnCurso = meses - anios * 12;
  return {
    sin_fecha_ingreso: false,
    antiguedad: { anios, meses: mesesEnCurso, total_meses: meses },
    ganados,
    tomados: totalTomados,
    solicitados,
    adelantados,
    pendientes: Math.max(0, ganados - totalTomados),
    por_vencer: periodos.filter((p) => p.estado === 'por_vencer').reduce((s, p) => s + p.pendientes, 0),
    vencidas: periodos.filter((p) => p.estado === 'vencido').reduce((s, p) => s + p.pendientes, 0),
    proximo: { numero: enCurso, derecho: sumarMeses(ingreso, enCurso * 12), dias_ley: diasLey(enCurso) },
    proporcional_en_curso: Math.round(((diasLey(enCurso) * mesesEnCurso) / 12) * 10) / 10,
    periodos,
  };
}
