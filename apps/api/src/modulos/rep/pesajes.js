import { Router } from 'express';
import { z } from 'zod';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { malaPeticion, validar, fechaISO, uuid, noEncontrado } from '../../lib/http.js';
import { categoriaParaGramos, panasParaCategoria } from './lib/reposicion.js';
import { resolverRango } from './lib/rangoFechas.js';
import { diasEntre } from './lib/fechasSemana.js';
import { GRAMOS_MAXIMO_RAZONABLE, empresaDe, sucursalDe } from './util.js';

const gramos = z.coerce.number({ invalid_type_error: 'Gramos inválidos' }).finite().min(0, `Gramos inválidos (entre 0 y ${GRAMOS_MAXIMO_RAZONABLE})`).max(GRAMOS_MAXIMO_RAZONABLE, `Gramos inválidos (entre 0 y ${GRAMOS_MAXIMO_RAZONABLE})`);
const clienteId = z.string().trim().max(80).optional().nullable().transform((v) => v || null);
const itemPesaje = z.object({ sabor_id: uuid, gramos, cliente_id: clienteId, fuente: z.enum(['manual', 'foto']).optional() });

/**
 * Guarda un pesaje y recalcula el despacho pendiente de esa noche. Regla del original:
 *   < 3000 g → 🔴 roja (2 panas) · 3000–5000 g → 🟡 amarilla (1 pana) · > 5000 g → no necesita reposición.
 * Un despacho ya preparado/enviado/recibido no se toca; uno pendiente se actualiza o se cae.
 */
export async function registrarPesaje(q, { empresaId, usuarioId, sucursalId, fecha, saborId, gramos: g, fuente = 'manual', clienteId: cid = null, panaGramos }) {
  await q.query(
    `insert into rep.pesajes (empresa_id, sucursal_id, sabor_id, fecha, gramos, fuente, cliente_id, usuario_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (empresa_id, cliente_id) where cliente_id is not null do nothing`,
    [empresaId, sucursalId, saborId, fecha, g, fuente, cid, usuarioId]);
  const categoria = categoriaParaGramos(g);
  const existente = (await q.query('select id, estado from rep.despachos where empresa_id = $1 and fecha = $2 and sucursal_id = $3 and sabor_id = $4', [empresaId, fecha, sucursalId, saborId])).rows[0];
  if (!categoria) {
    if (existente?.estado === 'pendiente') await q.query('delete from rep.despachos where id = $1', [existente.id]);
    return null;
  }
  const panas = panasParaCategoria(categoria);
  const gramosEnviados = panas * panaGramos;
  if (existente?.estado === 'pendiente') {
    await q.query('update rep.despachos set categoria = $2, panas = $3, gramos_enviados = $4 where id = $1', [existente.id, categoria, panas, gramosEnviados]);
  } else if (!existente) {
    await q.query(
      `insert into rep.despachos (empresa_id, fecha, sucursal_id, sabor_id, categoria, panas, gramos_enviados) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (empresa_id, fecha, sucursal_id, sabor_id) do nothing`, [empresaId, fecha, sucursalId, saborId, categoria, panas, gramosEnviados]);
  }
  return { categoria, panas, gramosEnviados };
}

