import { Router } from 'express';
import { z } from 'zod';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { ErrorHttp, noEncontrado, uuid, validar } from '../../lib/http.js';

export const UNIDADES = ['m2', 'caja', 'pieza', 'ml', 'saco', 'galon', 'unidad', 'viaje', 'global'];
export const TIPOS = ['piedra', 'accesorio', 'servicio', 'otro'];
const CATEGORIA_DE = { piedra: 'Piedra', accesorio: 'Accesorios', servicio: 'Servicios', otro: 'Servicios' };

const numOpc = (max = 1_000_000) => z.preprocess((v) => (v === '' || v === undefined || v === null ? null : v), z.coerce.number().min(0).max(max).nullable());
const texto = (max) => z.string().trim().max(max).optional().nullable().transform((v) => v || null);

const esqProducto = z.object({
  tipo: z.enum(TIPOS).default('piedra'),
  nombre: z.string().trim().min(2, 'Escribe el nombre del producto').max(120),
  codigo: texto(40), modelo: texto(80), color: texto(60), descripcion: texto(400),
  unidad_venta: z.enum(UNIDADES).default('m2'),
  m2_por_caja: numOpc(10_000), piezas_por_m2: numOpc(10_000), peso_kg_m2: numOpc(100_000), rendimiento_m2: numOpc(100_000), stock_minimo_m2: numOpc(10_000_000),
  precio: z.coerce.number().min(0).max(99_999_999).default(0),
  impuesto_tasa: z.coerce.number().refine((n) => [0, 0.15, 0.18].includes(n), 'La tasa solo puede ser 0, 0.15 o 0.18').default(0.15),
  activo: z.boolean().default(true),
});

const COLS = `p.id, p.codigo, p.nombre, p.descripcion, p.precio, p.impuesto_tasa, p.exento, p.activo, p.color, p.modelo, p.unidad_venta, p.m2_por_caja,
       p.piezas_por_m2, p.costo_estandar, p.stock_minimo as stock_minimo_m2, x.tipo, x.peso_kg_m2, x.rendimiento_m2`;

/** Valores de fábrica de los parámetros comerciales de EcoStone (core.config 'eco' los pisa). */
export const PARAMETROS_DEFECTO = {
  desperdicio_default_pct: 0, vigencia_cotizacion_dias: 15, anticipo_pct_default: 0, descuento_max_vendedor_pct: 5, descuento_max_gerente_pct: 15, dias_a_inventario: 5,
};
export async function parametros(q, empresaId) {
  const { rows } = await q.query(`select clave, valor from core.config where empresa_id = $1 and clave in ('eco','fab')`, [empresaId]);
  const fab = rows.find((r) => r.clave === 'fab')?.valor ?? {};
  const eco = rows.find((r) => r.clave === 'eco')?.valor ?? {};
  return { ...PARAMETROS_DEFECTO, ...(fab.dias_a_inventario != null ? { dias_a_inventario: fab.dias_a_inventario } : {}), ...eco };
}

