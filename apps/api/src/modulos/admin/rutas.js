import { Router } from 'express';
import { z } from 'zod';
import { ROLES, PERMISOS, ROLES_CON_PIN, MODULOS } from '@grupo/shared';
import { hashSecreto } from '../../auth/passwords.js';
import { hashPin, PIN_RE } from '../../auth/pin.js';
import { problemaClave, problemaPin } from '../../auth/politica.js';
import { revocarSesiones } from '../auth/sesiones.js';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { conflicto, fechaISO, malaPeticion, noEncontrado, prohibido, uuid, validar } from '../../lib/http.js';
import { estadoPunto } from '../pos/fiscal.js';

const ROLES_DIRECCION = ['dueno', 'admin'];   // solo estos exigen correo + contraseña; los demás entran con usuario y contraseña (o PIN)
const ROLES_ALTOS = ['dueno', 'admin'];                                   // solo un dueño los asigna
const rolEnum = z.enum(Object.keys(ROLES));
// Misma paleta que Italo Facturación: cada sucursal de una empresa lleva un color propio y no se repite.
export const PALETA_SUCURSALES = ['#c5603c', '#2e9e8f', '#b08d28', '#6c7fd6', '#d2567a', '#3d9fd6', '#7fa83e', '#a47bd6'];
const cambiosDe = (antes, despues, campos) => Object.fromEntries(
  campos.filter((k) => despues[k] !== undefined && String(antes[k] ?? '') !== String(despues[k] ?? '')).map((k) => [k, { antes: antes[k] ?? null, despues: despues[k] ?? null }]));
const permisoEnum = z.string().refine((p) => p in PERMISOS, 'permiso desconocido');

