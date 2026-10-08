// Etiqueta de tanda como imagen de 2×2" a 203 dpi (406×406 px) para la Munbyn ITPP130B: esa impresora no se maneja
// desde el navegador, solo importa imágenes desde su app, así que se genera el PNG exacto y se comparte.
// Lleva un QR con la dirección de la ficha de trazabilidad de la tanda (escanear una pana abre de dónde salió)
// y el código de lote en texto, para escribirlo a mano si el QR no se lee.
import QRCode from 'qrcode';

export const DPI = 203;
export const LADO_PX = DPI * 2;
const M = 18;

function tamanoQueEntra(ctx, texto, ancho, inicial, minimo) {
  for (let px = inicial; px >= minimo; px -= 2) { ctx.font = `bold ${px}px Arial, sans-serif`; if (ctx.measureText(texto).width <= ancho) return px; }
  return minimo;
}
function enDosRenglones(texto) {
  const p = String(texto || '').trim().split(/\s+/);
  if (p.length < 2) return [texto];
  const medio = Math.round(texto.length / 2);
  let mejor = 1, dist = Infinity, largo = 0;
  for (let i = 0; i < p.length - 1; i++) { largo += p[i].length + 1; const d = Math.abs(largo - medio); if (d < dist) { dist = d; mejor = i + 1; } }
  return [p.slice(0, mejor).join(' '), p.slice(mejor).join(' ')];
}
const cargarImagen = (src) => new Promise((ok, mal) => { const i = new Image(); i.onload = () => ok(i); i.onerror = mal; i.src = src; });

/** Dirección que abre la ficha de la tanda (la usa el QR). */
export const urlFicha = (empresa, lote) => `${location.origin}/${empresa}/gelato-produccion?tab=trazabilidad&lote=${encodeURIComponent(lote)}`;

export async function generarPngEtiqueta(tanda, empresa) {
  const c = document.createElement('canvas');
  c.width = LADO_PX; c.height = LADO_PX;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, LADO_PX, LADO_PX);       // fondo blanco explícito: transparente sale negro en térmica
  ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const centro = LADO_PX / 2, util = LADO_PX - M * 2;

  const yLote = LADO_PX - M - 24;
  let techo = yLote;
  try {
    const qr = await cargarImagen(await QRCode.toDataURL(urlFicha(empresa, tanda.lote), { margin: 0, width: 130, errorCorrectionLevel: 'M' }));
    techo = yLote - 130 - 6;
    ctx.drawImage(qr, centro - 65, techo, 130, 130);
  } catch { /* sin QR la etiqueta sigue sirviendo con el texto */ }

  const renglones = [];
  const nombre = String(tanda.sabor_nombre || '').toUpperCase();
  const una = tamanoQueEntra(ctx, nombre, util, 52, 22);
  if (una <= 26) { const partes = enDosRenglones(nombre); const px = Math.min(...partes.map((r) => tamanoQueEntra(ctx, r, util, 44, 18))); for (const t of partes) renglones.push({ t, px, b: true, e: 2 }); }
  else renglones.push({ t: nombre, px: una, b: true, e: 2 });
  renglones.push({ t: `${Number(tanda.kg)} kg`, px: 32, b: true, e: 6, antes: 6 });
  renglones.push({ t: `Producido ${tanda.fecha}`, px: 20, e: 3 });
  if (tanda.operario) renglones.push({ t: String(tanda.operario), px: 20, e: 3 });
  const alto = renglones.reduce((a, r) => a + (r.antes || 0) + r.px + r.e, 0);
  let y = Math.max(M, M + (techo - M - alto) / 2);
  for (const r of renglones) { y += r.antes || 0; ctx.font = `${r.b ? 'bold ' : ''}${r.px}px Arial, sans-serif`; ctx.fillText(r.t, centro, y); y += r.px + r.e; }
  ctx.font = 'bold 22px Arial, sans-serif';
  ctx.fillText(String(tanda.lote), centro, yLote);
  return new Promise((ok) => c.toBlob(ok, 'image/png'));
}
export const nombreArchivo = (tanda) => `etiqueta-${String(tanda.lote).replace(/[^\w-]/g, '')}.png`;
