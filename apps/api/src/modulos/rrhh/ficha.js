// La FICHA completa de un empleado: la usan igual la pantalla Personal de cada empresa
// (/api/rrhh/empleados/:id/ficha) y Dirección del grupo (/api/grupo/rrhh/empleados/:id).
// Los datos sensibles (salario, cuenta bancaria, identidad…) salen solo si `sensible` es true.
import { fechaHN, sumarDias } from '@grupo/shared';
import { calcularVacaciones, mesesCumplidos } from './vacaciones.js';
import { asistenciaDiaria } from './horas.js';
import { SENSIBLES_EMPLEADO, SENSIBLES_PERSONA, edadDe, formatoIdentidad, mascaraCuenta, mascaraIdentidad } from './comun.js';

/** Aplica la máscara de datos sensibles a la fila de persona. */
export function ocultarPersona(p, sensible) {
  const o = { ...p };
  o.identidad_formato = sensible ? formatoIdentidad(p.identidad) : mascaraIdentidad(p.identidad);
  if (sensible) return o;
  for (const k of SENSIBLES_PERSONA) o[k] = null;
  o.cuenta_bancaria_mascara = mascaraCuenta(p.cuenta_bancaria);
  o.tiene_cuenta = Boolean(p.cuenta_bancaria);
  return o;
}
export function ocultarEmpleado(e, sensible) {
  if (sensible) return e;
  const o = { ...e };
  for (const k of SENSIBLES_EMPLEADO) o[k] = null;
  return o;
}

/** Cuenta ausencias por año y tipo («cuántos días ha tomado libre»). */
export function contadoresAusencias(ausencias, vacaciones) {
  const por = new Map();
  const anio = (f) => Number(String(f).slice(0, 4));
  const get = (a) => {
    if (!por.has(a)) por.set(a, { anio: a, por_tipo: {}, dias_fuera: 0, libres_tomados: 0, dias_pagados: 0, dias_no_pagados: 0, tardanzas: 0, minutos_tarde: 0, vacaciones_tomadas: 0, pendientes_de_aprobar: 0 });
    return por.get(a);
  };
  for (const a of ausencias) {
    const c = get(anio(a.desde));
    if (a.estado === 'pendiente') { c.pendientes_de_aprobar += 1; continue; }
    if (a.estado === 'rechazada') continue;
    const t = (c.por_tipo[a.tipo] ??= { eventos: 0, dias: 0 });
    t.eventos += 1;
    if (a.tipo === 'tardanza') { c.tardanzas += 1; c.minutos_tarde += a.minutos ?? 0; continue; }
    t.dias += Number(a.dias);
    c.dias_fuera += Number(a.dias);
    if (a.tipo === 'dia_libre' || a.tipo === 'permiso') c.libres_tomados += Number(a.dias);
    if (a.pagado) c.dias_pagados += Number(a.dias); else c.dias_no_pagados += Number(a.dias);
  }
  for (const v of vacaciones) if (v.estado === 'aprobada' || v.estado === 'tomada') get(anio(v.desde)).vacaciones_tomadas += v.dias ?? 0;
  const lista = [...por.values()].sort((a, b) => b.anio - a.anio);
  const anioActual = Number(fechaHN().slice(0, 4));
  if (!lista.find((x) => x.anio === anioActual)) lista.unshift(get(anioActual));
  return lista.sort((a, b) => b.anio - a.anio);
}

