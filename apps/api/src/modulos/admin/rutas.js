import { Router } from 'express';
import { z } from 'zod';
import { ROLES, PERMISOS, ROLES_CON_PIN, MODULOS } from '@grupo/shared';
import { hashSecreto } from '../../auth/passwords.js';
import { hashPin, PIN_RE } from '../../auth/pin.js';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { conflicto, malaPeticion, noEncontrado, prohibido, uuid, validar } from '../../lib/http.js';

const ROLES_DIRECCION = ['dueno', 'admin', 'contador', 'solo_lectura'];   // exigen correo + contraseña
const ROLES_ALTOS = ['dueno', 'admin'];                                   // solo un dueño los asigna
const rolEnum = z.enum(Object.keys(ROLES));
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
      `select u.id, u.nombre, u.email, u.es_dueno_grupo, u.activo as usuario_activo, u.ultimo_acceso,
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

  r.post('/usuarios', requierePermiso('admin:usuarios'), async (req, res) => {
    const b = validar(esquemaNuevo, req.body);
    validarRolAsignable(req.ctx, b.rol);
    if (ROLES_DIRECCION.includes(b.rol) && (!b.email)) throw malaPeticion('Ese rol entra con correo y contraseña: falta el correo');
    if (b.pin && !ROLES_CON_PIN.includes(b.rol)) throw malaPeticion('Ese rol no puede entrar con PIN');
    if (!b.email && !b.pin) throw malaPeticion('Indica un correo o un PIN para que pueda entrar');
    const emp = req.ctx.empresa;
    const id = await db.tx(async (q) => {
      await validarSucursales(q, emp.id, b.sucursal_ids);
      let u = b.email ? (await q.query('select * from core.usuarios where email = $1', [b.email])).rows[0] : null;
      if (!u) {
        if (ROLES_DIRECCION.includes(b.rol) && !b.password) throw malaPeticion('Falta la contraseña inicial');
        u = (await q.query(
          `insert into core.usuarios (nombre, email, password_hash) values ($1,$2,$3) returning *`,
          [b.nombre, b.email ?? null, b.password ? hashSecreto(b.password) : null])).rows[0];
      } else if (b.password && !u.auth_user_id) {
        await q.query('update core.usuarios set password_hash = $1 where id = $2', [hashSecreto(b.password), u.id]);
      }
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
    const actual = (await db.query('select a.*, u.es_dueno_grupo from core.accesos a join core.usuarios u on u.id = a.usuario_id where a.usuario_id = $1 and a.empresa_id = $2', [id, emp.id])).rows[0];
    if (!actual) throw noEncontrado('Ese usuario no tiene acceso a esta empresa');
    if (b.rol) validarRolAsignable(req.ctx, b.rol);
    if (ROLES_ALTOS.includes(actual.rol)) validarRolAsignable(req.ctx, actual.rol);
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
      await auditar(q, req.ctx, 'usuario_editado', 'usuario', id, b);
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
    const a = (await db.query('select rol from core.accesos where usuario_id = $1 and empresa_id = $2', [id, req.ctx.empresa.id])).rows[0];
    if (!a) throw noEncontrado();
    if (ROLES_ALTOS.includes(a.rol)) validarRolAsignable(req.ctx, a.rol);
    await db.query('update core.usuarios set password_hash = $1, token_version = token_version + 1 where id = $2 and auth_user_id is null', [hashSecreto(password), id]);
    await auditar(db, req.ctx, 'password_restablecida', 'usuario', id);
    ctxMgr.invalidar();
    res.json({ ok: true });
  });

  // ── Sucursales ───────────────────────────────────────────────────────────
  r.get('/sucursales', requierePermiso('admin:empresa', 'pos:fiscal', 'admin:usuarios'), async (req, res) => {
    res.json((await db.query('select * from core.sucursales where empresa_id = $1 order by activo desc, orden, nombre', [req.ctx.empresa.id])).rows);
  });

  const esquemaSuc = z.object({
    nombre: z.string().trim().min(2).max(80),
    alias: z.string().trim().toLowerCase().regex(/^[a-z0-9_]+$/, 'solo letras, números y _').max(40),
    direccion: z.string().trim().max(200).optional().nullable(),
    telefono: z.string().trim().max(40).optional().nullable(),
    tipo: z.enum(['tienda', 'fabrica', 'bodega', 'oficina']).default('tienda'),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable(),
  });
  r.post('/sucursales', requierePermiso('admin:empresa'), async (req, res) => {
    const b = validar(esquemaSuc, req.body);
    const emp = req.ctx.empresa;
    const s = await db.tx(async (q) => {
      const orden = (await q.query('select coalesce(max(orden),0)+1 as n from core.sucursales where empresa_id = $1', [emp.id])).rows[0].n;
      const s = (await q.query(
        `insert into core.sucursales (empresa_id, nombre, alias, direccion, telefono, tipo, color, orden)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [emp.id, b.nombre, b.alias, b.direccion ?? null, b.telefono ?? null, b.tipo, b.color ?? null, orden])).rows[0];
      // Toda sucursal nace con un punto de emisión en borrador: cobra, pero sin validez fiscal hasta cargar el CAI.
      await q.query(
        `insert into pos.puntos_emision (empresa_id, sucursal_id, punto_emision_codigo, punto_venta_codigo, correlativo_desde, correlativo_hasta, correlativo_actual, es_borrador)
         values ($1,$2,$3,'001',1,99999999,1,true)`, [emp.id, s.id, String(orden).padStart(3, '0')]);
      await auditar(q, req.ctx, 'sucursal_creada', 'sucursal', s.id, { nombre: b.nombre });
      return s;
    });
    ctxMgr.invalidar();
    res.status(201).json(s);
  });
  r.put('/sucursales/:id', requierePermiso('admin:empresa'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(esquemaSuc.partial().extend({ activo: z.boolean().optional() }), req.body);
    const { rows } = await db.query(
      `update core.sucursales set nombre = coalesce($3, nombre), alias = coalesce($4, alias), direccion = coalesce($5, direccion),
              telefono = coalesce($6, telefono), tipo = coalesce($7, tipo), color = coalesce($8, color), activo = coalesce($9, activo)
        where id = $1 and empresa_id = $2 returning *`,
      [id, req.ctx.empresa.id, b.nombre ?? null, b.alias ?? null, b.direccion ?? null, b.telefono ?? null, b.tipo ?? null, b.color ?? null, b.activo ?? null]);
    if (!rows[0]) throw noEncontrado();
    await auditar(db, req.ctx, 'sucursal_editada', 'sucursal', id, b);
    ctxMgr.invalidar();
    res.json(rows[0]);
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
    res.json(['pos', 'kds', 'inventario', 'rrhh', 'finanzas', 'grupo'].map((m) => ({
      id: m, nombre: MODULOS[m]?.nombre ?? m, activo: act.find((a) => a.modulo === m)?.activo ?? false })));
  });
  r.put('/modulos/:modulo', async (req, res) => {
    if (!req.ctx.usuario.es_dueno_grupo) throw prohibido('Solo el dueño del grupo enciende o apaga módulos');
    const modulo = validar(z.enum(['pos', 'kds', 'inventario', 'rrhh', 'finanzas', 'grupo']), req.params.modulo);
    const { activo } = validar(z.object({ activo: z.boolean() }), req.body);
    await db.query(
      `insert into core.empresa_modulos (empresa_id, modulo, activo) values ($1,$2,$3)
       on conflict (empresa_id, modulo) do update set activo = excluded.activo`, [req.ctx.empresa.id, modulo, activo]);
    await auditar(db, req.ctx, activo ? 'modulo_encendido' : 'modulo_apagado', 'modulo', modulo);
    ctxMgr.invalidar();
    res.json({ ok: true });
  });

  // ── Bitácora inalterable ─────────────────────────────────────────────────
  r.get('/auditoria', requierePermiso('auditoria:ver'), async (req, res) => {
    const q = validar(z.object({
      limite: z.coerce.number().int().min(1).max(500).default(100),
      accion: z.string().max(60).optional(), entidad: z.string().max(60).optional(),
    }), req.query);
    const { rows } = await db.query(
      `select id, created_at, usuario_nombre, accion, entidad, entidad_id, detalle, ip
         from core.auditoria
        where empresa_id = $1 and ($2::text is null or accion = $2) and ($3::text is null or entidad = $3)
        order by id desc limit $4`, [req.ctx.empresa.id, q.accion ?? null, q.entidad ?? null, q.limite]);
    res.json(rows);
  });
  r.get('/auditoria/verificar', requierePermiso('auditoria:ver'), async (_req, res) => {
    const { rows } = await db.query('select * from core.verificar_auditoria()');
    res.json(rows[0]);
  });

  return r;
}
