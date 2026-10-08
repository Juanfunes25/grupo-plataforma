// Formato compartido de las pantallas de EcoStone.
export const num = (n, d = 2) => Number(n ?? 0).toLocaleString('es-HN', { minimumFractionDigits: 0, maximumFractionDigits: d });
export const fechaCorta = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('es-HN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
/** Toda cantidad se captura en números enteros (no se vende media caja). */
export const entero = (v) => (v === '' ? '' : String(Math.max(0, Math.floor(Number(v) || 0))));
