// Cálculos puros de Compras (sin base de datos): se prueban con datos sintéticos.

export const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const r4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;

/** Precio a lempiras: en dólares se multiplica por el tipo de cambio del documento. */
export const aLempiras = (precio, moneda, tipoCambio) => r4(Number(precio) * (moneda === 'USD' ? Number(tipoCambio) : 1));

/** Totales de una orden en SU moneda: subtotal de líneas redondeado por línea, ISV sobre el subtotal. */
export function totalesOrden(lineas, isvPct = 0) {
  const subtotal = r2(lineas.reduce((s, l) => s + r2(Number(l.cantidad) * Number(l.precio_unitario)), 0));
  const isv = r2((subtotal * Number(isvPct)) / 100);
  return { subtotal, isv, total: r2(subtotal + isv) };
}

/** Variación porcentual (con un decimal) del precio nuevo contra el anterior; null si no hay con qué comparar. */
export function variacionPct(nuevo, anterior) {
  const n = Number(nuevo), a = Number(anterior);
  if (!Number.isFinite(n) || !Number.isFinite(a) || a <= 0) return null;
  return Math.round(((n - a) / a) * 1000) / 10;
}

/**
 * Descompone el cambio de un precio dolarizado en lo que se debe al precio en dólares (la factura)
 * y lo que se debe al tipo de cambio. (1 + total) = (1 + usd) × (1 + cambio).
 */
export function variacionDolarizada(nuevo, anterior) {
  if (!nuevo || !anterior || nuevo.moneda !== 'USD' || anterior.moneda !== 'USD') return null;
  return {
    total_pct: variacionPct(nuevo.precio_lps, anterior.precio_lps),
    usd_pct: variacionPct(nuevo.precio, anterior.precio),
    cambio_pct: variacionPct(nuevo.tipo_cambio, anterior.tipo_cambio),
  };
}

/** Estado de la orden después de recibir: recibida si todas las líneas llegaron completas. */
export function estadoTrasRecepcion(lineas) {
  return lineas.every((l) => Number(l.cantidad_recibida) + 1e-9 >= Number(l.cantidad)) ? 'recibida' : 'recibida_parcial';
}

/**
 * Cuánto pedir de un ítem bajo su mínimo. Objetivo = máximo si existe; si no, el doble del mínimo.
 * Descuenta lo que ya viene en camino. Devuelve 0 si no hace falta.
 */
export function sugerirCantidad({ stock, minimo, maximo = null, enCamino = 0 }) {
  const min = Number(minimo) || 0;
  if (!(min > 0) || stock === null || stock === undefined) return 0;
  const s = Number(stock);
  if (s > min) return 0;
  const objetivo = Number(maximo) > min ? Number(maximo) : min * 2;
  const falta = objetivo - s - (Number(enCamino) || 0);
  return falta > 0 ? Math.ceil(falta * 100) / 100 : 0;
}

/**
 * Cuentas por pagar por recepción: los pagos de una orden se aplican a la recepción más vieja primero.
 * Devuelve las recepciones con saldo pendiente.
 */
export function saldosPorRecepcion(recepciones, pagosLps) {
  let sobrante = r2(pagosLps);
  const orden = [...recepciones].sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
  const out = [];
  for (const r of orden) {
    const total = r2(r.total_lps);
    const aplicado = Math.min(sobrante, total);
    sobrante = r2(sobrante - aplicado);
    const saldo = r2(total - aplicado);
    if (saldo > 0.004) out.push({ ...r, saldo });
  }
  return out;
}

/** Días entre dos fechas ISO (b − a). */
export function diasEntre(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}
