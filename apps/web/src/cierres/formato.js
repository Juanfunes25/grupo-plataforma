// Formatos y rangos compartidos por Cierre de caja, Caja chica, Reportes y Dashboard.
import { fechaHN, lempiras, sumarDias, TZ_HN } from '@grupo/shared';

export const L = lempiras;
/** Lempiras sin "-0.00". */
export const Lm = (n) => lempiras(Math.abs(Number(n ?? 0)) < 0.005 ? 0 : n);
export const entero = (n) => Number(n ?? 0).toLocaleString('es-HN');
export const num = (n) => Number(n ?? 0).toLocaleString('es-HN', { maximumFractionDigits: 2 });
export const fechaHora = (iso) => (iso ? new Date(iso).toLocaleString('es-HN', { timeZone: TZ_HN, dateStyle: 'short', timeStyle: 'short' }) : '—');
export const fechaCorta = (f) => new Date(`${f}T12:00:00Z`).toLocaleDateString('es-HN', { timeZone: 'UTC', day: '2-digit', month: 'short' });
export const hora12 = (h) => `${((h + 11) % 12) + 1} ${h < 12 ? 'a. m.' : 'p. m.'}`;
export const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
export const DIAS_CORTOS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

export const hoyHn = () => fechaHN();
export const primerDiaMes = () => `${hoyHn().slice(0, 7)}-01`;
const diaSemana = (f) => (new Date(`${f}T12:00:00Z`).getUTCDay() + 6) % 7;   // lunes = 0

/** Atajos de rango en días de calendario de Honduras. */
export const ATAJOS = [
  { etiqueta: 'Hoy', calcular: () => ({ desde: hoyHn(), hasta: hoyHn() }) },
  { etiqueta: 'Ayer', calcular: () => ({ desde: sumarDias(hoyHn(), -1), hasta: sumarDias(hoyHn(), -1) }) },
  { etiqueta: 'Esta semana', calcular: () => ({ desde: sumarDias(hoyHn(), -diaSemana(hoyHn())), hasta: hoyHn() }) },
  { etiqueta: 'Semana pasada', calcular: () => { const l = sumarDias(hoyHn(), -diaSemana(hoyHn()) - 7); return { desde: l, hasta: sumarDias(l, 6) }; } },
  { etiqueta: 'Este mes', calcular: () => ({ desde: primerDiaMes(), hasta: hoyHn() }) },
  { etiqueta: 'Mes pasado', calcular: () => { const fin = sumarDias(primerDiaMes(), -1); return { desde: `${fin.slice(0, 7)}-01`, hasta: fin }; } },
  { etiqueta: 'Últimos 30 días', calcular: () => ({ desde: sumarDias(hoyHn(), -29), hasta: hoyHn() }) },
  { etiqueta: 'Este año', calcular: () => ({ desde: `${hoyHn().slice(0, 4)}-01-01`, hasta: hoyHn() }) },
];

/** Imprime renglones de ticket en la térmica (mismo mecanismo que la factura: .ticket-print + window.print). */
export function imprimirLineas(lineas, fijar) {
  fijar(lineas);
  setTimeout(() => { window.print(); fijar(null); }, 150);
}

// <input type="datetime-local"> trabaja en hora local sin zona; el servidor guarda timestamptz.
export function isoAInputLocal(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const inputLocalAIso = (v) => new Date(v).toISOString();
export function inicioDeHoyIso() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); }

/** Imprime el reporte en pantalla (el estilo global de impresión solo deja ver tickets: aquí se destapa el reporte). */
export function imprimirReporte() {
  document.body.classList.add('imprimiendo-reporte');
  const quitar = () => { document.body.classList.remove('imprimiendo-reporte'); window.removeEventListener('afterprint', quitar); };
  window.addEventListener('afterprint', quitar);
  window.print();
}
