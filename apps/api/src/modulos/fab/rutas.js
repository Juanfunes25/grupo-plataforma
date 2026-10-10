import { Router } from 'express';
import { z } from 'zod';
import { fechaHN, sumarDias } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { conflicto, malaPeticion, noEncontrado, prohibido, uuid, validar, fechaISO } from '../../lib/http.js';
import {
  PARAMETROS, actualizarCostoEstandar, alerta, colarOrden, costoDeReceta, crearOrden, iniciarLiberacionAutomatica, liberarVencidos, num, parametros, round2, round3, terminarOrden,
} from './produccion.js';

const CATEGORIAS = ['cemento', 'arena', 'agregado', 'aditivo', 'pigmento', 'desmoldante', 'sellador', 'fibra', 'empaque', 'molde', 'otro'];
const PRUEBAS = ['Inspección visual y color', 'Dimensiones y espesor', 'Peso por m²', 'Absorción de agua (ASTM C1670)', 'Resistencia a compresión', 'Adherencia (bond) al mortero', 'Eflorescencia', 'Consistencia de la mezcla'];
const dec = z.coerce.number().finite().min(0).max(999_999_999);
const textoOpc = (n = 300) => z.string().trim().max(n).optional().nullable().transform((v) => v || null);
const idOpc = uuid.optional().nullable().or(z.literal('').transform(() => null));
const entero = (x) => Number.isInteger(x);

