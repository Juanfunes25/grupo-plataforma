import { Router } from 'express';
import { z } from 'zod';
import { fechaHN, sumarDias } from '@grupo/shared';
import { requierePermiso, resolverSucursal } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { conflicto, malaPeticion, noEncontrado, prohibido, uuid, validar, dinero, fechaISO } from '../../lib/http.js';

const txt = (n) => z.string().trim().max(n).optional().nullable().transform((v) => v || null);
const esqEmpleado = z.object({
  nombres: z.string().trim().min(2).max(100), apellidos: z.string().trim().max(100).default(''),
  identidad: z.string().trim().max(20).optional().nullable().transform((v) => (v ? v.replace(/[\s-]/g, '') : null)),
  fecha_nacimiento: fechaISO.optional().nullable(), telefono: txt(40), correo: txt(120), direccion: txt(250),
  puesto: z.string().trim().min(2).max(80), departamento: txt(60), sucursal_id: uuid.optional().nullable(),
  fecha_ingreso: fechaISO.optional(), salario_mensual: dinero.optional().nullable(), usuario_id: uuid.optional().nullable(), notas: txt(400),
});

/** Horas trabajadas por empleado emparejando entrada→salida (una jornada sin salida no suma). */
export function calcularHoras(marcas) {
  const por = new Map();
  for (const m of [...marcas].sort((a, b) => new Date(a.marcada_at) - new Date(b.marcada_at))) {
    const e = por.get(m.empleado_id) ?? { horas: 0, jornadas: 0, abierta: null, sin_salida: 0 };
    if (m.tipo === 'entrada') { if (e.abierta) e.sin_salida += 1; e.abierta = new Date(m.marcada_at); }
    else if (e.abierta) {
      const h = (new Date(m.marcada_at) - e.abierta) / 3_600_000;
      if (h > 0 && h <= 20) { e.horas += h; e.jornadas += 1; } else e.sin_salida += 1;
      e.abierta = null;
    }
    por.set(m.empleado_id, e);
  }
  for (const e of por.values()) { if (e.abierta) e.sin_salida += 1; e.horas = Math.round(e.horas * 100) / 100; delete e.abierta; }
  return por;
}

