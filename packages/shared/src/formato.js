const nf = new Intl.NumberFormat('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const lempiras = (n) => `L ${nf.format(Number(n || 0))}`;
export const numero = (n, dec = 0) => new Intl.NumberFormat('es-HN', { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(Number(n || 0));
export const TZ_HN = 'America/Tegucigalpa';

/** Fecha YYYY-MM-DD en hora de Honduras (UTC-6, sin horario de verano). */
export function fechaHN(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ_HN, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export const horaHN = (d) => new Intl.DateTimeFormat('es-HN', { timeZone: TZ_HN, hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(d));
export const fechaHoraHN = (d) => new Intl.DateTimeFormat('es-HN', { timeZone: TZ_HN, dateStyle: 'short', timeStyle: 'short' }).format(new Date(d));

/** Suma días a una fecha YYYY-MM-DD. */
export function sumarDias(fecha, dias) {
  const [y, m, d] = fecha.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + dias));
  return dt.toISOString().slice(0, 10);
}
