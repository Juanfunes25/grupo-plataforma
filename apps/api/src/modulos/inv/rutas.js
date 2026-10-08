import { Router } from 'express';
import { z } from 'zod';
import { fechaHN, sumarDias } from '@grupo/shared';
import { requierePermiso, resolverSucursal } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { malaPeticion, noEncontrado, uuid, validar, dinero, fechaISO } from '../../lib/http.js';

const cant = z.coerce.number().positive().max(1_000_000);

export function rutasInv({ db }) {
  const r = Router();

  // ── Insumos ──────────────────────────────────────────────────────────────
  r.get('/insumos', requierePermiso('inv:ver'), async (req, res) => {
    const { sucursal_id } = validar(z.object({ sucursal_id: uuid.optional() }), req.query);
    const { rows } = await db.query(
      `select i.*, coalesce(st.cantidad, 0)::numeric as stock, p.nombre as proveedor,
              (select min(l.vence_at) from inv.lotes l where l.insumo_id = i.id and l.cantidad_actual > 0 and l.vence_at is not null
                  and ($2::uuid is null or l.sucursal_id = $2) and ($3::uuid[] = '{}' or l.sucursal_id = any($3::uuid[]))) as proximo_vencimiento
         from inv.insumos i
         left join core.terceros p on p.id = i.proveedor_id
         left join lateral (select sum(m.cantidad) as cantidad from inv.movimientos m
                             where m.insumo_id = i.id and ($2::uuid is null or m.sucursal_id = $2) and ($3::uuid[] = '{}' or m.sucursal_id = any($3::uuid[]))) st on true
        where i.empresa_id = $1 order by i.activo desc, i.categoria nulls last, i.nombre`,
      [req.ctx.empresa.id, sucursal_id ?? null, req.ctx.sucursalIds]);
    res.json(rows.map((i) => ({ ...i, bajo_minimo: i.stock <= i.stock_minimo, negativo: i.stock < 0 })));
  });

  const esqInsumo = z.object({
    codigo: z.string().trim().max(40).optional().nullable().transform((v) => v || null),
    nombre: z.string().trim().min(2).max(120), categoria: z.string().trim().max(60).optional().nullable(),
    unidad: z.string().trim().min(1).max(20).default('kg'), costo_actual: dinero.default(0), stock_minimo: dinero.default(0),
    perecedero: z.boolean().default(false), vida_util_dias: z.coerce.number().int().min(0).max(3650).optional().nullable(),
    proveedor_id: uuid.optional().nullable(), activo: z.boolean().default(true),
  });
  r.post('/insumos', requierePermiso('inv:mover'), async (req, res) => {
    const b = validar(esqInsumo, req.body);
    const i = (await db.query(
      `insert into inv.insumos (empresa_id,codigo,nombre,categoria,unidad,costo_actual,stock_minimo,perecedero,vida_util_dias,proveedor_id,activo)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [req.ctx.empresa.id, b.codigo, b.nombre, b.categoria ?? null, b.unidad, b.costo_actual, b.stock_minimo, b.perecedero, b.vida_util_dias ?? null, b.proveedor_id ?? null, b.activo])).rows[0];
    await auditar(db, req.ctx, 'insumo_creado', 'insumo', i.id, { nombre: i.nombre });
    res.status(201).json(i);
  });
  r.put('/insumos/:id', requierePermiso('inv:mover'), async (req, res) => {
    const b = validar(esqInsumo, req.body);
    const i = (await db.query(
      `update inv.insumos set codigo=$3,nombre=$4,categoria=$5,unidad=$6,costo_actual=$7,stock_minimo=$8,perecedero=$9,vida_util_dias=$10,proveedor_id=$11,activo=$12
        where id=$1 and empresa_id=$2 returning *`,
      [validar(uuid, req.params.id), req.ctx.empresa.id, b.codigo, b.nombre, b.categoria ?? null, b.unidad, b.costo_actual, b.stock_minimo, b.perecedero, b.vida_util_dias ?? null, b.proveedor_id ?? null, b.activo])).rows[0];
    if (!i) throw noEncontrado();
    res.json(i);
  });

  // ── Vencimientos y movimientos ───────────────────────────────────────────
  r.get('/vencimientos', requierePermiso('inv:ver'), async (req, res) => {
    const { dias } = validar(z.object({ dias: z.coerce.number().int().min(0).max(120).default(5) }), req.query);
    const { rows } = await db.query(
      `select l.id, i.nombre as insumo, i.unidad, s.nombre as sucursal, l.cantidad_actual, l.vence_at::text, l.recibido_at,
              (l.vence_at - (now() at time zone 'America/Tegucigalpa')::date) as dias_restantes
         from inv.lotes l join inv.insumos i on i.id = l.insumo_id join core.sucursales s on s.id = l.sucursal_id
        where l.empresa_id = $1 and l.cantidad_actual > 0 and l.vence_at is not null and l.vence_at <= $2::date
          and ($3::uuid[] = '{}' or l.sucursal_id = any($3::uuid[])) order by l.vence_at`,
      [req.ctx.empresa.id, sumarDias(fechaHN(), dias), req.ctx.sucursalIds]);
    res.json(rows);
  });
  r.get('/movimientos', requierePermiso('inv:ver'), async (req, res) => {
    const f = validar(z.object({ insumo_id: uuid.optional(), tipo: z.string().max(30).optional(), limite: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    const { rows } = await db.query(
      `select m.id, m.created_at, i.nombre as insumo, i.unidad, s.nombre as sucursal, m.tipo, m.cantidad, m.costo_total, m.motivo, u.nombre as usuario, m.referencia_tipo
         from inv.movimientos m join inv.insumos i on i.id = m.insumo_id join core.sucursales s on s.id = m.sucursal_id left join core.usuarios u on u.id = m.usuario_id
        where m.empresa_id = $1 and ($2::uuid is null or m.insumo_id = $2) and ($3::text is null or m.tipo = $3) and ($4::uuid[] = '{}' or m.sucursal_id = any($4::uuid[]))
        order by m.id desc limit $5`, [req.ctx.empresa.id, f.insumo_id ?? null, f.tipo ?? null, req.ctx.sucursalIds, f.limite]);
    res.json(rows);
  });

  async function insumoDe(q, ctx, id) {
    const i = (await q.query('select * from inv.insumos where id = $1 and empresa_id = $2', [id, ctx.empresa.id])).rows[0];
    if (!i) throw noEncontrado('Insumo no encontrado');
    return i;
  }

  // ── Compras (entra mercancía con lote, costo y vencimiento) ──────────────
  r.post('/compras', requierePermiso('inv:mover'), async (req, res) => {
    const b = validar(z.object({
      sucursal_id: uuid.optional(), proveedor_id: uuid.optional().nullable(), numero_documento: z.string().trim().max(40).optional().nullable(),
      fecha: fechaISO.optional(), isv: dinero.default(0), notas: z.string().trim().max(300).optional().nullable(),
      items: z.array(z.object({ insumo_id: uuid, cantidad: cant, costo_unitario: dinero, vence_at: fechaISO.optional().nullable() })).min(1, 'La compra no tiene líneas').max(200),
    }), req.body);
    const out = await db.tx(async (q) => {
      const suc = await resolverSucursal(q, req.ctx, b.sucursal_id);
      const subtotal = Math.round(b.items.reduce((s, i) => s + i.cantidad * i.costo_unitario, 0) * 100) / 100;
      const c = (await q.query(
        `insert into inv.compras (empresa_id,sucursal_id,proveedor_id,numero_documento,fecha,subtotal,isv,total,notas,usuario_id)
         values ($1,$2,$3,$4,coalesce($5::date, (now() at time zone 'America/Tegucigalpa')::date),$6,$7,$8,$9,$10) returning *`,
        [req.ctx.empresa.id, suc.id, b.proveedor_id ?? null, b.numero_documento ?? null, b.fecha ?? null, subtotal, b.isv, subtotal + b.isv, b.notas ?? null, req.ctx.usuario.id])).rows[0];
      for (const it of b.items) {
        const ins = await insumoDe(q, req.ctx, it.insumo_id);
        // Perecederos sin fecha: se estima con la vida útil del insumo.
        const vence = it.vence_at ?? (ins.perecedero && ins.vida_util_dias ? sumarDias(c.fecha, ins.vida_util_dias) : null);
        await q.query('insert into inv.compra_items (compra_id,insumo_id,cantidad,costo_unitario,vence_at) values ($1,$2,$3,$4,$5)', [c.id, it.insumo_id, it.cantidad, it.costo_unitario, vence]);
        await q.query('select inv.ingresar($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11,$12)',
          [req.ctx.empresa.id, suc.id, it.insumo_id, it.cantidad, it.costo_unitario, 'compra', vence, 'compra', c.id, b.numero_documento ?? 'Compra', req.ctx.usuario.id, c.id]);
      }
      await auditar(q, req.ctx, 'compra_registrada', 'compra', c.id, { total: c.total, lineas: b.items.length }, { sucursalId: suc.id });
      return c;
    });
    res.status(201).json(out);
  });
  r.get('/compras', requierePermiso('inv:ver'), async (req, res) => {
    const { rows } = await db.query(
      `select c.*, s.nombre as sucursal, p.nombre as proveedor from inv.compras c join core.sucursales s on s.id = c.sucursal_id left join core.terceros p on p.id = c.proveedor_id
        where c.empresa_id = $1 and ($2::uuid[] = '{}' or c.sucursal_id = any($2::uuid[])) order by c.fecha desc, c.created_at desc limit 100`, [req.ctx.empresa.id, req.ctx.sucursalIds]);
    res.json(rows);
  });

  // ── Merma (fruta dañada, vencida, derrame…) ─────────────────────────────
  r.post('/mermas', requierePermiso('inv:mover'), async (req, res) => {
    const b = validar(z.object({
      sucursal_id: uuid.optional(), insumo_id: uuid, cantidad: cant,
      motivo: z.enum(['maduracion', 'dano', 'vencido', 'derrame', 'sobreproduccion', 'degustacion', 'otro']),
      nota: z.string().trim().max(200).optional().nullable(),
    }), req.body);
    const out = await db.tx(async (q) => {
      const suc = await resolverSucursal(q, req.ctx, b.sucursal_id);
      const ins = await insumoDe(q, req.ctx, b.insumo_id);
      const costo = (await q.query('select inv.descontar($1,$2,$3,$4,$5,$6,$7,$8,$9) as costo',
        [req.ctx.empresa.id, suc.id, ins.id, b.cantidad, 'merma', 'merma', null, b.nota ? `${b.motivo}: ${b.nota}` : b.motivo, req.ctx.usuario.id])).rows[0].costo;
      await auditar(q, req.ctx, 'merma_registrada', 'insumo', ins.id, { cantidad: b.cantidad, motivo: b.motivo, costo }, { sucursalId: suc.id });
      return { ok: true, costo };
    });
    res.status(201).json(out);
  });

  // ── Conteo físico: ajusta el sistema a lo contado ────────────────────────
  r.post('/ajustes', requierePermiso('inv:mover'), async (req, res) => {
    const b = validar(z.object({
      sucursal_id: uuid.optional(), motivo: z.string().trim().min(3).max(200).default('Conteo físico'),
      conteos: z.array(z.object({ insumo_id: uuid, cantidad_real: z.coerce.number().min(0).max(1_000_000) })).min(1).max(500),
    }), req.body);
    const out = await db.tx(async (q) => {
      const suc = await resolverSucursal(q, req.ctx, b.sucursal_id);
      const resultado = [];
      for (const c of b.conteos) {
        const ins = await insumoDe(q, req.ctx, c.insumo_id);
        const sistema = Number((await q.query('select coalesce(sum(cantidad),0) as s from inv.movimientos where insumo_id = $1 and sucursal_id = $2', [ins.id, suc.id])).rows[0].s);
        const dif = Math.round((c.cantidad_real - sistema) * 1000) / 1000;
        if (dif > 0) await q.query('select inv.ingresar($1,$2,$3,$4,$5,$6,null,$7,null,$8,$9)', [req.ctx.empresa.id, suc.id, ins.id, dif, ins.costo_actual, 'ajuste', 'conteo', b.motivo, req.ctx.usuario.id]);
        else if (dif < 0) await q.query('select inv.descontar($1,$2,$3,$4,$5,$6,null,$7,$8)', [req.ctx.empresa.id, suc.id, ins.id, -dif, 'ajuste', 'conteo', b.motivo, req.ctx.usuario.id]);
        resultado.push({ insumo_id: ins.id, nombre: ins.nombre, sistema, contado: c.cantidad_real, diferencia: dif, valor: Math.round(dif * ins.costo_actual * 100) / 100 });
      }
      await auditar(q, req.ctx, 'conteo_inventario', 'sucursal', suc.id, { motivo: b.motivo, diferencias: resultado.filter((x) => x.diferencia !== 0).length }, { sucursalId: suc.id });
      return resultado;
    });
    res.json(out);
  });

  // ── Traslado entre sucursales de la misma empresa ────────────────────────
  r.post('/traslados', requierePermiso('inv:mover'), async (req, res) => {
    const b = validar(z.object({ origen_id: uuid, destino_id: uuid, insumo_id: uuid, cantidad: cant, nota: z.string().trim().max(200).optional().nullable() }), req.body);
    if (b.origen_id === b.destino_id) throw malaPeticion('El origen y el destino son la misma sucursal');
    const out = await db.tx(async (q) => {
      const o = await resolverSucursal(q, req.ctx, b.origen_id);
      const d = (await q.query('select * from core.sucursales where id = $1 and empresa_id = $2 and activo', [b.destino_id, req.ctx.empresa.id])).rows[0];
      if (!d) throw noEncontrado('Sucursal destino no encontrada');
      const ins = await insumoDe(q, req.ctx, b.insumo_id);
      const costo = Number((await q.query('select inv.descontar($1,$2,$3,$4,$5,$6,null,$7,$8) as c', [req.ctx.empresa.id, o.id, ins.id, b.cantidad, 'traslado_salida', 'traslado', b.nota ?? `A ${d.nombre}`, req.ctx.usuario.id])).rows[0].c);
      await q.query('select inv.ingresar($1,$2,$3,$4,$5,$6,null,$7,null,$8,$9)', [req.ctx.empresa.id, d.id, ins.id, b.cantidad, costo / b.cantidad, 'traslado_entrada', 'traslado', b.nota ?? `De ${o.nombre}`, req.ctx.usuario.id]);
      await auditar(q, req.ctx, 'traslado', 'insumo', ins.id, { de: o.nombre, a: d.nombre, cantidad: b.cantidad }, { sucursalId: o.id });
      return { ok: true, costo };
    });
    res.status(201).json(out);
  });

  // ── Recetas y costo/margen por producto ──────────────────────────────────
  r.get('/recetas', requierePermiso('inv:ver', 'inv:recetas'), async (req, res) => {
    const { rows } = await db.query(
      `select p.id, p.nombre, p.precio, p.impuesto_tasa, p.exento, c.nombre as categoria, cr.costo,
              (select count(*)::int from inv.receta_items ri where ri.producto_id = p.id) as ingredientes
         from pos.productos p left join pos.categorias c on c.id = p.categoria_id left join inv.costo_receta cr on cr.producto_id = p.id
        where p.empresa_id = $1 and p.activo order by c.nombre nulls last, p.nombre`, [req.ctx.empresa.id]);
    res.json(rows.map((p) => {
      const neto = p.impuesto_tasa > 0 ? p.precio / (1 + p.impuesto_tasa) : p.precio;
      return { ...p, precio_neto: Math.round(neto * 100) / 100, margen_pct: p.costo != null && neto > 0 ? Math.round(((neto - p.costo) / neto) * 1000) / 10 : null };
    }));
  });
  r.get('/recetas/:producto_id', requierePermiso('inv:ver', 'inv:recetas'), async (req, res) => {
    const pid = validar(uuid, req.params.producto_id);
    const p = (await db.query('select id from pos.productos where id = $1 and empresa_id = $2', [pid, req.ctx.empresa.id])).rows[0];
    if (!p) throw noEncontrado();
    const { rows } = await db.query(
      `select ri.insumo_id, i.nombre, i.unidad, ri.cantidad, ri.merma_pct, (ri.cantidad * (1 + ri.merma_pct/100) * i.costo_actual)::numeric(14,4) as costo
         from inv.receta_items ri join inv.insumos i on i.id = ri.insumo_id where ri.producto_id = $1 order by i.nombre`, [pid]);
    res.json(rows);
  });
  r.put('/recetas/:producto_id', requierePermiso('inv:recetas'), async (req, res) => {
    const pid = validar(uuid, req.params.producto_id);
    const b = validar(z.object({ items: z.array(z.object({ insumo_id: uuid, cantidad: z.coerce.number().positive().max(100000), merma_pct: z.coerce.number().min(0).max(99).default(0) })).max(60) }), req.body);
    await db.tx(async (q) => {
      const p = (await q.query('select id, nombre from pos.productos where id = $1 and empresa_id = $2', [pid, req.ctx.empresa.id])).rows[0];
      if (!p) throw noEncontrado();
      const ids = b.items.map((i) => i.insumo_id);
      if (new Set(ids).size !== ids.length) throw malaPeticion('Un insumo está repetido en la receta');
      if (ids.length) {
        const ok = await q.query('select count(*)::int as n from inv.insumos where empresa_id = $1 and id = any($2::uuid[])', [req.ctx.empresa.id, ids]);
        if (ok.rows[0].n !== ids.length) throw noEncontrado('Algún insumo no existe');
      }
      await q.query('delete from inv.receta_items where producto_id = $1', [pid]);
      for (const it of b.items) await q.query('insert into inv.receta_items (producto_id,insumo_id,cantidad,merma_pct) values ($1,$2,$3,$4)', [pid, it.insumo_id, it.cantidad, it.merma_pct]);
      await q.query(`update pos.productos set tipo = case when $2 then 'receta' else 'simple' end where id = $1 and tipo <> 'combo'`, [pid, b.items.length > 0]);
      await auditar(q, req.ctx, 'receta_editada', 'producto', pid, { nombre: p.nombre, ingredientes: b.items.length });
    });
    res.json({ ok: true });
  });
  r.get('/modificadores/:id/consumo', requierePermiso('inv:ver', 'inv:recetas'), async (req, res) => {
    const { rows } = await db.query(
      `select mc.insumo_id, i.nombre, i.unidad, mc.cantidad from inv.modificador_consumo mc join inv.insumos i on i.id = mc.insumo_id
         join pos.modificadores m on m.id = mc.modificador_id join pos.modificador_grupos g on g.id = m.grupo_id
        where mc.modificador_id = $1 and g.empresa_id = $2`, [validar(uuid, req.params.id), req.ctx.empresa.id]);
    res.json(rows);
  });
  r.put('/modificadores/:id/consumo', requierePermiso('inv:recetas'), async (req, res) => {
    const mid = validar(uuid, req.params.id);
    const b = validar(z.object({ items: z.array(z.object({ insumo_id: uuid, cantidad: z.coerce.number().positive().max(100000) })).max(20) }), req.body);
    await db.tx(async (q) => {
      const m = await q.query('select 1 from pos.modificadores m join pos.modificador_grupos g on g.id = m.grupo_id where m.id = $1 and g.empresa_id = $2', [mid, req.ctx.empresa.id]);
      if (!m.rowCount) throw noEncontrado();
      await q.query('delete from inv.modificador_consumo where modificador_id = $1', [mid]);
      for (const it of b.items) {
        await insumoDe(q, req.ctx, it.insumo_id);
        await q.query('insert into inv.modificador_consumo (modificador_id,insumo_id,cantidad) values ($1,$2,$3)', [mid, it.insumo_id, it.cantidad]);
      }
    });
    res.json({ ok: true });
  });

  // ── Valor del inventario y alertas (para el tablero) ─────────────────────
  r.get('/resumen', requierePermiso('inv:ver'), async (req, res) => {
    const { rows } = await db.query(
      `select s.id as sucursal_id, s.nombre as sucursal,
              coalesce(sum(greatest(st.cantidad,0) * i.costo_actual),0)::numeric(14,2) as valor,
              count(*) filter (where st.cantidad <= i.stock_minimo)::int as bajo_minimo,
              count(*) filter (where st.cantidad < 0)::int as negativos
         from core.sucursales s
         left join inv.stock st on st.sucursal_id = s.id left join inv.insumos i on i.id = st.insumo_id
        where s.empresa_id = $1 and s.activo and ($2::uuid[] = '{}' or s.id = any($2::uuid[])) group by s.id, s.nombre, s.orden order by s.orden`, [req.ctx.empresa.id, req.ctx.sucursalIds]);
    res.json(rows);
  });

  return r;
}