/** Línea de tiempo del empleado: todo lo que le ha pasado, lo más reciente primero. */
export function lineaDeTiempo({ empleado, historial, vacaciones, ausencias, sanciones, evaluaciones, capacitaciones }) {
  const ev = [];
  const hayIngreso = historial.some((h) => h.tipo === 'ingreso');
  if (empleado.fecha_ingreso && !hayIngreso) ev.push({ fecha: empleado.fecha_ingreso, tipo: 'ingreso', titulo: 'Ingreso a la empresa', detalle: empleado.puesto });
  for (const h of historial) ev.push({ fecha: h.fecha, tipo: h.tipo, titulo: h.descripcion, detalle: h.usuario ? `Registró ${h.usuario}` : null });
  for (const v of vacaciones) if (v.estado !== 'cancelada') ev.push({ fecha: v.desde, tipo: 'vacaciones', titulo: `Vacaciones ${v.estado}`, detalle: `${v.desde} al ${v.hasta} · ${v.dias} día(s)` });
  for (const a of ausencias) ev.push({ fecha: a.desde, tipo: a.tipo, titulo: `${ETQ_AUSENCIA[a.tipo] ?? a.tipo}${a.estado !== 'aprobada' ? ` (${a.estado})` : ''}`, detalle: [a.dias ? `${a.dias} día(s)` : a.minutos ? `${a.minutos} min` : null, a.motivo, a.pagado ? null : 'sin goce'].filter(Boolean).join(' · ') });
  for (const s of sanciones) ev.push({ fecha: s.fecha, tipo: 'sancion', titulo: `Amonestación ${s.tipo}${s.estado === 'anulada' ? ' (anulada)' : ''}`, detalle: s.motivo });
  for (const e of evaluaciones) ev.push({ fecha: e.fecha, tipo: 'evaluacion', titulo: `Evaluación${e.periodo ? ` ${e.periodo}` : ''}`, detalle: e.puntaje != null ? `Puntaje ${e.puntaje}` : null });
  for (const c of capacitaciones) ev.push({ fecha: c.fecha, tipo: 'capacitacion', titulo: `Capacitación: ${c.nombre}`, detalle: [c.estado, c.horas ? `${c.horas} h` : null].filter(Boolean).join(' · ') });
  return ev.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
}
export const ETQ_AUSENCIA = { ausencia: 'Ausencia', permiso: 'Permiso', dia_libre: 'Día libre', incapacidad: 'Incapacidad', tardanza: 'Llegada tarde', licencia: 'Licencia' };

/**
 * Arma la ficha. `empresaId` (opcional) obliga a que el empleado sea de esa empresa.
 * `permisos` = { editar, sensible } ya resueltos para la empresa del empleado.
 */
