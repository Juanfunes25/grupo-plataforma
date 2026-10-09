// Impresión de tickets y facturas. La configuración de impresora es POR COMPUTADORA/CAJA (cada sucursal puede tener una distinta),
// por eso vive en el navegador y no en la base de datos.
import { envolverTicketHtml, PAPELES } from '@grupo/shared';
import { almacen, empresaActual, get, qs } from '../api.js';

export { PAPELES };
const CLAVE = 'grupo.impresora';
const DEFECTO = { columnas: 48, autoImprimir: true, logo: true };

export function leerConfigImpresora() {
  try { return { ...DEFECTO, ...(JSON.parse(localStorage.getItem(CLAVE) ?? 'null') ?? {}) }; } catch { return { ...DEFECTO }; }
}
export function guardarConfigImpresora(config) {
  try { localStorage.setItem(CLAVE, JSON.stringify(config)); } catch { /* modo privado: se usa la de fábrica */ }
}

/** Logo de la empresa activa para el ticket (`/logos/<codigo>.png`, en blanco y negro). Si el archivo no existe, la página lo quita sola. */
export function logoDelTicket() {
  const emp = empresaActual();
  if (!leerConfigImpresora().logo || !emp || emp === 'grupo' || typeof window === 'undefined') return null;
  return `${window.location.origin}/logos/${emp}.png`;
}

/**
 * Imprime HTML en un iframe invisible de la misma página: no abre pestañas ni lo frena el bloqueador de ventanas.
 * Con Chrome abierto con --kiosk-printing imprime directo en la térmica sin diálogo. Espera a que carguen las imágenes (logo).
 */
export function imprimirHtml(html) {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    let listo = false;
    const limpiar = () => { if (listo) return; listo = true; setTimeout(() => iframe.remove(), 500); resolve(); };
    iframe.onload = async () => {
      const w = iframe.contentWindow;
      const imgs = [...w.document.images].filter((i) => !i.complete);
      if (imgs.length) await Promise.race([Promise.all(imgs.map((i) => new Promise((r) => { i.onload = r; i.onerror = r; }))), new Promise((r) => setTimeout(r, 2000))]);
      w.addEventListener('afterprint', limpiar);
      w.focus(); w.print();
      setTimeout(limpiar, 60_000);
    };
    iframe.srcdoc = html;
    document.body.appendChild(iframe);
  });
}

/** Imprime renglones de ticket ya armados (comprobante provisional sin conexión, cierre de caja) con el ancho y el logo de esta caja. */
export function imprimirLineas(lineas, { logo = true } = {}) {
  const { columnas } = leerConfigImpresora();
  return imprimirHtml(envolverTicketHtml(lineas.join('\n'), columnas, { logo: logo ? logoDelTicket() : null }));
}

/**
 * Imprime el ticket de una factura. La 1.ª vez sale original; toda otra sale COPIA #n (lo decide el servidor).
 * `razon` es el motivo de la reimpresión (queda en la bitácora). Devuelve el número de copia (0 = original).
 */
export async function imprimirTicket(ventaId, { reimpresion = false, razon } = {}) {
  const { columnas } = leerConfigImpresora();
  const r = await get(`/pos/ventas/${ventaId}/ticket${qs({ columnas, motivo: reimpresion ? 'reimpresion' : '', razon: reimpresion ? razon : '' })}`);
  await imprimirHtml(envolverTicketHtml(r.lineas.join('\n'), columnas, { logo: logoDelTicket() }));
  return r.copia ?? 0;
}

export async function imprimirPrueba(sucursalId) {
  const { columnas } = leerConfigImpresora();
  const r = await get(`/pos/ventas/impresora/prueba${qs({ columnas, sucursal_id: sucursalId })}`);
  await imprimirHtml(envolverTicketHtml(r.lineas.join('\n'), columnas, { logo: logoDelTicket() }));
}

// ── PDF ─────────────────────────────────────────────────────────────────────
// Los PDF requieren el token en el encabezado, así que NO se pueden abrir con un <a href> directo: se piden con fetch y se
// muestran/descargan desde un blob.
async function pedirPdf(ruta) {
  const s = almacen.leer();
  const h = { authorization: `Bearer ${s?.token ?? ''}` };
  const emp = empresaActual();
  if (emp && emp !== 'grupo') h['x-empresa'] = emp;
  let r;
  try { r = await fetch(`/api${ruta}`, { headers: h }); } catch { throw new Error('Sin conexión con el servidor. Revisa tu internet e intenta de nuevo.'); }
  if (!r.ok) {
    let msg = `Error ${r.status}`;
    try { msg = (await r.json()).error ?? msg; } catch { /* sin cuerpo */ }
    throw new Error(msg);
  }
  return new Blob([await r.blob()], { type: 'application/pdf' });
}

/** Abre la factura en PDF en otra pestaña. La ventana se abre en el mismo toque (antes del await) para esquivar el bloqueador. */
export async function verPdf(ventaId) {
  const ventana = window.open('', '_blank');
  if (ventana) { ventana.document.title = 'Cargando…'; ventana.document.body.style.cssText = 'font-family:sans-serif;padding:32px;color:#555'; ventana.document.body.textContent = 'Cargando documento…'; }
  try {
    const url = URL.createObjectURL(await pedirPdf(`/pos/ventas/${ventaId}/pdf`));
    if (ventana) ventana.location.href = url; else window.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
  } catch (e) { ventana?.close(); throw e; }
}

export async function descargarPdf(ventaId, nombreArchivo) {
  const url = URL.createObjectURL(await pedirPdf(`/pos/ventas/${ventaId}/pdf`));
  const a = Object.assign(document.createElement('a'), { href: url, download: nombreArchivo });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
