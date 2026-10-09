// Cálculo del cierre de caja (puro, sin base de datos). Portado de italo-facturacion
// (backend/lib/cierre.js) y generalizado: los bancos de los POS de tarjeta son configurables
// por empresa (core.config 'cierre' → { bancos: ['BAC', 'Ficohsa'] }).

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export const BANCOS_POR_DEFECTO = ['BAC', 'Ficohsa'];

/** Lempiras en circulación: billetes y monedas que se cuentan en la gaveta. */
export const DENOMINACIONES = [
  { valor: 500, tipo: 'billete' }, { valor: 200, tipo: 'billete' }, { valor: 100, tipo: 'billete' },
  { valor: 50, tipo: 'billete' }, { valor: 20, tipo: 'billete' }, { valor: 10, tipo: 'billete' },
  { valor: 5, tipo: 'billete' }, { valor: 2, tipo: 'billete' },
  { valor: 1, tipo: 'moneda' }, { valor: 0.5, tipo: 'moneda' }, { valor: 0.2, tipo: 'moneda' },
  { valor: 0.1, tipo: 'moneda' }, { valor: 0.05, tipo: 'moneda' },
];

/** Total en lempiras de un conteo { "500": 2, "0.5": 3 }. */
export function totalConteo(conteo) {
  return round2(Object.entries(conteo ?? {}).reduce((s, [den, cant]) => s + Number(den) * Number(cant || 0), 0));
}

/**
 * Cuadre: lo que reportan los POS y el efectivo contado contra el sistema.
 *   Tarjeta:  (suma de los POS) − tarjeta según sistema
 *   Efectivo: contado en gaveta − (fondo + ventas en efectivo + ingresos − salidas)
 * Diferencia positiva = sobrante; negativa = faltante.
 */
export function calcularCuadre(sistema, entradas) {
  const n = (v) => round2(Number(v || 0));
  // Sin montos de los POS (pos_bancos null): el cierre de caja solo pide fondo y efectivo (decisión del dueño), así que la tarjeta
  // no se cuadra aquí: se toma la del sistema y no genera diferencia. Los lotes de tarjeta se revisan contra el banco.
  const pos = entradas.pos_bancos;
  const tarjetaReportada = pos == null ? n(sistema.tarjeta) : round2(Object.values(pos).reduce((s, v) => s + n(v), 0));
  const fondo = n(entradas.fondo_caja);
  const salidas = n(entradas.salidas);
  const ingresos = n(entradas.ingresos);
  const contado = n(entradas.efectivo_contado);
  const diferenciaTarjeta = round2(tarjetaReportada - n(sistema.tarjeta));
  const efectivoEsperado = round2(fondo + n(sistema.efectivo) + ingresos - salidas);
  const diferenciaEfectivo = round2(contado - efectivoEsperado);
  return {
    tarjeta_reportada: tarjetaReportada, diferencia_tarjeta: diferenciaTarjeta,
    fondo_caja: fondo, ingresos, salidas, efectivo_contado: contado,
    efectivo_esperado: efectivoEsperado, diferencia_efectivo: diferenciaEfectivo,
    diferencia_total: round2(diferenciaTarjeta + diferenciaEfectivo),
  };
}

/** Descuadre = diferencia de L 1 o más en tarjeta o efectivo (los centavos no obligan a explicar). */
export const hayDescuadre = (c) => Math.abs(c.diferencia_tarjeta) >= 1 || Math.abs(c.diferencia_efectivo) >= 1;

/**
 * Patrones que un solo cierre no muestra a simple vista:
 *  · desvío tarjeta→efectivo: sobra efectivo y falta tarjeta (cobrado en efectivo pero registrado como tarjeta)
 *  · reincidencia: el mismo cajero con faltantes en varios cierres recientes
 */
export function patrones(cuadre, { cajero, faltantesPrevios = 0, reincidencia = 2 }) {
  const out = [];
  const L = (n) => `L ${Math.abs(n).toFixed(2)}`;
  if (cuadre.diferencia_efectivo >= 1 && cuadre.diferencia_tarjeta <= -1) {
    out.push({ tipo: 'patron_desvio', severidad: 'alta', titulo: `Patrón de desvío: sobra efectivo (${L(cuadre.diferencia_efectivo)}) y falta tarjeta (${L(cuadre.diferencia_tarjeta)})` });
  }
  if (cuadre.diferencia_efectivo <= -1 && faltantesPrevios + 1 >= reincidencia) {
    out.push({ tipo: 'reincidencia', severidad: 'alta', titulo: `${cajero} acumula ${faltantesPrevios + 1} cierres con faltante en 7 días` });
  }
  return out;
}

/** Quita lo que el sistema calculó: el cajero cuenta a ciegas y no ve cuánto "debería" haber. */
const CAMPOS_SISTEMA = ['efectivo_sistema', 'tarjeta_sistema', 'transferencia_sistema', 'otros_sistema', 'total_ventas', 'anuladas', 'monto_anulado',
  'desglose_pagos', 'efectivo_esperado', 'diferencia_tarjeta', 'diferencia_efectivo', 'diferencia', 'alertas'];
export function sinSistema(cierre) {
  const c = { ...cierre };
  for (const k of CAMPOS_SISTEMA) delete c[k];
  return c;
}
