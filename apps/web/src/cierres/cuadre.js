// Espejo de apps/api/src/modulos/pos/cierre-calculo.js para mostrar las diferencias en vivo mientras se
// llenan los montos. El cierre definitivo lo recalcula el servidor con las facturas reales.
export const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const n = (v) => r2(Number(v || 0));

export function calcularCuadre(sistema, e) {
  const tarjetaReportada = r2(Object.values(e.pos ?? {}).reduce((s, v) => s + n(v), 0));
  const diferenciaTarjeta = r2(tarjetaReportada - n(sistema.tarjeta));
  const efectivoEsperado = r2(n(e.fondo_caja) + n(sistema.efectivo) + n(e.ingresos) - n(e.salidas));
  const diferenciaEfectivo = r2(n(e.efectivo_contado) - efectivoEsperado);
  return { tarjeta_reportada: tarjetaReportada, diferencia_tarjeta: diferenciaTarjeta, efectivo_esperado: efectivoEsperado, diferencia_efectivo: diferenciaEfectivo, diferencia_total: r2(diferenciaTarjeta + diferenciaEfectivo) };
}

export function estadoDiferencia(dif) {
  const d = Number(dif ?? 0);
  if (Math.abs(d) < 0.005) return { clase: 'ok', texto: 'Cuadra' };
  if (Math.abs(d) < 1) return { clase: 'aviso', texto: d < 0 ? 'Faltan centavos' : 'Sobran centavos' };
  return d < 0 ? { clase: 'mal', texto: 'Faltante' } : { clase: 'aviso', texto: 'Sobrante' };
}

export const totalConteo = (conteo) => r2(Object.entries(conteo ?? {}).reduce((s, [den, c]) => s + Number(den) * Number(c || 0), 0));
