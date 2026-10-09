import { Router } from 'express';
import { z } from 'zod';
import { requierePermiso, resolverSucursal, sucursalesPermitidas } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { ErrorHttp, conflicto, malaPeticion, noEncontrado, prohibido, uuid, validar, fechaISO } from '../../lib/http.js';
import { armarItems, totalesDe } from './calculo.js';
import { formatearTicket, formatearTicketPrueba, envolverTicketHtml, anchoValido } from './ticket.js';
import { generarPdfFactura, cargarLogo } from './pdf.js';
import { enviarFacturaPorCorreo } from '../mensajeria/envios.js';
import { UMBRAL_RTN_OBLIGATORIO, identidadValida, fechaHN, round2 } from '@grupo/shared';
import { verificarSecreto } from '../../auth/passwords.js';
import { loginSupabase } from '../../auth/supabase.js';
import { crearLimitador } from '../../lib/limitador.js';
import { vigilarVenta } from '../antifraude/vigilancia.js';
import { antesDeCobrar, despuesDeAnular, despuesDeCobrar } from '../eco/existencias.js';

const item = z.object({
  producto_id: uuid,
  cantidad: z.coerce.number().positive().max(999),
  opciones: z.array(uuid).max(30).default([]),
  notas: z.string().trim().max(200).optional().nullable(),
  descuento_porcentaje: z.coerce.number().default(0),
});
const pago = z.object({ forma_pago_id: uuid, monto: z.coerce.number().positive().max(999_999_999, 'El monto es demasiado grande'), referencia: z.string().trim().max(60).optional().nullable() });
const cuerpoVenta = z.object({
  sucursal_id: uuid.optional(),
  canal: z.enum(['mostrador', 'recoger', 'delivery', 'evento', 'mayoreo']).default('mostrador'),
  tipo_orden: z.enum(['aqui', 'llevar']).default('aqui'),
  nombre_orden: z.string().trim().max(60).optional().nullable(),
  notas: z.string().trim().max(300).optional().nullable(),
  cliente_id: uuid.optional().nullable(),
  items: z.array(item).min(1, 'La orden no tiene productos').max(100),
  tercera_edad: z.object({ nombre: z.string().trim().min(3).max(120), identidad: z.string().trim().max(30).refine(identidadValida, 'Escribe el número de identidad o carné (mínimo 5 caracteres)') }).optional().nullable(),
  cobrar: z.object({ pagos: z.array(pago).min(1).max(10) }).optional(),
  confirmar_sin_stock: z.boolean().optional(),
  // Venta hecha SIN conexión que llega al sincronizar. `id_cliente` lo genera la caja una sola vez: reenviar la misma venta no duplica nada.
  id_cliente: uuid.optional(),
  orden_id: uuid.optional(),    // la orden que la caja ya había guardado como abierta antes de perder la conexión: se cobra ESA, no se crea otra
  offline: z.object({
    vendida_at: z.string().max(40),
    numero_provisional: z.string().trim().min(4).max(40),
    cajero_nombre: z.string().trim().max(80).optional().nullable(),
    total_cliente: z.coerce.number().min(0).max(999_999_999).optional(),
  }).optional(),
});

