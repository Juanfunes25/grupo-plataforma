// Cotización imprimible: se arma como HTML aparte y se abre en otra pestaña para imprimir o «Guardar como PDF».
// (El PDF del servidor de Italo Facturación usaba pdfkit; aquí el navegador hace el PDF sin dependencias.)
import { horaCorta, numCot } from './reglas.js';

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const L = (n) => `L ${Number(n || 0).toLocaleString('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fechaCorta = (iso) => new Date(iso).toLocaleDateString('es-HN', { timeZone: 'America/Tegucigalpa', day: 'numeric', month: 'long', year: 'numeric' });
function fechaLargaDoc(f) {
  if (!f) return 'Por confirmar';
  const t = new Date(`${f}T12:00:00Z`).toLocaleDateString('es-HN', { timeZone: 'America/Tegucigalpa', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function htmlCotizacion({ cotizacion: c, empresa: e, emitida_at, valida_hasta, condiciones }) {
  const filas = [];
  if (c.cantidad_copitas > 0) filas.push([`Copitas de gelato artesanal`, 'Porción individual en copita, sabores a elección.', Number(c.cantidad_copitas).toLocaleString('es-HN'), L(c.precio_copita), c.cantidad_copitas * c.precio_copita]);
  if (c.costo_servicio > 0) filas.push(['Servicio para el evento', 'Montaje, atención a los invitados y desmontaje por nuestro equipo.', '1', L(c.costo_servicio), c.costo_servicio]);
  for (const p of c.partidas ?? []) filas.push([p.descripcion, '', Number(p.cantidad).toLocaleString('es-HN'), L(p.precio_unitario), p.cantidad * p.precio_unitario]);
  const porCopita = c.cantidad_copitas > 0 ? c.total / c.cantidad_copitas : 0;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Cotización ${numCot(c)} — ${esc(c.nombre_evento)}</title>
<style>
 *{box-sizing:border-box} body{font:13px/1.45 'Helvetica Neue',Arial,sans-serif;color:#1c1c18;margin:0;background:#fff}
 .hoja{max-width:800px;margin:0 auto;padding:36px 44px}
 .cab{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:4px solid #c5603c;padding-bottom:14px}
 .cab h1{margin:0;font-size:26px;letter-spacing:.06em;text-transform:uppercase} .cab small{color:#6b6a5e;display:block}
 .num{text-align:right} .num b{font-size:22px;display:block}
 h2{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6b6a5e;margin:22px 0 6px}
 .tarjetas{display:grid;grid-template-columns:1fr 1fr;gap:14px} .t{border:1px solid #ddd;border-radius:8px;padding:10px 14px} .t b{font-size:15px;display:block;margin-bottom:3px}
 table{width:100%;border-collapse:collapse;margin-top:6px} th{background:#2b2b26;color:#fff;font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:8px 10px;text-align:right}
 th:first-child,td:first-child{text-align:left} td{padding:9px 10px;border-bottom:1px solid #e6e3da;text-align:right;vertical-align:top} td small{display:block;color:#6b6a5e}
 .totales{margin-left:auto;width:260px;margin-top:12px} .totales div{display:flex;justify-content:space-between;padding:3px 0}
 .totales .gran{background:#1c1c18;color:#fff;border-radius:8px;padding:10px 14px;margin-top:6px;font-size:18px;font-weight:700}
 .totales small{color:#6b6a5e;display:block;text-align:right}
 ul{margin:4px 0 0;padding-left:18px} li{margin:3px 0}
 .notas{background:#f4f1ea;border-radius:8px;padding:10px 14px;margin-top:14px;white-space:pre-wrap}
 .firmas{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:46px} .firmas div{border-top:1px solid #999;padding-top:4px;font-size:11px;color:#6b6a5e}
 .pie{margin-top:26px;border-top:1px solid #ddd;padding-top:8px;color:#6b6a5e;font-size:11px;text-align:center}
 .barra{position:sticky;top:0;background:#222;color:#fff;padding:8px 16px;display:flex;gap:10px;align-items:center} .barra button{padding:6px 14px;border-radius:6px;border:0;font-weight:700;cursor:pointer}
 @media print{.barra{display:none}.hoja{padding:0}} @page{size:letter;margin:16mm}
</style></head><body>
<div class="barra"><button onclick="window.print()">Imprimir / Guardar como PDF</button><span>Elige «Guardar como PDF» como destino para enviarla al cliente.</span></div>
<div class="hoja">
 <div class="cab"><div><h1>${esc(e.nombre)}</h1><small>${esc(e.razon_social ?? '')}${e.rtn ? ` · RTN ${esc(e.rtn)}` : ''}</small><small>${esc([e.direccion, e.ciudad].filter(Boolean).join(', '))}</small><small>${esc([e.telefono, e.correo].filter(Boolean).join(' · '))}</small></div>
  <div class="num"><small>COTIZACIÓN DE EVENTO</small><b>No. ${numCot(c)}</b><small>Emitida: ${fechaCorta(emitida_at)}</small><small>Válida hasta: ${fechaCorta(valida_hasta)}</small></div></div>
 <h2>Hola, ${esc(String(c.nombre_cliente).split(' ')[0])}</h2>
 <div>Gracias por pensar en ${esc(e.nombre)} para tu evento. Esta es nuestra propuesta${e.lema ? ` — ${esc(e.lema.toLowerCase())}` : ''}.</div>
 <div class="tarjetas" style="margin-top:14px">
  <div class="t"><small>PREPARADA PARA</small><b>${esc(c.nombre_cliente)}</b>${[c.telefono_cliente && `Tel. ${c.telefono_cliente}`, c.email_cliente, c.rtn_cliente && `RTN ${c.rtn_cliente}`].filter(Boolean).map((x) => `<div>${esc(x)}</div>`).join('')}</div>
  <div class="t"><small>TU EVENTO</small><b>${esc(c.nombre_evento)}</b><div>${esc([fechaLargaDoc(c.fecha_evento), horaCorta(c.hora_evento)].filter(Boolean).join(' · '))}</div>${c.lugar ? `<div>${esc(c.lugar)}</div>` : ''}<div>${Number(c.cantidad_copitas).toLocaleString('es-HN')} copitas de gelato</div></div>
 </div>
 <table><thead><tr><th>Descripción</th><th>Cant.</th><th>Precio</th><th>Total</th></tr></thead><tbody>
  ${filas.map((f) => `<tr><td>${esc(f[0])}${f[1] ? `<small>${esc(f[1])}</small>` : ''}</td><td>${esc(f[2])}</td><td>${esc(f[3])}</td><td>${L(f[4])}</td></tr>`).join('')}
 </tbody></table>
 <div class="totales"><div><span>Subtotal</span><span>${L(c.subtotal)}</span></div>${c.descuento > 0 ? `<div><span>Descuento</span><span>− ${L(c.descuento)}</span></div>` : ''}
  <div class="gran"><span>TOTAL</span><span>${L(c.total)}</span></div><small>ISV incluido</small>${porCopita > 0 ? `<small>Equivale a ${L(porCopita)} por copita</small>` : ''}
  ${c.anticipo > 0 ? `<div style="margin-top:8px"><span>Anticipo recibido</span><span>${L(c.anticipo)}</span></div><div><b>Saldo pendiente</b><b>${L(Math.max(0, c.total - c.anticipo))}</b></div>` : ''}</div>
 <h2>Condiciones</h2><ul>${(condiciones ?? []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
 ${c.notas ? `<div class="notas"><b>Notas</b><br>${esc(c.notas)}</div>` : ''}
 <div class="firmas"><div>Aceptación del cliente (firma y fecha)</div><div>Atendido por: ${esc(c.atendido_por ?? `Equipo ${e.nombre}`)}</div></div>
 <div class="pie">${esc(e.nombre)}${e.web ? ` · ${esc(e.web)}` : ''}${e.telefono ? ` · Tel. / WhatsApp ${esc(e.telefono)}` : ''}</div>
</div></body></html>`;
}

/** Abre la cotización en otra pestaña lista para imprimir. Devuelve false si el navegador bloqueó la ventana. */
export function abrirDocumento(datos) {
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.open();
  w.document.write(htmlCotizacion(datos));
  w.document.close();
  return true;
}