export function rutasRrhh({ db }) {
  const r = Router();

  r.get('/empleados', requierePermiso('rrhh:ver'), async (req, res) => {
    const f = validar(z.object({ estado: z.enum(['activo', 'vacaciones', 'suspendido', 'baja']).optional(), sucursal_id: uuid.optional() }), req.query);
    const { rows } = await db.query(
      `select e.id, e.persona_id, p.nombres, p.apellidos, p.identidad, p.telefono, p.correo, p.fecha_nacimiento, p.direccion,
              e.puesto, e.departamento, e.sucursal_id, s.nombre as sucursal, e.fecha_ingreso::text, e.fecha_salida::text, e.estado, e.usuario_id,
              case when $4 then e.salario_mensual end as salario_mensual,
              (select coalesce(json_agg(json_build_object('empresa', e2.codigo, 'puesto', x.puesto)), '[]'::json) from rrhh.empleados x join core.empresas e2 on e2.id = x.empresa_id
                where x.persona_id = e.persona_id and x.estado <> 'baja' and x.id <> e.id) as otros_contratos
         from rrhh.empleados e join rrhh.personas p on p.id = e.persona_id left join core.sucursales s on s.id = e.sucursal_id
        where e.empresa_id = $1 and ($2::text is null or e.estado = $2) and ($3::uuid is null or e.sucursal_id = $3)
        order by (e.estado = 'baja'), p.nombres, p.apellidos`,
      [req.ctx.empresa.id, f.estado ?? null, f.sucursal_id ?? null, req.ctx.permisos.has('rrhh:editar')]);
    res.json(rows);
  });

  r.post('/empleados', requierePermiso('rrhh:editar'), async (req, res) => {
    const b = validar(esqEmpleado, req.body);
    const out = await db.tx(async (q) => {
      const suc = b.sucursal_id ? await resolverSucursal(q, req.ctx, b.sucursal_id) : null;
      // La persona es única en el grupo: si ya trabaja en otra empresa (misma identidad) se reutiliza su ficha.
      let persona = b.identidad ? (await q.query('select * from rrhh.personas where identidad = $1', [b.identidad])).rows[0] : null;
      if (!persona) {
        persona = (await q.query(
          `insert into rrhh.personas (nombres,apellidos,identidad,fecha_nacimiento,telefono,correo,direccion) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
          [b.nombres, b.apellidos, b.identidad, b.fecha_nacimiento ?? null, b.telefono, b.correo, b.direccion])).rows[0];
      }
      try {
        const e = (await q.query(
          `insert into rrhh.empleados (persona_id,empresa_id,sucursal_id,usuario_id,puesto,departamento,fecha_ingreso,salario_mensual,notas)
           values ($1,$2,$3,$4,$5,$6,coalesce($7::date,(now() at time zone 'America/Tegucigalpa')::date),$8,$9) returning *`,
          [persona.id, req.ctx.empresa.id, suc?.id ?? null, b.usuario_id ?? null, b.puesto, b.departamento, b.fecha_ingreso ?? null, b.salario_mensual ?? null, b.notas])).rows[0];
        await auditar(q, req.ctx, 'empleado_alta', 'empleado', e.id, { nombre: `${persona.nombres} ${persona.apellidos}`, puesto: b.puesto }, { sucursalId: suc?.id });
        return { ...e, persona_reutilizada: Boolean(persona.created_at) && persona.nombres !== b.nombres ? true : undefined };
      } catch (err) {
        if (err.code === '23505') throw conflicto('Esa persona ya tiene un contrato vigente en esta empresa');
        throw err;
      }
    });
    res.status(201).json(out);
  });

  r.put('/empleados/:id', requierePermiso('rrhh:editar'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(esqEmpleado.partial().extend({ estado: z.enum(['activo', 'vacaciones', 'suspendido', 'baja']).optional(), fecha_salida: fechaISO.optional().nullable() }), req.body);
    await db.tx(async (q) => {
      const e = (await q.query('select * from rrhh.empleados where id = $1 and empresa_id = $2 for update', [id, req.ctx.empresa.id])).rows[0];
      if (!e) throw noEncontrado();
      if (b.sucursal_id) await resolverSucursal(q, req.ctx, b.sucursal_id);
      await q.query(
        `update rrhh.personas set nombres=coalesce($2,nombres),apellidos=coalesce($3,apellidos),telefono=coalesce($4,telefono),correo=coalesce($5,correo),
                direccion=coalesce($6,direccion),fecha_nacimiento=coalesce($7::date,fecha_nacimiento) where id=$1`,
        [e.persona_id, b.nombres ?? null, b.apellidos ?? null, b.telefono ?? null, b.correo ?? null, b.direccion ?? null, b.fecha_nacimiento ?? null]);
      const baja = b.estado === 'baja';
      await q.query(
        `update rrhh.empleados set puesto=coalesce($2,puesto),departamento=coalesce($3,departamento),sucursal_id=coalesce($4,sucursal_id),
                salario_mensual=coalesce($5,salario_mensual),estado=coalesce($6,estado),usuario_id=coalesce($7,usuario_id),notas=coalesce($8,notas),
                fecha_salida = case when $9 then coalesce($10::date,(now() at time zone 'America/Tegucigalpa')::date) else coalesce($10::date, fecha_salida) end
          where id=$1`,
        [id, b.puesto ?? null, b.departamento ?? null, b.sucursal_id ?? null, b.salario_mensual ?? null, b.estado ?? null, b.usuario_id ?? null, b.notas ?? null, baja, b.fecha_salida ?? null]);
      await auditar(q, req.ctx, baja ? 'empleado_baja' : 'empleado_editado', 'empleado', id, { ...b, salario_mensual: b.salario_mensual != null ? '(cambiado)' : undefined });
    });
    res.json({ ok: true });
  });

  // ── Directorio del grupo: una persona, todos sus contratos ───────────────
  r.get('/directorio', async (req, res) => {
    if (!req.ctx.usuario.es_dueno_grupo) throw prohibido('El directorio del grupo es solo para la dirección');
    const { rows } = await db.query(
      `select p.id, p.nombres, p.apellidos, p.identidad, p.telefono,
              json_agg(json_build_object('empresa', e2.codigo, 'empresa_nombre', e2.nombre, 'sucursal', s.nombre, 'puesto', e.puesto, 'estado', e.estado) order by e2.orden) as contratos
         from rrhh.personas p join rrhh.empleados e on e.persona_id = p.id join core.empresas e2 on e2.id = e.empresa_id left join core.sucursales s on s.id = e.sucursal_id
        where e.estado <> 'baja' group by p.id order by p.nombres, p.apellidos`);
    res.json(rows);
  });

  // ── Horarios ─────────────────────────────────────────────────────────────
  r.get('/empleados/:id/horarios', requierePermiso('rrhh:ver'), async (req, res) => {
    const { rows } = await db.query(
      `select h.dia_semana, h.entrada::text, h.salida::text from rrhh.horarios h join rrhh.empleados e on e.id = h.empleado_id
        where h.empleado_id = $1 and e.empresa_id = $2 order by h.dia_semana`, [validar(uuid, req.params.id), req.ctx.empresa.id]);
    res.json(rows);
  });
  r.put('/empleados/:id/horarios', requierePermiso('rrhh:editar'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(z.object({ horarios: z.array(z.object({ dia_semana: z.coerce.number().int().min(0).max(6), entrada: z.string().regex(/^\d{2}:\d{2}$/), salida: z.string().regex(/^\d{2}:\d{2}$/) })).max(7) }), req.body);
    await db.tx(async (q) => {
      if (!(await q.query('select 1 from rrhh.empleados where id = $1 and empresa_id = $2', [id, req.ctx.empresa.id])).rowCount) throw noEncontrado();
      await q.query('delete from rrhh.horarios where empleado_id = $1', [id]);
      for (const h of b.horarios) await q.query('insert into rrhh.horarios (empleado_id,dia_semana,entrada,salida) values ($1,$2,$3,$4)', [id, h.dia_semana, h.entrada, h.salida]);
    });
    res.json({ ok: true });
  });

  // ── Asistencia ───────────────────────────────────────────────────────────
  // Marcar propio: alterna entrada/salida según la última marca del día.
  r.post('/marcar', requierePermiso('rrhh:asistencia'), async (req, res) => {
    const out = await db.tx(async (q) => {
      const e = (await q.query(`select e.id, e.sucursal_id, p.nombres from rrhh.empleados e join rrhh.personas p on p.id = e.persona_id
                                where e.usuario_id = $1 and e.empresa_id = $2 and e.estado <> 'baja'`, [req.ctx.usuario.id, req.ctx.empresa.id])).rows[0];
      if (!e) throw noEncontrado('Tu usuario no está ligado a una ficha de personal; pídele a administración que lo enlace');
      const ult = (await q.query('select tipo from rrhh.marcaciones where empleado_id = $1 and marcada_at > now() - interval \'20 hours\' order by marcada_at desc limit 1', [e.id])).rows[0];
      const tipo = ult?.tipo === 'entrada' ? 'salida' : 'entrada';
      const m = (await q.query(
        `insert into rrhh.marcaciones (empleado_id,empresa_id,sucursal_id,tipo,origen,registrada_por) values ($1,$2,$3,$4,$5,$6) returning *`,
        [e.id, req.ctx.empresa.id, e.sucursal_id, tipo, req.ctx.via === 'pin' ? 'pin' : 'manual', req.ctx.usuario.id])).rows[0];
      return { ...m, nombre: e.nombres };
    });
    res.status(201).json(out);
  });
  // Marca manual por RRHH (olvidos, correcciones) — queda en bitácora.
  r.post('/marcaciones', requierePermiso('rrhh:editar'), async (req, res) => {
    const b = validar(z.object({ empleado_id: uuid, tipo: z.enum(['entrada', 'salida']), marcada_at: z.string().datetime({ offset: true }).optional(), nota: z.string().trim().min(3, 'Explica el motivo').max(200) }), req.body);
    const e = (await db.query('select sucursal_id from rrhh.empleados where id = $1 and empresa_id = $2', [b.empleado_id, req.ctx.empresa.id])).rows[0];
    if (!e) throw noEncontrado();
    const m = (await db.query(
      `insert into rrhh.marcaciones (empleado_id,empresa_id,sucursal_id,tipo,marcada_at,origen,nota,registrada_por) values ($1,$2,$3,$4,coalesce($5::timestamptz, now()),'manual',$6,$7) returning *`,
      [b.empleado_id, req.ctx.empresa.id, e.sucursal_id, b.tipo, b.marcada_at ?? null, b.nota, req.ctx.usuario.id])).rows[0];
    await auditar(db, req.ctx, 'marcacion_manual', 'empleado', b.empleado_id, { tipo: b.tipo, nota: b.nota });
    res.status(201).json(m);
  });
  r.get('/asistencia', requierePermiso('rrhh:ver'), async (req, res) => {
    const f = validar(z.object({ desde: fechaISO.optional(), hasta: fechaISO.optional() }), req.query);
    const hoy = fechaHN();
    const desde = f.desde ?? sumarDias(hoy, -13), hasta = f.hasta ?? hoy;
    const [emp, marcas] = await Promise.all([
      db.query(`select e.id, p.nombres, p.apellidos, e.puesto, s.nombre as sucursal from rrhh.empleados e join rrhh.personas p on p.id = e.persona_id
                  left join core.sucursales s on s.id = e.sucursal_id where e.empresa_id = $1 and e.estado <> 'baja' order by p.nombres`, [req.ctx.empresa.id]),
      db.query(`select empleado_id, tipo, marcada_at from rrhh.marcaciones where empresa_id = $1
                   and (marcada_at at time zone 'America/Tegucigalpa')::date between $2::date and $3::date order by marcada_at`, [req.ctx.empresa.id, desde, hasta]),
    ]);
    const horas = calcularHoras(marcas.rows);
    res.json({ desde, hasta, empleados: emp.rows.map((e) => ({ ...e, ...(horas.get(e.id) ?? { horas: 0, jornadas: 0, sin_salida: 0 }) })) });
  });

  // ── Vacaciones ───────────────────────────────────────────────────────────
  r.get('/vacaciones', requierePermiso('rrhh:ver'), async (req, res) => {
    const { rows } = await db.query(
      `select v.id, v.empleado_id, p.nombres, p.apellidos, v.desde::text, v.hasta::text, v.estado, v.nota, (v.hasta - v.desde + 1) as dias
         from rrhh.vacaciones v join rrhh.empleados e on e.id = v.empleado_id join rrhh.personas p on p.id = e.persona_id
        where e.empresa_id = $1 order by v.desde desc limit 200`, [req.ctx.empresa.id]);
    res.json(rows);
  });
  r.post('/vacaciones', requierePermiso('rrhh:editar'), async (req, res) => {
    const b = validar(z.object({ empleado_id: uuid, desde: fechaISO, hasta: fechaISO, nota: txt(200) }), req.body);
    if (b.hasta < b.desde) throw malaPeticion('La fecha final es anterior a la inicial');
    const e = await db.query('select 1 from rrhh.empleados where id = $1 and empresa_id = $2', [b.empleado_id, req.ctx.empresa.id]);
    if (!e.rowCount) throw noEncontrado();
    const v = (await db.query('insert into rrhh.vacaciones (empleado_id,desde,hasta,nota) values ($1,$2,$3,$4) returning *', [b.empleado_id, b.desde, b.hasta, b.nota])).rows[0];
    res.status(201).json(v);
  });
  r.put('/vacaciones/:id', requierePermiso('rrhh:editar'), async (req, res) => {
    const { estado } = validar(z.object({ estado: z.enum(['aprobada', 'rechazada', 'tomada']) }), req.body);
    const v = (await db.query(
      `update rrhh.vacaciones v set estado = $3, resuelta_por = $4 from rrhh.empleados e where v.id = $1 and e.id = v.empleado_id and e.empresa_id = $2 returning v.id`,
      [validar(uuid, req.params.id), req.ctx.empresa.id, estado, req.ctx.usuario.id])).rows[0];
    if (!v) throw noEncontrado();
    await auditar(db, req.ctx, `vacaciones_${estado}`, 'vacaciones', v.id);
    res.json({ ok: true });
  });

  return r;
}