export function rutasVentas({ db, config, ctxMgr }) {
  const r = Router();
  const limAutorizacion = crearLimitador({ max: 6, ventanaMs: 10 * 60_000 });

  /** ¿Esta empresa usa notas de crédito? El negocio hoy NO las usa: están apagadas (core.config 'pos'.usar_notas_credito = true las enciende). */
  async function usaNotasCredito(q, empresaId) {
    const cfg = (await q.query(`select valor from core.config where empresa_id = $1 and clave = 'pos'`, [empresaId])).rows[0]?.valor ?? {};
    return cfg.usar_notas_credito === true;
  }

  /**
   * Anular una factura ya emitida:
   *  · el MISMO día (hora de Honduras): quien tenga pos:anular;
   *  · días anteriores del MISMO MES: solo con la aprobación de un dueño / administrador general (su correo y contraseña
   *    en la misma pantalla, o que quien anula ya sea ese dueño). Queda en la bitácora quién autorizó;
   *  · de un mes anterior: no se puede; se contacta a contabilidad.
   */
  async function autorizarAnulacion(q, req, v, autorizacion) {
    const hoy = fechaHN();
    const fecha = fechaHN(new Date(v.fecha_emision ?? v.created_at));
    if (fecha === hoy) return null;
    if (fecha.slice(0, 7) !== hoy.slice(0, 7)) {
      throw conflicto('Esta factura es de un mes anterior y ya no se puede anular desde el sistema. Comunícate con contabilidad.');
    }
    const esDueno = (u, rol) => u.es_dueno_grupo || rol === 'dueno';
    if (esDueno(req.ctx.usuario, req.ctx.rol)) return { id: req.ctx.usuario.id, nombre: req.ctx.usuario.nombre, via: 'propio' };
    if (!autorizacion?.email || !autorizacion?.password) {
      throw new ErrorHttp(403, 'Esta factura es de un día anterior: para anularla un dueño debe autorizarlo con su correo y contraseña.', 'requiere_autorizacion');
    }
    const clave = `${req.ctx.ip}|${req.ctx.usuario.id}`;
    if (limAutorizacion.bloqueado(clave)) throw new ErrorHttp(429, 'Demasiados intentos de autorización. Espera unos minutos.');
    const email = String(autorizacion.email).trim().toLowerCase();
    const u = (await q.query('select * from core.usuarios where email = $1 and activo', [email])).rows[0];
    let ok = false;
    if (u) ok = config?.supabaseUrl && u.auth_user_id ? Boolean(await loginSupabase(config, email, autorizacion.password)) : verificarSecreto(autorizacion.password, u.password_hash);
    else verificarSecreto(autorizacion.password, 'scrypt$00$00');
    let rolAut = null;
    if (ok && !u.es_dueno_grupo) rolAut = (await q.query('select rol from core.accesos where usuario_id = $1 and empresa_id = $2 and activo', [u.id, req.ctx.empresa.id])).rows[0]?.rol;
    if (!ok || !esDueno(u, rolAut)) {
      limAutorizacion.fallo(clave);
      throw Object.assign(new ErrorHttp(403, 'No se pudo autorizar: el correo o la contraseña no son de un dueño de esta empresa.', 'autorizacion_invalida'), { intento: { email, sucursalId: v.sucursal_id } });
    }
    limAutorizacion.exito(clave);
    return { id: u.id, nombre: u.nombre, via: 'contraseña' };
  }

  async function consumidorFinal(q) {
    return (await q.query('select * from core.terceros where es_consumidor_final')).rows[0];
  }
  async function clienteDe(q, id) {
    if (!id) return consumidorFinal(q);
    const c = (await q.query('select * from core.terceros where id = $1 and activo', [id])).rows[0];
    if (!c) throw malaPeticion('El cliente no existe');
    return c;
  }

  /** Carga una venta completa verificando empresa y sucursal permitida. */
  async function cargar(q, ctx, id, { bloquear = false } = {}) {
    const v = (await q.query(`select * from pos.ventas where id = $1 and empresa_id = $2 ${bloquear ? 'for update' : ''}`, [id, ctx.empresa.id])).rows[0];
    if (!v) throw noEncontrado('Venta no encontrada');
    if (ctx.sucursalIds.length && !ctx.sucursalIds.includes(v.sucursal_id)) throw prohibido();
    return v;
  }
  async function detalle(q, ctx, v) {
    const [lineas, pagos, cliente, sucursal, cajero, punto, notas] = await Promise.all([
      q.query('select * from pos.detalle_venta where venta_id = $1 order by orden', [v.id]),
      q.query('select p.monto, p.referencia, f.nombre as forma, f.tipo from pos.venta_pagos p join pos.formas_pago f on f.id = p.forma_pago_id where p.venta_id = $1', [v.id]),
      v.cliente_id ? q.query('select id, nombre, rtn, correo, telefono, exento_impuestos, es_consumidor_final from core.terceros where id = $1', [v.cliente_id]) : { rows: [] },
      q.query('select id, nombre, alias, direccion from core.sucursales where id = $1', [v.sucursal_id]),
      v.cajero_id ? q.query('select id, nombre from core.usuarios where id = $1', [v.cajero_id]) : { rows: [] },
      v.punto_emision_id ? q.query('select * from pos.puntos_emision where id = $1', [v.punto_emision_id]) : { rows: [] },
      q.query('select id, numero_nota, motivo, monto, created_at from pos.notas_credito where venta_id = $1 order by created_at', [v.id]),
    ]);
    // Factura emitida: el cliente es el que se congeló al cobrar (editar la ficha después no cambia facturas viejas).
    const cli = cliente.rows[0] ? { ...cliente.rows[0], ...(v.cliente_nombre ? { nombre: v.cliente_nombre, rtn: v.cliente_rtn, direccion: v.cliente_direccion } : {}) } : null;
    return { ...v, notas_credito: notas.rows, lineas: lineas.rows, pagos: pagos.rows, cliente: cli, sucursal: sucursal.rows[0], cajero: cajero.rows[0] ?? null, punto: punto.rows[0] ?? null };
  }

  /** Descuento de tercera edad (25 %): la ley exige identificar a la persona; la regla se puede apagar por empresa. */
  async function datosTerceraEdad(q, ctx, tot, enviado, previo = {}) {
    const hay25 = tot.lineas.some((l) => l.descuento_porcentaje === 25);
    if (!hay25) return { nombre: null, identidad: null };
    const nombre = enviado?.nombre ?? previo.nombre ?? null, identidad = enviado?.identidad ?? previo.identidad ?? null;
    // Guardar la orden con los datos a medias es válido (la caja guarda sola mientras el cajero escribe); lo que se exige es al COBRAR.
    return { nombre, identidad };
  }

  async function guardarLineas(q, ventaId, tot) {
    await q.query('delete from pos.detalle_venta where venta_id = $1', [ventaId]);
    for (const l of tot.lineas) {
      await q.query(
        `insert into pos.detalle_venta (venta_id, producto_id, nombre_producto, cantidad, precio_base, extras, precio_unitario, opciones, notas,
                                        descuento, descuento_porcentaje, impuesto_tasa, exento, monto, orden)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)`,
        [ventaId, l.producto_id, l.nombre_producto, l.cantidad, l.precio_base, l.extras, l.precio_unitario, JSON.stringify(l.opciones), l.notas,
          l.descuento, l.descuento_porcentaje, l.impuesto_tasa, l.exento, l.monto, l.orden]);
    }
  }
  const camposTotales = (tot) => [tot.subtotal_exento, tot.subtotal_exonerado, tot.subtotal_gravado_15, tot.subtotal_gravado_18,
    tot.descuento, Math.max(0, ...tot.lineas.map((l) => l.descuento_porcentaje)), tot.isv_total, tot.total];

  async function turnoAbierto(q, ctx, sucursalId) {
    return (await q.query(`select * from pos.turnos where sucursal_id = $1 and cajero_id = $2 and estado = 'abierto'`, [sucursalId, ctx.usuario.id])).rows[0];
  }

  async function cobrar(q, ctx, ventaId, pagos, extras = {}) {
    const v = await cargar(q, ctx, ventaId, { bloquear: true });
    if (v.estado !== 'abierta') throw conflicto(`La venta ya está ${v.estado}`);
    // La ley pide identificar al comprador en facturas grandes: sin RTN no se cobra por encima del umbral (L 10,000 por defecto).
    const cfgPos = (await q.query(`select valor from core.config where empresa_id = $1 and clave = 'pos'`, [ctx.empresa.id])).rows[0]?.valor ?? {};
    const umbral = Number(cfgPos.umbral_rtn) > 0 ? Number(cfgPos.umbral_rtn) : UMBRAL_RTN_OBLIGATORIO;
    if (Number(v.total) > umbral) {
      const cli = v.cliente_id ? (await q.query('select rtn from core.terceros where id = $1', [v.cliente_id])).rows[0] : null;
      if (!String(cli?.rtn ?? '').trim()) {
        // rtn_bloqueante=false (EcoStone, DISERCO): solo avisa y deja constancia en la bitácora; se cobra igual.
        if (cfgPos.rtn_bloqueante !== false) throw malaPeticion(`Se requiere el RTN del cliente para ventas mayores a L ${umbral.toLocaleString('es-HN')}`);
        extras.aviso_rtn = `Recordatorio: esta factura pasa de L ${umbral.toLocaleString('es-HN')} y el cliente no tiene RTN. Trata de pedirlo y agregarlo al cliente.`;
      }
    }
    if (cfgPos.exigir_tercera_edad !== false && !(v.tercera_edad_nombre && v.tercera_edad_identidad)
        && (await q.query('select 1 from pos.detalle_venta where venta_id = $1 and descuento_porcentaje = 25 limit 1', [ventaId])).rowCount) {
      throw malaPeticion('Para el descuento de tercera edad registra el nombre y la identidad de la persona');
    }
    let turno = await turnoAbierto(q, ctx, v.sucursal_id);
    if (!turno) {
      // Abrir turno NO es necesario: se abre solo (fondo 0) al primer cobro. Se puede volver a exigir con core.config 'pos'.exigir_turno = true.
      const cfg = (await q.query(`select valor from core.config where empresa_id = $1 and clave = 'pos'`, [ctx.empresa.id])).rows[0]?.valor ?? {};
      if (cfg.exigir_turno === true) throw conflicto('Abre tu turno de caja antes de cobrar');
      turno = (await q.query('insert into pos.turnos (empresa_id, sucursal_id, cajero_id, fondo_inicial) values ($1,$2,$3,0) returning *', [ctx.empresa.id, v.sucursal_id, ctx.usuario.id])).rows[0];
      await auditar(q, ctx, 'turno_abierto', 'turno', turno.id, { fondo: 0, automatico: true }, { sucursalId: v.sucursal_id });
    }
    await q.query('update pos.ventas set turno_id = $1, cajero_id = $2 where id = $3', [turno.id, ctx.usuario.id, ventaId]);
    const avisados = await antesDeCobrar(q, ctx, ventaId, { confirmarSinStock: extras.confirmarSinStock });   // fábricas: piedra sin existencia → confirmación
    const pagado = (await q.query('select * from pos.cobrar_venta($1, $2::jsonb)', [ventaId, JSON.stringify(pagos)])).rows[0];
    await auditar(q, ctx, 'venta_cobrada', 'venta', ventaId, { factura: pagado.numero_factura, total: pagado.total }, { sucursalId: v.sucursal_id });
    if (extras.aviso_rtn) await auditar(q, ctx, 'venta_sin_rtn', 'venta', ventaId, { factura: pagado.numero_factura, total: Number(pagado.total) }, { sucursalId: v.sucursal_id });
    extras.faltantes_inventario = await despuesDeCobrar(q, ctx, pagado, { faltantesAvisados: avisados });
    return pagado;
  }

  // ── Crear (y opcionalmente cobrar en el mismo paso) ──────────────────────
  // Venta SIN CONEXIÓN (b.offline): la caja ya cobró en efectivo y entregó un comprobante provisional. Aquí se le asigna el número fiscal
  // REAL (pos.cobrar_venta, con el mismo bloqueo de siempre: el correlativo nunca se repite ni se salta) y se guarda el número
  // provisional junto a la factura para poder cruzarlos. Es idempotente por `id_cliente`.
  const porIdCliente = async (q, ctx, idCliente) => {
    const f = (await q.query('select id from pos.ventas where empresa_id = $1 and id_cliente = $2', [ctx.empresa.id, idCliente])).rows[0];
    return f ? cargar(q, ctx, f.id) : null;
  };

  // La misma venta llegó otra vez: se devuelve la que ya existe. Si la caja había entregado un comprobante provisional y el servidor aún no
  // lo conocía (el cobro normal sí llegó pero la respuesta se perdió), se anota ahora para poder cruzar el comprobante con la factura.
  const respuestaDuplicada = async (ctx, previa, b) => {
    if (b?.offline?.numero_provisional && !previa.numero_provisional) {
      await db.query(`update pos.ventas set numero_provisional = $2, vendida_at = coalesce(vendida_at, $3::timestamptz), offline_info = coalesce(offline_info, $4::jsonb) where id = $1`,
        [previa.id, b.offline.numero_provisional, Number.isFinite(Date.parse(b.offline.vendida_at)) && Date.parse(b.offline.vendida_at) <= Date.now() ? new Date(Date.parse(b.offline.vendida_at)).toISOString() : null,
          JSON.stringify({ cajero_nombre: b.offline.cajero_nombre ?? null, respuesta_perdida: true })]);
      previa = await cargar(db, ctx, previa.id);
    }
    return { ...(await detalle(db, ctx, previa)), duplicado: true };
  };

  r.post('/', requierePermiso('pos:vender'), async (req, res) => {
    const b = validar(cuerpoVenta, req.body);
    if (b.offline && (!b.id_cliente || !b.cobrar)) throw malaPeticion('Una venta sin conexión llega ya cobrada y con su id_cliente');
    if (b.id_cliente) {
      const previa = await porIdCliente(db, req.ctx, b.id_cliente);
      if (previa) return res.status(200).json(await respuestaDuplicada(req.ctx, previa, b));
    }
    let out;
    try {
      out = await db.tx(async (q) => {
        const suc = await resolverSucursal(q, req.ctx, b.sucursal_id);
        const cliente = await clienteDe(q, b.cliente_id);
        const items = await armarItems(q, req.ctx, b.items);
        const tot = totalesDe(items, cliente, 0);
        const te = await datosTerceraEdad(q, req.ctx, tot, b.tercera_edad);
        let info = null;
        if (b.offline) {
          // Sin conexión solo se acepta EFECTIVO: tarjeta/transferencia necesitan validarse en el momento.
          const tipos = (await q.query('select id, tipo from pos.formas_pago where empresa_id = $1 and id = any($2::uuid[])', [req.ctx.empresa.id, b.cobrar.pagos.map((p) => p.forma_pago_id)])).rows;
          if (tipos.length !== new Set(b.cobrar.pagos.map((p) => p.forma_pago_id)).size || tipos.some((x) => x.tipo !== 'efectivo')) {
            throw malaPeticion('Una venta hecha sin conexión solo puede ser en efectivo');
          }
          const recibido = round2(b.cobrar.pagos.reduce((s, p) => s + p.monto, 0));
          if (recibido + 0.005 < tot.total) {
            throw new ErrorHttp(409, `El precio cambió mientras la caja estaba sin conexión: el total ahora es L ${tot.total.toFixed(2)} y el cliente pagó L ${recibido.toFixed(2)}. Un encargado debe resolverla.`, 'precio_cambio');
          }
          const ahora = Date.now();
          let vendida = Date.parse(b.offline.vendida_at);
          if (!Number.isFinite(vendida) || vendida > ahora) vendida = ahora;   // el reloj del equipo nunca adelanta una venta
          info = {
            vendida_at: new Date(vendida).toISOString(),
            json: { cajero_nombre: b.offline.cajero_nombre ?? null, retraso_min: Math.round((ahora - vendida) / 60000), total_cliente: b.offline.total_cliente ?? null,
              total_servidor: tot.total, diferencia: b.offline.total_cliente != null ? round2(tot.total - b.offline.total_cliente) : null, sincronizada_por: req.ctx.usuario.nombre },
          };
        }
        let v;
        if (b.orden_id) {
          const previa = await cargar(q, req.ctx, b.orden_id, { bloquear: true });
          if (previa.estado !== 'abierta' || previa.sucursal_id !== suc.id) throw conflicto('La orden que la caja había guardado ya no está abierta (otra caja la cobró o la descartó)');
          v = (await q.query(
            `update pos.ventas set cliente_id = $2, canal = $3, tipo_orden = $4, nombre_orden = $5, notas = $6, subtotal_exento = $7, subtotal_exonerado = $8,
                    subtotal_gravado_15 = $9, subtotal_gravado_18 = $10, descuento = $11, descuento_porcentaje = $12, isv_total = $13, total = $14, updated_at = now()
              where id = $1 returning *`,
            [previa.id, cliente.id, b.canal, b.tipo_orden, b.nombre_orden ?? null, b.notas ?? null, ...camposTotales(tot)])).rows[0];
        } else {
          const ticket = (await q.query('select pos.siguiente_ticket($1) as n', [suc.id])).rows[0].n;
          v = (await q.query(
            `insert into pos.ventas (empresa_id, sucursal_id, cliente_id, cajero_id, canal, tipo_orden, nombre_orden, notas, ticket_dia,
                                     subtotal_exento, subtotal_exonerado, subtotal_gravado_15, subtotal_gravado_18, descuento, descuento_porcentaje, isv_total, total)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning *`,
            [req.ctx.empresa.id, suc.id, cliente.id, req.ctx.usuario.id, b.canal, b.tipo_orden, b.nombre_orden ?? null, b.notas ?? null, ticket, ...camposTotales(tot)])).rows[0];
        }
        if (b.id_cliente) {
          await q.query('update pos.ventas set id_cliente = $2, vendida_at = $3, numero_provisional = $4, offline_info = $5::jsonb where id = $1',
            [v.id, b.id_cliente, info?.vendida_at ?? null, b.offline?.numero_provisional ?? null, info ? JSON.stringify(info.json) : null]);
        }
        await guardarLineas(q, v.id, tot);
        if (te.nombre) await q.query('update pos.ventas set tercera_edad_nombre = $2, tercera_edad_identidad = $3 where id = $1', [v.id, te.nombre, te.identidad]);
        // Lo vendido sin conexión ya salió de la tienda: si la piedra/insumo no alcanza se factura igual y queda la alerta de «sin existencia».
        const extras = { confirmarSinStock: b.confirmar_sin_stock || Boolean(b.offline) };
        if (b.cobrar) await cobrar(q, req.ctx, v.id, b.cobrar.pagos, extras);
        if (info) {
          const fin = await cargar(q, req.ctx, v.id);
          await auditar(q, req.ctx, 'venta_offline_sincronizada', 'venta', v.id,
            { factura: fin.numero_factura, provisional: b.offline.numero_provisional, ...info.json }, { sucursalId: suc.id });
        }
        return { ...(await detalle(q, req.ctx, await cargar(q, req.ctx, v.id))), ...(b.cobrar ? { aviso_rtn: extras.aviso_rtn ?? null, faltantes_inventario: extras.faltantes_inventario ?? [] } : {}) };
      });
    } catch (e) {
      // Dos envíos simultáneos de la misma venta: gana el primero y el segundo recibe esa misma factura.
      if (b.id_cliente && (e.code === '23505' || /ventas_id_cliente_uk/.test(String(e.message)))) {
        const previa = await porIdCliente(db, req.ctx, b.id_cliente);
        if (previa) return res.status(200).json(await respuestaDuplicada(req.ctx, previa, b));
      }
      throw e;
    }
    if (b.cobrar) await vigilarVenta(db, req.ctx, 'cobrada', out.id);   // antifraude: doble factura, tercera edad
    res.status(201).json(out);
  });

  // ── Editar una orden abierta ─────────────────────────────────────────────
  r.put('/:id', requierePermiso('pos:vender'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(cuerpoVenta.omit({ cobrar: true, id_cliente: true, offline: true, orden_id: true }).partial({ items: true }), req.body);
    const out = await db.tx(async (q) => {
      const v = await cargar(q, req.ctx, id, { bloquear: true });
      if (v.estado !== 'abierta') throw conflicto('Solo se pueden editar órdenes abiertas');
      const cliente = await clienteDe(q, b.cliente_id !== undefined ? b.cliente_id : v.cliente_id);   // null explícito = volver a Consumidor Final
      let tot;
      if (b.items) {
        tot = totalesDe(await armarItems(q, req.ctx, b.items), cliente, 0);
        const te = await datosTerceraEdad(q, req.ctx, tot, b.tercera_edad, { nombre: v.tercera_edad_nombre, identidad: v.tercera_edad_identidad });
        await guardarLineas(q, id, tot);
        await q.query('update pos.ventas set tercera_edad_nombre = $2, tercera_edad_identidad = $3 where id = $1', [id, te.nombre, te.identidad]);
      }
      const t = tot ? camposTotales(tot) : null;
      await q.query(
        `update pos.ventas set cliente_id = $2, canal = coalesce($3, canal), tipo_orden = coalesce($4, tipo_orden), nombre_orden = coalesce($5, nombre_orden),
                notas = coalesce($6, notas),
                subtotal_exento = coalesce($7, subtotal_exento), subtotal_exonerado = coalesce($8, subtotal_exonerado),
                subtotal_gravado_15 = coalesce($9, subtotal_gravado_15), subtotal_gravado_18 = coalesce($10, subtotal_gravado_18),
                descuento = coalesce($11, descuento), descuento_porcentaje = coalesce($12, descuento_porcentaje),
                isv_total = coalesce($13, isv_total), total = coalesce($14, total), updated_at = now()
          where id = $1`,
        [id, cliente.id, b.canal ?? null, b.tipo_orden ?? null, b.nombre_orden ?? null, b.notas ?? null, ...(t ?? Array(8).fill(null))]);
      return detalle(q, req.ctx, await cargar(q, req.ctx, id));
    });
    res.json(out);
  });

  // ── Cobrar una orden abierta ─────────────────────────────────────────────
  // `id_cliente` (opcional) marca el cobro con el id que la caja generó: si la respuesta se pierde y la caja reintenta (por la vía
  // normal o como venta sin conexión), el servidor devuelve ESTA misma factura en lugar de duplicarla.
  r.post('/:id/cobrar', requierePermiso('pos:vender'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const { pagos, confirmar_sin_stock, id_cliente } = validar(z.object({ pagos: z.array(pago).min(1, 'Falta la forma de pago'), confirmar_sin_stock: z.boolean().optional(), id_cliente: uuid.optional() }), req.body);
    if (id_cliente) {
      const previa = await porIdCliente(db, req.ctx, id_cliente);
      if (previa) return res.status(200).json({ ...(await detalle(db, req.ctx, previa)), duplicado: true });
    }
    const out = await db.tx(async (q) => {
      const extras = { confirmarSinStock: confirmar_sin_stock };
      await cobrar(q, req.ctx, id, pagos, extras);
      if (id_cliente) await q.query('update pos.ventas set id_cliente = $2 where id = $1', [id, id_cliente]);
      return { ...(await detalle(q, req.ctx, await cargar(q, req.ctx, id))), aviso_rtn: extras.aviso_rtn ?? null, faltantes_inventario: extras.faltantes_inventario ?? [] };
    });
    await vigilarVenta(db, req.ctx, 'cobrada', id);   // antifraude: doble factura, tercera edad
    res.json(out);
  });

  // ── Anular ───────────────────────────────────────────────────────────────
  r.post('/:id/anular', requierePermiso('pos:anular'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const { motivo, autorizacion } = validar(z.object({
      motivo: z.string().trim().min(3, 'Escribe el motivo de la anulación').max(300),
      autorizacion: z.object({ email: z.string().max(200), password: z.string().max(200) }).optional().nullable(),
    }), req.body);
    let out;
    try { out = await db.tx(async (q) => {
      const v = await cargar(q, req.ctx, id, { bloquear: true });
      let autorizo = null;
      if (v.estado === 'pagada') autorizo = await autorizarAnulacion(q, req, v, autorizacion);
      if (v.estado === 'abierta') {   // una orden sin cobrar simplemente se descarta
        await q.query(`update pos.ventas set estado = 'anulada', anulada_at = now(), anulada_por = $2, motivo_anulacion = $3, updated_at = now() where id = $1`, [id, req.ctx.usuario.id, motivo]);
      } else {
        await q.query('select pos.anular_venta($1,$2,$3)', [id, motivo, req.ctx.usuario.id]);
        await despuesDeAnular(q, req.ctx, v);   // fábricas: la piedra vuelve a su lote
      }
      await auditar(q, req.ctx, 'venta_anulada', 'venta', id, { motivo, factura: v.numero_factura, total: v.total, estado_previo: v.estado, ...(autorizo ? { autorizado_por: autorizo.nombre, autorizado_por_id: autorizo.id, autorizacion: autorizo.via } : {}) }, { sucursalId: v.sucursal_id });
      return detalle(q, req.ctx, await cargar(q, req.ctx, id));
    }); } catch (e) {
      // El intento fallido se anota FUERA de la transacción (que se revierte): quién intentó anular y con el correo de quién.
      if (e.intento) await auditar(db, req.ctx, 'anulacion_autorizacion_fallida', 'venta', id, { email: e.intento.email }, { sucursalId: e.intento.sucursalId });
      throw e;
    }
    if (out.numero_factura) await vigilarVenta(db, req.ctx, 'anulada', id, { motivo });   // antifraude: factura anulada
    res.json(out);
  });

  // ── Nota de crédito (devolución o ajuste parcial/total sobre una factura cobrada) ──
  r.post('/:id/nota-credito', requierePermiso('pos:anular'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(z.object({ motivo: z.string().trim().min(3, 'Escribe el motivo').max(300), monto: z.coerce.number().positive().optional() }), req.body);
    const nota = await db.tx(async (q) => {
      if (!(await usaNotasCredito(q, req.ctx.empresa.id))) throw conflicto('Las notas de crédito no están habilitadas en esta empresa. Si ya se cobró mal, anula la factura.');
      const v = await cargar(q, req.ctx, id, { bloquear: true });
      if (v.estado !== 'pagada') throw conflicto('Solo se emite nota de crédito sobre facturas cobradas y vigentes');
      const previas = Number((await q.query('select coalesce(sum(monto),0) as m from pos.notas_credito where venta_id = $1', [id])).rows[0].m);
      const monto = Math.round((b.monto ?? v.total - previas) * 100) / 100;
      if (!(monto > 0)) throw conflicto('Esta factura ya fue acreditada por completo');
      if (monto + previas > Number(v.total) + 0.001) throw malaPeticion(`El monto excede lo acreditable (máximo ${(Number(v.total) - previas).toFixed(2)})`);
      const pe = v.punto_emision_id ? (await q.query('select es_borrador from pos.puntos_emision where id = $1', [v.punto_emision_id])).rows[0] : null;
      const borrador = pe?.es_borrador ?? true;
      const n = (await q.query('select pos.siguiente_nc($1) as n', [req.ctx.empresa.id])).rows[0].n;
      const numero = `${borrador ? 'BORRADOR-' : ''}NC-${String(n).padStart(6, '0')}`;
      const nc = (await q.query(
        `insert into pos.notas_credito (empresa_id, venta_id, sucursal_id, numero_nota, motivo, monto, usuario_id, es_borrador) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [req.ctx.empresa.id, id, v.sucursal_id, numero, b.motivo, monto, req.ctx.usuario.id, borrador])).rows[0];
      await auditar(q, req.ctx, 'nota_credito_emitida', 'venta', id, { nota: numero, monto, motivo: b.motivo, factura: v.numero_factura }, { sucursalId: v.sucursal_id });
      return nc;
    });
    await vigilarVenta(db, req.ctx, 'nota_credito', id, { nota: nota.numero_nota, monto: nota.monto, motivo: b.motivo });   // antifraude
    res.status(201).json(nota);
  });

  // ── Estado de preparación (cocina) ───────────────────────────────────────
  r.put('/:id/prep', requierePermiso('kds:ver', 'pos:vender'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const { estado } = validar(z.object({ estado: z.enum(['pendiente', 'preparando', 'listo', 'entregado']) }), req.body);
    const v = await cargar(db, req.ctx, id);
    if (v.estado !== 'pagada') throw conflicto('Solo las órdenes cobradas pasan por cocina');
    await db.query(`update pos.ventas set estado_prep = $2, prep_listo_at = case when $2 = 'listo' then now() else prep_listo_at end, updated_at = now() where id = $1`, [id, estado]);
    res.json({ ok: true, estado });
  });

  // ── Lista ────────────────────────────────────────────────────────────────
  // `estado=facturadas` = cobradas + anuladas (lo que muestra Facturas). Incluye lo que ese listado necesita: cliente, RTN, ISV, pagos por forma y lo acreditado.
  r.get('/', requierePermiso('pos:vender', 'pos:reportes'), async (req, res) => {
    const f = validar(z.object({
      estado: z.enum(['abierta', 'pagada', 'anulada', 'facturadas']).optional(),
      desde: fechaISO.optional(), hasta: fechaISO.optional(),
      sucursal_id: uuid.optional(), q: z.string().trim().max(60).optional(),
      limite: z.coerce.number().int().min(1).max(500).default(100),
    }), req.query);
    const ver = req.ctx.permisos.has('pos:reportes');
    const suc = (await sucursalesPermitidas(db, req.ctx)).map((s) => s.id);
    const { rows } = await db.query(
      `select v.id, v.ticket_dia, v.numero_orden, v.numero_factura, v.estado, v.estado_prep, v.nombre_orden, v.canal, v.tipo_orden, v.total,
              v.created_at, v.fecha_emision, v.es_borrador_fiscal, v.sucursal_id, v.cajero_id, v.cliente_id, v.isv_total, v.descuento, v.cambio,
              v.motivo_anulacion, v.impresiones, v.reimpresiones, v.numero_provisional, v.vendida_at, s.nombre as sucursal, u.nombre as cajero,
              coalesce(v.cliente_nombre, t.nombre) as cliente, coalesce(v.cliente_rtn, t.rtn) as cliente_rtn, t.es_consumidor_final,
              (select count(*)::int from pos.detalle_venta d where d.venta_id = v.id) as lineas,
              (select coalesce(json_agg(json_build_object('forma', f.nombre, 'tipo', f.tipo, 'monto', p.monto) order by f.orden), '[]'::json)
                 from pos.venta_pagos p join pos.formas_pago f on f.id = p.forma_pago_id where p.venta_id = v.id) as pagos,
              (select coalesce(sum(n.monto), 0) from pos.notas_credito n where n.venta_id = v.id) as acreditado
         from pos.ventas v join core.sucursales s on s.id = v.sucursal_id left join core.usuarios u on u.id = v.cajero_id left join core.terceros t on t.id = v.cliente_id
        where v.empresa_id = $1 and v.sucursal_id = any($2::uuid[])
          and ($3::text is null or v.estado = $3 or ($3 = 'facturadas' and v.estado in ('pagada','anulada')))
          and ($4::date is null or (coalesce(v.fecha_emision, v.created_at) at time zone 'America/Tegucigalpa')::date >= $4::date)
          and ($5::date is null or (coalesce(v.fecha_emision, v.created_at) at time zone 'America/Tegucigalpa')::date <= $5::date)
          and ($6::uuid is null or v.sucursal_id = $6)
          and ($7::text is null or v.numero_factura ilike '%'||$7||'%' or v.nombre_orden ilike '%'||$7||'%' or v.numero_orden::text = $7 or v.ticket_dia::text = $7
               or coalesce(v.cliente_nombre, t.nombre) ilike '%'||$7||'%' or coalesce(v.cliente_rtn, t.rtn) like $7||'%')
          and ($8::boolean or v.cajero_id = $9 or v.estado = 'abierta')
        order by coalesce(v.fecha_emision, v.created_at) desc limit $10`,
      [req.ctx.empresa.id, suc, f.estado ?? null, f.desde ?? null, f.hasta ?? null, f.sucursal_id ?? null, f.q ?? null, ver, req.ctx.usuario.id, f.limite]);
    res.json(rows);
  });

  // Huella barata de lo que cambió en la sucursal (órdenes abiertas, cobros, anulaciones). Las pantallas la consultan cada pocos
  // segundos y solo recargan su lista cuando la huella cambia: así una orden guardada en otra caja aparece sin recargar.
  r.get('/cambios', requierePermiso('pos:vender', 'pos:reportes'), async (req, res) => {
    const f = validar(z.object({ sucursal_id: uuid.optional() }), req.query);
    const suc = (await sucursalesPermitidas(db, req.ctx)).map((s) => s.id);
    const x = (await db.query(
      `select count(*) filter (where estado = 'abierta')::int as abiertas, coalesce(sum(total) filter (where estado = 'abierta'), 0) as monto_abiertas,
              count(*)::int as recientes, coalesce(max(updated_at), 'epoch'::timestamptz) as ultimo
         from pos.ventas where empresa_id = $1 and sucursal_id = any($2::uuid[]) and ($3::uuid is null or sucursal_id = $3)
          and (estado = 'abierta' or updated_at > now() - interval '3 days')`, [req.ctx.empresa.id, suc, f.sucursal_id ?? null])).rows[0];
    res.json({ ...x, huella: `${x.abiertas}|${x.monto_abiertas}|${x.recientes}|${new Date(x.ultimo).getTime()}` });
  });

  // Ticket de prueba para configurar la impresora de cada caja (va antes de "/:id" para que "impresora" no se tome como un id).
  r.get('/impresora/prueba', requierePermiso('pos:vender', 'pos:reportes'), async (req, res) => {
    const f = validar(z.object({ columnas: z.coerce.number().refine((n) => [32, 42, 48].includes(n)).default(48), sucursal_id: uuid.optional(), formato: z.enum(['json', 'html']).default('json') }), req.query);
    const suc = f.sucursal_id ? (await sucursalesPermitidas(db, req.ctx)).find((s) => s.id === f.sucursal_id) : null;
    const lineas = formatearTicketPrueba(f.columnas, { empresa: req.ctx.empresa, sucursal: suc?.nombre ?? '' });
    if (f.formato === 'html') return res.type('text/html').send(envolverTicketHtml(lineas.join('\n'), f.columnas));
    res.json({ lineas, columnas: f.columnas });
  });

  // Eventos de uso del POS que van a la bitácora inalterable (quitar productos de una orden armada, dar descuentos, buscar facturas…).
  // Nunca bloquean la venta: el cliente los manda "y olvida".
  r.post('/evento', requierePermiso('pos:vender', 'pos:reportes'), async (req, res) => {
    const b = validar(z.object({ accion: z.string().regex(/^[a-z_]+\.[a-z_]+$/).max(40), detalle: z.record(z.any()).default({}), sucursal_id: uuid.optional().nullable() }), req.body);
    const permitidos = ['orden.quitar_producto', 'orden.descuento', 'factura.buscar', 'factura.ver', 'pantalla.abrir', 'offline.descartada', 'offline.cola_revisar'];
    if (!permitidos.includes(b.accion)) throw malaPeticion('Evento desconocido');
    const info = JSON.stringify(b.detalle).length > 2000 ? { truncado: true } : b.detalle;
    await auditar(db, req.ctx, b.accion, 'ui', null, info, { sucursalId: b.sucursal_id ?? null });
    res.status(204).end();
  });

  r.get('/:id', requierePermiso('pos:vender', 'pos:reportes'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    res.json(await detalle(db, req.ctx, await cargar(db, req.ctx, id)));
  });

  // ── Descartar una orden armada que no se cobró (cualquier cajero, siempre con motivo) ──
  // Se borra (no tiene número de factura, así que no hay correlativo que cuidar) pero queda la foto completa en la bitácora:
  // descartar una orden ya armada es la forma clásica de cobrar sin facturar. Si el monto es alto se levanta una alerta.
  r.post('/:id/descartar', requierePermiso('pos:vender'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const { motivo } = validar(z.object({ motivo: z.string().trim().min(3, 'Indica el motivo para descartar la orden').max(200) }), req.body);
    await db.tx(async (q) => {
      const v = await cargar(q, req.ctx, id, { bloquear: true });
      if (v.estado !== 'abierta') throw conflicto('Solo se pueden descartar órdenes abiertas');
      const d = await detalle(q, req.ctx, v);
      const items = d.lineas.map((l) => `${Number(l.cantidad)}× ${l.nombre_producto}${l.descuento_porcentaje ? ` (-${l.descuento_porcentaje}%)` : ''}`);
      await q.query('delete from pos.ventas where id = $1', [id]);
      await auditar(q, req.ctx, 'orden_descartada', 'venta', id, { orden: v.ticket_dia, total: Number(v.total), cliente: d.cliente?.nombre ?? 'Consumidor Final', items, motivo }, { sucursalId: v.sucursal_id });
      const cfgAf = (await q.query(`select valor from core.config where empresa_id = $1 and clave = 'antifraude'`, [req.ctx.empresa.id])).rows[0]?.valor ?? {};
      if (Number(v.total) >= (Number(cfgAf.monto_alerta_descarte) || 150)) {
        await alertar(q, req.ctx, { tipo: 'descartar_orden', severidad: Number(v.total) >= 500 ? 'alta' : 'media', sucursalId: v.sucursal_id, entidadId: id, clave: `descarte:${id}`,
          titulo: `Orden descartada de L ${Number(v.total).toFixed(2)} (${req.ctx.usuario.nombre})`, detalle: { orden: v.ticket_dia, total: Number(v.total), motivo, productos: items.join(', ') } });
      }
    });
    res.status(204).end();
  });

  /** Alerta en la bandeja del antifraude (si ese módulo está instalado). No repite la misma `clave`. */
  async function alertar(q, ctx, { tipo, severidad, titulo, detalle: det, sucursalId, entidadId, clave }) {
    if (!(await q.query(`select to_regclass('af.alertas') as t`)).rows[0].t) return;
    await q.query(
      `insert into af.alertas (empresa_id, tipo, severidad, titulo, detalle, sucursal_id, usuario_id, usuario_nombre, entidad, entidad_id, clave)
       select $1,$2,$3,$4,$5::jsonb,$6,$7,$8,'venta',$9,$10
        where not exists (select 1 from af.alertas where empresa_id = $1 and clave = $10)`,
      [ctx.empresa.id, tipo, severidad, titulo, JSON.stringify(det), sucursalId, ctx.usuario.id, ctx.usuario.nombre, String(entidadId), clave]);
  }

  // ── Ticket térmico ────────────────────────────────────────────────────────
  // La PRIMERA impresión de una factura sale como original; toda otra (aunque la pidan como "primera") sale marcada COPIA #n:
  // así una factura reimpresa no se puede entregar como original a otro cliente. Cada impresión queda en la bitácora.
  r.get('/:id/ticket', requierePermiso('pos:vender', 'pos:reportes'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const f = validar(z.object({
      columnas: z.coerce.number().refine((n) => [32, 42, 48].includes(n)).default(42),
      reimpresion: z.string().optional(), motivo: z.string().optional(), razon: z.string().trim().max(200).optional(),
      formato: z.enum(['json', 'html', 'texto']).default('json'),
    }), req.query);
    const pideCopia = ['true', '1'].includes(f.reimpresion ?? '') || f.motivo === 'reimpresion';
    const out = await db.tx(async (q) => {
      const v = await cargar(q, req.ctx, id, { bloquear: true });
      const esFactura = v.estado === 'pagada' || (v.estado === 'anulada' && v.numero_factura);
      const esCopia = Boolean(esFactura && (pideCopia || v.impresiones > 0));
      if (esCopia && !req.ctx.permisos.has('pos:reimprimir')) throw prohibido('No tienes permiso para reimprimir');
      if (f.motivo === 'reimpresion' && !f.razon) {
        const cfg = (await q.query(`select valor from core.config where empresa_id = $1 and clave = 'pos'`, [req.ctx.empresa.id])).rows[0]?.valor ?? {};
        if (cfg.exigir_motivo_reimpresion !== false) throw malaPeticion('Indica el motivo de la reimpresión');
      }
      let copia = 0;
      if (esFactura) {
        const n = (await q.query(
          `update pos.ventas set impresiones = impresiones + 1, reimpresiones = reimpresiones + $2, ultima_impresion_at = now() where id = $1 returning reimpresiones`,
          [id, esCopia ? 1 : 0])).rows[0];
        copia = esCopia ? n.reimpresiones : 0;
      }
      const d = await detalle(q, req.ctx, await cargar(q, req.ctx, id));
      if (esFactura) {
        await auditar(q, req.ctx, esCopia ? 'factura_reimpresa' : 'factura_impresa', 'venta', id,
          { factura: d.numero_factura, total: Number(d.total), reimpresion_no: copia, motivo: f.razon || null }, { sucursalId: d.sucursal_id });
        if (esCopia && copia >= 2) {
          await alertar(q, req.ctx, { tipo: 'reimpresion_repetida', severidad: copia >= 3 ? 'alta' : 'media', sucursalId: d.sucursal_id, entidadId: id, clave: `reimp:${id}:${copia}`,
            titulo: `Factura ${d.numero_factura} reimpresa ${copia} veces`, detalle: { factura: d.numero_factura, total: Number(d.total), reimpresiones: copia, ultimo_motivo: f.razon || '(sin motivo)', por: req.ctx.usuario.nombre } });
        }
      }
      return { d, copia };
    });
    const { d, copia } = out;
    const lineas = formatearTicket({ empresa: req.ctx.empresa, sucursal: d.sucursal, venta: d, lineas: d.lineas, pagos: d.pagos, punto: d.punto, cliente: d.cliente, cajero: d.cajero }, f.columnas, { copia });
    if (f.formato === 'html') return res.type('text/html').send(envolverTicketHtml(lineas.join('\n'), f.columnas));
    if (f.formato === 'texto') return res.type('text/plain').send(lineas.join('\n'));
    res.json({ lineas, copia });
  });

  // ── Factura completa tamaño carta (ver / descargar PDF) ────────────────────
  r.get('/:id/pdf', requierePermiso('pos:vender', 'pos:reportes'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const v = await cargar(db, req.ctx, id);
    if (v.estado === 'abierta') throw conflicto('La orden todavía no tiene factura');
    const d = await detalle(db, req.ctx, v);
    await auditar(db, req.ctx, 'factura_pdf', 'venta', id, { factura: d.numero_factura }, { sucursalId: d.sucursal_id });
    const pdf = generarPdfFactura({ empresa: req.ctx.empresa, sucursal: d.sucursal, venta: d, lineas: d.lineas, pagos: d.pagos, punto: d.punto, cliente: d.cliente, cajero: d.cajero },
      { logo: cargarLogo(req.ctx.empresa.codigo, config?.webDist) });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="factura-${String(d.numero_factura ?? d.ticket_dia).replace(/[^\w.-]/g, '_')}.pdf"`);
    res.send(pdf);
  });

  // ── Enviar la factura (PDF adjunto) por correo al cliente: el correo es editable; queda en la bitácora ──
  r.post('/:id/correo', requierePermiso('pos:vender', 'pos:reportes'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(z.object({ email: z.string().trim().max(160).optional(), mensaje: z.string().trim().max(500).optional() }), req.body ?? {});
    const v = await cargar(db, req.ctx, id);
    if (v.estado === 'abierta') throw conflicto('La orden todavía no tiene factura');
    if (v.estado !== 'pagada') throw conflicto('Esa factura está anulada: no se envía por correo');
    const d = await detalle(db, req.ctx, v);
    res.json(await enviarFacturaPorCorreo({ q: db, ctx: req.ctx, d, destino: b.email || d.cliente?.correo, mensaje: b.mensaje }));
  });

  return r;
}
