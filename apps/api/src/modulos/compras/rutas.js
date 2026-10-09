import { Router } from 'express';
import { z } from 'zod';
import { fechaHN, sumarDias } from '@grupo/shared';
import { requierePermiso, resolverSucursal } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { conflicto, malaPeticion, noEncontrado, uuid, validar, fechaISO } from '../../lib/http.js';
import { libroExcel, enviarLibro } from '../../lib/excel.js';
import { aLempiras, estadoTrasRecepcion, r2, saldosPorRecepcion, totalesOrden, variacionDolarizada, variacionPct } from './calculo.js';
import { leerCatalogo, sugerenciasReorden } from './catalogo.js';
import { ORIGENES, ORIGEN_NOMBRE, ingresarAInventario, necesitaSucursal, resolverItem } from './recepcion.js';

const cant = z.coerce.number().positive('La cantidad debe ser mayor a cero').max(10_000_000);
const precioEsq = z.coerce.number().min(0, 'El precio no puede ser negativo').max(999_999_999);
const tcEsq = z.coerce.number().positive('El tipo de cambio debe ser mayor a cero').max(1000);
const txt = (n = 300) => z.string().trim().max(n).optional().nullable().transform((v) => v || null);

const lineaEsq = z.object({ origen: z.enum(ORIGENES), item_id: uuid, cantidad: cant, precio_unitario: precioEsq });
const ordenEsq = z.object({
  proveedor_id: uuid, sucursal_id: uuid.optional().nullable(),
  moneda: z.enum(['HNL', 'USD']).default('HNL'), tipo_cambio: tcEsq.optional().nullable(),
  fecha: fechaISO.optional(), fecha_esperada: fechaISO.optional().nullable(),
  condicion: z.enum(['contado', 'credito']).default('contado'), dias_credito: z.coerce.number().int().min(0).max(365).default(0),
  isv_pct: z.coerce.number().refine((v) => [0, 15, 18].includes(v), 'El ISV es 0, 15 o 18 %').default(0),
  notas: txt(500), lineas: z.array(lineaEsq).min(1, 'La orden no tiene líneas').max(200),
});

