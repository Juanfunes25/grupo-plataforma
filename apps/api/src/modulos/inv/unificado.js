// Inventario unificado · /api/inv/u/…
// Una vista con los mismos conceptos (existencia, mínimo, valor, estado) para las cuatro empresas, con alertas,
// conteos cíclicos, traslados con documento y kardex consolidado. No toca las pantallas de cada empresa:
// lee sus tablas y mueve stock con sus propias funciones (ver adaptadores.js).
import { Router } from 'express';
import { z } from 'zod';
import { permisosDe, fechaHN } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { fechaISO, malaPeticion, uuid, validar } from '../../lib/http.js';
import { FUENTES, fuentesDe, kardex, leerItem, listarItems, resumirItems, vencimientos } from './adaptadores.js';
import { montarConteos } from './conteos.js';
import { montarTraslados } from './traslados.js';

const verCostos = (permisos) => permisos.has('fin:ver') || permisos.has('rep:costeo') || permisos.has('pos:catalogo');
const ESTADOS = ['ok', 'bajo', 'agotado', 'negativo', 'sin_cargar'];

/** Alertas de inventario de una empresa (las usa la pantalla, el tablero del grupo y, si se quiere, los avisos por correo). */
export async function alertasInventario(q, ctx, dias = 7) {
  const items = await listarItems(q, ctx, {});
  const venc = await vencimientos(q, ctx, dias);
  const hoy = fechaHN();
  const conteos = (await q.query(
    `select c.id, c.numero, c.nombre, c.estado, c.fecha_programada from invu.conteos c where c.empresa_id = $1 and c.estado in ('programado','en_conteo','por_aprobar') order by c.fecha_programada`, [ctx.empresa.id])).rows;
  const enTransito = (await q.query(
    `select t.id, t.numero, t.created_at, t.empresa_origen_id, t.empresa_destino_id from invu.traslados t where t.estado = 'en_transito' and (t.empresa_origen_id = $1 or t.empresa_destino_id = $1) order by t.created_at`, [ctx.empresa.id])).rows;
  return {
    resumen: resumirItems(items, dias),
    bajo_minimo: items.filter((i) => i.estado === 'bajo' || (i.estado === 'agotado' && i.minimo > 0)).sort((a, b) => (a.existencia / (a.minimo || 1)) - (b.existencia / (b.minimo || 1))),
    negativos: items.filter((i) => i.estado === 'negativo'),
    vencimientos: venc,
    conteos_pendientes: conteos.map((c) => ({ ...c, vencido: c.estado !== 'por_aprobar' && c.fecha_programada < hoy })),
    traslados_en_transito: enTransito.map((t) => ({ ...t, por_recibir: t.empresa_destino_id === ctx.empresa.id })),
  };
}

