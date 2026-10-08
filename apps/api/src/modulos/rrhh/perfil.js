// Perfil completo del empleado: alta/edición con bitácora (antes/después), ficha, vacaciones
// conforme a ley, ausencias/permisos, amonestaciones, evaluaciones, capacitaciones y horarios.
import { z } from 'zod';
import { fechaHN } from '@grupo/shared';
import { requierePermiso, resolverSucursal } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { conflicto, malaPeticion, noEncontrado, prohibido, uuid, validar, fechaISO, ErrorHttp } from '../../lib/http.js';
import { armarFicha } from './ficha.js';
import { calcularVacaciones, contarDias } from './vacaciones.js';
import {
  CAMPOS_CONTRATO, CAMPOS_PERSONA, ESTADOS, SENSIBLES, diferencias, diferenciasBitacora,
  esqContrato, esqPersona, fechaN, mascaraIdentidad, numN, soloEnviados, txt,
} from './comun.js';

const esqTodo = z.object({ ...esqPersona.shape, ...esqContrato.shape });
const esqAlta = esqTodo.partial().required({ nombres: true, puesto: true });
const esqEdicion = esqTodo.partial().extend({
  motivo_salario: txt(200), salario_desde: fechaN,           // contexto del cambio de salario
});

export const permisosFicha = (ctx) => ({ editar: ctx.permisos.has('rrhh:editar'), sensible: ctx.permisos.has('rrhh:sensible') });

/** UPDATE dinámico con columnas de una lista blanca (nunca nombres que vengan del cliente sin filtrar). */
async function actualizar(q, tabla, id, cambios, permitidas) {
  const claves = Object.keys(cambios).filter((k) => permitidas.includes(k));
  if (!claves.length) return;
  const sets = claves.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await q.query(`update ${tabla} set ${sets}${tabla === 'rrhh.personas' || tabla === 'rrhh.empleados' ? ', updated_at = now()' : ''} where id = $1`, [id, ...claves.map((k) => cambios[k])]);
}

async function empleadoDeEmpresa(q, ctx, id, bloquear = false) {
  const e = (await q.query(`select * from rrhh.empleados where id = $1 and empresa_id = $2${bloquear ? ' for update' : ''}`, [id, ctx.empresa.id])).rows[0];
  if (!e) throw noEncontrado('Empleado no encontrado');
  return e;
}

async function historial(q, ctx, e, tipo, descripcion, anterior = null, nuevo = null, fecha = null) {
  await q.query(
    `insert into rrhh.historial (empleado_id, empresa_id, fecha, tipo, descripcion, anterior, nuevo, registrado_por)
     values ($1,$2,coalesce($3::date, (now() at time zone 'America/Tegucigalpa')::date),$4,$5,$6::jsonb,$7::jsonb,$8)`,
    [e.id ?? e, ctx.empresa.id, fecha, tipo, descripcion, anterior ? JSON.stringify(anterior) : null, nuevo ? JSON.stringify(nuevo) : null, ctx.usuario.id]);
}

/** El jefe debe ser de la misma empresa, no uno mismo, y no formar un ciclo. */
async function validarJefe(q, ctx, empleadoId, jefeId) {
  if (!jefeId) return;
  if (jefeId === empleadoId) throw malaPeticion('Un empleado no puede ser su propio jefe');
  let actual = jefeId;
  for (let i = 0; i < 12 && actual; i++) {
    const r = (await q.query('select id, jefe_id, empresa_id from rrhh.empleados where id = $1', [actual])).rows[0];
    if (!r) throw malaPeticion('El jefe directo no existe');
    if (i === 0 && r.empresa_id !== ctx.empresa.id) throw malaPeticion('El jefe directo debe ser de la misma empresa');
    if (r.jefe_id === empleadoId) throw malaPeticion('Ese jefe depende de este empleado (ciclo)');
    actual = r.jefe_id;
  }
}

const nombreDe = (p) => `${p.nombres} ${p.apellidos}`.trim();