export function rutasCatalogoEco({ db }) {
  const r = Router();
  const leer = requierePermiso('pos:catalogo', 'pos:vender', 'cotizaciones:ver', 'inv:ver');
  const editar = requierePermiso('pos:catalogo');

  r.get('/productos', leer, async (req, res) => {
    const todos = req.query.incluirInactivos === 'true';
    const ver = req.ctx.permisos.has('pos:catalogo');
    const { rows } = await db.query(
      `select ${COLS} from pos.productos p join eco.producto_ext x on x.producto_id = p.id
        where p.empresa_id = $1 ${todos ? '' : 'and p.activo'} order by x.tipo, p.nombre`, [req.ctx.empresa.id]);
    res.json(rows.map((p) => (ver ? p : { ...p, costo_estandar: undefined })));
  });

  async function categoriaId(q, empresaId, tipo) {
    const nombre = CATEGORIA_DE[tipo];
    const c = (await q.query('select id from pos.categorias where empresa_id = $1 and nombre = $2', [empresaId, nombre])).rows[0];
    if (c) return c.id;
    return (await q.query('insert into pos.categorias (empresa_id, nombre, orden) values ($1,$2,9) returning id', [empresaId, nombre])).rows[0].id;
  }

  async function guardar(q, ctx, id, b) {
    const catId = await categoriaId(q, ctx.empresa.id, b.tipo);
    const esPiedra = b.tipo === 'piedra';
    const vals = [b.codigo, b.nombre, b.descripcion, catId, b.precio, b.impuesto_tasa, b.unidad_venta, esPiedra, b.modelo, b.color, esPiedra ? b.m2_por_caja : null,
      esPiedra ? b.piezas_por_m2 : null, b.stock_minimo_m2 ?? 0, b.activo];
    let antes = null, p;
    if (id) {
      antes = (await q.query('select precio, nombre from pos.productos where id = $1 and empresa_id = $2', [id, ctx.empresa.id])).rows[0];
      if (!antes) throw noEncontrado('Producto no encontrado');
      await q.query(
        `update pos.productos set codigo=$3,nombre=$4,descripcion=$5,categoria_id=$6,precio=$7,impuesto_tasa=$8,unidad=$9::text,unidad_venta=$9::text,es_piedra=$10,modelo=$11,color=$12,
                m2_por_caja=$13,piezas_por_m2=$14,stock_minimo=$15,activo=$16 where id=$1 and empresa_id=$2`, [id, ctx.empresa.id, ...vals]);
      p = { id };
    } else {
      p = (await q.query(
        `insert into pos.productos (empresa_id,codigo,nombre,descripcion,categoria_id,precio,impuesto_tasa,unidad,unidad_venta,es_piedra,modelo,color,m2_por_caja,piezas_por_m2,stock_minimo,activo)
         values ($1,$2,$3,$4,$5,$6,$7,$8::text,$8::text,$9,$10,$11,$12,$13,$14,$15) returning id`,
        [ctx.empresa.id, b.codigo, b.nombre, b.descripcion, catId, b.precio, b.impuesto_tasa, b.unidad_venta, esPiedra, b.modelo, b.color,
          esPiedra ? b.m2_por_caja : null, esPiedra ? b.piezas_por_m2 : null, b.stock_minimo_m2 ?? 0, b.activo])).rows[0];
    }
    await q.query(
      `insert into eco.producto_ext (producto_id, empresa_id, tipo, peso_kg_m2, rendimiento_m2) values ($1,$2,$3,$4,$5)
       on conflict (producto_id) do update set tipo = excluded.tipo, peso_kg_m2 = excluded.peso_kg_m2, rendimiento_m2 = excluded.rendimiento_m2`,
      [p.id, ctx.empresa.id, b.tipo, esPiedra ? b.peso_kg_m2 : null, b.tipo === 'accesorio' ? b.rendimiento_m2 : null]);
    if (!id) await auditar(q, ctx, 'producto_creado', 'producto', p.id, { nombre: b.nombre, precio: b.precio, tipo: b.tipo });
    else {
      await auditar(q, ctx, 'producto_editado', 'producto', p.id, { nombre: b.nombre, precio: b.precio });
      if (Number(b.precio) < Number(antes.precio)) {
        await auditar(q, ctx, 'precio_baja', 'producto', p.id, { producto: b.nombre, antes: Number(antes.precio), despues: b.precio, lista: 'Público' });
      }
    }
    return (await q.query(`select ${COLS} from pos.productos p join eco.producto_ext x on x.producto_id = p.id where p.id = $1`, [p.id])).rows[0];
  }
  const dup = (e) => { if (e?.code === '23505') throw new ErrorHttp(409, 'Ya existe un producto con ese código', 'duplicado'); throw e; };
  r.post('/productos', editar, async (req, res) => {
    const b = validar(esqProducto, req.body);
    res.status(201).json(await db.tx((q) => guardar(q, req.ctx, null, b)).catch(dup));
  });
  r.put('/productos/:id', editar, async (req, res) => {
    const b = validar(esqProducto, req.body);
    res.json(await db.tx((q) => guardar(q, req.ctx, validar(uuid, req.params.id), b)).catch(dup));
  });

  // Desactivar, o borrar de verdad (?definitivo=1) solo si nunca se usó.
  r.delete('/productos/:id', editar, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const p = (await db.query('select id, nombre from pos.productos where id = $1 and empresa_id = $2', [id, req.ctx.empresa.id])).rows[0];
    if (!p) throw noEncontrado('Producto no encontrado');
    if (req.query.definitivo === '1') {
      try { await db.query('delete from pos.productos where id = $1', [id]); }
      catch (e) {
        if (e?.code === '23503') throw new ErrorHttp(409, `“${p.nombre}” ya tiene facturas, cotizaciones, movimientos o producción: no se puede eliminar. Puedes desactivarlo para que no aparezca más.`, 'CON_HISTORIAL');
        throw e;
      }
      await auditar(db, req.ctx, 'producto_eliminado', 'producto', id, { nombre: p.nombre });
    } else {
      await db.query('update pos.productos set activo = false where id = $1', [id]);
      await auditar(db, req.ctx, 'producto_desactivado', 'producto', id, { nombre: p.nombre });
    }
    res.status(204).end();
  });

  // ── Listas de precio ─────────────────────────────────────────────────────
  r.get('/listas-precio', leer, async (req, res) => {
    res.json((await db.query('select * from eco.listas_precio where empresa_id = $1 and activo order by orden', [req.ctx.empresa.id])).rows);
  });
  r.get('/listas-precio/precios', leer, async (req, res) => {
    res.json((await db.query(
      `select pp.producto_id, pp.lista_id, pp.precio from eco.precios_producto pp join eco.listas_precio l on l.id = pp.lista_id where l.empresa_id = $1`, [req.ctx.empresa.id])).rows);
  });
  r.put('/listas-precio/precios', editar, async (req, res) => {
    const b = validar(z.object({ producto_id: uuid, lista_id: uuid, precio: z.coerce.number().min(0).max(99_999_999) }), req.body);
    const out = await db.tx(async (q) => {
      const prod = (await q.query('select nombre from pos.productos where id = $1 and empresa_id = $2', [b.producto_id, req.ctx.empresa.id])).rows[0];
      const lista = (await q.query('select nombre from eco.listas_precio where id = $1 and empresa_id = $2', [b.lista_id, req.ctx.empresa.id])).rows[0];
      if (!prod || !lista) throw noEncontrado('Producto o lista inexistente');
      const antes = (await q.query('select precio from eco.precios_producto where producto_id = $1 and lista_id = $2', [b.producto_id, b.lista_id])).rows[0];
      const fila = (await q.query(
        `insert into eco.precios_producto (producto_id, lista_id, precio) values ($1,$2,$3)
         on conflict (producto_id, lista_id) do update set precio = excluded.precio returning *`, [b.producto_id, b.lista_id, b.precio])).rows[0];
      await auditar(q, req.ctx, 'precio_editado', 'producto', b.producto_id, { producto: prod.nombre, lista: lista.nombre, antes: antes ? Number(antes.precio) : null, despues: b.precio });
      if (antes && b.precio < Number(antes.precio)) await auditar(q, req.ctx, 'precio_baja', 'producto', b.producto_id, { producto: prod.nombre, lista: lista.nombre, antes: Number(antes.precio), despues: b.precio });
      return fila;
    });
    res.json(out);
  });

  // ── Zonas de flete ───────────────────────────────────────────────────────
  r.get('/zonas-flete', leer, async (req, res) => {
    res.json((await db.query('select * from eco.zonas_flete where empresa_id = $1 and activo order by nombre', [req.ctx.empresa.id])).rows);
  });
  const esqZona = z.object({ nombre: z.string().trim().min(1, 'Indica el nombre de la zona').max(80), tarifa: z.coerce.number().min(0).max(9_999_999).default(0), activo: z.boolean().default(true) });
  r.post('/zonas-flete', editar, async (req, res) => {
    const b = validar(esqZona, req.body);
    try { res.status(201).json((await db.query('insert into eco.zonas_flete (empresa_id, nombre, tarifa) values ($1,$2,$3) returning *', [req.ctx.empresa.id, b.nombre, b.tarifa])).rows[0]); }
    catch (e) { if (e?.code === '23505') throw new ErrorHttp(409, 'Ya existe esa zona', 'duplicado'); throw e; }
  });
  r.put('/zonas-flete/:id', editar, async (req, res) => {
    const b = validar(esqZona, req.body);
    const z1 = (await db.query('update eco.zonas_flete set nombre=$3, tarifa=$4, activo=$5 where id=$1 and empresa_id=$2 returning *', [validar(uuid, req.params.id), req.ctx.empresa.id, b.nombre, b.tarifa, b.activo])).rows[0];
    if (!z1) throw noEncontrado();
    res.json(z1);
  });

  // Clientes del directorio común con sus datos comerciales de EcoStone (tipo de cliente y lista de precio)
  r.get('/clientes', leer, async (req, res) => {
    const q = String(req.query.q ?? '').trim().slice(0, 60);
    const { rows } = await db.query(
      `select t.id, t.nombre, t.rtn, t.telefono, t.correo as email, t.direccion, t.exento_impuestos, x.tipo_cliente, x.lista_precio_id, x.limite_credito, x.dias_credito
         from core.terceros t left join eco.cliente_ext x on x.tercero_id = t.id
        where t.activo and t.es_cliente and not t.es_consumidor_final
          and ($1 = '' or t.nombre ilike '%'||$1||'%' or t.rtn like $1||'%' or t.telefono like '%'||$1||'%' or t.correo ilike '%'||$1||'%')
        order by t.nombre limit 8`, [q]);
    res.json(rows);
  });

  r.get('/parametros', leer, async (req, res) => res.json(await parametros(db, req.ctx.empresa.id)));

  return r;
}
