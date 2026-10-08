import { Router } from 'express';
import { z } from 'zod';
import { requierePermiso, sucursalesPermitidas } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { noEncontrado, uuid, validar, dinero } from '../../lib/http.js';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable();
const esqProducto = z.object({
  codigo: z.string().trim().max(40).optional().nullable().transform((v) => v || null),
  codigo_barras: z.string().trim().max(60).optional().nullable().transform((v) => v || null),
  nombre: z.string().trim().min(2).max(120),
  descripcion: z.string().trim().max(400).optional().nullable(),
  categoria_id: uuid.optional().nullable(),
  precio: dinero,
  impuesto_tasa: z.coerce.number().refine((n) => [0, 0.15, 0.18].includes(n), 'La tasa solo puede ser 0, 0.15 o 0.18').default(0.15),
  exento: z.boolean().default(false),
  tipo: z.enum(['simple', 'receta', 'combo']).default('simple'),
  unidad: z.string().trim().max(20).default('unidad'),
  imagen: z.string().trim().max(500).optional().nullable(),
  color,
  tiempo_prep_min: z.coerce.number().int().min(0).max(240).optional().nullable(),
  orden: z.coerce.number().int().default(0),
  activo: z.boolean().default(true),
  disponible: z.boolean().default(true),
  grupo_ids: z.array(uuid).max(20).default([]),
});

