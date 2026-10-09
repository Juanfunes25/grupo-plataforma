// Cálculos puros del tablero del dueño (sin base de datos: se prueban con datos sintéticos).
import { TZ_HN } from '@grupo/shared';

export const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
export const n = (v) => Number(v ?? 0);

/** Hora de Honduras (HH:MM:SS, 24 h) de un instante. Sirve para comparar «a esta misma hora» de otros días. */
export function horaCorteHN(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ_HN, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t)?.value ?? '00';
  return `${g('hour')}:${g('minute')}:${g('second')}`;
}

/** Variación de `actual` contra `previo`. pct = null si no hay base de comparación. */
export function comparar(actual, previo) {
  const a = n(actual), b = n(previo);
  const delta = r2(a - b);
  if (b === 0) return { delta, pct: null, nuevo: a > 0 };
  return { delta, pct: Math.round(((a - b) / Math.abs(b)) * 1000) / 10, nuevo: false };
}

/** Nombre corto del día de la semana de una fecha YYYY-MM-DD. */
export const DIAS_CORTOS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
export const diaCorto = (fecha) => DIAS_CORTOS[new Date(`${fecha}T12:00:00Z`).getUTCDay()];

const vacioDia = (fecha) => ({ fecha, facturas: 0, total: 0, facturas_corte: 0, total_corte: 0, venta: 0, venta_costeada: 0, costo: 0 });

/**
 * Arma las métricas por día y por sucursal a partir de las filas agregadas.
 *   ventas: [{ fecha, sucursal_id, facturas, total, facturas_corte, total_corte }]
 *   margen: [{ fecha, venta, venta_costeada, costo }]
 */
export function armarDias({ fechas, ventas, margen }) {
  const dias = new Map(fechas.map((f) => [f, vacioDia(f)]));
  for (const v of ventas) {
    const d = dias.get(v.fecha);
    if (!d) continue;
    d.facturas += n(v.facturas); d.total += n(v.total); d.facturas_corte += n(v.facturas_corte); d.total_corte += n(v.total_corte);
  }
  for (const m of margen) {
    const d = dias.get(m.fecha);
    if (!d) continue;
    d.venta += n(m.venta); d.venta_costeada += n(m.venta_costeada); d.costo += n(m.costo);
  }
  const out = {};
  for (const [f, d] of dias) {
    out[f] = {
      fecha: f, dia: diaCorto(f), facturas: d.facturas, total: r2(d.total),
      ticket_promedio: d.facturas ? r2(d.total / d.facturas) : 0,
      facturas_corte: d.facturas_corte, total_corte: r2(d.total_corte),
      // Margen sobre lo que tiene costo capturado (receta); cobertura = qué parte de la venta tiene costo.
      margen_pct: d.venta_costeada > 0 ? Math.round(((d.venta_costeada - d.costo) / d.venta_costeada) * 1000) / 10 : null,
      cobertura_pct: d.venta > 0 ? Math.round((d.venta_costeada / d.venta) * 100) : null,
    };
  }
  return out;
}

/** Totales de un día por sucursal: { [sucursal_id]: { facturas, total, total_corte } }. */
export function porSucursal(ventas, fecha) {
  const m = new Map();
  for (const v of ventas) {
    if (v.fecha !== fecha) continue;
    const x = m.get(v.sucursal_id) ?? { facturas: 0, total: 0, total_corte: 0 };
    x.facturas += n(v.facturas); x.total += n(v.total); x.total_corte += n(v.total_corte);
    m.set(v.sucursal_id, x);
  }
  return m;
}

/**
 * Composición final del tablero de UNA empresa. `hoy` es la fecha de Honduras; ayer y la semana pasada
 * se comparan de dos maneras: el día completo y «hasta esta misma hora» (la comparación justa a media jornada).
 */
export function armarTablero({ hoy, ayer, semana, dias, ventas, sucursales, pagos, tendenciaFechas }) {
  const H = dias[hoy], A = dias[ayer], S = dias[semana];
  const cmp = (base) => ({
    dia_completo: comparar(H.total, base.total),
    misma_hora: comparar(H.total, base.total_corte),
    facturas_misma_hora: comparar(H.facturas, base.facturas_corte),
  });
  const sh = porSucursal(ventas, hoy), sa = porSucursal(ventas, ayer), ss = porSucursal(ventas, semana);
  const totalPagos = pagos.reduce((s, p) => s + n(p.monto), 0);
  return {
    hoy: H, ayer: A, semana_pasada: S,
    vs_ayer: cmp(A), vs_semana_pasada: cmp(S),
    sucursales: sucursales.map((s) => {
      const h = sh.get(s.id) ?? { facturas: 0, total: 0, total_corte: 0 };
      const a = sa.get(s.id) ?? { facturas: 0, total: 0, total_corte: 0 };
      const w = ss.get(s.id) ?? { facturas: 0, total: 0, total_corte: 0 };
      return {
        id: s.id, nombre: s.nombre, color: s.color ?? null,
        hoy: { facturas: h.facturas, total: r2(h.total), ticket_promedio: h.facturas ? r2(h.total / h.facturas) : 0 },
        ayer: { facturas: a.facturas, total: r2(a.total), total_corte: r2(a.total_corte) },
        semana_pasada: { facturas: w.facturas, total: r2(w.total), total_corte: r2(w.total_corte) },
        vs_ayer: comparar(h.total, a.total_corte), vs_semana_pasada: comparar(h.total, w.total_corte),
      };
    }).sort((x, y) => y.hoy.total - x.hoy.total),
    formas_pago: pagos.map((p) => ({ nombre: p.nombre, tipo: p.tipo, monto: r2(p.monto), porcentaje: totalPagos > 0 ? Math.round((n(p.monto) / totalPagos) * 1000) / 10 : 0 })),
    tendencia: tendenciaFechas.map((f) => ({ fecha: f, dia: dias[f].dia, total: dias[f].total, facturas: dias[f].facturas })),
  };
}