export async function armarFicha(db, { empleadoId, empresaId = null, permisos }) {
  const hoy = fechaHN();
  const e = (await db.query(
    `select e.*, em.codigo as empresa, em.nombre as empresa_nombre, em.color as empresa_color,
            s.nombre as sucursal, jp.nombres || ' ' || jp.apellidos as jefe_nombre
       from rrhh.empleados e join core.empresas em on em.id = e.empresa_id
       left join core.sucursales s on s.id = e.sucursal_id
       left join rrhh.empleados j on j.id = e.jefe_id left join rrhh.personas jp on jp.id = j.persona_id
      where e.id = $1 and ($2::uuid is null or e.empresa_id = $2)`, [empleadoId, empresaId])).rows[0];
  if (!e) return null;
  const sensible = Boolean(permisos.sensible);
  const [persona, otros, extra, vacs, ausc, sanc, evals, caps, hist, sal, hor, marcas] = await Promise.all([
    db.query('select * from rrhh.personas where id = $1', [e.persona_id]),
    db.query(`select x.id as empleado_id, em.codigo as empresa, em.nombre as empresa_nombre, x.puesto, x.estado, s.nombre as sucursal
                from rrhh.empleados x join core.empresas em on em.id = x.empresa_id left join core.sucursales s on s.id = x.sucursal_id
               where x.persona_id = $1 and x.id <> $2 order by em.orden`, [e.persona_id, e.id]),
    db.query(`select s.id, s.nombre from rrhh.empleado_sucursales es join core.sucursales s on s.id = es.sucursal_id where es.empleado_id = $1 order by s.nombre`, [e.id]),
    db.query(`select v.id, v.desde, v.hasta, v.dias, v.estado, v.nota, v.motivo_rechazo, v.resuelta_at, u.nombre as resuelta_por_nombre
                from rrhh.vacaciones v left join core.usuarios u on u.id = v.resuelta_por where v.empleado_id = $1 order by v.desde desc`, [e.id]),
    db.query(`select a.*, u.nombre as aprobado_por_nombre from rrhh.ausencias a left join core.usuarios u on u.id = a.aprobado_por where a.empleado_id = $1 order by a.desde desc, a.created_at desc`, [e.id]),
    db.query(`select s.*, u.nombre as emitida_por_nombre from rrhh.sanciones s left join core.usuarios u on u.id = s.emitida_por where s.empleado_id = $1 order by s.fecha desc, s.created_at desc`, [e.id]),
    db.query(`select v.*, u.nombre as evaluador_nombre from rrhh.evaluaciones v left join core.usuarios u on u.id = v.evaluador_id where v.empleado_id = $1 order by v.fecha desc`, [e.id]),
    db.query('select * from rrhh.capacitaciones where empleado_id = $1 order by fecha desc', [e.id]),
    db.query(`select h.id, h.fecha, h.tipo, h.descripcion, h.anterior, h.nuevo, u.nombre as usuario
                from rrhh.historial h left join core.usuarios u on u.id = h.registrado_por where h.empleado_id = $1 order by h.fecha desc, h.created_at desc`, [e.id]),
    sensible ? db.query(`select h.id, h.salario_anterior, h.salario_nuevo, h.tipo_pago, h.motivo, h.vigente_desde, u.nombre as usuario
                           from rrhh.salarios_historial h left join core.usuarios u on u.id = h.registrado_por where h.empleado_id = $1 order by h.vigente_desde desc, h.created_at desc`, [e.id]) : { rows: [] },
    db.query(`select h.dia_semana, h.estado, h.entrada::text, h.salida::text, h.sucursal_id, s.nombre as sucursal
                from rrhh.horarios h left join core.sucursales s on s.id = h.sucursal_id where h.empleado_id = $1 order by h.dia_semana`, [e.id]),
    db.query(`select tipo, marcada_at, verificacion, distancia_metros from rrhh.marcaciones where empleado_id = $1
                 and (marcada_at at time zone 'America/Tegucigalpa')::date between $2::date and $3::date order by marcada_at`, [e.id, sumarDias(hoy, -30), sumarDias(hoy, 1)]),
  ]);

  const vac = calcularVacaciones({ ingreso: e.fecha_ingreso, hoy: e.estado === 'baja' && e.fecha_salida && e.fecha_salida < hoy ? e.fecha_salida : hoy, tomadas: vacs.rows });
  const vigentes = vacs.rows.filter((v) => (v.estado === 'aprobada' || v.estado === 'tomada') && v.desde <= hoy && v.hasta >= hoy);
  const proximas = vacs.rows.filter((v) => v.estado === 'aprobada' && v.desde > hoy).sort((a, b) => a.desde.localeCompare(b.desde));
  const asist = asistenciaDiaria({
    desde: sumarDias(hoy, -30), hasta: hoy, marcaciones: marcas.rows.map((m) => ({ ...m, empleado_id: e.id })), horarios: hor.rows,
    ausencias: ausc.rows, vacaciones: vacs.rows,
  });
  const per = ocultarPersona(persona.rows[0], sensible);
  const emp = ocultarEmpleado(e, sensible);
  emp.antiguedad_meses = e.fecha_ingreso ? mesesCumplidos(e.fecha_ingreso, hoy) : null;
  emp.edad = edadDe(per.fecha_nacimiento, hoy);
  emp.sucursales_extra = extra.rows;
  emp.salario_oculto = !sensible;

  return {
    hoy, permisos: { editar: Boolean(permisos.editar), sensible },
    empleado: emp, persona: per, otros_contratos: otros.rows,
    vacaciones: { resumen: vac, lista: vacs.rows, vigentes, proximas },
    ausencias: { lista: ausc.rows, contadores: contadoresAusencias(ausc.rows, vacs.rows) },
    sanciones: sanc.rows, evaluaciones: evals.rows, capacitaciones: caps.rows,
    historial: hist.rows, salarios: sensible ? sal.rows : null,
    horarios: hor.rows, asistencia: { desde: sumarDias(hoy, -30), hasta: hoy, ...asist },
    linea: lineaDeTiempo({ empleado: e, historial: hist.rows, vacaciones: vacs.rows, ausencias: ausc.rows, sanciones: sanc.rows, evaluaciones: evals.rows, capacitaciones: caps.rows }),
  };
}
