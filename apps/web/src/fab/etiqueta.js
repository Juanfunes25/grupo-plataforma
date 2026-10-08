// Etiqueta de lote 4×6" (impresora térmica): lote, QR que abre la ficha de trazabilidad,
// producto, cantidad, fechas, operario. Modo «cajas» = una etiqueta por caja.
import QRCode from 'qrcode';
import { post } from '../api.js';
import { imprimirHtml } from '../lib/documentos.js';
import { cuando, fechaCorta, textoCantidad } from './comun.jsx';

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function paginaHtml(d) {
  const total = d.modo === 'cajas' ? Math.min(Math.max(1, Math.round(d.cantidad)), 500) : 1;
  const filas = [
    ['Producto', d.producto],
    ['Cantidad del lote', textoCantidad(d)],
    ['Producido', cuando(d.producido_at)],
    ['Lista para vender', fechaCorta(d.lista_at ?? d.disponible_desde)],
    ['Operario', d.operario ?? '—'],
    ...(d.molde ? [['Molde', d.molde]] : []),
    ...(d.receta ? [['Mezcla / receta', d.receta]] : []),
    ['Orden de producción', `#${d.orden_numero}`],
  ];
  const paginas = [];
  for (let i = 1; i <= total; i++) {
    const svg = await QRCode.toString(d.modo === 'cajas' ? `${d.url}&caja=${i}` : d.url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    paginas.push(`<section class="et">
      <header><b>ECOSTONE</b><small>TRAZABILIDAD DE LOTE</small>${d.modo === 'cajas' ? `<em>CAJA ${i} / ${total}</em>` : ''}</header>
      <div class="lote"><small>LOTE</small><b>${esc(d.lote)}</b></div>
      <div class="medio"><div class="txt"><b>${esc(d.modelo)}</b><span>${esc(d.color)}</span><small>Escanea el código para ver<br>la trazabilidad completa</small></div><div class="qr">${svg}</div></div>
      <table>${filas.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>
      <footer>${esc(d.empresa.nombre)} · RTN ${esc(d.empresa.rtn ?? '')}</footer>
    </section>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>Etiqueta ${esc(d.lote)}</title><style>
    @page { size: 4in 6in; margin: 0; } * { box-sizing: border-box; } body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #222; }
    .et { width: 4in; height: 6in; padding: 0; position: relative; page-break-after: always; overflow: hidden; }
    header { background: #2b2f33; color: #fff; padding: 12px 16px; border-bottom: 3px solid #4f6b3c; position: relative; }
    header b { font-size: 21px; letter-spacing: 2px; display: block; } header small { font-size: 8px; letter-spacing: 2px; color: #d9cfb8; } header em { position: absolute; right: 16px; top: 16px; font-style: normal; font-weight: 700; font-size: 14px; }
    .lote { padding: 8px 16px 0; } .lote small { font-size: 9px; color: #777; letter-spacing: 1px; } .lote b { display: block; font-size: 29px; }
    .medio { display: flex; justify-content: space-between; gap: 8px; padding: 4px 16px; } .txt b { display: block; font-size: 15px; } .txt span { display: block; font-size: 18px; font-weight: 700; color: #3b5a2a; margin-top: 4px; } .txt small { display: block; margin-top: 34px; font-size: 8px; color: #777; }
    .qr { width: 1.6in; height: 1.6in; } .qr svg { width: 100%; height: 100%; }
    table { margin: 6px 16px 0; width: calc(100% - 32px); border-top: 1px solid #d9cfb8; border-collapse: collapse; } th { text-align: left; font-size: 8px; color: #777; text-transform: uppercase; width: 34%; padding: 5px 0; vertical-align: top; } td { font-size: 11px; font-weight: 600; padding: 5px 0; }
    footer { position: absolute; bottom: 12px; left: 0; right: 0; text-align: center; font-size: 8px; color: #777; }
  </style></head><body>${paginas.join('')}</body></html>`;
}

/** Pide los datos al servidor (cuenta la impresión en bitácora) y manda la etiqueta a imprimir. */
export async function imprimirEtiqueta(codigo, modo = 'lote') {
  const datos = await post(`/fab/trazabilidad/lote/${encodeURIComponent(codigo)}/etiqueta`, { modo });
  await imprimirHtml(await paginaHtml(datos));
  return datos;
}
