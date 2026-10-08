import { Router } from 'express';
import { z } from 'zod';
import { requierePermiso, resolverSucursal } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { fechaISO, malaPeticion, noEncontrado, uuid, validar } from '../../lib/http.js';
import { empresaDe, texto } from './util.js';

const MAX_DESCRIPCION = 500;

/**
 * Lista de equipos dañados (aire, congelador, lo que sea): se anota apenas se nota, para que el técnico revise todo de una
 * pasada. Es un tablero abierto a cualquiera con acceso a reposición. La sucursal es obligatoria.
 */
export function rutasMantenimiento({ db }) {
  const r = Router();
  r.use(requierePermiso('rep:ver', 'rep:pesar', 'rep:inventario', 'rep:producir'));
  const equipo = z.string().trim().min(2, 'Di qué equipo se dañó').max(120);

  r.post('/', async (req, res) => {
    const b = validar(z.object({ equipo, descripcion: z.string().trim().max(MAX_DESCRIPCION).optional().nullable(), sucursal_id: uuid, fecha: fechaISO }), { ...req.body, sucursal_id: req.body?.sucursal_id || undefined });
    const s = await resolverSucursal(db, req.ctx, b.sucursal_id).catch(() => { throw malaPeticion('Sucursal inválida'); });
    const m = (await db.query('insert into rinv.mantenimientos (empresa_id, equipo, descripcion, sucursal_id, fecha, usuario_id) values ($1,$2,$3,$4,$5,$6) returning id', [empresaDe(req), b.equipo, texto(b.descripcion), s.id, b.fecha, req.ctx.usuario.id])).rows[0];
    await auditar(db, req.ctx, 'rinv.mantenimiento_anotado', 'mantenimiento', m.id, { equipo: b.equipo, sucursal: s.nombre }, { sucursalId: s.id });
    res.status(201).json({ ok: true, id: m.id });
  });

  /** Por defecto solo lo pendiente (lo más viejo primero); `todos=1` incluye lo resuelto. */
  r.get('/', async (req, res) => {
    const todos = req.query.todos === '1' || req.query.todos === 'true';
    res.json((await db.query(
      `select m.id, m.equipo, m.descripcion, m.fecha::text as fecha, m.listo, m.resuelto_en, m.created_at as creado_en, m.sucursal_id, s.nombre as sucursal_nombre
         from rinv.mantenimientos m left join core.sucursales s on s.id = m.sucursal_id
        where m.empresa_id = $1 and ($2 or not m.listo) and ($3::uuid[] = '{}' or m.sucursal_id is null or m.sucursal_id = any($3::uuid[]))
        order by m.listo, m.fecha, m.created_at`, [empresaDe(req), todos, req.ctx.sucursalIds])).rows);
  });

  r.patch('/:id', async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = req.body ?? {};
    const cols = []; const vals = [];
    const poner = (c, v) => { vals.push(v); cols.push(`${c} = $${vals.length + 2}`); };
    if ('listo' in b) { poner('listo', Boolean(b.listo)); poner('resuelto_en', b.listo ? new Date() : null); }
    if ('equipo' in b) poner('equipo', validar(equipo, b.equipo));
    if ('descripcion' in b) poner('descripcion', texto(b.descripcion)?.slice(0, MAX_DESCRIPCION) ?? null);
    if ('fecha' in b) poner('fecha', validar(fechaISO, b.fecha));
    if ('sucursal_id' in b) poner('sucursal_id', b.sucursal_id ? (await resolverSucursal(db, req.ctx, validar(uuid, b.sucursal_id))).id : null);
    if (!cols.length) throw malaPeticion('Nada que actualizar');
    const { rows } = await db.query(`update rinv.mantenimientos set ${cols.join(', ')} where id = $1 and empresa_id = $2 returning equipo, listo`, [id, empresaDe(req), ...vals]);
    if (!rows[0]) throw noEncontrado('No encontrado');
    await auditar(db, req.ctx, 'listo' in b ? (b.listo ? 'rinv.mantenimiento_resuelto' : 'rinv.mantenimiento_reabierto') : 'rinv.mantenimiento_editado', 'mantenimiento', id, { equipo: rows[0].equipo });
    res.json({ ok: true });
  });

  r.delete('/:id', async (req, res) => {
    const id = validar(uuid, req.params.id);
    const { rows } = await db.query('delete from rinv.mantenimientos where id = $1 and empresa_id = $2 returning equipo', [id, empresaDe(req)]);
    if (!rows[0]) throw noEncontrado('No encontrado');
    await auditar(db, req.ctx, 'rinv.mantenimiento_borrado', 'mantenimiento', id, { equipo: rows[0].equipo });
    res.json({ ok: true });
  });

  return r;
}
