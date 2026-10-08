// Consultas transversales de personal: directorio con filtros, tarjetas de resumen y calendario.
// Sirven igual a una empresa (/api/rrhh/...) y al grupo (/api/grupo/rrhh/...): solo cambia la lista de empresas.
import { fechaHN, sumarDias } from '@grupo/shared';
import { mascaraIdentidad } from './comun.js';
import { diferenciaDias } from './vacaciones.js';

const mmdd = (f) => f.slice(5);
/** Próxima ocurrencia (en los próximos `dias`) de un cumpleaños/aniversario. null si no cae en la ventana. */
export function proximaFecha(fecha, hoy, dias) {
  if (!fecha) return null;
  const y = Number(hoy.slice(0, 4));
  for (const anio of [y, y + 1]) {
    let md = mmdd(fecha);
    if (md === '02-29' && !(anio % 4 === 0 && (anio % 100 !== 0 || anio % 400 === 0))) md = '02-28';
    const f = `${anio}-${md}`;
    const d = diferenciaDias(hoy, f);
    if (d >= 0) return d <= dias ? { fecha: f, en_dias: d, anios: anio - Number(fecha.slice(0, 4)) } : null;
  }
  return null;
}

/**
 * Directorio. `filtros`: q, empresa (código), sucursal_id, cargo, estado, vence ('30'|'60'|'90'|'vencidos').
 * `sensibles`: Set de empresa_id para las que el usuario ve identidad.
 */
export async function directorio(db, { empresaIds, sensibles, filtros = {} }) {
  const hoy = fechaHN();
  const { rows } = await db.query(
    `select e.id, e.persona_id, e.empresa_id, em.codigo as empresa, em.nombre as empresa_nombre, em.color as empresa_color,
            e.codigo, p.nombres, p.apellidos, p.identidad, p.telefono, p.whatsapp, p.correo, p.fecha_nacimiento, p.sexo,
            e.puesto, e.departamento, e.sucursal_id, s.nombre as sucursal, e.estado, e.motivo_estado, e.fecha_ingreso, e.fecha_salida,
            e.tipo_contrato, e.fecha_fin_contrato, e.fecha_fin_prueba,
            exists (select 1 from rrhh.vacaciones v where v.empleado_id = e.id and v.estado in ('aprobada','tomada') and $2::date between v.desde and v.hasta) as en_vacaciones,
            (select count(*)::int from rrhh.empleados x where x.persona_id = e.persona_id and x.estado <> 'baja') as contratos_activos
       from rrhh.empleados e join rrhh.personas p on p.id = e.persona_id join core.empresas em on em.id = e.empresa_id
       left join core.sucursales s on s.id = e.sucursal_id
      where e.empresa_id = any($1::uuid[])
        and ($3::text is null or em.codigo = $3) and ($4::uuid is null or e.sucursal_id = $4)
        and ($5::text is null or e.puesto ilike '%' || $5 || '%') and ($6::text is null or e.estado = $6)
        and ($7::text is null or (p.nombres || ' ' || p.apellidos || ' ' || coalesce(e.puesto,'') || ' ' || coalesce(e.codigo,'') || ' ' || coalesce(p.telefono,'') || ' ' || coalesce(p.whatsapp,'') || ' ' || coalesce(p.correo,'') || ' ' || coalesce(s.nombre,'')) ilike '%' || $7 || '%'
             or ($8 and p.identidad like '%' || regexp_replace($7, '[^0-9]', '', 'g') || '%' and regexp_replace($7, '[^0-9]', '', 'g') <> ''))
      order by (e.estado = 'baja'), em.orden, p.nombres, p.apellidos`,
    [empresaIds, hoy, filtros.empresa ?? null, filtros.sucursal_id ?? null, filtros.cargo ?? null, filtros.estado ?? null, filtros.q ?? null, empresaIds.some((i) => sensibles.has(i))]);
  let out = rows.map((x) => {
    const finC = x.fecha_fin_contrato, finP = x.fecha_fin_prueba;
    return {
      ...x,
      identidad: sensibles.has(x.empresa_id) ? x.identidad : mascaraIdentidad(x.identidad),
      contrato_dias: finC ? diferenciaDias(hoy, finC) : null,
      prueba_dias: finP ? diferenciaDias(hoy, finP) : null,
    };
  });
  // Búsqueda por identidad: solo cuenta para quien la ve (ya filtrado arriba por empresa); se recorta lo que no debía coincidir.
  if (filtros.q) {
    const ql = filtros.q.toLowerCase(), dig = filtros.q.replace(/\D/g, '');
    out = out.filter((x) => {
      const texto = `${x.nombres} ${x.apellidos} ${x.puesto ?? ''} ${x.codigo ?? ''} ${x.telefono ?? ''} ${x.whatsapp ?? ''} ${x.correo ?? ''} ${x.sucursal ?? ''}`.toLowerCase();
      return texto.includes(ql) || (dig && sensibles.has(x.empresa_id) && String(x.identidad ?? '').includes(dig));
    });
  }
  if (filtros.vence) {
    out = out.filter((x) => x.estado !== 'baja' && x.contrato_dias != null && (filtros.vence === 'vencidos' ? x.contrato_dias < 0 : x.contrato_dias >= 0 && x.contrato_dias <= Number(filtros.vence)));
  }
  const activos = rows.filter((x) => x.estado !== 'baja');
  return {
    hoy, total: out.length, empleados: out,
    opciones: {
      cargos: [...new Set(activos.map((x) => x.puesto).filter(Boolean))].sort(),
      sucursales: [...new Map(rows.filter((x) => x.sucursal_id).map((x) => [x.sucursal_id, { id: x.sucursal_id, nombre: x.sucursal, empresa: x.empresa }])).values()],
    },
  };
}

