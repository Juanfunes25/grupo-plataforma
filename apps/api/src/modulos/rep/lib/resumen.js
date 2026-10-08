// Resumen diario «lista de envíos»: el contenido queda listo (texto y HTML) aunque el servidor
// no tenga correo configurado. Portado de lib/resumen.js del original.

export function armarResumen({ fecha, filas, alertas = [] }) {
  const porSucursal = {};
  const ordenadas = [...filas].sort((a, b) => a.sucursal_nombre.localeCompare(b.sucursal_nombre) || b.categoria.localeCompare(a.categoria) || a.sabor_nombre.localeCompare(b.sabor_nombre));
  for (const f of ordenadas) {
    if (!porSucursal[f.sucursal_id]) porSucursal[f.sucursal_id] = { nombre: f.sucursal_nombre, roja: [], amarilla: [] };
    porSucursal[f.sucursal_id][f.categoria].push({ nombre: f.sabor_nombre, gramosEnviados: f.gramos_enviados, estado: f.estado });
  }
  const discrepancias = filas.filter((f) => f.discrepancia).map((f) => ({ sucursal: f.sucursal_nombre, sabor: f.sabor_nombre, enviado: f.gramos_enviados, recibido: f.gramos_confirmados_recibidos }));
  return { fecha, porSucursal, totalDespachos: filas.length, discrepancias, alertasInv: alertas };
}

export function formatearResumenTexto(resumen) {
  const lineas = [`Lista de envíos para hoy - ${resumen.fecha}`, '='.repeat(50), ''];
  for (const sucursal of Object.values(resumen.porSucursal)) {
    lineas.push(`SUCURSAL: ${sucursal.nombre}`, '-'.repeat(40));
    if (sucursal.roja.length) {
      lineas.push('ENVIAR 2 PANAS:');
      for (const item of sucursal.roja) lineas.push(`  - ${item.nombre} (${item.gramosEnviados}g)`);
    }
    if (sucursal.amarilla.length) {
      lineas.push('ENVIAR 1 PANA:');
      for (const item of sucursal.amarilla) lineas.push(`  - ${item.nombre} (${item.gramosEnviados}g)`);
    }
    lineas.push('');
  }
  if (resumen.discrepancias.length) {
    lineas.push('DISCREPANCIAS DETECTADAS:', '-'.repeat(40));
    for (const d of resumen.discrepancias) lineas.push(`  - ${d.sucursal} / ${d.sabor}: enviado ${d.enviado}g, recibido ${d.recibido}g`);
    lineas.push('');
  }
  if (resumen.alertasInv?.length) {
    lineas.push('ALERTAS DE INVENTARIO:', '-'.repeat(40));
    for (const a of resumen.alertasInv) lineas.push(`  - ${a}`);
    lineas.push('');
  }
  lineas.push('Generado automáticamente desde la Plataforma del Grupo.');
  return lineas.join('\n');
}

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function formatearResumenHtml(resumen) {
  const bloque = (titulo, items, color) => items.length
    ? `<p style="margin:8px 0 4px;color:${color};font-weight:bold;">${titulo}</p><ul style="margin:0 0 8px;padding-left:20px;">${items.map((i) => `<li>${esc(i.nombre)} (${i.gramosEnviados}g)</li>`).join('')}</ul>` : '';
  const seccion = (s) => `
      <div style="background:#262220;border-radius:8px;padding:16px;margin-bottom:12px;">
        <h3 style="margin:0 0 8px;color:#d4af37;">${esc(s.nombre)}</h3>
        ${bloque('🔴 ENVIAR 2 PANAS', s.roja, '#e0483f')}
        ${bloque('🟡 ENVIAR 1 PANA', s.amarilla, '#e0b23f')}
      </div>`;
  const disc = resumen.discrepancias.length
    ? `<div style="background:#3a1f1f;border-radius:8px;padding:16px;margin-top:16px;"><h3 style="margin:0 0 8px;color:#e0483f;">⚠️ Discrepancias</h3><ul style="margin:0;padding-left:20px;">${resumen.discrepancias.map((d) => `<li>${esc(d.sucursal)} / ${esc(d.sabor)}: enviado ${d.enviado}g, recibido ${d.recibido}g</li>`).join('')}</ul></div>` : '';
  const alertas = resumen.alertasInv?.length
    ? `<div style="background:#3a321f;border-radius:8px;padding:16px;margin-top:16px;"><h3 style="margin:0 0 8px;color:#e0b23f;">Alertas de inventario</h3><ul style="margin:0;padding-left:20px;">${resumen.alertasInv.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>` : '';
  return `
    <div style="background:#1a1a1a;color:#f2ede6;font-family:system-ui,sans-serif;padding:24px;">
      <h2 style="color:#d4af37;">Lista de envíos para hoy - ${esc(resumen.fecha)}</h2>
      ${Object.values(resumen.porSucursal).map(seccion).join('')}
      ${disc}${alertas}
      <p style="color:#a89f92;font-size:0.85em;margin-top:16px;">Generado automáticamente desde la Plataforma del Grupo.</p>
    </div>`;
}
