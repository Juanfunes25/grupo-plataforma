import { fechaHN, lempiras, sumarDias, sumarPorBucket, BUCKETS_ANTIGUEDAD } from '@grupo/shared';
import { cuentasPorCobrar } from './cxc.js';

const r2 = (n) => Math.round(n * 100) / 100;
const fechaDe = (ts) => (ts ? new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/Tegucigalpa' }) : null);

/**
 * Datos del estado de cuenta de UN cliente en UNA empresa (EcoStone o DISERCO): cotizaciones aprobadas / facturadas con sus pagos,
 * facturas emitidas, saldo y antigüedad (misma función de la base que usa el tablero).
 */
export async function datosEstadoCuenta(q, { empresa, terceroId, hoy = fechaHN(), desdeDias = 365 }) {
  const t = (await q.query('select id, nombre, nombre_comercial, rtn, direccion from core.terceros where id = $1', [terceroId])).rows[0];
  if (!t) return null;
  const e = (await q.query('select nombre, razon_social, rtn, direccion, telefono, correo from core.empresas where id = $1', [empresa.id])).rows[0];
  const desde = sumarDias(hoy, -desdeDias);
  const pendientes = await cuentasPorCobrar(q, { empresaIds: [empresa.id], hoy, tercero: terceroId });
  const clave = (o, id) => `${o}:${id}`;
  const pend = new Map(pendientes.map((p) => [clave(p.origen, p.documento_id), p]));

  const docs = [];
  const eco = await q.query(
    `select c.id, 'COT-' || c.numero as documento, c.proyecto, c.estado, c.total, c.anticipo_pct, coalesce(c.aprobada_at, c.created_at) as fecha, v.numero_factura, v.es_borrador_fiscal
       from eco.cotizaciones c left join pos.ventas v on v.id = c.venta_id
      where c.empresa_id = $1 and c.cliente_id = $2 and c.estado in ('aprobada','facturada') and (c.estado = 'aprobada' or coalesce(c.aprobada_at, c.created_at) >= $3::date) order by 6`, [empresa.id, terceroId, desde]);
  for (const c of eco.rows) {
    const pagos = (await q.query(`select p.created_at, p.tipo, f.nombre as forma, p.monto, p.referencia from eco.cotizacion_pagos p join pos.formas_pago f on f.id = p.forma_pago_id where p.cotizacion_id = $1 order by p.created_at`, [c.id])).rows;
    docs.push({ origen: 'eco', documento_id: c.id, documento: c.documento, proyecto: c.proyecto, estado: c.estado, fecha: fechaDe(c.fecha), total: Number(c.total), factura: c.numero_factura, factura_borrador: c.es_borrador_fiscal,
      pagos: pagos.map((p) => ({ fecha: fechaDe(p.created_at), concepto: p.tipo === 'anticipo' ? 'Anticipo' : 'Pago', forma: p.forma, monto: Number(p.monto), referencia: p.referencia, factura: c.numero_factura })) });
  }
  const dis = await q.query(
    `select c.id, c.codigo as documento, c.proyecto, c.estado, c.total, coalesce(c.aprobada_at, c.created_at) as fecha
       from dis.cotizaciones c where c.empresa_id = $1 and c.cliente_id = $2 and c.estado in ('aprobada','facturada') and (c.estado = 'aprobada' or coalesce(c.aprobada_at, c.created_at) >= $3::date) order by 6`, [empresa.id, terceroId, desde]);
  for (const c of dis.rows) {
    const pagos = (await q.query(
      `select g.created_at, g.concepto, f.nombre as forma, g.monto, g.referencia, v.numero_factura, v.es_borrador_fiscal from dis.cotizacion_pagos g join pos.formas_pago f on f.id = g.forma_pago_id
         left join pos.ventas v on v.id = g.venta_id where g.cotizacion_id = $1 and not g.anulado order by g.created_at`, [c.id])).rows;
    docs.push({ origen: 'dis', documento_id: c.id, documento: c.documento, proyecto: c.proyecto, estado: c.estado, fecha: fechaDe(c.fecha), total: Number(c.total), factura: null, factura_borrador: pagos.some((p) => p.es_borrador_fiscal),
      pagos: pagos.map((p) => ({ fecha: fechaDe(p.created_at), concepto: p.concepto, forma: p.forma, monto: Number(p.monto), referencia: p.referencia, factura: p.numero_factura })) });
  }
  for (const d of docs) {
    d.pagado = r2(d.pagos.reduce((s, p) => s + p.monto, 0));
    const p = pend.get(clave(d.origen, d.documento_id));
    d.saldo = p ? p.saldo : r2(Math.max(0, d.total - d.pagado));
    d.vencimiento = p?.fecha_vencimiento ?? null; d.dias_atraso = p?.dias_atraso ?? 0; d.bucket = p?.bucket ?? null; d.vencido = p?.vencido ?? false;
  }
  docs.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
  const saldo = r2(docs.reduce((s, d) => s + d.saldo, 0));
  const cred = pendientes[0];
  const limite = cred?.limite_credito ?? (empresa.modulos.includes('fabrica')
    ? Number((await q.query('select limite_credito from eco.cliente_ext where tercero_id = $1', [terceroId])).rows[0]?.limite_credito ?? 0)
    : Number((await q.query('select limite_credito from crm.credito_cliente where empresa_id = $1 and tercero_id = $2', [empresa.id, terceroId])).rows[0]?.limite_credito ?? 0));
  return {
    fecha: hoy, empresa: e, cliente: t, documentos: docs,
    resumen: { documentos: docs.length, total: r2(docs.reduce((s, d) => s + d.total, 0)), pagado: r2(docs.reduce((s, d) => s + d.pagado, 0)), saldo, antiguedad: sumarPorBucket(pendientes), vencido: r2(pendientes.filter((p) => p.vencido).reduce((s, p) => s + p.saldo, 0)) },
    credito: { limite, usado: saldo, excede: limite > 0 && saldo > limite },
    hay_borrador: docs.some((d) => d.factura_borrador),
  };
}

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtFecha = (f) => (f ? f.split('-').reverse().join('/') : '');

/** HTML imprimible (Carta, también sirve para «guardar como PDF» o adjuntar a un correo de Mensajería). */
export function htmlEstadoCuenta(d) {
  const filas = d.documentos.map((doc) => {
    const pagos = doc.pagos.map((p) => `<tr class="pago"><td>${fmtFecha(p.fecha)}</td><td colspan="2">${esc(p.concepto)} · ${esc(p.forma)}${p.referencia ? ` · ref. ${esc(p.referencia)}` : ''}${p.factura ? ` · factura ${esc(p.factura)}` : ''}</td><td></td><td class="der">${lempiras(p.monto)}</td><td></td></tr>`).join('');
    return `<tr class="doc"><td>${fmtFecha(doc.fecha)}</td><td><b>${esc(doc.documento)}</b></td><td>${esc(doc.proyecto || '—')}</td><td class="der">${lempiras(doc.total)}</td><td class="der">${lempiras(doc.pagado)}</td><td class="der"><b>${lempiras(doc.saldo)}</b>${doc.vencido ? `<small class="mal"> vencido ${doc.dias_atraso} d</small>` : ''}</td></tr>${pagos}`;
  }).join('');
  const a = d.resumen.antiguedad;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Estado de cuenta · ${esc(d.cliente.nombre)}</title>
<style>
@page { size: letter; margin: 14mm; }
* { box-sizing: border-box; } body { font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #1c1917; margin: 0; padding: 20px; background: #fff; }
h1 { font-size: 20px; margin: 0 0 2px; } h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #57534e; margin: 22px 0 6px; }
.cab { display: flex; justify-content: space-between; gap: 16px; border-bottom: 2px solid #1c1917; padding-bottom: 10px; flex-wrap: wrap; } .cab small, .mut { color: #57534e; }
.cli { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; margin-top: 12px; }
table { width: 100%; border-collapse: collapse; } th { text-align: left; font-size: 11px; text-transform: uppercase; color: #57534e; border-bottom: 1px solid #a8a29e; padding: 5px 6px; }
td { padding: 5px 6px; border-bottom: 1px solid #e7e5e4; vertical-align: top; } .der { text-align: right; font-variant-numeric: tabular-nums; } tr.pago td { font-size: 12px; color: #57534e; padding-left: 14px; }
tr.doc td { background: #fafaf9; } .mal { color: #b91c1c; } .ok { color: #166534; }
.edades { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; } .edades div { border: 1px solid #d6d3d1; border-radius: 8px; padding: 8px; } .edades b { display: block; font-size: 15px; }
.total { margin-top: 16px; text-align: right; font-size: 18px; } .aviso { margin-top: 16px; padding: 8px 10px; border: 1px dashed #a8a29e; border-radius: 8px; font-size: 12px; }
.pie { margin-top: 28px; font-size: 11px; color: #78716c; }
@media (max-width: 640px) { .edades { grid-template-columns: repeat(2, 1fr); } .cli { grid-template-columns: 1fr; } }
@media print { body { padding: 0; } }
</style></head><body>
<div class="cab"><div><h1>Estado de cuenta</h1><div class="mut">al ${fmtFecha(d.fecha)}</div></div>
<div style="text-align:right"><b>${esc(d.empresa.razon_social || d.empresa.nombre)}</b><br><small>${d.empresa.rtn ? `RTN ${esc(d.empresa.rtn)} · ` : ''}${esc(d.empresa.direccion || '')}</small><br><small>${esc([d.empresa.telefono, d.empresa.correo].filter(Boolean).join(' · '))}</small></div></div>
<div class="cli"><div><span class="mut">Cliente</span><br><b>${esc(d.cliente.nombre)}</b></div><div><span class="mut">RTN</span><br>${esc(d.cliente.rtn || '—')}</div></div>
<h2>Documentos y pagos</h2>
<table><thead><tr><th>Fecha</th><th>Documento</th><th>Proyecto</th><th class="der">Total</th><th class="der">Pagado</th><th class="der">Saldo</th></tr></thead><tbody>${filas || '<tr><td colspan="6" class="mut">Sin documentos en el período.</td></tr>'}</tbody></table>
<div class="total">Saldo pendiente: <b class="${d.resumen.saldo > 0 ? 'mal' : 'ok'}">${lempiras(d.resumen.saldo)}</b></div>
<h2>Antigüedad del saldo</h2>
<div class="edades">${BUCKETS_ANTIGUEDAD.map((b) => `<div><span class="mut">${b} días</span><b>${lempiras(a[b])}</b></div>`).join('')}<div><span class="mut">Total</span><b>${lempiras(a.total)}</b></div></div>
${d.credito.limite > 0 ? `<p class="mut">Límite de crédito: ${lempiras(d.credito.limite)}${d.credito.excede ? ' · <b class="mal">el saldo excede el límite</b>' : ''}</p>` : ''}
${d.hay_borrador ? '<div class="aviso">Algunas facturas de este estado de cuenta fueron emitidas en modo BORRADOR (etapa de pruebas, sin CAI): no tienen valor fiscal.</div>' : ''}
<p class="pie">Generado el ${fmtFecha(d.fecha)}. Si encuentra alguna diferencia, comuníquese con ${esc(d.empresa.telefono || d.empresa.correo || 'la empresa')}.</p>
</body></html>`;
}
