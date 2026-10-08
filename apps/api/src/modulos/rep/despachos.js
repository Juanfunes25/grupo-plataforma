import { Router } from 'express';
import { z } from 'zod';
import { fechaHN } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { conflicto, malaPeticion, noEncontrado, prohibido, validar, fechaISO, uuid } from '../../lib/http.js';
import { reasignarTandas } from './tandas.js';
import { PERM_ADMIN, empresaDe, esTienda } from './util.js';

const SELECT = `select d.id, d.fecha::text as fecha, d.sucursal_id, d.sabor_id, d.categoria, d.panas, d.gramos_enviados, d.estado,
  d.gramos_confirmados_recibidos::float8 as gramos_confirmados_recibidos, d.panas_recibidas, d.discrepancia::int as discrepancia,
  d.discrepancia_resuelta::int as discrepancia_resuelta, d.notas, d.enviado_en::text as enviado_en, sa.nombre as sabor_nombre, sa.gramos_pana, su.nombre as sucursal_nombre
  from rep.despachos d join rep.sabores sa on sa.id = d.sabor_id join core.sucursales su on su.id = d.sucursal_id`;

export function rutasDespachos({ db }) {
  const r = Router();
  const emp = empresaDe;

  async function cargar(q, req, id) {
    const { rows } = await q.query(`${SELECT} where d.id = $1 and d.empresa_id = $2`, [validar(uuid, id), emp(req)]);
    if (!rows[0]) throw noEncontrado('Despacho no encontrado');
    return rows[0];
  }
  /** Una tienda solo toca lo de su sucursal. */
  function tiendaPropia(req, d) {
    if (req.ctx.sucursalIds.length && !req.ctx.sucursalIds.includes(d.sucursal_id)) throw prohibido('Ese despacho es de otra sucursal');
  }

  /**
   * Los despachos de un día. Qué es «de un día» depende de quién pregunta: la tienda pesa y pide a las 10 pm y fábrica
   * despacha a la mañana siguiente. Despachador y dueño preguntan por el día del PEDIDO (fecha); la tienda, por el día
   * de la ENTREGA (enviado_en) y nunca ve lo marcado «no disponible».
   */
  r.get('/:fecha', requierePermiso('rep:pesar', 'rep:despachar', 'rep:ver'), async (req, res) => {
    const fecha = validar(fechaISO, req.params.fecha);
    const tienda = esTienda(req.ctx);
    const params = [emp(req), fecha];
    let filtro = tienda ? 'd.enviado_en = $2' : 'd.fecha = $2';
    if (req.ctx.sucursalIds.length) { params.push(req.ctx.sucursalIds); filtro += ` and d.sucursal_id = any($3::uuid[])`; }
    if (tienda) filtro += ` and d.estado <> 'no_disponible'`;
    const { rows } = await db.query(`${SELECT} where d.empresa_id = $1 and ${filtro} order by su.nombre, d.categoria, sa.nombre`, params);
    const agrupado = {};
    for (const f of rows) (agrupado[f.sucursal_id] ||= []).push(f);
    res.json(agrupado);
  });

  // La tienda confirma en PANAS (0 a 10), que es lo que realmente cuenta al recibir; evita discrepancias falsas por balanza.
  r.patch('/:id/recepcion', requierePermiso('rep:pesar'), async (req, res) => {
    const { panas_recibidas } = validar(z.object({ panas_recibidas: z.coerce.number({ invalid_type_error: 'Falta indicar cuántas panas se recibieron' }).int().min(0, 'Panas recibidas inválidas (0 a 10)').max(10, 'Panas recibidas inválidas (0 a 10)') }), req.body);
    const out = await db.tx(async (q) => {
      const d = await cargar(q, req, req.params.id);
      tiendaPropia(req, d);
      if (d.estado === 'no_disponible') throw conflicto('Ese sabor se marcó como no disponible: no hay nada que recibir');
      const gramos = panas_recibidas * d.gramos_pana;
      const discrepancia = panas_recibidas !== d.panas;
      // discrepancia_resuelta se reinicia siempre: es una confirmación nueva (si no, una corrección heredaría un «resuelta» viejo).
      await q.query(
        `update rep.despachos set estado = 'recibido', gramos_confirmados_recibidos = $2, panas_recibidas = $3, discrepancia = $4, discrepancia_resuelta = false,
                recibido_por = $5, recibido_at = now() where id = $1`, [d.id, gramos, panas_recibidas, discrepancia, req.ctx.usuario.id]);
      await auditar(q, req.ctx, discrepancia ? 'despacho.recepcion_discrepancia' : 'despacho.recepcion', 'despacho', d.id,
        { sucursal: d.sucursal_nombre, sabor: d.sabor_nombre, fecha: d.fecha, panas_enviadas: d.panas, panas_recibidas }, { sucursalId: d.sucursal_id });
      return { ok: true, discrepancia, panas_recibidas };
    });
    res.json(out);
  });

  // Deshace una recepción confirmada por error, para poder volver a marcarla (se guarda: no es solo la pantalla).
  r.patch('/:id/corregir-recepcion', requierePermiso('rep:pesar'), async (req, res) => {
    await db.tx(async (q) => {
      const d = await cargar(q, req, req.params.id);
      tiendaPropia(req, d);
      await q.query(`update rep.despachos set estado = 'enviado', panas_recibidas = null, gramos_confirmados_recibidos = null, discrepancia = false where id = $1`, [d.id]);
      await auditar(q, req.ctx, 'despacho.corregir_recepcion', 'despacho', d.id, { sucursal: d.sucursal_nombre, sabor: d.sabor_nombre, antes_panas_recibidas: d.panas_recibidas }, { sucursalId: d.sucursal_id });
    });
    res.json({ ok: true });
  });

  r.patch('/:id/resolver-discrepancia', requierePermiso(PERM_ADMIN), async (req, res) => {
    await db.tx(async (q) => {
      const d = await cargar(q, req, req.params.id);
      await q.query('update rep.despachos set discrepancia_resuelta = true where id = $1', [d.id]);
      await auditar(q, req.ctx, 'despacho.resolver_discrepancia', 'despacho', d.id, { sucursal: d.sucursal_nombre, sabor: d.sabor_nombre, enviadas: d.panas, recibidas: d.panas_recibidas }, { sucursalId: d.sucursal_id });
    });
    res.json({ ok: true });
  });

  /** Marca el despacho como enviado con `panas` y reparte las tandas (FIFO). */
  async function enviar(q, req, d, panas) {
    const gramos = panas * d.gramos_pana;
    const sinTanda = await reasignarTandas(q, { empresaId: emp(req), despachoId: d.id, saborId: d.sabor_id, gramos, fecha: d.fecha });
    // enviado_en = el día de HOY en Honduras (cuando de verdad sale de fábrica), no la noche del pedido.
    await q.query(`update rep.despachos set panas = $2, gramos_enviados = $3, estado = 'enviado', enviado_en = $4 where id = $1`, [d.id, panas, gramos, fechaHN()]);
    return { gramos, sinTanda };
  }
  const esquemaPanas = z.coerce.number().int().refine((n) => [1, 2, 3, 4].includes(n), 'Panas inválidas (1 a 4)');

  // OJO: esta ruta va ANTES de /:id/panas-enviadas (":id" matchearía «lote»).
  r.patch('/lote/panas-enviadas', requierePermiso('rep:despachar'), async (req, res) => {
    const b = validar(z.object({ ids: z.array(uuid).min(1, 'Falta la lista de ids').max(100), panas: esquemaPanas }), req.body);
    const out = await db.tx(async (q) => {
      const { rows } = await q.query(`${SELECT} where d.empresa_id = $1 and d.id = any($2::uuid[])`, [emp(req), b.ids]);
      if (!rows.length) throw noEncontrado('Ningún despacho encontrado');
      let sinTanda = 0;
      for (const d of rows) {
        if (d.estado === 'recibido') continue;   // ya confirmado por la tienda: no se reescribe
        sinTanda += (await enviar(q, req, d, b.panas)).sinTanda;
      }
      await auditar(q, req.ctx, 'despacho.enviar_lote', 'despacho', null, { cantidad: rows.length, panas: b.panas, sucursales: [...new Set(rows.map((d) => d.sucursal_nombre))] });
      return { ok: true, actualizados: rows.length, panas: b.panas, sin_tanda: sinTanda };
    });
    res.json(out);
  });

  r.patch('/:id/panas-enviadas', requierePermiso('rep:despachar'), async (req, res) => {
    const { panas } = validar(z.object({ panas: esquemaPanas }), req.body);
    const out = await db.tx(async (q) => {
      const d = await cargar(q, req, req.params.id);
      const { gramos, sinTanda } = await enviar(q, req, d, panas);
      await auditar(q, req.ctx, 'despacho.enviar', 'despacho', d.id, { sucursal: d.sucursal_nombre, sabor: d.sabor_nombre, pedidas: d.panas, enviadas: panas, sin_tanda_g: sinTanda }, { sucursalId: d.sucursal_id });
      return { ok: true, panas, gramosEnviados: gramos, sin_tanda: sinTanda };
    });
    res.json(out);
  });

  // El despachador marca que un sabor no está (no se produjo / se acabó): sale de la ecuación, la tienda no lo ve.
  r.patch('/:id/no-disponible', requierePermiso('rep:despachar'), async (req, res) => {
    await db.tx(async (q) => {
      const d = await cargar(q, req, req.params.id);
      if (d.estado === 'recibido') throw malaPeticion('Ya fue confirmado como recibido por la tienda, no se puede marcar como no disponible');
      await reasignarTandas(q, { empresaId: emp(req), despachoId: d.id, saborId: d.sabor_id, gramos: 0, fecha: d.fecha });
      await q.query(`update rep.despachos set estado = 'no_disponible', panas = 0, gramos_enviados = 0 where id = $1`, [d.id]);
      await auditar(q, req.ctx, 'despacho.no_disponible', 'despacho', d.id, { sucursal: d.sucursal_nombre, sabor: d.sabor_nombre, fecha: d.fecha }, { sucursalId: d.sucursal_id });
    });
    res.json({ ok: true });
  });

  // Deshace un envío por error: restaura estado, panas y gramos (y el reparto de tandas).
  r.patch('/:id/restaurar', requierePermiso('rep:despachar'), async (req, res) => {
    const b = validar(z.object({ estado: z.enum(['pendiente', 'preparado', 'enviado'], { errorMap: () => ({ message: 'Estado inválido' }) }), panas: z.coerce.number().finite().min(0), gramos_enviados: z.coerce.number().finite().min(0) }), req.body);
    await db.tx(async (q) => {
      const d = await cargar(q, req, req.params.id);
      await reasignarTandas(q, { empresaId: emp(req), despachoId: d.id, saborId: d.sabor_id, gramos: b.estado === 'enviado' ? b.gramos_enviados : 0, fecha: d.fecha });
      // Si vuelve a pendiente/preparado deja de estar enviado: el día de salida se borra.
      await q.query(`update rep.despachos set estado = $2, panas = $3, gramos_enviados = $4, enviado_en = $5,
                       panas_recibidas = null, gramos_confirmados_recibidos = null, discrepancia = false where id = $1`,
        [d.id, b.estado, b.panas, b.gramos_enviados, b.estado === 'enviado' ? fechaHN() : null]);
      await auditar(q, req.ctx, 'despacho.restaurar', 'despacho', d.id, { sucursal: d.sucursal_nombre, sabor: d.sabor_nombre, estado_anterior: d.estado, estado: b.estado }, { sucursalId: d.sucursal_id });
    });
    res.json({ ok: true });
  });
  return r;
}