export function rutasCompras({ db }) {
  const r = Router();
  const ver = requierePermiso('compras:ver');
  const editar = requierePermiso('compras:editar');
  const recibir = requierePermiso('compras:recibir');
  const emp = (req) => req.ctx.empresa.id;

  // ── Utilidades ─────────────────────────────────────────────────────────────
  async function tipoCambioSugerido(empresaId) {
    const u = (await db.query(`select tipo_cambio::float8 as tc from cmp.recepciones where moneda = 'USD' order by fecha desc, created_at desc limit 1`)).rows[0]
      ?? (await db.query(`select tipo_cambio::float8 as tc from cmp.ordenes where moneda = 'USD' order by created_at desc limit 1`)).rows[0];
    if (u) return { valor: u.tc, fuente: 'la última compra en dólares del grupo' };
    const fab = (await db.query(`select (valor->>'tipo_cambio_usd')::float8 as tc from core.config where empresa_id = $1 and clave = 'fab'`, [empresaId])).rows[0];
    if (fab?.tc) return { valor: fab.tc, fuente: 'la configuración de la fábrica' };
    return { valor: null, fuente: null };
  }

  async function cargarOrden(q, req, id, { bloquear = false } = {}) {
    const o = (await q.query(
      `select o.*, t.nombre as proveedor, t.rtn as proveedor_rtn, t.telefono as proveedor_telefono, t.correo as proveedor_correo, t.direccion as proveedor_direccion, s.nombre as sucursal
         from cmp.ordenes o join core.terceros t on t.id = o.proveedor_id left join core.sucursales s on s.id = o.sucursal_id
        where o.id = $1 and o.empresa_id = $2 ${bloquear ? 'for update of o' : ''}`, [id, emp(req)])).rows[0];
    if (!o) throw noEncontrado('Orden de compra no encontrada');
    return o;
  }
  const lineasDe = async (q, ordenId) => (await q.query(
    `select id, orden, origen, item_id, descripcion, unidad, cantidad::float8 as cantidad, cantidad_recibida::float8 as cantidad_recibida, precio_unitario::float8 as precio_unitario
       from cmp.orden_lineas where orden_id = $1 order by orden`, [ordenId])).rows;

  async function detalleOrden(q, req, id) {
    const o = await cargarOrden(q, req, id);
    const [lineas, recs, pagos] = await Promise.all([
      lineasDe(q, id),
      q.query(
        `select r.*, u.nombre as usuario,
                coalesce((select json_agg(json_build_object('linea_id', rl.linea_id, 'cantidad', rl.cantidad::float8, 'precio_unitario', rl.precio_unitario::float8, 'costo_lps', rl.costo_lps::float8, 'vence_at', rl.vence_at) order by rl.id)
                            from cmp.recepcion_lineas rl where rl.recepcion_id = r.id), '[]') as lineas
           from cmp.recepciones r left join core.usuarios u on u.id = r.usuario_id where r.orden_id = $1 order by r.fecha, r.created_at`, [id]),
      q.query(`select p.*, u.nombre as usuario from cmp.pagos p left join core.usuarios u on u.id = p.usuario_id where p.orden_id = $1 order by p.fecha, p.created_at`, [id]),
    ]);
    const pagado = r2(pagos.rows.reduce((s, p) => s + Number(p.monto_lps), 0));
    const aCredito = recs.rows.filter((x) => x.vence_pago);
    const saldo = r2(aCredito.reduce((s, x) => s + Number(x.total_lps), 0) - pagado);
    return {
      ...o, subtotal: Number(o.subtotal), isv: Number(o.isv), total: Number(o.total), tipo_cambio: Number(o.tipo_cambio), isv_pct: Number(o.isv_pct),
      fecha: String(o.fecha).slice(0, 10), fecha_esperada: o.fecha_esperada ? String(o.fecha_esperada).slice(0, 10) : null,
      lineas, recepciones: recs.rows.map((x) => ({ ...x, fecha: String(x.fecha).slice(0, 10), vence_pago: x.vence_pago ? String(x.vence_pago).slice(0, 10) : null,
        subtotal: Number(x.subtotal), isv: Number(x.isv), total: Number(x.total), total_lps: Number(x.total_lps), tipo_cambio: Number(x.tipo_cambio) })),
      pagos: pagos.rows.map((p) => ({ ...p, fecha: String(p.fecha).slice(0, 10), monto_lps: Number(p.monto_lps) })),
      pagado_lps: pagado, saldo_lps: Math.max(0, saldo),
    };
  }

  /** Valida y arma las líneas de una orden (snapshot de nombre y unidad) más el destino. */
  async function prepararLineas(q, req, b) {
    const vistos = new Set();
    const lineas = [];
    for (const [i, l] of b.lineas.entries()) {
      const k = `${l.origen}:${l.item_id}`;
      if (vistos.has(k)) throw malaPeticion('Un mismo ítem aparece dos veces; suma las cantidades en una sola línea');
      vistos.add(k);
      const it = await resolverItem(q, emp(req), l.origen, l.item_id);
      lineas.push({ ...l, orden: i, descripcion: it.nombre, unidad: it.unidad });
    }
    let sucursalId = null;
    if (lineas.some((l) => necesitaSucursal(l.origen)) || b.sucursal_id) sucursalId = (await resolverSucursal(q, req.ctx, b.sucursal_id ?? undefined)).id;
    return { lineas, sucursalId };
  }

  async function guardarLineas(q, ordenId, lineas) {
    await q.query('delete from cmp.orden_lineas where orden_id = $1', [ordenId]);
    for (const l of lineas) {
      await q.query(`insert into cmp.orden_lineas (orden_id, orden, origen, item_id, descripcion, unidad, cantidad, precio_unitario) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [ordenId, l.orden, l.origen, l.item_id, l.descripcion, l.unidad, l.cantidad, l.precio_unitario]);
    }
  }

  function datosOrden(b) {
    if (b.moneda === 'USD' && !b.tipo_cambio) throw malaPeticion('Escribe el tipo de cambio de la orden en dólares');
    return { tc: b.moneda === 'USD' ? b.tipo_cambio : 1, ...totalesOrden(b.lineas, b.isv_pct) };
  }

  // ── Datos de apoyo ─────────────────────────────────────────────────────────
  r.get('/config', ver, async (req, res) => {
    res.json({ tipo_cambio_sugerido: await tipoCambioSugerido(emp(req)), origenes: ORIGEN_NOMBRE });
  });

  r.get('/catalogo', ver, async (req, res) => res.json(await leerCatalogo(db, emp(req))));

  // ── Proveedores (fichas comunes del grupo: core.terceros) ──────────────────
  r.get('/proveedores', ver, async (req, res) => {
    const { rows } = await db.query(
      `select t.id, t.nombre, t.nombre_comercial, t.rtn, t.telefono, t.correo, t.direccion, t.notas,
              (select count(*)::int from cmp.ordenes o where o.proveedor_id = t.id and o.empresa_id = $1 and o.estado <> 'anulada') as ordenes,
              coalesce((select sum(rc.total_lps) from cmp.recepciones rc join cmp.ordenes o on o.id = rc.orden_id where o.proveedor_id = t.id and rc.empresa_id = $1), 0)::float8 as comprado_lps,
              (select max(rc.fecha)::text from cmp.recepciones rc join cmp.ordenes o on o.id = rc.orden_id where o.proveedor_id = t.id and rc.empresa_id = $1) as ultima_compra,
              (coalesce((select sum(rc.total_lps) from cmp.recepciones rc join cmp.ordenes o on o.id = rc.orden_id where o.proveedor_id = t.id and rc.empresa_id = $1 and rc.vence_pago is not null), 0)
               - coalesce((select sum(p.monto_lps) from cmp.pagos p join cmp.ordenes o on o.id = p.orden_id where o.proveedor_id = t.id and p.empresa_id = $1), 0))::float8 as por_pagar_lps
         from core.terceros t where t.es_proveedor and t.activo order by t.nombre`, [emp(req)]);
    res.json(rows.map((p) => ({ ...p, por_pagar_lps: Math.max(0, r2(p.por_pagar_lps)) })));
  });

  r.post('/proveedores', editar, async (req, res) => {
    const rtn = z.string().trim().transform((v) => v.replace(/[\s-]/g, '')).refine((v) => v === '' || /^\d{14}$/.test(v), 'El RTN lleva 14 dígitos').optional().nullable().transform((v) => v || null);
    const b = validar(z.object({
      nombre: z.string().trim().min(2).max(160), rtn, telefono: txt(40), correo: z.string().trim().toLowerCase().email().optional().nullable().or(z.literal('').transform(() => null)),
      direccion: txt(250), notas: txt(500),
    }), req.body);
    const out = await db.tx(async (q) => {
      // Si el RTN ya está en el directorio común, esa ficha se vuelve también proveedora (no se duplica).
      const ya = b.rtn ? (await q.query('select id from core.terceros where rtn = $1', [b.rtn])).rows[0] : null;
      if (ya) {
        const t = (await q.query('update core.terceros set es_proveedor = true, activo = true where id = $1 returning *', [ya.id])).rows[0];
        await auditar(q, req.ctx, 'proveedor_marcado', 'tercero', t.id, { nombre: t.nombre });
        return t;
      }
      const t = (await q.query(
        `insert into core.terceros (nombre, rtn, telefono, correo, direccion, notas, es_cliente, es_proveedor, created_by) values ($1,$2,$3,$4,$5,$6,false,true,$7) returning *`,
        [b.nombre, b.rtn, b.telefono, b.correo ?? null, b.direccion, b.notas, req.ctx.usuario.id])).rows[0];
      await auditar(q, req.ctx, 'proveedor_creado', 'tercero', t.id, { nombre: t.nombre });
      return t;
    });
    res.status(201).json(out);
  });

  // ── Órdenes de compra ──────────────────────────────────────────────────────
  r.get('/ordenes', ver, async (req, res) => {
    const f = validar(z.object({ estado: z.string().max(120).optional(), proveedor_id: uuid.optional(), q: z.string().trim().max(60).optional() }), req.query);
    const estados = f.estado ? f.estado.split(',') : null;
    const { rows } = await db.query(
      `select o.id, o.numero, o.estado, o.moneda, o.tipo_cambio::float8 as tipo_cambio, o.fecha::text as fecha, o.fecha_esperada::text as fecha_esperada, o.condicion, o.total::float8 as total,
              t.nombre as proveedor, s.nombre as sucursal,
              (select count(*)::int from cmp.orden_lineas l where l.orden_id = o.id) as lineas,
              coalesce((select sum(l.cantidad_recibida * l.precio_unitario) / nullif(sum(l.cantidad * l.precio_unitario), 0) from cmp.orden_lineas l where l.orden_id = o.id), 0)::float8 as avance,
              (coalesce((select sum(rc.total_lps) from cmp.recepciones rc where rc.orden_id = o.id and rc.vence_pago is not null), 0)
               - coalesce((select sum(p.monto_lps) from cmp.pagos p where p.orden_id = o.id), 0))::float8 as saldo_lps
         from cmp.ordenes o join core.terceros t on t.id = o.proveedor_id left join core.sucursales s on s.id = o.sucursal_id
        where o.empresa_id = $1 and ($2::text[] is null or o.estado = any($2::text[])) and ($3::uuid is null or o.proveedor_id = $3)
          and ($4::text is null or t.nombre ilike '%'||$4||'%' or o.numero::text = $4)
        order by o.numero desc limit 300`, [emp(req), estados, f.proveedor_id ?? null, f.q || null]);
    const hoy = fechaHN();
    res.json(rows.map((o) => ({ ...o, saldo_lps: Math.max(0, r2(o.saldo_lps)), atrasada: o.estado === 'enviada' && !!o.fecha_esperada && o.fecha_esperada < hoy })));
  });

  r.get('/ordenes/:id', ver, async (req, res) => res.json(await detalleOrden(db, req, validar(uuid, req.params.id))));

  r.post('/ordenes', editar, async (req, res) => {
    const b = validar(ordenEsq, req.body);
    const out = await db.tx(async (q) => {
      const prov = (await q.query('select id from core.terceros where id = $1 and es_proveedor and activo', [b.proveedor_id])).rows[0];
      if (!prov) throw noEncontrado('Proveedor no encontrado');
      const { lineas, sucursalId } = await prepararLineas(q, req, b);
      const d = datosOrden({ ...b, lineas });
      const numero = (await q.query('select cmp.siguiente_numero($1) as n', [emp(req)])).rows[0].n;
      const o = (await q.query(
        `insert into cmp.ordenes (empresa_id, numero, proveedor_id, sucursal_id, moneda, tipo_cambio, fecha, fecha_esperada, condicion, dias_credito, isv_pct, subtotal, isv, total, notas, creado_por)
         values ($1,$2,$3,$4,$5,$6,coalesce($7::date,$8::date),$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id, numero`,
        [emp(req), numero, b.proveedor_id, sucursalId, b.moneda, d.tc, b.fecha ?? null, fechaHN(), b.fecha_esperada ?? null, b.condicion, b.condicion === 'credito' ? b.dias_credito : 0, b.isv_pct, d.subtotal, d.isv, d.total, b.notas, req.ctx.usuario.id])).rows[0];
      await guardarLineas(q, o.id, lineas);
      await auditar(q, req.ctx, 'oc_creada', 'orden_compra', o.id, { numero: Number(o.numero), total: d.total, moneda: b.moneda, lineas: lineas.length }, { sucursalId });
      return o;
    });
    res.status(201).json(await detalleOrden(db, req, out.id));
  });

  r.put('/ordenes/:id', editar, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(ordenEsq, req.body);
    await db.tx(async (q) => {
      const o = await cargarOrden(q, req, id, { bloquear: true });
      if (o.estado !== 'borrador') throw conflicto('Solo se edita una orden en borrador');
      const prov = (await q.query('select id from core.terceros where id = $1 and es_proveedor and activo', [b.proveedor_id])).rows[0];
      if (!prov) throw noEncontrado('Proveedor no encontrado');
      const { lineas, sucursalId } = await prepararLineas(q, req, b);
      const d = datosOrden({ ...b, lineas });
      await q.query(
        `update cmp.ordenes set proveedor_id=$2, sucursal_id=$3, moneda=$4, tipo_cambio=$5, fecha=coalesce($6::date, fecha), fecha_esperada=$7, condicion=$8, dias_credito=$9, isv_pct=$10,
                subtotal=$11, isv=$12, total=$13, notas=$14, updated_at=now() where id=$1`,
        [id, b.proveedor_id, sucursalId, b.moneda, d.tc, b.fecha ?? null, b.fecha_esperada ?? null, b.condicion, b.condicion === 'credito' ? b.dias_credito : 0, b.isv_pct, d.subtotal, d.isv, d.total, b.notas]);
      await guardarLineas(q, id, lineas);
      await auditar(q, req.ctx, 'oc_editada', 'orden_compra', id, { numero: Number(o.numero), total: d.total }, { sucursalId });
    });
    res.json(await detalleOrden(db, req, id));
  });

  /** Correo de la orden al proveedor (usa el servicio de correo; si Gmail no está configurado queda pendiente). */
  async function enviarPorCorreo(req, o, para) {
    const { enviarCorreo, escaparHtml: e } = await import('../../lib/correo.js');
    const moneda = (v) => `${o.moneda === 'USD' ? 'US$' : 'L'} ${Number(v).toLocaleString('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const filas = o.lineas.map((l) => `<tr><td style="padding:6px 8px;border-bottom:1px solid #e5e0d8">${e(l.descripcion)}</td><td style="padding:6px 8px;border-bottom:1px solid #e5e0d8;text-align:right">${l.cantidad} ${e(l.unidad)}</td><td style="padding:6px 8px;border-bottom:1px solid #e5e0d8;text-align:right">${moneda(l.precio_unitario)}</td><td style="padding:6px 8px;border-bottom:1px solid #e5e0d8;text-align:right">${moneda(r2(l.cantidad * l.precio_unitario))}</td></tr>`).join('');
    const html = `<p>Buen día, ${e(o.proveedor)}.</p><p>Le enviamos la <b>orden de compra N.° ${o.numero}</b> de ${e(req.ctx.empresa.nombre)}${o.fecha_esperada ? `, con entrega esperada el ${e(o.fecha_esperada)}` : ''}.</p>
      <table style="border-collapse:collapse;width:100%;font-size:14px"><thead><tr style="background:#f4f1ec"><th style="padding:6px 8px;text-align:left">Producto</th><th style="padding:6px 8px;text-align:right">Cantidad</th><th style="padding:6px 8px;text-align:right">Precio</th><th style="padding:6px 8px;text-align:right">Importe</th></tr></thead><tbody>${filas}</tbody></table>
      <p style="text-align:right">Subtotal ${moneda(o.subtotal)}${o.isv_pct ? ` · ISV ${o.isv_pct}% ${moneda(o.isv)}` : ''} · <b>Total ${moneda(o.total)}</b></p>
      <p>Condición: ${o.condicion === 'credito' ? `crédito a ${o.dias_credito} días` : 'contado'}.${o.notas ? ` Notas: ${e(o.notas)}` : ''}</p><p>Gracias.</p>`;
    return enviarCorreo({ empresaId: emp(req), para, asunto: `Orden de compra N.° ${o.numero} · ${req.ctx.empresa.nombre}`, html, titulo: `Orden de compra N.° ${o.numero}`,
      tipo: 'orden_compra', referencia: String(o.id), usuario: req.ctx.usuario });
  }

  r.post('/ordenes/:id/enviar', editar, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(z.object({ correo: z.boolean().default(false), para: txt(160) }), req.body ?? {});
    await db.tx(async (q) => {
      const o = await cargarOrden(q, req, id, { bloquear: true });
      if (o.estado !== 'borrador') throw conflicto('La orden ya fue enviada');
      const n = (await q.query('select count(*)::int as n from cmp.orden_lineas where orden_id = $1', [id])).rows[0].n;
      if (!n) throw malaPeticion('La orden no tiene líneas');
      await q.query(`update cmp.ordenes set estado = 'enviada', enviada_at = now(), updated_at = now() where id = $1`, [id]);
      await auditar(q, req.ctx, 'oc_enviada', 'orden_compra', id, { numero: Number(o.numero), proveedor: o.proveedor });
    });
    const out = { orden: await detalleOrden(db, req, id) };
    if (b.correo) {
      const para = b.para || out.orden.proveedor_correo;
      out.correo = para ? await enviarPorCorreo(req, out.orden, para) : { ok: false, pendiente: false, error: 'El proveedor no tiene correo registrado' };
    }
    res.json(out);
  });

  r.post('/ordenes/:id/correo', editar, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(z.object({ para: txt(160) }), req.body ?? {});
    const o = await detalleOrden(db, req, id);
    if (o.estado === 'anulada') throw conflicto('La orden está anulada');
    const para = b.para || o.proveedor_correo;
    if (!para) throw malaPeticion('El proveedor no tiene correo registrado; escribe uno');
    res.json(await enviarPorCorreo(req, o, para));
  });

  r.post('/ordenes/:id/anular', editar, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const { motivo } = validar(z.object({ motivo: z.string().trim().min(3, 'Escribe el motivo').max(200) }), req.body);
    await db.tx(async (q) => {
      const o = await cargarOrden(q, req, id, { bloquear: true });
      if (!['borrador', 'enviada'].includes(o.estado)) throw conflicto('Solo se anula una orden sin mercadería recibida; si ya llegó algo, ciérrala');
      if ((await q.query('select 1 from cmp.recepciones where orden_id = $1', [id])).rowCount) throw conflicto('La orden ya tiene recepciones; ciérrala en lugar de anularla');
      await q.query(`update cmp.ordenes set estado = 'anulada', motivo_cierre = $2, cerrada_at = now(), updated_at = now() where id = $1`, [id, motivo]);
      await auditar(q, req.ctx, 'oc_anulada', 'orden_compra', id, { numero: Number(o.numero), motivo });
    });
    res.json(await detalleOrden(db, req, id));
  });

  r.post('/ordenes/:id/cerrar', editar, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(z.object({ motivo: txt(200) }), req.body ?? {});
    await db.tx(async (q) => {
      const o = await cargarOrden(q, req, id, { bloquear: true });
      if (!['recibida', 'recibida_parcial'].includes(o.estado)) throw conflicto('Solo se cierra una orden con mercadería recibida');
      await q.query(`update cmp.ordenes set estado = 'cerrada', cerrada_at = now(), motivo_cierre = $2, updated_at = now() where id = $1`, [id, b.motivo]);
      await auditar(q, req.ctx, 'oc_cerrada', 'orden_compra', id, { numero: Number(o.numero), faltante: o.estado === 'recibida_parcial', motivo: b.motivo });
    });
    res.json(await detalleOrden(db, req, id));
  });

  // ── Recepción: la mercadería entra al inventario de la empresa ─────────────
  r.post('/ordenes/:id/recibir', recibir, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(z.object({
      fecha: fechaISO.optional(), documento: txt(60), tipo_cambio: tcEsq.optional().nullable(), notas: txt(300),
      lineas: z.array(z.object({ linea_id: uuid, cantidad: cant, precio_unitario: precioEsq.optional().nullable(), vence_at: fechaISO.optional().nullable() })).min(1, 'No indicaste qué llegó').max(200),
    }), req.body);
    const hoy = fechaHN();
    const fecha = b.fecha ?? hoy;
    if (fecha > hoy) throw malaPeticion('La fecha de recepción no puede ser futura');
    const salida = await db.tx(async (q) => {
      const o = await cargarOrden(q, req, id, { bloquear: true });
      if (!['enviada', 'recibida_parcial'].includes(o.estado)) throw conflicto(o.estado === 'borrador' ? 'Envía la orden antes de recibirla' : 'Esta orden ya no recibe mercadería');
      const lineasOrden = (await q.query('select * from cmp.orden_lineas where orden_id = $1 for update', [id])).rows;
      const tc = o.moneda === 'USD' ? (b.tipo_cambio ?? Number(o.tipo_cambio)) : 1;
      const vistos = new Set();
      const lineas = b.lineas.map((x) => {
        if (vistos.has(x.linea_id)) throw malaPeticion('Una línea aparece dos veces en la recepción');
        vistos.add(x.linea_id);
        const linea = lineasOrden.find((l) => l.id === x.linea_id);
        if (!linea) throw noEncontrado('Una de las líneas no es de esta orden');
        const pendiente = r2(Number(linea.cantidad) - Number(linea.cantidad_recibida));
        if (x.cantidad > pendiente + 1e-9) throw conflicto(`«${linea.descripcion}»: se pidieron ${linea.cantidad}, ya llegaron ${linea.cantidad_recibida}; solo faltan ${pendiente}`);
        const precio = x.precio_unitario ?? Number(linea.precio_unitario);
        return { linea, cantidad: x.cantidad, precio, costoLps: aLempiras(precio, o.moneda, tc), vence_at: x.vence_at ?? null };
      });
      const subtotal = r2(lineas.reduce((s, l) => s + r2(l.cantidad * l.precio), 0));
      const isv = r2((subtotal * Number(o.isv_pct)) / 100);
      const total = r2(subtotal + isv);
      const totalLps = r2(total * tc);
      const vence = o.condicion === 'credito' ? sumarDias(fecha, o.dias_credito) : null;
      const rec = (await q.query(
        `insert into cmp.recepciones (empresa_id, orden_id, fecha, documento, moneda, tipo_cambio, subtotal, isv, total, total_lps, vence_pago, notas, usuario_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
        [emp(req), id, fecha, b.documento, o.moneda, tc, subtotal, isv, total, totalLps, vence, b.notas, req.ctx.usuario.id])).rows[0];
      const previos = new Map();
      for (const l of lineas) {
        const prev = (await q.query(
          `select moneda, precio::float8 as precio, tipo_cambio::float8 as tipo_cambio, precio_lps::float8 as precio_lps from cmp.precios
            where empresa_id = $1 and origen = $2 and item_id = $3 order by (proveedor_id = $4) desc nulls last, fecha desc, id desc limit 1`,
          [emp(req), l.linea.origen, l.linea.item_id, o.proveedor_id])).rows[0] ?? null;
        previos.set(l.linea.id, prev);
        await q.query('insert into cmp.recepcion_lineas (recepcion_id, linea_id, cantidad, precio_unitario, costo_lps, vence_at) values ($1,$2,$3,$4,$5,$6)', [rec.id, l.linea.id, l.cantidad, l.precio, l.costoLps, l.vence_at]);
        await q.query('update cmp.orden_lineas set cantidad_recibida = cantidad_recibida + $2 where id = $1', [l.linea.id, l.cantidad]);
      }
      const resultados = await ingresarAInventario(q, req.ctx, { orden: o, recepcion: { ...rec, fecha }, proveedor: { nombre: o.proveedor }, lineas, documento: b.documento });
      for (const l of lineas) {
        await q.query(
          `insert into cmp.precios (empresa_id, proveedor_id, origen, item_id, descripcion, unidad, fecha, moneda, precio, tipo_cambio, precio_lps, fuente, orden_id, recepcion_id, documento, usuario_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'recepcion',$12,$13,$14,$15)`,
          [emp(req), o.proveedor_id, l.linea.origen, l.linea.item_id, l.linea.descripcion, l.linea.unidad, fecha, o.moneda, l.precio, tc, l.costoLps, id, rec.id, b.documento, req.ctx.usuario.id]);
      }
      const despues = await lineasDe(q, id);
      const estado = estadoTrasRecepcion(despues);
      await q.query('update cmp.ordenes set estado = $2, updated_at = now() where id = $1', [id, estado]);
      await auditar(q, req.ctx, 'oc_recibida', 'orden_compra', id, { numero: Number(o.numero), estado, documento: b.documento, total_lps: totalLps, lineas: lineas.length, tipo_cambio: tc }, { sucursalId: o.sucursal_id });
      return {
        estado, recepcion_id: rec.id,
        lineas: lineas.map((l) => {
          const prev = previos.get(l.linea.id);
          const nuevo = { moneda: o.moneda, precio: l.precio, tipo_cambio: tc, precio_lps: l.costoLps };
          return { linea_id: l.linea.id, descripcion: l.linea.descripcion, ...resultados.find((x) => x.linea_id === l.linea.id),
            variacion_pct: prev ? variacionPct(l.costoLps, prev.precio_lps) : null, variacion_dolar: prev ? variacionDolarizada(nuevo, prev) : null };
        }),
      };
    });
    res.status(201).json({ ...salida, orden: await detalleOrden(db, req, id) });
  });

  // ── Pagos al proveedor (cuentas por pagar) ─────────────────────────────────
  r.post('/ordenes/:id/pagos', requierePermiso('fin:gastos'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(z.object({ monto_lps: z.coerce.number().positive('El monto debe ser mayor a 0').max(999_999_999), fecha: fechaISO.optional(), forma: txt(30), referencia: txt(60) }), req.body);
    const hoy = fechaHN();
    if ((b.fecha ?? hoy) > hoy) throw malaPeticion('La fecha del pago no puede ser futura');
    await db.tx(async (q) => {
      const o = await cargarOrden(q, req, id, { bloquear: true });
      const d = await detalleOrden(q, req, id);
      if (o.condicion !== 'credito') throw conflicto('Esta orden es de contado: se considera pagada al recibirla');
      if (b.monto_lps > d.saldo_lps + 0.005) throw malaPeticion(`El pago supera el saldo pendiente (L ${d.saldo_lps.toFixed(2)})`);
      const p = (await q.query('insert into cmp.pagos (empresa_id, orden_id, fecha, monto_lps, forma, referencia, usuario_id) values ($1,$2,$3,$4,$5,$6,$7) returning id', [emp(req), id, b.fecha ?? hoy, b.monto_lps, b.forma, b.referencia, req.ctx.usuario.id])).rows[0];
      await auditar(q, req.ctx, 'oc_pago', 'orden_compra', id, { numero: Number(o.numero), monto_lps: b.monto_lps, forma: b.forma, pago: p.id });
    });
    res.status(201).json(await detalleOrden(db, req, id));
  });

  // ── Precios: historial por proveedor, comparativo y variación ──────────────
  r.post('/precios', editar, async (req, res) => {
    const b = validar(z.object({
      proveedor_id: uuid, origen: z.enum(ORIGENES), item_id: uuid, moneda: z.enum(['HNL', 'USD']).default('HNL'), precio: precioEsq, tipo_cambio: tcEsq.optional().nullable(),
      fecha: fechaISO.optional(), documento: txt(60),
    }), req.body);
    if (b.moneda === 'USD' && !b.tipo_cambio) throw malaPeticion('Escribe el tipo de cambio');
    const tc = b.moneda === 'USD' ? b.tipo_cambio : 1;
    const hoy = fechaHN();
    if ((b.fecha ?? hoy) > hoy) throw malaPeticion('La fecha no puede ser futura');
    await db.tx(async (q) => {
      if (!(await q.query('select 1 from core.terceros where id = $1 and es_proveedor and activo', [b.proveedor_id])).rowCount) throw noEncontrado('Proveedor no encontrado');
      const it = await resolverItem(q, emp(req), b.origen, b.item_id);
      await q.query(
        `insert into cmp.precios (empresa_id, proveedor_id, origen, item_id, descripcion, unidad, fecha, moneda, precio, tipo_cambio, precio_lps, fuente, documento, usuario_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'cotizacion',$12,$13)`,
        [emp(req), b.proveedor_id, b.origen, b.item_id, it.nombre, it.unidad, b.fecha ?? hoy, b.moneda, b.precio, tc, aLempiras(b.precio, b.moneda, tc), b.documento, req.ctx.usuario.id]);
      await auditar(q, req.ctx, 'precio_cotizado', 'tercero', b.proveedor_id, { item: it.nombre, precio: b.precio, moneda: b.moneda });
    });
    res.status(201).json({ ok: true });
  });

  async function filasPrecios(req, f = {}) {
    const { rows } = await db.query(
      `select p.id, p.proveedor_id, t.nombre as proveedor, p.origen, p.item_id, p.descripcion, p.unidad, p.fecha::text as fecha, p.moneda, p.precio::float8 as precio,
              p.tipo_cambio::float8 as tipo_cambio, p.precio_lps::float8 as precio_lps, p.fuente, p.documento
         from cmp.precios p left join core.terceros t on t.id = p.proveedor_id
        where p.empresa_id = $1 and ($2::text is null or p.origen = $2) and ($3::uuid is null or p.item_id = $3) and ($4::text is null or p.descripcion ilike '%'||$4||'%')
        order by p.fecha desc, p.id desc limit 5000`, [emp(req), f.origen ?? null, f.item_id ?? null, f.q || null]);
    return rows;
  }

  /** Por ítem: el último precio de cada proveedor, contra su compra anterior, y cuál conviene. */
  function resumenPrecios(filas) {
    const items = new Map();
    for (const p of filas) {
      const k = `${p.origen}:${p.item_id}`;
      if (!items.has(k)) items.set(k, { origen: p.origen, item_id: p.item_id, descripcion: p.descripcion, unidad: p.unidad, historial: [] });
      items.get(k).historial.push(p);
    }
    return [...items.values()].map((it) => {
      const porProv = new Map();
      for (const p of it.historial) { const k = p.proveedor_id ?? 'sin'; if (!porProv.has(k)) porProv.set(k, []); porProv.get(k).push(p); }   // ya vienen de lo más nuevo a lo más viejo
      const proveedores = [...porProv.values()].map((h) => ({
        proveedor_id: h[0].proveedor_id, proveedor: h[0].proveedor ?? 'Sin proveedor', ultimo: h[0], anterior: h[1] ?? null, compras: h.length,
        variacion_pct: h[1] ? variacionPct(h[0].precio_lps, h[1].precio_lps) : null, variacion_dolar: h[1] ? variacionDolarizada(h[0], h[1]) : null,
      })).sort((a, b) => a.ultimo.precio_lps - b.ultimo.precio_lps);
      const mejor = proveedores[0];
      const peor = proveedores[proveedores.length - 1];
      return {
        origen: it.origen, item_id: it.item_id, descripcion: it.descripcion, unidad: it.unidad, proveedores, mejor_proveedor_id: proveedores.length > 1 ? mejor.proveedor_id : null,
        ahorro_pct: proveedores.length > 1 ? variacionPct(peor.ultimo.precio_lps, mejor.ultimo.precio_lps) : null,
        ultimo: it.historial[0], variacion_pct: it.historial[1] ? variacionPct(it.historial[0].precio_lps, it.historial[1].precio_lps) : null,
        variacion_dolar: it.historial[1] ? variacionDolarizada(it.historial[0], it.historial[1]) : null,
      };
    });
  }

  r.get('/precios', ver, async (req, res) => {
    const f = validar(z.object({ origen: z.enum(ORIGENES).optional(), item_id: uuid.optional(), q: z.string().trim().max(60).optional() }), req.query);
    const filas = await filasPrecios(req, f);
    res.json(f.item_id ? { historial: filas, resumen: resumenPrecios(filas)[0] ?? null } : { resumen: resumenPrecios(filas) });
  });

  // ── Reorden desde mínimos ──────────────────────────────────────────────────
  r.get('/reorden', ver, async (req, res) => res.json(sugerenciasReorden(await leerCatalogo(db, emp(req)))));

  // ── Excel ──────────────────────────────────────────────────────────────────
  r.get('/exportar', ver, async (req, res) => {
    const { reporte } = validar(z.object({ reporte: z.enum(['ordenes', 'precios', 'reorden']) }), req.query);
    const sub = `${req.ctx.empresa.nombre} · generado ${fechaHN()}`;
    let hoja, nombre;
    if (reporte === 'ordenes') {
      const { rows } = await db.query(
        `select o.numero::int as numero, o.fecha::text as fecha, t.nombre as proveedor, o.estado, o.moneda, o.tipo_cambio::float8 as tipo_cambio, o.total::float8 as total, o.condicion, o.fecha_esperada::text as esperada
           from cmp.ordenes o join core.terceros t on t.id = o.proveedor_id where o.empresa_id = $1 order by o.numero desc`, [emp(req)]);
      hoja = { nombre: 'Órdenes de compra', columnas: [{ h: 'N.°', k: 'numero', tipo: 'entero', ancho: 8 }, { h: 'Fecha', k: 'fecha', ancho: 12 }, { h: 'Proveedor', k: 'proveedor', ancho: 32 }, { h: 'Estado', k: 'estado', ancho: 18 },
        { h: 'Moneda', k: 'moneda', ancho: 9 }, { h: 'Tipo de cambio', k: 'tipo_cambio', tipo: 'numero' }, { h: 'Total', k: 'total', tipo: 'numero' }, { h: 'Condición', k: 'condicion', ancho: 12 }, { h: 'Entrega esperada', k: 'esperada', ancho: 16 }], filas: rows };
      nombre = 'ordenes-de-compra.xlsx';
    } else if (reporte === 'precios') {
      const resumen = resumenPrecios(await filasPrecios(req));
      const filas = resumen.flatMap((it) => it.proveedores.map((p) => ({ item: it.descripcion, unidad: it.unidad, proveedor: p.proveedor, fecha: p.ultimo.fecha, moneda: p.ultimo.moneda, precio: p.ultimo.precio, tc: p.ultimo.tipo_cambio,
        lps: p.ultimo.precio_lps, variacion: p.variacion_pct, mejor: it.mejor_proveedor_id && it.mejor_proveedor_id === p.proveedor_id ? 'Sí' : '' })));
      hoja = { nombre: 'Comparativo de precios', columnas: [{ h: 'Ítem', k: 'item', ancho: 34 }, { h: 'Unidad', k: 'unidad', ancho: 10 }, { h: 'Proveedor', k: 'proveedor', ancho: 28 }, { h: 'Fecha', k: 'fecha', ancho: 12 }, { h: 'Moneda', k: 'moneda', ancho: 9 },
        { h: 'Precio', k: 'precio', tipo: 'numero' }, { h: 'Tipo de cambio', k: 'tc', tipo: 'numero' }, { h: 'Precio en lempiras', k: 'lps', tipo: 'lempiras' }, { h: 'Variación vs compra anterior', k: 'variacion', tipo: 'porcentaje' }, { h: 'Más barato', k: 'mejor', ancho: 11 }], filas };
      nombre = 'comparativo-de-precios.xlsx';
    } else {
      const filas = sugerenciasReorden(await leerCatalogo(db, emp(req))).map((i) => ({ item: i.nombre, tipo: ORIGEN_NOMBRE[i.origen], unidad: i.unidad, stock: i.stock, minimo: i.minimo, camino: i.en_camino, sugerido: i.sugerido, costo: i.costo_estimado_lps }));
      hoja = { nombre: 'Reorden', columnas: [{ h: 'Ítem', k: 'item', ancho: 34 }, { h: 'Tipo', k: 'tipo', ancho: 28 }, { h: 'Unidad', k: 'unidad', ancho: 10 }, { h: 'Existencia', k: 'stock', tipo: 'numero' }, { h: 'Mínimo', k: 'minimo', tipo: 'numero' },
        { h: 'En camino', k: 'camino', tipo: 'numero' }, { h: 'Sugerido', k: 'sugerido', tipo: 'numero' }, { h: 'Costo estimado', k: 'costo', tipo: 'lempiras' }], filas };
      nombre = 'sugerencias-de-reorden.xlsx';
    }
    enviarLibro(res, await libroExcel({ titulo: hoja.nombre, subtitulo: sub, hojas: [hoja] }), nombre);
  });

  return r;
}
