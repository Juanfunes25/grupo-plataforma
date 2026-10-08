// Cotización DISERCO imprimible (HTML que el navegador imprime o guarda como PDF). Dos formatos, como los de la app original:
//  · proyecto: tabla Área × Valor por m², secciones de texto y firma.
//  · productos: Cantidad / Presentación / P. unitario, rendimientos e información bancaria.
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const L = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cant = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 });
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function partes(iso) {
  const [a, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Tegucigalpa' }).format(new Date(iso)).split('-').map(Number);
  return { a, m: MESES[m - 1], d, dia: DIAS[new Date(Date.UTC(a, m - 1, d, 12)).getUTCDay()] };
}
export const fechaProyecto = (iso) => { const f = partes(iso); return `San Pedro Sula, ${f.d} de ${f.m[0].toUpperCase()}${f.m.slice(1)} del ${f.a}`; };
export const fechaProductos = (iso) => { const f = partes(iso); return `${f.dia} ${f.d} de ${f.m} de ${f.a}`; };

export function htmlCotizacion({ cotizacion: c, config: cfg }) {
  const proy = c.tipo === 'proyecto';
  const bruto = c.lineas.reduce((s, l) => s + l.cantidad * l.precio_unitario, 0);
  const desc = Number(c.descuento_pct) > 0 ? Math.round(bruto * Number(c.descuento_pct)) / 100 : 0;
  const tot = [];
  if (desc > 0.004) tot.push([proy ? 'Descuento' : 'DESCUENTO', -desc]);
  tot.push([proy ? 'Sub total' : 'SUB TOTAL', c.subtotal], [proy ? 'ISV' : 'IMPUESTO', c.isv]);
  if (proy) tot.push(['Total', c.total]);
  const filas = c.lineas.map((l, i) => {
    const m = /^([^.]{4,90}\.)\s([\s\S]*)$/.exec(l.descripcion);
    const d = proy && m ? `<b>${esc(m[1])}</b> ${esc(m[2])}` : esc(l.descripcion);
    return proy
      ? `<tr><td class="c">${i + 1}</td><td class="d">${d}</td><td class="c">${cant(l.cantidad)}</td><td class="c">${esc(l.unidad)}</td><td class="r">L ${L(l.precio_unitario)}</td><td class="r">L ${L(l.cantidad * l.precio_unitario)}</td></tr>`
      : `<tr><td class="d">${d}</td><td class="c">${cant(l.cantidad)}</td><td class="c">${esc(l.presentacion || l.unidad)}</td><td class="r">L ${L(l.precio_unitario)}</td><td class="r">L ${L(l.cantidad * l.precio_unitario)}</td></tr>`;
  }).join('');
  const encabezado = proy
    ? '<tr><th></th><th>DESCRIPCIÓN</th><th>Área</th><th>Unidad</th><th>Valor x m2</th><th>TOTAL</th></tr>'
    : '<tr><th class="izq">DESCRIPCIÓN</th><th>CANTIDAD</th><th>PRESENTACIÓN</th><th>P/ UNITARIO</th><th>SUBTOTAL</th></tr>';
  const datos = proy
    ? `<p class="fecha">${esc(fechaProyecto(c.created_at))}</p>${[['Proyecto:', c.proyecto], ['Cliente:', c.nombre_cliente], ['Ubicación :', c.ubicacion]].filter((x) => x[1]).map(([k, v]) => `<div class="dato"><span>${k}</span>${esc(v)}</div>`).join('')}`
    : `<div class="dato"><span>San Pedro Sula,</span>${esc(fechaProductos(c.created_at))}</div><br>
       <div class="dato"><span>Para:</span>${esc(c.contacto || c.nombre_cliente)}</div>
       ${c.contacto && c.contacto !== c.nombre_cliente ? `<div class="dato"><span>Empresa:</span>${esc(c.nombre_cliente)}</div>` : ''}
       ${c.rtn_cliente ? `<div class="dato"><span>RTN:</span>${esc(c.rtn_cliente)}</div>` : ''}${c.telefono ? `<div class="dato"><span>Cel:</span>${esc(c.telefono)}</div>` : ''}`;
  const secciones = (c.secciones ?? []).filter((s) => s.titulo || s.texto).map((s) => `<div class="sec">${s.titulo ? `<b>${esc(String(s.titulo).toUpperCase())}</b>` : ''}<div>${esc(s.texto)}</div></div>`).join('');
  const pie = proy
    ? (c.firma_nombre ? `<div class="firma"><b>${esc(c.firma_nombre)}</b><br>${esc(c.firma_cargo ?? '')}</div>` : '')
    : `<p class="vig">Cotización válida por ${c.vigencia_dias} días</p>
       <div class="banco"><div>${c.mostrar_bancos ? `<b>INFORMACIÓN BANCARIA</b><br>${esc(cfg.nombreCheques)}<br>${cfg.bancos.map((b) => `${esc(b.banco)} ${esc(b.cuenta)} <i>cheque lempiras</i>`).join('<br>')}` : ''}</div><div class="gran"><b>TOTAL</b><span>L ${L(c.total)}</span></div></div>`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Cotización ${esc(c.codigo)} — DISERCO</title>
<style>
 *{box-sizing:border-box} body{font:12px/1.4 'Helvetica Neue',Arial,sans-serif;color:#111;margin:0;background:#fff}
 .hoja{max-width:780px;margin:0 auto;padding:34px 44px 70px;position:relative}
 .cab{display:flex;justify-content:space-between;align-items:flex-start} .cab h1{margin:0;font-size:22px} .cab .no{color:${cfg.naranja};font-weight:700;font-size:14px}
 .cab img{height:92px}
 .fecha{margin:20px 0 14px} .dato{margin:2px 0} .dato span{display:inline-block;min-width:92px}
 table{width:100%;border-collapse:collapse;margin-top:18px} td,th{padding:5px 6px;vertical-align:middle}
 ${proy ? `th{background:${cfg.naranja};color:#fff;font-size:11px} td{border:1px solid #333} th:first-child{background:none}` : `th{font-weight:400;font-size:10px;border-bottom:2px solid ${cfg.naranja};text-align:center} tbody td{padding:7px 6px}`}
 th.izq{text-align:left} td.c{text-align:center} td.r{text-align:right;white-space:nowrap} td.d{white-space:pre-wrap}
 .tot{margin:10px 0 0 auto;width:230px} .tot div{display:flex;justify-content:space-between;padding:2px 0}
 ${proy ? `.tot div b{background:${cfg.naranja};color:#fff;padding:2px 8px;min-width:78px;text-align:center}` : `.tot div b{color:${cfg.naranja}}`}
 .sec{margin:14px 0 0;white-space:pre-wrap} .sec b{display:block;margin-bottom:2px}
 .firma{margin-top:30px} .vig{color:${cfg.naranja};font-weight:700;margin-top:22px}
 .banco{display:flex;justify-content:space-between;gap:20px;border-top:2px solid #111;border-bottom:2px solid #111;padding:8px 0;margin-top:6px;font-size:11px}
 .banco .gran{text-align:right;min-width:150px} .banco .gran b{display:block;color:${cfg.naranja};font-size:16px} .banco .gran span{font-weight:700;font-size:14px}
 .pie{margin-top:40px;border-top:2px solid ${cfg.naranja};padding-top:6px;font-size:10px;color:#555;display:flex;justify-content:space-between;gap:10px} .pie b{color:${cfg.naranja};font-size:13px;font-weight:500}
 .barra{position:sticky;top:0;background:#222;color:#fff;padding:8px 16px;display:flex;gap:10px;align-items:center} .barra button{padding:6px 14px;border-radius:6px;border:0;font-weight:700;cursor:pointer}
 @media print{.barra{display:none}.hoja{padding:0}} @page{size:letter;margin:14mm}
</style></head><body>
<div class="barra"><button onclick="window.print()">Imprimir / Guardar como PDF</button><span>Elige «Guardar como PDF» como destino para enviarla al cliente.</span></div>
<div class="hoja">
 <div class="cab"><div><h1>COTIZACIÓN</h1><div class="no">No. ${esc(c.codigo)}</div></div><img src="/logos/diserco.png" alt="DISERCO" onerror="this.style.display='none'"></div>
 ${datos}
 <table><thead>${encabezado}</thead><tbody>${filas}</tbody></table>
 <div class="tot">${tot.map(([et, v]) => `<div><b>${et}</b><span>L ${L(v)}</span></div>`).join('')}</div>
 ${secciones}${pie}
 <div class="pie"><span>${esc(cfg.direccion)}   Tel: ${esc(cfg.telefono)}</span><b>${esc(cfg.web)}</b></div>
</div></body></html>`;
}

/** Abre una pestaña en el mismo toque del clic (esquiva el bloqueador) y luego se escribe en ella con escribirDocumento. */
export function abrirVentana() {
  const w = window.open('', '_blank');
  if (w) { w.document.title = 'Cargando…'; w.document.body.textContent = 'Cargando cotización…'; }
  return w;
}
export function escribirDocumento(w, datos) {
  w.document.open();
  w.document.write(htmlCotizacion(datos));
  w.document.close();
}
