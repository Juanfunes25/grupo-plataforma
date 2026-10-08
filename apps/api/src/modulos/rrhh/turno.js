// Control de turno por empresa (portado de italo-reposicion): marcaciones de entrada/salida con
// verificación de ubicación, horas trabajadas para pagar la quincena, panel de tiendas abiertas,
// geocerca por sucursal, checklist de apertura/cierre e importación de fechas de ingreso.
import fs from 'node:fs';
import { z } from 'zod';
import { fechaHN, sumarDias } from '@grupo/shared';
import { requierePermiso, resolverSucursal, sucursalesPermitidas } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { conflicto, malaPeticion, noEncontrado, prohibido, uuid, validar, fechaISO, ErrorHttp } from '../../lib/http.js';
import { armarReporte, fechaLocal, horaAMinutos, minutosLocal, quincenaDe, verificarUbicacion } from './horas.js';
import { proponerCruces } from './cruces.js';
import { diferenciasBitacora, diferencias } from './comun.js';

const PLANILLA_ITALO = JSON.parse(fs.readFileSync(new URL('./datos/fechas-ingreso-italo.json', import.meta.url), 'utf8'));
const coord = z.preprocess((v) => (v === '' || v === undefined ? null : v), z.coerce.number().finite().nullable());

/** Qué tiendas deberían estar abiertas ya y nadie ha marcado entrada (con tolerancia en minutos). */
export function tiendasSinAbrir({ horarios, marcaciones, ahoraMinutos, toleranciaMinutos = 20 }) {
  const conEntrada = new Set(marcaciones.filter((m) => m.tipo === 'entrada').map((m) => m.sucursal_id));
  return horarios
    .filter((h) => !conEntrada.has(h.sucursal_id) && h.entrada_minutos != null && ahoraMinutos >= h.entrada_minutos + toleranciaMinutos)
    .map((h) => ({ sucursal_id: h.sucursal_id, nombre: h.nombre, esperada_minutos: h.entrada_minutos, minutos_de_atraso: ahoraMinutos - h.entrada_minutos }))
    .sort((a, b) => b.minutos_de_atraso - a.minutos_de_atraso);
}