export function montarPerfil(r, { db }) {
  // ── Lista de la empresa (misma ficha resumida que usa el directorio) ───────
  r.get('/empleados', requierePermiso('rrhh:ver'), async (req, res) => {
    const f = validar(z.object({
      estado: z.enum(ESTADOS).optional(), sucursal_id: uuid.optional(), q: z.string().trim().max(80).optional(), cargo: z.string().trim().max(80).optional(),
    }), req.query);
    const sensible = req.ctx.permisos.has('rrhh:sensible');
    const { rows } = await db.query(
      `select e.id, e.persona_id, e.codigo, p.nombres, p.apellidos, p.identidad, p.telefono, p.telefono2, p.whatsapp, p.correo, p.fecha_nacimiento, p.direccion,
              e.puesto, e.departamento, e.sucursal_id, s.nombre as sucursal, e.fecha_ingreso, e.fecha_salida, e.estado, e.usuario_id,
              e.tipo_contrato, e.fecha_fin_contrato, e.fecha_fin_prueba, e.jefe_id, jp.nombres || ' ' || jp.apellidos as jefe,
              case when $4 then e.salario_mensual end as salario_mensual,
              exists (select 1 from rrhh.vacaciones v where v.empleado_id = e.id and v.estado in ('aprobada','tomada')
                        and (now() at time zone 'America/Tegucigalpa')::date between v.desde and v.hasta) as en_vacaciones,
              (select coalesce(json_agg(json_build_object('empresa', e2.codigo, 'puesto', x.puesto)), '[]'::json) from rrhh.empleados x join core.empresas e2 on e2.id = x.empresa_id
                where x.persona_id = e.persona_id and x.estado <> 'baja' and x.id <> e.id) as otros_contratos
         from rrhh.empleados e join rrhh.personas p on p.id = e.persona_id left join core.sucursales s on s.id = e.sucursal_id
         left join rrhh.empleados j on j.id = e.jefe_id left join rrhh.personas jp on jp.id = j.persona_id
        where e.empresa_id = $1 and ($2::text is null or e.estado = $2) and ($3::uuid is null or e.sucursal_id = $3)
          and ($5::text is null or (p.nombres || ' ' || p.apellidos || ' ' || coalesce(e.puesto,'') || ' ' || coalesce(e.codigo,'') || ' ' || coalesce(p.telefono,'') || ' ' || coalesce(p.correo,'')) ilike '%' || $5 || '%')
          and ($6::text is null or e.puesto ilike '%' || $6 || '%')
        order by (e.estado = 'baja'), p.nombres, p.apellidos`,
      [req.ctx.empresa.id, f.estado ?? null, f.sucursal_id ?? null, sensible, f.q ?? null, f.cargo ?? null]);
    res.json(rows.map((x) => (sensible ? x : { ...x, identidad: mascaraIdentidad(x.identidad) })));
  });

  r.get('/empleados/:id/ficha', requierePermiso('rrhh:ver'), async (req, res) => {
    const ficha = await armarFicha(db, { empleadoId: validar(uuid, req.params.id), empresaId: req.ctx.empresa.id, permisos: permisosFicha(req.ctx) });
    if (!ficha) throw noEncontrado('Empleado no encontrado');
    res.json(ficha);
  });

  // ── Alta ───────────────────────────────────────────────────────────────────
  r.post('/empleados', requierePermiso('rrhh:editar'), async (req, res) => {
    const b = soloEnviados(validar(esqAlta, req.body));
    if (!req.ctx.permisos.has('rrhh:sensible') && SENSIBLES.some((k) => b[k] != null)) throw prohibido('Los datos sensibles (identidad, salario, cuenta bancaria) los registra solo el dueño o el administrador');
    const out = await db.tx(async (q) => {
      const suc = b.sucursal_id ? await resolverSucursal(q, req.ctx, b.sucursal_id) : null;
      // La persona es única en el grupo: si ya trabaja en otra empresa (misma identidad) se reutiliza su ficha
      // y solo se completan los datos personales que le faltaban.
      let persona = b.identidad ? (await q.query('select * from rrhh.personas where identidad = $1', [b.identidad])).rows[0] : null;
      let reutilizada = false;
      if (persona) {
        reutilizada = true;
        const faltantes = Object.fromEntries(CAMPOS_PERSONA.filter((k) => !['nombres', 'apellidos'].includes(k) && b[k] != null && (persona[k] == null || persona[k] === '')).map((k) => [k, b[k]]));
        await actualizar(q, 'rrhh.personas', persona.id, faltantes, CAMPOS_PERSONA);
      } else {
        const datos = { ...Object.fromEntries(CAMPOS_PERSONA.filter((k) => b[k] !== undefined).map((k) => [k, b[k]])), apellidos: b.apellidos ?? '' };
        const cols = Object.keys(datos);
        persona = (await q.query(`insert into rrhh.personas (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning *`, cols.map((k) => datos[k]))).rows[0];
      }
      if (b.jefe_id) await validarJefe(q, req.ctx, null, b.jefe_id);
      try {
        const hoy = fechaHN();
        const c = { tipo_contrato: 'indefinido', tipo_pago: 'mensual', ...Object.fromEntries(CAMPOS_CONTRATO.filter((k) => b[k] !== undefined).map((k) => [k, b[k]])) };
        c.fecha_ingreso = b.fecha_ingreso ?? hoy;
        c.sucursal_id = suc?.id ?? null;
        c.estado = 'activo'; delete c.fecha_salida; delete c.tipo_baja; delete c.motivo_estado; delete c.estado_desde;
        const cols = Object.keys(c);
        const e = (await q.query(
          `insert into rrhh.empleados (persona_id, empresa_id, ${cols.join(',')}) values ($1,$2,${cols.map((_, i) => `$${i + 3}`).join(',')}) returning *`,
          [persona.id, req.ctx.empresa.id, ...cols.map((k) => c[k])])).rows[0];
        for (const sid of b.sucursales_extra ?? []) {
          await resolverSucursal(q, req.ctx, sid);
          await q.query('insert into rrhh.empleado_sucursales (empleado_id, sucursal_id) values ($1,$2) on conflict do nothing', [e.id, sid]);
        }
        await historial(q, req.ctx, e, reutilizada ? 'reingreso' : 'ingreso', `Ingreso como ${e.puesto}${suc ? ` en ${suc.nombre}` : ''}`, null, { puesto: e.puesto, sucursal: suc?.nombre ?? null }, e.fecha_ingreso);
        if (e.salario_mensual != null || e.salario_hora != null) {
          await q.query(`insert into rrhh.salarios_historial (empleado_id, salario_anterior, salario_nuevo, tipo_pago, motivo, vigente_desde, registrado_por)
                         values ($1,null,$2,$3,'Salario de ingreso',$4,$5)`, [e.id, e.salario_mensual ?? e.salario_hora, e.tipo_pago, e.fecha_ingreso, req.ctx.usuario.id]);
        }
        await auditar(q, req.ctx, 'empleado_alta', 'empleado', e.id, { nombre: nombreDe(persona), puesto: e.puesto, persona_reutilizada: reutilizada || undefined }, { sucursalId: suc?.id });
        return { ...e, persona_reutilizada: reutilizada || undefined };
      } catch (err) {
        if (err.code === '23505') throw conflicto(String(err.message).includes('codigo') ? 'Ya hay un empleado con ese código en la empresa' : 'Esa persona ya tiene un contrato vigente en esta empresa');
        throw err;
      }
    });
    res.status(201).json(out);
  });

  // ── Edición ────────────────────────────────────────────────────────────────
  r.put('/empleados/:id', requierePermiso('rrhh:editar'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = soloEnviados(validar(esqEdicion, req.body));
    const sensibleOk = req.ctx.permisos.has('rrhh:sensible');
    const out = await db.tx(async (q) => {
      const e = await empleadoDeEmpresa(q, req.ctx, id, true);
      const p = (await q.query('select * from rrhh.personas where id = $1 for update', [e.persona_id])).rows[0];
      const cP = Object.fromEntries(CAMPOS_PERSONA.filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
      const cE = Object.fromEntries(CAMPOS_CONTRATO.filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));
      if (cP.nombres === null || cP.apellidos === null) { delete cP.nombres; if (cP.apellidos === null) cP.apellidos = ''; }
      if (cE.puesto === null) delete cE.puesto;
      for (const k of ['tipo_contrato', 'tipo_pago', 'estado']) if (cE[k] === null) delete cE[k];

      const dP = diferencias(p, cP), dE = diferencias(e, cE);
      if (!sensibleOk && [...Object.keys(dP), ...Object.keys(dE)].some((k) => SENSIBLES.includes(k))) throw prohibido('Cambiar identidad, salario o cuenta bancaria requiere permiso de datos sensibles');

      // Reglas de estado: baja y suspensión llevan motivo y fecha.
      const hoy = fechaHN();
      const nuevoEstado = cE.estado ?? e.estado;
      const cambiaEstado = cE.estado && cE.estado !== e.estado;
      if (cambiaEstado || (nuevoEstado === 'baja' || nuevoEstado === 'suspendido')) {
        if (cambiaEstado && (nuevoEstado === 'baja' || nuevoEstado === 'suspendido')) {
          if (!(cE.motivo_estado ?? e.motivo_estado)) throw malaPeticion(nuevoEstado === 'baja' ? 'Indica el motivo de la baja' : 'Indica el motivo de la suspensión');
          cE.estado_desde = cE.estado_desde ?? hoy;
          if (nuevoEstado === 'baja') {
            cE.tipo_baja = cE.tipo_baja ?? 'otro';
            cE.fecha_salida = cE.fecha_salida ?? cE.estado_desde;
          }
        }
        if (cambiaEstado && (nuevoEstado === 'activo' || nuevoEstado === 'vacaciones')) {
          cE.motivo_estado = null; cE.tipo_baja = null; cE.fecha_salida = null; cE.estado_desde = cE.estado_desde ?? hoy;
        }
      }
      const ing = cE.fecha_ingreso ?? e.fecha_ingreso, sal = cE.fecha_salida ?? e.fecha_salida;
      if (ing && sal && sal < ing) throw malaPeticion('La fecha de salida es anterior a la de ingreso');
      const ci = cE.fecha_inicio_contrato ?? e.fecha_inicio_contrato, cf = cE.fecha_fin_contrato ?? e.fecha_fin_contrato;
      if (ci && cf && cf < ci) throw malaPeticion('El contrato termina antes de empezar');

      let suc = null;
      if (cE.sucursal_id) suc = await resolverSucursal(q, req.ctx, cE.sucursal_id);
      if (cE.jefe_id) await validarJefe(q, req.ctx, id, cE.jefe_id);
      try {
        await actualizar(q, 'rrhh.personas', p.id, cP, CAMPOS_PERSONA);
        await actualizar(q, 'rrhh.empleados', id, cE, CAMPOS_CONTRATO);
      } catch (err) {
        if (err.code === '23505') throw conflicto(String(err.message).includes('identidad') ? 'Esa identidad ya pertenece a otra persona' : 'Ya existe un empleado con esos datos (código o contrato vigente)');
        throw err;
      }
      if (b.sucursales_extra) {
        await q.query('delete from rrhh.empleado_sucursales where empleado_id = $1', [id]);
        for (const sid of b.sucursales_extra) { await resolverSucursal(q, req.ctx, sid); await q.query('insert into rrhh.empleado_sucursales (empleado_id, sucursal_id) values ($1,$2) on conflict do nothing', [id, sid]); }
      }

      // Historial laboral y de salario
      if (dE.puesto || dE.departamento) await historial(q, req.ctx, id, 'cambio_puesto', `Cambio de puesto: ${e.puesto}${e.departamento ? ` (${e.departamento})` : ''} → ${cE.puesto ?? e.puesto}${(cE.departamento ?? e.departamento) ? ` (${cE.departamento ?? e.departamento})` : ''}`, { puesto: e.puesto, departamento: e.departamento }, { puesto: cE.puesto ?? e.puesto, departamento: cE.departamento ?? e.departamento });
      if (dE.sucursal_id) {
        const antes = e.sucursal_id ? (await q.query('select nombre from core.sucursales where id = $1', [e.sucursal_id])).rows[0]?.nombre : null;
        await historial(q, req.ctx, id, 'cambio_sucursal', `Cambio de sucursal: ${antes ?? 'sin sucursal'} → ${suc?.nombre ?? 'sin sucursal'}`, { sucursal: antes }, { sucursal: suc?.nombre ?? null });
      }
      if (dE.tipo_contrato || dE.fecha_fin_contrato || dE.fecha_inicio_contrato || dE.fecha_fin_prueba) {
        await historial(q, req.ctx, id, 'cambio_contrato', `Contrato: ${cE.tipo_contrato ?? e.tipo_contrato}${(cE.fecha_fin_contrato ?? e.fecha_fin_contrato) ? ` hasta ${cE.fecha_fin_contrato ?? e.fecha_fin_contrato}` : ' (sin vencimiento)'}`, { tipo_contrato: e.tipo_contrato, fin: e.fecha_fin_contrato }, { tipo_contrato: cE.tipo_contrato ?? e.tipo_contrato, fin: cE.fecha_fin_contrato ?? e.fecha_fin_contrato });
      }
      if (dE.salario_mensual || dE.salario_hora || dE.tipo_pago) {
        const nuevo = cE.salario_mensual ?? cE.salario_hora ?? e.salario_mensual ?? e.salario_hora;
        await q.query(`insert into rrhh.salarios_historial (empleado_id, salario_anterior, salario_nuevo, tipo_pago, motivo, vigente_desde, registrado_por)
                       values ($1,$2,$3,$4,$5,coalesce($6::date,(now() at time zone 'America/Tegucigalpa')::date),$7)`,
          [id, dE.salario_hora && !dE.salario_mensual ? e.salario_hora : e.salario_mensual, nuevo, cE.tipo_pago ?? e.tipo_pago, b.motivo_salario ?? null, b.salario_desde ?? null, req.ctx.usuario.id]);
        await historial(q, req.ctx, id, 'cambio_salario', 'Cambio de salario (ver historial salarial)', null, null, b.salario_desde ?? null);
      }
      if (cambiaEstado) {
        const tipo = nuevoEstado === 'baja' ? 'baja' : nuevoEstado === 'suspendido' ? 'suspension' : e.estado === 'baja' ? 'reingreso' : e.estado === 'suspendido' ? 'reactivacion' : 'cambio_estado';
        await historial(q, req.ctx, id, tipo, `Estado: ${e.estado} → ${nuevoEstado}${cE.motivo_estado ? ` · ${cE.motivo_estado}` : ''}${cE.tipo_baja ? ` (${cE.tipo_baja})` : ''}`, { estado: e.estado }, { estado: nuevoEstado, motivo: cE.motivo_estado ?? null, tipo_baja: cE.tipo_baja ?? null }, cE.estado_desde ?? null);
      }

      const dif = diferenciasBitacora({ ...dP, ...dE });
      if (b.sucursales_extra) dif.sucursales_extra = { antes: null, despues: b.sucursales_extra.length };
      if (Object.keys(dif).length) {
        await auditar(q, req.ctx, nuevoEstado === 'baja' && cambiaEstado ? 'empleado_baja' : 'empleado_editado', 'empleado', id, { nombre: nombreDe({ ...p, ...cP }), cambios: dif }, { sucursalId: suc?.id ?? e.sucursal_id });
      }
      return { ok: true, cambios: Object.keys(dif) };
    });
    res.json(out);
  });

  // ── Vacaciones ─────────────────────────────────────────────────────────────
  async function cuadroVacaciones(q, empleado, excluirId = null) {
    const { rows } = await q.query('select id, dias, estado from rrhh.vacaciones where empleado_id = $1', [empleado.id]);
    return calcularVacaciones({ ingreso: empleado.fecha_ingreso, hoy: fechaHN(), tomadas: rows.filter((v) => v.id !== excluirId) });
  }
  function exigirSaldo(cuadro, dias, forzar) {
    if (forzar) return;
    if (cuadro.sin_fecha_ingreso) throw new ErrorHttp(409, 'Este empleado no tiene fecha de ingreso: no se puede calcular su saldo. Complétala en su ficha o confirma para registrar igual.', 'sin_fecha_ingreso');
    if (dias > cuadro.pendientes) throw new ErrorHttp(409, `Solo tiene ${cuadro.pendientes} día(s) de vacaciones pendientes y esto usa ${dias}. Confirma para registrarlo como adelanto.`, 'saldo_insuficiente');
  }

  r.get('/vacaciones', requierePermiso('rrhh:ver'), async (req, res) => {
    const f = validar(z.object({ empleado_id: uuid.optional(), estado: z.string().optional() }), req.query);
    const { rows } = await db.query(
      `select v.id, v.empleado_id, p.nombres, p.apellidos, v.desde, v.hasta, v.estado, v.nota, coalesce(v.dias, v.hasta - v.desde + 1) as dias, v.motivo_rechazo
         from rrhh.vacaciones v join rrhh.empleados e on e.id = v.empleado_id join rrhh.personas p on p.id = e.persona_id
        where e.empresa_id = $1 and ($2::uuid is null or v.empleado_id = $2) and ($3::text is null or v.estado = $3) order by v.desde desc limit 300`,
      [req.ctx.empresa.id, f.empleado_id ?? null, f.estado ?? null]);
    res.json(rows);
  });
  r.post('/vacaciones', requierePermiso('rrhh:editar'), async (req, res) => {
    const b = validar(z.object({
      empleado_id: uuid, desde: fechaISO, hasta: fechaISO, nota: txt(200), estado: z.enum(['solicitada', 'aprobada', 'tomada']).default('solicitada'),
      dias: z.coerce.number().int().min(1).max(60).optional(), contar: z.enum(['habiles', 'corridos']).default('habiles'), forzar: z.boolean().default(false),
    }), req.body);
    if (b.hasta < b.desde) throw malaPeticion('La fecha final es anterior a la inicial');
    const out = await db.tx(async (q) => {
      const e = await empleadoDeEmpresa(q, req.ctx, b.empleado_id, true);
      if (e.estado === 'baja') throw malaPeticion('Ese empleado está dado de baja');
      const dias = b.dias ?? contarDias(b.desde, b.hasta, b.contar);
      if (dias < 1) throw malaPeticion('Ese rango no tiene días hábiles');
      const choque = (await q.query(`select 1 from rrhh.vacaciones where empleado_id = $1 and estado in ('solicitada','aprobada','tomada') and desde <= $3::date and hasta >= $2::date`, [e.id, b.desde, b.hasta])).rowCount;
      if (choque) throw conflicto('Ya tiene vacaciones registradas que se cruzan con esas fechas');
      exigirSaldo(await cuadroVacaciones(q, e), dias, b.forzar);
      const resuelta = b.estado !== 'solicitada';
      const v = (await q.query(
        `insert into rrhh.vacaciones (empleado_id, desde, hasta, dias, estado, nota, registrada_por, resuelta_por, resuelta_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,case when $9 then now() end) returning *`,
        [e.id, b.desde, b.hasta, dias, b.estado, b.nota, req.ctx.usuario.id, resuelta ? req.ctx.usuario.id : null, resuelta])).rows[0];
      await auditar(q, req.ctx, 'vacaciones_registradas', 'vacaciones', v.id, { empleado_id: e.id, desde: b.desde, hasta: b.hasta, dias, estado: b.estado, adelanto: b.forzar || undefined });
      return { ...v, saldo: await cuadroVacaciones(q, e) };
    });
    res.status(201).json(out);
  });
  r.put('/vacaciones/:id', requierePermiso('rrhh:editar'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(z.object({ estado: z.enum(['aprobada', 'rechazada', 'tomada', 'cancelada']), motivo_rechazo: txt(200), forzar: z.boolean().default(false) }), req.body);
    await db.tx(async (q) => {
      const v = (await q.query(`select v.* from rrhh.vacaciones v join rrhh.empleados e on e.id = v.empleado_id where v.id = $1 and e.empresa_id = $2 for update of v`, [id, req.ctx.empresa.id])).rows[0];
      if (!v) throw noEncontrado();
      if (b.estado === 'rechazada' && !b.motivo_rechazo) throw malaPeticion('Escribe el motivo del rechazo');
      if ((b.estado === 'aprobada' || b.estado === 'tomada') && v.estado !== 'aprobada' && v.estado !== 'tomada') {
        const e = (await q.query('select * from rrhh.empleados where id = $1', [v.empleado_id])).rows[0];
        exigirSaldo(await cuadroVacaciones(q, e, v.id), v.dias ?? (v.hasta - v.desde + 1), b.forzar);
      }
      await q.query(`update rrhh.vacaciones set estado = $2, resuelta_por = $3, resuelta_at = now(), motivo_rechazo = $4 where id = $1`, [id, b.estado, req.ctx.usuario.id, b.estado === 'rechazada' ? b.motivo_rechazo : null]);
      await auditar(q, req.ctx, `vacaciones_${b.estado}`, 'vacaciones', id, { empleado_id: v.empleado_id, antes: { estado: v.estado }, despues: { estado: b.estado }, motivo: b.motivo_rechazo ?? undefined });
    });
    res.json({ ok: true });
  });
  r.delete('/vacaciones/:id', requierePermiso('rrhh:editar'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    await db.tx(async (q) => {
      const v = (await q.query(`select v.* from rrhh.vacaciones v join rrhh.empleados e on e.id = v.empleado_id where v.id = $1 and e.empresa_id = $2 for update of v`, [id, req.ctx.empresa.id])).rows[0];
      if (!v) throw noEncontrado();
      await q.query('delete from rrhh.vacaciones where id = $1', [id]);
      await auditar(q, req.ctx, 'vacaciones_eliminadas', 'vacaciones', id, { empleado_id: v.empleado_id, antes: { desde: v.desde, hasta: v.hasta, dias: v.dias, estado: v.estado } });
    });
    res.json({ ok: true });
  });

  // ── Ausencias, permisos, días libres, incapacidades, llegadas tarde ───────
  const TIPOS_AUS = ['ausencia', 'permiso', 'dia_libre', 'incapacidad', 'tardanza', 'licencia'];
  const esqAus = z.object({
    tipo: z.enum(TIPOS_AUS), subtipo: txt(60), desde: fechaISO, hasta: fechaN, dias: numN(366), minutos: z.preprocess((v) => (v === '' ? null : v), z.coerce.number().int().min(0).max(1440).nullish()),
    motivo: txt(300), pagado: z.boolean().optional(), estado: z.enum(['pendiente', 'aprobada', 'rechazada']).optional(), documento_id: z.preprocess((v) => (v === '' ? null : v), uuid.nullish()),
  });
  const COLS_AUS = ['tipo', 'subtipo', 'desde', 'hasta', 'dias', 'minutos', 'motivo', 'pagado', 'estado', 'documento_id'];

  r.get('/ausencias', requierePermiso('rrhh:ver'), async (req, res) => {
    const f = validar(z.object({ desde: fechaISO.optional(), hasta: fechaISO.optional(), tipo: z.enum(TIPOS_AUS).optional(), empleado_id: uuid.optional(), estado: z.enum(['pendiente', 'aprobada', 'rechazada']).optional() }), req.query);
    const hoy = fechaHN();
    const { rows } = await db.query(
      `select a.*, p.nombres, p.apellidos, e.puesto, s.nombre as sucursal from rrhh.ausencias a join rrhh.empleados e on e.id = a.empleado_id join rrhh.personas p on p.id = e.persona_id
         left join core.sucursales s on s.id = e.sucursal_id
        where a.empresa_id = $1 and a.hasta >= coalesce($2::date, $5::date - 60) and a.desde <= coalesce($3::date, $5::date + 60)
          and ($4::text is null or a.tipo = $4) and ($6::uuid is null or a.empleado_id = $6) and ($7::text is null or a.estado = $7)
        order by a.desde desc, a.created_at desc limit 500`,
      [req.ctx.empresa.id, f.desde ?? null, f.hasta ?? null, f.tipo ?? null, hoy, f.empleado_id ?? null, f.estado ?? null]);
    res.json(rows);
  });
  r.post('/empleados/:id/ausencias', requierePermiso('rrhh:editar'), async (req, res) => {
    const b = soloEnviados(validar(esqAus, req.body));
    const out = await db.tx(async (q) => {
      const e = await empleadoDeEmpresa(q, req.ctx, validar(uuid, req.params.id));
      const hasta = b.hasta ?? b.desde;
      if (hasta < b.desde) throw malaPeticion('La fecha final es anterior a la inicial');
      const tard = b.tipo === 'tardanza';
      if (tard && !(b.minutos > 0)) throw malaPeticion('Indica cuántos minutos llegó tarde');
      const dias = tard ? 0 : (b.dias ?? contarDias(b.desde, hasta, b.tipo === 'incapacidad' ? 'corridos' : 'habiles'));
      const estado = b.estado ?? 'aprobada';
      const pagado = b.pagado ?? !(b.tipo === 'ausencia');
      const a = (await q.query(
        `insert into rrhh.ausencias (empleado_id, empresa_id, tipo, subtipo, desde, hasta, dias, minutos, motivo, pagado, estado, aprobado_por, aprobado_at, documento_id, registrada_por)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,case when $12::uuid is not null then now() end,$13,$14) returning *`,
        [e.id, req.ctx.empresa.id, b.tipo, b.subtipo ?? null, b.desde, hasta, dias, tard ? b.minutos : null, b.motivo ?? null, pagado, estado, estado === 'pendiente' ? null : req.ctx.usuario.id, b.documento_id ?? null, req.ctx.usuario.id])).rows[0];
      await auditar(q, req.ctx, 'ausencia_registrada', 'empleado', e.id, { ausencia_id: a.id, tipo: a.tipo, desde: a.desde, hasta: a.hasta, dias: a.dias, pagado: a.pagado, estado: a.estado });
      return a;
    });
    res.status(201).json(out);
  });
  r.put('/ausencias/:id', requierePermiso('rrhh:editar'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = soloEnviados(validar(esqAus.partial(), req.body));
    await db.tx(async (q) => {
      const a = (await q.query('select * from rrhh.ausencias where id = $1 and empresa_id = $2 for update', [id, req.ctx.empresa.id])).rows[0];
      if (!a) throw noEncontrado();
      const c = Object.fromEntries(COLS_AUS.filter((k) => b[k] !== undefined && b[k] !== null || (b[k] === null && ['subtipo', 'motivo', 'documento_id', 'minutos'].includes(k))).map((k) => [k, b[k]]));
      const desde = c.desde ?? a.desde, hasta = c.hasta ?? a.hasta;
      if (hasta < desde) throw malaPeticion('La fecha final es anterior a la inicial');
      if ((c.desde || c.hasta) && c.dias === undefined && (c.tipo ?? a.tipo) !== 'tardanza') c.dias = contarDias(desde, hasta, (c.tipo ?? a.tipo) === 'incapacidad' ? 'corridos' : 'habiles');
      const dif = diferencias(a, c);
      if (!Object.keys(dif).length) return;
      const claves = Object.keys(c);
      const extra = c.estado && c.estado !== a.estado && c.estado !== 'pendiente' ? ', aprobado_por = $' + (claves.length + 2) + ', aprobado_at = now()' : '';
      await q.query(`update rrhh.ausencias set ${claves.map((k, i) => `${k} = $${i + 2}`).join(', ')}${extra} where id = $1`, [id, ...claves.map((k) => c[k]), ...(extra ? [req.ctx.usuario.id] : [])]);
      await auditar(q, req.ctx, 'ausencia_editada', 'empleado', a.empleado_id, { ausencia_id: id, cambios: diferenciasBitacora(dif) });
    });
    res.json({ ok: true });
  });
  r.delete('/ausencias/:id', requierePermiso('rrhh:editar'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    await db.tx(async (q) => {
      const a = (await q.query('delete from rrhh.ausencias where id = $1 and empresa_id = $2 returning *', [id, req.ctx.empresa.id])).rows[0];
      if (!a) throw noEncontrado();
      await auditar(q, req.ctx, 'ausencia_eliminada', 'empleado', a.empleado_id, { ausencia_id: id, antes: { tipo: a.tipo, desde: a.desde, hasta: a.hasta, dias: a.dias } });
    });
    res.json({ ok: true });
  });

  // ── Amonestaciones, evaluaciones y capacitaciones (CRUD simple por empleado) ─
  const docId = z.preprocess((v) => (v === '' ? null : v), uuid.nullish());
  const hijos = [
    { ruta: 'sanciones', tabla: 'rrhh.sanciones', etiqueta: 'sancion', usuarioCol: 'emitida_por',
      esquema: z.object({ tipo: z.enum(['verbal', 'escrita', 'suspension', 'otra']), fecha: fechaN, motivo: z.string().trim().min(3, 'Escribe el motivo').max(300), descripcion: txt(1500),
        dias_suspension: z.preprocess((v) => (v === '' ? null : v), z.coerce.number().int().min(1).max(60).nullish()), con_goce: z.boolean().nullish(), estado: z.enum(['vigente', 'anulada']).optional(), documento_id: docId }),
      cols: ['tipo', 'fecha', 'motivo', 'descripcion', 'dias_suspension', 'con_goce', 'estado', 'documento_id'], requeridos: ['tipo', 'motivo'] },
    { ruta: 'evaluaciones', tabla: 'rrhh.evaluaciones', etiqueta: 'evaluacion', usuarioCol: 'evaluador_id',
      esquema: z.object({ fecha: fechaN, periodo: txt(60), puntaje: numN(100), fortalezas: txt(1000), areas_mejora: txt(1000), comentarios: txt(1500), documento_id: docId }),
      cols: ['fecha', 'periodo', 'puntaje', 'fortalezas', 'areas_mejora', 'comentarios', 'documento_id'], requeridos: [] },
    { ruta: 'capacitaciones', tabla: 'rrhh.capacitaciones', etiqueta: 'capacitacion', usuarioCol: null,
      esquema: z.object({ nombre: z.string().trim().min(2, 'Escribe el nombre de la capacitación').max(150), institucion: txt(120), fecha: fechaN, horas: numN(2000), estado: z.enum(['programada', 'completada', 'cancelada']).optional(), vence: fechaN, resultado: txt(200), documento_id: docId }),
      cols: ['nombre', 'institucion', 'fecha', 'horas', 'estado', 'vence', 'resultado', 'documento_id'], requeridos: ['nombre'] },
  ];
  for (const h of hijos) {
    r.post(`/empleados/:id/${h.ruta}`, requierePermiso('rrhh:editar'), async (req, res) => {
      const b = soloEnviados(validar(h.esquema, req.body));
      const out = await db.tx(async (q) => {
        const e = await empleadoDeEmpresa(q, req.ctx, validar(uuid, req.params.id));
        const cols = h.cols.filter((k) => b[k] !== undefined && b[k] !== null);
        const fila = (await q.query(
          `insert into ${h.tabla} (empleado_id, empresa_id, ${cols.join(',')}${h.usuarioCol ? `, ${h.usuarioCol}` : ''}) values ($1,$2,${cols.map((_, i) => `$${i + 3}`).join(',')}${h.usuarioCol ? `, $${cols.length + 3}` : ''}) returning *`,
          [e.id, req.ctx.empresa.id, ...cols.map((k) => b[k]), ...(h.usuarioCol ? [req.ctx.usuario.id] : [])])).rows[0];
        await auditar(q, req.ctx, `${h.etiqueta}_registrada`, 'empleado', e.id, { id: fila.id, ...Object.fromEntries(cols.map((k) => [k, b[k]]).filter(([k]) => k !== 'descripcion')) });
        return fila;
      });
      res.status(201).json(out);
    });
    r.put(`/${h.ruta}/:id`, requierePermiso('rrhh:editar'), async (req, res) => {
      const id = validar(uuid, req.params.id);
      const b = soloEnviados(validar(h.esquema.partial(), req.body));
      await db.tx(async (q) => {
        const f = (await q.query(`select * from ${h.tabla} where id = $1 and empresa_id = $2 for update`, [id, req.ctx.empresa.id])).rows[0];
        if (!f) throw noEncontrado();
        const c = Object.fromEntries(h.cols.filter((k) => b[k] !== undefined && !(b[k] === null && h.requeridos.includes(k))).map((k) => [k, b[k]]));
        const dif = diferencias(f, c);
        if (!Object.keys(dif).length) return;
        await actualizar(q, h.tabla, id, c, h.cols);
        await auditar(q, req.ctx, `${h.etiqueta}_editada`, 'empleado', f.empleado_id, { id, cambios: diferenciasBitacora(dif) });
      });
      res.json({ ok: true });
    });
    r.delete(`/${h.ruta}/:id`, requierePermiso('rrhh:editar'), async (req, res) => {
      const id = validar(uuid, req.params.id);
      await db.tx(async (q) => {
        const f = (await q.query(`delete from ${h.tabla} where id = $1 and empresa_id = $2 returning *`, [id, req.ctx.empresa.id])).rows[0];
        if (!f) throw noEncontrado();
        await auditar(q, req.ctx, `${h.etiqueta}_eliminada`, 'empleado', f.empleado_id, { id, antes: Object.fromEntries(h.cols.filter((k) => k !== 'descripcion').map((k) => [k, f[k]])) });
      });
      res.json({ ok: true });
    });
  }

  // ── Horarios semanales (turno / libre / cubre otra tienda / vacaciones) ───
  const esqHora = z.string().regex(/^\d{2}:\d{2}$/, 'Hora inválida (HH:MM)');
  r.get('/empleados/:id/horarios', requierePermiso('rrhh:ver'), async (req, res) => {
    const { rows } = await db.query(
      `select h.dia_semana, h.estado, h.entrada::text, h.salida::text, h.sucursal_id from rrhh.horarios h join rrhh.empleados e on e.id = h.empleado_id
        where h.empleado_id = $1 and e.empresa_id = $2 order by h.dia_semana`, [validar(uuid, req.params.id), req.ctx.empresa.id]);
    res.json(rows);
  });
  r.get('/horarios', requierePermiso('rrhh:ver'), async (req, res) => {
    const { rows } = await db.query(
      `select e.id as empleado_id, p.nombres, p.apellidos, e.puesto, e.sucursal_id, s.nombre as sucursal,
              (select coalesce(json_agg(json_build_object('dia_semana', h.dia_semana, 'estado', h.estado, 'entrada', h.entrada::text, 'salida', h.salida::text, 'sucursal_id', h.sucursal_id) order by h.dia_semana), '[]'::json)
                 from rrhh.horarios h where h.empleado_id = e.id) as horarios
         from rrhh.empleados e join rrhh.personas p on p.id = e.persona_id left join core.sucursales s on s.id = e.sucursal_id
        where e.empresa_id = $1 and e.estado <> 'baja' order by s.nombre nulls last, p.nombres`, [req.ctx.empresa.id]);
    res.json(rows);
  });
  r.put('/empleados/:id/horarios', requierePermiso('rrhh:editar'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(z.object({ horarios: z.array(z.object({
      dia_semana: z.coerce.number().int().min(0).max(6), estado: z.enum(['turno', 'libre', 'otra_tienda', 'vacaciones']).default('turno'),
      entrada: esqHora.nullish(), salida: esqHora.nullish(), sucursal_id: z.preprocess((v) => (v === '' ? null : v), uuid.nullish()),
    })).max(7) }), req.body);
    const vistos = new Set();
    for (const h of b.horarios) {
      if (vistos.has(h.dia_semana)) throw malaPeticion('Un día está repetido en el horario');
      vistos.add(h.dia_semana);
      if (h.estado === 'turno' && (!h.entrada || !h.salida)) throw malaPeticion('Falta la hora de entrada o de salida en un día con turno');
    }
    await db.tx(async (q) => {
      await empleadoDeEmpresa(q, req.ctx, id, true);
      await q.query('delete from rrhh.horarios where empleado_id = $1', [id]);
      for (const h of b.horarios) {
        if (h.sucursal_id) await resolverSucursal(q, req.ctx, h.sucursal_id);
        await q.query('insert into rrhh.horarios (empleado_id,dia_semana,estado,entrada,salida,sucursal_id) values ($1,$2,$3,$4,$5,$6)',
          [id, h.dia_semana, h.estado, h.estado === 'turno' ? h.entrada : null, h.estado === 'turno' ? h.salida : null, h.sucursal_id ?? null]);
      }
      await auditar(q, req.ctx, 'horario_editado', 'empleado', id, { dias: b.horarios.length });
    });
    res.json({ ok: true });
  });
}