export function rutasAdmin({ db, config, ctxMgr }) {
  const r = Router();

  // ── Catálogo de roles y permisos (para armar pantallas) ──────────────────
  r.get('/roles', (req, res) => {
    res.json({
      roles: Object.entries(ROLES).map(([id, v]) => ({ id, nombre: v.nombre, permisos: v.permisos, con_pin: ROLES_CON_PIN.includes(id) })),
      permisos: Object.entries(PERMISOS).map(([id, nombre]) => ({ id, nombre })),
    });
  });

  // ── Usuarios de la empresa activa ────────────────────────────────────────
  r.get('/usuarios', requierePermiso('admin:usuarios'), async (req, res) => {
    const { rows } = await db.query(
      `select u.id, u.nombre, u.email, u.usuario, u.es_dueno_grupo, u.activo as usuario_activo, u.ultimo_acceso,
              a.rol, a.sucursal_ids, a.permisos_extra, a.permisos_quitados, a.activo, (a.pin_hash is not null) as tiene_pin,
              coalesce((select array_agg(e2.codigo order by e2.orden) from core.accesos a2
                         join core.empresas e2 on e2.id = a2.empresa_id
                        where a2.usuario_id = u.id and a2.activo and a2.empresa_id <> a.empresa_id), '{}') as otras_empresas
         from core.accesos a join core.usuarios u on u.id = a.usuario_id
        where a.empresa_id = $1
        order by a.activo desc, u.nombre`, [req.ctx.empresa.id]);
    res.json(rows);
  });

  const esquemaNuevo = z.object({
    nombre: z.string().trim().min(2).max(120),
    email: z.string().trim().toLowerCase().email().optional().or(z.literal('').transform(() => undefined)),
    usuario: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,30}$/, 'El usuario lleva 3 a 30 letras, números, punto o guion').optional().or(z.literal('').transform(() => undefined)),
    password: z.string().min(8, 'La contraseña lleva mínimo 8 caracteres').max(200).optional(),
    rol: rolEnum,
    sucursal_ids: z.array(uuid).default([]),
    permisos_extra: z.array(permisoEnum).default([]),
    permisos_quitados: z.array(permisoEnum).default([]),
    pin: z.string().regex(PIN_RE, 'El PIN son 4 a 8 dígitos').optional(),
  });

  async function validarSucursales(q, empresaId, ids) {
    if (!ids.length) return;
    const { rows } = await q.query('select id from core.sucursales where empresa_id = $1 and id = any($2::uuid[])', [empresaId, ids]);
    if (rows.length !== new Set(ids).size) throw malaPeticion('Alguna sucursal no pertenece a esta empresa');
  }
  function validarRolAsignable(ctx, rol) {
    if (ROLES_ALTOS.includes(rol) && ctx.rol !== 'dueno') throw prohibido('Solo un dueño puede asignar los roles Dueño y Administrador');
  }
  // El acceso a Dirección (consolidado del grupo) lo concede solo un dueño: un administrador no puede darse ni dar `grupo:ver` a escondidas.
  function validarPermisosExtra(ctx, extra) {
    if ((extra ?? []).includes('grupo:ver') && ctx.rol !== 'dueno') throw prohibido('Solo un dueño puede dar acceso a la Dirección del Grupo');
  }
  /**
   * Una persona puede trabajar en varias empresas. Quien administra UNA empresa no puede tocar la clave ni el nombre de alguien
   * que es administrador general o dueño/administrador en otra empresa: sería tomar su cuenta (incluida la del dueño del grupo).
   */
  async function validarUsuarioNoProtegido(q, ctx, usuarioId) {
    if (ctx.usuario.es_dueno_grupo) return;
    const { rows } = await q.query(
      `select u.es_dueno_grupo, exists (select 1 from core.accesos a where a.usuario_id = u.id and a.empresa_id <> $2 and a.rol = any($3::text[])) as alto_en_otra
         from core.usuarios u where u.id = $1`, [usuarioId, ctx.empresa.id, ROLES_ALTOS]);
    if (rows[0]?.es_dueno_grupo || rows[0]?.alto_en_otra) throw prohibido('Esa persona tiene un cargo de dirección en otra empresa; su clave la cambia solo un dueño del grupo');
  }

  r.post('/usuarios', requierePermiso('admin:usuarios'), async (req, res) => {
    const b = validar(esquemaNuevo, req.body);
    validarRolAsignable(req.ctx, b.rol);
    validarPermisosExtra(req.ctx, b.permisos_extra);
    if (ROLES_DIRECCION.includes(b.rol) && (!b.email)) throw malaPeticion('Ese rol entra con correo y contraseña: falta el correo');
    if (b.pin && !ROLES_CON_PIN.includes(b.rol)) throw malaPeticion('Ese rol no puede entrar con PIN');
    if (!b.email && !b.usuario && !b.pin) throw malaPeticion('Indica un usuario (o correo) o un PIN para que pueda entrar');
    if (b.usuario && !b.password && !b.email) throw malaPeticion('Con usuario hace falta una contraseña inicial');
    if (b.password) { const m = problemaClave(b.password, { email: b.email, nombre: b.nombre }); if (m) throw malaPeticion(m); }
    if (b.pin) { const m = problemaPin(b.pin, await ctxMgr.politica.obtener()); if (m) throw malaPeticion(m); }
    const emp = req.ctx.empresa;
    const id = await db.tx(async (q) => {
      await validarSucursales(q, emp.id, b.sucursal_ids);
      let u = b.email ? (await q.query('select * from core.usuarios where email = $1', [b.email])).rows[0] : null;
      if (!u && b.usuario) {
        if ((await q.query('select 1 from core.usuarios where usuario = $1', [b.usuario])).rowCount) throw conflicto('Ese nombre de usuario ya existe; elige otro');
      }
      if (!u) {
        if (ROLES_DIRECCION.includes(b.rol) && !b.password) throw malaPeticion('Falta la contraseña inicial');
        u = (await q.query(
          `insert into core.usuarios (nombre, email, usuario, password_hash) values ($1,$2,$3,$4) returning *`,
          [b.nombre, b.email ?? null, b.usuario ?? null, b.password ? hashSecreto(b.password) : null])).rows[0];
      }
      // Si el correo ya existe (la persona trabaja en otra empresa) NO se toca su contraseña: entra con la que ya tiene.
      // Cambiarla desde aquí permitiría a cualquier administrador tomar la cuenta de otro usuario (incluido el dueño del grupo).
      try {
        await q.query(
          `insert into core.accesos (usuario_id, empresa_id, rol, sucursal_ids, permisos_extra, permisos_quitados, pin_hash, pin_cambiado_at)
           values ($1,$2,$3,$4::uuid[],$5::text[],$6::text[],$7, $8)`,
          [u.id, emp.id, b.rol, b.sucursal_ids, b.permisos_extra, b.permisos_quitados,
            b.pin ? hashPin(config, emp.id, b.pin) : null, b.pin ? new Date() : null]);
      } catch (e) {
        if (e.code === '23505' && /pin/.test(e.constraint ?? e.message ?? '')) throw conflicto('Ese PIN ya lo usa otra persona; elige otro');
        if (e.code === '23505') throw conflicto('Ese usuario ya tiene acceso a esta empresa');
        throw e;
      }
      await auditar(q, req.ctx, 'usuario_creado', 'usuario', u.id, { rol: b.rol, email: b.email ?? null });
      return u.id;
    });
    ctxMgr.invalidar();
    res.status(201).json({ id });
  });

  r.put('/usuarios/:id', requierePermiso('admin:usuarios'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(z.object({
      nombre: z.string().trim().min(2).max(120).optional(),
      rol: rolEnum.optional(),
      sucursal_ids: z.array(uuid).optional(),
      permisos_extra: z.array(permisoEnum).optional(),
      permisos_quitados: z.array(permisoEnum).optional(),
      activo: z.boolean().optional(),
    }), req.body);
    const emp = req.ctx.empresa;
    const esYo = id === req.ctx.usuario.id;
    if (esYo && (b.activo === false || (b.rol && b.rol !== req.ctx.rol))) throw prohibido('No puedes desactivarte ni cambiarte el rol a ti mismo');
    const actual = (await db.query('select a.*, u.es_dueno_grupo, u.nombre from core.accesos a join core.usuarios u on u.id = a.usuario_id where a.usuario_id = $1 and a.empresa_id = $2', [id, emp.id])).rows[0];
    if (!actual) throw noEncontrado('Ese usuario no tiene acceso a esta empresa');
    if (b.rol) validarRolAsignable(req.ctx, b.rol);
    if (ROLES_ALTOS.includes(actual.rol)) validarRolAsignable(req.ctx, actual.rol);
    validarPermisosExtra(req.ctx, (b.permisos_extra ?? []).filter((p) => !(actual.permisos_extra ?? []).includes(p)));
    if (b.nombre && b.nombre !== actual.nombre) await validarUsuarioNoProtegido(db, req.ctx, id);
    if (b.rol && b.rol !== actual.rol && !ROLES_CON_PIN.includes(b.rol) && actual.pin_hash) {
      await db.query('update core.accesos set pin_hash = null where id = $1', [actual.id]);
    }
    await db.tx(async (q) => {
      if (b.sucursal_ids) await validarSucursales(q, emp.id, b.sucursal_ids);
      if (b.nombre) await q.query('update core.usuarios set nombre = $1 where id = $2', [b.nombre, id]);
      await q.query(
        `update core.accesos set rol = coalesce($3, rol), sucursal_ids = coalesce($4::uuid[], sucursal_ids),
               permisos_extra = coalesce($5::text[], permisos_extra), permisos_quitados = coalesce($6::text[], permisos_quitados),
               activo = coalesce($7, activo)
          where usuario_id = $1 and empresa_id = $2`,
        [id, emp.id, b.rol ?? null, b.sucursal_ids ?? null, b.permisos_extra ?? null, b.permisos_quitados ?? null, b.activo ?? null]);
      const cambios = cambiosDe(
        { nombre: actual.nombre, rol: actual.rol, activo: actual.activo, sucursal_ids: (actual.sucursal_ids ?? []).join(','), permisos_extra: (actual.permisos_extra ?? []).join(','), permisos_quitados: (actual.permisos_quitados ?? []).join(',') },
        { ...b, sucursal_ids: b.sucursal_ids?.join(','), permisos_extra: b.permisos_extra?.join(','), permisos_quitados: b.permisos_quitados?.join(',') },
        ['nombre', 'rol', 'activo', 'sucursal_ids', 'permisos_extra', 'permisos_quitados']);
      await auditar(q, req.ctx, 'usuario_editado', 'usuario', id, { nombre: b.nombre ?? actual.nombre, cambios }, { sucursalId: null });
    });
    ctxMgr.invalidar();
    res.json({ ok: true });
  });

  r.post('/usuarios/:id/pin', requierePermiso('admin:usuarios'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const { pin } = validar(z.object({ pin: z.string().regex(PIN_RE, 'El PIN son 4 a 8 dígitos').nullable() }), req.body);
    const a = (await db.query('select id, rol from core.accesos where usuario_id = $1 and empresa_id = $2', [id, req.ctx.empresa.id])).rows[0];
    if (!a) throw noEncontrado();
    if (pin && !ROLES_CON_PIN.includes(a.rol)) throw malaPeticion('Ese rol no puede entrar con PIN');
    if (pin) { const m = problemaPin(pin, await ctxMgr.politica.obtener()); if (m) throw malaPeticion(m); }
    try {
      await db.query('update core.accesos set pin_hash = $1, pin_cambiado_at = now() where id = $2',
        [pin ? hashPin(config, req.ctx.empresa.id, pin) : null, a.id]);
    } catch (e) {
      if (e.code === '23505') throw conflicto('Ese PIN ya lo usa otra persona; elige otro');
      throw e;
    }
    await auditar(db, req.ctx, pin ? 'pin_asignado' : 'pin_quitado', 'usuario', id);
    ctxMgr.invalidar();
    res.json({ ok: true });
  });

  r.post('/usuarios/:id/password', requierePermiso('admin:usuarios'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const { password } = validar(z.object({ password: z.string().min(8, 'Mínimo 8 caracteres').max(200) }), req.body);
    const a = (await db.query('select a.rol, u.email, u.nombre from core.accesos a join core.usuarios u on u.id = a.usuario_id where a.usuario_id = $1 and a.empresa_id = $2', [id, req.ctx.empresa.id])).rows[0];
    if (!a) throw noEncontrado();
    if (ROLES_ALTOS.includes(a.rol)) validarRolAsignable(req.ctx, a.rol);
    await validarUsuarioNoProtegido(db, req.ctx, id);
    { const m = problemaClave(password, { email: a.email, nombre: a.nombre }); if (m) throw malaPeticion(m); }
    await db.query('update core.usuarios set password_hash = $1, token_version = token_version + 1 where id = $2 and auth_user_id is null', [hashSecreto(password), id]);
    await revocarSesiones(db, ctxMgr, id, { motivo: 'contraseña restablecida por un administrador' });
    await auditar(db, req.ctx, 'password_restablecida', 'usuario', id);
    ctxMgr.invalidar();
    res.json({ ok: true });
  });

  // ── Cerrar a distancia las sesiones de una persona / reiniciar su 2FA ─────
  r.post('/usuarios/:id/cerrar-sesiones', requierePermiso('admin:usuarios'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const a = (await db.query('select rol from core.accesos where usuario_id = $1 and empresa_id = $2', [id, req.ctx.empresa.id])).rows[0];
    if (!a) throw noEncontrado();
    if (ROLES_ALTOS.includes(a.rol)) validarRolAsignable(req.ctx, a.rol);
    await validarUsuarioNoProtegido(db, req.ctx, id);
    const n = await revocarSesiones(db, ctxMgr, id, { motivo: `cerradas por ${req.ctx.usuario.nombre}` });
    await auditar(db, req.ctx, 'sesiones_cerradas_por_admin', 'usuario', id, { cantidad: n });
    res.json({ ok: true, cerradas: n });
  });
  // Perdió el teléfono y los códigos de recuperación: quien lo administra le quita el 2FA para que lo configure de nuevo.
  r.post('/usuarios/:id/reiniciar-2fa', requierePermiso('admin:usuarios'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    if (id === req.ctx.usuario.id) throw prohibido('Tu propia verificación se gestiona en «Mi seguridad»');
    const a = (await db.query('select rol from core.accesos where usuario_id = $1 and empresa_id = $2', [id, req.ctx.empresa.id])).rows[0];
    if (!a) throw noEncontrado();
    if (ROLES_ALTOS.includes(a.rol)) validarRolAsignable(req.ctx, a.rol);
    await validarUsuarioNoProtegido(db, req.ctx, id);
    await db.tx(async (q) => {
      await q.query('delete from core.usuarios_mfa where usuario_id = $1', [id]);
      await q.query('delete from core.mfa_recuperacion where usuario_id = $1', [id]);
    });
    await revocarSesiones(db, ctxMgr, id, { motivo: 'verificación en dos pasos reiniciada' });
    await auditar(db, req.ctx, 'mfa_reiniciado_por_admin', 'usuario', id);
    ctxMgr.invalidar();
    res.json({ ok: true });
  });

  // ── Política de seguridad (2FA obligatoria para dirección, largo del PIN) ─
  r.get('/seguridad', requierePermiso('admin:usuarios'), async (req, res) => {
    const pol = (await db.query('select mfa_obligatoria_direccion, pin_largo_min, pin_largo_max, actualizado_at from core.seguridad_politica where id')).rows[0];
    const alcance = req.ctx.usuario.es_dueno_grupo;   // el dueño del grupo ve a toda la dirección; un administrador, la de su empresa
    const { rows } = await db.query(
      `select u.id, u.nombre, u.email, u.es_dueno_grupo, u.ultimo_acceso,
              coalesce((select string_agg(distinct a.rol, ', ') from core.accesos a where a.usuario_id = u.id and a.activo and a.rol in ('dueno','admin')), '') as roles,
              exists (select 1 from core.usuarios_mfa m where m.usuario_id = u.id and m.confirmado) as mfa_activo
         from core.usuarios u
        where u.activo and (u.es_dueno_grupo
              or exists (select 1 from core.accesos a where a.usuario_id = u.id and a.activo and a.rol in ('dueno','admin') and ($1::boolean or a.empresa_id = $2)))
        order by u.es_dueno_grupo desc, u.nombre`, [alcance, req.ctx.empresa.id]);
    res.json({ politica: pol, direccion: rows, puede_cambiar: req.ctx.usuario.es_dueno_grupo, yo_tengo_mfa: Boolean(req.ctx.usuario.mfa_activo) });
  });
  r.put('/seguridad', async (req, res) => {
    if (!req.ctx.usuario.es_dueno_grupo) throw prohibido('Solo el dueño del grupo cambia la política de seguridad');
    const b = validar(z.object({
      mfa_obligatoria_direccion: z.boolean().optional(),
      pin_largo_min: z.number().int().min(4).max(6).optional(),
      pin_largo_max: z.number().int().min(4).max(6).optional(),
    }), req.body);
    const ant = (await db.query('select * from core.seguridad_politica where id')).rows[0];
    const nueva = { ...ant, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
    if (nueva.pin_largo_max < nueva.pin_largo_min) throw malaPeticion('El largo máximo del PIN no puede ser menor que el mínimo');
    // Para no dejar al dueño fuera de su propio sistema: debe tener la verificación activa antes de exigirla a todos.
    if (b.mfa_obligatoria_direccion === true && !ant.mfa_obligatoria_direccion && !req.ctx.usuario.mfa_activo) {
      throw conflicto('Primero activa tu propia verificación en dos pasos (Mi seguridad); así no te quedas fuera cuando se vuelva obligatoria');
    }
    await db.query(
      `update core.seguridad_politica set mfa_obligatoria_direccion = $1, pin_largo_min = $2, pin_largo_max = $3, actualizado_at = now(), actualizado_por = $4 where id`,
      [nueva.mfa_obligatoria_direccion, nueva.pin_largo_min, nueva.pin_largo_max, req.ctx.usuario.id]);
    await auditar(db, req.ctx, 'politica_seguridad_editada', 'seguridad', null,
      { cambios: cambiosDe(ant, nueva, ['mfa_obligatoria_direccion', 'pin_largo_min', 'pin_largo_max']) });
    ctxMgr.politica.invalidar();
    res.json({ ok: true, politica: nueva });
  });

  // ── Sucursales ───────────────────────────────────────────────────────────
  // Incluye el estado fiscal de su punto de emisión (borrador / CAI activo / por vencer) para mostrarlo en la lista.
  r.get('/sucursales', requierePermiso('admin:empresa', 'pos:fiscal', 'admin:usuarios'), async (req, res) => {
    const { rows } = await db.query(
      `select s.*, pe.id as punto_emision_id, pe.es_borrador, pe.cai, pe.correlativo_desde, pe.correlativo_hasta, pe.correlativo_actual, pe.fecha_limite_emision,
              pe.punto_emision_codigo, pe.punto_venta_codigo, pe.tipo_documento_codigo
         from core.sucursales s left join pos.puntos_emision pe on pe.sucursal_id = s.id and pe.activo
        where s.empresa_id = $1 order by s.activo desc, s.orden, s.nombre`, [req.ctx.empresa.id]);
    res.json(rows.map((s) => {
      if (!s.punto_emision_id) return { ...s, cai_estado: null };
      const e = estadoPunto({ es_borrador: s.es_borrador, correlativo_desde: s.correlativo_desde, correlativo_hasta: s.correlativo_hasta, correlativo_actual: s.correlativo_actual, fecha_limite_emision: s.fecha_limite_emision });
      return { ...s, cai_estado: e.es_borrador ? 'borrador' : e.agotado ? 'agotado' : e.vencido ? 'vencido' : e.alerta ? 'por_vencer' : 'activo' };
    }));
  });

  const esquemaSuc = z.object({
    nombre: z.string().trim().min(2).max(80),
    alias: z.string().trim().toLowerCase().regex(/^[a-z0-9_]+$/, 'solo letras, números y _').max(40),
    direccion: z.string().trim().max(200).optional().nullable(),
    telefono: z.string().trim().max(40).optional().nullable(),
    tipo: z.enum(['tienda', 'fabrica', 'bodega', 'oficina']).default('tienda'),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color inválido (#rrggbb)').optional().nullable(),
  });
  /** El color de cada sucursal es único dentro de la empresa: así nadie confunde en cuál está trabajando. */
  async function validarColor(q, empresaId, color, exceptoId = null) {
    if (!color) return;
    const { rows } = await q.query(
      'select nombre from core.sucursales where empresa_id = $1 and activo and lower(color) = lower($2) and ($3::uuid is null or id <> $3)', [empresaId, color, exceptoId]);
    if (rows[0]) throw conflicto(`Ese color ya lo usa la sucursal "${rows[0].nombre}"; elige otro`);
  }
  async function colorLibre(q, empresaId) {
    const usados = new Set((await q.query('select lower(color) as c from core.sucursales where empresa_id = $1 and activo and color is not null', [empresaId])).rows.map((x) => x.c));
    return PALETA_SUCURSALES.find((c) => !usados.has(c)) ?? null;
  }
  r.post('/sucursales', requierePermiso('admin:empresa'), async (req, res) => {
    const b = validar(esquemaSuc, req.body);
    const emp = req.ctx.empresa;
    const s = await db.tx(async (q) => {
      await validarColor(q, emp.id, b.color);
      const color = b.color ?? (await colorLibre(q, emp.id));
      const orden = (await q.query('select coalesce(max(orden),0)+1 as n from core.sucursales where empresa_id = $1', [emp.id])).rows[0].n;
      const s = (await q.query(
        `insert into core.sucursales (empresa_id, nombre, alias, direccion, telefono, tipo, color, orden)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [emp.id, b.nombre, b.alias, b.direccion ?? null, b.telefono ?? null, b.tipo, color, orden])).rows[0];
      // Toda sucursal nace con un punto de emisión en borrador: cobra, pero sin validez fiscal hasta cargar el CAI.
      const pe = (await q.query(
        `insert into pos.puntos_emision (empresa_id, sucursal_id, punto_emision_codigo, punto_venta_codigo, correlativo_desde, correlativo_hasta, correlativo_actual, es_borrador)
         values ($1,$2,$3,'001',1,99999999,1,true) returning id, punto_emision_codigo, es_borrador`, [emp.id, s.id, String(orden).padStart(3, '0')])).rows[0];
      await auditar(q, req.ctx, 'sucursal_creada', 'sucursal', s.id, { nombre: b.nombre, alias: b.alias }, { sucursalId: s.id });
      return { ...s, punto_emision: pe };
    });
    ctxMgr.invalidar();
    res.status(201).json(s);
  });
  r.put('/sucursales/:id', requierePermiso('admin:empresa'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(esquemaSuc.partial().extend({ activo: z.boolean().optional() }), req.body);
    const s = await db.tx(async (q) => {
      const ant = (await q.query('select * from core.sucursales where id = $1 and empresa_id = $2 for update', [id, req.ctx.empresa.id])).rows[0];
      if (!ant) throw noEncontrado();
      if (b.activo === false && ant.activo) {
        const otras = (await q.query('select count(*)::int as n from core.sucursales where empresa_id = $1 and activo and id <> $2', [req.ctx.empresa.id, id])).rows[0].n;
        if (!otras) throw conflicto('No puedes desactivar la única sucursal activa de la empresa');
      }
      if (b.color) await validarColor(q, req.ctx.empresa.id, b.color, id);
      const { rows } = await q.query(
        `update core.sucursales set nombre = coalesce($3, nombre), alias = coalesce($4, alias), direccion = coalesce($5, direccion),
                telefono = coalesce($6, telefono), tipo = coalesce($7, tipo), color = coalesce($8, color), activo = coalesce($9, activo)
          where id = $1 and empresa_id = $2 returning *`,
        [id, req.ctx.empresa.id, b.nombre ?? null, b.alias ?? null, b.direccion ?? null, b.telefono ?? null, b.tipo ?? null, b.color ?? null, b.activo ?? null]);
      await auditar(q, req.ctx, 'sucursal_editada', 'sucursal', id,
        { nombre: rows[0].nombre, cambios: cambiosDe(ant, b, ['nombre', 'alias', 'direccion', 'telefono', 'tipo', 'color', 'activo']) }, { sucursalId: id });
      return rows[0];
    });
    ctxMgr.invalidar();
    res.json(s);
  });

  // ── Datos de la empresa ──────────────────────────────────────────────────
  r.get('/empresa', requierePermiso('admin:empresa'), (req, res) => res.json(req.ctx.empresa));
  r.put('/empresa', requierePermiso('admin:empresa'), async (req, res) => {
    const t = z.string().trim().max(200).optional().nullable();
    const b = validar(z.object({ razon_social: z.string().trim().min(2).max(200).optional(), rtn: t, direccion: t, ciudad: t, telefono: t, correo: t, web: t }), req.body);
    const { rows } = await db.query(
      `update core.empresas set razon_social = coalesce($2, razon_social), rtn = coalesce($3, rtn), direccion = coalesce($4, direccion),
              ciudad = coalesce($5, ciudad), telefono = coalesce($6, telefono), correo = coalesce($7, correo), web = coalesce($8, web)
        where id = $1 returning *`,
      [req.ctx.empresa.id, b.razon_social ?? null, b.rtn ?? null, b.direccion ?? null, b.ciudad ?? null, b.telefono ?? null, b.correo ?? null, b.web ?? null]);
    await auditar(db, req.ctx, 'empresa_editada', 'empresa', req.ctx.empresa.id, b);
    ctxMgr.invalidar();
    res.json(rows[0]);
  });

  // ── Módulos encendidos (solo dueño del grupo) ────────────────────────────
  r.get('/modulos', requierePermiso('admin:empresa'), async (req, res) => {
    const act = (await db.query('select modulo, activo from core.empresa_modulos where empresa_id = $1', [req.ctx.empresa.id])).rows;
    res.json(['pos', 'kds', 'inventario', 'rrhh', 'finanzas', 'antifraude', 'cotizaciones', 'fabrica', 'distribuidora', 'reposicion', 'cobranza'].map((m) => ({
      id: m, nombre: MODULOS[m]?.nombre ?? m, activo: act.find((a) => a.modulo === m)?.activo ?? false })));
  });
  r.put('/modulos/:modulo', async (req, res) => {
    if (!req.ctx.usuario.es_dueno_grupo) throw prohibido('Solo el dueño del grupo enciende o apaga módulos');
    const modulo = validar(z.enum(['pos', 'kds', 'inventario', 'rrhh', 'finanzas', 'antifraude', 'cotizaciones', 'fabrica', 'distribuidora', 'reposicion', 'cobranza']), req.params.modulo);
    const { activo } = validar(z.object({ activo: z.boolean() }), req.body);
    await db.query(
      `insert into core.empresa_modulos (empresa_id, modulo, activo) values ($1,$2,$3)
       on conflict (empresa_id, modulo) do update set activo = excluded.activo`, [req.ctx.empresa.id, modulo, activo]);
    await auditar(db, req.ctx, activo ? 'modulo_encendido' : 'modulo_apagado', 'modulo', modulo);
    ctxMgr.invalidar();
    res.json({ ok: true });
  });

  // ── Bitácora inalterable ─────────────────────────────────────────────────
  // Solo lectura: core.auditoria no admite UPDATE/DELETE y este router no expone cómo escribir en ella.
  const TZ = 'America/Tegucigalpa';
  r.get('/auditoria', requierePermiso('auditoria:ver'), async (req, res) => {
    const q = validar(z.object({
      limite: z.coerce.number().int().min(1).max(500).default(300),
      accion: z.string().max(60).optional(),            // prefijo: «venta_» filtra todo lo de ventas
      entidad: z.string().max(60).optional(),
      entidad_id: z.string().max(80).optional(),
      usuario_id: uuid.optional(),
      sucursal_id: uuid.optional(),
      desde: fechaISO.optional(), hasta: fechaISO.optional(),
      q: z.string().trim().max(80).optional(),           // busca en usuario, acción, documento y detalle
      antes_de: z.coerce.number().int().positive().optional(),   // paginación: ids menores a este
    }), req.query);
    const like = (t) => `%${t.replace(/[\\%_]/g, '\\$&')}%`;
    const { rows } = await db.query(
      `select a.id, a.created_at, a.usuario_id, a.usuario_nombre, a.accion, a.entidad, a.entidad_id, a.sucursal_id, s.nombre as sucursal,
              a.detalle, a.ip, a.hash_anterior, a.hash
         from core.auditoria a left join core.sucursales s on s.id = a.sucursal_id
        where a.empresa_id = $1
          and ($2::text is null or a.accion like $2 || '%')
          and ($3::text is null or a.entidad = $3)
          and ($4::text is null or a.entidad_id = $4)
          and ($5::uuid is null or a.usuario_id = $5)
          and ($6::uuid is null or a.sucursal_id = $6)
          and ($7::date is null or a.created_at >= ($7::date)::timestamp at time zone '${TZ}')
          and ($8::date is null or a.created_at < (($8::date) + 1)::timestamp at time zone '${TZ}')
          and ($9::text is null or a.usuario_nombre ilike $9 or a.accion ilike $9 or a.entidad_id ilike $9 or a.detalle::text ilike $9)
          and ($10::bigint is null or a.id < $10)
        order by a.id desc limit $11`,
      [req.ctx.empresa.id, q.accion ?? null, q.entidad ?? null, q.entidad_id ?? null, q.usuario_id ?? null, q.sucursal_id ?? null,
        q.desde ?? null, q.hasta ?? null, q.q ? like(q.q) : null, q.antes_de ?? null, q.limite]);
    res.json(rows);
  });
  // Quién ha dejado huella en esta empresa (para el filtro por usuario).
  r.get('/auditoria/usuarios', requierePermiso('auditoria:ver'), async (req, res) => {
    const { rows } = await db.query(
      `select usuario_id as id, max(usuario_nombre) as nombre, count(*)::int as registros from core.auditoria
        where empresa_id = $1 and usuario_id is not null group by usuario_id order by max(usuario_nombre)`, [req.ctx.empresa.id]);
    res.json(rows);
  });
  // Recalcula la cadena completa de hashes: si alguien alteró o borró un registro directo en la base, lo señala.
  r.get('/auditoria/verificar', requierePermiso('auditoria:ver'), async (_req, res) => {
    const { rows } = await db.query('select * from core.verificar_auditoria()');
    res.json(rows[0]);
  });

  return r;
}
