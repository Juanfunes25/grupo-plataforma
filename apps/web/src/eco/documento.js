// Cotización de proyecto imprimible (marca EcoStone): se arma como HTML y se abre en otra pestaña para imprimir o «Guardar como PDF».
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const L = (n) => `L ${Number(n || 0).toLocaleString('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (n, d = 2) => Number(n ?? 0).toLocaleString('es-HN', { minimumFractionDigits: 0, maximumFractionDigits: d });
const fecha = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('es-HN', { day: '2-digit', month: 'long', year: 'numeric' }) : '—');

export function htmlCotizacion({ cotizacion: c, calculo: calc, empresa: e, condiciones }) {
  const filas = c.lineas.map((l, i) => {
    const det = l.m2_neto != null && l.cajas != null ? `${num(l.m2_neto, 2)} m² → ${num(l.cajas, 0)} cajas completas` : '';
    const importe = c.isv_incluido ? calc.lineas[i].monto : calc.lineas[i].base;
    return `<tr><td>${esc(l.descripcion)}${det ? `<small>${esc(det)}</small>` : ''}</td><td>${num(l.cantidad, 3)}</td><td>${esc(l.unidad === 'caja' ? 'cajas' : l.unidad)}</td>
      <td>${L(l.precio_unitario)}${Number(l.descuento_pct) ? ` (-${num(l.descuento_pct, 1)}%)` : ''}</td><td>${L(importe)}</td></tr>`;
  }).join('');
  const conAnticipo = Number(c.anticipo_pct) > 0;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Cotización ${esc(c.numero)} — ${esc(e.nombre)}</title>
<style>
 *{box-sizing:border-box} body{font:13px/1.45 'Helvetica Neue',Arial,sans-serif;color:#1c1d1f;margin:0;background:#fff}
 .hoja{max-width:800px;margin:0 auto;padding:0 0 30px}
 .cab{background:#2b2d2f;color:#fff;display:flex;justify-content:space-between;align-items:flex-start;padding:24px 44px;border-bottom:4px solid #5f7a4a}
 .cab h1{margin:0;font-size:28px;letter-spacing:.2em;text-transform:uppercase} .cab small{display:block;color:#e8e0d0;letter-spacing:.3em;font-size:10px}
 .cab .num{text-align:right} .cab .num b{font-size:18px;display:block;letter-spacing:.04em}
 .cuerpo{padding:0 44px}
 .datos{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:20px} .datos b.t{font-size:11px;letter-spacing:.12em;display:block;margin-bottom:4px}
 table{width:100%;border-collapse:collapse;margin-top:16px} th{background:#2b2d2f;color:#fff;font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:8px 10px;text-align:right}
 th:first-child,td:first-child{text-align:left} td{padding:9px 10px;border-bottom:1px solid #e6e3da;text-align:right;vertical-align:top} tr:nth-child(even) td{background:#f4f1ea} td small{display:block;color:#6b6a5e}
 .totales{margin-left:auto;width:290px;margin-top:12px} .totales div{display:flex;justify-content:space-between;padding:3px 0}
 .totales .gran{border-top:2px solid #5f7a4a;margin-top:4px;padding-top:6px;font-size:18px;font-weight:700}
 h2{font-size:11px;letter-spacing:.14em;text-transform:uppercase;margin:22px 0 4px} ul{margin:4px 0 0;padding-left:18px;color:#6b6a5e} li{margin:2px 0}
 .notas{background:#f4f1ea;border-radius:8px;padding:10px 14px;margin-top:12px;white-space:pre-wrap}
 .pie{margin-top:26px;border-top:1px solid #ddd;padding-top:8px;color:#6b6a5e;font-size:11px;text-align:center}
 .barra{position:sticky;top:0;background:#222;color:#fff;padding:8px 16px;display:flex;gap:10px;align-items:center} .barra button{padding:6px 14px;border-radius:6px;border:0;font-weight:700;cursor:pointer}
 @media print{.barra{display:none}} @page{size:letter;margin:0}
</style></head><body>
<div class="barra"><button onclick="window.print()">Imprimir / Guardar como PDF</button><span>Elige «Guardar como PDF» como destino para enviarla al cliente.</span></div>
<div class="hoja">
 <div class="cab"><div><h1>${esc(e.nombre)}</h1><small>PIEDRA DE ENCHAPE</small></div>
  <div class="num"><b>COTIZACIÓN #${esc(c.numero)}</b><span>Emitida: ${fecha(c.created_at)}</span><br><span>Vigencia: ${fecha(c.fecha_vigencia)}</span></div></div>
 <div class="cuerpo">
  <div class="datos">
   <div><b class="t">CLIENTE</b>${[c.nombre_cliente, c.rtn_cliente && `RTN: ${c.rtn_cliente}`, c.telefono && `Tel: ${c.telefono}`, c.email].filter(Boolean).map((x) => `<div>${esc(x)}</div>`).join('')}</div>
   ${c.proyecto || c.direccion_obra || c.fecha_entrega ? `<div><b class="t">PROYECTO</b>${[c.proyecto, c.direccion_obra, c.fecha_entrega && `Entrega estimada: ${fecha(c.fecha_entrega)}`].filter(Boolean).map((x) => `<div>${esc(x)}</div>`).join('')}</div>` : ''}
  </div>
  <table><thead><tr><th>Descripción</th><th>Cant.</th><th>Unidad</th><th>${c.isv_incluido ? 'Precio (c/ISV)' : 'Precio (s/ISV)'}</th><th>Importe</th></tr></thead><tbody>${filas}</tbody></table>
  <div class="totales">
   ${calc.descuento_total > 0 ? `<div><span>${Number(c.descuento_pct) > 0 ? `Descuento ${num(c.descuento_pct, 2)}%` : 'Descuento'}</span><span>- ${L(calc.descuento_total)}</span></div>` : ''}
   <div><span>Subtotal</span><span>${L(calc.subtotal)}</span></div><div><span>ISV 15%</span><span>${L(calc.isv)}</span></div>
   <div class="gran"><span>TOTAL</span><span>${L(calc.total)}</span></div>
   ${conAnticipo ? `<div><span>Anticipo ${num(c.anticipo_pct, 0)}%</span><span>${L(c.anticipo_monto)}</span></div><div><span>Saldo contra entrega</span><span>${L(c.saldo_monto)}</span></div>` : ''}
  </div>
  <h2>Condiciones</h2><ul>${(condiciones ?? []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
  ${c.notas ? `<div class="notas"><b>Notas</b><br>${esc(c.notas)}</div>` : ''}
  <div class="pie">${esc(e.razon_social ?? e.nombre)}${e.rtn ? ` · RTN ${esc(e.rtn)}` : ''}${e.ciudad ? ` · ${esc(e.ciudad)}` : ''}${e.telefono ? ` · Tel. ${esc(e.telefono)}` : ''}</div>
 </div>
</div></body></html>`;
}

/** Abre la cotización en otra pestaña lista para imprimir. Devuelve false si el navegador bloqueó la ventana. */
export function abrirDocumento(datos) {
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.open(); w.document.write(htmlCotizacion(datos)); w.document.close();
  return true;
}

export function enlaceCorreo(c, empresaNombre, total) {
  const asunto = `Cotización #${c.numero} — ${c.proyecto || c.nombre_cliente} — ${empresaNombre}`;
  const cuerpo = `Hola, ${String(c.nombre_cliente).split(' ')[0]}:\n\nGracias por considerarnos${c.proyecto ? ` para ${c.proyecto}` : ''}. Te compartimos la cotización #${c.numero} por ${L(total ?? c.total)}.\n(Adjunta el PDF: Imprimir → Guardar como PDF.)\n\nQuedamos atentos.\n${empresaNombre}`;
  return `mailto:${encodeURIComponent(c.email ?? '')}?subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent(cuerpo)}`;
}
