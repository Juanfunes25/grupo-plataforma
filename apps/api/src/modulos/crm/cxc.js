import { BUCKETS_ANTIGUEDAD, fechaHN } from '@grupo/shared';

/**
 * CUENTAS POR COBRAR del grupo — punto de lectura para Finanzas y para el tablero de cobranza.
 * El cálculo vive UNA sola vez, en la base: crm.cxc(fecha) (y la vista crm.v_cxc con la fecha de hoy en Honduras).
 * Una fila = una cotización aprobada (EcoStone o DISERCO) con saldo; la antigüedad corre desde el vencimiento
 * (fecha del documento + días de crédito del cliente) y se reparte en 0-30 / 31-60 / 61-90 / +90.
 *
 *   const filas = await cuentasPorCobrar(db, { empresaIds: [id], hoy: '2026-10-09' });
 *   const resumen = resumirCxc(filas);   // { total, vencido, documentos, clientes, buckets:{'0-30':…,'+90':…} }
 */
export async function cuentasPorCobrar(q, { empresaIds = null, hoy = fechaHN(), tercero = null } = {}) {
  const { rows } = await q.query(
    `select c.*, e.codigo as empresa_codigo, e.nombre as empresa_nombre
       from crm.cxc($1::date) c join core.empresas e on e.id = c.empresa_id
      where ($2::uuid[] is null or c.empresa_id = any($2::uuid[])) and ($3::uuid is null or c.tercero_id = $3::uuid)
      order by c.fecha_vencimiento, c.documento`, [hoy, empresaIds, tercero]);
  return rows.map((r) => ({ ...r, total: Number(r.total), pagado: Number(r.pagado), saldo: Number(r.saldo), anticipo_requerido: Number(r.anticipo_requerido), anticipo_pendiente: Number(r.anticipo_pendiente), limite_credito: Number(r.limite_credito) }));
}

const r2 = (n) => Math.round(n * 100) / 100;

export function resumirCxc(filas) {
  const buckets = Object.fromEntries(BUCKETS_ANTIGUEDAD.map((b) => [b, 0]));
  let total = 0, vencido = 0;
  const clientes = new Set();
  for (const f of filas) { buckets[f.bucket] += f.saldo; total += f.saldo; if (f.vencido) vencido += f.saldo; clientes.add(f.tercero_id ?? f.nombre_cliente); }
  for (const k of Object.keys(buckets)) buckets[k] = r2(buckets[k]);
  return { total: r2(total), vencido: r2(vencido), documentos: filas.length, clientes: clientes.size, buckets };
}

/** Por empresa, para el consolidado de Dirección / Finanzas. */
export async function cxcPorEmpresa(q, { empresaIds = null, hoy = fechaHN() } = {}) {
  const filas = await cuentasPorCobrar(q, { empresaIds, hoy });
  const por = new Map();
  for (const f of filas) { if (!por.has(f.empresa_id)) por.set(f.empresa_id, { empresa_id: f.empresa_id, codigo: f.empresa_codigo, nombre: f.empresa_nombre, filas: [] }); por.get(f.empresa_id).filas.push(f); }
  return [...por.values()].map(({ filas: fs, ...e }) => ({ ...e, ...resumirCxc(fs) }));
}

/** Crédito usado por cliente en una empresa (suma de saldos de lo aprobado y no pagado). */
export function creditoUsado(filas, terceroId) {
  return r2(filas.filter((f) => f.tercero_id === terceroId).reduce((s, f) => s + f.saldo, 0));
}