export function rutasPesajes({ db }) {
  const r = Router();

  // Un pesaje suelto (el reporte de la noche usa /lote).
  r.post('/', requierePermiso('rep:pesar'), async (req, res) => {
    const b = validar(z.object({ sucursal_id: uuid, sabor_id: uuid, fecha: fechaISO, gramos, cliente_id: clienteId }), req.body);
    const suc = await sucursalDe(db, req, b.sucursal_id);
    const out = await db.tx(async (q) => {
      const sa = (await q.query('select gramos_pana from rep.sabores where id = $1 and empresa_id = $2', [b.sabor_id, empresaDe(req)])).rows[0];
      if (!sa) throw noEncontrado('Sabor no encontrado');
      const despacho = await registrarPesaje(q, { empresaId: empresaDe(req), usuarioId: req.ctx.usuario.id, sucursalId: suc.id, fecha: b.fecha, saborId: b.sabor_id, gramos: b.gramos, clienteId: b.cliente_id, panaGramos: sa.gramos_pana });
      await auditar(q, req.ctx, 'pesaje.registrar', 'pesaje', b.sabor_id, { sucursal: suc.nombre, fecha: b.fecha, gramos: b.gramos }, { sucursalId: suc.id });
      return despacho;
    });
    res.status(201).json({ ok: true, despacho: out });
  });

  /**
   * Guarda TODOS los pesajes del reporte de la noche en una sola solicitud y una sola transacción:
   * o entra el reporte completo, o no entra nada. Idempotente por cliente_id (doble toque o cola sin señal).
   */
  r.post('/lote', requierePermiso('rep:pesar'), async (req, res) => {
    const b = validar(z.object({ sucursal_id: uuid, fecha: fechaISO, pesajes: z.array(itemPesaje).min(1, 'Faltan campos requeridos (al menos un pesaje)').max(200) }), req.body);
    const suc = await sucursalDe(db, req, b.sucursal_id);
    const resultados = await db.tx(async (q) => {
      const ids = [...new Set(b.pesajes.map((p) => p.sabor_id))];
      const panas = new Map((await q.query('select id, gramos_pana from rep.sabores where empresa_id = $1 and id = any($2::uuid[])', [empresaDe(req), ids])).rows.map((s) => [s.id, s.gramos_pana]));
      const out = [];
      for (const p of b.pesajes) {
        const panaG = panas.get(p.sabor_id);
        if (panaG === undefined) continue;   // sabor que ya no existe: se ignora en vez de romper todo el reporte
        const despacho = await registrarPesaje(q, { empresaId: empresaDe(req), usuarioId: req.ctx.usuario.id, sucursalId: suc.id, fecha: b.fecha, saborId: p.sabor_id, gramos: p.gramos, fuente: p.fuente || 'manual', clienteId: p.cliente_id, panaGramos: panaG });
        out.push({ sabor_id: p.sabor_id, despacho });
      }
      const rojas = out.filter((o) => o.despacho?.categoria === 'roja').length;
      const amarillas = out.filter((o) => o.despacho?.categoria === 'amarilla').length;
      await auditar(q, req.ctx, 'pesaje.reporte', 'sucursal', suc.id, { sucursal: suc.nombre, fecha: b.fecha, sabores: out.length, rojas, amarillas, fuente: b.pesajes.some((p) => p.fuente === 'foto') ? 'foto+manual' : 'manual' }, { sucursalId: suc.id });
      return out;
    });
    res.status(201).json({ ok: true, guardados: resultados.length, resultados });
  });

  /**
   * Historial de reportes de una tienda (vista de dueño/gerente): qué pesó cada noche y cuántas noches del
   * rango tienen reporte. La pregunta real no es «cuánto pesó tal sabor» sino «¿reportaron anoche, y antenoche…?».
   */
  r.get('/historial', requierePermiso('rep:ver'), async (req, res) => {
    const suc = await sucursalDe(db, req, req.query.sucursal_id);
    const rango = resolverRango(req.query);
    if (rango.error) throw malaPeticion(rango.error);
    const { rows } = await db.query(
      `select p.fecha::text as fecha, p.sabor_id, sa.nombre as sabor_nombre, p.gramos::float8 as gramos
         from rep.pesajes p join rep.sabores sa on sa.id = p.sabor_id
        where p.empresa_id = $1 and p.sucursal_id = $2 and p.fecha between $3 and $4 order by p.fecha desc, sa.nombre`, [empresaDe(req), suc.id, rango.desde, rango.hasta]);
    const porFecha = new Map();
    for (const f of rows) {
      if (!porFecha.has(f.fecha)) porFecha.set(f.fecha, []);
      porFecha.get(f.fecha).push({ sabor_id: f.sabor_id, nombre: f.sabor_nombre, gramos: f.gramos, kg: Math.round(f.gramos / 100) / 10 });
    }
    const noches = [...porFecha.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([fecha, sabores]) => ({ fecha, sabores, totalKg: Math.round(sabores.reduce((a, s) => a + s.gramos, 0) / 100) / 10 }));
    res.json({ sucursal: { id: suc.id, nombre: suc.nombre }, desde: rango.desde, hasta: rango.hasta, diasEnRango: diasEntre(rango.desde, rango.hasta) + 1, nochesConReporte: noches.length, noches });
  });

  r.get('/:sucursalId/:fecha', requierePermiso('rep:pesar', 'rep:despachar', 'rep:ver'), async (req, res) => {
    const suc = await sucursalDe(db, req, req.params.sucursalId);
    const fecha = validar(fechaISO, req.params.fecha);
    const { rows } = await db.query(
      `select p.id, p.sabor_id, sa.nombre as sabor_nombre, p.gramos::float8 as gramos, p.fuente, p.created_at as creado_en
         from rep.pesajes p join rep.sabores sa on sa.id = p.sabor_id
        where p.empresa_id = $1 and p.sucursal_id = $2 and p.fecha = $3 order by sa.nombre`, [empresaDe(req), suc.id, fecha]);
    res.json(rows);
  });
  return r;
}
