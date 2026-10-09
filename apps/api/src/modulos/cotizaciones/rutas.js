import { Router } from 'express';
import { z } from 'zod';
import { calcularTotales, fechaHN, round2 } from '@grupo/shared';
import { requierePermiso, resolverSucursal } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { enviarCotizacionPorCorreo } from '../mensajeria/envios.js';
import { ErrorHttp, conflicto, malaPeticion, noEncontrado, prohibido, uuid, validar } from '../../lib/http.js';
import {
  CLAVES_CHECKLIST, CONDICIONES_EVENTOS, DIAS_VALIDEZ, ESTADOS, ESTADOS_MANUALES, ITEMS_CHECKLIST, UMBRAL_RTN_OBLIGATORIO,
  pasosHechos, problemaAgenda, rtnLuceValido, saldoPendiente, situacionEvento, subtotalCotizacion, totalCotizacion,
} from './calculo.js';

// nullish() va DESPUÉS del transform: un campo que no viene sigue siendo undefined (no se pisa con null al editar).
const texto = (max = 200) => z.string().trim().max(max).transform((v) => (v ? v : null)).nullish();
const dineroOpc = z.coerce.number().finite().min(0).max(99_999_999);

const partida = z.object({
  descripcion: z.string().trim().min(1, 'Cada partida lleva descripción').max(160),
  cantidad: z.coerce.number().positive().max(99_999),
  precio_unitario: dineroOpc,
});

const camposBase = {
  nombre_cliente: z.string().trim().min(2, 'Falta el nombre del cliente').max(160),
  telefono_cliente: texto(40),
  email_cliente: z.string().trim().toLowerCase().email('Correo del cliente inválido').optional().nullable().or(z.literal('').transform(() => null)),
  rtn_cliente: texto(20),
  nombre_evento: z.string().trim().min(2, 'Falta el nombre del evento').max(160),
  fecha_evento: texto(10),
  hora_evento: texto(8),
  lugar: texto(200),
  cantidad_copitas: z.coerce.number().int().min(0).max(1_000_000),
  precio_copita: dineroOpc,
  costo_servicio: dineroOpc.default(0),
  descuento: dineroOpc.default(0),
  anticipo: dineroOpc.default(0),
  notas: texto(1000),
  sucursal_id: uuid.optional().nullable().or(z.literal('').transform(() => null)),
  estado: z.enum(ESTADOS_MANUALES).optional(),
  partidas: z.array(partida).max(40).default([]),
};
const esquemaCrear = z.object(camposBase);
const esquemaEditar = z.object(camposBase).partial();

