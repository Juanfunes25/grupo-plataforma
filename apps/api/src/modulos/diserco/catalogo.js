import { z } from 'zod';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { conflicto, malaPeticion, noEncontrado, uuid, validar } from '../../lib/http.js';
import { DISERCO } from './config.js';
import { enProyectosMapa, enteroPositivo, esAdmin, existenciasMapa, numeroOpc, sinCostosProducto, texto, veCostos } from './comun.js';
import { round2, round4 } from './calculo.js';

const LEE = ['inv:ver', 'cotizaciones:ver', 'pos:vender'];
export const UNIDADES = ['unidad', 'kit', 'galon', 'cubeta', 'saco', 'litro', 'm2', 'ml', 'pieza', 'caja', 'viaje', 'global'];

const esquemaProducto = z.object({
  nombre: z.string().trim().min(1, 'El nombre es obligatorio').max(200),
  codigo: texto(40), categoria_id: uuid.nullish().or(z.literal('').transform(() => null)),
  marca: texto(80), presentacion: texto(80), rendimiento_texto: texto(200), descripcion: texto(500),
  unidad_venta: z.string().trim().min(1).max(20).default('unidad'),
  precio: z.coerce.number({ invalid_type_error: 'Indica el precio de venta (sin ISV)' }).finite().min(0, 'Indica el precio de venta (sin ISV)').max(99_999_999),
  costo_estandar: z.coerce.number().finite().min(0).default(0),
  stock_minimo: z.coerce.number().int('El mínimo debe ser un número entero').min(0, 'El mínimo debe ser un número entero').default(0),
  controla_inventario: z.boolean().default(true), consumible: z.boolean().default(true), activo: z.boolean().default(true),
});

const SQL_PRODUCTOS = `
  select p.id, p.codigo, p.codigo_barras, p.nombre, p.descripcion, p.categoria_id, c.nombre as categoria, p.unidad as unidad_venta, p.activo,
         p.stock_minimo, p.impuesto_tasa, p.precio as precio_con_isv, x.precio_sin_isv as precio, x.marca, x.presentacion, x.rendimiento_texto,
         x.consumible, x.controla_inventario, x.costo_estandar
    from pos.productos p join dis.producto_ext x on x.producto_id = p.id left join pos.categorias c on c.id = p.categoria_id
   where p.empresa_id = $1`;

