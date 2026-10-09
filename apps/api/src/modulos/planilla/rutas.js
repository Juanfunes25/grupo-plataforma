// Planilla Honduras · /api/planilla/…
// TODO exige el permiso rrhh:sensible (dueño y administrador): sueldos, deducciones y boletas son datos sensibles.
// Los parámetros (IHSS, RAP, INFOP, ISR, horas extra…) son valores de arranque POR CONFIRMAR con el contador; solo el
// dueño del grupo los edita. Cada planilla guarda copia de los parámetros que usó y, una vez aprobada, no se modifica.
import { Router } from 'express';
import { z } from 'zod';
import { fechaHN } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { conflicto, fechaISO, malaPeticion, noEncontrado, prohibido, uuid, validar } from '../../lib/http.js';
import { agruparPorSucursal, armarLinea, mapaParametros, PERIODICIDADES, periodoDe, recalcularRenglon, resumenContable, sinHorasExtra, totalesDe } from './calculo.js';
import { armarReporte } from '../rrhh/horas.js';
import { generarBoletasPdf } from './pdf.js';
import { generarExcel } from './excel.js';

const TIPOS = ['semanal', 'quincena', 'mensual', 'aguinaldo', 'catorceavo'];
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export function rutasPlanilla({ db }) {
  const r = Router();
  const sensible = requierePermiso('rrhh:sensible');
  r.use(sensible);                       // nada de planilla sin permiso, ni siquiera listar
  const empresa = (req) => req.ctx.empresa.id;
  const soloDuenoGrupo = (req) => { if (!req.ctx.usuario.es_dueno_grupo) throw prohibido('Solo el dueño del grupo puede cambiar los parámetros de la planilla'); };

  // ── Parámetros ─────────────────────────────────────────────────────────────
  async function cargarParametros(q) {
    const filas = (await q.query('select * from plan.parametros order by grupo, clave')).rows;
    const tramos = (await q.query('select id, orden, desde, tasa, por_confirmar from plan.isr_tramos order by desde')).rows;
    return { filas, tramos, P: mapaParametros(filas), pendientes: filas.some((p) => p.por_confirmar) || tramos.some((t) => t.por_confirmar) };
  }

  r.get('/parametros', async (req, res) => {
    const p = await cargarParametros(db);
    res.json({ parametros: p.filas, tramos: p.tramos, por_confirmar: p.pendientes, puede_editar: !!req.ctx.usuario.es_dueno_grupo,
      aviso: 'Estos valores son de arranque. El contador debe validarlos y marcarlos como confirmados antes de pagar con ellos.' });
  });

  r.put('/parametros', async (req, res) => {
    soloDuenoGrupo(req);
    const b = validar(z.object({ valores: z.record(z.string().max(60), z.coerce.number().finite().min(0).max(9_999_999)).refine((o) => Object.keys(o).length > 0, 'No hay cambios') }), req.body);
    await db.tx(async (q) => {
      const antes = Object.fromEntries((await q.query('select clave, valor from plan.parametros')).rows.map((x) => [x.clave, x.valor]));
      const cambios = {};
      for (const [clave, valor] of Object.entries(b.valores)) {
        if (!(clave in antes)) throw malaPeticion(`Parámetro desconocido: ${clave}`);
        if (Number(antes[clave]) === Number(valor)) continue;
        await q.query('update plan.parametros set valor = $2, por_confirmar = true, confirmado_por = null, confirmado_at = null, updated_by = $3, updated_at = now() where clave = $1', [clave, valor, req.ctx.usuario.id]);
        cambios[clave] = { antes: antes[clave], despues: valor };
      }
      if (Object.keys(cambios).length) await auditar(q, req.ctx, 'planilla.parametros_editados', 'parametros', null, { cambios });
    });
    res.json({ ok: true });
  });

  r.put('/isr-tramos', async (req, res) => {
    soloDuenoGrupo(req);
    const b = validar(z.object({ tramos: z.array(z.object({ desde: z.coerce.number().min(0).max(999_999_999), tasa: z.coerce.number().min(0).max(100) })).min(1).max(10) }), req.body);
    const t = [...b.tramos].sort((x, y) => x.desde - y.desde);
    if (t[0].desde !== 0) throw malaPeticion('El primer tramo debe empezar en 0');
    if (new Set(t.map((x) => x.desde)).size !== t.length) throw malaPeticion('Hay dos tramos que empiezan en el mismo monto');
    await db.tx(async (q) => {
      const antes = (await q.query('select desde, tasa from plan.isr_tramos order by desde')).rows;
      await q.query('delete from plan.isr_tramos');
      for (const [i, x] of t.entries()) await q.query('insert into plan.isr_tramos (orden, desde, tasa) values ($1,$2,$3)', [i + 1, x.desde, x.tasa]);
      await auditar(q, req.ctx, 'planilla.isr_editado', 'parametros', null, { antes, despues: t });
    });
    res.json({ ok: true });
  });

  r.post('/parametros/confirmar', async (req, res) => {
    soloDuenoGrupo(req);
    const b = validar(z.object({ contador: z.string().trim().min(3, 'Escribe el nombre del contador que lo validó').max(120), claves: z.array(z.string().max(60)).max(80).optional(), tramos: z.boolean().default(true) }), req.body);
    await db.tx(async (q) => {
      const n = (await q.query(`update plan.parametros set por_confirmar = false, confirmado_por = $1, confirmado_at = now() where por_confirmar and ($2::text[] is null or clave = any($2::text[]))`, [req.ctx.usuario.id, b.claves ?? null])).rowCount;
      if (b.tramos) await q.query('update plan.isr_tramos set por_confirmar = false where por_confirmar');
      await auditar(q, req.ctx, 'planilla.parametros_confirmados', 'parametros', null, { validado_por: b.contador, parametros: n, tramos: b.tramos });
    });
    res.json({ ok: true });
  });

  // ── Novedades: horas extra, bonos y descuentos ────────────────────────────
  r.get('/novedades', async (req, res) => {
    const f = validar(z.object({ desde: fechaISO.optional(), hasta: fechaISO.optional(), estado: z.enum(['pendiente', 'aplicada', 'anulada']).optional() }), req.query);
    const hoy = fechaHN();
    const { rows } = await db.query(
      `select n.*, p.nombres || ' ' || p.apellidos as empleado from plan.novedades n join rrhh.empleados e on e.id = n.empleado_id join rrhh.personas p on p.id = e.persona_id
        where n.empresa_id = $1 and n.fecha between coalesce($2::date, $4::date - 60) and coalesce($3::date, $4::date + 31) and ($5::text is null or n.estado = $5)
        order by n.fecha desc, n.created_at desc limit 500`, [empresa(req), f.desde ?? null, f.hasta ?? null, hoy, f.estado ?? null]);
    res.json(rows);
  });

  r.post('/novedades', async (req, res) => {
    const b = validar(z.object({
      empleado_id: uuid, fecha: fechaISO, tipo: z.enum(['he_diurna', 'he_nocturna', 'he_feriada', 'bono', 'descuento']),
      horas: z.coerce.number().positive().max(300).optional().nullable(), monto: z.coerce.number().positive().max(9_999_999).optional().nullable(),
      concepto: z.string().trim().max(160).optional().nullable(),
    }), req.body);
    const esHoras = b.tipo.startsWith('he_');
    if (esHoras && !b.horas) throw malaPeticion('Indica cuántas horas extra');
    if (!esHoras && !b.monto) throw malaPeticion('Indica el monto');
    const nov = await db.tx(async (q) => {
      const e = (await q.query('select e.id, p.nombres || \' \' || p.apellidos as nombre from rrhh.empleados e join rrhh.personas p on p.id = e.persona_id where e.id = $1 and e.empresa_id = $2', [b.empleado_id, empresa(req)])).rows[0];
      if (!e) throw noEncontrado('Empleado no encontrado en esta empresa');
      const n = (await q.query(
        `insert into plan.novedades (empresa_id, empleado_id, fecha, tipo, horas, monto, concepto, creado_por) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [empresa(req), b.empleado_id, b.fecha, b.tipo, esHoras ? b.horas : null, esHoras ? null : b.monto, b.concepto || null, req.ctx.usuario.id])).rows[0];
      await auditar(q, req.ctx, 'planilla.novedad_creada', 'novedad', n.id, { empleado: e.nombre, fecha: b.fecha, tipo: b.tipo, horas: n.horas, monto: n.monto, concepto: n.concepto });
      return n;
    });
    res.status(201).json(nov);
  });

  r.delete('/novedades/:id', async (req, res) => {
    await db.tx(async (q) => {
      const n = (await q.query('select * from plan.novedades where id = $1 and empresa_id = $2 for update', [validar(uuid, req.params.id), empresa(req)])).rows[0];
      if (!n) throw noEncontrado();
      if (n.estado !== 'pendiente') throw conflicto('Esa novedad ya entró a una planilla: anula la planilla primero');
      await q.query(`update plan.novedades set estado = 'anulada' where id = $1`, [n.id]);
      await auditar(q, req.ctx, 'planilla.novedad_anulada', 'novedad', n.id, { tipo: n.tipo, fecha: n.fecha });
    });
    res.json({ ok: true });
  });

  // ── Periodicidad de pago, deducciones fijas ───────────────────────────────
  r.get('/config', async (req, res) => {
    const emp = (await db.query('select periodicidad from plan.config_empresa where empresa_id = $1', [empresa(req)])).rows[0];
    const defecto = emp?.periodicidad ?? 'quincena';
    const { P } = await cargarParametros(db);
    const { rows } = await db.query(
      `select e.id, p.nombres || ' ' || p.apellidos as nombre, e.puesto, s.nombre as sucursal, ep.periodicidad as excepcion, e.salario_mensual, e.salario_hora, e.estado
         from rrhh.empleados e join rrhh.personas p on p.id = e.persona_id left join core.sucursales s on s.id = e.sucursal_id left join plan.empleado_periodicidad ep on ep.empleado_id = e.id
        where e.empresa_id = $1 and e.estado <> 'baja' order by p.nombres`, [empresa(req)]);
    res.json({
      periodicidad_empresa: defecto, periodicidades: Object.entries(PERIODICIDADES).map(([id, nombre]) => ({ id, nombre })),
      semana: { dias_pago: P.semana_dias_pago, inicio_dia: P.semana_inicio_dia, dia_pago: P.semana_dia_pago },
      empleados: rows.map((e) => ({ id: e.id, nombre: e.nombre, puesto: e.puesto, sucursal: e.sucursal, excepcion: e.excepcion, periodicidad: e.excepcion ?? defecto, con_salario: Number(e.salario_mensual) > 0 || Number(e.salario_hora) > 0, estado: e.estado })),
    });
  });

  r.put('/config', async (req, res) => {
    const b = validar(z.object({ periodicidad: z.enum(['semanal', 'quincena', 'mensual']) }), req.body);
    await db.tx(async (q) => {
      const antes = (await q.query('select periodicidad from plan.config_empresa where empresa_id = $1', [empresa(req)])).rows[0]?.periodicidad ?? null;
      await q.query(`insert into plan.config_empresa (empresa_id, periodicidad, updated_by) values ($1,$2,$3) on conflict (empresa_id) do update set periodicidad = excluded.periodicidad, updated_by = excluded.updated_by, updated_at = now()`, [empresa(req), b.periodicidad, req.ctx.usuario.id]);
      await auditar(q, req.ctx, 'planilla.periodicidad_empresa', 'empresa', empresa(req), { antes, despues: b.periodicidad });
    });
    res.json({ ok: true });
  });

  r.put('/empleados/:id/periodicidad', async (req, res) => {
    const b = validar(z.object({ periodicidad: z.enum(['semanal', 'quincena', 'mensual']).nullable() }), req.body);
    await db.tx(async (q) => {
      const e = (await q.query('select e.id, p.nombres || \' \' || p.apellidos as nombre from rrhh.empleados e join rrhh.personas p on p.id = e.persona_id where e.id = $1 and e.empresa_id = $2', [validar(uuid, req.params.id), empresa(req)])).rows[0];
      if (!e) throw noEncontrado('Empleado no encontrado');
      if (b.periodicidad === null) await q.query('delete from plan.empleado_periodicidad where empleado_id = $1', [e.id]);
      else await q.query(`insert into plan.empleado_periodicidad (empleado_id, empresa_id, periodicidad, updated_by) values ($1,$2,$3,$4) on conflict (empleado_id) do update set periodicidad = excluded.periodicidad, updated_by = excluded.updated_by, updated_at = now()`, [e.id, empresa(req), b.periodicidad, req.ctx.usuario.id]);
      await auditar(q, req.ctx, 'planilla.periodicidad_empleado', 'empleado', e.id, { empleado: e.nombre, periodicidad: b.periodicidad ?? 'la de la empresa' });
    });
    res.json({ ok: true });
  });

  r.get('/fijas', async (req, res) => {
    res.json((await db.query(
      `select f.*, p.nombres || ' ' || p.apellidos as empleado from plan.deducciones_fijas f join rrhh.empleados e on e.id = f.empleado_id join rrhh.personas p on p.id = e.persona_id
        where f.empresa_id = $1 and f.activa order by p.nombres, f.concepto`, [empresa(req)])).rows);
  });
  r.post('/fijas', async (req, res) => {
    const b = validar(z.object({ empleado_id: uuid, concepto: z.string().trim().min(2).max(80), monto_mensual: z.coerce.number().positive().max(9_999_999) }), req.body);
    const f = await db.tx(async (q) => {
      const e = (await q.query('select id from rrhh.empleados where id = $1 and empresa_id = $2', [b.empleado_id, empresa(req)])).rows[0];
      if (!e) throw noEncontrado('Empleado no encontrado');
      const f = (await q.query('insert into plan.deducciones_fijas (empresa_id, empleado_id, concepto, monto_mensual, creada_por) values ($1,$2,$3,$4,$5) returning *', [empresa(req), b.empleado_id, b.concepto, b.monto_mensual, req.ctx.usuario.id])).rows[0];
      await auditar(q, req.ctx, 'planilla.deduccion_fija_creada', 'empleado', b.empleado_id, { concepto: b.concepto, monto_mensual: b.monto_mensual });
      return f;
    });
    res.status(201).json(f);
  });
  r.delete('/fijas/:id', async (req, res) => {
    const f = (await db.query('update plan.deducciones_fijas set activa = false where id = $1 and empresa_id = $2 and activa returning concepto, empleado_id', [validar(uuid, req.params.id), empresa(req)])).rows[0];
    if (!f) throw noEncontrado();
    await auditar(db, req.ctx, 'planilla.deduccion_fija_quitada', 'empleado', f.empleado_id, { concepto: f.concepto });
    res.json({ ok: true });
  });

  // ── Armado de la hoja ─────────────────────────────────────────────────────
  const specDe = (p) => ({ tipo: p.tipo, anio: Number(p.hasta.slice(0, 4)), mes: Number(p.hasta.slice(5, 7)), quincena: p.desde.endsWith('-01') ? 1 : 2, desde: p.desde });
  const COLS = `planilla_id, empleado_id, sucursal_id, sucursal, nombre, identidad, puesto, dias, salario_diario, total_quincenal, por_hora, horas_extra, total_hx, otros_ingresos,
    deducciones, total_deducciones, total, banco, cuenta, observaciones, editado, aportes_patronales, detalle`;
  async function insertarLinea(q, planillaId, l, editado = false) {
    await q.query(
      `insert into plan.planilla_lineas (${COLS}) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,$20,$21,$22,$23::jsonb)`,
      [planillaId, l.empleado_id, l.sucursal_id, l.sucursal, l.nombre, l.identidad, l.puesto, l.dias, l.salario_diario, l.total_quincenal, l.por_hora, l.horas_extra, l.total_hx, l.otros_ingresos,
        JSON.stringify(l.deducciones), l.total_deducciones, l.total, l.banco, l.cuenta, l.observaciones ?? '', editado, l.aportes_patronales ?? 0, JSON.stringify(l.detalle ?? {})]);
  }

  /** Pre-llena (o vuelve a pre-llenar) la hoja desde RRHH. Los renglones que alguien editó a mano se conservan. */
  async function calcular(q, planilla) {
    const { P, tramos, filas, pendientes } = await cargarParametros(q);
    const periodo = periodoDe(specDe(planilla), P);
    const periodica = ['semanal', 'quincena', 'mensual'].includes(planilla.tipo);
    const empleados = (await q.query(
      `select e.*, p.nombres, p.apellidos, p.identidad, p.banco, p.cuenta_bancaria, s.nombre as sucursal, s.orden as sucursal_orden
         from rrhh.empleados e join rrhh.personas p on p.id = e.persona_id left join core.sucursales s on s.id = e.sucursal_id
         left join plan.empleado_periodicidad ep on ep.empleado_id = e.id left join plan.config_empresa ce on ce.empresa_id = e.empresa_id
        where e.empresa_id = $1 and (e.fecha_ingreso is null or e.fecha_ingreso <= $3::date) and (e.fecha_salida is null or e.fecha_salida >= $2::date)
          and (e.estado <> 'baja' or e.fecha_salida is not null) and ($4::text is null or coalesce(ep.periodicidad, ce.periodicidad, 'quincena') = $4)
        order by coalesce(s.orden, 999), p.nombres, p.apellidos`, [planilla.empresa_id, planilla.desde, planilla.hasta, periodica ? planilla.tipo : null])).rows;
    const [d, h] = [planilla.desde, planilla.hasta];
    const aus = periodica ? (await q.query(`select a.* from rrhh.ausencias a where a.empresa_id = $1 and a.estado = 'aprobada' and not a.pagado and a.desde <= $3::date and a.hasta >= $2::date`, [planilla.empresa_id, d, h])).rows : [];
    const sus = periodica ? (await q.query(
      `select s.empleado_id, s.fecha::text as desde, (s.fecha + (s.dias_suspension - 1))::text as hasta from rrhh.sanciones s
        where s.empresa_id = $1 and s.tipo = 'suspension' and s.estado = 'vigente' and s.con_goce is not true and s.dias_suspension is not null
          and s.fecha <= $3::date and (s.fecha + (s.dias_suspension - 1)) >= $2::date`, [planilla.empresa_id, d, h])).rows : [];
    const vac = periodica ? (await q.query(
      `select v.empleado_id, v.desde, v.hasta, v.dias from rrhh.vacaciones v join rrhh.empleados e on e.id = v.empleado_id
        where e.empresa_id = $1 and v.estado in ('aprobada','tomada') and v.desde <= $3::date and v.hasta >= $2::date`, [planilla.empresa_id, d, h])).rows : [];
    const nov = periodica ? (await q.query(
      `select * from plan.novedades where empresa_id = $1 and fecha between $2::date and $3::date and (estado = 'pendiente' or planilla_id = $4) and estado <> 'anulada'`, [planilla.empresa_id, d, h, planilla.id])).rows : [];
    const fijas = periodica ? (await q.query('select empleado_id, concepto, monto_mensual from plan.deducciones_fijas where empresa_id = $1 and activa', [planilla.empresa_id])).rows : [];
    // horas extra sugeridas por el reporte de horas: lo que cada turno completo pasa de la jornada, en pasos de media hora
    const sugeridas = new Map();
    if (periodica) {
      const marc = (await q.query(
        `select empleado_id, tipo, marcada_at, verificacion from rrhh.marcaciones where empresa_id = $1
            and marcada_at >= ($2::date)::timestamp at time zone 'America/Tegucigalpa' and marcada_at < (($3::date + 2))::timestamp at time zone 'America/Tegucigalpa'`, [planilla.empresa_id, d, h])).rows;
      for (const f of armarReporte({ empleados, marcaciones: marc, desde: d, hasta: h })) {
        const jornada = f.jornada === 'nocturna' ? P.horas_dia_nocturna : f.jornada === 'mixta' ? P.horas_dia_mixta : P.horas_dia_diurna;
        sugeridas.set(f.id, f.turnos.filter((t) => t.horas !== null).reduce((s, t) => s + Math.floor(Math.max(0, t.horas - jornada) * 2) / 2, 0));
      }
    }
    const editadas = new Map((await q.query('select * from plan.planilla_lineas where planilla_id = $1 and editado', [planilla.id])).rows.map((l) => [l.empleado_id, l]));
    // horas extra escritas en la captura rápida: viven en el renglón (detalle.horas_captura) y sobreviven al volver a llenar
    const capturadas = new Map((await q.query(
      `select empleado_id, (detalle->>'horas_captura')::numeric as horas from plan.planilla_lineas where planilla_id = $1 and not editado and detalle ? 'horas_captura'`, [planilla.id])).rows
      .map((x) => [x.empleado_id, Number(x.horas)]));
    const avisos = [];
    const nuevas = [];
    for (const emp of empleados) {
      const nombre = `${emp.nombres} ${emp.apellidos ?? ''}`.trim();
      if (editadas.has(emp.id)) continue;
      const res = armarLinea({
        tipo: planilla.tipo, emp, P, tramos, periodo, horasSugeridas: sugeridas.get(emp.id) ?? 0, horasCapturadas: capturadas.get(emp.id) ?? null,
        novedades: nov.filter((n) => n.empleado_id === emp.id), ausencias: aus.filter((a) => a.empleado_id === emp.id),
        vacaciones: vac.filter((v) => v.empleado_id === emp.id), suspensiones: sus.filter((s) => s.empleado_id === emp.id), fijas: fijas.filter((f) => f.empleado_id === emp.id),
      });
      if (res.omitido) { avisos.push({ empleado: nombre, nivel: 'omitido', mensaje: `No entró a la planilla: ${res.omitido}.` }); continue; }
      for (const a of res.avisos) avisos.push({ empleado: nombre, nivel: 'aviso', mensaje: a });
      nuevas.push(res.linea);
    }
    await q.query('delete from plan.planilla_lineas where planilla_id = $1 and not editado', [planilla.id]);
    for (const l of nuevas) await insertarLinea(q, planilla.id, l);
    const todas = (await q.query('select * from plan.planilla_lineas where planilla_id = $1', [planilla.id])).rows;
    if (!todas.length) avisos.unshift({ nivel: 'aviso', mensaje: `No hay empleados con salario y pago ${PERIODICIDADES[planilla.tipo]?.toLowerCase() ?? ''} en este periodo.` });
    if (editadas.size) avisos.push({ nivel: 'info', mensaje: `${editadas.size} renglón(es) corregidos a mano se conservaron.` });
    await q.query(`update plan.planillas set parametros = $2::jsonb, advertencias = $3::jsonb, por_confirmar = $4, calculada_at = now() where id = $1`,
      [planilla.id, JSON.stringify({ valores: Object.fromEntries(filas.map((p) => [p.clave, Number(p.valor)])), isr_tramos: tramos.map((t) => ({ desde: t.desde, tasa: t.tasa })) }), JSON.stringify(avisos), pendientes]);
    return { totales: totalesDe(todas), avisos, lineas: todas.length };
  }

  async function cargarPlanilla(q, req, id, { bloquear = false } = {}) {
    const { rows } = await q.query(`select * from plan.planillas where id = $1 and empresa_id = $2 ${bloquear ? 'for update' : ''}`, [validar(uuid, id), empresa(req)]);
    if (!rows[0]) throw noEncontrado('Planilla no encontrada');
    return rows[0];
  }
  const lineasDe = async (q, id) => (await q.query(`select l.*, coalesce(s.orden, 999) as orden_suc from plan.planilla_lineas l left join core.sucursales s on s.id = l.sucursal_id where l.planilla_id = $1 order by coalesce(s.orden, 999), l.nombre`, [id])).rows;

  async function detalle(q, req, id) {
    const p = await cargarPlanilla(q, req, id);
    const lineas = await lineasDe(q, p.id);
    const totales = totalesDe(lineas);
    const suma = Math.round(lineas.reduce((s, l) => s + Number(l.total), 0) * 100) / 100;
    return {
      ...p, empresa: req.ctx.empresa.nombre, lineas, grupos: agruparPorSucursal(lineas), totales, contable: resumenContable(p.tipo, totales),
      control: { empleados: lineas.length, con_cuenta: lineas.length - totales.sin_cuenta, sin_cuenta: totales.sin_cuenta, total_a_pagar: totales.total, suma_de_renglones: suma, cuadra: suma === totales.total },
    };
  }

  r.get('/planillas', async (req, res) => {
    const { rows } = await db.query(
      `select p.id, p.tipo, p.etiqueta, p.desde, p.hasta, p.fecha_pago, p.estado, p.por_confirmar, p.aprobada_at, p.pagada_at, p.gasto_id, p.created_at, p.reaperturas,
              jsonb_array_length(p.advertencias) as avisos, (select count(*)::int from plan.planilla_lineas l where l.planilla_id = p.id) as empleados,
              (select coalesce(sum(total),0) from plan.planilla_lineas l where l.planilla_id = p.id) as total
         from plan.planillas p where p.empresa_id = $1 order by p.desde desc, p.tipo, p.created_at desc limit 200`, [empresa(req)]);
    res.json(rows);
  });

  r.post('/planillas', async (req, res) => {
    const b = validar(z.object({
      tipo: z.enum(TIPOS), anio: z.coerce.number().int().min(2020).max(2100).optional(), mes: z.coerce.number().int().min(1).max(12).optional(), quincena: z.coerce.number().int().min(1).max(2).optional(),
      desde: fechaISO.optional(), fecha_pago: fechaISO.optional().nullable(), notas: z.string().trim().max(300).optional().nullable(),
    }), req.body);
    if (b.tipo === 'semanal' && !b.desde) throw malaPeticion('Indica el primer día de la semana');
    if (['quincena', 'mensual'].includes(b.tipo) && (!b.anio || !b.mes)) throw malaPeticion('Elige el mes');
    if (b.tipo === 'quincena' && !b.quincena) throw malaPeticion('Elige la quincena');
    if (['aguinaldo', 'catorceavo'].includes(b.tipo) && !b.anio) throw malaPeticion('Elige el año');
    const out = await db.tx(async (q) => {
      const { P } = await cargarParametros(q);
      const per = periodoDe({ tipo: b.tipo, anio: b.anio, mes: b.mes, quincena: b.quincena, desde: b.desde }, P);
      if (per.error) throw malaPeticion(per.error);
      const ya = (await q.query(`select id, estado from plan.planillas where empresa_id = $1 and tipo = $2 and desde = $3 and hasta = $4 and estado <> 'anulada'`, [empresa(req), b.tipo, per.desde, per.hasta])).rows[0];
      if (ya) throw conflicto(`Ya existe una planilla ${PERIODICIDADES[b.tipo]?.toLowerCase() ?? b.tipo} de ese periodo (${ya.estado}). Ábrela, o anúlala para hacer otra.`);
      const p = (await q.query(
        `insert into plan.planillas (empresa_id, tipo, etiqueta, desde, hasta, fecha_pago, notas, creada_por) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [empresa(req), b.tipo, per.etiqueta, per.desde, per.hasta, b.fecha_pago ?? per.pago, b.notas || null, req.ctx.usuario.id])).rows[0];
      const c = await calcular(q, p);
      await auditar(q, req.ctx, 'planilla.creada', 'planilla', p.id, { etiqueta: p.etiqueta, tipo: p.tipo, empleados: c.lineas, total: c.totales.total });
      return p;
    });
    res.status(201).json(out);
  });

  r.get('/planillas/:id', async (req, res) => {
    const d = await detalle(db, req, req.params.id);
    await auditar(db, req.ctx, 'planilla.consultada', 'planilla', d.id, { etiqueta: d.etiqueta });   // ver sueldos de todos queda en la bitácora
    res.json(d);
  });

  // Corregir una celda (o varias) de un renglón antes de aprobar
  r.patch('/planillas/:id/lineas/:lid', async (req, res) => {
    const b = validar(z.object({
      dias: z.coerce.number().min(0).max(400).optional(), salario_diario: z.coerce.number().min(0).max(999_999).optional(), por_hora: z.coerce.number().min(0).max(999_999).optional(),
      horas_extra: z.coerce.number().min(0).max(999).optional(), total_hx: z.coerce.number().min(0).max(9_999_999).optional(), otros_ingresos: z.coerce.number().min(0).max(9_999_999).optional(),
      deducciones: z.array(z.object({ concepto: z.string().trim().min(1).max(80), monto: z.coerce.number().min(0).max(9_999_999) })).max(20).optional(),
      banco: z.string().trim().max(80).optional().nullable(), cuenta: z.string().trim().max(40).optional().nullable(), observaciones: z.string().trim().max(300).optional(),
    }), req.body);
    const out = await db.tx(async (q) => {
      const p = await cargarPlanilla(q, req, req.params.id, { bloquear: true });
      if (p.estado !== 'borrador') throw conflicto('La planilla ya está cerrada: reábrela (solo el dueño, con motivo) para corregir');
      const l = (await q.query('select * from plan.planilla_lineas where id = $1 and planilla_id = $2 for update', [validar(uuid, req.params.lid), p.id])).rows[0];
      if (!l) throw noEncontrado('Renglón no encontrado');
      if (sinHorasExtra(l) && (Number(b.horas_extra) > 0 || Number(b.total_hx) > 0)) throw malaPeticion(`${l.nombre} es de Gerencia: no cobra horas extra`);
      const { P } = await cargarParametros(q);
      const n = { ...l, ...Object.fromEntries(Object.entries(b).filter(([k, v]) => v !== undefined && k !== 'deducciones')) };
      if (b.deducciones) n.deducciones = b.deducciones.map((d) => ({ ...d, tipo: l.deducciones.find((x) => x.concepto === d.concepto)?.tipo ?? 'manual' }));
      if (b.salario_diario !== undefined && b.por_hora === undefined) n.por_hora = Math.round((b.salario_diario / P.horas_dia_diurna) * 10000) / 10000;
      if ((b.horas_extra !== undefined || b.por_hora !== undefined || b.salario_diario !== undefined) && b.total_hx === undefined) n.total_hx = Math.round(n.horas_extra * n.por_hora * (1 + P.he_diurna_pct / 100) * 100) / 100;
      const f = recalcularRenglon(n);
      if (f.total < 0) throw malaPeticion('El total a pagar quedaría negativo');
      await q.query(
        `update plan.planilla_lineas set dias=$2, salario_diario=$3, total_quincenal=$4, por_hora=$5, horas_extra=$6, total_hx=$7, otros_ingresos=$8, deducciones=$9::jsonb, total_deducciones=$10, total=$11,
                banco=$12, cuenta=$13, observaciones=$14, editado=true where id=$1`,
        [l.id, f.dias, f.salario_diario, f.total_quincenal, f.por_hora, f.horas_extra, f.total_hx, f.otros_ingresos, JSON.stringify(f.deducciones), f.total_deducciones, f.total, f.banco, f.cuenta, f.observaciones ?? '']);
      const cambios = Object.fromEntries(Object.keys(b).map((k) => [k, { antes: l[k], despues: f[k] }]));
      await auditar(q, req.ctx, 'planilla.renglon_editado', 'planilla', p.id, { empleado: l.nombre, cambios, total_antes: l.total, total_despues: f.total });
      return { ...f, totales: totalesDe(await lineasDe(q, p.id)) };
    });
    res.json(out);
  });

  /**
   * Captura rápida de HORAS EXTRAS (como la columna de la hoja): varias de una vez, por empleado.
   * El número es EL total de horas extra del periodo (reemplaza al sugerido por el reporte de horas y a las novedades).
   * Renglón sin tocar → se guarda en detalle.horas_captura y se recalcula todo (deducciones, totales) sin «congelar» el renglón;
   * renglón corregido a mano → se cambian sus horas y su TOTAL HX. Solo en borrador; Gerencia no cobra horas extra.
   */
  r.put('/planillas/:id/horas', async (req, res) => {
    const b = validar(z.object({ horas: z.array(z.object({ empleado_id: uuid, horas: z.coerce.number().min(0, 'Las horas no pueden ser negativas').max(300, 'Máximo 300 horas extra en un periodo') })).min(1).max(1000) }), req.body);
    const out = await db.tx(async (q) => {
      const p = await cargarPlanilla(q, req, req.params.id, { bloquear: true });
      if (p.estado !== 'borrador') throw conflicto('La planilla ya está cerrada: reábrela (solo el dueño, con motivo) para cambiar horas');
      if (!['semanal', 'quincena', 'mensual'].includes(p.tipo)) throw malaPeticion('El aguinaldo y el catorceavo no llevan horas extra');
      const lineas = new Map((await q.query('select * from plan.planilla_lineas where planilla_id = $1 for update', [p.id])).rows.map((l) => [l.empleado_id, l]));
      const { P } = await cargarParametros(q);
      const cambios = [];
      for (const h of b.horas) {
        const l = lineas.get(h.empleado_id);
        if (!l) throw noEncontrado('Un empleado ya no está en esta planilla: ciérrala y vuelve a abrirla');
        const horas = Math.round(h.horas * 100) / 100;
        if (sinHorasExtra(l)) { if (horas > 0) throw malaPeticion(`${l.nombre} es de Gerencia: no cobra horas extra`); continue; }
        if (Number(l.horas_extra) === horas) continue;
        if (l.editado) {
          const f = recalcularRenglon({ ...l, horas_extra: horas, total_hx: r2(horas * Number(l.por_hora) * (1 + P.he_diurna_pct / 100)) });
          if (f.total < 0) throw malaPeticion(`El total de ${l.nombre} quedaría negativo`);
          await q.query('update plan.planilla_lineas set horas_extra = $2, total_hx = $3, total = $4 where id = $1', [l.id, f.horas_extra, f.total_hx, f.total]);
        } else {
          await q.query(`update plan.planilla_lineas set detalle = detalle || jsonb_build_object('horas_captura', $2::numeric) where id = $1`, [l.id, horas]);
        }
        cambios.push({ empleado: l.nombre, antes: Number(l.horas_extra), despues: horas });
      }
      if (!cambios.length) return { guardadas: 0 };
      const c = await calcular(q, p);
      await auditar(q, req.ctx, 'planilla.horas_capturadas', 'planilla', p.id, { etiqueta: p.etiqueta, cambios, total: c.totales.total });
      return { guardadas: cambios.length };
    });
    res.json({ ...out, planilla: await detalle(db, req, req.params.id) });
  });

  /** Para «copiar horas del periodo anterior»: las HORAS EXTRAS de la planilla anterior del mismo tipo (no anulada). */
  r.get('/planillas/:id/horas-anteriores', async (req, res) => {
    const p = await cargarPlanilla(db, req, req.params.id);
    const ant = (await db.query(
      `select id, etiqueta, estado from plan.planillas where empresa_id = $1 and tipo = $2 and estado <> 'anulada' and hasta < $3::date order by hasta desc, created_at desc limit 1`, [p.empresa_id, p.tipo, p.desde])).rows[0];
    if (!ant) return res.json({ planilla: null, horas: [] });
    const { rows } = await db.query('select empleado_id, horas_extra from plan.planilla_lineas where planilla_id = $1 and horas_extra > 0', [ant.id]);
    res.json({ planilla: ant, horas: rows.map((x) => ({ empleado_id: x.empleado_id, horas: Number(x.horas_extra) })) });
  });

  r.post('/planillas/:id/recalcular', async (req, res) => {
    const out = await db.tx(async (q) => {
      const p = await cargarPlanilla(q, req, req.params.id, { bloquear: true });
      if (p.estado !== 'borrador') throw conflicto('Solo se recalcula una planilla en borrador');
      const c = await calcular(q, p);
      await auditar(q, req.ctx, 'planilla.recalculada', 'planilla', p.id, { etiqueta: p.etiqueta, empleados: c.lineas, total: c.totales.total });
      return c;
    });
    res.json({ ok: true, ...out });
  });

  r.post('/planillas/:id/aprobar', async (req, res) => {
    const out = await db.tx(async (q) => {
      const p = await cargarPlanilla(q, req, req.params.id, { bloquear: true });
      if (p.estado !== 'borrador') throw conflicto('Esta planilla ya no está en borrador');
      const c = await calcular(q, p);                            // última lectura antes de cerrar (lo editado a mano se respeta)
      if (!c.lineas) throw malaPeticion('La planilla no tiene empleados: no se puede aprobar');
      const neg = (await q.query('select count(*)::int as n from plan.planilla_lineas where planilla_id = $1 and total < 0', [p.id])).rows[0].n;
      if (neg) throw malaPeticion(`${neg} empleado(s) quedaron con total negativo: corrige las deducciones antes de aprobar`);
      await q.query(`update plan.novedades n set estado = 'aplicada', planilla_id = $1 where n.empresa_id = $2 and n.estado = 'pendiente' and n.fecha between $3::date and $4::date
                      and n.empleado_id in (select empleado_id from plan.planilla_lineas where planilla_id = $1)`, [p.id, p.empresa_id, p.desde, p.hasta]);
      await q.query(`update plan.planillas set estado = 'aprobada', aprobada_por = $2, aprobada_at = now() where id = $1`, [p.id, req.ctx.usuario.id]);
      await auditar(q, req.ctx, 'planilla.aprobada', 'planilla', p.id, { etiqueta: p.etiqueta, empleados: c.lineas, total: c.totales.total, costo_empresa: c.totales.costo_empresa, parametros_sin_confirmar: p.por_confirmar });
      return { ok: true, totales: c.totales };
    });
    res.json(out);
  });

  /** Reabrir una planilla cerrada (no pagada): solo el dueño del grupo, con motivo; queda en el historial de la planilla y en la bitácora. */
  r.post('/planillas/:id/reabrir', async (req, res) => {
    soloDuenoGrupo(req);
    const b = validar(z.object({ motivo: z.string().trim().min(5, 'Escribe el motivo (mínimo 5 letras)').max(200) }), req.body);
    await db.tx(async (q) => {
      const p = await cargarPlanilla(q, req, req.params.id, { bloquear: true });
      if (p.estado === 'pagada') throw conflicto('Una planilla pagada no se reabre');
      if (p.estado !== 'aprobada') throw conflicto('Solo se reabre una planilla aprobada');
      if (p.gasto_id) await q.query('update fin.gastos set anulado = true where id = $1', [p.gasto_id]);
      await q.query(`update plan.novedades set estado = 'pendiente', planilla_id = null where planilla_id = $1`, [p.id]);
      const hist = [...p.reaperturas, { por: req.ctx.usuario.nombre, cuando: new Date().toISOString(), motivo: b.motivo }];
      await q.query(`update plan.planillas set estado = 'borrador', aprobada_por = null, aprobada_at = null, gasto_id = null, reaperturas = $2::jsonb where id = $1`, [p.id, JSON.stringify(hist)]);
      await auditar(q, req.ctx, 'planilla.reabierta', 'planilla', p.id, { etiqueta: p.etiqueta, motivo: b.motivo, gasto_anulado: !!p.gasto_id });
    });
    res.json({ ok: true });
  });

  r.post('/planillas/:id/pagar', async (req, res) => {
    await db.tx(async (q) => {
      const p = await cargarPlanilla(q, req, req.params.id, { bloquear: true });
      if (p.estado !== 'aprobada') throw conflicto('Primero hay que aprobar la planilla');
      await q.query(`update plan.planillas set estado = 'pagada', pagada_por = $2, pagada_at = now() where id = $1`, [p.id, req.ctx.usuario.id]);
      if (p.gasto_id) await q.query('update fin.gastos set pagado = true where id = $1', [p.gasto_id]);
      await auditar(q, req.ctx, 'planilla.pagada', 'planilla', p.id, { etiqueta: p.etiqueta });
    });
    res.json({ ok: true });
  });

  r.post('/planillas/:id/anular', async (req, res) => {
    const b = validar(z.object({ motivo: z.string().trim().min(3, 'Escribe el motivo').max(200) }), req.body);
    await db.tx(async (q) => {
      const p = await cargarPlanilla(q, req, req.params.id, { bloquear: true });
      if (!['borrador', 'aprobada'].includes(p.estado)) throw conflicto(p.estado === 'pagada' ? 'Una planilla pagada no se anula desde aquí' : 'Esta planilla ya está anulada');
      await q.query(`update plan.novedades set estado = 'pendiente', planilla_id = null where planilla_id = $1`, [p.id]);
      if (p.gasto_id) await q.query('update fin.gastos set anulado = true where id = $1', [p.gasto_id]);
      await q.query(`update plan.planillas set estado = 'anulada', anulada_por = $2, anulada_at = now(), motivo_anulacion = $3 where id = $1`, [p.id, req.ctx.usuario.id, b.motivo]);
      await auditar(q, req.ctx, 'planilla.anulada', 'planilla', p.id, { etiqueta: p.etiqueta, motivo: b.motivo, estaba: p.estado });
    });
    res.json({ ok: true });
  });

  // ── Resumen contable y envío a Finanzas ───────────────────────────────────
  r.get('/planillas/:id/contable', async (req, res) => {
    const d = await detalle(db, req, req.params.id);
    res.json({ planilla: { id: d.id, etiqueta: d.etiqueta, estado: d.estado, por_confirmar: d.por_confirmar, gasto_id: d.gasto_id }, empresa: d.empresa, ...d.contable, totales: d.totales });
  });

  r.post('/planillas/:id/finanzas', async (req, res) => {
    const out = await db.tx(async (q) => {
      const p = await cargarPlanilla(q, req, req.params.id, { bloquear: true });
      if (!['aprobada', 'pagada'].includes(p.estado)) throw conflicto('Solo una planilla aprobada se manda a Finanzas');
      if (p.gasto_id) throw conflicto('Esta planilla ya se mandó a Finanzas');
      const monto = r2(totalesDe(await lineasDe(q, p.id)).costo_empresa);
      if (!(monto > 0)) throw malaPeticion('La planilla no tiene monto');
      let cat = (await q.query(`select id from fin.categorias_gasto where empresa_id = $1 and grupo = 'nomina' and activo order by nombre limit 1`, [p.empresa_id])).rows[0];
      if (!cat) cat = (await q.query(`insert into fin.categorias_gasto (empresa_id, nombre, grupo) values ($1,'Planilla y cargas sociales','nomina') returning id`, [p.empresa_id])).rows[0];
      const g = (await q.query(
        `insert into fin.gastos (empresa_id, fecha, categoria_id, descripcion, monto, documento, pagado, registrado_por) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [p.empresa_id, p.fecha_pago ?? p.hasta, cat.id, `Planilla ${p.etiqueta} (costo total de la empresa)`, monto, `PLAN-${p.id.slice(0, 8)}`, p.estado === 'pagada', req.ctx.usuario.id])).rows[0];
      await q.query('update plan.planillas set gasto_id = $2 where id = $1', [p.id, g.id]);
      await auditar(q, req.ctx, 'planilla.enviada_finanzas', 'planilla', p.id, { etiqueta: p.etiqueta, monto, gasto_id: g.id });
      return { ok: true, gasto_id: g.id, monto };
    });
    res.json(out);
  });

  /** Por mes, lo aprobado/pagado de la empresa: lo que Finanzas necesita para cerrar el mes. */
  r.get('/resumen-contable', async (req, res) => {
    const f = validar(z.object({ anio: z.coerce.number().int().min(2020).max(2100).default(Number(fechaHN().slice(0, 4))), mes: z.coerce.number().int().min(1).max(12).optional() }), req.query);
    const { rows } = await db.query(
      `select id, tipo, etiqueta, desde, hasta, estado, gasto_id, por_confirmar from plan.planillas
        where empresa_id = $1 and estado in ('aprobada','pagada') and extract(year from hasta) = $2 and ($3::int is null or extract(month from hasta) = $3) order by hasta, tipo`, [empresa(req), f.anio, f.mes ?? null]);
    const todas = [];
    for (const p of rows) todas.push(...await lineasDe(db, p.id));
    const t = totalesDe(todas);
    res.json({ empresa: req.ctx.empresa.nombre, anio: f.anio, mes: f.mes ?? null, planillas: rows, totales: t, contable: resumenContable('mensual', t), sin_confirmar: rows.some((p) => p.por_confirmar) });
  });

  /** Dirección: las planillas de las cuatro empresas de un mes, lado a lado (solo el dueño del grupo). */
  r.get('/grupo', async (req, res) => {
    soloDuenoGrupo(req);
    const f = validar(z.object({ anio: z.coerce.number().int().min(2020).max(2100).default(Number(fechaHN().slice(0, 4))), mes: z.coerce.number().int().min(1).max(12).default(Number(fechaHN().slice(5, 7))) }), req.query);
    const { rows: emps } = await db.query('select id, codigo, nombre, color from core.empresas where activo order by orden');
    const out = [];
    for (const e of emps) {
      const planillas = (await db.query(
        `select p.id, p.tipo, p.etiqueta, p.desde, p.hasta, p.estado, p.por_confirmar, (select count(*)::int from plan.planilla_lineas l where l.planilla_id = p.id) as empleados,
                (select coalesce(sum(total),0) from plan.planilla_lineas l where l.planilla_id = p.id) as total
           from plan.planillas p where p.empresa_id = $1 and p.estado <> 'anulada' and extract(year from p.hasta) = $2 and extract(month from p.hasta) = $3 order by p.desde, p.tipo`, [e.id, f.anio, f.mes])).rows;
      out.push({ ...e, planillas, total: Math.round(planillas.reduce((s, p) => s + Number(p.total), 0) * 100) / 100, borradores: planillas.filter((p) => p.estado === 'borrador').length });
    }
    res.json({ anio: f.anio, mes: f.mes, empresas: out, total: Math.round(out.reduce((s, e) => s + e.total, 0) * 100) / 100 });
  });

  // ── Boletas de pago en PDF y exportación a Excel ──────────────────────────
  async function boletas(req, res, soloEmpleado) {
    const p = await cargarPlanilla(db, req, req.params.id);
    if (!['aprobada', 'pagada'].includes(p.estado)) throw conflicto('Las boletas salen cuando la planilla está aprobada');
    const lineas = (await lineasDe(db, p.id)).filter((l) => !soloEmpleado || l.empleado_id === soloEmpleado);
    if (!lineas.length) throw noEncontrado('No hay boletas');
    const aviso = p.por_confirmar ? 'Calculada con parámetros por confirmar con el contador. Documento interno de la empresa.' : null;
    const pdf = generarBoletasPdf({ empresa: req.ctx.empresa.nombre, planilla: p, lineas, aviso });
    await auditar(db, req.ctx, 'planilla.boletas_generadas', 'planilla', p.id, { etiqueta: p.etiqueta, boletas: lineas.length, empleado_id: soloEmpleado ?? null });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="boletas-${p.tipo}-${p.desde}.pdf"`);
    res.send(pdf);
  }
  r.get('/planillas/:id/boletas.pdf', (req, res) => boletas(req, res, null));
  r.get('/planillas/:id/boleta/:empleadoId', (req, res) => boletas(req, res, validar(uuid, req.params.empleadoId)));

  r.get('/planillas/:id/excel', async (req, res) => {
    const p = await cargarPlanilla(db, req, req.params.id);
    if (p.estado === 'anulada') throw conflicto('La planilla está anulada');
    const lineas = await lineasDe(db, p.id);
    const buf = await generarExcel({ empresa: req.ctx.empresa.nombre, planilla: p, lineas });
    await auditar(db, req.ctx, 'planilla.excel_exportado', 'planilla', p.id, { etiqueta: p.etiqueta, estado: p.estado });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="planilla-${req.ctx.empresa.codigo}-${p.tipo}-${p.desde}.xlsx"`);
    res.send(Buffer.from(buf));
  });

  // Empleados de la empresa (para elegir en novedades y deducciones)
  r.get('/empleados', async (req, res) => {
    const { rows } = await db.query(
      `select e.id, p.nombres || ' ' || p.apellidos as nombre, e.puesto, e.salario_mensual is not null as con_salario from rrhh.empleados e join rrhh.personas p on p.id = e.persona_id
        where e.empresa_id = $1 and e.estado <> 'baja' order by p.nombres`, [empresa(req)]);
    res.json(rows);
  });

  return r;
}
