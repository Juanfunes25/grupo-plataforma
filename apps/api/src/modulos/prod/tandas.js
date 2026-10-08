// Rutas de producción por tanda: registro del día, corrección, borrado, etiqueta, consumo de materia
// prima, reporte por rango y plan de producción. Montadas bajo /api/prod por rutas.js.
//
// Permisos (igual que los roles del original): quien PRODUCE (rep:producir) registra y corrige tandas pero
// NUNCA ve recetas, consumos ni costos —la respuesta de registrar no dice cuánta materia prima lleva un
// sabor—; confirmar el consumo exige conocer la receta (rep:costeo o rep:inventario); el reporte por rango
// y el plan son del dueño/gerente (rep:costeo) y del despachador (rep:despachar).
import { Router } from 'express';
import { z } from 'zod';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { conflicto, fechaISO, malaPeticion, noEncontrado, uuid, validar } from '../../lib/http.js';
import { sumarDias } from '@grupo/shared';
import { cargarPrecios, cargarRecetas, congelarCosto, indiceRecetaPorSabor } from './costeo.js';
import { aplicarConsumo, desviacion, esDesviacionNotable, planificarConsumo, revertirConsumo, tandaYaDespachada } from './consumo.js';
import { FECHA_ISO, hoyHN, resolverRango, round2 } from './comun.js';
import { planProduccionDeDatos } from './plan.js';

// Cota generosa (una tanda real ronda 30-40 kg) solo para atajar un dígito de más (450 en vez de 45)
// antes de que ensucie el costeo y las estadísticas.
export const KG_MAXIMO_RAZONABLE = 500;

const COLUMNAS_TANDA = `p.id, p.sabor_id, sa.nombre as sabor_nombre, sa.gramos_pana, p.kg::float8 as kg, p.panas::float8 as panas, p.lote, p.fecha::text as fecha,
  p.operario, p.notas, p.created_at as creado_en`;

