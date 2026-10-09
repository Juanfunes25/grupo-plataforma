// Formatos de Honduras para mostrar: moneda «L 1,234.50» (ver lempiras en formato.js), fechas dd/mm/aaaa y hora de 12 h.
import { TZ_HN } from './formato.js';

/** '2026-10-09' (o fecha/ISO con hora) → '09/10/2026'. Las fechas sin hora no se mueven de día por la zona horaria. */
export function fechaDMA(v) {
  if (!v) return '';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) { const [y, m, d] = v.split('-'); return `${d}/${m}/${y}`; }
  const dt = new Date(v);
  if (Number.isNaN(dt.getTime())) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ_HN, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(dt).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year}`;
}
/** Fecha y hora de Honduras: '09/10/2026 6:15 p. m.' */
export function fechaHoraDMA(v) {
  if (!v) return '';
  const dt = new Date(v);
  if (Number.isNaN(dt.getTime())) return '';
  const hora = new Intl.DateTimeFormat('es-HN', { timeZone: TZ_HN, hour: 'numeric', minute: '2-digit', hour12: true }).format(dt);
  return `${fechaDMA(dt)} ${hora}`;
}
