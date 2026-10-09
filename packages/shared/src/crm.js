// Cobranza: reglas puras de antigüedad de saldos. Las usan el API y la web; el cálculo de la lista vive en la base (crm.cxc).
export const BUCKETS_ANTIGUEDAD = ['0-30', '31-60', '61-90', '+90'];

/** Días entre dos fechas YYYY-MM-DD (b - a). */
export function diasEntre(a, b) {
  const [ya, ma, da] = String(a).slice(0, 10).split('-').map(Number);
  const [yb, mb, db] = String(b).slice(0, 10).split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86_400_000);
}

/** Cubeta según los días de antigüedad. */
export function bucketAntiguedad(dias) {
  const d = Math.max(0, Math.floor(Number(dias) || 0));
  return d <= 30 ? '0-30' : d <= 60 ? '31-60' : d <= 90 ? '61-90' : '+90';
}

/** Antigüedad de UN saldo: días desde la aprobación del documento (sin días de crédito). */
export function antiguedadDe({ fecha_documento }, hoy) {
  const dias = Math.max(0, diasEntre(fecha_documento, hoy));
  return { fecha_vencimiento: String(fecha_documento).slice(0, 10), dias_atraso: dias, vencido: dias > 0, bucket: bucketAntiguedad(dias) };
}

/** [{ saldo, bucket }] → { '0-30': n, …, total }. */
export function sumarPorBucket(filas) {
  const out = Object.fromEntries(BUCKETS_ANTIGUEDAD.map((b) => [b, 0]));
  let total = 0;
  for (const f of filas) { out[f.bucket] += Number(f.saldo) || 0; total += Number(f.saldo) || 0; }
  for (const k of Object.keys(out)) out[k] = Math.round(out[k] * 100) / 100;
  return { ...out, total: Math.round(total * 100) / 100 };
}
