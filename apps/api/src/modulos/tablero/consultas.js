// Consultas del tablero del dueño. Todo se mide en días de Honduras (UTC-6); nunca la fecha UTC.
import { fechaHN, sumarDias } from '@grupo/shared';
import { proximos } from '../documentos/servicio.js';
import { armarDias, armarTablero, horaCorteHN } from './calculo.js';

const TZ = `'America/Tegucigalpa'`;
const LOCAL = `(v.fecha_emision at time zone ${TZ})`;

/**
 * Tablero de UNA empresa: hoy vs ayer vs mismo día de la semana pasada, por sucursal, formas de pago,
 * tendencia de 7 días y margen. `sucursalIds` vacío = todas las sucursales de la empresa.
 */
export async function tableroEmpresa(db, { empresaId, sucursalIds = [], ahora = new Date() }) {
  const hoy = fechaHN(ahora), ayer = sumarDias(hoy, -1), semana = sumarDias(hoy, -7);
  const corte = horaCorteHN(ahora);
  const fechas = Array.from({ length: 8 }, (_, i) => sumarDias(hoy, i - 7));   // hoy-7 … hoy
  const filtro = `v.empresa_id = $1 and v.estado = 'pagada' and ($2::uuid[] = '{}' or v.sucursal_id = any($2::uuid[]))
                  and ${LOCAL}::date between $3::date and $4::date`;
  const args = [empresaId, sucursalIds, semana, hoy];
  const [ventas, margen, pagos, sucs] = await Promise.all([
    db.query(`select ${LOCAL}::date::text as fecha, v.sucursal_id, count(*)::int as facturas, sum(v.total)::numeric as total,
                     (count(*) filter (where ${LOCAL}::time <= $5::time))::int as facturas_corte,
                     coalesce(sum(v.total) filter (where ${LOCAL}::time <= $5::time), 0)::numeric as total_corte
                from pos.ventas v where ${filtro} group by 1, 2`, [...args, corte]).then((r) => r.rows),
    db.query(`select ${LOCAL}::date::text as fecha, coalesce(sum(d.monto), 0)::numeric as venta,
                     coalesce(sum(d.monto) filter (where d.costo_unitario is not null), 0)::numeric as venta_costeada,
                     coalesce(sum(d.cantidad * d.costo_unitario) filter (where d.costo_unitario is not null), 0)::numeric as costo
                from pos.detalle_venta d join pos.ventas v on v.id = d.venta_id where ${filtro} group by 1`, args).then((r) => r.rows),
    db.query(`select f.nombre, f.tipo, sum(p.monto)::numeric as monto
                from pos.venta_pagos p join pos.formas_pago f on f.id = p.forma_pago_id join pos.ventas v on v.id = p.venta_id
               where v.empresa_id = $1 and v.estado = 'pagada' and ($2::uuid[] = '{}' or v.sucursal_id = any($2::uuid[])) and ${LOCAL}::date = $3::date
               group by f.nombre, f.tipo order by 3 desc`, [empresaId, sucursalIds, hoy]).then((r) => r.rows),
    db.query(`select id, nombre, color from core.sucursales where empresa_id = $1 and activo and ($2::uuid[] = '{}' or id = any($2::uuid[])) order by orden, nombre`,
      [empresaId, sucursalIds]).then((r) => r.rows),
  ]);
  const dias = armarDias({ fechas, ventas, margen });
  return {
    fecha: hoy, hora_corte: corte.slice(0, 5), generado_at: ahora.toISOString(),
    ...armarTablero({ hoy, ayer, semana, dias, ventas, sucursales: sucs, pagos, tendenciaFechas: fechas.slice(1) }),
  };
}

/**
 * Alertas que el dueño debe ver arriba. Cada una dice qué es, cuántas hay y a qué módulo ir.
 * `ver` indica qué familias de alertas puede ver quien consulta (según sus permisos).
 */
