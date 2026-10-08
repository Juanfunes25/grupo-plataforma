import { tiposPorDefecto } from '@grupo/shared';

// Lógica de lectura compartida: la usan las rutas de la empresa, el consolidado de Dirección
// y el gerente digital. Aquí NO se escribe nada salvo la siembra de tipos por defecto.

/** Dueño y administrador ven los documentos «restringidos» (contratos de empleados, etc.). */
export const veRestringidos = (ctx) => ctx.rol === 'dueno' || ctx.rol === 'admin';

/** Estado calculado: archivado > vencido > por vencer (dentro de dias_aviso) > vigente. `h` = placeholder de la fecha de hoy. */
export const estadoSql = (h) => `case when d.archivado then 'archivado' when d.fecha_vencimiento is null then 'vigente'
  when d.fecha_vencimiento < ${h}::date then 'vencido' when d.fecha_vencimiento <= ${h}::date + d.dias_aviso then 'por_vencer' else 'vigente' end`;

export const columnasDoc = (h) => `d.*, ${estadoSql(h)} as estado, t.nombre as tipo_nombre, t.grupo as tipo_grupo, s.nombre as sucursal,
  (d.fecha_vencimiento - ${h}::date) as dias_restantes, (d.fecha_vencimiento - d.dias_aviso) as fecha_aviso,
  case when d.empleado_id is not null then btrim(p.nombres || ' ' || coalesce(p.apellidos, '')) end as empleado,
  v.nombre_archivo, v.mime, v.tamano, v.created_at as version_fecha`;
export const unionesDoc = `from doc.documentos d
  left join doc.tipos t on t.empresa_id = d.empresa_id and t.codigo = d.tipo
  left join core.sucursales s on s.id = d.sucursal_id
  left join rrhh.empleados e on e.id = d.empleado_id left join rrhh.personas p on p.id = e.persona_id
  left join doc.versiones v on v.documento_id = d.id and v.numero = d.version_actual`;

const sembrados = new Set();
/** Siembra (una vez por empresa) los tipos por defecto según su tipo de negocio. Idempotente. */
export async function asegurarTipos(q, empresa) {
  if (sembrados.has(empresa.id)) return;
  const t = tiposPorDefecto(empresa.tipo_negocio);
  await q.query(
    `insert into doc.tipos (empresa_id, codigo, nombre, grupo, requiere_vencimiento, confidencial, dias_aviso, de_empleado, esperado, por_sucursal, orden)
     select $1, x.codigo, x.nombre, x.grupo, x.rv, x.conf, x.dias, x.emp, x.esp, x.ps, x.orden
       from jsonb_to_recordset($2::jsonb) as x(codigo text, nombre text, grupo text, rv boolean, conf boolean, dias int, emp boolean, esp boolean, ps boolean, orden int)
     on conflict (empresa_id, codigo) do nothing`,
    [empresa.id, JSON.stringify(t.map((x) => ({ codigo: x.codigo, nombre: x.nombre, grupo: x.grupo, rv: x.requiere_vencimiento, conf: x.confidencial, dias: x.dias_aviso, emp: x.de_empleado, esp: x.esperado, ps: x.por_sucursal, orden: x.orden })))]);
  sembrados.add(empresa.id);
}

/** Contadores del tablero: vigentes, por vencer 30/60/90 días y vencidos. */
export async function kpis(q, empresaId, { hoy, verRestringido, sucursalIds = [] }) {
  const { rows: [k] } = await q.query(
    `select count(*) filter (where not archivado)::int as activos,
            count(*) filter (where not archivado and (fecha_vencimiento is null or fecha_vencimiento >= $2::date))::int as vigentes,
            count(*) filter (where not archivado and fecha_vencimiento < $2::date)::int as vencidos,
            count(*) filter (where not archivado and fecha_vencimiento between $2::date and $2::date + 30)::int as d30,
            count(*) filter (where not archivado and fecha_vencimiento between $2::date + 31 and $2::date + 60)::int as d60,
            count(*) filter (where not archivado and fecha_vencimiento between $2::date + 61 and $2::date + 90)::int as d90,
            count(*) filter (where archivado)::int as archivados
       from doc.documentos
      where empresa_id = $1 and eliminado_at is null and ($3::boolean or confidencialidad = 'normal')
        and ($4::uuid[] = '{}' or sucursal_id is null or sucursal_id = any($4::uuid[]))`,
    [empresaId, hoy, verRestringido, sucursalIds]);
  return k;
}

