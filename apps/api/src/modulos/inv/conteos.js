// Conteos cíclicos del inventario unificado.
// Flujo: programar → iniciar (se congela lo que dice el sistema) → capturar (celular/tablet) → enviar a aprobación
// → el gerente aprueba (qué diferencias se ajustan) → el ajuste queda en el kardex de cada fuente y en la bitácora.
// El ajuste se aplica como DIFERENCIA (contado − esperado al iniciar), no como valor absoluto: si mientras se contaba
// hubo ventas o compras, esos movimientos no se pierden.
import { z } from 'zod';
import { fechaHN } from '@grupo/shared';
import { requierePermiso, sucursalesPermitidas } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { conflicto, fechaISO, malaPeticion, noEncontrado, prohibido, uuid, validar } from '../../lib/http.js';
import { fuentesDe, listarItems, moverItem } from './adaptadores.js';

const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const SIN_SUC = '00000000-0000-0000-0000-000000000000';

export function montarConteos(r, { db, ctxInv }) {
  const ver = requierePermiso('inv:ver');
  const operar = requierePermiso('inv:mover');
  const aprobar = requierePermiso('inv:aprobar');

  async function cargar(q, req, id, { bloquear = false } = {}) {
    const { rows } = await q.query(`select * from invu.conteos where id = $1 and empresa_id = $2 ${bloquear ? 'for update' : ''}`, [validar(uuid, id), req.ctx.empresa.id]);
    if (!rows[0]) throw noEncontrado('Conteo no encontrado');
    return rows[0];
  }
  const ocultaSistema = (req, c) => c.ciego && c.estado === 'en_conteo' && !req.ctx.permisos.has('inv:aprobar');
  const lineaSalida = (req, c, l) => {
    const dif = l.contado == null ? null : r3(l.contado - l.esperado);
    const costos = ctxInv(req).costos;
    return {
      id: l.id, fuente: l.fuente, ref_id: l.ref_id, sucursal_id: l.sucursal_id, nombre: l.nombre, categoria: l.categoria, unidad: l.unidad,
      esperado: ocultaSistema(req, c) ? null : l.esperado, contado: l.contado, diferencia: ocultaSistema(req, c) ? null : dif,
      valor_diferencia: costos && dif != null && l.costo_unitario != null && !ocultaSistema(req, c) ? r2(dif * l.costo_unitario) : null,
      decision: l.decision, ajuste_aplicado: l.ajuste_aplicado, nota: l.nota, contado_at: l.contado_at,
    };
  };

  r.get('/conteos', ver, async (req, res) => {
    const f = validar(z.object({ estado: z.enum(['programado', 'en_conteo', 'por_aprobar', 'aplicado', 'cancelado', 'abiertos']).optional() }), req.query);
    const { rows } = await db.query(
      `select c.*, s.nombre as sucursal, u.nombre as creado_por_nombre,
              (select count(*)::int from invu.conteo_lineas l where l.conteo_id = c.id) as lineas,
              (select count(*)::int from invu.conteo_lineas l where l.conteo_id = c.id and l.contado is not null) as contadas,
              (select count(*)::int from invu.conteo_lineas l where l.conteo_id = c.id and l.contado is not null and l.contado <> l.esperado) as con_diferencia
         from invu.conteos c left join core.sucursales s on s.id = c.sucursal_id left join core.usuarios u on u.id = c.creado_por
        where c.empresa_id = $1 and ($2::text is null or ($2 = 'abiertos' and c.estado in ('programado','en_conteo','por_aprobar')) or c.estado = $2)
        order by (c.estado in ('programado','en_conteo','por_aprobar')) desc, c.fecha_programada desc, c.numero desc limit 100`,
      [req.ctx.empresa.id, f.estado ?? null]);
    const hoy = fechaHN();
    res.json(rows.map((c) => ({ ...c, vencido: ['programado', 'en_conteo'].includes(c.estado) && c.fecha_programada < hoy })));
  });

  r.post('/conteos', operar, async (req, res) => {
    const b = validar(z.object({
      nombre: z.string().trim().min(2, 'Ponle un nombre al conteo').max(120), fecha_programada: fechaISO.optional(),
      sucursal_id: uuid.optional().nullable(), fuente: z.string().max(20).optional().nullable(), categoria: z.string().trim().max(80).optional().nullable(),
      ciego: z.boolean().default(true), notas: z.string().trim().max(500).optional().nullable(),
    }), req.body);
    const fuentes = fuentesDe(req.ctx.empresa);
    if (b.fuente && !fuentes.includes(b.fuente)) throw malaPeticion('Esa fuente de inventario no existe en esta empresa');
    if (b.sucursal_id && !(await sucursalesPermitidas(db, req.ctx)).some((s) => s.id === b.sucursal_id)) throw prohibido('Esa sucursal no existe o no tienes acceso a ella');
    const c = await db.tx(async (q) => {
      const numero = (await q.query('select invu.siguiente($1, $2) as n', [req.ctx.empresa.id, 'conteo'])).rows[0].n;
      const c = (await q.query(
        `insert into invu.conteos (empresa_id, numero, nombre, fecha_programada, sucursal_id, fuente, categoria, ciego, notas, creado_por)
         values ($1,$2,$3,coalesce($4::date, $5::date),$6,$7,$8,$9,$10,$11) returning *`,
        [req.ctx.empresa.id, numero, b.nombre, b.fecha_programada ?? null, fechaHN(), b.sucursal_id ?? null, b.fuente ?? null, b.categoria || null, b.ciego, b.notas || null, req.ctx.usuario.id])).rows[0];
      await auditar(q, req.ctx, 'inv.conteo_programado', 'conteo', c.id, { numero, nombre: b.nombre, sucursal_id: b.sucursal_id ?? null, fuente: b.fuente ?? null, categoria: b.categoria ?? null });
      return c;
    });
    res.status(201).json(c);
  });

  r.get('/conteos/:id', ver, async (req, res) => {
    const c = await cargar(db, req, req.params.id);
    const { rows } = await db.query(
      `select l.*, s.nombre as sucursal from invu.conteo_lineas l left join core.sucursales s on s.id = l.sucursal_id where l.conteo_id = $1 order by l.categoria nulls last, l.nombre, s.nombre`, [c.id]);
    const lineas = rows.map((l) => ({ ...lineaSalida(req, c, l), sucursal: l.sucursal }));
    const sucursal = c.sucursal_id ? (await db.query('select nombre from core.sucursales where id = $1', [c.sucursal_id])).rows[0]?.nombre : null;
    const dif = lineas.filter((l) => l.diferencia != null && l.diferencia !== 0);
    res.json({
      ...c, sucursal, lineas, oculto: ocultaSistema(req, c),
      resumen: {
        total: lineas.length, contadas: lineas.filter((l) => l.contado != null).length, con_diferencia: dif.length,
        valor_faltante: ctxInv(req).costos ? r2(dif.reduce((s, l) => s + Math.min(0, l.valor_diferencia ?? 0), 0)) : null,
        valor_sobrante: ctxInv(req).costos ? r2(dif.reduce((s, l) => s + Math.max(0, l.valor_diferencia ?? 0), 0)) : null,
      },
    });
  });

  r.post('/conteos/:id/iniciar', operar, async (req, res) => {
    const out = await db.tx(async (q) => {
      const c = await cargar(q, req, req.params.id, { bloquear: true });
      if (c.estado !== 'programado') throw conflicto('Este conteo ya se inició');
      const ctx = { ...ctxInv(req), costos: true };
      const items = await listarItems(q, ctx, { fuente: c.fuente ?? undefined, sucursal_id: c.sucursal_id ?? undefined, categoria: c.categoria ?? undefined });
      if (!items.length) throw malaPeticion('No hay ítems de inventario con esos filtros: revisa la sucursal y la categoría');
      for (const i of items) {
        await q.query(
          `insert into invu.conteo_lineas (conteo_id, fuente, ref_id, sucursal_id, nombre, categoria, unidad, esperado, costo_unitario) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [c.id, i.fuente, i.ref_id, i.sucursal_id, i.nombre, i.categoria, i.unidad, i.existencia, i.costo]);
      }
      await q.query(`update invu.conteos set estado = 'en_conteo', iniciado_at = now() where id = $1`, [c.id]);
      await auditar(q, req.ctx, 'inv.conteo_iniciado', 'conteo', c.id, { numero: c.numero, lineas: items.length });
      return { ok: true, lineas: items.length };
    });
    res.json(out);
  });

  // Captura por lotes (la pantalla táctil manda lo que lleva contado cada tanto; sirve para reintentar sin duplicar)
  r.post('/conteos/:id/captura', operar, async (req, res) => {
    const b = validar(z.object({
      lineas: z.array(z.object({ id: uuid, contado: z.coerce.number().finite().min(0).max(10_000_000).nullable(), nota: z.string().trim().max(200).optional().nullable() })).min(1).max(1000),
    }), req.body);
    const out = await db.tx(async (q) => {
      const c = await cargar(q, req, req.params.id, { bloquear: true });
      if (c.estado !== 'en_conteo') throw conflicto('Este conteo no está abierto para capturar');
      let n = 0;
      for (const l of b.lineas) {
        const fila = (await q.query('select fuente from invu.conteo_lineas where id = $1 and conteo_id = $2', [l.id, c.id])).rows[0];
        if (!fila) throw noEncontrado('Una línea no pertenece a este conteo');
        if (l.contado != null && fila.fuente === 'fab_piedra' && !Number.isInteger(l.contado)) throw malaPeticion('La piedra se cuenta en cajas completas de 1 m²: usa un número entero');
        await q.query(
          `update invu.conteo_lineas set contado = $2, nota = coalesce($3, nota), contado_por = case when $2::numeric is null then null else $4::uuid end,
                  contado_at = case when $2::numeric is null then null else now() end where id = $1`,
          [l.id, l.contado == null ? null : r3(l.contado), l.nota || null, req.ctx.usuario.id]);
        n++;
      }
      return { ok: true, guardadas: n };
    });
    res.json(out);
  });

  r.post('/conteos/:id/enviar', operar, async (req, res) => {
    const out = await db.tx(async (q) => {
      const c = await cargar(q, req, req.params.id, { bloquear: true });
      if (c.estado !== 'en_conteo') throw conflicto('Este conteo no está abierto');
      const n = (await q.query('select count(*)::int as n from invu.conteo_lineas where conteo_id = $1 and contado is not null', [c.id])).rows[0].n;
      if (!n) throw malaPeticion('Todavía no has contado nada');
      await q.query(`update invu.conteos set estado = 'por_aprobar', enviado_por = $2, enviado_at = now() where id = $1`, [c.id, req.ctx.usuario.id]);
      await auditar(q, req.ctx, 'inv.conteo_enviado', 'conteo', c.id, { numero: c.numero, contadas: n });
      return { ok: true, contadas: n };
    });
    res.json(out);
  });

  r.post('/conteos/:id/aprobar', aprobar, async (req, res) => {
    const b = validar(z.object({
      decisiones: z.array(z.object({ id: uuid, decision: z.enum(['ajustar', 'ignorar']) })).max(1000).default([]),
      nota: z.string().trim().max(300).optional().nullable(),
    }), req.body);
    const out = await db.tx(async (q) => {
      const c = await cargar(q, req, req.params.id, { bloquear: true });
      if (c.estado !== 'por_aprobar') throw conflicto('Este conteo no está esperando aprobación');
      const { rows } = await q.query('select * from invu.conteo_lineas where conteo_id = $1 and contado is not null order by nombre for update', [c.id]);
      const dec = new Map(b.decisiones.map((d) => [d.id, d.decision]));
      const conDif = rows.filter((l) => r3(l.contado - l.esperado) !== 0);
      const aAjustar = conDif.filter((l) => (dec.get(l.id) ?? 'ajustar') === 'ajustar');
      if (aAjustar.length && (b.nota ?? '').length < 3) throw malaPeticion('Escribe el motivo de la aprobación (mínimo 3 letras): queda en la bitácora');
      let valor = 0; let ajustadas = 0;
      const ctx = { empresa: req.ctx.empresa, usuario: req.ctx.usuario, rol: req.ctx.rol };
      for (const l of conDif) {
        const d = dec.get(l.id) ?? 'ajustar';
        if (d === 'ignorar') { await q.query(`update invu.conteo_lineas set decision = 'ignorar' where id = $1`, [l.id]); continue; }
        const delta = r3(l.contado - l.esperado);
        const motivo = `Conteo #${c.numero}: sistema ${l.esperado}, contado ${l.contado}${b.nota ? ` · ${b.nota}` : ''}`;
        const m = await moverItem(q, ctx, { fuente: l.fuente, ref: l.ref_id, sucursalId: l.sucursal_id, delta, tipo: 'ajuste', motivo });
        await q.query(`update invu.conteo_lineas set decision = 'ajustar', ajuste_aplicado = $2 where id = $1`, [l.id, m.delta]);
        await auditar(q, req.ctx, 'inv.conteo_ajuste', 'conteo', c.id, { numero: c.numero, item: l.nombre, fuente: l.fuente, sucursal_id: l.sucursal_id, esperado: l.esperado, contado: l.contado, ajuste: m.delta, valor: l.costo_unitario != null ? r2(m.delta * l.costo_unitario) : null }, { sucursalId: l.sucursal_id });
        valor += l.costo_unitario != null ? m.delta * l.costo_unitario : 0; ajustadas++;
      }
      await q.query(`update invu.conteo_lineas set decision = 'ignorar' where conteo_id = $1 and (contado is null or contado = esperado) and decision is null`, [c.id]);
      await q.query(`update invu.conteos set estado = 'aplicado', aprobado_por = $2, aprobado_at = now(), nota_aprobacion = $3 where id = $1`, [c.id, req.ctx.usuario.id, b.nota || null]);
      await auditar(q, req.ctx, 'inv.conteo_aprobado', 'conteo', c.id, { numero: c.numero, ajustadas, ignoradas: conDif.length - ajustadas, valor: r2(valor), nota: b.nota ?? null });
      return { ok: true, ajustadas, ignoradas: conDif.length - ajustadas, valor: r2(valor) };
    });
    res.json(out);
  });

  r.post('/conteos/:id/cancelar', operar, async (req, res) => {
    const b = validar(z.object({ motivo: z.string().trim().max(200).optional().nullable() }), req.body);
    await db.tx(async (q) => {
      const c = await cargar(q, req, req.params.id, { bloquear: true });
      if (['aplicado', 'cancelado'].includes(c.estado)) throw conflicto('Este conteo ya está cerrado');
      await q.query(`update invu.conteos set estado = 'cancelado', nota_aprobacion = $2 where id = $1`, [c.id, b.motivo || null]);
      await auditar(q, req.ctx, 'inv.conteo_cancelado', 'conteo', c.id, { numero: c.numero, motivo: b.motivo ?? null });
    });
    res.json({ ok: true });
  });
}

export { SIN_SUC };
