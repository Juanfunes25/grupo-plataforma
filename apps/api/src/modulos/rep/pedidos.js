import { Router } from 'express';
import { z } from 'zod';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { conflicto, malaPeticion, noEncontrado, prohibido, validar, fechaISO, uuid } from '../../lib/http.js';
import { empresaDe, esTienda, sucursalDe } from './util.js';

const item = z.object({ insumo_texto: z.string().trim().min(1, 'Cada artículo necesita su nombre').max(120), cantidad: z.string().trim().max(60).optional().nullable().transform((v) => v || '') });
const ESTADOS = ['pedido', 'preparado', 'enviado', 'recibido'];

export function rutasPedidos({ db }) {
  const r = Router();
  const emp = empresaDe;

  async function conItems(q, pedidos) {
    if (!pedidos.length) return [];
    const { rows } = await q.query('select id, pedido_id, insumo_texto, cantidad, preparado::int as preparado, enviado::int as enviado from rep.pedido_items where pedido_id = any($1::uuid[]) order by created_at, id', [pedidos.map((p) => p.id)]);
    return pedidos.map((p) => ({ ...p, items: rows.filter((i) => i.pedido_id === p.id) }));
  }
  const cols = `p.id, p.sucursal_id, p.fecha::text as fecha, p.notas, p.estado, p.created_at as creado_en`;

  /**
   * Un pedido lo puede tocar la tienda mientras NADIE lo haya empezado a preparar. El corte no es el estado solo: el
   * despachador va tildando artículo por artículo, y cambiarle la lista a media caja se descubre recién al llegar mal.
   */
  async function pedidoEditable(q, req, id) {
    const p = (await q.query(`select ${cols} from rep.pedidos_insumos p where p.id = $1 and p.empresa_id = $2`, [validar(uuid, id), emp(req)])).rows[0];
    if (!p) throw noEncontrado('Ese pedido ya no existe');
    if (req.ctx.sucursalIds.length && !req.ctx.sucursalIds.includes(p.sucursal_id)) throw prohibido('Ese pedido es de otra tienda');
    if (p.estado !== 'pedido') throw conflicto('Ese pedido ya salió de fábrica. Hablá con el despachador.');
    const tocado = (await q.query('select count(*)::int as n from rep.pedido_items where pedido_id = $1 and preparado', [p.id])).rows[0].n;
    if (tocado > 0) throw conflicto('El despachador ya lo está preparando. Hablá con él para cambiarlo.');
    return p;
  }

  async function insertarItems(q, req, pedidoId, items) {
    for (const it of items) {
      await q.query('insert into rep.pedido_items (pedido_id, insumo_texto, cantidad) values ($1,$2,$3)', [pedidoId, it.insumo_texto, it.cantidad]);
      // Lo que no esté todavía en el catálogo de insumos se da de alta, para el «toca para agregar rápido».
      await q.query('insert into rep.insumos_catalogo (empresa_id, nombre) values ($1,$2) on conflict (empresa_id, nombre) do nothing', [emp(req), it.insumo_texto]);
    }
  }

  r.post('/', requierePermiso('rep:pesar'), async (req, res) => {
    const b = validar(z.object({ sucursal_id: uuid, fecha: fechaISO, notas: z.string().trim().max(500).optional().nullable().transform((v) => v || ''), items: z.array(item).min(1, 'Faltan campos requeridos (al menos un item)').max(80) }), req.body);
    const suc = await sucursalDe(db, req, b.sucursal_id);
    const out = await db.tx(async (q) => {
      // Si esa tienda ya tiene un pedido abierto de hoy, los artículos se SUMAN a ese en vez de abrir otro (causa del pedido doble).
      const abierto = (await q.query(
        `select p.id from rep.pedidos_insumos p where p.empresa_id = $1 and p.sucursal_id = $2 and p.fecha = $3 and p.estado = 'pedido'
            and not exists (select 1 from rep.pedido_items i where i.pedido_id = p.id and i.preparado) order by p.created_at desc limit 1`, [emp(req), suc.id, b.fecha])).rows[0];
      if (abierto) {
        await insertarItems(q, req, abierto.id, b.items);
        if (b.notas) await q.query(`update rep.pedidos_insumos set notas = trim(coalesce(notas,'') || ' ' || $2) where id = $1`, [abierto.id, b.notas]);
        await auditar(q, req.ctx, 'pedido.agregar', 'pedido', abierto.id, { sucursal: suc.nombre, agregados: b.items.length }, { sucursalId: suc.id });
        return { status: 200, body: { ok: true, id: abierto.id, agregado: true, items: b.items.length } };
      }
      const p = (await q.query('insert into rep.pedidos_insumos (empresa_id, sucursal_id, fecha, notas, creado_por) values ($1,$2,$3,$4,$5) returning id', [emp(req), suc.id, b.fecha, b.notas, req.ctx.usuario.id])).rows[0];
      await insertarItems(q, req, p.id, b.items);
      await auditar(q, req.ctx, 'pedido.crear', 'pedido', p.id, { sucursal: suc.nombre, fecha: b.fecha, items: b.items.map((i) => i.insumo_texto) }, { sucursalId: suc.id });
      return { status: 201, body: { ok: true, id: p.id, agregado: false } };
    });
    res.status(out.status).json(out.body);
  });

  // La tienda corrige su propio pedido: reemplaza la lista entera.
  r.put('/:id', requierePermiso('rep:pesar'), async (req, res) => {
    const b = validar(z.object({ items: z.array(item).min(1, 'El pedido tiene que quedar con al menos un artículo. Si no va ninguno, bórralo.').max(80), notas: z.string().trim().max(500).optional().nullable().transform((v) => v || '') }), req.body);
    await db.tx(async (q) => {
      const p = await pedidoEditable(q, req, req.params.id);
      await q.query('delete from rep.pedido_items where pedido_id = $1', [p.id]);
      await insertarItems(q, req, p.id, b.items);
      await q.query('update rep.pedidos_insumos set notas = $2 where id = $1', [p.id, b.notas]);
      await auditar(q, req.ctx, 'pedido.editar', 'pedido', p.id, { items: b.items.length }, { sucursalId: p.sucursal_id });
    });
    res.json({ ok: true });
  });

  r.delete('/:id', requierePermiso('rep:pesar'), async (req, res) => {
    await db.tx(async (q) => {
      const p = await pedidoEditable(q, req, req.params.id);
      await q.query('delete from rep.pedidos_insumos where id = $1', [p.id]);
      await auditar(q, req.ctx, 'pedido.borrar', 'pedido', p.id, { fecha: p.fecha }, { sucursalId: p.sucursal_id });
    });
    res.json({ ok: true });
  });

  r.get('/', requierePermiso('rep:pesar', 'rep:despachar', 'rep:ver'), async (req, res) => {
    const params = [emp(req)];
    let filtro = '';
    if (req.ctx.sucursalIds.length) { params.push(req.ctx.sucursalIds); filtro = ' and p.sucursal_id = any($2::uuid[])'; }
    const { rows } = await db.query(`select ${cols}, su.nombre as sucursal_nombre from rep.pedidos_insumos p join core.sucursales su on su.id = p.sucursal_id where p.empresa_id = $1${filtro} order by p.created_at desc limit 300`, params);
    res.json(await conItems(db, rows));
  });

  // El último pedido de la sucursal, para «pedir lo mismo que la vez pasada».
  r.get('/ultimo', requierePermiso('rep:pesar'), async (req, res) => {
    const suc = await sucursalDe(db, req, req.query.sucursal_id);
    const p = (await db.query(`select ${cols} from rep.pedidos_insumos p where p.empresa_id = $1 and p.sucursal_id = $2 order by p.created_at desc limit 1`, [emp(req), suc.id])).rows[0];
    if (!p) return res.json(null);
    const items = (await db.query('select insumo_texto, cantidad from rep.pedido_items where pedido_id = $1 order by created_at, id', [p.id])).rows;
    res.json({ ...p, items });
  });

  const cargarPedido = async (q, req, id) => {
    const p = (await q.query(`select ${cols}, su.nombre as sucursal_nombre from rep.pedidos_insumos p join core.sucursales su on su.id = p.sucursal_id where p.id = $1 and p.empresa_id = $2`, [validar(uuid, id), emp(req)])).rows[0];
    if (!p) throw noEncontrado('Pedido no encontrado');
    return p;
  };

  r.patch('/:id/estado', requierePermiso('rep:despachar'), async (req, res) => {
    const { estado } = validar(z.object({ estado: z.enum(ESTADOS, { errorMap: () => ({ message: 'Estado inválido' }) }) }), req.body);
    await db.tx(async (q) => {
      const p = await cargarPedido(q, req, req.params.id);
      await q.query('update rep.pedidos_insumos set estado = $2 where id = $1', [p.id, estado]);
      await auditar(q, req.ctx, 'pedido.estado', 'pedido', p.id, { sucursal: p.sucursal_nombre, antes: p.estado, despues: estado }, { sucursalId: p.sucursal_id });
    });
    res.json({ ok: true });
  });

  r.patch('/items/:itemId/preparado', requierePermiso('rep:despachar'), async (req, res) => {
    const preparado = Boolean(req.body?.preparado);
    const { rowCount } = await db.query(
      `update rep.pedido_items i set preparado = $2 from rep.pedidos_insumos p where i.id = $1 and p.id = i.pedido_id and p.empresa_id = $3`, [validar(uuid, req.params.itemId), preparado, emp(req)]);
    if (!rowCount) throw noEncontrado('Artículo no encontrado');
    res.json({ ok: true });
  });

  /**
   * Despacha SOLO los insumos que el operario marcó (los que de verdad había en bodega) y cierra el pedido de una vez:
   * casi nunca están los 6 que pidió la tienda; lo que no se marcó no queda dando vueltas.
   */
  r.patch('/:id/despachar-marcados', requierePermiso('rep:despachar'), async (req, res) => {
    const { items_enviados } = validar(z.object({ items_enviados: z.array(uuid).default([]) }), req.body ?? {});
    const out = await db.tx(async (q) => {
      const p = await cargarPedido(q, req, req.params.id);
      const todos = (await q.query('select id from rep.pedido_items where pedido_id = $1', [p.id])).rows.map((i) => i.id);
      if (!todos.length) throw noEncontrado('El pedido no tiene items');
      const marcados = new Set(items_enviados);
      const seEnvian = todos.filter((id) => marcados.has(id));
      if (!seEnvian.length) throw malaPeticion('Marca al menos un insumo para despachar');
      await q.query('update rep.pedido_items set preparado = true, enviado = true where pedido_id = $1 and id = any($2::uuid[])', [p.id, seEnvian]);
      await q.query(`update rep.pedidos_insumos set estado = 'recibido' where id = $1`, [p.id]);   // el pedido se cierra siempre
      await auditar(q, req.ctx, 'pedido.despachar', 'pedido', p.id, { sucursal: p.sucursal_nombre, enviados: seEnvian.length, sin_enviar: todos.length - seEnvian.length }, { sucursalId: p.sucursal_id });
      return { ok: true, enviados: seEnvian.length, sinEnviar: todos.length - seEnvian.length, estado: 'recibido' };
    });
    res.json(out);
  });

  // Reabre un pedido ya despachado (deshacer un toque equivocado): vuelve exactamente a como estaba antes.
  r.patch('/:id/reabrir', requierePermiso('rep:despachar'), async (req, res) => {
    const b = validar(z.object({ estado: z.enum(['pedido', 'preparado', 'enviado'], { errorMap: () => ({ message: 'Estado inválido para reabrir' }) }).default('pedido'), items_preparados: z.array(uuid).default([]) }), req.body ?? {});
    await db.tx(async (q) => {
      const p = await cargarPedido(q, req, req.params.id);
      await q.query('update rep.pedidos_insumos set estado = $2 where id = $1', [p.id, b.estado]);
      await q.query('update rep.pedido_items set preparado = false, enviado = false where pedido_id = $1', [p.id]);
      if (b.items_preparados.length) await q.query('update rep.pedido_items set preparado = true where pedido_id = $1 and id = any($2::uuid[])', [p.id, b.items_preparados]);
      await auditar(q, req.ctx, 'pedido.reabrir', 'pedido', p.id, { sucursal: p.sucursal_nombre, estado: b.estado }, { sucursalId: p.sucursal_id });
    });
    res.json({ ok: true });
  });
  return r;
}