/** Rutas /api/fab — solo en empresas con el módulo `fabrica` (EcoStone). */
export function rutasFab({ db, config }) {
  const r = Router();
  if (config?.driver !== 'pglite' && process.env.NODE_ENV !== 'test') iniciarLiberacionAutomatica(db);

  r.use((req, _res, next) => {
    if (!req.ctx.empresa.modulos.includes('fabrica')) throw prohibido(`${req.ctx.empresa.nombre} no tiene el módulo de fabricación`);
    next();
  });
  // Las producciones que cumplieron sus días pasan solas a «lista para vender» al abrir cualquier pantalla.
  r.use(async (req, _res, next) => { if (req.method === 'GET') await liberarVencidos(db, req.ctx.empresa.id).catch(() => {}); next(); });

  const empresa = (req) => req.ctx.empresa.id;
  const verCostos = (req) => req.ctx.permisos.has('fab:editar');
  const puedeTerminar = (req) => req.ctx.permisos.has('fab:editar') || req.ctx.rol === 'bodega';

  // ═════════════════════════ Parámetros ═════════════════════════
  r.get('/parametros', requierePermiso('fab:ver', 'inv:ver'), async (req, res) => {
    const p = await parametros(db, empresa(req));
    res.json(Object.entries(PARAMETROS).map(([clave, d]) => ({ clave, texto: d.texto, valor: p[clave] })));
  });
  r.put('/parametros/:clave', requierePermiso('fab:editar'), async (req, res) => {
    const clave = req.params.clave;
    if (!(clave in PARAMETROS)) throw noEncontrado('Parámetro no encontrado');
    const { valor } = validar(z.object({ valor: dec }), req.body);
    const antes = (await parametros(db, empresa(req)))[clave];
    await db.query(
      `insert into core.config (empresa_id, clave, valor) values ($1,'fab',jsonb_build_object($2::text,$3::numeric))
       on conflict (empresa_id, clave) do update set valor = core.config.valor || jsonb_build_object($2::text,$3::numeric), updated_at = now()`, [empresa(req), clave, valor]);
    await auditar(db, req.ctx, 'parametro.editar', 'parametro', clave, { antes, despues: valor });
    res.json({ clave, valor });
  });

  // ═════════════════════════ Proveedores ═════════════════════════
  const esqProv = z.object({
    nombre: z.string().trim().min(1, 'El nombre del proveedor es obligatorio').max(160), rtn: textoOpc(30), contacto: textoOpc(120), telefono: textoOpc(40), email: textoOpc(120),
    dias_credito: z.coerce.number().int().min(0).max(365).default(0), notas: textoOpc(300), activo: z.boolean().optional(),
  });
  r.get('/proveedores', requierePermiso('fab:ver', 'inv:ver'), async (req, res) => {
    res.json((await db.query('select * from fab.proveedores where empresa_id = $1 order by nombre', [empresa(req)])).rows);
  });
  r.post('/proveedores', requierePermiso('inv:mover'), async (req, res) => {
    const b = validar(esqProv, req.body);
    const p = (await db.query(
      'insert into fab.proveedores (empresa_id,nombre,rtn,contacto,telefono,email,dias_credito,notas) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *',
      [empresa(req), b.nombre, b.rtn, b.contacto, b.telefono, b.email, b.dias_credito, b.notas])).rows[0];
    await auditar(db, req.ctx, 'proveedor.crear', 'proveedor', p.id, { nombre: p.nombre });
    res.status(201).json(p);
  });
  r.put('/proveedores/:id', requierePermiso('inv:mover'), async (req, res) => {
    const b = validar(esqProv, req.body);
    const p = (await db.query(
      `update fab.proveedores set nombre=$3,rtn=$4,contacto=$5,telefono=$6,email=$7,dias_credito=$8,notas=$9,activo=coalesce($10,activo) where id=$1 and empresa_id=$2 returning *`,
      [validar(uuid, req.params.id), empresa(req), b.nombre, b.rtn, b.contacto, b.telefono, b.email, b.dias_credito, b.notas, b.activo ?? null])).rows[0];
    if (!p) throw noEncontrado();
    res.json(p);
  });

  // ═════════════════════════ Insumos (materias primas) ═════════════════════════
  r.get('/insumos', requierePermiso('fab:ver', 'inv:ver'), async (req, res) => {
    const { rows } = await db.query(
      `select i.*, coalesce(s.stock,0) as stock, p.nombre as proveedor
         from fab.insumos i left join fab.stock_insumos s on s.insumo_id = i.id left join fab.proveedores p on p.id = i.proveedor_id
        where i.empresa_id = $1 order by i.categoria, i.nombre`, [empresa(req)]);
    const tc = (await parametros(db, empresa(req))).tipo_cambio_usd;
    const costos = verCostos(req);
    res.json(rows.map((m) => {
      const stock = num(m.stock);
      const o = { ...m, stock, bajo_minimo: num(m.stock_minimo) > 0 && stock < num(m.stock_minimo), negativo: stock < 0 };
      if (!costos) { delete o.costo_promedio; return o; }
      return { ...o, costo_promedio: num(m.costo_promedio), valor_inventario: round2(stock * num(m.costo_promedio)), costo_usd: m.moneda === 'USD' && tc ? Math.round((num(m.costo_promedio) / tc) * 10000) / 10000 : null };
    }));
  });
  const esqInsumo = z.object({
    codigo: z.string().trim().max(40).optional().nullable().transform((v) => v || null), nombre: z.string().trim().min(1, 'El nombre del insumo es obligatorio').max(160),
    categoria: z.enum(CATEGORIAS, { errorMap: () => ({ message: 'Categoría inválida' }) }).default('otro'), unidad: z.string().trim().min(1).max(20).default('kg'),
    moneda: z.enum(['HNL', 'USD']).default('HNL'), stock_minimo: dec.default(0), proveedor_id: idOpc, notas: textoOpc(300), activo: z.boolean().optional(),
  });
  r.post('/insumos', requierePermiso('inv:mover'), async (req, res) => {
    const b = validar(esqInsumo, req.body);
    const i = (await db.query(
      `insert into fab.insumos (empresa_id,codigo,nombre,categoria,unidad,moneda,stock_minimo,proveedor_id,notas) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [empresa(req), b.codigo, b.nombre, b.categoria, b.unidad, b.moneda, b.stock_minimo, b.proveedor_id ?? null, b.notas])).rows[0];
    await auditar(db, req.ctx, 'insumo.crear', 'insumo', i.id, { nombre: i.nombre });
    res.status(201).json(i);
  });
  r.put('/insumos/:id', requierePermiso('inv:mover'), async (req, res) => {
    const b = validar(esqInsumo, req.body);
    const i = (await db.query(
      `update fab.insumos set codigo=$3,nombre=$4,categoria=$5,unidad=$6,moneda=$7,stock_minimo=$8,proveedor_id=$9,notas=$10,activo=coalesce($11,activo) where id=$1 and empresa_id=$2 returning *`,
      [validar(uuid, req.params.id), empresa(req), b.codigo, b.nombre, b.categoria, b.unidad, b.moneda, b.stock_minimo, b.proveedor_id ?? null, b.notas, b.activo ?? null])).rows[0];
    if (!i) throw noEncontrado();
    res.json(i);
  });

  // Compra, ajuste, merma o devolución. Todo cambio de stock deja kardex.
  r.post('/insumos/:id/movimiento', requierePermiso('inv:mover'), async (req, res) => {
    const b = validar(z.object({
      tipo: z.enum(['compra', 'ajuste', 'merma', 'devolucion', 'inicial'], { errorMap: () => ({ message: 'Tipo de movimiento inválido' }) }),
      cantidad: z.coerce.number().finite(), costo_unitario: z.coerce.number().finite().min(0).optional().nullable(), moneda: z.enum(['HNL', 'USD']).default('HNL'),
      proveedor_id: idOpc, documento: textoOpc(60), motivo: textoOpc(200),
    }), req.body);
    if (['compra', 'ajuste', 'inicial'].includes(b.tipo) && req.ctx.rol === 'produccion') throw prohibido();
    let cant = b.cantidad;
    if (!(cant !== 0)) throw malaPeticion('Indica la cantidad');
    if (!entero(cant)) throw malaPeticion('La cantidad debe ser un número entero');
    if (['compra', 'inicial'].includes(b.tipo)) {
      cant = Math.abs(cant);
      if (!(num(b.costo_unitario, -1) >= 0)) throw malaPeticion('Indica el costo unitario de la compra');
    }
    if (['merma', 'devolucion'].includes(b.tipo)) cant = -Math.abs(cant);
    if (['ajuste', 'merma', 'devolucion'].includes(b.tipo) && !b.motivo) throw malaPeticion('El motivo es obligatorio');
    const tc = (await parametros(db, empresa(req))).tipo_cambio_usd;
    const out = await db.tx(async (q) => {
      const mov = (await q.query('select * from fab.mover_insumo($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,null,$11,false)',
        [empresa(req), validar(uuid, req.params.id), b.tipo, cant, b.costo_unitario ?? null, b.moneda, b.moneda === 'USD' ? tc : 1, b.proveedor_id ?? null, b.documento, b.motivo, req.ctx.usuario.id])).rows[0];
      const mp = (await q.query('select nombre, unidad from fab.insumos where id = $1', [mov.insumo_id])).rows[0];
      await auditar(q, req.ctx, `insumo.${b.tipo}`, 'insumo', mov.insumo_id, { insumo: mp.nombre, cantidad: cant, unidad: mp.unidad, costo_unitario: mov.costo_unitario, documento: b.documento, motivo: b.motivo });
      if (['ajuste', 'merma'].includes(b.tipo)) {
        const n = num((await q.query(
          `select count(*) as n from fab.mov_insumos where empresa_id = $1 and usuario_id = $2 and tipo in ('ajuste','merma') and created_at >= now() - interval '7 days'`, [empresa(req), req.ctx.usuario.id])).rows[0].n);
        if (n >= 3) await alerta(q, req.ctx, { tipo: 'inventario.ajustes_repetidos', titulo: `${req.ctx.usuario.nombre} lleva ${n} ajustes/mermas de insumos en 7 días`, entidad: 'insumo', entidadId: mov.insumo_id, detalle: { insumo: mp.nombre, ultimo_motivo: b.motivo } });
      }
      return mov;
    });
    res.status(201).json(out);
  });
  r.get('/insumos/:id/kardex', requierePermiso('fab:ver', 'inv:ver'), async (req, res) => {
    const { rows } = await db.query(
      `select m.*, p.nombre as proveedor, u.nombre as usuario from fab.mov_insumos m left join fab.proveedores p on p.id = m.proveedor_id left join core.usuarios u on u.id = m.usuario_id
        where m.empresa_id = $1 and m.insumo_id = $2 order by m.id desc limit 200`, [empresa(req), validar(uuid, req.params.id)]);
    const costos = verCostos(req);
    res.json(rows.map((k) => ({ ...k, cantidad: num(k.cantidad), costo_unitario: costos ? num(k.costo_unitario) : undefined })));
  });

  // ═════════════════════════ Productos de piedra (para recetas, órdenes y registro) ═════════════════════════
  r.get('/productos', requierePermiso('fab:ver', 'fab:registrar'), async (req, res) => {
    const { rows } = await db.query(
      `select id, nombre, modelo, color, unidad_venta, m2_por_caja, precio, costo_estandar, activo from pos.productos where empresa_id = $1 and es_piedra and activo order by modelo nulls last, color nulls last, nombre`, [empresa(req)]);
    res.json(rows.map((p) => ({ ...p, precio: num(p.precio), costo_estandar: num(p.costo_estandar), m2_por_caja: p.m2_por_caja == null ? null : num(p.m2_por_caja) })));
  });

  // ═════════════════════════ Recetas ═════════════════════════
  r.get('/recetas', requierePermiso('costeo:ver'), async (req, res) => {
    const recetas = (await db.query(
      `select r.*, p.nombre as producto, p.modelo, p.color, p.precio, p.impuesto_tasa from fab.recetas r join pos.productos p on p.id = r.producto_id where r.empresa_id = $1 order by r.created_at desc`, [empresa(req)])).rows;
    const items = recetas.length ? (await db.query(
      `select ri.receta_id, ri.insumo_id, ri.cantidad_m2, i.nombre, i.unidad, i.categoria, i.costo_promedio from fab.receta_items ri join fab.insumos i on i.id = ri.insumo_id where ri.receta_id = any($1::uuid[]) order by i.nombre`,
      [recetas.map((x) => x.id)])).rows : [];
    res.json(recetas.map((x) => {
      const its = items.filter((i) => i.receta_id === x.id).map((i) => ({ ...i, cantidad_m2: num(i.cantidad_m2), costo_promedio: num(i.costo_promedio) }));
      const costo = costoDeReceta(x, its);
      const precioNeto = num(x.precio) / (1 + num(x.impuesto_tasa, 0.15));
      return { ...x, precio: num(x.precio), items: its, costo, margen_pct_publico: precioNeto > 0 ? round2(((precioNeto - costo.total_m2) / precioNeto) * 100) : null };
    }));
  });
  async function guardarItems(q, empresaId, recetaId, items) {
    const limpios = (items ?? []).filter((i) => i.insumo_id && num(i.cantidad_m2) > 0);
    if (!limpios.length) throw malaPeticion('La receta necesita al menos un insumo con cantidad por m²');
    if (new Set(limpios.map((i) => i.insumo_id)).size !== limpios.length) throw malaPeticion('Un insumo está repetido en la receta');
    await q.query('delete from fab.receta_items where receta_id = $1', [recetaId]);
    for (const i of limpios) {
      const ok = (await q.query('select 1 from fab.insumos where id = $1 and empresa_id = $2', [i.insumo_id, empresaId])).rowCount;
      if (!ok) throw malaPeticion('Insumo no válido en la receta');
      await q.query('insert into fab.receta_items (receta_id, insumo_id, cantidad_m2) values ($1,$2,$3)', [recetaId, i.insumo_id, num(i.cantidad_m2)]);
    }
  }
  const esqReceta = z.object({
    producto_id: uuid, nombre: z.string().trim().min(1, 'Producto y nombre de la receta son obligatorios').max(120),
    merma_esperada_pct: z.coerce.number().min(0).max(100).default(5), mano_obra_m2: dec.default(0), indirectos_m2: dec.default(0), notas: textoOpc(300),
    items: z.array(z.object({ insumo_id: uuid.or(z.literal('')), cantidad_m2: z.coerce.number().min(0) })).default([]),
  });
  r.post('/recetas', requierePermiso('costeo:ver'), async (req, res) => {
    const b = validar(esqReceta, req.body);
    const out = await db.tx(async (q) => {
      const prod = (await q.query('select 1 from pos.productos where id = $1 and empresa_id = $2 and es_piedra', [b.producto_id, empresa(req)])).rowCount;
      if (!prod) throw malaPeticion('Producto no válido');
      await q.query('update fab.recetas set activa = false where producto_id = $1 and activa', [b.producto_id]);
      const rec = (await q.query(
        'insert into fab.recetas (empresa_id,producto_id,nombre,merma_esperada_pct,mano_obra_m2,indirectos_m2,notas) values ($1,$2,$3,$4,$5,$6,$7) returning *',
        [empresa(req), b.producto_id, b.nombre, b.merma_esperada_pct, b.mano_obra_m2, b.indirectos_m2, b.notas])).rows[0];
      await guardarItems(q, empresa(req), rec.id, b.items);
      const costo = await actualizarCostoEstandar(q, empresa(req), b.producto_id);
      await auditar(q, req.ctx, 'receta.crear', 'receta', rec.id, { nombre: rec.nombre, costo_m2: costo?.total_m2 });
      return { ...rec, costo };
    });
    res.status(201).json(out);
  });
  r.put('/recetas/:id', requierePermiso('costeo:ver'), async (req, res) => {
    const b = validar(esqReceta.partial().extend({ activa: z.boolean().optional() }), req.body);
    const out = await db.tx(async (q) => {
      const antes = (await q.query('select * from fab.recetas where id = $1 and empresa_id = $2 for update', [validar(uuid, req.params.id), empresa(req)])).rows[0];
      if (!antes) throw noEncontrado('Receta no encontrada');
      if (b.activa === true && !antes.activa) await q.query('update fab.recetas set activa = false where producto_id = $1 and activa', [antes.producto_id]);
      const rec = (await q.query(
        `update fab.recetas set nombre=coalesce($2,nombre), merma_esperada_pct=coalesce($3,merma_esperada_pct), mano_obra_m2=coalesce($4,mano_obra_m2),
           indirectos_m2=coalesce($5,indirectos_m2), notas=coalesce($6,notas), activa=coalesce($7,activa) where id=$1 returning *`,
        [antes.id, b.nombre ?? null, b.merma_esperada_pct ?? null, b.mano_obra_m2 ?? null, b.indirectos_m2 ?? null, b.notas ?? null, b.activa ?? null])).rows[0];
      if (b.items) await guardarItems(q, empresa(req), rec.id, b.items);
      const costo = await actualizarCostoEstandar(q, empresa(req), rec.producto_id);
      await auditar(q, req.ctx, 'receta.editar', 'receta', rec.id, { nombre: rec.nombre, costo_m2: costo?.total_m2 });
      return { ...rec, costo };
    });
    res.json(out);
  });

  // ═════════════════════════ Moldes ═════════════════════════
  r.get('/moldes', requierePermiso('fab:ver'), async (req, res) => {
    const { rows } = await db.query('select m.*, p.nombre as producto from fab.moldes m left join pos.productos p on p.id = m.producto_id where m.empresa_id = $1 order by m.codigo', [empresa(req)]);
    res.json(rows.map((m) => ({ ...m, m2_por_colada: num(m.m2_por_colada), vida_restante: m.vida_util_usos - m.usos, por_reemplazar: m.vida_util_usos > 0 && m.usos >= m.vida_util_usos * 0.9 })));
  });
  const esqMolde = z.object({
    codigo: z.string().trim().min(1, 'Código y nombre del molde son obligatorios').max(40), nombre: z.string().trim().min(1, 'Código y nombre del molde son obligatorios').max(120), producto_id: idOpc,
    piezas_por_colada: z.coerce.number().int().min(1).default(1), m2_por_colada: dec.default(0), vida_util_usos: z.coerce.number().int().min(0).default(300),
    estado: z.enum(['activo', 'mantenimiento', 'baja']).optional(), notas: textoOpc(300),
  });
  r.post('/moldes', requierePermiso('fab:registrar'), async (req, res) => {
    const b = validar(esqMolde, req.body);
    const m = (await db.query(
      'insert into fab.moldes (empresa_id,codigo,nombre,producto_id,piezas_por_colada,m2_por_colada,vida_util_usos,notas) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *',
      [empresa(req), b.codigo, b.nombre, b.producto_id ?? null, b.piezas_por_colada, b.m2_por_colada, b.vida_util_usos, b.notas]).catch((e) => { if (e.code === '23505') throw conflicto('Ya existe un molde con ese código'); throw e; })).rows[0];
    await auditar(db, req.ctx, 'molde.crear', 'molde', m.id, { codigo: m.codigo });
    res.status(201).json(m);
  });
  r.put('/moldes/:id', requierePermiso('fab:registrar'), async (req, res) => {
    const b = validar(esqMolde.partial(), req.body);
    const m = (await db.query(
      `update fab.moldes set nombre=coalesce($3,nombre), producto_id=case when $4::boolean then $5 else producto_id end, piezas_por_colada=coalesce($6,piezas_por_colada),
         m2_por_colada=coalesce($7,m2_por_colada), vida_util_usos=coalesce($8,vida_util_usos), estado=coalesce($9,estado), notas=coalesce($10,notas) where id=$1 and empresa_id=$2 returning *`,
      [validar(uuid, req.params.id), empresa(req), b.nombre ?? null, 'producto_id' in b, b.producto_id ?? null, b.piezas_por_colada ?? null, b.m2_por_colada ?? null, b.vida_util_usos ?? null, b.estado ?? null, b.notas ?? null])).rows[0];
    if (!m) throw noEncontrado();
    res.json(m);
  });

  // ═════════════════════════ Órdenes de producción ═════════════════════════
  r.get('/ordenes', requierePermiso('fab:ver'), async (req, res) => {
    const estados = String(req.query.estado ?? '').split(',').filter(Boolean);
    const { rows } = await db.query(
      `select o.*, p.nombre as producto, p.modelo, p.color, mo.codigo as molde, u.nombre as responsable from fab.ordenes o join pos.productos p on p.id = o.producto_id
         left join fab.moldes mo on mo.id = o.molde_id left join core.usuarios u on u.id = o.responsable_id
        where o.empresa_id = $1 and ($2::text[] = '{}' or o.estado = any($2::text[])) order by o.created_at desc limit 300`, [empresa(req), estados]);
    const hoy = fechaHN();
    res.json(rows.map((o) => ({ ...o, m2_planificado: num(o.m2_planificado), m2_bueno: o.m2_bueno == null ? null : num(o.m2_bueno), atrasada: o.estado === 'planificada' && o.fecha_programada && String(o.fecha_programada).slice(0, 10) < hoy })));
  });
  async function ordenCompleta(req, id) {
    const o = (await db.query(
      `select o.*, p.nombre as producto, p.modelo, p.color, p.m2_por_caja, p.unidad_venta, mo.codigo as molde, mo.m2_por_colada, rc.nombre as receta
         from fab.ordenes o join pos.productos p on p.id = o.producto_id left join fab.moldes mo on mo.id = o.molde_id left join fab.recetas rc on rc.id = o.receta_id
        where o.id = $1 and o.empresa_id = $2`, [id, empresa(req)])).rows[0];
    if (!o) throw noEncontrado('Orden no encontrada');
    const consumos = (await db.query(
      `select c.*, i.nombre, i.unidad, i.categoria, coalesce(s.stock,0) as stock from fab.orden_consumos c join fab.insumos i on i.id = c.insumo_id left join fab.stock_insumos s on s.insumo_id = i.id
        where c.orden_id = $1 order by i.nombre`, [o.id])).rows;
    const calidad = (await db.query('select c.*, u.nombre as usuario from fab.controles_calidad c left join core.usuarios u on u.id = c.usuario_id where c.orden_id = $1 order by c.created_at', [o.id])).rows;
    const costos = verCostos(req);
    return {
      ...o, m2_planificado: num(o.m2_planificado),
      consumos: consumos.map((c) => ({ ...c, teorico: num(c.teorico), real: c.real == null ? null : num(c.real), stock: num(c.stock), alcanza: num(c.stock) >= num(c.teorico), costo_unitario: costos ? num(c.costo_unitario) : undefined })),
      calidad: calidad.map((c) => ({ ...c, valor: c.valor == null ? null : num(c.valor) })),
      costo_mp: costos ? o.costo_mp : null, costo_total: costos ? o.costo_total : null, costo_m2: costos ? o.costo_m2 : null, costo_mano_obra: costos ? o.costo_mano_obra : null, costo_indirectos: costos ? o.costo_indirectos : null,
    };
  }
  r.get('/ordenes/:id', requierePermiso('fab:ver'), async (req, res) => res.json(await ordenCompleta(req, validar(uuid, req.params.id))));

  r.post('/ordenes', requierePermiso('fab:registrar'), async (req, res) => {
    const b = validar(z.object({ producto_id: uuid, m2_planificado: z.coerce.number().positive().max(100_000), fecha_programada: fechaISO.optional().nullable().or(z.literal('').transform(() => null)), molde_id: idOpc, notas: textoOpc(300), responsable_id: idOpc }), req.body);
    if (!entero(b.m2_planificado)) throw malaPeticion('La cantidad a producir debe ser un número entero');
    const orden = await db.tx(async (q) => {
      const o = await crearOrden(q, req.ctx, { producto_id: b.producto_id, m2: b.m2_planificado, fecha_programada: b.fecha_programada, molde_id: b.molde_id, notas: b.notas, responsable_id: b.responsable_id });
      await auditar(q, req.ctx, 'produccion.crear_orden', 'orden_produccion', o.id, { lote: o.lote, m2: o.m2_planificado });
      return o;
    });
    res.status(201).json(orden);
  });

  // Colada: se descuentan los insumos reales y empieza la cuenta para pasar a lista.
  r.post('/ordenes/:id/colar', requierePermiso('fab:registrar'), async (req, res) => {
    const b = validar(z.object({ consumos: z.array(z.object({ insumo_id: uuid, real: z.coerce.number().min(0).optional() })).default([]) }), req.body);
    const out = await db.tx(async (q) => {
      const orden = (await q.query('select * from fab.ordenes where id = $1 and empresa_id = $2 for update', [validar(uuid, req.params.id), empresa(req)])).rows[0];
      if (!orden) throw noEncontrado('Orden no encontrada');
      if (orden.estado !== 'planificada') throw malaPeticion(`La orden está "${orden.estado}": solo se puede colar una orden planificada`);
      const reales = new Map(b.consumos.filter((c) => c.real != null).map((c) => [c.insumo_id, c.real]));
      return colarOrden(q, req.ctx, orden, { reales });
    });
    res.json({ ...out.orden, desvios: out.desvios });
  });

  // Lista para vender: entra el producto terminado al inventario (1ª / 2ª calidad) y se calcula el costo real.
  r.post('/ordenes/:id/terminar', requierePermiso('fab:ver'), async (req, res) => {
    if (!puedeTerminar(req)) throw prohibido();
    const bruto = req.body ?? {};
    const out = await db.tx(async (q) => {
      const orden = (await q.query('select * from fab.ordenes where id = $1 and empresa_id = $2 for update', [validar(uuid, req.params.id), empresa(req)])).rows[0];
      if (!orden) throw noEncontrado('Orden no encontrada');
      if (orden.estado !== 'curando') throw malaPeticion('Solo pasa a "lista para vender" una producción que está en secado');
      const bueno = bruto.m2_bueno === undefined || bruto.m2_bueno === '' ? num(orden.m2_planificado) : num(bruto.m2_bueno);
      const segunda = num(bruto.m2_segunda); const merma = num(bruto.m2_merma);
      if (![bueno, segunda, merma].every(entero)) throw malaPeticion('La piedra se cuenta en cajas completas de 1 m²: las cantidades deben ser números enteros');
      if (bueno < 0 || segunda < 0 || merma < 0) throw malaPeticion('Las cantidades no pueden ser negativas');
      if (bueno + segunda <= 0) throw malaPeticion('Indica cuántos salieron buenos (o de segunda)');
      const rech = (await q.query(`select 1 from fab.controles_calidad where orden_id = $1 and resultado = 'rechazado'`, [orden.id])).rowCount;
      if (rech && !req.ctx.permisos.has('fab:editar')) throw malaPeticion('Hay un control de calidad RECHAZADO en esta producción: gerencia debe revisarla antes de pasarla a lista para vender');
      const antes = orden.fecha_disponible && String(orden.fecha_disponible).slice(0, 10) > fechaHN();
      return terminarOrden(q, req.ctx, orden, { bueno, segunda, merma, motivoAnticipado: antes ? `manual, antes del ${String(orden.fecha_disponible).slice(0, 10)}` : '' });
    });
    res.json({ ...out.orden, merma_pct: out.merma_pct, rendimiento_pct: out.rendimiento_pct, sin_control_calidad: out.sin_control_calidad, reserva: out.reserva });
  });

  r.post('/ordenes/:id/cancelar', requierePermiso('fab:editar'), async (req, res) => {
    const { motivo } = validar(z.object({ motivo: z.string().trim().min(1, 'El motivo de la cancelación es obligatorio').max(200) }), req.body);
    await db.tx(async (q) => {
      const o = (await q.query('select * from fab.ordenes where id = $1 and empresa_id = $2 for update', [validar(uuid, req.params.id), empresa(req)])).rows[0];
      if (!o) throw noEncontrado('Orden no encontrada');
      if (o.estado !== 'planificada') throw conflicto('Solo se cancelan órdenes planificadas (una colada ya gastó insumos)');
      await q.query(`update fab.ordenes set estado = 'cancelada', notas = coalesce(notas || ' | ', '') || $2 where id = $1`, [o.id, `Cancelada: ${motivo}`]);
      await auditar(q, req.ctx, 'produccion.cancelar', 'orden_produccion', o.id, { lote: o.lote, motivo });
    });
    res.json({ ok: true });
  });

  r.get('/calidad/pruebas', requierePermiso('fab:ver'), (_req, res) => res.json(PRUEBAS));
  r.post('/ordenes/:id/calidad', requierePermiso('fab:registrar'), async (req, res) => {
    const b = validar(z.object({
      prueba: z.string().trim().min(1, 'Indica la prueba realizada').max(120), resultado: z.enum(['aprobado', 'observado', 'rechazado'], { errorMap: () => ({ message: 'Resultado inválido' }) }),
      valor: z.coerce.number().finite().optional().nullable().or(z.literal('').transform(() => null)), unidad: textoOpc(20), notas: textoOpc(300),
    }), req.body);
    const out = await db.tx(async (q) => {
      const o = (await q.query('select id, lote from fab.ordenes where id = $1 and empresa_id = $2', [validar(uuid, req.params.id), empresa(req)])).rows[0];
      if (!o) throw noEncontrado('Orden no encontrada');
      const c = (await q.query('insert into fab.controles_calidad (empresa_id,orden_id,prueba,resultado,valor,unidad,notas,usuario_id) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *',
        [empresa(req), o.id, b.prueba, b.resultado, b.valor ?? null, b.unidad, b.notas, req.ctx.usuario.id])).rows[0];
      await auditar(q, req.ctx, 'calidad.control', 'orden_produccion', o.id, { lote: o.lote, prueba: b.prueba, resultado: b.resultado, valor: b.valor });
      if (b.resultado === 'rechazado') await alerta(q, req.ctx, { tipo: 'calidad.rechazado', severidad: 'alta', titulo: `Control de calidad RECHAZADO en ${o.lote}: ${b.prueba}`, entidad: 'orden_produccion', entidadId: o.id, detalle: { lote: o.lote, prueba: b.prueba, valor: b.valor, unidad: b.unidad, notas: b.notas } });
      return c;
    });
    res.status(201).json(out);
  });

  // ═════════════════════════ Planificación de compras (MRP) ═════════════════════════
  r.get('/mrp', requierePermiso('fab:ver'), async (req, res) => {
    const mps = (await db.query(
      `select i.id, i.nombre, i.unidad, i.categoria, i.costo_promedio, i.moneda, i.stock_minimo, p.nombre as proveedor, coalesce(s.stock,0) as stock
         from fab.insumos i left join fab.proveedores p on p.id = i.proveedor_id left join fab.stock_insumos s on s.insumo_id = i.id where i.empresa_id = $1 and i.activo`, [empresa(req)])).rows;
    const req_ = new Map((await db.query(
      `select c.insumo_id, sum(c.teorico) as t from fab.orden_consumos c join fab.ordenes o on o.id = c.orden_id where o.empresa_id = $1 and o.estado = 'planificada' group by c.insumo_id`, [empresa(req)])).rows.map((x) => [x.insumo_id, num(x.t)]));
    const nOrd = num((await db.query(`select count(*) as n from fab.ordenes where empresa_id = $1 and estado = 'planificada'`, [empresa(req)])).rows[0].n);
    const costos = verCostos(req);
    const insumos = mps.map((m) => {
      const stock = num(m.stock); const requerido = req_.get(m.id) ?? 0; const minimo = num(m.stock_minimo);
      const faltante = round3(Math.max(0, requerido - stock));
      const sugerido = Math.ceil(Math.max(0, requerido + minimo - stock) - 1e-9);
      return { id: m.id, nombre: m.nombre, unidad: m.unidad, categoria: m.categoria, proveedor: m.proveedor, stock, requerido, minimo, faltante, sugerido_comprar: sugerido, costo_estimado: costos ? round2(sugerido * num(m.costo_promedio)) : undefined };
    }).filter((f) => f.requerido > 0 || f.sugerido_comprar > 0).sort((a, b) => b.faltante - a.faltante || b.sugerido_comprar - a.sugerido_comprar);
    res.json({ ordenes_planificadas: nOrd, insumos });
  });

  // ═════════════════════════ Agenda y resumen ═════════════════════════
  r.get('/agenda', requierePermiso('fab:ver'), async (req, res) => {
    const hoy = fechaHN();
    const desde = req.query.desde || sumarDias(hoy, -7); const hasta = req.query.hasta || sumarDias(hoy, 45);
    const { rows } = await db.query(
      `select o.id, o.lote, o.estado, o.m2_planificado, o.fecha_programada, o.fecha_disponible, o.cotizacion_numero, p.nombre as producto from fab.ordenes o join pos.productos p on p.id = o.producto_id where o.empresa_id = $1 and o.estado in ('planificada','curando')`, [empresa(req)]);
    const ev = [];
    for (const o of rows) {
      const prog = o.fecha_programada ? String(o.fecha_programada).slice(0, 10) : null; const disp = o.fecha_disponible ? String(o.fecha_disponible).slice(0, 10) : null;
      if (o.estado === 'planificada' && prog) ev.push({ fecha: prog, tipo: 'colada', titulo: `Colar ${o.lote} · ${o.producto}`, detalle: `${num(o.m2_planificado)}${o.cotizacion_numero ? ` · Cot. #${o.cotizacion_numero}` : ''}`, atrasado: prog < hoy, orden_id: o.id });
      if (o.estado === 'curando' && disp) ev.push({ fecha: disp, tipo: 'inventario', titulo: `Pasa a lista para vender ${o.lote} · ${o.producto}`, detalle: `${num(o.m2_planificado)}`, atrasado: disp < hoy, orden_id: o.id });
    }
    res.json(ev.filter((e) => e.fecha >= desde && e.fecha <= hasta).sort((a, b) => a.fecha.localeCompare(b.fecha)));
  });
  r.get('/resumen', requierePermiso('fab:ver'), async (req, res) => {
    const hoy = fechaHN();
    const o = (await db.query(
      `select count(*) filter (where estado='planificada') as planificadas, count(*) filter (where estado='planificada' and fecha_programada < $2) as atrasadas,
              count(*) filter (where estado='curando') as curando, coalesce(sum(m2_planificado) filter (where estado='curando'),0) as m2_curando,
              count(*) filter (where estado='curando' and fecha_disponible <= $2) as listas_para_liberar from fab.ordenes where empresa_id = $1`, [empresa(req), hoy])).rows[0];
    const bajo = num((await db.query(`select count(*) as n from fab.insumos i left join fab.stock_insumos s on s.insumo_id = i.id where i.empresa_id = $1 and i.activo and i.stock_minimo > 0 and coalesce(s.stock,0) < i.stock_minimo`, [empresa(req)])).rows[0].n);
    const pt = (await db.query(
      `select coalesce(sum(cantidad_libre) filter (where calidad='primera' and estado='lista'),0) as libre, coalesce(sum(cantidad_disponible) filter (where estado<>'secado'),0) as fisico from fab.lotes where empresa_id = $1`, [empresa(req)])).rows[0];
    res.json({
      planificadas: num(o.planificadas), atrasadas: num(o.atrasadas), curando: num(o.curando), m2_curando: round3(num(o.m2_curando)), listas_para_liberar: num(o.listas_para_liberar),
      insumos_bajo_minimo: bajo, m2_disponible_primera: round3(num(pt.libre)), m2_fisico_total: round3(num(pt.fisico)),
    });
  });

  // ═════════════════════════ Registrar producción (celular del productor) ═════════════════════════
  const unidadDe = (p) => (p.unidad_venta === 'caja' ? 'cajas' : 'm²');
  r.get('/registro/catalogo', requierePermiso('fab:registrar'), async (req, res) => {
    const { rows } = await db.query(
      `select p.id, p.nombre, p.modelo, p.color, p.unidad_venta, exists(select 1 from fab.recetas r where r.producto_id = p.id and r.activa) as con_receta
         from pos.productos p where p.empresa_id = $1 and p.es_piedra and p.activo order by p.modelo nulls last, p.color nulls last`, [empresa(req)]);
    res.json(rows.map((p) => ({ id: p.id, nombre: p.nombre, modelo: p.modelo ?? p.nombre, color: p.color ?? '', unidad: unidadDe(p), esquina: p.unidad_venta === 'caja', con_receta: p.con_receta })));
  });
  r.post('/registro', requierePermiso('fab:registrar'), async (req, res) => {
    const b = validar(z.object({ producto_id: uuid, cantidad: z.coerce.number().positive('Escribe la cantidad producida').max(5000, 'Esa cantidad es demasiado grande; revísala'), nota: textoOpc(200) }), req.body);
    if (!entero(b.cantidad)) throw malaPeticion('La piedra se produce en cajas completas de 1 m²: la cantidad debe ser un número entero');
    const out = await db.tx(async (q) => {
      const producto = (await q.query('select id, nombre, unidad_venta from pos.productos where id = $1 and empresa_id = $2 and es_piedra and activo', [b.producto_id, empresa(req)])).rows[0];
      if (!producto) throw malaPeticion('Producto no válido');
      // Anti doble toque: mismo usuario, mismo producto y cantidad en los últimos 90 segundos.
      const rep = (await q.query(`select lote from fab.ordenes where empresa_id = $1 and creada_por = $2 and producto_id = $3 and m2_planificado = $4 and created_at >= now() - interval '90 seconds' limit 1`,
        [empresa(req), req.ctx.usuario.id, producto.id, b.cantidad])).rows[0];
      if (rep) throw conflicto(`Ya enviaste ${b.cantidad} de ${producto.nombre} hace un momento (lote ${rep.lote}). No se registró de nuevo.`);
      const orden = await crearOrden(q, req.ctx, { producto_id: producto.id, m2: b.cantidad, fecha_programada: fechaHN(), responsable_id: req.ctx.usuario.id, permitirSinReceta: true, notas: b.nota });
      const c = await colarOrden(q, req.ctx, orden, { forzar: true });
      const sinReceta = !orden.receta_id;
      if (sinReceta) {
        const hoy = (await q.query(`select 1 from fab.alertas where empresa_id = $1 and tipo = 'produccion.sin_receta' and entidad_id = $2 and created_at >= now() - interval '1 day'`, [empresa(req), producto.id])).rowCount;
        if (!hoy) await alerta(q, req.ctx, { tipo: 'produccion.sin_receta', titulo: `Se produjo ${producto.nombre} pero no tiene receta: no se descontaron insumos`, entidad: 'producto', entidadId: producto.id, detalle: { producto: producto.nombre, lote: orden.lote, por: req.ctx.usuario.nombre } });
      }
      await auditar(q, req.ctx, 'produccion.registro', 'orden_produccion', orden.id, { lote: orden.lote, producto: producto.nombre, cantidad: b.cantidad, unidad: unidadDe(producto), sin_receta: sinReceta || undefined });
      const avisos = [];
      if (sinReceta) avisos.push('Este modelo aún no tiene receta: se guardó la producción pero no se descontó materia prima. Avisa al administrador.');
      if (c.faltantes.length) avisos.push('El sistema tenía menos materia prima que la usada. Ya se avisó al administrador.');
      return { orden_id: orden.id, lote: orden.lote, producto: producto.nombre, cantidad: b.cantidad, unidad: unidadDe(producto), registrado_at: c.orden.fecha_colado, disponible_desde: c.orden.fecha_disponible, insumos: c.consumido, avisos };
    });
    res.status(201).json(out);
  });
  r.get('/registro/recientes', requierePermiso('fab:registrar'), async (req, res) => {
    const propios = req.ctx.rol === 'produccion';
    const { rows } = await db.query(
      `select o.id, o.lote, o.m2_planificado, o.estado, o.fecha_colado, o.fecha_disponible, p.nombre as producto, p.unidad_venta, u.nombre as operario
         from fab.ordenes o join pos.productos p on p.id = o.producto_id left join core.usuarios u on u.id = o.responsable_id
        where o.empresa_id = $1 and o.fecha_colado >= now() - interval '7 days' and ($2::boolean is false or o.responsable_id = $3) order by o.fecha_colado desc limit 40`, [empresa(req), propios, req.ctx.usuario.id]);
    res.json(rows.map((o) => ({ id: o.id, lote: o.lote, producto: o.producto, cantidad: num(o.m2_planificado), unidad: unidadDe(o), estado: o.estado, registrado_at: o.fecha_colado, disponible_desde: o.fecha_disponible, operario: o.operario })));
  });

  // ═════════════════════════ Trazabilidad ═════════════════════════
  r.get('/trazabilidad', requierePermiso('fab:ver'), async (req, res) => {
    const q = `%${String(req.query.q ?? '').trim().toLowerCase()}%`;
    const { rows } = await db.query(
      `select o.lote, o.estado, o.m2_planificado, o.fecha_colado, o.fecha_disponible, p.nombre as producto from fab.ordenes o join pos.productos p on p.id = o.producto_id
        where o.empresa_id = $1 and o.fecha_colado is not null and lower(o.lote || ' ' || p.nombre) like $2 order by o.fecha_colado desc limit 60`, [empresa(req), q]);
    res.json(rows.map((o) => ({ lote: o.lote, producto: o.producto, cantidad: num(o.m2_planificado), estado: o.estado, registrado_at: o.fecha_colado, disponible_desde: o.fecha_disponible })));
  });

  async function trazar(req, codigo) {
    const emp = empresa(req);
    const orden = (await db.query(
      `select o.*, p.nombre as producto, p.modelo, p.color, p.unidad_venta, p.m2_por_caja, mo.codigo as molde_codigo, mo.nombre as molde_nombre, rc.nombre as receta, u.nombre as operario, cr.nombre as creador
         from fab.ordenes o join pos.productos p on p.id = o.producto_id left join fab.moldes mo on mo.id = o.molde_id left join fab.recetas rc on rc.id = o.receta_id
         left join core.usuarios u on u.id = o.responsable_id left join core.usuarios cr on cr.id = o.creada_por where o.empresa_id = $1 and o.lote = $2`, [emp, codigo])).rows[0] ?? null;
    const lotes = (await db.query('select * from fab.lotes where empresa_id = $1 and codigo = $2', [emp, codigo])).rows;
    if (!orden && !lotes.length) throw noEncontrado(`No se encontró el lote ${codigo}`);
    const movs = lotes.length ? (await db.query(
      `select m.*, l.calidad, u.nombre as por from fab.lote_movs m join fab.lotes l on l.id = m.lote_id left join core.usuarios u on u.id = m.usuario_id where m.lote_id = any($1::uuid[]) order by m.id`, [lotes.map((l) => l.id)])).rows : [];
    const consumos = orden ? (await db.query(
      `select c.teorico, c.real, c.costo_unitario, c.insumo_id, i.nombre, i.unidad, i.categoria from fab.orden_consumos c join fab.insumos i on i.id = c.insumo_id where c.orden_id = $1 order by i.nombre`, [orden.id])).rows : [];
    const calidad = orden ? (await db.query('select c.prueba, c.resultado, c.valor, c.unidad, c.notas, c.created_at, u.nombre as por from fab.controles_calidad c left join core.usuarios u on u.id = c.usuario_id where c.orden_id = $1 order by c.created_at', [orden.id])).rows : [];
    // Última compra de cada insumo ANTES de la colada (proveedor y factura): de dónde vino el material.
    const hasta = orden?.fecha_colado ?? new Date().toISOString();
    const compras = [];
    for (const c of consumos) {
      const m = (await db.query(
        `select m.created_at, m.cantidad, m.documento, p.nombre as proveedor from fab.mov_insumos m left join fab.proveedores p on p.id = m.proveedor_id
          where m.insumo_id = $1 and m.tipo = 'compra' and m.created_at <= $2 order by m.created_at desc, m.id desc limit 1`, [c.insumo_id, hasta])).rows[0];
      compras.push({ insumo_id: c.insumo_id, insumo: c.nombre, ultima_compra: m ? { fecha: m.created_at, proveedor: m.proveedor, factura: m.documento, cantidad: num(m.cantidad) } : null });
    }
    const destinos = new Map();
    for (const m of movs) {
      if (!m.ref_id && !m.venta_id) continue;
      const k = m.ref_id ?? m.venta_id;
      const d = destinos.get(k) ?? { cotizacion: m.ref_numero ?? null, cliente: m.cliente ?? null, reservado: 0, facturas: new Set() };
      if (m.ref_numero && !d.cotizacion) d.cotizacion = m.ref_numero;
      if (m.tipo === 'reserva' || m.tipo === 'liberacion') d.reservado += num(m.cantidad);
      if (m.venta_numero) d.facturas.add(m.venta_numero);
      destinos.set(k, d);
    }
    const fisico = lotes.reduce((s, l) => s + num(l.cantidad_disponible), 0); const reservado = lotes.reduce((s, l) => s + num(l.cantidad_reservada), 0);
    const costos = verCostos(req);
    return {
      lote: codigo, existe_orden: !!orden,
      orden: orden ? {
        id: orden.id, numero: Number(orden.numero), estado: orden.estado, producto: orden.producto, modelo: orden.modelo, color: orden.color, unidad_venta: orden.unidad_venta, m2_por_caja: orden.m2_por_caja == null ? null : num(orden.m2_por_caja),
        cantidad_registrada: num(orden.m2_planificado), cantidad_lista: orden.m2_bueno == null ? null : num(orden.m2_bueno), segunda: num(orden.m2_segunda), merma: num(orden.m2_merma),
        registrado_at: orden.fecha_colado, disponible_desde: orden.fecha_disponible, lista_at: orden.fecha_terminada, etiqueta_at: orden.etiqueta_at, etiquetas_impresas: orden.etiquetas_impresas,
        operario: orden.operario ?? orden.creador ?? null, molde: orden.molde_codigo ? `${orden.molde_codigo} · ${orden.molde_nombre}` : null, receta: orden.receta ?? null,
        cotizacion_origen: orden.cotizacion_numero ? { numero: orden.cotizacion_numero } : null, notas: orden.notas,
        costo_m2: costos && orden.costo_m2 != null ? num(orden.costo_m2) : null, costo_mp: costos && orden.costo_mp != null ? num(orden.costo_mp) : null,
      } : null,
      consumos: consumos.map((c) => ({ insumo: c.nombre, categoria: c.categoria, unidad: c.unidad, teorico: num(c.teorico), real: c.real == null ? null : num(c.real), costo_unitario: costos ? num(c.costo_unitario) : undefined })),
      compras,
      calidad: calidad.map((c) => ({ ...c, valor: c.valor == null ? null : num(c.valor), fecha: c.created_at })),
      inventario: { fisico, reservado, disponible: fisico - reservado },
      movimientos: movs.map((m) => ({ fecha: m.created_at, tipo: m.tipo, calidad: m.calidad, cantidad: num(m.cantidad), detalle: m.motivo, por: m.por, cotizacion: m.ref_numero, cliente: m.cliente, factura: m.venta_numero })),
      destinos: [...destinos.values()].map((d) => ({ ...d, facturas: [...d.facturas] })).filter((d) => d.cotizacion || d.facturas.length),
    };
  }
  r.get('/trazabilidad/lote/:codigo', requierePermiso('fab:ver'), async (req, res) => res.json(await trazar(req, String(req.params.codigo).slice(0, 60))));

  // Datos de la etiqueta 4×6" (la web la dibuja con QR y la manda a imprimir). Cuenta la impresión y la deja en bitácora.
  r.post('/trazabilidad/lote/:codigo/etiqueta', requierePermiso('fab:ver', 'fab:registrar'), async (req, res) => {
    const modo = req.body?.modo === 'cajas' ? 'cajas' : 'lote';
    const codigo = String(req.params.codigo).slice(0, 60);
    const o = (await db.query(
      `select o.*, p.nombre as producto, p.modelo, p.color, p.unidad_venta, p.m2_por_caja, mo.codigo as molde, rc.nombre as receta, u.nombre as operario, cr.nombre as creador
         from fab.ordenes o join pos.productos p on p.id = o.producto_id left join fab.moldes mo on mo.id = o.molde_id left join fab.recetas rc on rc.id = o.receta_id
         left join core.usuarios u on u.id = o.responsable_id left join core.usuarios cr on cr.id = o.creada_por where o.empresa_id = $1 and o.lote = $2`, [empresa(req), codigo])).rows[0];
    if (!o) throw noEncontrado('Ese lote no tiene orden de producción (no genera etiqueta)');
    if (req.ctx.rol === 'produccion' && o.responsable_id !== req.ctx.usuario.id && o.creada_por !== req.ctx.usuario.id) throw noEncontrado('Lote no encontrado');
    await db.tx(async (q) => {
      await q.query('update fab.ordenes set etiquetas_impresas = etiquetas_impresas + 1 where id = $1', [o.id]);
      await q.query('update fab.lotes set etiquetas_impresas = etiquetas_impresas + 1 where empresa_id = $1 and codigo = $2', [empresa(req), codigo]);
      await auditar(q, req.ctx, 'produccion.etiqueta', 'orden_produccion', o.id, { lote: o.lote, modo });
    });
    const base = (process.env.APP_URL || `${req.get('x-forwarded-proto') || req.protocol}://${req.get('x-forwarded-host') || req.get('host')}`).replace(/\/$/, '');
    res.json({
      empresa: { nombre: req.ctx.empresa.razon_social ?? req.ctx.empresa.nombre, rtn: req.ctx.empresa.rtn }, modo, url: `${base}/${req.ctx.empresa.codigo}/trazabilidad?lote=${encodeURIComponent(o.lote)}`,
      lote: o.lote, producto: o.producto, modelo: o.modelo ?? o.producto, color: o.color ?? '', unidad_venta: o.unidad_venta, m2_por_caja: o.m2_por_caja == null ? null : num(o.m2_por_caja),
      cantidad: num(o.m2_planificado), producido_at: o.fecha_colado ?? o.created_at, lista_at: o.fecha_terminada, disponible_desde: o.fecha_disponible,
      operario: o.operario ?? o.creador ?? null, molde: o.molde, receta: o.receta, orden_numero: Number(o.numero),
    });
  });

  // ═════════════════════════ Reporte de producción ═════════════════════════
  r.get('/reporte', requierePermiso('fab:editar'), async (req, res) => {
    const hoy = fechaHN();
    const hasta = /^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta ?? '') ? req.query.hasta : hoy;
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde ?? '') ? req.query.desde : sumarDias(hasta, -29);
    const emp = empresa(req);
    const ordenes = (await db.query(
      `select o.id, o.lote, o.estado, o.m2_planificado, o.m2_bueno, o.m2_segunda, o.m2_merma, o.fecha_colado, o.fecha_disponible, o.fecha_terminada, o.costo_mp, o.costo_total, o.cotizacion_id,
              p.nombre as producto, p.modelo, p.unidad_venta, u.nombre as operario
         from fab.ordenes o join pos.productos p on p.id = o.producto_id left join core.usuarios u on u.id = o.responsable_id
        where o.empresa_id = $1 and o.fecha_colado is not null and (o.fecha_colado at time zone 'America/Tegucigalpa')::date between $2::date and $3::date order by o.fecha_colado desc`, [emp, desde, hasta])).rows
      .map((o) => ({ ...o, m2_planificado: num(o.m2_planificado), m2_bueno: num(o.m2_bueno), m2_segunda: num(o.m2_segunda), m2_merma: num(o.m2_merma), costo_mp: num(o.costo_mp), costo_total: num(o.costo_total) }));
    const ids = ordenes.map((o) => o.id);
    const consumos = ids.length ? (await db.query(
      `select c.insumo_id, i.nombre, i.unidad, c.teorico, c.real, c.costo_unitario from fab.orden_consumos c join fab.insumos i on i.id = c.insumo_id where c.orden_id = any($1::uuid[])`, [ids])).rows : [];
    const pendientes = (await db.query(
      `select o.lote, o.m2_planificado, o.fecha_programada, o.cotizacion_numero, p.nombre as producto, p.unidad_venta from fab.ordenes o join pos.productos p on p.id = o.producto_id where o.empresa_id = $1 and o.estado = 'planificada' order by o.fecha_programada`, [emp])).rows;
    const alertas = (await db.query(
      `select id, created_at, tipo, severidad, titulo, estado from fab.alertas where empresa_id = $1 and (created_at at time zone 'America/Tegucigalpa')::date between $2::date and $3::date order by created_at desc limit 25`, [emp, desde, hasta])).rows;
    const calidadRows = (await db.query(
      `select resultado, count(*) as n from fab.controles_calidad where empresa_id = $1 and (created_at at time zone 'America/Tegucigalpa')::date between $2::date and $3::date group by resultado`, [emp, desde, hasta])).rows;
    const crit = (await db.query(
      `select i.nombre, i.unidad, i.stock_minimo, coalesce(s.stock,0) as stock from fab.insumos i left join fab.stock_insumos s on s.insumo_id = i.id where i.empresa_id = $1 and i.activo`, [emp])).rows;
    const inv = (await db.query(
      `select p.nombre, p.unidad_venta, coalesce(sum(l.cantidad_disponible) filter (where l.calidad='primera'),0) as fisico_p, coalesce(sum(l.cantidad_libre) filter (where l.calidad='primera'),0) as libre
         from fab.lotes l join pos.productos p on p.id = l.producto_id where l.empresa_id = $1 and l.estado <> 'secado' group by p.nombre, p.unidad_venta`, [emp])).rows;

    const uni = (o) => (o.unidad_venta === 'caja' ? 'cajas' : 'm²');
    const m2s = ordenes.filter((o) => uni(o) === 'm²');
    const suma = (arr, f) => round3(arr.reduce((s, o) => s + num(f(o)), 0));
    const term = m2s.filter((o) => o.estado === 'terminada');
    const bueno = suma(term, (o) => o.m2_bueno); const segunda = suma(term, (o) => o.m2_segunda); const merma = suma(term, (o) => o.m2_merma);
    const costos = true;
    const kpis = {
      registros: ordenes.length, m2_producidos: suma(m2s, (o) => o.m2_planificado), cajas_esquina_producidas: suma(ordenes.filter((o) => uni(o) === 'cajas'), (o) => o.m2_planificado),
      en_produccion_m2: suma(m2s.filter((o) => o.estado === 'curando'), (o) => o.m2_planificado), en_produccion_lotes: ordenes.filter((o) => o.estado === 'curando').length,
      liberado_m2: bueno, segunda_m2: segunda, merma_m2: merma, merma_pct: bueno + segunda + merma > 0 ? round2((merma / (bueno + segunda + merma)) * 100) : 0,
      costo_insumos: costos ? round2(ordenes.reduce((s, o) => s + o.costo_mp, 0)) : null,
      costo_m2_promedio: bueno + segunda > 0 ? round2(term.reduce((s, o) => s + o.costo_total, 0) / (bueno + segunda)) : null,
    };
    const horaDia = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Tegucigalpa' }).format(new Date(iso));
    const porDiaMap = new Map();
    for (const o of m2s) { const f = horaDia(o.fecha_colado); porDiaMap.set(f, round3((porDiaMap.get(f) ?? 0) + o.m2_planificado)); }
    const por_dia = [];
    for (let f = desde, n = 0; f <= hasta && n < 400; f = sumarDias(f, 1), n++) por_dia.push({ fecha: f, etiqueta: `${f.slice(8)}/${f.slice(5, 7)}`, valor: porDiaMap.get(f) ?? 0 });
    const agrupar = (lista, clave) => {
      const m = new Map();
      for (const o of lista) { const k = clave(o); const x = m.get(k) ?? { nombre: k, valor: 0, registros: 0 }; x.valor = round3(x.valor + o.m2_planificado); x.registros++; m.set(k, x); }
      return [...m.values()].sort((a, b) => b.valor - a.valor);
    };
    const unidadPorNombre = new Map(ordenes.map((o) => [o.producto, uni(o)]));
    const mp = new Map();
    for (const c of consumos) {
      if (c.real == null) continue;
      const x = mp.get(c.insumo_id) ?? { insumo: c.nombre, unidad: c.unidad, teorico: 0, real: 0, costo: 0 };
      x.teorico += num(c.teorico); x.real += num(c.real); x.costo += num(c.real) * num(c.costo_unitario); mp.set(c.insumo_id, x);
    }
    const consumo = [...mp.values()].map((x) => ({ ...x, teorico: round3(x.teorico), real: round3(x.real), costo: round2(x.costo), desvio_pct: x.teorico > 0 ? round2(((x.real - x.teorico) / x.teorico) * 100) : null })).sort((a, b) => b.costo - a.costo);
    const cal = { aprobado: 0, observado: 0, rechazado: 0 };
    for (const c of calidadRows) cal[c.resultado] = num(c.n);
    res.json({
      rango: { desde, hasta }, kpis, por_dia, por_modelo: agrupar(m2s, (o) => o.modelo ?? o.producto),
      por_producto: agrupar(ordenes, (o) => o.producto).map((x) => ({ ...x, unidad: unidadPorNombre.get(x.nombre) ?? 'm²' })),
      por_operario: agrupar(ordenes, (o) => o.operario ?? 'Sin usuario'), consumo, calidad: cal,
      insumos_criticos: crit.map((m) => ({ nombre: m.nombre, unidad: m.unidad, stock: round3(num(m.stock)), minimo: num(m.stock_minimo) })).filter((m) => m.stock < 0 || (m.minimo > 0 && m.stock < m.minimo)).sort((a, b) => a.stock - b.stock),
      inventario: inv.map((i) => ({ nombre: i.nombre, unidad: i.unidad_venta === 'caja' ? 'cajas' : 'm²', disponible: round3(num(i.libre)), fisico: round3(num(i.fisico_p)) })).filter((x) => x.fisico || x.disponible).sort((a, b) => b.disponible - a.disponible),
      por_producir: pendientes.map((o) => ({ lote: o.lote, producto: o.producto, cantidad: num(o.m2_planificado), unidad: o.unidad_venta === 'caja' ? 'cajas' : 'm²', fecha_programada: o.fecha_programada, cotizacion: o.cotizacion_numero })),
      alertas,
      registros: ordenes.map((o) => ({ id: o.id, lote: o.lote, registrado_at: o.fecha_colado, operario: o.operario ?? '—', producto: o.producto, cantidad: o.m2_planificado, unidad: uni(o), estado: o.estado, disponible_desde: o.fecha_disponible, liberado_at: o.fecha_terminada, cotizacion_id: o.cotizacion_id })),
    });
  });

  return r;
}