export function montarTurno(r, { db }) {
  async function geoDe(q, sucursalId) {
    return (await q.query('select lat, lon, radio_metros from rrhh.sucursal_geo where sucursal_id = $1', [sucursalId])).rows[0] ?? null;
  }
  const dow = (fecha) => { const [y, m, d] = fecha.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

  /** Inserta una marcación calculando alternancia, doble toque y ubicación. */
  async function registrarMarca(q, ctx, emp, { tipo, sucursalId, lat, lon, nota }) {
    const ult = (await q.query(`select tipo, marcada_at from rrhh.marcaciones where empleado_id = $1 and marcada_at > now() - interval '20 hours' order by marcada_at desc limit 1`, [emp.id])).rows[0];
    const t = tipo ?? (ult?.tipo === 'entrada' ? 'salida' : 'entrada');
    if (tipo && ult && ult.tipo === tipo && Date.now() - new Date(ult.marcada_at).getTime() < 5 * 60_000) throw conflicto(`Ya se registró la ${tipo} hace un momento`);
    const suc = sucursalId ?? emp.sucursal_id;
    const ver = suc ? verificarUbicacion({ geo: await geoDe(q, suc), lat, lon }) : { verificacion: 'sin_configurar', distancia_metros: null };
    const m = (await q.query(
      `insert into rrhh.marcaciones (empleado_id, empresa_id, sucursal_id, tipo, origen, nota, registrada_por, lat, lon, distancia_metros, verificacion)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [emp.id, ctx.empresa.id, suc, t, ctx.via === 'pin' ? 'pin' : 'manual', nota ?? null, ctx.usuario.id, lat ?? null, lon ?? null, ver.distancia_metros, ver.verificacion])).rows[0];
    return { ...m, nombre: emp.nombres };
  }

  // Marcar propio (el usuario ligado a su ficha): alterna entrada/salida según la última marca.
  r.post('/marcar', requierePermiso('rrhh:asistencia'), async (req, res) => {
    const b = validar(z.object({ lat: coord.optional(), lon: coord.optional() }), req.body ?? {});
    const out = await db.tx(async (q) => {
      const e = (await q.query(`select e.id, e.sucursal_id, p.nombres from rrhh.empleados e join rrhh.personas p on p.id = e.persona_id
                                where e.usuario_id = $1 and e.empresa_id = $2 and e.estado <> 'baja'`, [req.ctx.usuario.id, req.ctx.empresa.id])).rows[0];
      if (!e) throw noEncontrado('Tu usuario no está ligado a una ficha de personal; pídele a administración que lo enlace');
      return registrarMarca(q, req.ctx, e, { lat: b.lat, lon: b.lon });
    });
    res.status(201).json(out);
  });

  // Pantalla de turno de una sucursal: quién trabaja hoy, quién está adentro, y el checklist.
  r.get('/turno/hoy', requierePermiso('rrhh:asistencia', 'rrhh:ver'), async (req, res) => {
    const f = validar(z.object({ sucursal_id: uuid.optional() }), req.query);
    const suc = await resolverSucursal(db, req.ctx, f.sucursal_id);
    const hoy = fechaHN();
    const d = dow(hoy);
    const { rows: emps } = await db.query(
      `select e.id, p.nombres, p.apellidos, e.puesto, e.estado, e.sucursal_id,
              (e.sucursal_id <> $2) as de_otra_tienda,
              (select json_build_object('estado', h.estado, 'entrada', h.entrada::text, 'salida', h.salida::text, 'sucursal_id', h.sucursal_id)
                 from rrhh.horarios h where h.empleado_id = e.id and h.dia_semana = $3) as horario_hoy
         from rrhh.empleados e join rrhh.personas p on p.id = e.persona_id
        where e.empresa_id = $1 and e.estado in ('activo','vacaciones')
          and (e.sucursal_id = $2 or exists (select 1 from rrhh.empleado_sucursales es where es.empleado_id = e.id and es.sucursal_id = $2)
               or exists (select 1 from rrhh.horarios h where h.empleado_id = e.id and h.dia_semana = $3 and h.sucursal_id = $2 and h.estado = 'turno'))
        order by p.nombres`, [req.ctx.empresa.id, suc.id, d]);
    const ids = emps.map((e) => e.id);
    const marcas = ids.length ? (await db.query(
      `select empleado_id, tipo, marcada_at, verificacion, distancia_metros from rrhh.marcaciones
        where empleado_id = any($1::uuid[]) and marcada_at > now() - interval '20 hours' order by marcada_at`, [ids])).rows : [];
    const enVac = ids.length ? new Set((await db.query(`select empleado_id from rrhh.vacaciones where empleado_id = any($1::uuid[]) and estado in ('aprobada','tomada') and $2::date between desde and hasta`, [ids, hoy])).rows.map((x) => x.empleado_id)) : new Set();
    res.json({
      fecha: hoy, sucursal: { id: suc.id, nombre: suc.nombre }, geo_configurada: Boolean(await geoDe(db, suc.id)),
      empleados: emps.map((e) => {
        const ms = marcas.filter((m) => m.empleado_id === e.id);
        const ult = ms.at(-1) ?? null;
        return { ...e, en_vacaciones: enVac.has(e.id), marcas: ms.filter((m) => fechaLocal(m.marcada_at) === hoy), adentro: ult?.tipo === 'entrada', ultima: ult };
      }),
    });
  });

  // Marca de un compañero desde la tablet de la tienda (cajero con PIN, gerente…).
  r.post('/turno/marcar', requierePermiso('rrhh:asistencia'), async (req, res) => {
    const b = validar(z.object({ empleado_id: uuid, tipo: z.enum(['entrada', 'salida']).optional(), sucursal_id: uuid.optional(), lat: coord.optional(), lon: coord.optional(), nota: z.string().trim().max(200).optional() }), req.body);
    const out = await db.tx(async (q) => {
      const e = (await q.query(`select e.id, e.sucursal_id, e.estado, p.nombres from rrhh.empleados e join rrhh.personas p on p.id = e.persona_id where e.id = $1 and e.empresa_id = $2`, [b.empleado_id, req.ctx.empresa.id])).rows[0];
      if (!e) throw noEncontrado('Ese empleado no trabaja en esta empresa');
      if (e.estado === 'baja' || e.estado === 'suspendido') throw malaPeticion(`Ese empleado está ${e.estado === 'baja' ? 'dado de baja' : 'suspendido'}`);
      // Solo se marca en sucursales que el usuario puede operar.
      const suc = b.sucursal_id ? await resolverSucursal(q, req.ctx, b.sucursal_id) : (e.sucursal_id ? await resolverSucursal(q, req.ctx, e.sucursal_id) : null);
      const m = await registrarMarca(q, req.ctx, e, { tipo: b.tipo, sucursalId: suc?.id, lat: b.lat, lon: b.lon, nota: b.nota });
      if (m.verificacion === 'lejos') await auditar(q, req.ctx, 'marcacion_lejos', 'empleado', e.id, { tipo: m.tipo, distancia_metros: m.distancia_metros, registrada_por_otro: req.ctx.usuario.nombre }, { sucursalId: suc?.id });
      return m;
    });
    res.status(201).json(out);
  });

  // ── Horas trabajadas (para pagar la quincena) ─────────────────────────────
  r.get('/quincena-actual', requierePermiso('rrhh:ver'), (_req, res) => res.json(quincenaDe(fechaHN())));
  r.get('/reporte-horas', requierePermiso('rrhh:ver'), async (req, res) => {
    const f = validar(z.object({ desde: fechaISO, hasta: fechaISO, sucursal_id: uuid.optional() }), req.query);
    if (f.desde > f.hasta) throw malaPeticion('La fecha de inicio va antes que la de fin');
    if (new Date(f.hasta) - new Date(f.desde) > 93 * 86_400_000) throw malaPeticion('El período no puede pasar de 3 meses');
    const [emps, marcas] = await Promise.all([
      db.query(
        `select e.id, p.nombres, p.apellidos, e.puesto, e.sucursal_id, s.nombre as sucursal, e.estado, e.tipo_pago
           from rrhh.empleados e join rrhh.personas p on p.id = e.persona_id left join core.sucursales s on s.id = e.sucursal_id
          where e.empresa_id = $1 and ($4::uuid is null or e.sucursal_id = $4)
            and (e.estado <> 'baja' or exists (select 1 from rrhh.marcaciones m where m.empleado_id = e.id and (m.marcada_at at time zone 'America/Tegucigalpa')::date between $2::date and $3::date))
          order by s.nombre nulls last, p.nombres`, [req.ctx.empresa.id, f.desde, f.hasta, f.sucursal_id ?? null]),
      // Un día de más: un turno nocturno tiene la salida con la fecha siguiente.
      db.query(`select empleado_id, tipo, marcada_at, verificacion, distancia_metros from rrhh.marcaciones where empresa_id = $1
                  and (marcada_at at time zone 'America/Tegucigalpa')::date between $2::date and $3::date order by marcada_at`, [req.ctx.empresa.id, f.desde, sumarDias(f.hasta, 1)]),
    ]);
    const filas = armarReporte({ empleados: emps.rows, marcaciones: marcas.rows, desde: f.desde, hasta: f.hasta });
    res.json({
      desde: f.desde, hasta: f.hasta, empleados: filas,
      total_horas: Math.round(filas.reduce((s, e) => s + e.total_horas, 0) * 100) / 100,
      total_incompletos: filas.reduce((s, e) => s + e.turnos_incompletos, 0),
    });
  });

  // ── Panel del dueño: ¿está todo abierto? ──────────────────────────────────
  r.get('/panel', requierePermiso('rrhh:ver'), async (req, res) => {
    const f = validar(z.object({ fecha: fechaISO.optional() }), req.query);
    const hoy = fechaHN(), fecha = f.fecha ?? hoy;
    const sucs = (await sucursalesPermitidas(db, req.ctx));
    const [marcas, hors] = await Promise.all([
      db.query(`select m.sucursal_id, m.empleado_id, m.tipo, m.marcada_at, m.verificacion, m.distancia_metros, p.nombres, p.apellidos
                  from rrhh.marcaciones m join rrhh.empleados e on e.id = m.empleado_id join rrhh.personas p on p.id = e.persona_id
                 where m.empresa_id = $1 and (m.marcada_at at time zone 'America/Tegucigalpa')::date = $2::date order by m.marcada_at`, [req.ctx.empresa.id, fecha]),
      db.query(`select coalesce(h.sucursal_id, e.sucursal_id) as sucursal_id, h.entrada::text as entrada
                  from rrhh.horarios h join rrhh.empleados e on e.id = h.empleado_id
                 where e.empresa_id = $1 and h.dia_semana = $2 and e.estado = 'activo' and h.estado = 'turno' and h.entrada is not null`, [req.ctx.empresa.id, dow(fecha)]),
    ]);
    const temprana = new Map();
    for (const h of hors.rows) { const mnt = horaAMinutos(h.entrada); if (mnt != null && (!temprana.has(h.sucursal_id) || mnt < temprana.get(h.sucursal_id))) temprana.set(h.sucursal_id, mnt); }
    const sinAbrir = fecha === hoy ? tiendasSinAbrir({
      horarios: sucs.map((s) => ({ sucursal_id: s.id, nombre: s.nombre, entrada_minutos: temprana.get(s.id) ?? null })),
      marcaciones: marcas.rows, ahoraMinutos: minutosLocal(new Date()),
    }) : [];
    res.json({
      fecha, sin_abrir: sinAbrir,
      sucursales: sucs.map((s) => {
        const suyas = marcas.rows.filter((m) => m.sucursal_id === s.id);
        return { sucursal_id: s.id, nombre: s.nombre, marcaciones: suyas, abrio: suyas.some((m) => m.tipo === 'entrada'), sospechosas: suyas.filter((m) => m.verificacion === 'lejos').length };
      }),
    });
  });

  // ── Geocerca de cada sucursal ─────────────────────────────────────────────
  r.get('/sucursales-geo', requierePermiso('rrhh:ver'), async (req, res) => {
    const { rows } = await db.query(
      `select s.id, s.nombre, g.lat, g.lon, g.radio_metros from core.sucursales s left join rrhh.sucursal_geo g on g.sucursal_id = s.id
        where s.empresa_id = $1 and s.activo order by s.orden, s.nombre`, [req.ctx.empresa.id]);
    res.json(rows);
  });
  r.put('/sucursales/:id/geo', requierePermiso('rrhh:editar'), async (req, res) => {
    const b = validar(z.object({ lat: z.coerce.number().min(-90).max(90), lon: z.coerce.number().min(-180).max(180), radio_metros: z.coerce.number().int().min(20).max(2000).default(150) }), req.body);
    const suc = await resolverSucursal(db, req.ctx, validar(uuid, req.params.id));
    const antes = await geoDe(db, suc.id);
    await db.query(`insert into rrhh.sucursal_geo (sucursal_id, lat, lon, radio_metros) values ($1,$2,$3,$4)
                    on conflict (sucursal_id) do update set lat = $2, lon = $3, radio_metros = $4, updated_at = now()`, [suc.id, b.lat, b.lon, b.radio_metros]);
    await auditar(db, req.ctx, 'sucursal_geo_editada', 'sucursal', suc.id, { antes, despues: b }, { sucursalId: suc.id });
    res.json({ ok: true });
  });

  // ── Checklist de apertura y cierre ────────────────────────────────────────
  r.get('/checklist', requierePermiso('rrhh:asistencia', 'rrhh:ver'), async (req, res) => {
    const f = validar(z.object({ sucursal_id: uuid.optional(), fecha: fechaISO.optional() }), req.query);
    const suc = await resolverSucursal(db, req.ctx, f.sucursal_id);
    const fecha = f.fecha ?? fechaHN();
    const { rows } = await db.query(
      `select c.id, c.momento, c.texto, c.orden, r.ok, r.nota, r.created_at as at, p.nombres as por
         from rrhh.checklist_catalogo c
         left join rrhh.checklist_registros r on r.item_id = c.id and r.sucursal_id = $2 and r.fecha = $3::date
         left join rrhh.empleados e on e.id = r.empleado_id left join rrhh.personas p on p.id = e.persona_id
        where c.empresa_id = $1 and c.activo order by c.momento, c.orden, c.texto`, [req.ctx.empresa.id, suc.id, fecha]);
    const grupo = (m) => { const items = rows.filter((x) => x.momento === m).map((x) => ({ ...x, ok: x.ok === true })); return { items, hechos: items.filter((x) => x.ok).length, total: items.length }; };
    res.json({ fecha, sucursal: { id: suc.id, nombre: suc.nombre }, apertura: grupo('apertura'), cierre: grupo('cierre') });
  });
  r.post('/checklist', requierePermiso('rrhh:asistencia'), async (req, res) => {
    const b = validar(z.object({ sucursal_id: uuid.optional(), fecha: fechaISO.optional(), momento: z.enum(['apertura', 'cierre']), item_id: uuid, ok: z.boolean(), nota: z.string().trim().max(200).optional().nullable(), empleado_id: uuid.optional().nullable() }), req.body);
    const hoy = fechaHN();
    const fecha = b.fecha ?? hoy;
    if (fecha !== hoy && !req.ctx.permisos.has('rrhh:editar')) throw prohibido('Solo se puede llenar el checklist del día de hoy');
    const suc = await resolverSucursal(db, req.ctx, b.sucursal_id);
    const it = (await db.query('select id from rrhh.checklist_catalogo where id = $1 and empresa_id = $2 and momento = $3 and activo', [b.item_id, req.ctx.empresa.id, b.momento])).rows[0];
    if (!it) throw noEncontrado('Ese punto del checklist no existe');
    if (b.empleado_id && !(await db.query('select 1 from rrhh.empleados where id = $1 and empresa_id = $2', [b.empleado_id, req.ctx.empresa.id])).rowCount) throw noEncontrado('Empleado no encontrado');
    await db.query(
      `insert into rrhh.checklist_registros (empresa_id, sucursal_id, fecha, momento, item_id, ok, nota, empleado_id, usuario_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (sucursal_id, fecha, momento, item_id) do update set ok = $6, nota = $7, empleado_id = $8, usuario_id = $9, created_at = now()`,
      [req.ctx.empresa.id, suc.id, fecha, b.momento, b.item_id, b.ok, b.nota || null, b.empleado_id ?? null, req.ctx.usuario.id]);
    res.json({ ok: true });
  });
  r.get('/checklist/resumen', requierePermiso('rrhh:ver'), async (req, res) => {
    const f = validar(z.object({ desde: fechaISO.optional(), hasta: fechaISO.optional() }), req.query);
    const hoy = fechaHN();
    const { rows } = await db.query(
      `select r.fecha, s.nombre as sucursal, r.momento, count(*) filter (where r.ok)::int as hechos,
              (select count(*)::int from rrhh.checklist_catalogo c where c.empresa_id = r.empresa_id and c.momento = r.momento and c.activo) as total
         from rrhh.checklist_registros r join core.sucursales s on s.id = r.sucursal_id
        where r.empresa_id = $1 and r.fecha between $2::date and $3::date group by r.fecha, s.nombre, r.momento, r.empresa_id order by r.fecha desc, s.nombre, r.momento`,
      [req.ctx.empresa.id, f.desde ?? sumarDias(hoy, -13), f.hasta ?? hoy]);
    res.json(rows);
  });
  r.post('/checklist/catalogo', requierePermiso('rrhh:editar'), async (req, res) => {
    const b = validar(z.object({ momento: z.enum(['apertura', 'cierre']), texto: z.string().trim().min(3).max(150), orden: z.coerce.number().int().min(0).max(999).default(99) }), req.body);
    const c = (await db.query('insert into rrhh.checklist_catalogo (empresa_id, momento, texto, orden) values ($1,$2,$3,$4) returning *', [req.ctx.empresa.id, b.momento, b.texto, b.orden])).rows[0];
    await auditar(db, req.ctx, 'checklist_item_creado', 'checklist', c.id, { momento: b.momento, texto: b.texto });
    res.status(201).json(c);
  });
  r.put('/checklist/catalogo/:id', requierePermiso('rrhh:editar'), async (req, res) => {
    const b = validar(z.object({ texto: z.string().trim().min(3).max(150).optional(), orden: z.coerce.number().int().min(0).max(999).optional(), activo: z.boolean().optional() }), req.body);
    const id = validar(uuid, req.params.id);
    const a = (await db.query('select * from rrhh.checklist_catalogo where id = $1 and empresa_id = $2', [id, req.ctx.empresa.id])).rows[0];
    if (!a) throw noEncontrado();
    await db.query('update rrhh.checklist_catalogo set texto = coalesce($2,texto), orden = coalesce($3,orden), activo = coalesce($4,activo) where id = $1', [id, b.texto ?? null, b.orden ?? null, b.activo ?? null]);
    await auditar(db, req.ctx, 'checklist_item_editado', 'checklist', id, { cambios: diferenciasBitacora(diferencias(a, b)) });
    res.json({ ok: true });
  });

  // ── Importar fechas de ingreso desde la planilla de contratos (Italo) ─────
  const soloItalo = (req) => { if (req.ctx.empresa.codigo !== 'italo') throw new ErrorHttp(404, 'La planilla de contratos cargada es la de Italo', 'no_encontrado'); };
  r.get('/fechas-ingreso/propuesta', requierePermiso('rrhh:editar'), async (req, res) => {
    soloItalo(req);
    const { rows } = await db.query(
      `select e.id, p.nombres as nombre, e.fecha_ingreso, s.nombre as sucursal_nombre from rrhh.empleados e join rrhh.personas p on p.id = e.persona_id
         left join core.sucursales s on s.id = e.sucursal_id where e.empresa_id = $1 and e.estado <> 'baja' order by s.nombre, p.nombres`, [req.ctx.empresa.id]);
    res.json(proponerCruces({ empleados: rows, planilla: PLANILLA_ITALO }));
  });
  r.post('/fechas-ingreso', requierePermiso('rrhh:editar'), async (req, res) => {
    soloItalo(req);
    const b = validar(z.object({
      usar_nombre_legal: z.boolean().default(false), usar_cargo: z.boolean().default(false),
      cambios: z.array(z.object({ empleado_id: uuid, fecha_ingreso: fechaISO, nombre_completo: z.string().trim().max(150).optional().nullable(), cargo: z.string().trim().max(120).optional().nullable() })).min(1).max(200),
    }), req.body);
    const guardados = await db.tx(async (q) => {
      let n = 0;
      for (const c of b.cambios) {
        const e = (await q.query('select e.*, p.nombres, p.apellidos from rrhh.empleados e join rrhh.personas p on p.id = e.persona_id where e.id = $1 and e.empresa_id = $2 for update of e', [c.empleado_id, req.ctx.empresa.id])).rows[0];
        if (!e) throw noEncontrado('Hay un empleado que no existe');
        const antes = { fecha_ingreso: e.fecha_ingreso }, despues = { fecha_ingreso: c.fecha_ingreso };
        await q.query('update rrhh.empleados set fecha_ingreso = $2, updated_at = now() where id = $1', [e.id, c.fecha_ingreso]);
        if (b.usar_cargo && c.cargo) { await q.query('update rrhh.empleados set puesto = $2 where id = $1', [e.id, c.cargo]); antes.puesto = e.puesto; despues.puesto = c.cargo; }
        if (b.usar_nombre_legal && c.nombre_completo) {
          const w = c.nombre_completo.split(/\s+/);
          const corte = w.length >= 4 ? 2 : w.length === 3 ? 2 : 1;
          const nombres = w.slice(0, corte).join(' '), apellidos = w.slice(corte).join(' ');
          await q.query('update rrhh.personas set nombres = $2, apellidos = $3, updated_at = now() where id = $1', [e.persona_id, nombres, apellidos]);
          antes.nombre = `${e.nombres} ${e.apellidos}`.trim(); despues.nombre = c.nombre_completo;
        }
        await auditar(q, req.ctx, 'empleado_editado', 'empleado', e.id, { origen: 'importar_fechas_ingreso', cambios: Object.fromEntries(Object.keys(despues).map((k) => [k, { antes: antes[k] ?? null, despues: despues[k] }])) });
        n += 1;
      }
      return n;
    });
    res.json({ guardados });
  });
}
