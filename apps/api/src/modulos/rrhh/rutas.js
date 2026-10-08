import { Router } from 'express';
import { z } from 'zod';
import { fechaHN, sumarDias } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { montarPerfil } from './perfil.js';
import { montarTurno } from './turno.js';
import { calendario, resumen } from './consultas.js';
import { auditar } from '../../lib/auditoria.js';
import { malaPeticion, noEncontrado, prohibido, uuid, validar, fechaISO } from '../../lib/http.js';

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

  // ── Asistencia ───────────────────────────────────────────────────────────
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

  r.get('/resumen', requierePermiso('rrhh:ver'), async (req, res) => res.json(await resumen(db, { empresaIds: [req.ctx.empresa.id] })));
  r.get('/calendario', requierePermiso('rrhh:ver'), async (req, res) => {
    const f = validar(z.object({ desde: fechaISO.optional(), hasta: fechaISO.optional() }), req.query);
    const hoy = fechaHN();
    res.json(await calendario(db, { empresaIds: [req.ctx.empresa.id], desde: f.desde ?? `${hoy.slice(0, 8)}01`, hasta: f.hasta ?? sumarDias(hoy, 60) }));
  });
  montarPerfil(r, { db });
  montarTurno(r, { db });

  return r;
}