/** Documentos que vencen dentro de `dias` (o ya vencidos), del más urgente al menos. */
export async function proximos(q, empresaId, { hoy, dias = 90, verRestringido, sucursalIds = [], limite = 300 }) {
  const { rows } = await q.query(
    `select ${columnasDoc('$2')}, case when d.fecha_vencimiento < $2::date then 'vencido' when d.fecha_vencimiento <= $2::date + 30 then 'd30'
                                      when d.fecha_vencimiento <= $2::date + 60 then 'd60' else 'd90' end as franja
       ${unionesDoc}
      where d.empresa_id = $1 and d.eliminado_at is null and not d.archivado and d.fecha_vencimiento is not null and d.fecha_vencimiento <= $2::date + $3::int
        and ($4::boolean or d.confidencialidad = 'normal') and ($5::uuid[] = '{}' or d.sucursal_id is null or d.sucursal_id = any($5::uuid[]))
      order by d.fecha_vencimiento, d.titulo limit $6`,
    [empresaId, hoy, dias, verRestringido, sucursalIds, limite]);
  return rows;
}

/**
 * Checklist de documentos esperados: por cada tipo marcado «esperado» (y por cada sucursal si es por sucursal),
 * dice si hay uno vigente. estado: ok | por_vencer | vencido (solo hay vencidos) | falta (no hay ninguno).
 */
export async function checklist(q, empresa, { hoy, verRestringido = true, sucursalIds = [] }) {
  await asegurarTipos(q, empresa);
  const [tipos, sucs, docs] = await Promise.all([
    q.query(`select codigo, nombre, grupo, por_sucursal from doc.tipos where empresa_id = $1 and activo and esperado order by orden, nombre`, [empresa.id]),
    q.query(`select id, nombre, alias from core.sucursales where empresa_id = $1 and activo order by orden, nombre`, [empresa.id]),
    q.query(
      `select d.id, d.tipo, d.sucursal_id, d.fecha_vencimiento, ${estadoSql('$2')} as estado from doc.documentos d
        where d.empresa_id = $1 and d.eliminado_at is null and not d.archivado and ($3::boolean or d.confidencialidad = 'normal')`, [empresa.id, hoy, verRestringido]),
  ]);
  const sucursales = sucursalIds.length ? sucs.rows.filter((s) => sucursalIds.includes(s.id)) : sucs.rows;
  const items = [];
  const evaluar = (t, suc) => {
    const propios = docs.rows.filter((d) => d.tipo === t.codigo && (suc ? d.sucursal_id === suc.id : true));
    const vigentes = propios.filter((d) => d.estado !== 'vencido').sort((a, b) => (b.fecha_vencimiento ?? '9999').localeCompare(a.fecha_vencimiento ?? '9999'));
    const mejor = vigentes[0] ?? propios.sort((a, b) => (b.fecha_vencimiento ?? '').localeCompare(a.fecha_vencimiento ?? ''))[0];
    const estado = !propios.length ? 'falta' : vigentes.length ? (vigentes[0].estado === 'por_vencer' ? 'por_vencer' : 'ok') : 'vencido';
    items.push({ tipo: t.codigo, tipo_nombre: t.nombre, grupo: t.grupo, sucursal_id: suc?.id ?? null, sucursal: suc?.nombre ?? null, estado, documento_id: mejor?.id ?? null, vence: mejor?.fecha_vencimiento ?? null });
  };
  for (const t of tipos.rows) {
    if (t.por_sucursal && sucursales.length) for (const s of sucursales) evaluar(t, s);
    else evaluar(t, null);
  }
  const cuenta = (e) => items.filter((i) => i.estado === e).length;
  return { items, resumen: { total: items.length, ok: cuenta('ok'), por_vencer: cuenta('por_vencer'), vencido: cuenta('vencido'), falta: cuenta('falta') } };
}

/** Lo que necesita el gerente digital de la empresa: vencidos, por vencer y faltantes (títulos de confidenciales anonimizados). */
export async function resumenParaGerente(q, empresa, { hoy }) {
  await asegurarTipos(q, empresa);
  const { rows } = await q.query(
    `select ${columnasDoc('$2')} ${unionesDoc}
      where d.empresa_id = $1 and d.eliminado_at is null and not d.archivado and d.fecha_vencimiento is not null
        and d.fecha_vencimiento <= $2::date + d.dias_aviso order by d.fecha_vencimiento`, [empresa.id, hoy]);
  const f = (d) => ({
    titulo: d.confidencialidad === 'restringido' ? `Documento confidencial (${d.tipo_nombre ?? d.tipo})` : d.titulo,
    tipo: d.tipo_nombre ?? d.tipo, sucursal: d.sucursal ?? null, vence: d.fecha_vencimiento, dias: d.dias_restantes,
  });
  const cl = await checklist(q, empresa, { hoy });
  return {
    vencidos: rows.filter((d) => d.estado === 'vencido').map(f),
    por_vencer: rows.filter((d) => d.estado === 'por_vencer').map(f),
    faltantes: cl.items.filter((i) => i.estado === 'falta').map((i) => ({ tipo: i.tipo_nombre, sucursal: i.sucursal })),
  };
}
