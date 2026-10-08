import { z } from 'zod';
import { ROLES, fechaHN, sumarDias } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { hashSecreto } from '../../auth/passwords.js';
import { conflicto, malaPeticion, noEncontrado, prohibido, uuid, validar, fechaISO, dinero } from '../../lib/http.js';
import { recolectar } from '../gerente/recolectar.js';
import { analizar, analizarGrupo } from '../gerente/analisis.js';

/** Rutas de Dirección: gerente digital del grupo, finanzas de las 4 empresas y administradores. */
export function montarExtras(r, { db, ctxMgr }, empresasConsolidables) {
  // ── Gerente digital de Dirección: analiza cada empresa y luego las compara ──
  r.get('/gerente', requierePermiso('grupo:ver'), async (req, res) => {
    const { dias } = validar(z.object({ dias: z.coerce.number().int().min(7).max(90).default(28) }), req.query);
    const empresas = await empresasConsolidables(req.ctx.usuario);
    const porEmpresa = [];
    for (const e of empresas) porEmpresa.push(analizar(await recolectar(db, { empresa: e, sucursalIds: [], dias })));
    const interco = (await db.query('select monto, estado from fin.intercompania where empresa_origen_id = any($1::uuid[])', [empresas.map((e) => e.id)])).rows;
    res.json({ grupo: analizarGrupo(porEmpresa, interco), empresas: porEmpresa });
  });

  // ── Finanzas del grupo: control sobre las cuatro empresas ──
  const rango = z.object({ desde: fechaISO.optional(), hasta: fechaISO.optional(), empresa: z.string().optional() });
  r.get('/gastos', requierePermiso('grupo:ver'), async (req, res) => {
    const f = validar(rango, req.query);
    const hoy = fechaHN();
    const empresas = (await empresasConsolidables(req.ctx.usuario)).filter((e) => !f.empresa || e.codigo === f.empresa);
    const { rows } = await db.query(
      `select g.*, e.codigo as empresa, e.nombre as empresa_nombre, c.nombre as categoria, c.grupo, s.nombre as sucursal
         from fin.gastos g join core.empresas e on e.id = g.empresa_id left join fin.categorias_gasto c on c.id = g.categoria_id left join core.sucursales s on s.id = g.sucursal_id
        where g.empresa_id = any($1::uuid[]) and g.fecha between $2::date and $3::date order by g.fecha desc, g.created_at desc limit 500`,
      [empresas.map((e) => e.id), f.desde ?? sumarDias(hoy, -30), f.hasta ?? hoy]);
    res.json(rows);
  });
  r.post('/gastos', requierePermiso('grupo:ver'), async (req, res) => {
    const b = validar(z.object({
      empresa: z.string().min(1), fecha: fechaISO.optional(), sucursal_id: uuid.optional().nullable(), categoria_id: uuid, descripcion: z.string().trim().min(3).max(200),
      monto: dinero.refine((n) => n > 0, 'El monto debe ser mayor a 0'), isv: dinero.default(0), documento: z.string().trim().max(40).optional().nullable() }), req.body);
    const emp = (await empresasConsolidables(req.ctx.usuario)).find((e) => e.codigo === b.empresa);
    if (!emp) throw prohibido('No tienes acceso a esa empresa');
    if (b.isv > b.monto) throw malaPeticion('El ISV no puede ser mayor al monto');
    if (!(await db.query('select 1 from fin.categorias_gasto where id = $1 and empresa_id = $2', [b.categoria_id, emp.id])).rowCount) throw noEncontrado('Esa categoría no pertenece a la empresa elegida');
    if (b.sucursal_id && !(await db.query('select 1 from core.sucursales where id = $1 and empresa_id = $2', [b.sucursal_id, emp.id])).rowCount) throw malaPeticion('La sucursal no es de esa empresa');
    const g = (await db.query(
      `insert into fin.gastos (empresa_id,sucursal_id,fecha,categoria_id,descripcion,monto,isv,documento,registrado_por)
       values ($1,$2,coalesce($3::date,(now() at time zone 'America/Tegucigalpa')::date),$4,$5,$6,$7,$8,$9) returning *`,
      [emp.id, b.sucursal_id ?? null, b.fecha ?? null, b.categoria_id, b.descripcion, b.monto, b.isv, b.documento ?? null, req.ctx.usuario.id])).rows[0];
    await auditar(db, { ...req.ctx, empresa: emp }, 'gasto_registrado', 'gasto', g.id, { monto: g.monto, descripcion: g.descripcion, desde: 'direccion' });
    res.status(201).json(g);
  });
  r.get('/categorias-gasto', requierePermiso('grupo:ver'), async (req, res) => {
    const empresas = await empresasConsolidables(req.ctx.usuario);
    res.json((await db.query(`select c.id, c.nombre, c.grupo, e.codigo as empresa from fin.categorias_gasto c join core.empresas e on e.id = c.empresa_id where c.activo and c.empresa_id = any($1::uuid[]) order by e.orden, c.grupo, c.nombre`, [empresas.map((e) => e.id)])).rows);
  });
  r.get('/intercompania', requierePermiso('grupo:ver'), async (req, res) => {
    const ids = (await empresasConsolidables(req.ctx.usuario)).map((e) => e.id);
    res.json((await db.query(
      `select i.*, o.nombre as origen, d.nombre as destino from fin.intercompania i join core.empresas o on o.id = i.empresa_origen_id join core.empresas d on d.id = i.empresa_destino_id
        where i.empresa_origen_id = any($1::uuid[]) or i.empresa_destino_id = any($1::uuid[]) order by i.fecha desc limit 200`, [ids])).rows);
  });
  r.post('/intercompania', requierePermiso('grupo:ver'), async (req, res) => {
    const b = validar(z.object({ origen: z.string(), destino: z.string(), fecha: fechaISO.optional(), concepto: z.string().trim().min(3).max(200), monto: dinero.refine((n) => n > 0, 'El monto debe ser mayor a 0') }), req.body);
    if (b.origen === b.destino) throw malaPeticion('Elige dos empresas distintas');
    const todas = await empresasConsolidables(req.ctx.usuario);
    const o = todas.find((e) => e.codigo === b.origen), d = todas.find((e) => e.codigo === b.destino);
    if (!o || !d) throw prohibido('No tienes acceso a alguna de esas empresas');
    const i = (await db.query(
      `insert into fin.intercompania (fecha, empresa_origen_id, empresa_destino_id, concepto, monto, registrado_por) values (coalesce($1::date,(now() at time zone 'America/Tegucigalpa')::date),$2,$3,$4,$5,$6) returning *`,
      [b.fecha ?? null, o.id, d.id, b.concepto, b.monto, req.ctx.usuario.id])).rows[0];
    await auditar(db, req.ctx, 'intercompania_registrada', 'intercompania', i.id, { origen: b.origen, destino: b.destino, monto: i.monto });
    res.status(201).json(i);
  });
  r.put('/intercompania/:id/conciliar', requierePermiso('grupo:ver'), async (req, res) => {
    const ids = (await empresasConsolidables(req.ctx.usuario)).map((e) => e.id);
    const { rowCount } = await db.query(`update fin.intercompania set estado = 'conciliado' where id = $1 and empresa_origen_id = any($2::uuid[]) and empresa_destino_id = any($2::uuid[])`, [validar(uuid, req.params.id), ids]);
    if (!rowCount) throw noEncontrado();
    res.json({ ok: true });
  });

  // ── Administradores del grupo y accesos entre empresas (solo "administrador general") ──
  const soloGeneral = (req) => { if (!req.ctx.usuario.es_dueno_grupo) throw prohibido('Solo un administrador general puede hacer esto'); };
  r.get('/usuarios', async (req, res) => {
    soloGeneral(req);
    const { rows } = await db.query(
      `select u.id, u.nombre, u.email, u.es_dueno_grupo, u.activo, u.ultimo_acceso,
              coalesce(json_agg(json_build_object('empresa', e.codigo, 'rol', a.rol, 'activo', a.activo) order by e.orden) filter (where a.id is not null), '[]') as accesos
         from core.usuarios u left join core.accesos a on a.usuario_id = u.id left join core.empresas e on e.id = a.empresa_id
        group by u.id order by u.es_dueno_grupo desc, u.nombre`);
    res.json(rows);
  });
  r.post('/usuarios', async (req, res) => {
    soloGeneral(req);
    const b = validar(z.object({ nombre: z.string().trim().min(2).max(120), email: z.string().trim().toLowerCase().email(), password: z.string().min(10, 'Mínimo 10 caracteres').max(200), es_dueno_grupo: z.boolean().default(false) }), req.body);
    try {
      const u = (await db.query('insert into core.usuarios (nombre, email, password_hash, es_dueno_grupo) values ($1,$2,$3,$4) returning id', [b.nombre, b.email, hashSecreto(b.password), b.es_dueno_grupo])).rows[0];
      await auditar(db, req.ctx, 'usuario_creado', 'usuario', u.id, { email: b.email, administrador_general: b.es_dueno_grupo });
      ctxMgr.invalidar();
      res.status(201).json(u);
    } catch (e) { if (e.code === '23505') throw conflicto('Ya existe un usuario con ese correo'); throw e; }
  });
  r.put('/usuarios/:id/administrador-general', async (req, res) => {
    soloGeneral(req);
    const id = validar(uuid, req.params.id);
    const { valor } = validar(z.object({ valor: z.boolean() }), req.body);
    if (!valor && id === req.ctx.usuario.id) throw prohibido('No puedes quitarte a ti mismo el rol de administrador general');
    if (!(await db.query('update core.usuarios set es_dueno_grupo = $2, token_version = token_version + 1 where id = $1', [id, valor])).rowCount) throw noEncontrado();
    await auditar(db, req.ctx, valor ? 'administrador_general_asignado' : 'administrador_general_quitado', 'usuario', id);
    ctxMgr.invalidar();
    res.json({ ok: true });
  });
  r.put('/usuarios/:id/acceso', async (req, res) => {
    soloGeneral(req);
    const id = validar(uuid, req.params.id);
    const b = validar(z.object({ empresa: z.string(), rol: z.enum(Object.keys(ROLES)), activo: z.boolean().default(true) }), req.body);
    const emp = (await ctxMgr.empresas()).find((e) => e.codigo === b.empresa);
    if (!emp) throw noEncontrado('Empresa no encontrada');
    if (!(await db.query('select 1 from core.usuarios where id = $1', [id])).rowCount) throw noEncontrado('Usuario no encontrado');
    await db.query(
      `insert into core.accesos (usuario_id, empresa_id, rol, activo) values ($1,$2,$3,$4) on conflict (usuario_id, empresa_id) do update set rol = excluded.rol, activo = excluded.activo`,
      [id, emp.id, b.rol, b.activo]);
    await auditar(db, req.ctx, 'acceso_asignado', 'usuario', id, { empresa: b.empresa, rol: b.rol, activo: b.activo });
    ctxMgr.invalidar();
    res.json({ ok: true });
  });
}
