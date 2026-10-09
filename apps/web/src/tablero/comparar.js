// Misma regla que el API (tablero/calculo.js): variación porcentual con «nuevo» cuando no hay base.
export function comparar(actual, previo) {
  const a = Number(actual ?? 0), b = Number(previo ?? 0);
  const delta = Math.round((a - b) * 100) / 100;
  if (b === 0) return { delta, pct: null, nuevo: a > 0 };
  return { delta, pct: Math.round(((a - b) / Math.abs(b)) * 1000) / 10, nuevo: false };
}
