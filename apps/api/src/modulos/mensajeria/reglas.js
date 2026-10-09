// Consultas de solo lectura que alimentan las alertas por correo y el resumen diario.
// Cada una devuelve datos simples (sin HTML) para poder probarlas y reutilizarlas.
import { fechaHN, horaDeHN, sumarDias, lempiras } from '@grupo/shared';
import { resumenParaGerente } from '../documentos/servicio.js';

/** Hora (HN) desde la que se arma el despacho; antes de las 12:00 la «noche de trabajo» sigue siendo la de ayer. */
export const HORA_MANANA_DESDE = 6;
export const HORA_MANANA_HASTA = 12;

/** Tiendas con gelato que no pesaron la noche `noche` (YYYY-MM-DD). Excluye las fuera de análisis y las cerradas. */
export async function tiendasSinPesar(db, empresaId, noche) {
  const { rows } = await db.query(
    `select s.id, s.nombre
       from core.sucursales s
       left join rep.sucursal_config cfg on cfg.sucursal_id = s.id
      where s.empresa_id = $1 and s.activo and not coalesce(cfg.fuera_de_analisis, false) and not coalesce(cfg.cerrada, false)
        and exists (select 1 from rep.sucursal_sabores ss join rep.sabores sa on sa.id = ss.sabor_id
                     where ss.sucursal_id = s.id and ss.activo and sa.activo)
        and not exists (select 1 from rep.pesajes p
                         where p.sucursal_id = s.id
                           and (p.fecha = $2::date
                                or (p.fecha = $2::date + 1 and p.created_at < ((($2::date + 1)::timestamp + interval '18 hours') at time zone 'UTC'))))
      order by s.orden, s.nombre`, [empresaId, noche]);
  return rows;
}

/** Mañana de despacho: de 6:00 a 11:59 hora de Honduras. Devuelve la noche a revisar o null fuera de ese horario. */
export function nocheDeLaManana(ahora = new Date()) {
  const h = horaDeHN(ahora);
  if (h < HORA_MANANA_DESDE || h >= HORA_MANANA_HASTA) return null;
  return sumarDias(fechaHN(ahora), -1);
}

/** CAI reales por vencer (≤ dias) o con 10 % o menos del rango. Los puntos en BORRADOR (sin CAI real) no cuentan. */
export async function caiPorVencer(db, empresaId, { hoy, dias = 15 }) {
  const { rows } = await db.query(
    `select s.nombre as sucursal, pe.fecha_limite_emision::text as vence,
            (pe.correlativo_hasta - pe.correlativo_actual + 1)::int as restantes,
            (pe.correlativo_hasta - pe.correlativo_desde + 1)::int as total
       from pos.puntos_emision pe join core.sucursales s on s.id = pe.sucursal_id
      where pe.empresa_id = $1 and pe.activo and not pe.es_borrador
        and (pe.fecha_limite_emision <= $2::date
             or (pe.correlativo_hasta - pe.correlativo_actual + 1) <= (pe.correlativo_hasta - pe.correlativo_desde + 1) * 0.1)
      order by pe.fecha_limite_emision nulls last`, [empresaId, sumarDias(hoy, dias)]);
  return rows.map((r) => {
    const dest = r.vence ? Math.round((Date.parse(`${r.vence}T00:00:00Z`) - Date.parse(`${hoy}T00:00:00Z`)) / 86_400_000) : null;
    const motivos = [];
    if (dest !== null && dest < 0) motivos.push(`vencido hace ${-dest} día${dest === -1 ? '' : 's'}`);
    else if (dest !== null && dest <= dias) motivos.push(dest === 0 ? 'vence hoy' : `vence en ${dest} día${dest === 1 ? '' : 's'}`);
    if (r.restantes <= r.total * 0.1) motivos.push(r.restantes <= 0 ? 'rango agotado' : `quedan ${r.restantes} de ${r.total} facturas`);
    return { sucursal: r.sucursal, vence: r.vence, restantes: r.restantes, total: r.total, texto: `${r.sucursal}: ${motivos.join(' y ')}` };
  });
}

/** Documentos vencidos y por vencer (misma lógica del gerente digital; los confidenciales salen anonimizados). */
export async function documentosPorVencer(db, empresa, { hoy }) {
  const r = await resumenParaGerente(db, empresa, { hoy });
  const f = (d) => `${d.titulo}${d.sucursal ? ` (${d.sucursal})` : ''}`;
  return {
    vencidos: r.vencidos.map((d) => ({ ...d, texto: `${f(d)}: vencido hace ${-d.dias} día${d.dias === -1 ? '' : 's'}` })),
    por_vencer: r.por_vencer.map((d) => ({ ...d, texto: `${f(d)}: vence ${d.dias === 0 ? 'hoy' : `en ${d.dias} día${d.dias === 1 ? '' : 's'}`}` })),
    faltantes: r.faltantes.map((d) => ({ ...d, texto: `Falta: ${d.tipo}${d.sucursal ? ` (${d.sucursal})` : ''}` })),
  };
}

