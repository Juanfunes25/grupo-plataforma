// Documentos por correo: factura (PDF adjunto) y cotizaciones de Italo (eventos), EcoStone y DISERCO.
// Los módulos dueños de cada documento llaman a estas funciones desde su botón «Enviar por correo»;
// aquí solo se arma el contenido y se manda con lib/correo.js (nunca lanza por fallas de envío).
import { lempiras } from '@grupo/shared';
import { enviarCorreo, escaparHtml as esc, correoValido } from '../../lib/correo.js';
import { ErrorHttp } from '../../lib/http.js';
import { auditar } from '../../lib/auditoria.js';
import { generarPdfFactura } from '../pos/pdf.js';
import { generarPdfDocumento, lempirasPdf } from './pdfSimple.js';

export const LEYENDA_BORRADOR = 'BORRADOR – SIN VALOR FISCAL';

const fila = (k, v) => (v === null || v === undefined || v === '' ? '' : `<tr><td style="padding:3px 12px 3px 0;color:#7a716a">${esc(k)}</td><td style="padding:3px 0"><strong>${esc(v)}</strong></td></tr>`);
const tabla = (cabeza, filas) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:14px 0;font-size:14px">
<tr>${cabeza.map((c, i) => `<th align="${i ? 'right' : 'left'}" style="padding:6px 4px;border-bottom:2px solid #e6e0d8;font-size:12px;color:#7a716a">${esc(c)}</th>`).join('')}</tr>
${filas.map((f) => `<tr>${f.map((c, i) => `<td align="${i ? 'right' : 'left'}" style="padding:6px 4px;border-bottom:1px solid #eee8e0">${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`;
const avisoBorrador = `<p style="margin:0 0 14px;padding:10px 12px;background:#fdecea;border:1px solid #f1b5ae;border-radius:6px;color:#a02a1c;font-weight:bold;text-align:center">${LEYENDA_BORRADOR}<br><span style="font-weight:normal;font-size:12px">Etapa de pruebas: este documento todavía no tiene CAI autorizado por el SAR.</span></p>`;

function exigirCorreo(destino) {
  const d = String(destino ?? '').trim().toLowerCase();
  if (!correoValido(d)) throw new ErrorHttp(400, d ? `El correo «${d}» no es válido` : 'Escribe el correo del cliente', 'correo_invalido');
  return d;
}

/** Texto para el mensaje al usuario según el resultado del envío. */
export function mensajeResultado(r, destino) {
  if (r.ok) return `Enviado a ${destino}`;
  if (r.pendiente) return `Quedó pendiente de envío a ${destino}: ${r.error}`;
  return `No se pudo enviar: ${r.error}`;
}

/**
 * Factura (la venta ya cargada con su detalle, como la arma pos/ventas.js) → correo con el PDF adjunto.
 * @returns {{ ok, pendiente, error, destino, mensaje }}
 */
export async function enviarFacturaPorCorreo({ q, ctx, d, destino, mensaje }) {
  const para = exigirCorreo(destino);
  const borrador = Boolean(d.es_borrador_fiscal);
  const numero = d.numero_factura ?? `ticket ${d.ticket_dia ?? ''}`.trim();
  const pdf = generarPdfFactura({ empresa: ctx.empresa, sucursal: d.sucursal, venta: d, lineas: d.lineas, pagos: d.pagos, punto: d.punto, cliente: d.cliente, cajero: d.cajero });
  const nombreArchivo = `factura-${String(numero).replace(/[^\w.-]/g, '_')}${borrador ? '-BORRADOR' : ''}.pdf`;
  const cuerpo = `${borrador ? avisoBorrador : ''}
<p style="margin:0 0 10px">Hola${d.cliente?.nombre ? ` ${esc(d.cliente.nombre)}` : ''}, gracias por tu compra en <strong>${esc(ctx.empresa.nombre)}</strong>. Adjuntamos tu ${borrador ? 'comprobante (borrador)' : 'factura'} en PDF.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:8px 0">
${fila(borrador ? 'Comprobante' : 'Factura', numero)}${fila('Sucursal', d.sucursal?.nombre)}${fila('Total', lempiras(d.total))}
</table>
${mensaje ? `<p style="margin:10px 0">${esc(mensaje)}</p>` : ''}
<p style="margin:14px 0 0;color:#7a716a;font-size:13px">Si tienes alguna duda, responde a este correo o comunícate con nosotros.</p>`;
  const r = await enviarCorreo({
    empresaId: ctx.empresa.id, para, tipo: 'factura', referencia: d.id,
    asunto: `${borrador ? 'Comprobante (borrador)' : 'Factura'} ${numero} – ${ctx.empresa.nombre}`,
    titulo: borrador ? 'Comprobante de compra' : 'Tu factura', html: cuerpo,
    adjuntos: [{ nombre: nombreArchivo, mime: 'application/pdf', contenido: pdf }],
    usuario: ctx.usuario,
  });
  await auditar(q, ctx, 'factura_enviada_correo', 'venta', d.id, { factura: numero, destino: para, ok: r.ok, pendiente: r.pendiente, error: r.error ?? null, borrador }, { sucursalId: d.sucursal_id });
  return { ...r, destino: para, mensaje: mensajeResultado(r, para) };
}

// ── Cotizaciones ──────────────────────────────────────────────────────────────
/** Lleva los tres tipos de cotización (Italo eventos, EcoStone, DISERCO) a una misma forma. */
export function normalizarCotizacion(tipo, c) {
  const n = (v) => Number(v || 0);
  if (tipo === 'italo') {
    const lineas = [];
    if (n(c.cantidad_copitas) > 0) lineas.push({ descripcion: `Copitas de gelato${c.nombre_evento ? ` – ${c.nombre_evento}` : ''}`, cantidad: n(c.cantidad_copitas), unidad: 'copitas', precio: n(c.precio_copita), monto: n(c.cantidad_copitas) * n(c.precio_copita) });
    if (n(c.costo_servicio) > 0) lineas.push({ descripcion: 'Servicio / montaje', cantidad: 1, unidad: '', precio: n(c.costo_servicio), monto: n(c.costo_servicio) });
    for (const p of c.partidas ?? []) lineas.push({ descripcion: p.descripcion, cantidad: n(p.cantidad), unidad: '', precio: n(p.precio_unitario), monto: n(p.cantidad) * n(p.precio_unitario) });
    return {
      codigo: String(c.numero).padStart(4, '0'), cliente: c.nombre_cliente, rtn: c.rtn_cliente, proyecto: c.nombre_evento, lugar: c.lugar,
      fechaEvento: c.fecha_evento, lineas, subtotal: n(c.subtotal), descuento: n(c.descuento), isv: null, total: n(c.total), anticipo: n(c.anticipo), vigenciaDias: 15, notas: c.notas,
    };
  }
  if (tipo === 'eco') {
    return {
      codigo: String(c.numero).padStart(4, '0'), cliente: c.nombre_cliente, rtn: c.rtn_cliente, proyecto: c.proyecto, lugar: c.direccion_obra,
      lineas: (c.lineas ?? []).map((l) => ({ descripcion: l.descripcion, cantidad: n(l.cantidad), unidad: l.unidad ?? '', precio: n(l.precio_unitario), monto: n(l.monto) })),
      subtotal: n(c.subtotal), descuento: n(c.descuento), isv: n(c.isv), total: n(c.total), anticipo: n(c.anticipo_monto), vigenciaDias: n(c.vigencia_dias) || 15, vigenciaHasta: c.fecha_vigencia, notas: c.notas,
    };
  }
  return {   // diserco
    codigo: c.codigo, cliente: c.nombre_cliente, rtn: c.rtn_cliente, proyecto: c.proyecto, lugar: c.ubicacion, contacto: c.contacto,
    lineas: (c.lineas ?? []).map((l) => ({ descripcion: l.descripcion, cantidad: n(l.cantidad), unidad: l.unidad ?? '', precio: n(l.precio_unitario), monto: n(l.monto) })),
    subtotal: n(c.subtotal), descuento: null, descuentoPct: n(c.descuento_pct), isv: n(c.isv), total: n(c.total), anticipo: null, anticipoPct: n(c.anticipo_pct), vigenciaDias: n(c.vigencia_dias) || 30, vigenciaHasta: c.fecha_vigencia, notas: null,
  };
}

/**
 * Cotización → correo con su documento en PDF.
 * @param {'italo'|'eco'|'diserco'} tipo
 */
export async function enviarCotizacionPorCorreo({ q, ctx, tipo, cot, id, destino, mensaje }) {
  const para = exigirCorreo(destino);
  const c = normalizarCotizacion(tipo, cot);
  const empresa = ctx.empresa;
  const etiqueta = tipo === 'italo' ? 'Cotización de evento' : 'Cotización';
  const valida = c.vigenciaHasta ? `Válida hasta el ${String(c.vigenciaHasta).slice(0, 10)}` : `Válida por ${c.vigenciaDias} días`;
  const filas = c.lineas.map((l) => [l.descripcion, `${l.cantidad}${l.unidad ? ` ${l.unidad}` : ''}`, lempiras(l.precio), lempiras(l.monto)]);
  const totalesHtml = `<table role="presentation" cellpadding="0" cellspacing="0" align="right" style="font-size:14px;margin:4px 0 14px">
${c.subtotal ? `<tr><td style="padding:2px 14px 2px 0;color:#7a716a">Subtotal</td><td align="right">${esc(lempiras(c.subtotal))}</td></tr>` : ''}
${c.descuento ? `<tr><td style="padding:2px 14px 2px 0;color:#7a716a">Descuento</td><td align="right">– ${esc(lempiras(c.descuento))}</td></tr>` : ''}
${c.isv ? `<tr><td style="padding:2px 14px 2px 0;color:#7a716a">ISV</td><td align="right">${esc(lempiras(c.isv))}</td></tr>` : ''}
<tr><td style="padding:4px 14px 2px 0"><strong>Total</strong></td><td align="right"><strong>${esc(lempiras(c.total))}</strong></td></tr></table><div style="clear:both"></div>`;
  const cuerpo = `<p style="margin:0 0 10px">Hola${c.cliente ? ` ${esc(c.cliente)}` : ''}, te compartimos la ${etiqueta.toLowerCase()} <strong>${esc(c.codigo)}</strong>${c.proyecto ? ` para <strong>${esc(c.proyecto)}</strong>` : ''}. El documento completo va adjunto en PDF.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:8px 0">${fila('Cotización', c.codigo)}${fila('Evento / proyecto', c.proyecto)}${fila('Fecha del evento', c.fechaEvento)}${fila('Lugar', c.lugar)}${fila('Vigencia', valida)}</table>
${filas.length ? tabla(['Descripción', 'Cantidad', 'Precio', 'Monto'], filas) : ''}${totalesHtml}
${mensaje ? `<p style="margin:10px 0">${esc(mensaje)}</p>` : ''}
<p style="margin:14px 0 0;color:#7a716a;font-size:13px">Para aceptar la cotización o hacer cambios, responde a este correo o llámanos${empresa.telefono ? ` al ${esc(empresa.telefono)}` : ''}.</p>`;

  const pdf = generarPdfDocumento({
    empresa, titulo: `${etiqueta} ${c.codigo}`,
    datos: [['Cliente', c.cliente], ['RTN', c.rtn], ['Contacto', c.contacto], ['Evento / proyecto', c.proyecto], ['Fecha del evento', c.fechaEvento], ['Lugar', c.lugar], ['Vigencia', valida]],
    columnas: [{ cabeza: 'Descripción', ancho: 270 }, { cabeza: 'Cantidad', ancho: 80, derecha: true }, { cabeza: 'Precio', ancho: 80, derecha: true }, { cabeza: 'Monto', ancho: 84, derecha: true }],
    filas: c.lineas.map((l) => [l.descripcion, `${l.cantidad}${l.unidad ? ` ${l.unidad}` : ''}`, lempirasPdf(l.precio), lempirasPdf(l.monto)]),
    totales: [
      ...(c.subtotal ? [['Subtotal', lempirasPdf(c.subtotal)]] : []),
      ...(c.descuento ? [['Descuento', `- ${lempirasPdf(c.descuento)}`]] : c.descuentoPct ? [[`Descuento ${c.descuentoPct}%`, '']] : []),
      ...(c.isv ? [['ISV', lempirasPdf(c.isv)]] : []),
      ['TOTAL', lempirasPdf(c.total), true],
      ...(c.anticipo ? [['Anticipo', lempirasPdf(c.anticipo)]] : []),
    ],
    notas: [c.notas, 'Esta cotización no es una factura.'].filter(Boolean),
  });
  const r = await enviarCorreo({
    empresaId: empresa.id, para, tipo: 'cotizacion', referencia: String(id ?? c.codigo),
    asunto: `${etiqueta} ${c.codigo} – ${empresa.nombre}`, titulo: etiqueta, html: cuerpo,
    adjuntos: [{ nombre: `cotizacion-${String(c.codigo).replace(/[^\w.-]/g, '_')}.pdf`, mime: 'application/pdf', contenido: pdf }],
    usuario: ctx.usuario,
  });
  await auditar(q, ctx, 'cotizacion_enviada_correo', 'cotizacion', id ?? null, { codigo: c.codigo, tipo, destino: para, ok: r.ok, pendiente: r.pendiente, error: r.error ?? null }, {});
  return { ...r, destino: para, mensaje: mensajeResultado(r, para) };
}