/** Tarjetas de resumen. */
export async function resumen(db, { empresaIds }) {
  const hoy = fechaHN(), mes = hoy.slice(0, 7), inicioMes = `${mes}-01`;
  const [emps, vacs, aus] = await Promise.all([
    db.query(`select e.id, e.empresa_id, em.codigo as empresa, em.nombre as empresa_nombre, em.color, p.nombres, p.apellidos, p.fecha_nacimiento, e.puesto, e.estado, e.fecha_ingreso, e.fecha_salida,
                     e.fecha_fin_contrato, e.fecha_fin_prueba, e.tipo_contrato
                from rrhh.empleados e join rrhh.personas p on p.id = e.persona_id join core.empresas em on em.id = e.empresa_id
               where e.empresa_id = any($1::uuid[]) order by em.orden`, [empresaIds]),
    db.query(`select v.id, v.empleado_id, v.desde, v.hasta, v.dias, v.estado from rrhh.vacaciones v join rrhh.empleados e on e.id = v.empleado_id
               where e.empresa_id = any($1::uuid[]) and v.estado in ('aprobada','tomada','solicitada') and v.hasta >= $2::date and v.desde <= $3::date`, [empresaIds, hoy, sumarDias(hoy, 45)]),
    db.query(`select a.tipo, count(*)::int as eventos, coalesce(sum(a.dias),0)::float as dias, coalesce(sum(a.minutos),0)::int as minutos
                from rrhh.ausencias a where a.empresa_id = any($1::uuid[]) and a.estado <> 'rechazada' and a.desde >= $2::date and a.desde < ($2::date + interval '1 month') group by a.tipo`, [empresaIds, inicioMes]),
  ]);
  const nom = (x) => `${x.nombres} ${x.apellidos}`.trim();
  const vigentes = emps.rows.filter((x) => x.estado !== 'baja');
  const porId = new Map(emps.rows.map((x) => [x.id, x]));
  const plantilla = [...new Map(emps.rows.map((x) => [x.empresa, { empresa: x.empresa, nombre: x.empresa_nombre, color: x.color }])).values()].map((c) => {
    const l = emps.rows.filter((x) => x.empresa === c.empresa);
    return { ...c, activos: l.filter((x) => x.estado === 'activo' || x.estado === 'vacaciones').length, suspendidos: l.filter((x) => x.estado === 'suspendido').length, bajas: l.filter((x) => x.estado === 'baja').length, total: l.filter((x) => x.estado !== 'baja').length };
  });
  const vv = (v) => { const e = porId.get(v.empleado_id); return { id: v.id, empleado_id: v.empleado_id, nombre: nom(e), empresa: e.empresa, desde: v.desde, hasta: v.hasta, dias: v.dias, estado: v.estado }; };
  const contratos = vigentes.filter((x) => x.fecha_fin_contrato).map((x) => ({ empleado_id: x.id, nombre: nom(x), empresa: x.empresa, puesto: x.puesto, vence: x.fecha_fin_contrato, dias: diferenciaDias(hoy, x.fecha_fin_contrato), tipo: x.tipo_contrato })).filter((x) => x.dias <= 60).sort((a, b) => a.dias - b.dias);
  const pruebas = vigentes.filter((x) => x.fecha_fin_prueba).map((x) => ({ empleado_id: x.id, nombre: nom(x), empresa: x.empresa, vence: x.fecha_fin_prueba, dias: diferenciaDias(hoy, x.fecha_fin_prueba) })).filter((x) => x.dias >= 0 && x.dias <= 30).sort((a, b) => a.dias - b.dias);
  return {
    hoy, plantilla,
    total_activos: plantilla.reduce((s, c) => s + c.activos, 0),
    altas_mes: emps.rows.filter((x) => x.fecha_ingreso && x.fecha_ingreso.startsWith(mes)).map((x) => ({ empleado_id: x.id, nombre: nom(x), empresa: x.empresa, fecha: x.fecha_ingreso })),
    bajas_mes: emps.rows.filter((x) => x.estado === 'baja' && x.fecha_salida && x.fecha_salida.startsWith(mes)).map((x) => ({ empleado_id: x.id, nombre: nom(x), empresa: x.empresa, fecha: x.fecha_salida })),
    cumpleanos: vigentes.map((x) => ({ x, p: proximaFecha(x.fecha_nacimiento, hoy, 30) })).filter((o) => o.p).map(({ x, p }) => ({ empleado_id: x.id, nombre: nom(x), empresa: x.empresa, ...p })).sort((a, b) => a.en_dias - b.en_dias),
    aniversarios: vigentes.map((x) => ({ x, p: proximaFecha(x.fecha_ingreso, hoy, 30) })).filter((o) => o.p && o.p.anios >= 1).map(({ x, p }) => ({ empleado_id: x.id, nombre: nom(x), empresa: x.empresa, ...p })).sort((a, b) => a.en_dias - b.en_dias),
    vacaciones_vigentes: vacs.rows.filter((v) => v.estado !== 'solicitada' && v.desde <= hoy).map(vv),
    vacaciones_proximas: vacs.rows.filter((v) => v.desde > hoy && v.desde <= sumarDias(hoy, 30)).map(vv).sort((a, b) => a.desde.localeCompare(b.desde)),
    ausencias_mes: { por_tipo: aus.rows, eventos: aus.rows.filter((x) => x.tipo !== 'tardanza').reduce((s, x) => s + x.eventos, 0), dias: aus.rows.filter((x) => x.tipo !== 'tardanza').reduce((s, x) => s + x.dias, 0) },
    contratos_por_vencer: contratos, pruebas_por_terminar: pruebas,
    sin_fecha_ingreso: vigentes.filter((x) => !x.fecha_ingreso).length,
  };
}

