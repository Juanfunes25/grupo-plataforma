// Cálculo de cotizaciones DISERCO: los precios van SIN ISV y el 15 % se suma encima.
// El descuento global (%) se reparte proporcionalmente entre las líneas antes del ISV.
// (Duplicado en apps/web/src/diserco/calculo.js: las pruebas comprueban que den lo mismo.)
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;

export function calcularCotizacion(lineas, { descuento_pct = 0, cliente_exento = false } = {}) {
  const base = lineas.map((l) => {
    const cantidad = Number(l.cantidad) || 0;
    const bruto = round2(cantidad * (Number(l.precio_unitario) || 0));
    return { l, cantidad, bruto, tasa: cliente_exento ? 0 : Number(l.isv_tasa ?? 0.15) };
  });
  const suma = round2(base.reduce((s, x) => s + x.bruto, 0));
  const pct = Math.min(100, Math.max(0, Number(descuento_pct) || 0));
  const D = Math.min(suma, round2((suma * pct) / 100));
  let asignado = 0;
  const out = base.map((x, i) => {
    const ultima = i === base.length - 1;
    const dGlob = ultima ? round2(D - asignado) : suma > 0 ? round2((D * x.bruto) / suma) : 0;
    asignado = round2(asignado + dGlob);
    const neto = round2(x.bruto - dGlob);
    const isv = round2(neto * x.tasa);
    const total = round2(neto + isv);
    const factor = 1 + x.tasa;
    return {
      monto: total, base: neto, isv, descuento: dGlob, descuento_con_isv: round2(dGlob * factor), isv_tasa: x.tasa,
      precio_unitario_con_isv: x.cantidad > 0 ? round4(round2(x.bruto * factor) / x.cantidad) : 0,
      costo: round2((Number(x.l.costo_unitario) || 0) * x.cantidad),
    };
  });
  const s = (k) => round2(out.reduce((a, o) => a + o[k], 0));
  const subtotal = s('base');
  const costo = s('costo');
  return {
    lineas: out, subtotal, isv: s('isv'), total: s('monto'), descuento_total: D, costo,
    margen: round2(subtotal - costo), margen_pct: subtotal > 0 ? round2(((subtotal - costo) / subtotal) * 100) : 0,
  };
}
