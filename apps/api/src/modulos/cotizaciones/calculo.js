// Reglas puras de cotizaciones/eventos (se prueban sin base de datos).
import { round2 } from '@grupo/shared';

/** Lista de control de un evento aceptado, en el orden en que suele ocurrir (igual que Italo Facturación). */
export const ITEMS_CHECKLIST = [
  { clave: 'anticipo', etiqueta: 'Anticipo recibido' },
  { clave: 'sabores', etiqueta: 'Sabores y cantidades confirmados' },
  { clave: 'produccion', etiqueta: 'Producción programada' },
  { clave: 'logistica', etiqueta: 'Transporte, carrito y equipo listos' },
  { clave: 'entrega', etiqueta: 'Montaje / entrega realizada' },
  { clave: 'cobro', etiqueta: 'Saldo cobrado' },
];
export const CLAVES_CHECKLIST = new Set(ITEMS_CHECKLIST.map((i) => i.clave));

export const ESTADOS = ['borrador', 'enviada', 'aceptada', 'rechazada', 'facturada'];
/** Estados que el usuario puede elegir a mano: «facturada» solo se alcanza con Facturar. */
export const ESTADOS_MANUALES = ['borrador', 'enviada', 'aceptada', 'rechazada'];

/** Desde este total la factura exige el RTN del cliente (misma regla que Italo Facturación). */
export const UMBRAL_RTN_OBLIGATORIO = 10000;
/** Días de validez que imprime el documento. */
export const DIAS_VALIDEZ = 15;

export const CONDICIONES_EVENTOS = [
  'Para reservar la fecha se solicita un anticipo; el saldo se cancela a más tardar el día del evento.',
  'Los precios incluyen ISV. Los sabores se confirman al menos 3 días antes del evento.',
  'La cotización tiene una validez de 15 días a partir de su fecha de emisión.',
  'Cualquier cambio en la cantidad o la fecha debe avisarse con 72 horas de anticipación.',
];

export const rtnLuceValido = (rtn) => /^\d{13,14}$/.test(String(rtn ?? '').replace(/[-\s]/g, ''));

export function subtotalCotizacion(c, partidas = []) {
  const copitas = round2(Number(c.cantidad_copitas || 0) * Number(c.precio_copita || 0));
  const extras = round2(partidas.reduce((s, p) => s + Number(p.cantidad) * Number(p.precio_unitario), 0));
  return round2(copitas + Number(c.costo_servicio || 0) + extras);
}
export function totalCotizacion(c, partidas = []) {
  return round2(subtotalCotizacion(c, partidas) - Number(c.descuento || 0));
}

/** Lo que falta cobrar: facturada o con «Saldo cobrado» ya no debe nada. */
export function saldoPendiente(c, total) {
  if (c.estado === 'facturada' || c.checklist?.cobro?.hecho) return 0;
  return Math.max(0, round2(total - Number(c.anticipo || 0)));
}

export const pasosHechos = (c) => ITEMS_CHECKLIST.filter((i) => c.checklist?.[i.clave]?.hecho).length;

const diasEntre = (desde, hasta) => Math.round((Date.parse(hasta) - Date.parse(desde)) / 86_400_000);

/** Situación de un evento confirmado para colorearlo y avisar a tiempo (null si aún es tentativo). */
export function situacionEvento(c, hoy) {
  if (!['aceptada', 'facturada'].includes(c.estado) || !c.fecha_evento) return null;
  const dias = diasEntre(hoy, c.fecha_evento);
  const faltan = ITEMS_CHECKLIST.length - pasosHechos(c);
  if (c.realizado && faltan === 0) return { tipo: 'cerrado', texto: 'Evento cerrado', dias };
  if (dias < 0) return { tipo: 'vencido', texto: c.realizado ? `Realizado · faltan ${faltan} pasos` : 'Pasó la fecha: ciérralo', dias };
  if (dias <= 3 && faltan > 0) return { tipo: 'urgente', texto: dias === 0 ? `Hoy · faltan ${faltan} pasos` : `En ${dias} día${dias === 1 ? '' : 's'} · faltan ${faltan} pasos`, dias };
  if (faltan === 0) return { tipo: 'listo', texto: 'Todo listo', dias };
  return { tipo: 'en-curso', texto: `${ITEMS_CHECKLIST.length - faltan}/${ITEMS_CHECKLIST.length} pasos`, dias };
}

const fechaOk = (f) => /^\d{4}-\d{2}-\d{2}$/.test(String(f)) && !Number.isNaN(Date.parse(`${f}T00:00:00Z`));
const horaOk = (h) => /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(String(h));

/** Valida fecha, hora y anticipo (devuelve el mensaje de error o null). */
export function problemaAgenda({ fecha_evento, hora_evento, anticipo }, total) {
  if (fecha_evento && !fechaOk(fecha_evento)) return 'Fecha del evento inválida';
  if (hora_evento && !horaOk(hora_evento)) return 'Hora del evento inválida';
  if (anticipo !== undefined && anticipo !== null) {
    const a = Number(anticipo);
    if (!Number.isFinite(a) || a < 0) return 'Anticipo inválido';
    if (total !== undefined && a > total + 0.001) return 'El anticipo no puede ser mayor que el total de la cotización';
  }
  return null;
}
