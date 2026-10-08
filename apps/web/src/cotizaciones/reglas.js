// Utilidades de presentación de cotizaciones y eventos (las reglas de negocio viven en el servidor).
export const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
export const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
export const CONFIRMADOS = ['aceptada', 'facturada'];

export const ETIQUETA_ESTADO = { borrador: 'Borrador', enviada: 'Enviada', aceptada: 'Aceptada', rechazada: 'Rechazada', facturada: 'Facturada' };
export const CLASE_ESTADO = { borrador: '', enviada: 'info', aceptada: 'ok', rechazada: 'mal', facturada: 'ok' };

// Mismos pasos y claves que el servidor (cotizaciones/calculo.js).
export const ITEMS_CHECKLIST = [
  ['anticipo', 'Anticipo recibido'], ['sabores', 'Sabores y cantidades confirmados'], ['produccion', 'Producción programada'],
  ['logistica', 'Transporte, carrito y equipo listos'], ['entrega', 'Montaje / entrega realizada'], ['cobro', 'Saldo cobrado'],
];

export const numCot = (c) => String(c.numero).padStart(4, '0');
export const claveFecha = (anio, mes, dia) => `${anio}-${String(mes + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
export function hoyClave() { const d = new Date(); return claveFecha(d.getFullYear(), d.getMonth(), d.getDate()); }

export function horaCorta(h) {
  if (!h) return '';
  const [hh, mm] = String(h).split(':').map(Number);
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh >= 12 ? 'p. m.' : 'a. m.'}`;
}
export function fechaLarga(fecha) {
  if (!fecha) return 'Sin fecha';
  const [a, m, d] = fecha.split('-').map(Number);
  const t = new Date(a, m - 1, d).toLocaleDateString('es-HN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return t.charAt(0).toUpperCase() + t.slice(1);
}
export function diasHasta(fecha) {
  const [a, m, d] = fecha.split('-').map(Number);
  const [ha, hm, hd] = hoyClave().split('-').map(Number);
  return Math.round((Date.UTC(a, m - 1, d) - Date.UTC(ha, hm - 1, hd)) / 86_400_000);
}

export function enlaceWhatsApp(telefono) {
  let d = String(telefono || '').replace(/\D/g, '');
  if (d.length === 8) d = `504${d}`;
  return d ? `https://wa.me/${d}` : null;
}

/** Evento a Google Calendar (cuatro horas por defecto si hay hora; todo el día si no). */
export function enlaceGoogleCalendar(c, empresaNombre = '') {
  const f = c.fecha_evento.replaceAll('-', '');
  let fechas;
  if (c.hora_evento) {
    const [hh, mm] = c.hora_evento.split(':').map(Number);
    const p = (n) => String(n).padStart(2, '0');
    fechas = `${f}T${p(hh)}${p(mm)}00/${f}T${p(Math.min(hh + 4, 23))}${p(mm)}00`;
  } else {
    const [a, m, d] = c.fecha_evento.split('-').map(Number);
    fechas = `${f}/${new Date(Date.UTC(a, m - 1, d + 1)).toISOString().slice(0, 10).replaceAll('-', '')}`;
  }
  const detalles = [
    `Cotización #${numCot(c)} · ${Number(c.cantidad_copitas).toLocaleString('es-HN')} copitas`,
    `Cliente: ${c.nombre_cliente}${c.telefono_cliente ? ` · Tel. ${c.telefono_cliente}` : ''}`,
    `Total: L ${Number(c.total).toFixed(2)}${Number(c.anticipo) > 0 ? ` · Anticipo L ${Number(c.anticipo).toFixed(2)}` : ''}`,
    c.notas || '',
  ].filter(Boolean).join('\n');
  const params = new URLSearchParams({ action: 'TEMPLATE', text: `${empresaNombre ? empresaNombre + ' · ' : ''}${c.nombre_evento}`, dates: fechas, ctz: 'America/Tegucigalpa', details: detalles, location: c.lugar || '' });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** «Abrir en mi correo»: mientras el envío automático no esté configurado en el servidor. */
export function enlaceCorreo(c, empresaNombre = '') {
  const asunto = `Tu cotización para ${c.nombre_evento}${empresaNombre ? ` — ${empresaNombre}` : ''}`;
  const cuerpo = `Hola ${String(c.nombre_cliente).split(' ')[0]},\n\nGracias por pensar en nosotros para ${c.nombre_evento}. Te compartimos la cotización No. ${numCot(c)} por L ${Number(c.total).toLocaleString('es-HN', { minimumFractionDigits: 2 })} (ISV incluido).\n\nAdjunto va el PDF.\n\nSaludos.`;
  return `mailto:${encodeURIComponent(c.email_cliente)}?subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent(cuerpo)}`;
}