/** Calendario de vacaciones y ausencias entre dos fechas. */
export async function calendario(db, { empresaIds, desde, hasta }) {
  const [v, a] = await Promise.all([
    db.query(`select v.id, v.empleado_id, v.desde, v.hasta, v.dias, v.estado, p.nombres, p.apellidos, em.codigo as empresa, em.color
                from rrhh.vacaciones v join rrhh.empleados e on e.id = v.empleado_id join rrhh.personas p on p.id = e.persona_id join core.empresas em on em.id = e.empresa_id
               where e.empresa_id = any($1::uuid[]) and v.estado in ('aprobada','tomada','solicitada') and v.hasta >= $2::date and v.desde <= $3::date`, [empresaIds, desde, hasta]),
    db.query(`select a.id, a.empleado_id, a.tipo, a.desde, a.hasta, a.dias, a.estado, a.pagado, p.nombres, p.apellidos, em.codigo as empresa, em.color
                from rrhh.ausencias a join rrhh.empleados e on e.id = a.empleado_id join rrhh.personas p on p.id = e.persona_id join core.empresas em on em.id = e.empresa_id
               where a.empresa_id = any($1::uuid[]) and a.estado <> 'rechazada' and a.tipo <> 'tardanza' and a.hasta >= $2::date and a.desde <= $3::date`, [empresaIds, desde, hasta]),
  ]);
  const nom = (x) => `${x.nombres} ${x.apellidos}`.trim();
  const eventos = [
    ...v.rows.map((x) => ({ id: x.id, empleado_id: x.empleado_id, nombre: nom(x), empresa: x.empresa, color: x.color, clase: 'vacaciones', tipo: 'vacaciones', desde: x.desde, hasta: x.hasta, dias: x.dias, estado: x.estado })),
    ...a.rows.map((x) => ({ id: x.id, empleado_id: x.empleado_id, nombre: nom(x), empresa: x.empresa, color: x.color, clase: 'ausencia', tipo: x.tipo, desde: x.desde, hasta: x.hasta, dias: Number(x.dias), estado: x.estado, pagado: x.pagado })),
  ].sort((p, q) => p.desde.localeCompare(q.desde));
  return { desde, hasta, eventos };
}