/** Rutas /api/cotizaciones — solo en empresas con el módulo `cotizaciones` encendido (hoy Italo). */
export function rutasCotizaciones({ db }) {
  const r = Router();

  r.use((req, _res, next) => {
    if (!req.ctx.empresa.modulos.includes('cotizaciones')) throw prohibido(`${req.ctx.empresa.nombre} no tiene el módulo de cotizaciones`);
    next();
  });
  r.use(requierePermiso('cotizaciones:ver'));

  /** Agrega partidas, total, saldo y situación calculados en el servidor. */
  function enriquecer(c, partidas) {
    const total = totalCotizacion(c, partidas);
    return {
      ...c, partidas, subtotal: subtotalCotizacion(c, partidas), total,
      saldo: saldoPendiente(c, total), pasos_hechos: pasosHechos(c), pasos_total: ITEMS_CHECKLIST.length,
      situacion: situacionEvento(c, fechaHN()),
    };
  }
  async function cargarLista(q, ctx, filtro = '', params = []) {
    const { rows } = await q.query(
      `select c.*, u.nombre as atendido_por, s.nombre as sucursal
         from cot.cotizaciones c left join core.usuarios u on u.id = c.usuario_id left join core.sucursales s on s.id = c.sucursal_id
        where c.empresa_id = $1 ${filtro} order by c.created_at desc, c.numero desc`, [ctx.empresa.id, ...params]);
    if (!rows.length) return [];
    const ps = (await q.query('select * from cot.partidas where cotizacion_id = any($1::uuid[]) order by orden', [rows.map((x) => x.id)])).rows;
    return rows.map((c) => enriquecer(c, ps.filter((p) => p.cotizacion_id === c.id)));
  }
  async function cargarUna(q, ctx, id) {
    const [c] = await cargarLista(q, ctx, 'and c.id = $2', [id]);
    if (!c) throw noEncontrado('Cotización no encontrada');
    return c;
  }
  async function guardarPartidas(q, id, partidas) {
    await q.query('delete from cot.partidas where cotizacion_id = $1', [id]);
    for (const [i, p] of partidas.entries()) {
      await q.query('insert into cot.partidas (cotizacion_id, descripcion, cantidad, precio_unitario, orden) values ($1,$2,$3,$4,$5)', [id, p.descripcion, p.cantidad, p.precio_unitario, i]);
    }
  }
  async function validarSucursal(q, ctx, id) {
    if (!id) return;
    const { rows } = await q.query('select 1 from core.sucursales where id = $1 and empresa_id = $2', [id, ctx.empresa.id]);
    if (!rows.length) throw malaPeticion('Esa sucursal no pertenece a esta empresa');
  }
  const nombreFila = (c) => String(c.numero).padStart(4, '0');

  // ── Lista ────────────────────────────────────────────────────────────────
  r.get('/', async (req, res) => {
    const f = validar(z.object({ estado: z.enum(ESTADOS).optional() }), req.query);
    res.json(await cargarLista(db, req.ctx, f.estado ? 'and c.estado = $2' : '', f.estado ? [f.estado] : []));
  });

  // ── Crear ────────────────────────────────────────────────────────────────
  r.post('/', async (req, res) => {
    const b = validar(esquemaCrear, req.body);
    if (b.cantidad_copitas === 0 && b.partidas.length === 0) throw malaPeticion('Indica la cantidad de copitas o agrega al menos una partida');
    const total = totalCotizacion(b, b.partidas);
    if (b.descuento > subtotalCotizacion(b, b.partidas) + 0.001) throw malaPeticion('El descuento no puede ser mayor que el subtotal');
    const err = problemaAgenda(b, total);
    if (err) throw malaPeticion(err);
    if (b.rtn_cliente && !rtnLuceValido(b.rtn_cliente)) throw malaPeticion('El RTN hondureño debe tener 13-14 dígitos — revísalo.');
    const estado = b.estado ?? 'borrador';
    if (estado === 'aceptada' && !b.fecha_evento) throw malaPeticion('Para aceptar la cotización indica la fecha del evento');
    const out = await db.tx(async (q) => {
      await validarSucursal(q, req.ctx, b.sucursal_id);
      const numero = (await q.query('select cot.siguiente_numero($1) as n', [req.ctx.empresa.id])).rows[0].n;
      const checklist = estado === 'aceptada' && b.anticipo > 0 ? { anticipo: { hecho: true, por: req.ctx.usuario.nombre, fecha: new Date().toISOString() } } : {};
      const c = (await q.query(
        `insert into cot.cotizaciones (empresa_id, numero, sucursal_id, nombre_cliente, telefono_cliente, email_cliente, rtn_cliente, nombre_evento,
                fecha_evento, hora_evento, lugar, cantidad_copitas, precio_copita, costo_servicio, descuento, anticipo, notas, estado, checklist,
                aceptada_at, usuario_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21) returning id`,
        [req.ctx.empresa.id, numero, b.sucursal_id ?? null, b.nombre_cliente, b.telefono_cliente, b.email_cliente ?? null, b.rtn_cliente, b.nombre_evento,
          b.fecha_evento, b.hora_evento, b.lugar, b.cantidad_copitas, b.precio_copita, b.costo_servicio, b.descuento, b.anticipo, b.notas, estado,
          JSON.stringify(checklist), estado === 'aceptada' ? new Date() : null, req.ctx.usuario.id])).rows[0];
      await guardarPartidas(q, c.id, b.partidas);
      await auditar(q, req.ctx, 'cotizacion_creada', 'cotizacion', c.id, { numero, evento: b.nombre_evento, cliente: b.nombre_cliente, total }, { sucursalId: b.sucursal_id ?? null });
      return cargarUna(q, req.ctx, c.id);
    });
    res.status(201).json(out);
  });

  r.get('/:id', async (req, res) => res.json(await cargarUna(db, req.ctx, validar(uuid, req.params.id))));

  // ── Editar (datos, partidas y estado) ────────────────────────────────────
  r.put('/:id', async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(esquemaEditar, req.body);
    const out = await db.tx(async (q) => {
      const act = (await q.query('select * from cot.cotizaciones where id = $1 and empresa_id = $2 for update', [id, req.ctx.empresa.id])).rows[0];
      if (!act) throw noEncontrado('Cotización no encontrada');
      if (act.estado === 'facturada') throw conflicto('Una cotización ya facturada no se puede modificar');
      const partidasAct = (await q.query('select * from cot.partidas where cotizacion_id = $1 order by orden', [id])).rows;
      const partidas = b.partidas ?? partidasAct;
      const nuevo = { ...act, ...Object.fromEntries(Object.entries(b).filter(([k, v]) => v !== undefined && k !== 'partidas')) };
      if (nuevo.cantidad_copitas === 0 && partidas.length === 0) throw malaPeticion('Indica la cantidad de copitas o agrega al menos una partida');
      const total = totalCotizacion(nuevo, partidas);
      if (nuevo.descuento > subtotalCotizacion(nuevo, partidas) + 0.001) throw malaPeticion('El descuento no puede ser mayor que el subtotal');
      const err = problemaAgenda(nuevo, total);
      if (err) throw malaPeticion(err);
      if (nuevo.rtn_cliente && !rtnLuceValido(nuevo.rtn_cliente)) throw malaPeticion('El RTN hondureño debe tener 13-14 dígitos — revísalo.');
      await validarSucursal(q, req.ctx, nuevo.sucursal_id);
      const seAcepta = nuevo.estado === 'aceptada' && act.estado !== 'aceptada';
      let checklist = act.checklist ?? {};
      let aceptadaAt = act.aceptada_at;
      if (seAcepta) {
        if (!nuevo.fecha_evento) throw malaPeticion('Para aceptar la cotización indica la fecha del evento (se agenda en el calendario)');
        aceptadaAt = new Date();
        if (Number(nuevo.anticipo) > 0 && !checklist.anticipo?.hecho) checklist = { ...checklist, anticipo: { hecho: true, por: req.ctx.usuario.nombre, fecha: aceptadaAt.toISOString() } };
      }
      await q.query(
        `update cot.cotizaciones set sucursal_id=$2, nombre_cliente=$3, telefono_cliente=$4, email_cliente=$5, rtn_cliente=$6, nombre_evento=$7,
                fecha_evento=$8, hora_evento=$9, lugar=$10, cantidad_copitas=$11, precio_copita=$12, costo_servicio=$13, descuento=$14, anticipo=$15,
                notas=$16, estado=$17, checklist=$18::jsonb, aceptada_at=$19, updated_at=now() where id=$1`,
        [id, nuevo.sucursal_id ?? null, nuevo.nombre_cliente, nuevo.telefono_cliente, nuevo.email_cliente, nuevo.rtn_cliente, nuevo.nombre_evento,
          nuevo.fecha_evento || null, nuevo.hora_evento || null, nuevo.lugar, nuevo.cantidad_copitas, nuevo.precio_copita, nuevo.costo_servicio, nuevo.descuento,
          nuevo.anticipo, nuevo.notas, nuevo.estado, JSON.stringify(checklist), aceptadaAt]);
      if (b.partidas) await guardarPartidas(q, id, b.partidas);
      if (nuevo.estado !== act.estado) {
        await auditar(q, req.ctx, seAcepta ? 'cotizacion_aceptada' : 'cotizacion_estado', 'cotizacion', id,
          { numero: act.numero, de: act.estado, a: nuevo.estado, fecha_evento: nuevo.fecha_evento, total, anticipo: Number(nuevo.anticipo) }, { sucursalId: nuevo.sucursal_id ?? null });
      } else {
        await auditar(q, req.ctx, 'cotizacion_editada', 'cotizacion', id, { numero: act.numero, total }, { sucursalId: nuevo.sucursal_id ?? null });
      }
      return cargarUna(q, req.ctx, id);
    });
    res.json(out);
  });

  // ── Seguimiento del evento (calendario): checklist, hora, sucursal, anticipo, reprogramar ──
  r.put('/:id/seguimiento', async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(z.object({
      fecha_evento: texto(10), hora_evento: texto(8), lugar: texto(200), notas_seguimiento: texto(2000),
      sucursal_id: uuid.optional().nullable().or(z.literal('').transform(() => null)),
      anticipo: dineroOpc.optional(),
      item: z.string().optional(), hecho: z.boolean().optional(), realizado: z.boolean().optional(),
    }), req.body);
    const out = await db.tx(async (q) => {
      const act = (await q.query('select * from cot.cotizaciones where id = $1 and empresa_id = $2 for update', [id, req.ctx.empresa.id])).rows[0];
      if (!act) throw noEncontrado('Cotización no encontrada');
      if (!['aceptada', 'facturada'].includes(act.estado)) throw conflicto('Solo las cotizaciones aceptadas o facturadas tienen seguimiento en el calendario');
      const partidas = (await q.query('select * from cot.partidas where cotizacion_id = $1', [id])).rows;
      const total = totalCotizacion(act, partidas);
      const cambios = {};
      for (const k of ['fecha_evento', 'hora_evento', 'lugar', 'notas_seguimiento', 'sucursal_id', 'anticipo']) if (b[k] !== undefined) cambios[k] = b[k];
      if ('fecha_evento' in cambios && !cambios.fecha_evento) throw malaPeticion('Un evento aceptado debe tener fecha');
      if (cambios.anticipo !== undefined && act.estado === 'facturada' && cambios.anticipo !== Number(act.anticipo)) throw conflicto('La cotización ya está facturada: el anticipo quedó cerrado en la factura');
      const err = problemaAgenda(cambios, total);
      if (err) throw malaPeticion(err);
      if ('sucursal_id' in cambios) await validarSucursal(q, req.ctx, cambios.sucursal_id);
      if (b.item !== undefined) {
        if (!CLAVES_CHECKLIST.has(b.item)) throw malaPeticion('Paso de seguimiento desconocido');
        cambios.checklist = { ...(act.checklist ?? {}), [b.item]: b.hecho ? { hecho: true, por: req.ctx.usuario.nombre, fecha: new Date().toISOString() } : { hecho: false } };
      }
      if (b.realizado !== undefined) cambios.realizado = b.realizado;
      if (!Object.keys(cambios).length) throw malaPeticion('Nada que actualizar');
      const sets = Object.keys(cambios).map((k, i) => `${k} = $${i + 2}${k === 'checklist' ? '::jsonb' : ''}`);
      const vals = Object.entries(cambios).map(([k, v]) => (k === 'checklist' ? JSON.stringify(v) : v === '' ? null : v));
      await q.query(`update cot.cotizaciones set ${sets.join(', ')}, updated_at = now() where id = $1`, [id, ...vals]);

      const detalle = { numero: act.numero, evento: act.nombre_evento };
      if (b.item !== undefined) detalle.paso = { item: b.item, hecho: Boolean(b.hecho) };
      if (cambios.fecha_evento && cambios.fecha_evento !== act.fecha_evento) detalle.reprogramado = { de: act.fecha_evento, a: cambios.fecha_evento };
      for (const k of ['hora_evento', 'sucursal_id', 'anticipo', 'realizado', 'lugar']) {
        if (cambios[k] !== undefined && String(cambios[k] ?? '') !== String(act[k] ?? '')) detalle[k] = { de: act[k], a: cambios[k] };
      }
      if (cambios.notas_seguimiento !== undefined && cambios.notas_seguimiento !== act.notas_seguimiento) detalle.notas = true;
      await auditar(q, req.ctx, detalle.reprogramado ? 'evento_reprogramado' : 'evento_seguimiento', 'cotizacion', id, detalle, { sucursalId: cambios.sucursal_id ?? act.sucursal_id ?? null });
      return cargarUna(q, req.ctx, id);
    });
    res.json(out);
  });

  // ── Eliminar (solo borradores) ───────────────────────────────────────────
  r.delete('/:id', async (req, res) => {
    const id = validar(uuid, req.params.id);
    await db.tx(async (q) => {
      const c = (await q.query('select * from cot.cotizaciones where id = $1 and empresa_id = $2 for update', [id, req.ctx.empresa.id])).rows[0];
      if (!c) throw noEncontrado('Cotización no encontrada');
      if (c.estado !== 'borrador') throw conflicto('Solo se eliminan cotizaciones en borrador');
      await q.query('delete from cot.cotizaciones where id = $1', [id]);
      await auditar(q, req.ctx, 'cotizacion_eliminada', 'cotizacion', id, { numero: c.numero, evento: c.nombre_evento });
    });
    res.status(204).end();
  });

  // ── Documento imprimible (el navegador lo imprime o lo guarda como PDF) ──
  r.get('/:id/documento', async (req, res) => {
    const c = await cargarUna(db, req.ctx, validar(uuid, req.params.id));
    const emp = req.ctx.empresa;
    const emitida = new Date(c.created_at);
    res.json({
      cotizacion: c,
      empresa: { nombre: emp.nombre, razon_social: emp.razon_social, rtn: emp.rtn, direccion: emp.direccion, ciudad: emp.ciudad, telefono: emp.telefono, correo: emp.correo, web: emp.web, lema: emp.lema },
      sucursal: c.sucursal ?? null,
      emitida_at: emitida.toISOString(),
      valida_hasta: new Date(emitida.getTime() + DIAS_VALIDEZ * 86_400_000).toISOString(),
      dias_validez: DIAS_VALIDEZ,
      condiciones: CONDICIONES_EVENTOS,
    });
  });

  // ── Envío por correo (Gmail, con el PDF adjunto) ─────────────────────────
  r.post('/:id/enviar', async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(z.object({ email: z.string().trim().max(160).optional(), mensaje: z.string().trim().max(500).optional() }), req.body ?? {});
    const c = await cargarUna(db, req.ctx, id);
    if (c.estado === 'facturada') throw conflicto('Esa cotización ya está facturada');
    const out = await enviarCotizacionPorCorreo({ q: db, ctx: req.ctx, tipo: 'italo', cot: c, id, destino: b.email || c.email_cliente, mensaje: b.mensaje });
    if (out.ok && c.estado === 'borrador') await db.query(`update cot.cotizaciones set estado = 'enviada' where id = $1 and estado = 'borrador'`, [id]);
    res.json(out);
  });

  // ── Cotización → factura (misma conversión que Italo Facturación) ────────
  r.post('/:id/facturar', requierePermiso('pos:anular'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(z.object({
      sucursal_id: uuid.optional(),
      forma_pago: z.enum(['efectivo', 'tarjeta', 'transferencia']),
      rtn: texto(20),
    }), req.body);
    const out = await db.tx(async (q) => {
      const c = (await q.query('select * from cot.cotizaciones where id = $1 and empresa_id = $2 for update', [id, req.ctx.empresa.id])).rows[0];
      if (!c) throw noEncontrado('Cotización no encontrada');
      if (c.venta_id || c.estado === 'facturada') throw conflicto('Esta cotización ya fue facturada');
      if (c.estado === 'rechazada') throw conflicto('No se puede facturar una cotización rechazada');
      const partidas = (await q.query('select * from cot.partidas where cotizacion_id = $1 order by orden', [id])).rows;
      const total = totalCotizacion(c, partidas);
      const rtn = (b.rtn ?? c.rtn_cliente ?? '').trim();
      if (rtn && !rtnLuceValido(rtn)) throw malaPeticion('El RTN hondureño debe tener 13-14 dígitos — revísalo.');
      if (total > UMBRAL_RTN_OBLIGATORIO && !rtn) throw malaPeticion(`Esta cotización supera L${UMBRAL_RTN_OBLIGATORIO.toLocaleString('es-HN')}: se necesita el RTN del cliente para facturarla.`);
      const suc = await resolverSucursal(q, req.ctx, b.sucursal_id ?? c.sucursal_id ?? undefined);
      const fp = (await q.query(`select id from pos.formas_pago where empresa_id = $1 and tipo = $2 and activo order by orden limit 1`, [req.ctx.empresa.id, b.forma_pago])).rows[0];
      if (!fp) throw malaPeticion('Esa forma de pago no existe en esta empresa');

      // Cliente: por RTN, o por correo si no hay RTN; si no existe se crea (la factura sale a su nombre).
      const rtnLimpio = rtn.replace(/[-\s]/g, '');
      let cliente = null;
      if (rtnLimpio) cliente = (await q.query('select * from core.terceros where rtn = $1 and activo limit 1', [rtnLimpio])).rows[0];
      else if (c.email_cliente) cliente = (await q.query('select * from core.terceros where lower(correo) = lower($1) and activo limit 1', [c.email_cliente])).rows[0];
      if (!cliente) {
        cliente = (await q.query(
          `insert into core.terceros (nombre, rtn, telefono, correo, es_cliente, created_by) values ($1,$2,$3,$4,true,$5) returning *`,
          [c.nombre_cliente, rtnLimpio || null, c.telefono_cliente, c.email_cliente, req.ctx.usuario.id])).rows[0];
        await auditar(q, req.ctx, 'tercero_creado', 'tercero', cliente.id, { nombre: cliente.nombre, origen: 'cotizacion' });
      }
      if (rtnLimpio && rtnLimpio !== c.rtn_cliente) await q.query('update cot.cotizaciones set rtn_cliente = $2 where id = $1', [id, rtnLimpio]);

      // Líneas con los mismos precios cotizados (ISV incluido, 15 %).
      const items = [];
      if (c.cantidad_copitas > 0) items.push({ producto_id: null, nombre_producto: `Copitas de gelato - ${c.nombre_evento}`, cantidad: c.cantidad_copitas, precio_base: c.precio_copita, impuesto_tasa: 0.15 });
      if (c.costo_servicio > 0) items.push({ producto_id: null, nombre_producto: 'Servicio de evento', cantidad: 1, precio_base: c.costo_servicio, impuesto_tasa: 0.15 });
      for (const p of partidas) items.push({ producto_id: null, nombre_producto: p.descripcion, cantidad: p.cantidad, precio_base: p.precio_unitario, impuesto_tasa: 0.15 });
      const tot = calcularTotales(items, cliente, c.descuento);
      if (round2(tot.total) !== round2(total)) throw conflicto('El total de la factura no coincide con la cotización; revisa los montos');

      const ticket = (await q.query('select pos.siguiente_ticket($1) as n', [suc.id])).rows[0].n;
      const venta = (await q.query(
        `insert into pos.ventas (empresa_id, sucursal_id, cliente_id, cajero_id, canal, tipo_orden, nombre_orden, notas, ticket_dia,
                subtotal_exento, subtotal_exonerado, subtotal_gravado_15, subtotal_gravado_18, descuento, isv_total, total)
         values ($1,$2,$3,$4,'evento','llevar',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
        [req.ctx.empresa.id, suc.id, cliente.id, req.ctx.usuario.id, c.nombre_evento.slice(0, 60), `Cotización de evento No. ${nombreFila(c)}`, ticket,
          tot.subtotal_exento, tot.subtotal_exonerado, tot.subtotal_gravado_15, tot.subtotal_gravado_18, tot.descuento, tot.isv_total, tot.total])).rows[0];
      for (const l of tot.lineas) {
        await q.query(
          `insert into pos.detalle_venta (venta_id, producto_id, nombre_producto, cantidad, precio_base, extras, precio_unitario, opciones, notas,
                  descuento, descuento_porcentaje, impuesto_tasa, exento, monto, orden)
           values ($1,null,$2,$3,$4,$5,$6,'[]'::jsonb,null,$7,0,$8,$9,$10,$11)`,
          [venta.id, l.nombre_producto, l.cantidad, l.precio_base, l.extras, l.precio_unitario, l.descuento, l.impuesto_tasa, l.exento, l.monto, l.orden]);
      }
      // Turno: se abre solo (fondo 0) si el usuario no tiene uno, igual que al cobrar en caja.
      let turno = (await q.query(`select id from pos.turnos where sucursal_id = $1 and cajero_id = $2 and estado = 'abierto'`, [suc.id, req.ctx.usuario.id])).rows[0];
      if (!turno) {
        turno = (await q.query('insert into pos.turnos (empresa_id, sucursal_id, cajero_id, fondo_inicial) values ($1,$2,$3,0) returning id', [req.ctx.empresa.id, suc.id, req.ctx.usuario.id])).rows[0];
        await auditar(q, req.ctx, 'turno_abierto', 'turno', turno.id, { fondo: 0, automatico: true }, { sucursalId: suc.id });
      }
      await q.query('update pos.ventas set turno_id = $1 where id = $2', [turno.id, venta.id]);
      const pagada = (await q.query('select * from pos.cobrar_venta($1, $2::jsonb)', [venta.id, JSON.stringify(tot.total > 0 ? [{ forma_pago_id: fp.id, monto: tot.total }] : [])])).rows[0];
      await auditar(q, req.ctx, 'venta_cobrada', 'venta', venta.id, { factura: pagada.numero_factura, total: pagada.total, origen: 'cotizacion' }, { sucursalId: suc.id });

      await q.query(
        `update cot.cotizaciones set estado='facturada', venta_id=$2, cliente_id=$3, aceptada_at=coalesce(aceptada_at, now()), sucursal_id=coalesce(sucursal_id, $4),
                checklist = checklist || $5::jsonb, updated_at=now() where id=$1`,
        [id, venta.id, cliente.id, suc.id, JSON.stringify({ cobro: { hecho: true, por: req.ctx.usuario.nombre, fecha: new Date().toISOString(), factura: pagada.numero_factura } })]);
      await auditar(q, req.ctx, 'cotizacion_facturada', 'cotizacion', id,
        { numero_cotizacion: c.numero, numero_factura: pagada.numero_factura, venta_id: venta.id, total: pagada.total, cliente: cliente.nombre }, { sucursalId: suc.id });
      return { factura: { id: venta.id, numero_factura: pagada.numero_factura, es_borrador: pagada.es_borrador_fiscal, total: pagada.total }, cotizacion: await cargarUna(q, req.ctx, id) };
    });
    res.status(201).json(out);
  });

  return r;
}