export function rutasUnificado({ db, ctxMgr }) {
  const r = Router();
  const ver = requierePermiso('inv:ver');
  const operar = requierePermiso('inv:mover');
  /** Contexto de inventario de la petición (qué empresa, qué sucursales y si puede ver costos). */
  const ctxInv = (req) => ({ empresa: req.ctx.empresa, sucursalIds: req.ctx.sucursalIds, usuario: req.ctx.usuario, rol: req.ctx.rol, costos: verCostos(req.ctx.permisos) });

  r.get('/existencias', ver, async (req, res) => {
    const f = validar(z.object({
      fuente: z.string().max(20).optional(), sucursal_id: uuid.optional(), categoria: z.string().max(80).optional(),
      estado: z.enum(ESTADOS).optional(), q: z.string().trim().max(80).optional(), vence: z.enum(['1']).optional(),
    }), req.query);
    const ctx = ctxInv(req);
    const todos = await listarItems(db, ctx, {});
    const buscado = (f.q ?? '').toLowerCase();
    const items = todos.filter((i) => (!f.fuente || i.fuente === f.fuente) && (!f.sucursal_id || i.sucursal_id === f.sucursal_id) && (!f.categoria || i.categoria === f.categoria)
      && (!f.estado || i.estado === f.estado) && (!buscado || i.nombre.toLowerCase().includes(buscado)) && (!f.vence || i.vence));
    res.json({
      items, resumen: resumirItems(items),
      filtros: {
        fuentes: fuentesDe(req.ctx.empresa).map((id) => ({ id, nombre: FUENTES[id].nombre })),
        categorias: [...new Set(todos.map((i) => i.categoria))].sort(),
        sucursales: [...new Map(todos.filter((i) => i.sucursal_id).map((i) => [i.sucursal_id, { id: i.sucursal_id, nombre: i.sucursal }])).values()],
      },
      costos: ctx.costos,
    });
  });

  r.get('/alertas', ver, async (req, res) => {
    const { dias } = validar(z.object({ dias: z.coerce.number().int().min(0).max(365).default(7) }), req.query);
    res.json(await alertasInventario(db, ctxInv(req), dias));
  });

  r.get('/kardex', ver, async (req, res) => {
    const f = validar(z.object({ desde: fechaISO.optional(), hasta: fechaISO.optional(), q: z.string().trim().max(80).optional(), fuente: z.string().max(20).optional(), limite: z.coerce.number().int().min(1).max(1000).default(300) }), req.query);
    res.json(await kardex(db, ctxInv(req), { desde: f.desde, hasta: f.hasta, texto: f.q, fuente: f.fuente, limite: f.limite }));
  });

  // Mínimo propio de un ítem (para lo que no lo trae, como DISERCO). minimo = null lo quita y vuelve al de la fuente.
  r.put('/minimos', operar, async (req, res) => {
    const b = validar(z.object({ fuente: z.string().max(20), ref_id: uuid, sucursal_id: uuid.optional().nullable(), minimo: z.coerce.number().min(0).max(10_000_000).nullable() }), req.body);
    if (!fuentesDe(req.ctx.empresa).includes(b.fuente)) throw malaPeticion('Esa fuente no existe en esta empresa');
    const suc = FUENTES[b.fuente].sucursal ? (b.sucursal_id ?? null) : null;
    if (FUENTES[b.fuente].sucursal && !suc) throw malaPeticion('Indica la sucursal');
    await db.tx(async (q) => {
      const item = await leerItem(q, req.ctx.empresa.id, b.fuente, b.ref_id, suc);
      await q.query(`delete from invu.minimos where empresa_id = $1 and fuente = $2 and ref_id = $3 and coalesce(sucursal_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce($4::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
        [req.ctx.empresa.id, b.fuente, b.ref_id, suc]);
      if (b.minimo != null) await q.query('insert into invu.minimos (empresa_id, fuente, ref_id, sucursal_id, minimo, updated_by) values ($1,$2,$3,$4,$5,$6)', [req.ctx.empresa.id, b.fuente, b.ref_id, suc, b.minimo, req.ctx.usuario.id]);
      await auditar(q, req.ctx, 'inv.minimo_definido', 'item', b.ref_id, { item: item.nombre, fuente: b.fuente, minimo: b.minimo }, { sucursalId: suc });
    });
    res.json({ ok: true });
  });

  // Vista del grupo (Dirección): una fila por empresa con lo mismo, más lo que hay que atender.
  r.get('/grupo', requierePermiso('grupo:ver'), async (req, res) => {
    const { dias } = validar(z.object({ dias: z.coerce.number().int().min(0).max(365).default(7) }), req.query);
    const u = req.ctx.usuario;
    const todas = await ctxMgr.empresas();
    let accesos = [];
    if (!u.es_dueno_grupo) accesos = (await db.query('select empresa_id, rol, permisos_extra, permisos_quitados from core.accesos where usuario_id = $1 and activo', [u.id])).rows;
    const empresas = [];
    for (const e of todas) {
      let permisos;
      if (u.es_dueno_grupo) permisos = permisosDe('dueno');
      else { const a = accesos.find((x) => x.empresa_id === e.id); if (!a) continue; permisos = permisosDe(a.rol, a.permisos_extra, a.permisos_quitados); if (!permisos.has('grupo:ver')) continue; }
      const ctx = { empresa: e, sucursalIds: [], usuario: u, rol: 'dueno', costos: u.es_dueno_grupo || verCostos(permisos) };
      const a = await alertasInventario(db, ctx, dias);
      empresas.push({
        codigo: e.codigo, nombre: e.nombre, color: e.color, fuentes: fuentesDe(e).map((f) => FUENTES[f].nombre), costos: ctx.costos,
        resumen: a.resumen, bajo_minimo: a.bajo_minimo.slice(0, 8), negativos: a.negativos.slice(0, 5), vencimientos: a.vencimientos.slice(0, 8),
        conteos_pendientes: a.conteos_pendientes, traslados_en_transito: a.traslados_en_transito.length,
      });
    }
    const ids = todas.filter((e) => empresas.some((x) => x.codigo === e.codigo)).map((e) => e.id);
    const traslados = (await db.query(
      `select t.id, t.numero, t.estado, t.created_at, t.valor_total, t.con_diferencia, eo.nombre as origen, ed.nombre as destino, t.empresa_origen_id <> t.empresa_destino_id as entre_empresas,
              (select count(*)::int from invu.traslado_lineas l where l.traslado_id = t.id) as lineas
         from invu.traslados t join core.empresas eo on eo.id = t.empresa_origen_id join core.empresas ed on ed.id = t.empresa_destino_id
        where (t.empresa_origen_id = any($1::uuid[]) or t.empresa_destino_id = any($1::uuid[])) and (t.estado = 'en_transito' or t.created_at > now() - interval '30 days')
        order by t.created_at desc limit 30`, [ids])).rows;
    const costosTodos = u.es_dueno_grupo || empresas.every((e) => e.costos);
    res.json({
      dias, empresas,
      total: {
        valor: costosTodos ? Math.round(empresas.reduce((s, e) => s + e.resumen.valor, 0) * 100) / 100 : null,
        bajo_minimo: empresas.reduce((s, e) => s + e.resumen.bajo_minimo, 0), negativos: empresas.reduce((s, e) => s + e.resumen.negativos, 0),
        por_vencer: empresas.reduce((s, e) => s + e.resumen.por_vencer, 0), traslados_en_transito: traslados.filter((t) => t.estado === 'en_transito').length,
      },
      traslados: traslados.map((t) => ({ ...t, numero_doc: `TR-${String(t.numero).padStart(4, '0')}`, valor_total: costosTodos ? t.valor_total : null })),
    });
  });

  montarConteos(r, { db, ctxInv });
  montarTraslados(r, { db, ctxMgr, ctxInv });
  return r;
}
