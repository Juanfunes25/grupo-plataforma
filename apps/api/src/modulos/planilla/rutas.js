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
import { calcularLinea, mapaParametros, periodoDe, resumenContable, totalesDe } from './calculo.js';
import { generarBoletasPdf } from './pdf.js';

const TIPOS = ['quincena', 'mensual', 'aguinaldo', 'catorceavo'];
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

  // ── Cálculo de una planilla ───────────────────────────────────────────────
  /** Calcula (o recalcula) los renglones de una planilla en borrador y deja los totales. */
  async function calcular(q, planilla) {
    const { P, tramos, filas, pendientes } = await cargarParametros(q);
    const per = { desde: planilla.desde, hasta: planilla.hasta };
    const periodo = periodoDe({ tipo: planilla.tipo, anio: Number(planilla.hasta.slice(0, 4)), mes: Number(planilla.hasta.slice(5, 7)), quincena: planilla.desde.endsWith('-01') ? 1 : 2 }, P);
    const empleados = (await q.query(
      `select e.*, p.nombres, p.apellidos, p.identidad, s.nombre as sucursal from rrhh.empleados e join rrhh.personas p on p.id = e.persona_id left join core.sucursales s on s.id = e.sucursal_id
        where e.empresa_id = $1 and (e.fecha_ingreso is null or e.fecha_ingreso <= $3::date) and (e.fecha_salida is null or e.fecha_salida >= $2::date)
          and (e.estado <> 'baja' or e.fecha_salida is not null) order by p.nombres, p.apellidos`, [planilla.empresa_id, per.desde, per.hasta])).rows;
    const periodica = planilla.tipo === 'quincena' || planilla.tipo === 'mensual';
    const aus = periodica ? (await q.query(
      `select a.* from rrhh.ausencias a where a.empresa_id = $1 and a.estado = 'aprobada' and not a.pagado and a.desde <= $3::date and a.hasta >= $2::date`, [planilla.empresa_id, per.desde, per.hasta])).rows : [];
    const sus = periodica ? (await q.query(
      `select s.empleado_id, s.fecha::text as desde, (s.fecha + (s.dias_suspension - 1))::text as hasta from rrhh.sanciones s
        where s.empresa_id = $1 and s.tipo = 'suspension' and s.estado = 'vigente' and s.con_goce is not true and s.dias_suspension is not null
          and s.fecha <= $3::date and (s.fecha + (s.dias_suspension - 1)) >= $2::date`, [planilla.empresa_id, per.desde, per.hasta])).rows : [];
    const vac = periodica ? (await q.query(
      `select v.empleado_id, v.desde, v.hasta, v.dias from rrhh.vacaciones v join rrhh.empleados e on e.id = v.empleado_id
        where e.empresa_id = $1 and v.estado in ('aprobada','tomada') and v.desde <= $3::date and v.hasta >= $2::date`, [planilla.empresa_id, per.desde, per.hasta])).rows : [];
    const nov = periodica ? (await q.query(
      `select * from plan.novedades where empresa_id = $1 and fecha between $2::date and $3::date and (estado = 'pendiente' or planilla_id = $4) and estado <> 'anulada'`,
      [planilla.empresa_id, per.desde, per.hasta, planilla.id])).rows : [];

    const lineas = [], avisos = [];
    for (const emp of empleados) {
      const res = calcularLinea({
        tipo: planilla.tipo, emp, P, tramos, periodo,
        novedades: nov.filter((n) => n.empleado_id === emp.id), ausencias: aus.filter((a) => a.empleado_id === emp.id),
        vacaciones: vac.filter((v) => v.empleado_id === emp.id), suspensiones: sus.filter((s) => s.empleado_id === emp.id),
      });
      const nombre = `${emp.nombres} ${emp.apellidos ?? ''}`.trim();
      if (res.omitido) { avisos.push({ empleado: nombre, nivel: 'omitido', mensaje: `No entró a la planilla: ${res.omitido}.` }); continue; }
      for (const a of res.avisos) avisos.push({ empleado: nombre, nivel: 'aviso', mensaje: a });
      lineas.push(res.linea);
    }
    await q.query('delete from plan.planilla_lineas where planilla_id = $1', [planilla.id]);
    for (const l of lineas) {
      await q.query(
        `insert into plan.planilla_lineas (planilla_id, empleado_id, nombre, identidad, puesto, sucursal, salario_mensual, dias_pagados, devengado, desc_ausencias, he_diurna_h, he_nocturna_h, he_feriada_h,
           he_monto, bonos, vacaciones_dias, vacaciones_extra, ihss, rap, infop, isr, otros_desc, total_ingresos, total_deducciones, neto, ihss_patrono, rap_patrono, infop_patrono, detalle)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29::jsonb)`,
        [planilla.id, l.empleado_id, l.nombre, l.identidad, l.puesto, l.sucursal, l.salario_mensual, l.dias_pagados, l.devengado, l.desc_ausencias, l.he_diurna_h, l.he_nocturna_h, l.he_feriada_h,
          l.he_monto, l.bonos, l.vacaciones_dias, l.vacaciones_extra, l.ihss, l.rap, l.infop, l.isr, l.otros_desc, l.total_ingresos, l.total_deducciones, l.neto, l.ihss_patrono, l.rap_patrono, l.infop_patrono, JSON.stringify(l.detalle)]);
    }
    const totales = totalesDe(lineas);
    if (lineas.length === 0) avisos.unshift({ nivel: 'aviso', mensaje: 'No hay empleados con salario para este periodo.' });
    await q.query(
      `update plan.planillas set parametros = $2::jsonb, totales = $3::jsonb, advertencias = $4::jsonb, por_confirmar = $5, calculada_at = now() where id = $1`,
      [planilla.id, JSON.stringify({ valores: Object.fromEntries(filas.map((p) => [p.clave, Number(p.valor)])), isr_tramos: tramos.map((t) => ({ desde: t.desde, tasa: t.tasa })) }), JSON.stringify(totales), JSON.stringify(avisos), pendientes]);
    return { totales, avisos, lineas: lineas.length };
  }

  async function cargarPlanilla(q, req, id, { bloquear = false } = {}) {
    const { rows } = await q.query(`select * from plan.planillas where id = $1 and empresa_id = $2 ${bloquear ? 'for update' : ''}`, [validar(uuid, id), empresa(req)]);
    if (!rows[0]) throw noEncontrado('Planilla no encontrada');
    return rows[0];
  }

  r.get('/planillas', async (req, res) => {
    const { rows } = await db.query(
      `select p.id, p.tipo, p.etiqueta, p.desde, p.hasta, p.fecha_pago, p.estado, p.totales, p.por_confirmar, p.aprobada_at, p.pagada_at, p.gasto_id, p.created_at,
              jsonb_array_length(p.advertencias) as avisos
         from plan.planillas p where p.empresa_id = $1 order by p.desde desc, p.created_at desc limit 100`, [empresa(req)]);
    res.json(rows);
  });

  r.post('/planillas', async (req, res) => {
    const b = validar(z.object({
      tipo: z.enum(TIPOS), anio: z.coerce.number().int().min(2020).max(2100), mes: z.coerce.number().int().min(1).max(12).optional(), quincena: z.coerce.number().int().min(1).max(2).optional(),
      fecha_pago: fechaISO.optional().nullable(), notas: z.string().trim().max(300).optional().nullable(),
    }), req.body);
    if ((b.tipo === 'quincena' || b.tipo === 'mensual') && !b.mes) throw malaPeticion('Elige el mes');
    if (b.tipo === 'quincena' && !b.quincena) throw malaPeticion('Elige la quincena');
    const out = await db.tx(async (q) => {
      const { P } = await cargarParametros(q);
      const per = periodoDe({ tipo: b.tipo, anio: b.anio, mes: b.mes, quincena: b.quincena }, P);
      const ya = (await q.query(`select id, estado from plan.planillas where empresa_id = $1 and tipo = $2 and desde = $3 and hasta = $4 and estado <> 'anulada'`, [empresa(req), b.tipo, per.desde, per.hasta])).rows[0];
      if (ya) throw conflicto(`Ya existe una planilla de ese periodo (${ya.estado}). Ábrela, o anúlala para hacer otra.`);
      const p = (await q.query(
        `insert into plan.planillas (empresa_id, tipo, etiqueta, desde, hasta, fecha_pago, notas, creada_por) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [empresa(req), b.tipo, per.etiqueta, per.desde, per.hasta, b.fecha_pago ?? per.pago, b.notas || null, req.ctx.usuario.id])).rows[0];
      const c = await calcular(q, p);
      await auditar(q, req.ctx, 'planilla.creada', 'planilla', p.id, { etiqueta: p.etiqueta, empleados: c.lineas, neto: c.totales.neto, costo_empresa: c.totales.costo_empresa });
      return p;
    });
    res.status(201).json(out);
  });

  async function detalle(q, req, id) {
    const p = await cargarPlanilla(q, req, id);
    const lineas = (await q.query('select * from plan.planilla_lineas where planilla_id = $1 order by nombre', [p.id])).rows;
    return { ...p, lineas, contable: resumenContable(p.tipo, p.totales && Object.keys(p.totales).length ? p.totales : totalesDe(lineas)) };
  }

  r.get('/planillas/:id', async (req, res) => {
    const d = await detalle(db, req, req.params.id);
    // Ver la planilla completa (sueldos de todos) queda en la bitácora
    await auditar(db, req.ctx, 'planilla.consultada', 'planilla', d.id, { etiqueta: d.etiqueta });
    res.json(d);
  });

  r.post('/planillas/:id/recalcular', async (req, res) => {
    const out = await db.tx(async (q) => {
      const p = await cargarPlanilla(q, req, req.params.id, { bloquear: true });
      if (p.estado !== 'borrador') throw conflicto('Solo se recalcula una planilla en borrador');
      const c = await calcular(q, p);
      await auditar(q, req.ctx, 'planilla.recalculada', 'planilla', p.id, { etiqueta: p.etiqueta, empleados: c.lineas, neto: c.totales.neto });
      return c;
    });
    res.json({ ok: true, ...out });
  });

  r.post('/planillas/:id/aprobar', async (req, res) => {
    const out = await db.tx(async (q) => {
      const p = await cargarPlanilla(q, req, req.params.id, { bloquear: true });
      if (p.estado !== 'borrador') throw conflicto('Esta planilla ya no está en borrador');
      const c = await calcular(q, p);                            // última lectura antes de congelar
      if (!c.lineas) throw malaPeticion('La planilla no tiene empleados: no se puede aprobar');
      const neg = (await q.query('select count(*)::int as n from plan.planilla_lineas where planilla_id = $1 and neto < 0', [p.id])).rows[0].n;
      if (neg) throw malaPeticion(`${neg} empleado(s) quedaron con neto negativo: corrige los descuentos antes de aprobar`);
      await q.query(`update plan.novedades n set estado = 'aplicada', planilla_id = $1 where n.empresa_id = $2 and n.estado = 'pendiente' and n.fecha between $3::date and $4::date
                      and n.empleado_id in (select empleado_id from plan.planilla_lineas where planilla_id = $1)`, [p.id, p.empresa_id, p.desde, p.hasta]);
      await q.query(`update plan.planillas set estado = 'aprobada', aprobada_por = $2, aprobada_at = now() where id = $1`, [p.id, req.ctx.usuario.id]);
      await auditar(q, req.ctx, 'planilla.aprobada', 'planilla', p.id, { etiqueta: p.etiqueta, empleados: c.lineas, neto: c.totales.neto, costo_empresa: c.totales.costo_empresa, parametros_sin_confirmar: p.por_confirmar });
      return { ok: true, totales: c.totales };
    });
    res.json(out);
  });

  r.post('/planillas/:id/pagar', async (req, res) => {
    await db.tx(async (q) => {
      const p = await cargarPlanilla(q, req, req.params.id, { bloquear: true });
      if (p.estado !== 'aprobada') throw conflicto('Primero hay que aprobar la planilla');
      await q.query(`update plan.planillas set estado = 'pagada', pagada_por = $2, pagada_at = now() where id = $1`, [p.id, req.ctx.usuario.id]);
      if (p.gasto_id) await q.query('update fin.gastos set pagado = true where id = $1', [p.gasto_id]);
      await auditar(q, req.ctx, 'planilla.pagada', 'planilla', p.id, { etiqueta: p.etiqueta, neto: p.totales?.neto });
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
    res.json({ planilla: { id: d.id, etiqueta: d.etiqueta, estado: d.estado, por_confirmar: d.por_confirmar, gasto_id: d.gasto_id }, empresa: req.ctx.empresa.nombre, ...d.contable, totales: d.totales });
  });

  r.post('/planillas/:id/finanzas', async (req, res) => {
    const out = await db.tx(async (q) => {
      const p = await cargarPlanilla(q, req, req.params.id, { bloquear: true });
      if (!['aprobada', 'pagada'].includes(p.estado)) throw conflicto('Solo una planilla aprobada se manda a Finanzas');
      if (p.gasto_id) throw conflicto('Esta planilla ya se mandó a Finanzas');
      const monto = r2(p.totales.costo_empresa);
      if (!(monto > 0)) throw malaPeticion('La planilla no tiene monto');
      let cat = (await q.query(`select id from fin.categorias_gasto where empresa_id = $1 and grupo = 'nomina' and activo order by nombre limit 1`, [p.empresa_id])).rows[0];
      if (!cat) cat = (await q.query(`insert into fin.categorias_gasto (empresa_id, nombre, grupo) values ($1,'Planilla y cargas sociales','nomina') returning id`, [p.empresa_id])).rows[0];
      const g = (await q.query(
        `insert into fin.gastos (empresa_id, fecha, categoria_id, descripcion, monto, documento, pagado, registrado_por) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [p.empresa_id, p.fecha_pago ?? p.hasta, cat.id, `Planilla ${p.etiqueta} (costo total: sueldos y aportes patronales)`, monto, `PLAN-${p.id.slice(0, 8)}`, p.estado === 'pagada', req.ctx.usuario.id])).rows[0];
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
      `select id, tipo, etiqueta, desde, hasta, estado, totales, gasto_id, por_confirmar from plan.planillas
        where empresa_id = $1 and estado in ('aprobada','pagada') and extract(year from hasta) = $2 and ($3::int is null or extract(month from hasta) = $3) order by hasta, tipo`,
      [empresa(req), f.anio, f.mes ?? null]);
    const acc = { devengado: 0, desc_ausencias: 0, he_monto: 0, bonos: 0, vacaciones_extra: 0, ihss: 0, rap: 0, infop: 0, isr: 0, otros_desc: 0, total_ingresos: 0, total_deducciones: 0, neto: 0, ihss_patrono: 0, rap_patrono: 0, infop_patrono: 0 };
    for (const p of rows) for (const k of Object.keys(acc)) acc[k] += Number(p.totales[k] || 0);
    const t = totalesDe([acc]);
    res.json({ empresa: req.ctx.empresa.nombre, anio: f.anio, mes: f.mes ?? null, planillas: rows.map((p) => ({ ...p })), totales: t, contable: resumenContable('mensual', t), sin_confirmar: rows.some((p) => p.por_confirmar) });
  });

  // ── Boletas de pago en PDF ────────────────────────────────────────────────
  async function boletas(req, res, soloEmpleado) {
    const p = await cargarPlanilla(db, req, req.params.id);
    if (!['aprobada', 'pagada'].includes(p.estado)) throw conflicto('Las boletas salen cuando la planilla está aprobada');
    const lineas = (await db.query(`select * from plan.planilla_lineas where planilla_id = $1 ${soloEmpleado ? 'and empleado_id = $2' : ''} order by nombre`, soloEmpleado ? [p.id, soloEmpleado] : [p.id])).rows;
    if (!lineas.length) throw noEncontrado('No hay boletas');
    const aviso = p.por_confirmar ? 'Calculada con porcentajes por confirmar con el contador. Documento interno de la empresa.' : null;
    const pdf = generarBoletasPdf({ empresa: req.ctx.empresa.nombre, planilla: p, lineas, aviso });
    await auditar(db, req.ctx, 'planilla.boletas_generadas', 'planilla', p.id, { etiqueta: p.etiqueta, boletas: lineas.length, empleado_id: soloEmpleado ?? null });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="boletas-${p.desde}.pdf"`);
    res.send(pdf);
  }
  r.get('/planillas/:id/boletas.pdf', (req, res) => boletas(req, res, null));
  r.get('/planillas/:id/boleta/:empleadoId', (req, res) => boletas(req, res, validar(uuid, req.params.empleadoId)));

  // Empleados que cuentan para la planilla (para elegir en novedades)
  r.get('/empleados', async (req, res) => {
    const { rows } = await db.query(
      `select e.id, p.nombres || ' ' || p.apellidos as nombre, e.puesto, e.salario_mensual is not null as con_salario from rrhh.empleados e join rrhh.personas p on p.id = e.persona_id
        where e.empresa_id = $1 and e.estado <> 'baja' order by p.nombres`, [empresa(req)]);
    res.json(rows);
  });

  return r;
}
