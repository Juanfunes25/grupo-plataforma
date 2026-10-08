import { REGLAS_DEFECTO } from './reglas.js';

// Análisis del periodo: patrones por cajero/sucursal calculados al vuelo sobre las ventas
// (descuentos, anulaciones, reimpresiones, saltos de numeración, descuadres, horario).
// Solo lee; nunca modifica ventas. Lo usan la pantalla Antifraude y el gerente digital.
export const REGLAS = REGLAS_DEFECTO;
export const FECHA = (c) => `(${c} at time zone 'America/Tegucigalpa')::date`;

/** Calcula las alertas de una empresa en un rango. Solo lee; nunca modifica ventas. */
export async function calcularAlertas(q, { empresaId, sucursalIds = [], desde, hasta, reglas }) {
  const R = { ...REGLAS, ...reglas };
  const base = [empresaId, sucursalIds, desde, hasta];
  const filtro = `v.empresa_id = $1 and ($2::uuid[] = '{}' or v.sucursal_id = any($2::uuid[])) and ${FECHA('coalesce(v.fecha_emision, v.created_at)')} between $3::date and $4::date`;
  const [desc, anul, reimp, huecos, cierres, horario] = await Promise.all([
    q.query(`select u.nombre as usuario, count(*)::int as facturas, sum(v.descuento)::numeric as descuento, sum(v.total + v.descuento)::numeric as bruto
               from pos.ventas v join core.usuarios u on u.id = v.cajero_id where v.estado = 'pagada' and ${filtro} group by u.nombre`, base),
    q.query(`select u.nombre as usuario, count(*) filter (where v.estado = 'anulada')::int as anuladas, count(*)::int as total, coalesce(sum(v.total) filter (where v.estado = 'anulada'),0)::numeric as monto
               from pos.ventas v join core.usuarios u on u.id = v.cajero_id where v.estado in ('pagada','anulada') and ${filtro} group by u.nombre`, base),
    q.query(`select coalesce(usuario_nombre, 'desconocido') as usuario, count(*)::int as n from core.auditoria
              where empresa_id = $1 and accion = 'factura_reimpresa' and ${FECHA('created_at')} between $2::date and $3::date group by 1`, [empresaId, desde, hasta]),
    q.query(`select s.nombre as sucursal, x.punto, x.anterior, x.actual from (
               select v.sucursal_id, v.punto_emision_id as punto, v.correlativo as actual, lag(v.correlativo) over (partition by v.punto_emision_id order by v.correlativo) as anterior
                 from pos.ventas v where v.empresa_id = $1 and v.correlativo is not null and v.estado in ('pagada','anulada')) x
               join core.sucursales s on s.id = x.sucursal_id where x.anterior is not null and x.actual - x.anterior > 1 and ($2::uuid[] = '{}' or x.sucursal_id = any($2::uuid[]))
               order by x.actual desc limit 20`, [empresaId, sucursalIds]),
    q.query(`select t.id, s.nombre as sucursal, u.nombre as usuario, t.diferencia, t.abierto_at from pos.turnos t join core.sucursales s on s.id = t.sucursal_id join core.usuarios u on u.id = t.cajero_id
              where t.empresa_id = $1 and t.estado = 'cerrado' and t.diferencia is not null and ${FECHA('t.abierto_at')} between $3::date and $4::date and ($2::uuid[] = '{}' or t.sucursal_id = any($2::uuid[]))`, base),
    q.query(`select u.nombre as usuario, s.nombre as sucursal, v.numero_factura, v.total, v.fecha_emision from pos.ventas v join core.usuarios u on u.id = v.cajero_id join core.sucursales s on s.id = v.sucursal_id
              where v.estado = 'pagada' and ${filtro}
                and (extract(hour from v.fecha_emision at time zone 'America/Tegucigalpa') < $5 or extract(hour from v.fecha_emision at time zone 'America/Tegucigalpa') >= $6)
              order by v.fecha_emision desc limit 20`, [...base, R.hora_apertura, R.hora_cierre]),
  ]);

  const A = [];
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
  for (const d of desc.rows) {
    const p = pct(d.descuento, d.bruto);
    if (d.facturas >= R.descuento_min_facturas && p > R.descuento_pct_max) A.push({ tipo: 'descuentos_altos', severidad: 'media', titulo: `${d.usuario}: descuentos de ${p}% de sus ventas`, detalle: `${d.facturas} facturas · L ${Number(d.descuento).toFixed(2)} en descuentos (límite ${R.descuento_pct_max}%)`, usuario: d.usuario });
  }
  for (const a of anul.rows) {
    const p = pct(a.anuladas, a.total);
    if (a.anuladas >= R.anulaciones_min && p > R.anulaciones_pct_max) A.push({ tipo: 'anulaciones_altas', severidad: 'alta', titulo: `${a.usuario}: ${a.anuladas} anulaciones (${p}%)`, detalle: `L ${Number(a.monto).toFixed(2)} anulados de ${a.total} facturas (límite ${R.anulaciones_pct_max}%)`, usuario: a.usuario });
  }
  for (const r of reimp.rows) if (r.n > R.reimpresiones_max) A.push({ tipo: 'reimpresiones', severidad: 'media', titulo: `${r.usuario}: ${r.n} reimpresiones`, detalle: `Más de ${R.reimpresiones_max} en el periodo`, usuario: r.usuario });
  for (const h of huecos.rows) A.push({ tipo: 'hueco_correlativo', severidad: 'alta', titulo: `Salto de numeración en ${h.sucursal}`, detalle: `Del ${h.anterior} se pasó al ${h.actual}: faltan ${h.actual - h.anterior - 1} número(s). Un salto en facturas fiscales debe explicarse al SAR.` });
  const faltantesPor = new Map();
  for (const c of cierres.rows) {
    if (Math.abs(c.diferencia) > R.descuadre_max) A.push({ tipo: 'descuadre_caja', severidad: c.diferencia < 0 ? 'alta' : 'media', titulo: `${c.usuario}: ${c.diferencia < 0 ? 'faltante' : 'sobrante'} de L ${Math.abs(c.diferencia).toFixed(2)}`, detalle: `${c.sucursal} · turno del ${String(c.abierto_at).slice(0, 10)}`, usuario: c.usuario });
    if (c.diferencia < 0) faltantesPor.set(c.usuario, (faltantesPor.get(c.usuario) ?? 0) + 1);
  }
  for (const [u, n] of faltantesPor) if (n >= R.faltantes_reincidencia) A.push({ tipo: 'faltantes_reincidentes', severidad: 'alta', titulo: `${u}: ${n} cierres con faltante`, detalle: 'Reincidencia en el periodo', usuario: u });
  if (horario.rows.length) A.push({ tipo: 'fuera_de_horario', severidad: 'media', titulo: `${horario.rows.length}+ venta(s) fuera de horario (${R.hora_apertura}:00–${R.hora_cierre}:00)`, detalle: horario.rows.slice(0, 5).map((v) => `${v.usuario} · ${v.sucursal} · ${v.numero_factura ?? ''} · L ${Number(v.total).toFixed(2)}`).join(' | ') });
  const orden = { alta: 0, media: 1 };
  return A.sort((a, b) => orden[a.severidad] - orden[b.severidad]);
}