export async function alertasEmpresa(db, { empresaId, empresaNombre = null, sucursalIds = [], hoy = fechaHN(), ver = {} }) {
  const out = [];
  const poner = (a) => out.push({ empresa: empresaNombre, ...a });
  const suc = sucursalIds;
  const tareas = [];

  if (ver.cai) {
    tareas.push(db.query(
      `select s.nombre as sucursal, pe.fecha_limite_emision::text as vence, (pe.correlativo_hasta - pe.correlativo_actual + 1) as restantes
         from pos.puntos_emision pe join core.sucursales s on s.id = pe.sucursal_id
        where pe.empresa_id = $1 and pe.activo and not pe.es_borrador and ($3::uuid[] = '{}' or pe.sucursal_id = any($3::uuid[]))
          and (pe.fecha_limite_emision <= $2::date + 15 or (pe.correlativo_hasta - pe.correlativo_actual + 1) <= (pe.correlativo_hasta - pe.correlativo_desde + 1) * 0.1)`,
      [empresaId, hoy, suc]).then(({ rows }) => {
      if (!rows.length) return;
      const vencido = rows.some((r) => r.vence <= hoy);
      poner({ tipo: 'cai', severidad: vencido ? 'alta' : 'media', cantidad: rows.length, modulo: 'cai',
        titulo: vencido ? 'CAI vencido' : 'CAI por vencer o por agotarse',
        detalle: rows.slice(0, 3).map((r) => `${r.sucursal}: vence ${r.vence}, quedan ${r.restantes}`).join(' · ') });
    }));
  }
  if (ver.inventario) {
    tareas.push(db.query(
      `select count(*)::int as n, (array_agg(i.nombre order by st.cantidad))[1:3] as ejemplos
         from inv.stock st join inv.insumos i on i.id = st.insumo_id
        where st.empresa_id = $1 and st.cantidad < 0 and ($2::uuid[] = '{}' or st.sucursal_id = any($2::uuid[]))`, [empresaId, suc]).then(({ rows }) => {
      if (rows[0]?.n > 0) poner({ tipo: 'stock_negativo', severidad: 'media', cantidad: rows[0].n, modulo: 'inventario', titulo: 'Inventario en negativo', detalle: (rows[0].ejemplos ?? []).join(', ') });
    }));
    tareas.push(db.query(
      `select count(*)::int as n, (array_agg(i.nombre order by l.vence_at))[1:3] as ejemplos
         from inv.lotes l join inv.insumos i on i.id = l.insumo_id
        where l.empresa_id = $1 and l.cantidad_actual > 0 and l.vence_at <= $3::date + 2 and ($2::uuid[] = '{}' or l.sucursal_id = any($2::uuid[]))`, [empresaId, suc, hoy]).then(({ rows }) => {
      if (rows[0]?.n > 0) poner({ tipo: 'por_vencer', severidad: 'media', cantidad: rows[0].n, modulo: 'inventario', titulo: 'Producto por vencer (48 h)', detalle: (rows[0].ejemplos ?? []).join(', ') });
    }));
  }
  if (ver.caja) {
    tareas.push(db.query(
      `select s.nombre as sucursal, u.nombre as cajero from pos.turnos t join core.sucursales s on s.id = t.sucursal_id join core.usuarios u on u.id = t.cajero_id
        where t.empresa_id = $1 and t.estado = 'abierto' and t.abierto_at < now() - interval '18 hours' and ($2::uuid[] = '{}' or t.sucursal_id = any($2::uuid[]))`,
      [empresaId, suc]).then(({ rows }) => {
      if (rows.length) poner({ tipo: 'turno_olvidado', severidad: 'media', cantidad: rows.length, modulo: 'cierres', titulo: 'Turnos de caja sin cerrar', detalle: rows.slice(0, 3).map((r) => `${r.sucursal} (${r.cajero})`).join(' · ') });
    }));
    // Sucursales que venden y suelen hacer cierre, pero ayer no lo hicieron.
    tareas.push(db.query(
      `select s.nombre from core.sucursales s
        where s.empresa_id = $1 and s.activo and ($2::uuid[] = '{}' or s.id = any($2::uuid[]))
          and exists (select 1 from pos.ventas v where v.sucursal_id = s.id and v.estado = 'pagada' and (v.fecha_emision at time zone ${TZ})::date = $3::date - 1)
          and exists (select 1 from pos.cierres_caja c where c.sucursal_id = s.id and c.fecha between $3::date - 30 and $3::date - 2)
          and not exists (select 1 from pos.cierres_caja c where c.sucursal_id = s.id and c.fecha >= $3::date - 1)`,
      [empresaId, suc, hoy]).then(({ rows }) => {
      if (rows.length) poner({ tipo: 'sin_cierre', severidad: 'alta', cantidad: rows.length, modulo: 'cierres', titulo: 'Falta el cierre de caja de ayer', detalle: rows.map((r) => r.nombre).join(', ') });
    }));
  }
  if (ver.antifraude) {
    tareas.push(db.query(
      `select count(*)::int as n, count(*) filter (where severidad = 'alta')::int as altas from af.alertas
        where empresa_id = $1 and estado = 'pendiente' and ($2::uuid[] = '{}' or sucursal_id is null or sucursal_id = any($2::uuid[]))`, [empresaId, suc]).then(({ rows }) => {
      if (rows[0]?.n > 0) poner({ tipo: 'antifraude', severidad: rows[0].altas > 0 ? 'alta' : 'media', cantidad: rows[0].n, modulo: 'antifraude', titulo: 'Alertas de control sin revisar', detalle: rows[0].altas ? `${rows[0].altas} de severidad alta` : '' });
    }));
  }
  if (ver.documentos) {
    tareas.push(proximos(db, empresaId, { hoy, dias: 30, verRestringido: ver.restringidos === true, sucursalIds: suc, limite: 100 }).then((rows) => {
      if (!rows.length) return;
      const vencidos = rows.filter((d) => d.fecha_vencimiento < hoy).length;
      poner({ tipo: 'documentos', severidad: vencidos ? 'alta' : 'media', cantidad: rows.length, modulo: 'documentos',
        titulo: vencidos ? `${vencidos} documento(s) vencido(s)` : 'Documentos por vencer (30 días)',
        detalle: rows.slice(0, 3).map((d) => `${d.titulo} (${d.fecha_vencimiento})`).join(' · ') });
    }));
  }
  await Promise.all(tareas);
  const peso = { alta: 0, media: 1, info: 2 };
  return out.sort((a, b) => peso[a.severidad] - peso[b.severidad]);
}