export function rutasCatalogo({ db }) {
  const r = Router();

  // Todo lo que la caja necesita en UNA llamada (se cachea offline en el frontend).
  r.get('/', requierePermiso('pos:vender', 'pos:catalogo', 'pos:reportes'), async (req, res) => {
    const eid = req.ctx.empresa.id;
    const [cats, prods, pg, grupos, mods, fp, suc, pe] = await Promise.all([
      db.query('select id, nombre, color, orden from pos.categorias where empresa_id = $1 and activo order by orden, nombre', [eid]),
      db.query(`select id, codigo, codigo_barras, nombre, descripcion, categoria_id, precio, impuesto_tasa, exento, tipo, color, imagen, tiempo_prep_min, disponible
                  from pos.productos where empresa_id = $1 and activo order by orden, nombre`, [eid]),
      db.query('select producto_id, grupo_id from pos.producto_grupos pg join pos.productos p on p.id = pg.producto_id where p.empresa_id = $1 order by pg.orden', [eid]),
      db.query('select id, nombre, min_sel, max_sel from pos.modificador_grupos where empresa_id = $1 and activo order by orden, nombre', [eid]),
      db.query(`select m.id, m.grupo_id, m.nombre, m.precio_extra from pos.modificadores m join pos.modificador_grupos g on g.id = m.grupo_id
                 where g.empresa_id = $1 and m.activo and g.activo order by m.orden, m.nombre`, [eid]),
      db.query('select id, nombre, tipo from pos.formas_pago where empresa_id = $1 and activo order by orden', [eid]),
      sucursalesPermitidas(db, req.ctx),
      db.query(`select sucursal_id, es_borrador, cai, fecha_limite_emision, correlativo_actual, correlativo_hasta from pos.puntos_emision where empresa_id = $1 and activo`, [eid]),
    ]);
    res.json({
      categorias: cats.rows,
      productos: prods.rows.map((p) => ({ ...p, grupo_ids: pg.rows.filter((x) => x.producto_id === p.id).map((x) => x.grupo_id) })),
      grupos: grupos.rows.map((g) => ({ ...g, modificadores: mods.rows.filter((m) => m.grupo_id === g.id) })),
      formas_pago: fp.rows,
      sucursales: suc,
      fiscal: Object.fromEntries(pe.rows.map((p) => [p.sucursal_id, {
        borrador: p.es_borrador, restantes: p.correlativo_hasta - p.correlativo_actual + 1, vence: p.fecha_limite_emision }])),
    });
  });

  // ── Administración del catálogo ──────────────────────────────────────────
  const admin = Router();
  admin.use(requierePermiso('pos:catalogo'));

  admin.get('/productos', async (req, res) => {
    const { rows } = await db.query(
      `select p.*, c.nombre as categoria,
              coalesce((select array_agg(pg.grupo_id order by pg.orden) from pos.producto_grupos pg where pg.producto_id = p.id), '{}') as grupo_ids,
              cr.costo as costo_receta
         from pos.productos p left join pos.categorias c on c.id = p.categoria_id left join inv.costo_receta cr on cr.producto_id = p.id
        where p.empresa_id = $1 order by p.activo desc, c.nombre nulls last, p.orden, p.nombre`, [req.ctx.empresa.id]);
    res.json(rows);
  });

  async function guardarProducto(q, ctx, id, b) {
    if (b.categoria_id) {
      const c = await q.query('select 1 from pos.categorias where id = $1 and empresa_id = $2', [b.categoria_id, ctx.empresa.id]);
      if (!c.rowCount) throw noEncontrado('Categoría inexistente');
    }
    if (b.grupo_ids.length) {
      const g = await q.query('select id from pos.modificador_grupos where empresa_id = $1 and id = any($2::uuid[])', [ctx.empresa.id, b.grupo_ids]);
      if (g.rowCount !== new Set(b.grupo_ids).size) throw noEncontrado('Algún grupo de opciones no existe');
    }
    const vals = [b.codigo, b.codigo_barras, b.nombre, b.descripcion ?? null, b.categoria_id ?? null, b.precio, b.impuesto_tasa, b.exento, b.tipo,
      b.unidad, b.imagen ?? null, b.color ?? null, b.tiempo_prep_min ?? null, b.orden, b.activo, b.disponible];
    let p;
    if (id) {
      p = (await q.query(
        `update pos.productos set codigo=$3,codigo_barras=$4,nombre=$5,descripcion=$6,categoria_id=$7,precio=$8,impuesto_tasa=$9,exento=$10,tipo=$11,
                unidad=$12,imagen=$13,color=$14,tiempo_prep_min=$15,orden=$16,activo=$17,disponible=$18
          where id=$1 and empresa_id=$2 returning *`, [id, ctx.empresa.id, ...vals])).rows[0];
      if (!p) throw noEncontrado('Producto no encontrado');
    } else {
      p = (await q.query(
        `insert into pos.productos (empresa_id,codigo,codigo_barras,nombre,descripcion,categoria_id,precio,impuesto_tasa,exento,tipo,unidad,imagen,color,tiempo_prep_min,orden,activo,disponible)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning *`, [ctx.empresa.id, ...vals])).rows[0];
    }
    await q.query('delete from pos.producto_grupos where producto_id = $1', [p.id]);
    for (const [i, gid] of b.grupo_ids.entries()) await q.query('insert into pos.producto_grupos (producto_id, grupo_id, orden) values ($1,$2,$3)', [p.id, gid, i]);
    await auditar(q, ctx, id ? 'producto_editado' : 'producto_creado', 'producto', p.id, { nombre: p.nombre, precio: p.precio });
    return p;
  }
  admin.post('/productos', async (req, res) => res.status(201).json(await db.tx((q) => guardarProducto(q, req.ctx, null, validar(esqProducto, req.body)))));
  admin.put('/productos/:id', async (req, res) => res.json(await db.tx((q) => guardarProducto(q, req.ctx, validar(uuid, req.params.id), validar(esqProducto, req.body)))));
  // "Se acabó" rápido, sin tocar nada más
  r.patch('/productos/:id/disponible', requierePermiso('pos:catalogo', 'pos:vender'), async (req, res) => {
    const { disponible } = validar(z.object({ disponible: z.boolean() }), req.body);
    const { rowCount } = await db.query('update pos.productos set disponible = $3 where id = $1 and empresa_id = $2', [validar(uuid, req.params.id), req.ctx.empresa.id, disponible]);
    if (!rowCount) throw noEncontrado();
    res.json({ ok: true });
  });

  admin.get('/categorias', async (req, res) => res.json((await db.query('select * from pos.categorias where empresa_id = $1 order by orden, nombre', [req.ctx.empresa.id])).rows));
  const esqCat = z.object({ nombre: z.string().trim().min(2).max(60), color, orden: z.coerce.number().int().default(0), activo: z.boolean().default(true) });
  admin.post('/categorias', async (req, res) => {
    const b = validar(esqCat, req.body);
    const c = (await db.query('insert into pos.categorias (empresa_id, nombre, color, orden, activo) values ($1,$2,$3,$4,$5) returning *', [req.ctx.empresa.id, b.nombre, b.color ?? null, b.orden, b.activo])).rows[0];
    res.status(201).json(c);
  });
  admin.put('/categorias/:id', async (req, res) => {
    const b = validar(esqCat, req.body);
    const c = (await db.query('update pos.categorias set nombre=$3, color=$4, orden=$5, activo=$6 where id=$1 and empresa_id=$2 returning *', [validar(uuid, req.params.id), req.ctx.empresa.id, b.nombre, b.color ?? null, b.orden, b.activo])).rows[0];
    if (!c) throw noEncontrado();
    res.json(c);
  });

  // Grupos de modificadores (con sus opciones; se reemplazan en bloque)
  admin.get('/grupos', async (req, res) => {
    const g = await db.query('select * from pos.modificador_grupos where empresa_id = $1 order by orden, nombre', [req.ctx.empresa.id]);
    const m = await db.query('select m.* from pos.modificadores m join pos.modificador_grupos g on g.id = m.grupo_id where g.empresa_id = $1 order by m.orden, m.nombre', [req.ctx.empresa.id]);
    res.json(g.rows.map((x) => ({ ...x, modificadores: m.rows.filter((y) => y.grupo_id === x.id) })));
  });
  const esqGrupo = z.object({
    nombre: z.string().trim().min(2).max(60), min_sel: z.coerce.number().int().min(0).default(0), max_sel: z.coerce.number().int().min(1).default(1),
    orden: z.coerce.number().int().default(0), activo: z.boolean().default(true),
    modificadores: z.array(z.object({ id: uuid.optional(), nombre: z.string().trim().min(1).max(60), precio_extra: dinero.default(0), activo: z.boolean().default(true) })).max(60).default([]),
  }).refine((g) => g.min_sel <= g.max_sel, 'El mínimo no puede ser mayor al máximo');
  async function guardarGrupo(q, ctx, id, b) {
    let g;
    if (id) {
      g = (await q.query('update pos.modificador_grupos set nombre=$3,min_sel=$4,max_sel=$5,orden=$6,activo=$7 where id=$1 and empresa_id=$2 returning *', [id, ctx.empresa.id, b.nombre, b.min_sel, b.max_sel, b.orden, b.activo])).rows[0];
      if (!g) throw noEncontrado();
    } else {
      g = (await q.query('insert into pos.modificador_grupos (empresa_id,nombre,min_sel,max_sel,orden,activo) values ($1,$2,$3,$4,$5,$6) returning *', [ctx.empresa.id, b.nombre, b.min_sel, b.max_sel, b.orden, b.activo])).rows[0];
    }
    const conservar = b.modificadores.filter((m) => m.id).map((m) => m.id);
    // Las opciones que ya salieron en ventas se desactivan en vez de borrarse (el snapshot de la línea las conserva igual).
    await q.query('update pos.modificadores set activo = false where grupo_id = $1 and not (id = any($2::uuid[]))', [g.id, conservar]);
    for (const [i, m] of b.modificadores.entries()) {
      if (m.id) await q.query('update pos.modificadores set nombre=$3, precio_extra=$4, activo=$5, orden=$6 where id=$1 and grupo_id=$2', [m.id, g.id, m.nombre, m.precio_extra, m.activo, i]);
      else await q.query('insert into pos.modificadores (grupo_id,nombre,precio_extra,activo,orden) values ($1,$2,$3,$4,$5)', [g.id, m.nombre, m.precio_extra, m.activo, i]);
    }
    await auditar(q, ctx, id ? 'grupo_editado' : 'grupo_creado', 'grupo_modificadores', g.id, { nombre: g.nombre });
    return g;
  }
  admin.post('/grupos', async (req, res) => res.status(201).json(await db.tx((q) => guardarGrupo(q, req.ctx, null, validar(esqGrupo, req.body)))));
  admin.put('/grupos/:id', async (req, res) => res.json(await db.tx((q) => guardarGrupo(q, req.ctx, validar(uuid, req.params.id), validar(esqGrupo, req.body)))));

  // Formas de pago (ej. agregar "Tarjeta BAC", "Link de pago")
  admin.get('/formas-pago', async (req, res) => res.json((await db.query('select * from pos.formas_pago where empresa_id = $1 order by orden', [req.ctx.empresa.id])).rows));
  admin.post('/formas-pago', async (req, res) => {
    const b = validar(z.object({ nombre: z.string().trim().min(2).max(40), tipo: z.enum(['efectivo', 'tarjeta', 'transferencia', 'credito', 'otro']), orden: z.coerce.number().int().default(9) }), req.body);
    res.status(201).json((await db.query('insert into pos.formas_pago (empresa_id,nombre,tipo,orden) values ($1,$2,$3,$4) returning *', [req.ctx.empresa.id, b.nombre, b.tipo, b.orden])).rows[0]);
  });
  admin.put('/formas-pago/:id', async (req, res) => {
    const b = validar(z.object({ nombre: z.string().trim().min(2).max(40), orden: z.coerce.number().int().default(9), activo: z.boolean() }), req.body);
    const f = (await db.query('update pos.formas_pago set nombre=$3, orden=$4, activo=$5 where id=$1 and empresa_id=$2 returning *', [validar(uuid, req.params.id), req.ctx.empresa.id, b.nombre, b.orden, b.activo])).rows[0];
    if (!f) throw noEncontrado();
    res.json(f);
  });

  r.use('/admin', admin);
  return r;
}