export function rutasCatalogo(r, { db }) {
  async function conExistencia(q, ctx, filas) {
    const [hay, fuera] = await Promise.all([existenciasMapa(q, ctx.empresa.id), esAdmin(ctx) ? enProyectosMapa(q, ctx.empresa.id) : new Map()]);
    return filas.map((p) => {
      const proyectos = fuera.get(p.id) ?? [];
      const en_proyectos = proyectos.reduce((s, x) => s + x.cantidad, 0);
      const existencia = hay.get(p.id) ?? 0;
      return sinCostosProducto({
        ...p, precio: Number(p.precio), precio_con_isv: Number(p.precio_con_isv), costo_estandar: Number(p.costo_estandar), stock_minimo: Number(p.stock_minimo),
        existencia, en_proyectos, proyectos, total: existencia + en_proyectos,
        bajo_minimo: p.controla_inventario && Number(p.stock_minimo) > 0 && existencia <= Number(p.stock_minimo),
      }, ctx);
    });
  }

  r.get('/categorias', requierePermiso(...LEE), async (req, res) => {
    res.json((await db.query('select id, nombre from pos.categorias where empresa_id = $1 and activo order by orden, nombre', [req.ctx.empresa.id])).rows);
  });

  r.get('/formas-pago', requierePermiso(...LEE), async (req, res) => {
    res.json((await db.query('select id, nombre, tipo from pos.formas_pago where empresa_id = $1 and activo order by orden', [req.ctx.empresa.id])).rows);
  });

  r.get('/productos', requierePermiso(...LEE), async (req, res) => {
    const todos = req.query.incluirInactivos === 'true';
    const { rows } = await db.query(`${SQL_PRODUCTOS} ${todos ? '' : 'and p.activo'} order by p.nombre`, [req.ctx.empresa.id]);
    res.json(await conExistencia(db, req.ctx, rows));
  });

  async function validarCategoria(q, ctx, id) {
    if (!id) return;
    const { rows } = await q.query('select 1 from pos.categorias where id = $1 and empresa_id = $2', [id, ctx.empresa.id]);
    if (!rows.length) throw malaPeticion('Esa categoría no existe en DISERCO');
  }
  async function codigoLibre(q, ctx, codigo, idActual = null) {
    if (!codigo) return;
    const { rows } = await q.query('select id from pos.productos where empresa_id = $1 and codigo = $2 and ($3::uuid is null or id <> $3)', [ctx.empresa.id, codigo, idActual]);
    if (rows.length) throw conflicto('Ya existe un producto con ese código');
  }
  const conIsv = (sin, tasa = DISERCO.tasaIsv) => round2(sin * (1 + Number(tasa)));

  r.post('/productos', requierePermiso('pos:catalogo'), async (req, res) => {
    const b = validar(esquemaProducto, req.body);
    const id = await db.tx(async (q) => {
      await validarCategoria(q, req.ctx, b.categoria_id);
      await codigoLibre(q, req.ctx, b.codigo);
      const p = (await q.query(
        `insert into pos.productos (empresa_id, codigo, nombre, descripcion, categoria_id, precio, impuesto_tasa, tipo, unidad, stock_minimo, activo)
         values ($1,$2,$3,$4,$5,$6,0.15,'simple',$7,$8,$9) returning id`,
        [req.ctx.empresa.id, b.codigo, b.nombre, b.descripcion, b.categoria_id ?? null, conIsv(b.precio), b.unidad_venta, b.stock_minimo, b.activo])).rows[0];
      await q.query(
        `insert into dis.producto_ext (producto_id, empresa_id, marca, presentacion, rendimiento_texto, consumible, controla_inventario, precio_sin_isv, costo_estandar)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [p.id, req.ctx.empresa.id, b.marca, b.presentacion, b.rendimiento_texto, b.consumible, b.controla_inventario, round4(b.precio), b.costo_estandar]);
      await auditar(q, req.ctx, 'producto_creado', 'producto', p.id, { nombre: b.nombre, empresa: 'diserco', precio: b.precio });
      return p.id;
    });
    const { rows } = await db.query(`${SQL_PRODUCTOS} and p.id = $2`, [req.ctx.empresa.id, id]);
    res.status(201).json((await conExistencia(db, req.ctx, rows))[0]);
  });

  r.put('/productos/:id', requierePermiso('pos:catalogo'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    await db.tx(async (q) => {
      const antes = (await q.query(`${SQL_PRODUCTOS} and p.id = $2 for update of p`, [req.ctx.empresa.id, id])).rows[0];
      if (!antes) throw noEncontrado('Producto no encontrado');
      const b = validar(esquemaProducto, { ...antes, precio: antes.precio, categoria_id: antes.categoria_id, ...req.body });
      await validarCategoria(q, req.ctx, b.categoria_id);
      await codigoLibre(q, req.ctx, b.codigo, id);
      await q.query(
        `update pos.productos set codigo=$2, nombre=$3, descripcion=$4, categoria_id=$5, precio=$6, unidad=$7, stock_minimo=$8, activo=$9 where id=$1`,
        [id, b.codigo, b.nombre, b.descripcion, b.categoria_id ?? null, conIsv(b.precio, antes.impuesto_tasa), b.unidad_venta, b.stock_minimo, b.activo]);
      await q.query(
        `update dis.producto_ext set marca=$2, presentacion=$3, rendimiento_texto=$4, consumible=$5, controla_inventario=$6, precio_sin_isv=$7, costo_estandar=$8 where producto_id=$1`,
        [id, b.marca, b.presentacion, b.rendimiento_texto, b.consumible, b.controla_inventario, round4(b.precio), b.costo_estandar]);
      const cambios = {};
      for (const k of ['nombre', 'codigo', 'categoria_id', 'marca', 'presentacion', 'rendimiento_texto', 'unidad_venta', 'precio', 'costo_estandar', 'stock_minimo', 'controla_inventario', 'consumible', 'activo']) {
        if (String(antes[k] ?? '') !== String(b[k] ?? '')) cambios[k] = { antes: antes[k], despues: b[k] };
      }
      if (Object.keys(cambios).length) await auditar(q, req.ctx, 'producto_editado', 'producto', id, { nombre: b.nombre, empresa: 'diserco', cambios });
    });
    const { rows } = await db.query(`${SQL_PRODUCTOS} and p.id = $2`, [req.ctx.empresa.id, id]);
    res.json((await conExistencia(db, req.ctx, rows))[0]);
  });

  // Eliminar definitivo (solo si no tiene historial) o desactivar.
  r.delete('/productos/:id', requierePermiso('pos:catalogo'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const definitivo = req.query.definitivo === '1';
    await db.tx(async (q) => {
      const p = (await q.query('select id, nombre from pos.productos where id = $1 and empresa_id = $2 for update', [id, req.ctx.empresa.id])).rows[0];
      if (!p) throw noEncontrado('Producto no encontrado');
      if (!definitivo) {
        await q.query('update pos.productos set activo = false where id = $1', [id]);
        return auditar(q, req.ctx, 'producto_desactivado', 'producto', id, { nombre: p.nombre, empresa: 'diserco' });
      }
      const { rows } = await q.query(
        `select (select count(*) from pos.detalle_venta where producto_id = $1)
              + (select count(*) from dis.cotizacion_lineas where producto_id = $1)
              + (select count(*) from dis.salida_items where producto_id = $1)
              + (select count(*) from dis.movimientos where producto_id = $1 and tipo <> 'inicial') as n`, [id]);
      if (Number(rows[0].n) > 0) {
        const e = conflicto(`“${p.nombre}” ya tiene ventas, cotizaciones o movimientos: no se puede eliminar.`);
        e.codigo = 'CON_HISTORIAL';
        throw e;
      }
      await q.query('delete from dis.movimientos where producto_id = $1', [id]);
      await q.query('delete from pos.productos where id = $1', [id]);
      await auditar(q, req.ctx, 'producto_eliminado', 'producto', id, { nombre: p.nombre, empresa: 'diserco' });
    });
    res.status(204).end();
  });

  // ── Inventario ─────────────────────────────────────────────────────────────
  r.get('/inventario', requierePermiso('inv:ver', 'dis:salidas'), async (req, res) => {
    const { rows } = await db.query(`${SQL_PRODUCTOS} and p.activo and x.controla_inventario order by p.nombre`, [req.ctx.empresa.id]);
    const filas = await conExistencia(db, req.ctx, rows);
    res.json(veCostos(req.ctx) ? filas : filas.map(({ precio, precio_con_isv, ...resto }) => resto));
  });

  r.get('/inventario/kardex', requierePermiso('inv:ver'), async (req, res) => {
    const pid = req.query.producto_id ? validar(uuid, req.query.producto_id) : null;
    const { rows } = await db.query(
      `select m.id, m.created_at, m.tipo, m.cantidad, m.costo_unitario, m.motivo, m.proveedor, m.referencia, m.producto_id, p.nombre as producto, u.nombre as usuario
         from dis.movimientos m join pos.productos p on p.id = m.producto_id left join core.usuarios u on u.id = m.usuario_id
        where m.empresa_id = $1 and ($2::uuid is null or m.producto_id = $2) order by m.created_at desc, m.id desc limit 300`, [req.ctx.empresa.id, pid]);
    res.json(rows.map((m) => ({ ...m, cantidad: Number(m.cantidad), costo_unitario: veCostos(req.ctx) ? Number(m.costo_unitario) : undefined })));
  });

  // compra / inicial: entran unidades (con costo sin ISV); ajuste: suma o resta con motivo.
  r.post('/inventario/movimiento', requierePermiso('inv:mover'), async (req, res) => {
    const b = validar(z.object({
      producto_id: uuid, tipo: z.enum(['compra', 'inicial', 'ajuste'], { errorMap: () => ({ message: 'Tipo de movimiento inválido' }) }),
      cantidad: numeroOpc, costo: z.coerce.number().min(0).default(0), motivo: texto(200), proveedor: texto(120), referencia: texto(80),
    }), req.body);
    const cantidad = enteroPositivo(b.cantidad, 'La cantidad debe ser un número entero distinto de cero');
    if (b.tipo !== 'ajuste' && cantidad < 0) throw malaPeticion('Una compra o existencia inicial debe ser positiva');
    if (b.tipo !== 'ajuste' && !(b.costo > 0)) throw malaPeticion('Indica el costo unitario (sin ISV)');
    if (b.tipo === 'ajuste' && !b.motivo) throw malaPeticion('Indica el motivo del ajuste');
    const id = await db.tx(async (q) => {
      const p = (await q.query(
        `select p.nombre, x.controla_inventario from pos.productos p join dis.producto_ext x on x.producto_id = p.id where p.id = $1 and p.empresa_id = $2`, [b.producto_id, req.ctx.empresa.id])).rows[0];
      if (!p) throw noEncontrado('Producto no encontrado');
      if (!p.controla_inventario) throw malaPeticion('Este producto no controla inventario');
      const mid = (await q.query('select dis.mover($1,$2,$3,$4,$5,$6,null,$7,$8,$9,false,null) as id', [
        req.ctx.empresa.id, b.producto_id, b.tipo, cantidad, b.tipo === 'ajuste' ? 0 : b.costo, b.motivo ?? (b.tipo === 'compra' ? 'Compra' : 'Existencia inicial'), b.proveedor, b.referencia, req.ctx.usuario.id])).rows[0].id;
      await auditar(q, req.ctx, `inventario_${b.tipo}`, 'producto', b.producto_id, { producto: p.nombre, cantidad, costo: b.costo, motivo: b.motivo, empresa: 'diserco' });
      return mid;
    });
    res.status(201).json({ id });
  });
}
