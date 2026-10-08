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

// ── Papel térmico ───────────────────────────────────────────────────────────
// Ancho en caracteres según el papel (48 col → 80 mm, 42 col → 80 mm fuente B, 32 col → 58 mm).
export const ANCHOS_TICKET = { 48: '80mm', 42: '80mm', 32: '58mm' };
export const PAPELES = [
  { columnas: 48, etiqueta: '80 mm (el más común)' },
  { columnas: 42, etiqueta: '80 mm, letra más grande' },
  { columnas: 32, etiqueta: '58 mm (impresora pequeña)' },
];
// Área realmente imprimible (el cabezal no llega al borde): 80 mm → 72 mm, 58 mm → 48 mm.
const IMPRIMIBLE_MM = { '80mm': 72, '58mm': 48 };
const escaparHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Página HTML de un ticket de texto. @page fija el ancho real del rollo para que el navegador no agregue márgenes ni escale,
 * y la letra se calcula para que las N columnas llenen exactamente el área imprimible (Courier mide 0.6 del tamaño de letra).
 */
export function envolverTicketHtml(texto, ancho = 48) {
  const papel = ANCHOS_TICKET[ancho] ?? '80mm';
  const imprimible = IMPRIMIBLE_MM[papel];
  const fuenteMm = (imprimible / (ancho * 0.6)).toFixed(2);
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Ticket</title>
<style>
  @page { size: ${papel} auto; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  pre { font-family: 'Courier New', Courier, monospace; font-size: ${fuenteMm}mm; line-height: 1.2; white-space: pre; width: ${imprimible}mm; margin: 0 auto; padding: 2mm 0 8mm; color: #000; overflow: hidden; }
</style></head><body><pre>${escaparHtml(texto)}</pre></body></html>`;
}

/** "Inversiones Milano S de R.L. - 10 Calle" → "10 Calle": la parte que distingue una sucursal de otra. */
export function nombreCortoSucursal(nombre, alias) {
  if (!nombre) return alias ?? '';
  const partes = String(nombre).split(' - ');
  return partes.length > 1 ? partes.slice(1).join(' - ') : nombre;
}