/** Alertas del antifraude de severidad alta, aún pendientes, más nuevas que `desdeId`. */
export async function antifraudeAltas(db, empresaId, { desdeId = 0 } = {}) {
  const { rows } = await db.query(
    `select a.id::int as id, a.titulo, a.tipo, a.created_at, s.nombre as sucursal
       from af.alertas a left join core.sucursales s on s.id = a.sucursal_id
      where a.empresa_id = $1 and a.severidad = 'alta' and a.estado = 'pendiente' and a.id > $2
      order by a.id desc limit 30`, [empresaId, desdeId]);
  return rows.map((r) => ({ ...r, texto: `${r.titulo}${r.sucursal ? ` (${r.sucursal})` : ''}` }));
}

/** Cierres de caja con diferencia (valor absoluto) de `umbral` o más, creados después de `desde`. */
export async function descuadresDeCaja(db, empresaId, { desde, umbral = 50 }) {
  const { rows } = await db.query(
    `select c.fecha::text as fecha, s.nombre as sucursal, c.diferencia::float8 as diferencia, c.created_at
       from pos.cierres_caja c join core.sucursales s on s.id = c.sucursal_id
      where c.empresa_id = $1 and c.created_at > $2::timestamptz and abs(c.diferencia) >= $3
      order by c.created_at desc limit 30`, [empresaId, desde, umbral]);
  return rows.map((r) => ({ ...r, texto: `${r.sucursal}, ${r.fecha}: ${r.diferencia < 0 ? 'faltante' : 'sobrante'} de ${lempiras(Math.abs(r.diferencia))}` }));
}

/** Todo lo que lleva el resumen diario de UNA empresa para el día `fecha` (YYYY-MM-DD, Honduras). */
export async function datosResumenEmpresa(db, empresa, { fecha, hoy }) {
  const dia = `(v.fecha_emision at time zone 'America/Tegucigalpa')::date = $2::date`;
  const [suc, cierres, sinCierre, af, cai, docs] = await Promise.all([
    db.query(`select s.nombre as sucursal, count(*)::int as facturas, coalesce(sum(v.total),0)::float8 as total
                from pos.ventas v join core.sucursales s on s.id = v.sucursal_id
               where v.empresa_id = $1 and v.estado = 'pagada' and ${dia} group by s.nombre order by 3 desc`, [empresa.id, fecha]).then((x) => x.rows),
    db.query(`select s.nombre as sucursal, c.total_ventas::float8 as ventas, c.diferencia::float8 as diferencia
                from pos.cierres_caja c join core.sucursales s on s.id = c.sucursal_id where c.empresa_id = $1 and c.fecha = $2::date order by s.nombre`, [empresa.id, fecha]).then((x) => x.rows),
    db.query(`select distinct s.nombre as sucursal from pos.ventas v join core.sucursales s on s.id = v.sucursal_id
               where v.empresa_id = $1 and v.estado = 'pagada' and ${dia}
                 and not exists (select 1 from pos.cierres_caja c where c.sucursal_id = v.sucursal_id and c.fecha = $2::date) order by 1`, [empresa.id, fecha]).then((x) => x.rows.map((r) => r.sucursal)),
    db.query(`select severidad, count(*)::int as n from af.alertas where empresa_id = $1 and (created_at at time zone 'America/Tegucigalpa')::date = $2::date group by severidad`, [empresa.id, fecha]).then((x) => x.rows),
    caiPorVencer(db, empresa.id, { hoy }),
    documentosPorVencer(db, empresa, { hoy }),
  ]);
  const out = {
    empresa: { id: empresa.id, nombre: empresa.nombre, color: empresa.color },
    ventas: { sucursales: suc, facturas: suc.reduce((s, x) => s + x.facturas, 0), total: Math.round(suc.reduce((s, x) => s + x.total, 0) * 100) / 100 },
    cierres: { hechos: cierres, sin_cierre: sinCierre, diferencia_total: Math.round(cierres.reduce((s, c) => s + c.diferencia, 0) * 100) / 100 },
    antifraude: { por_severidad: Object.fromEntries(af.map((a) => [a.severidad, a.n])), total: af.reduce((s, a) => s + a.n, 0) },
    cai, documentos: docs, gelato: null,
  };
  if (empresa.modulos?.includes('reposicion')) {
    const despachos = await db.query(`select estado, count(*)::int as n, coalesce(sum(panas),0)::int as panas from rep.despachos where empresa_id = $1 and fecha = $2::date group by estado`, [empresa.id, fecha]);
    out.gelato = {
      noche: fecha,
      sin_pesar: fecha < hoy ? (await tiendasSinPesar(db, empresa.id, fecha)).map((t) => t.nombre) : null,   // la noche de hoy aún no termina
      despachos: Object.fromEntries(despachos.rows.map((d) => [d.estado, { n: d.n, panas: d.panas }])),
    };
  }
  return out;
}