export function rutasTandas({ db }) {
  const r = Router();
  const emp = (req) => req.ctx.empresa.id;
  const VER_TANDAS = ['rep:producir', 'rep:costeo', 'rep:inventario'];
  const CONSUMO = ['rep:costeo', 'rep:inventario'];

  async function tandaDe(q, req, id, bloquear = false) {
    const t = (await q.query(
      `select p.*, p.kg::float8 as kg_n, sa.nombre as sabor_nombre from prod.producciones p join rep.sabores sa on sa.id = p.sabor_id
        where p.id = $1 and p.empresa_id = $2 ${bloquear ? 'for update of p' : ''}`, [validar(uuid, id), emp(req)])).rows[0];
    if (!t) throw noEncontrado('Producción no encontrada');
    return { ...t, fecha: String(t.fecha).slice(0, 10), kg: Number(t.kg) };
  }

  // ── Catálogo de sabores para el formulario: todos los activos, sin filtrar por sucursal ──
  r.get('/sabores', requierePermiso(...VER_TANDAS), async (req, res) => {
    const { rows } = await db.query('select id, nombre, gramos_pana from rep.sabores where empresa_id = $1 and activo order by nombre', [emp(req)]);
    res.json(rows);
  });

  // ── La producción de un día (para que la propia fábrica vea qué ya cargó hoy) ──
  r.get('/tandas', requierePermiso(...VER_TANDAS), async (req, res) => {
    const fecha = FECHA_ISO.test(req.query.fecha || '') ? req.query.fecha : hoyHN();
    const { rows } = await db.query(
      `select ${COLUMNAS_TANDA},
              exists (select 1 from rep.despacho_tandas dt where dt.produccion_id = p.id) as despachada,
              exists (select 1 from prod.consumos c where c.produccion_id = p.id) as con_consumo
         from prod.producciones p join rep.sabores sa on sa.id = p.sabor_id
        where p.empresa_id = $1 and p.fecha = $2 order by p.created_at desc`, [emp(req), fecha]);
    // Quien produce no ve si el consumo está confirmado (es parte de la receta/inventario).
    const verConsumo = CONSUMO.some((p) => req.ctx.permisos.has(p));
    res.json(rows.map((t) => (verConsumo ? t : { ...t, con_consumo: undefined })));
  });

  /**
   * Registra toda la producción del día en UNA solicitud atómica: o entra completa, o no entra nada
   * (evita perder media captura si se corta la conexión). El lote de trazabilidad se arma solo
   * (fecha + código del sabor + n.º de tanda de ese sabor ese día). De paso se congela el costo de cada tanda con el
   * precio vigente A ESA fecha; queda NULL si el sabor no tiene receta o falta algún precio
   * (POST /costeo/recalcular-pendientes lo completa después). Registrar NO descuenta materia prima:
   * eso se confirma aparte (POST /tandas/:id/consumo), porque la materia prima sale de bodega en una salida por lote.
   */
  const esqLote = z.object({
    fecha: fechaISO,
    operario: z.string().trim().max(80).default(''),
    items: z.array(z.object({
      sabor_id: uuid,
      kg: z.coerce.number().finite().gt(0, 'Cada item necesita kg mayores a 0').max(KG_MAXIMO_RAZONABLE, `Cada item necesita kg entre 0 y ${KG_MAXIMO_RAZONABLE}`),
      panas: z.coerce.number().finite().gt(0).max(200).optional().nullable(),
      notas: z.string().trim().max(300).optional().nullable(),
      cliente_id: z.string().trim().min(6).max(80).optional().nullable(),
    })).min(1, 'Falta al menos un item').max(100),
  });
  r.post('/tandas/lote', requierePermiso('rep:producir'), async (req, res) => {
    const b = validar(esqLote, req.body);
    if (b.fecha > sumarDias(hoyHN(), 1)) throw malaPeticion('La fecha de producción no puede ser futura');
    const ids = [...new Set(b.items.map((i) => i.sabor_id))];
    const sabores = (await db.query('select id, nombre from rep.sabores where empresa_id = $1 and activo and id = any($2::uuid[])', [emp(req), ids])).rows;
    if (sabores.length !== ids.length) throw malaPeticion('Hay un sabor que no existe o está desactivado');
    const nombre = new Map(sabores.map((s) => [s.id, s.nombre]));
    const [recetas, precios] = await Promise.all([cargarRecetas(db, emp(req)), cargarPrecios(db, emp(req))]);
    const indice = indiceRecetaPorSabor(recetas);
    const compacta = b.fecha.replace(/-/g, '');

    const guardados = await db.tx(async (q) => {
      const out = [];
      for (const it of b.items) {
        if (it.cliente_id) {      // reintento sin señal: ya estaba guardado, no se duplica
          const ya = (await q.query('select id, lote from prod.producciones where empresa_id = $1 and cliente_id = $2', [emp(req), it.cliente_id])).rows[0];
          if (ya) { out.push({ id: ya.id, lote: ya.lote, sabor_id: it.sabor_id, kg: it.kg, repetida: true }); continue; }
        }
        const { costoKg, costoTotal } = congelarCosto(it.sabor_id, b.fecha, it.kg, recetas, precios, indice);
        const cod = (await q.query('select prod.codigo_sabor($1, $2) as c', [emp(req), it.sabor_id])).rows[0].c;
        const n = (await q.query('select prod.siguiente($1, $2) as n', [emp(req), `lote:${compacta}:${cod}`])).rows[0].n;
        const lote = `${compacta}-${cod}-${n}`;
        const t = (await q.query(
          `insert into prod.producciones (empresa_id, fecha, sabor_id, kg, panas, kg_restante, lote, operario, notas, costo_kg_congelado, costo_total_congelado, cliente_id, usuario_id)
           values ($1,$2,$3,$4,$5,$4,$6,$7,$8,$9,$10,$11,$12) returning id, lote`,
          [emp(req), b.fecha, it.sabor_id, it.kg, it.panas ?? null, lote, b.operario, it.notas ?? '', costoKg, costoTotal, it.cliente_id ?? null, req.ctx.usuario.id])).rows[0];
        await auditar(q, req.ctx, 'tanda.registrar', 'tanda', t.id, { lote: t.lote, sabor: nombre.get(it.sabor_id), kg: it.kg, fecha: b.fecha, operario: b.operario || null });
        out.push({ id: t.id, lote: t.lote, sabor_id: it.sabor_id, kg: it.kg });
      }
      return out;
    });
    // NO se devuelve costo ni materia prima: esta ruta es de quien produce.
    res.status(201).json({
      ok: true, guardados: guardados.length,
      items: guardados.map((g) => ({ id: g.id, sabor_id: g.sabor_id, sabor_nombre: nombre.get(g.sabor_id) ?? '', kg: g.kg, fecha: b.fecha, lote: g.lote, repetida: g.repetida || undefined })),
    });
  });

  /**
   * Corrige una tanda mal cargada (kg o sabor equivocado). La fecha no se cambia: es corregir «lo que se puso mal»,
   * no reingresar a otro día. El costo se congela de nuevo con el precio vigente a la fecha ORIGINAL. Si ya se había
   * confirmado el consumo, ese descuento se DESHACE (los kg vuelven al stock y a sus lotes) y no se vuelve a aplicar
   * solo: el número nuevo lo pone una persona.
   */
  const esqPatch = z.object({
    sabor_id: uuid.optional(),
    kg: z.coerce.number().finite().gt(0, 'Kg inválido').max(KG_MAXIMO_RAZONABLE, `Kg inválido (entre 0 y ${KG_MAXIMO_RAZONABLE})`).optional(),
    panas: z.coerce.number().finite().gt(0).max(200).optional().nullable(),
    notas: z.string().trim().max(300).optional(),
  });
  r.patch('/tandas/:id', requierePermiso('rep:producir'), async (req, res) => {
    const b = validar(esqPatch, req.body);
    const [recetas, precios] = await Promise.all([cargarRecetas(db, emp(req)), cargarPrecios(db, emp(req))]);
    const out = await db.tx(async (q) => {
      const t = await tandaDe(q, req, req.params.id, true);
      if (await tandaYaDespachada(q, emp(req), t.id)) throw conflicto('Esta tanda ya salió en un despacho: no se puede corregir sin perder el rastro de lo que se envió');
      const saborId = b.sabor_id ?? t.sabor_id;
      if (b.sabor_id) {
        const ok = (await q.query('select 1 from rep.sabores where id = $1 and empresa_id = $2 and activo', [saborId, emp(req)])).rows.length;
        if (!ok) throw malaPeticion('Ese sabor no existe o está desactivado');
      }
      const kg = b.kg ?? t.kg;
      const { costoKg, costoTotal } = congelarCosto(saborId, t.fecha, kg, recetas, precios, indiceRecetaPorSabor(recetas));
      const deshecho = await revertirConsumo(q, req.ctx, t.id, `Corrección de la tanda ${t.lote}`);
      await q.query(
        `update prod.producciones set sabor_id = $2, kg = $3, kg_restante = $3, panas = $4, notas = $5, costo_kg_congelado = $6, costo_total_congelado = $7 where id = $1`,
        [t.id, saborId, kg, b.panas === undefined ? t.panas : b.panas, b.notas ?? t.notas, costoKg, costoTotal]);
      await auditar(q, req.ctx, 'tanda.corregir', 'tanda', t.id, { lote: t.lote, antes: { kg: t.kg, sabor_id: t.sabor_id }, despues: { kg, sabor_id: saborId }, consumo_deshecho: deshecho });
      return { kg, sabor_id: saborId, deshecho, costoKg };
    });
    res.json({ ok: true, kg: out.kg, sabor_id: out.sabor_id, descuento_deshecho: out.deshecho, ...(CONSUMO.some((p) => req.ctx.permisos.has(p)) ? { costo_kg_congelado: out.costoKg } : {}) });
  });

  // Borra una tanda cargada por error (sabor o día equivocado, entrada duplicada) y devuelve al stock lo que se le descontó.
  r.delete('/tandas/:id', requierePermiso('rep:producir'), async (req, res) => {
    await db.tx(async (q) => {
      const t = await tandaDe(q, req, req.params.id, true);
      if (await tandaYaDespachada(q, emp(req), t.id)) throw conflicto('Esta tanda ya salió en un despacho: no se puede borrar sin perder el rastro de lo que se envió');
      await revertirConsumo(q, req.ctx, t.id, `Tanda ${t.lote} borrada`);
      await q.query('delete from prod.producciones where id = $1', [t.id]);
      await auditar(q, req.ctx, 'tanda.borrar', 'tanda', t.id, { lote: t.lote, sabor: t.sabor_nombre, kg: t.kg, fecha: t.fecha });
    });
    res.json({ ok: true });
  });

  // Imprimir (o reimprimir) la etiqueta: queda en la bitácora y devuelve lo que lleva impreso.
  r.post('/tandas/:id/etiqueta', requierePermiso(...VER_TANDAS), async (req, res) => {
    const t = await tandaDe(db, req, req.params.id);
    await auditar(db, req.ctx, 'tanda.etiqueta', 'tanda', t.id, { lote: t.lote });
    res.json({ id: t.id, lote: t.lote, sabor_nombre: t.sabor_nombre, kg: t.kg, panas: t.panas === null ? null : Number(t.panas), fecha: t.fecha, operario: t.operario, empresa: { nombre: req.ctx.empresa.nombre } });
  });

  // ═══ Consumo de materia prima de la tanda (exige conocer la receta) ═══
  r.get('/tandas/:id/consumo', requierePermiso(...CONSUMO), async (req, res) => {
    const t = await tandaDe(db, req, req.params.id);
    const [guardado, lotes, plan] = await Promise.all([
      db.query(
        `select c.insumo_id, i.nombre, i.unidad, c.cantidad_sugerida::float8 as sugerida, c.cantidad_real::float8 as real, c.sin_lote::float8 as sin_lote, c.rinv_insumo_id
           from prod.consumos c join prod.costeo_insumos i on i.id = c.insumo_id where c.produccion_id = $1 order by i.nombre`, [t.id]),
      db.query('select insumo_id, lote_id, cantidad::float8 as cantidad from prod.produccion_lotes where produccion_id = $1', [t.id]),
      planificarConsumo(db, emp(req), { saborId: t.sabor_id, kg: t.kg }),
    ]);
    res.json({
      tanda: { id: t.id, lote: t.lote, fecha: t.fecha, kg: t.kg, sabor_id: t.sabor_id, sabor_nombre: t.sabor_nombre },
      confirmado: guardado.rows.length > 0,
      guardado: guardado.rows.map((c) => ({ ...c, desviacion: desviacion(c.sugerida, c.real), lotes: lotes.rows.filter((l) => l.insumo_id === c.insumo_id) })),
      sugerido: plan,
    });
  });

  const esqConsumo = z.object({ consumos: z.array(z.object({ insumo_id: uuid, cantidad: z.coerce.number().finite().gt(0).max(100000) })).max(80).optional() });
  r.post('/tandas/:id/consumo', requierePermiso(...CONSUMO), async (req, res) => {
    const b = validar(esqConsumo, req.body);
    const plan = await db.tx(async (q) => {
      const t = await tandaDe(q, req, req.params.id, true);
      const p = await aplicarConsumo(q, req.ctx, t, b.consumos ?? null);
      if (p.desconocidos.length) throw malaPeticion('Hay un insumo que no existe en el catálogo de costeo');
      if (!p.consumos.length) throw malaPeticion(p.tiene_receta ? 'La receta de este sabor no tiene ingredientes: indica qué se usó' : 'Este sabor no tiene receta: indica qué se usó');
      await auditar(q, req.ctx, 'tanda.consumo_confirmar', 'tanda', t.id, { lote: t.lote, insumos: p.consumos.length, corregido_a_mano: !!b.consumos, sin_inventario: p.sin_inventario });
      return p;
    });
    res.status(201).json({ ok: true, ...plan });
  });

  r.delete('/tandas/:id/consumo', requierePermiso(...CONSUMO), async (req, res) => {
    const deshecho = await db.tx(async (q) => {
      const t = await tandaDe(q, req, req.params.id, true);
      const h = await revertirConsumo(q, req.ctx, t.id, `Se deshizo el consumo de la tanda ${t.lote}`);
      if (h) await auditar(q, req.ctx, 'tanda.consumo_deshacer', 'tanda', t.id, { lote: t.lote });
      return h;
    });
    res.json({ ok: true, deshecho });
  });

  // ═══ Reportes del dueño ═══
  const ADMIN = ['rep:costeo', 'rep:despachar'];
  /** Resumen: hoy, histórico de N días (con los días sin producción en 0) y total por sabor. */
  r.get('/tandas/resumen', requierePermiso(...ADMIN), async (req, res) => {
    const fecha = FECHA_ISO.test(req.query.fecha || '') ? req.query.fecha : hoyHN();
    const dias = Math.min(Math.max(Number(req.query.dias) || 14, 1), 90);
    const desde = sumarDias(fecha, -dias);
    const [hoy, hist, porSabor] = await Promise.all([
      db.query(`select p.id, p.sabor_id, sa.nombre as sabor_nombre, p.kg::float8 as kg, p.lote, p.operario, p.notas, p.created_at as creado_en
                  from prod.producciones p join rep.sabores sa on sa.id = p.sabor_id where p.empresa_id = $1 and p.fecha = $2 order by sa.nombre`, [emp(req), fecha]),
      db.query('select fecha::text as fecha, coalesce(sum(kg),0)::float8 as kg from prod.producciones where empresa_id = $1 and fecha >= $2 and fecha <= $3 group by fecha', [emp(req), desde, fecha]),
      db.query(`select sa.nombre as sabor_nombre, coalesce(sum(p.kg),0)::float8 as kg from prod.producciones p join rep.sabores sa on sa.id = p.sabor_id
                 where p.empresa_id = $1 and p.fecha >= $2 and p.fecha <= $3 group by sa.nombre order by kg desc`, [emp(req), desde, fecha]),
    ]);
    // Un día sin producción no trae fila: se completa en 0 para que un hueco de verdad se vea como hueco.
    const kgPorFecha = new Map(hist.rows.map((h) => [h.fecha, h.kg]));
    const historico = [];
    for (let i = dias - 1; i >= 0; i--) { const f = sumarDias(fecha, -i); historico.push({ fecha: f, kg: kgPorFecha.get(f) || 0 }); }
    res.json({ fecha, hoy: hoy.rows, historico, porSabor: porSabor.rows });
  });

  /** Lo producido en un período EXACTO, tanda por tanda (para auditar). */
  r.get('/tandas/rango', requierePermiso('rep:costeo'), async (req, res) => {
    const rango = resolverRango(req.query);
    if (rango.error) throw malaPeticion(rango.error);
    const [items, porSabor] = await Promise.all([
      db.query(`select ${COLUMNAS_TANDA} from prod.producciones p join rep.sabores sa on sa.id = p.sabor_id
                 where p.empresa_id = $1 and p.fecha between $2 and $3 order by p.fecha desc, p.created_at desc`, [emp(req), rango.desde, rango.hasta]),
      db.query(`select sa.nombre as sabor_nombre, coalesce(sum(p.kg),0)::float8 as kg, count(*)::int as tandas from prod.producciones p join rep.sabores sa on sa.id = p.sabor_id
                 where p.empresa_id = $1 and p.fecha between $2 and $3 group by sa.nombre order by kg desc`, [emp(req), rango.desde, rango.hasta]),
    ]);
    res.json({ ...rango, totalKg: Math.round(items.rows.reduce((a, i) => a + i.kg, 0) * 10) / 10, tandas: items.rows.length, porSabor: porSabor.rows, items: items.rows });
  });

  /** Qué producir y para cuándo (ver plan.js). `hoy` lo manda el cliente por si el reloj del servidor difiere. */
  r.get('/plan', requierePermiso(...ADMIN), async (req, res) => {
    const rango = resolverRango({ ...req.query, dias: req.query.dias || 90 });
    if (rango.error) throw malaPeticion(rango.error);
    const hoy = FECHA_ISO.test(req.query.hoy || '') ? req.query.hoy : hoyHN();
    const horizonteDias = Math.min(Math.max(Number(req.query.horizonte) || 7, 2), 21);
    res.json(await planProduccionDeDatos(db, emp(req), { desde: rango.desde, hasta: rango.hasta, hoy, horizonteDias }));
  });

  return r;
}

export { desviacion, esDesviacionNotable, round2 };
