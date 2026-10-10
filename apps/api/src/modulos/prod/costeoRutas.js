// Rutas de recetas y costeo (/api/prod/costeo). Todo exige rep:costeo: son los precios reales de compra y el
// margen del negocio, no algo que producción ni el despachador necesiten ver.
import { Router } from 'express';
import { z } from 'zod';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { conflicto, dinero, fechaISO, malaPeticion, noEncontrado, uuid, validar } from '../../lib/http.js';
import {
  calcularConsumoInsumos, cargarPrecios, cargarRecetas, congelarCosto, costoKgReceta, desglosarReceta, impactoDePrecio,
  indiceRecetaPorSabor, resumenCosteo, resumenCosteoRango,
} from './costeo.js';
import { FECHA_ISO, hoyHN, redondear } from './comun.js';
import { sumarDias } from '@grupo/shared';

const txt = (n = 200) => z.string().trim().max(n).optional().nullable().transform((v) => v || null);

export function rutasCosteo({ db }) {
  const r = Router();
  const emp = (req) => req.ctx.empresa.id;
  r.use(requierePermiso('costeo:ver'));
  const fechaQ = (req) => (FECHA_ISO.test(req.query.fecha || '') ? req.query.fecha : hoyHN());

  const SQL_INSUMOS = `select i.id, i.nombre, i.tipo, i.part_number, i.unidad, i.activo, i.categoria, i.descripcion,
      p.lps_kg::float8 as precio_actual, p.fecha_vigencia::text as precio_fecha, p.usd_kg::float8 as usd_kg, p.tipo_cambio_usado::float8 as tipo_cambio_usado, p.fuente as precio_fuente
    from prod.costeo_insumos i
    left join lateral (select * from prod.costeo_precios p where p.insumo_id = i.id order by p.fecha_vigencia desc, p.id desc limit 1) p on true
    where i.empresa_id = $1`;

  // ── Insumos y precios ──
  r.get('/insumos', async (req, res) => {
    res.json((await db.query(`${SQL_INSUMOS} and i.activo order by i.nombre`, [emp(req)])).rows);
  });

  const esqInsumo = z.object({
    nombre: z.string().trim().min(1, 'Falta el nombre del insumo').max(160),
    tipo: z.enum(['mec3', 'local'], { errorMap: () => ({ message: 'Tipo inválido (mec3 o local)' }) }),
    part_number: txt(60), unidad: z.string().trim().min(1).max(20).default('unidad'), categoria: txt(60), descripcion: txt(300),
    precio_inicial: dinero.optional().nullable(), usd_kg: dinero.optional().nullable(), tipo_cambio_usado: z.coerce.number().positive().max(1000).optional().nullable(),
    fecha_vigencia: fechaISO.optional(),
  });
  r.post('/insumos', async (req, res) => {
    const b = validar(esqInsumo, req.body);
    const nombre = b.nombre.toUpperCase();
    const i = await db.tx(async (q) => {
      if ((await q.query('select 1 from prod.costeo_insumos where empresa_id = $1 and nombre = $2', [emp(req), nombre])).rows.length) throw malaPeticion('Ya existe un insumo con ese nombre');
      const n = (await q.query('insert into prod.costeo_insumos (empresa_id, nombre, tipo, part_number, unidad, categoria, descripcion) values ($1,$2,$3,$4,$5,$6,$7) returning id',
        [emp(req), nombre, b.tipo, b.part_number, b.unidad, b.categoria, b.descripcion])).rows[0];
      if (b.precio_inicial !== null && b.precio_inicial !== undefined) {
        await q.query(`insert into prod.costeo_precios (empresa_id, insumo_id, fecha_vigencia, lps_kg, usd_kg, tipo_cambio_usado, fuente, usuario_id) values ($1,$2,$3,$4,$5,$6,'manual',$7)`,
          [emp(req), n.id, b.fecha_vigencia ?? hoyHN(), b.precio_inicial, b.usd_kg ?? null, b.tipo_cambio_usado ?? null, req.ctx.usuario.id]);
      }
      await auditar(q, req.ctx, 'costeo.insumo_crear', 'insumo', n.id, { nombre, tipo: b.tipo, precio_inicial: b.precio_inicial ?? null });
      return n;
    });
    res.status(201).json({ ok: true, id: i.id });
  });

  r.patch('/insumos/:id', async (req, res) => {
    const b = validar(esqInsumo.pick({ nombre: true, tipo: true, part_number: true, unidad: true, categoria: true, descripcion: true }).partial({ unidad: true, categoria: true, descripcion: true }), req.body);
    const id = validar(uuid, req.params.id);
    await db.tx(async (q) => {
      const a = (await q.query('select * from prod.costeo_insumos where id = $1 and empresa_id = $2', [id, emp(req)])).rows[0];
      if (!a) throw noEncontrado('Insumo no encontrado');
      const nombre = b.nombre.toUpperCase();
      if ((await q.query('select 1 from prod.costeo_insumos where empresa_id = $1 and nombre = $2 and id <> $3', [emp(req), nombre, id])).rows.length) throw malaPeticion('Ya existe otro insumo con ese nombre');
      await q.query('update prod.costeo_insumos set nombre=$2, tipo=$3, part_number=$4, unidad=$5, categoria=coalesce($6,categoria), descripcion=coalesce($7,descripcion) where id=$1',
        [id, nombre, b.tipo, b.part_number, b.unidad ?? a.unidad, b.categoria ?? null, b.descripcion ?? null]);
      await auditar(q, req.ctx, 'costeo.insumo_editar', 'insumo', id, { antes: { nombre: a.nombre, tipo: a.tipo }, despues: { nombre, tipo: b.tipo } });
    });
    res.json({ ok: true });
  });

  // Desactivar (no se borra: se conserva el historial de precios y las recetas que lo usan lo siguen costeando).
  r.delete('/insumos/:id', async (req, res) => {
    const id = validar(uuid, req.params.id);
    const a = (await db.query('update prod.costeo_insumos set activo = false where id = $1 and empresa_id = $2 returning nombre', [id, emp(req)])).rows[0];
    if (!a) throw noEncontrado('Insumo no encontrado');
    await auditar(db, req.ctx, 'costeo.insumo_desactivar', 'insumo', id, { nombre: a.nombre });
    res.json({ ok: true });
  });

  // Historial de precios (solo se agrega) con la variación contra el precio anterior.
  r.get('/insumos/:id/precios', async (req, res) => {
    const id = validar(uuid, req.params.id);
    const ins = (await db.query('select id, nombre from prod.costeo_insumos where id = $1 and empresa_id = $2', [id, emp(req)])).rows[0];
    if (!ins) throw noEncontrado('Insumo no encontrado');
    const { rows } = await db.query(
      `select p.id, p.fecha_vigencia::text as fecha_vigencia, p.lps_kg::float8 as lps_kg, p.usd_kg::float8 as usd_kg, p.tipo_cambio_usado::float8 as tipo_cambio_usado,
              p.fuente, p.factura_ref, u.nombre as usuario, p.created_at
         from prod.costeo_precios p left join core.usuarios u on u.id = p.usuario_id where p.insumo_id = $1 order by p.fecha_vigencia desc, p.id desc`, [id]);
    res.json({ insumo: ins, precios: rows.map((p, i) => { const ant = rows[i + 1]; return { ...p, variacion_pct: ant && ant.lps_kg > 0 ? ((p.lps_kg - ant.lps_kg) / ant.lps_kg) * 100 : null }; }) });
  });

  // Precio nuevo. Se puede dar en Lempiras, o en dólares con su tipo de cambio (lps = usd × tipo de cambio).
  const esqPrecio = z.object({
    lps_kg: dinero.optional().nullable(), usd_kg: dinero.optional().nullable(), tipo_cambio_usado: z.coerce.number().positive().max(1000).optional().nullable(),
    fecha_vigencia: fechaISO.optional(), fuente: z.enum(['factura_mec3', 'manual']).default('manual'), factura_ref: txt(120),
  });
  function lpsDe(b) {
    if (b.lps_kg !== null && b.lps_kg !== undefined) return b.lps_kg;
    if (b.usd_kg && b.tipo_cambio_usado) return redondear(b.usd_kg * b.tipo_cambio_usado, 4);
    throw malaPeticion('Precio inválido: indica Lps/kg, o US$/kg con su tipo de cambio');
  }
  r.post('/insumos/:id/precios', async (req, res) => {
    const b = validar(esqPrecio, req.body);
    const id = validar(uuid, req.params.id);
    const lps = lpsDe(b);
    await db.tx(async (q) => {
      const ins = (await q.query('select nombre from prod.costeo_insumos where id = $1 and empresa_id = $2', [id, emp(req)])).rows[0];
      if (!ins) throw noEncontrado('Insumo no encontrado');
      const ant = (await q.query('select lps_kg::float8 as lps from prod.costeo_precios where insumo_id = $1 order by fecha_vigencia desc, id desc limit 1', [id])).rows[0];
      await q.query(`insert into prod.costeo_precios (empresa_id, insumo_id, fecha_vigencia, lps_kg, usd_kg, tipo_cambio_usado, fuente, factura_ref, usuario_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [emp(req), id, b.fecha_vigencia ?? hoyHN(), lps, b.usd_kg ?? null, b.tipo_cambio_usado ?? null, b.fuente, b.factura_ref, req.ctx.usuario.id]);
      await auditar(q, req.ctx, 'costeo.precio_agregar', 'insumo', id, { insumo: ins.nombre, antes: ant?.lps ?? null, despues: lps, usd_kg: b.usd_kg ?? null, tipo_cambio: b.tipo_cambio_usado ?? null });
    });
    res.status(201).json({ ok: true, lps_kg: lps });
  });

  // ¿Qué pasa con las recetas si este insumo cambia de precio? (antes de guardarlo)
  r.get('/insumos/:id/impacto', async (req, res) => {
    const id = validar(uuid, req.params.id);
    const nuevo = validar(dinero, req.query.lps_kg);
    const [recetas, precios, sabores] = await Promise.all([cargarRecetas(db, emp(req)), cargarPrecios(db, emp(req)), db.query('select id, nombre from rep.sabores where empresa_id = $1', [emp(req)])]);
    res.json(impactoDePrecio({ insumoId: id, nuevoLpsKg: nuevo, fechaISO: fechaQ(req), recetas, precios, nombreSabor: new Map(sabores.rows.map((s) => [s.id, s.nombre])) }));
  });

  // ── Tipo de cambio: los insumos Mec3 vienen en dólares y el dólar se mueve ──
  async function dolarizados(q, empresaId) {
    return (await q.query(`select * from (${SQL_INSUMOS} and i.activo) t where t.usd_kg > 0 order by t.nombre`, [empresaId])).rows;
  }
  r.get('/tipo-cambio', async (req, res) => {
    const cfg = (await db.query(`select valor from core.config where empresa_id = $1 and clave = 'prod'`, [emp(req)])).rows[0]?.valor ?? {};
    const sugerido = (await db.query(`select tipo_cambio_usado::float8 as tc from prod.costeo_precios where empresa_id = $1 and tipo_cambio_usado is not null order by fecha_vigencia desc, id desc limit 1`, [emp(req)])).rows[0]?.tc ?? null;
    res.json({ tipo_cambio_usd: cfg.tipo_cambio_usd ?? sugerido, ultimo_usado: sugerido, insumos_en_dolares: (await dolarizados(db, emp(req))).length });
  });
  /**
   * Re-expresa en Lempiras todos los insumos dolarizados al tipo de cambio dado: por cada uno AGREGA una fila de precio
   * (usd_kg × tipo de cambio) sin tocar las anteriores. `vista_previa` solo calcula y muestra el efecto en las recetas.
   */
  const esqTc = z.object({ tipo_cambio: z.coerce.number().positive().max(1000), fecha_vigencia: fechaISO.optional(), vista_previa: z.boolean().optional(), insumo_ids: z.array(uuid).max(400).optional() });
  r.post('/tipo-cambio/aplicar', async (req, res) => {
    const b = validar(esqTc, req.body);
    const fecha = b.fecha_vigencia ?? hoyHN();
    const todos = await dolarizados(db, emp(req));
    const cambios = todos
      .filter((i) => !b.insumo_ids || b.insumo_ids.includes(i.id))
      .map((i) => ({ insumo_id: i.id, nombre: i.nombre, usd_kg: i.usd_kg, antes: i.precio_actual, despues: redondear(i.usd_kg * b.tipo_cambio, 4) }))
      .filter((c) => Math.abs(c.despues - c.antes) >= 0.0001);
    const [recetas, precios, sabores] = await Promise.all([cargarRecetas(db, emp(req)), cargarPrecios(db, emp(req)), db.query('select id, nombre from rep.sabores where empresa_id = $1', [emp(req)])]);
    const nombreSabor = new Map(sabores.rows.map((s) => [s.id, s.nombre]));
    const mod = new Map(precios);
    cambios.forEach((c, k) => mod.set(c.insumo_id, [...(precios.get(c.insumo_id) ?? []), { insumo_id: c.insumo_id, fecha_vigencia: fecha, lps_kg: c.despues, id: Number.MAX_SAFE_INTEGER - k }]));
    const efecto = [...recetas].map(([id, rc]) => {
      const antes = costoKgReceta(id, fecha, recetas, precios), despues = costoKgReceta(id, fecha, recetas, mod);
      return { receta_id: id, nombre: rc.saborId ? (nombreSabor.get(rc.saborId) ?? rc.nombre) : rc.nombre, antes, despues, variacion_pct: antes && despues !== null ? ((despues - antes) / antes) * 100 : null };
    }).filter((e) => e.antes !== e.despues).sort((a, c) => Math.abs(c.variacion_pct ?? 0) - Math.abs(a.variacion_pct ?? 0));
    if (b.vista_previa) return res.json({ vista_previa: true, fecha_vigencia: fecha, cambios, recetas: efecto });
    await db.tx(async (q) => {
      for (const c of cambios) {
        await q.query(`insert into prod.costeo_precios (empresa_id, insumo_id, fecha_vigencia, lps_kg, usd_kg, tipo_cambio_usado, fuente, factura_ref, usuario_id) values ($1,$2,$3,$4,$5,$6,'manual',$7,$8)`,
          [emp(req), c.insumo_id, fecha, c.despues, c.usd_kg, b.tipo_cambio, `Tipo de cambio L ${b.tipo_cambio} por US$`, req.ctx.usuario.id]);
      }
      await q.query(`insert into core.config (empresa_id, clave, valor) values ($1,'prod',jsonb_build_object('tipo_cambio_usd',$2::numeric))
                     on conflict (empresa_id, clave) do update set valor = core.config.valor || jsonb_build_object('tipo_cambio_usd',$2::numeric), updated_at = now()`, [emp(req), b.tipo_cambio]);
      await auditar(q, req.ctx, 'costeo.tipo_cambio_aplicar', 'insumo', null, { tipo_cambio: b.tipo_cambio, fecha_vigencia: fecha, insumos: cambios.length });
    });
    res.status(201).json({ ok: true, actualizados: cambios.length, recetas: efecto });
  });

  // ── Recetas (una por sabor) ──
  r.get('/recetas', async (req, res) => {
    const fecha = fechaQ(req);
    const [sabores, recetas, precios] = await Promise.all([db.query('select id, nombre from rep.sabores where empresa_id = $1 and activo order by nombre', [emp(req)]), cargarRecetas(db, emp(req)), cargarPrecios(db, emp(req))]);
    const indice = indiceRecetaPorSabor(recetas);
    res.json(sabores.rows.map((s) => {
      const rid = indice.get(s.id), rc = rid ? recetas.get(rid) : null;
      const costo = rid ? costoKgReceta(rid, fecha, recetas, precios) : null;
      const pv = rc?.precioVentaKg ?? null;
      return { sabor_id: s.id, sabor_nombre: s.nombre, tiene_receta: !!rid, receta_id: rid ?? null, cantidad_ingredientes: rc ? rc.items.length : 0, costo_kg_hoy: costo, precio_venta_kg: pv, margen_pct: costo !== null && pv > 0 ? ((pv - costo) / pv) * 100 : null };
    }));
  });
  r.get('/recetas-sin-sabor', async (req, res) => {
    const fecha = fechaQ(req);
    const [recetas, precios] = await Promise.all([cargarRecetas(db, emp(req)), cargarPrecios(db, emp(req))]);
    res.json([...recetas.values()].filter((x) => !x.saborId).map((x) => ({ receta_id: x.id, nombre: x.nombre, cantidad_ingredientes: x.items.length, costo_kg_hoy: costoKgReceta(x.id, fecha, recetas, precios) })));
  });
  // Detalle con el desglose de costo por ingrediente.
  r.get('/recetas/:saborId', async (req, res) => {
    const fecha = fechaQ(req);
    const sabor = (await db.query('select id, nombre from rep.sabores where id = $1 and empresa_id = $2', [validar(uuid, req.params.saborId), emp(req)])).rows[0];
    if (!sabor) throw noEncontrado('Sabor no encontrado');
    const [recetas, precios, nombres] = await Promise.all([cargarRecetas(db, emp(req)), cargarPrecios(db, emp(req)), db.query('select id, nombre, tipo from prod.costeo_insumos where empresa_id = $1', [emp(req)])]);
    const rid = indiceRecetaPorSabor(recetas).get(sabor.id);
    if (!rid) return res.json({ sabor_id: sabor.id, sabor_nombre: sabor.nombre, items: [], costo_kg_hoy: null });
    const rc = recetas.get(rid);
    const d = desglosarReceta(rc, new Map(nombres.rows.map((n) => [n.id, n.nombre])), fecha, precios);
    const tipo = new Map(nombres.rows.map((n) => [n.id, n.tipo]));
    res.json({ sabor_id: sabor.id, sabor_nombre: sabor.nombre, receta_id: rid, items: d.lineas.map((l) => ({ ...l, gramos: l.gramos, insumo_tipo: tipo.get(l.insumo_id) })),
      costo_kg_hoy: d.costo_kg, costo_lote: d.costo_lote, peso_lote_g: d.peso_lote_g, precio_venta_kg: d.precio_venta_kg, margen: d.margen });
  });
  // Guarda la receta COMPLETA de un sabor en una sola solicitud (reemplaza todos los ingredientes).
  const esqReceta = z.object({
    items: z.array(z.object({ insumo_id: uuid, gramos: z.coerce.number().finite().gt(0, 'Cada ingrediente necesita insumo_id y gramos (mayor a 0)').max(10_000_000) })).max(80),
    precio_venta_kg: z.coerce.number().finite().min(0).max(1_000_000).optional().nullable(),
  });
  r.put('/recetas/:saborId', async (req, res) => {
    const b = validar(esqReceta, req.body);
    const id = await db.tx(async (q) => {
      const sabor = (await q.query('select id, nombre from rep.sabores where id = $1 and empresa_id = $2', [validar(uuid, req.params.saborId), emp(req)])).rows[0];
      if (!sabor) throw noEncontrado('Sabor no encontrado');
      const ids = [...new Set(b.items.map((i) => i.insumo_id))];
      const ok = ids.length ? (await q.query('select count(*)::int as n from prod.costeo_insumos where empresa_id = $1 and id = any($2::uuid[])', [emp(req), ids])).rows[0].n : 0;
      if (ok !== ids.length) throw malaPeticion('Hay un insumo que no existe en el catálogo');
      let rc = (await q.query('select id, precio_venta_kg from prod.costeo_recetas where empresa_id = $1 and sabor_id = $2', [emp(req), sabor.id])).rows[0];
      const antes = rc ? (await q.query('select count(*)::int as n from prod.receta_insumos where receta_id = $1', [rc.id])).rows[0].n : null;
      if (!rc) rc = (await q.query('insert into prod.costeo_recetas (empresa_id, nombre, sabor_id) values ($1,$2,$3) returning id', [emp(req), sabor.nombre, sabor.id])).rows[0];
      await q.query('delete from prod.receta_insumos where receta_id = $1', [rc.id]);
      for (const it of b.items) await q.query('insert into prod.receta_insumos (receta_id, insumo_id, gramos) values ($1,$2,$3)', [rc.id, it.insumo_id, it.gramos]);
      if (b.precio_venta_kg !== undefined) await q.query('update prod.costeo_recetas set precio_venta_kg = $2, updated_at = now() where id = $1', [rc.id, b.precio_venta_kg]);
      else await q.query('update prod.costeo_recetas set updated_at = now() where id = $1', [rc.id]);
      await auditar(q, req.ctx, 'costeo.receta_guardar', 'receta', rc.id, { sabor: sabor.nombre, ingredientes_antes: antes, ingredientes: b.items.length, precio_venta_kg: b.precio_venta_kg ?? undefined });
      return rc.id;
    });
    res.json({ ok: true, receta_id: id });
  });
  // La producción histórica que ya tenía costo congelado NO se toca; la nueva queda sin costo hasta cargar otra receta.
  r.delete('/recetas/:saborId', async (req, res) => {
    await db.tx(async (q) => {
      const rc = (await q.query('select id, nombre from prod.costeo_recetas where empresa_id = $1 and sabor_id = $2', [emp(req), validar(uuid, req.params.saborId)])).rows[0];
      if (!rc) throw noEncontrado('Ese sabor no tiene receta');
      await q.query('delete from prod.costeo_recetas where id = $1', [rc.id]);
      await auditar(q, req.ctx, 'costeo.receta_borrar', 'receta', rc.id, { nombre: rc.nombre });
    });
    res.json({ ok: true });
  });
  r.post('/recetas/:id/enganchar', async (req, res) => {
    const { sabor_id } = validar(z.object({ sabor_id: uuid }), req.body);
    await db.tx(async (q) => {
      const rc = (await q.query('select id, nombre from prod.costeo_recetas where id = $1 and empresa_id = $2 and sabor_id is null', [validar(uuid, req.params.id), emp(req)])).rows[0];
      if (!rc) throw noEncontrado('Receta no encontrada o ya enlazada');
      const sa = (await q.query('select id, nombre from rep.sabores where id = $1 and empresa_id = $2', [sabor_id, emp(req)])).rows[0];
      if (!sa) throw noEncontrado('Sabor no encontrado');
      if ((await q.query('select 1 from prod.costeo_recetas where empresa_id = $1 and sabor_id = $2', [emp(req), sabor_id])).rows.length) throw conflicto(`${sa.nombre} ya tiene una receta`);
      await q.query('update prod.costeo_recetas set sabor_id = $2, updated_at = now() where id = $1', [rc.id, sabor_id]);
      await auditar(q, req.ctx, 'costeo.receta_enganchar', 'receta', rc.id, { receta: rc.nombre, sabor: sa.nombre });
    });
    res.json({ ok: true });
  });
  // Vuelve a enlazar, por nombre, las recetas que no tienen sabor (después de crear un sabor nuevo).
  r.post('/enganchar', async (req, res) => {
    const out = (await db.query('select prod.enganchar_recetas($1) as r', [emp(req)])).rows[0].r;
    await auditar(db, req.ctx, 'costeo.enganchar', 'receta', null, out);
    res.json(out);
  });

  // ── Panorama ──
  r.get('/dashboard', async (req, res) => { res.json(await resumenCosteo(db, emp(req), fechaQ(req))); });
  r.get('/dashboard/rango', async (req, res) => {
    const { desde, hasta } = req.query;
    if (!FECHA_ISO.test(desde || '') || !FECHA_ISO.test(hasta || '')) throw malaPeticion('Faltan desde y hasta');
    res.json(await resumenCosteoRango(db, emp(req), desde, hasta));
  });
  r.get('/consumo', async (req, res) => {
    const hasta = FECHA_ISO.test(req.query.hasta || '') ? req.query.hasta : hoyHN();
    const desde = FECHA_ISO.test(req.query.desde || '') ? req.query.desde : sumarDias(hasta, -29);
    res.json(await calcularConsumoInsumos(db, emp(req), desde, hasta));
  });
  // Completa el costo de las tandas que quedaron sin costear (sabor sin receta o con un precio faltante en su día).
  // Nunca toca una que ya tiene costo congelado.
  r.post('/recalcular-pendientes', async (req, res) => {
    const out = await db.tx(async (q) => {
      const pend = (await q.query('select id, fecha::text as fecha, sabor_id, kg::float8 as kg from prod.producciones where empresa_id = $1 and costo_kg_congelado is null', [emp(req)])).rows;
      const [recetas, precios] = await Promise.all([cargarRecetas(q, emp(req)), cargarPrecios(q, emp(req))]);
      const indice = indiceRecetaPorSabor(recetas);
      let n = 0;
      for (const p of pend) {
        const { costoKg, costoTotal } = congelarCosto(p.sabor_id, p.fecha, p.kg, recetas, precios, indice);
        if (costoKg === null) continue;
        await q.query('update prod.producciones set costo_kg_congelado = $2, costo_total_congelado = $3 where id = $1', [p.id, costoKg, costoTotal]);
        n++;
      }
      await auditar(q, req.ctx, 'costeo.recalcular_pendientes', 'tanda', null, { revisadas: pend.length, actualizadas: n });
      return { ok: true, revisadas: pend.length, actualizadas: n };
    });
    res.json(out);
  });

  return r;
}
