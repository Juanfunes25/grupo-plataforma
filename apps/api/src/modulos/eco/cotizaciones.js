// Cotizaciones de proyecto de EcoStone: m² → cajas completas, accesorios, flete, ISV incluido o separado según la lista,
// descuento %, aprobación (reserva de piedra / orden de producción), cobro (anticipo o pago) y factura con CAI.
import { Router } from 'express';
import { z } from 'zod';
import { UMBRAL_RTN_OBLIGATORIO, fechaHN, sumarDias } from '@grupo/shared';
import { requierePermiso, resolverSucursal, sucursalesPermitidas } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { ErrorHttp, conflicto, malaPeticion, noEncontrado, prohibido, uuid, validar } from '../../lib/http.js';
import { calcularAnticipo, calcularCotizacion, dimensionarLinea, round2 } from './calculo.js';
import { parametros } from './catalogo.js';
import { antesDeCobrar, configPos, despuesDeCobrar, liberarCotizacion, reservarCotizacion } from './existencias.js';

const TIPOS_LINEA = ['producto', 'accesorio', 'flete', 'instalacion', 'otro'];
const ABIERTAS = ['borrador', 'enviada'];
const num = (v, d = 0) => (v === '' || v === undefined || v === null || !Number.isFinite(Number(v)) ? d : Number(v));

export const CONDICIONES = [
  'Precios en Lempiras.',
  'Cotización válida por 15 días a partir de su emisión.',
  'Aceptamos efectivo, tarjeta y transferencia.',
];

const linea = z.object({
  tipo: z.enum(TIPOS_LINEA).default('producto'),
  producto_id: uuid.optional().nullable().or(z.literal('').transform(() => null)),
  descripcion: z.string().trim().max(200).optional().nullable(),
  unidad: z.string().trim().max(20).optional().nullable(),
  m2_neto: z.any().optional(), desperdicio_pct: z.any().optional(), cantidad: z.any().optional(),
  precio_unitario: z.any().optional(), descuento_pct: z.any().optional(), costo_unitario: z.any().optional(),
});
const esquema = z.object({
  cliente_id: uuid.optional().nullable().or(z.literal('').transform(() => null)),
  nombre_cliente: z.string().trim().max(160).optional().nullable(),
  rtn_cliente: z.string().trim().max(20).optional().nullable(),
  telefono: z.string().trim().max(40).optional().nullable(),
  email: z.string().trim().max(120).optional().nullable(),
  tipo_cliente: z.enum(['final', 'constructora', 'arquitecto', 'instalador', 'ferreteria', 'distribuidor']).optional(),
  proyecto: z.string().trim().max(160).optional().nullable(),
  direccion_obra: z.string().trim().max(250).optional().nullable(),
  lista_precio_id: uuid.optional().nullable().or(z.literal('').transform(() => null)),
  vigencia_dias: z.any().optional(), descuento_pct: z.any().optional(), anticipo_pct: z.any().optional(),
  entrega: z.enum(['retira', 'despacho']).default('retira'),
  fecha_entrega: z.string().trim().max(10).optional().nullable(),
  notas: z.string().trim().max(1000).optional().nullable(),
  lineas: z.array(linea).max(80),
});

export function rutasCotizacionesEco({ db }) {
  const r = Router();
  const vende = requierePermiso('cotizaciones:ver');
  const cobra = requierePermiso('pos:vender', 'cotizaciones:ver');

  // Tope de descuento según el rol: Ventas el del vendedor, Manager el del gerente, Administrador/Dueño sin tope.
  const topeDe = (ctx, p) => (['dueno', 'admin'].includes(ctx.rol) ? 100 : ctx.rol === 'gerente' ? num(p.descuento_max_gerente_pct, 15) : num(p.descuento_max_vendedor_pct, 5));
  const esVendedor = (ctx) => !['dueno', 'admin', 'gerente'].includes(ctx.rol);
  const gerencia = (ctx) => ctx.permisos.has('pos:catalogo');

  async function cargar(q, ctx, id) {
    const c = (await q.query(
      `select c.*, v.numero_factura, v.estado as venta_estado, u.nombre as vendedor, t.exento_impuestos, x.tipo_cliente,
              l.nombre as lista_nombre
         from eco.cotizaciones c left join pos.ventas v on v.id = c.venta_id left join core.usuarios u on u.id = c.vendedor_id
         left join core.terceros t on t.id = c.cliente_id left join eco.cliente_ext x on x.tercero_id = c.cliente_id
         left join eco.listas_precio l on l.id = c.lista_precio_id
        where c.id = $1 and c.empresa_id = $2`, [id, ctx.empresa.id])).rows[0];
    if (!c) return null;
    const [lineas, pagos] = await Promise.all([
      q.query(`select l.*, p.nombre as producto_nombre, p.unidad_venta as producto_unidad, p.m2_por_caja from eco.cotizacion_lineas l left join pos.productos p on p.id = l.producto_id where l.cotizacion_id = $1 order by l.orden`, [id]),
      q.query(`select p.*, f.nombre as forma, u.nombre as usuario from eco.cotizacion_pagos p join pos.formas_pago f on f.id = p.forma_pago_id left join core.usuarios u on u.id = p.usuario_id where p.cotizacion_id = $1 order by p.created_at`, [id]),
    ]);
    const pagado = round2(pagos.rows.reduce((s, p) => s + Number(p.monto), 0));
    const total = Number(c.total);
    const { anticipo, saldo } = calcularAnticipo(total, c.anticipo_pct);
    const venc = ABIERTAS.includes(c.estado) && c.fecha_vigencia && String(c.fecha_vigencia).slice(0, 10) < fechaHN();
    return { ...c, fecha_vigencia: c.fecha_vigencia ? String(c.fecha_vigencia).slice(0, 10) : null, fecha_entrega: c.fecha_entrega ? String(c.fecha_entrega).slice(0, 10) : null,
      lineas: lineas.rows, pagos: pagos.rows, pagado, pendiente: round2(total - pagado), vencida: Boolean(venc), anticipo_monto: anticipo, saldo_monto: saldo,
      venta: c.venta_id ? { numero_factura: c.numero_factura, estado: c.venta_estado } : null };
  }

  async function resolverCliente(q, ctx, b) {
    if (b.cliente_id) {
      const c = (await q.query('select * from core.terceros where id = $1 and activo', [b.cliente_id])).rows[0];
      if (c) return c;
    }
    const rtn = String(b.rtn_cliente ?? '').replace(/[-\s]/g, '');
    if (rtn && !/^\d{13,14}$/.test(rtn)) throw malaPeticion('El RTN debe tener 13 o 14 dígitos');
    if (rtn) {
      const c = (await q.query('select * from core.terceros where rtn = $1 and activo', [rtn])).rows[0];
      if (c) return c;
    }
    const nombre = String(b.nombre_cliente ?? '').trim();
    if (!nombre) throw malaPeticion('Indica el nombre del cliente');
    const c = (await q.query(
      `insert into core.terceros (nombre, rtn, telefono, correo, direccion, es_cliente, created_by) values ($1,$2,$3,$4,$5,true,$6) returning *`,
      [nombre, rtn || null, b.telefono || null, b.email || null, b.direccion_obra || null, ctx.usuario.id])).rows[0];
    await auditar(q, ctx, 'tercero_creado', 'tercero', c.id, { nombre, origen: 'cotizacion_eco' });
    return c;
  }

  async function armarLineas(q, ctx, lineasIn, { lista, params }) {
    if (!lineasIn.length) throw malaPeticion('La cotización necesita al menos una línea');
    const ids = [...new Set(lineasIn.map((l) => l.producto_id).filter(Boolean))];
    const prods = new Map((ids.length ? (await q.query(
      `select p.*, x.tipo as tipo_eco from pos.productos p left join eco.producto_ext x on x.producto_id = p.id where p.empresa_id = $1 and p.id = any($2::uuid[])`, [ctx.empresa.id, ids])).rows : []).map((p) => [p.id, p]));
    const precios = new Map((ids.length && lista ? (await q.query('select producto_id, precio from eco.precios_producto where lista_id = $1 and producto_id = any($2::uuid[])', [lista.id, ids])).rows : []).map((p) => [p.producto_id, Number(p.precio)]));
    const tope = topeDe(ctx, params);
    const bajoLista = [];
    const out = lineasIn.map((l, i) => {
      const tipo = l.tipo;
      const desc = num(l.descuento_pct);
      if (desc < 0 || desc > 100) throw malaPeticion(`Descuento inválido en la línea ${i + 1}`);
      if (desc > tope) throw prohibido(`El descuento de ${desc}% (línea ${i + 1}) supera tu tope de ${tope}%. Pide a un gerente que lo autorice.`);
      const base = { orden: i, tipo, descuento_pct: desc };
      if (tipo === 'producto' || tipo === 'accesorio') {
        const p = prods.get(l.producto_id);
        if (!p) throw malaPeticion(`Producto no encontrado en la línea ${i + 1}`);
        const m2 = num(l.m2_neto);
        if (m2 > 0 && !Number.isInteger(m2)) throw malaPeticion(`Los m² de la línea ${i + 1} deben ser un número entero`);
        const dim = tipo === 'producto' && m2 > 0 ? dimensionarLinea(p, m2, num(l.desperdicio_pct)) : null;
        const cantidad = dim ? dim.cantidad : num(l.cantidad);
        if (!(cantidad > 0)) throw malaPeticion(`Indica la cantidad en la línea ${i + 1}`);
        if (!Number.isInteger(cantidad)) throw malaPeticion(`La cantidad de la línea ${i + 1} debe ser un número entero (no se vende media caja)`);
        const factor = dim?.factor_precio ?? 1;
        // El precio del catálogo es el de la lista Público (con ISV). En una lista sin ISV sin precio propio se quita el ISV (no se cobra doble).
        const tasa = Number(p.impuesto_tasa ?? 0.15);
        const listaM2 = precios.get(p.id) ?? (lista && !lista.isv_incluido ? round2(Number(p.precio) / (1 + tasa)) : Number(p.precio));
        const listaP = round2(listaM2 * factor);
        const precio = l.precio_unitario === undefined || l.precio_unitario === '' || l.precio_unitario === null ? listaP : num(l.precio_unitario, listaP);
        if (precio < listaP * 0.995) {
          if (esVendedor(ctx)) throw prohibido(`El precio de ${p.nombre} (L ${precio}) está por debajo de la lista (L ${listaP}). Requiere autorización de gerente.`);
          bajoLista.push({ producto: p.nombre, lista: listaP, precio });
        }
        const costoBase = Number(p.costo_estandar || 0);
        return { ...base, producto_id: p.id, descripcion: p.nombre, unidad: dim?.unidad_linea ?? p.unidad_venta ?? 'unidad', m2_neto: dim ? m2 : null, desperdicio_pct: dim ? num(l.desperdicio_pct) : 0,
          cajas: dim?.cajas ?? null, cantidad, precio_unitario: precio, isv_tasa: tasa, costo_unitario: p.unidad_venta === 'caja' ? costoBase * Number(p.m2_por_caja || 0) : costoBase * factor };
      }
      const cantidad = num(l.cantidad);
      if (!String(l.descripcion ?? '').trim() || !(cantidad > 0) || num(l.precio_unitario, -1) < 0) throw malaPeticion(`Completa descripción, cantidad y precio de la línea ${i + 1}`);
      if (!Number.isInteger(cantidad)) throw malaPeticion(`La cantidad de la línea ${i + 1} debe ser un número entero`);
      return { ...base, producto_id: null, descripcion: String(l.descripcion).trim(), unidad: l.unidad || (tipo === 'instalacion' ? 'm2' : 'viaje'), m2_neto: null, desperdicio_pct: 0, cajas: null,
        cantidad, precio_unitario: num(l.precio_unitario), isv_tasa: 0.15, costo_unitario: num(l.costo_unitario) };
    });
    return { lineas: out, bajoLista, tope };
  }

  async function sucursalDe(q, ctx) {
    const lista = await sucursalesPermitidas(q, ctx);
    if (!lista.length) throw malaPeticion('La empresa no tiene sucursales activas');
    return lista[0];
  }

  async function guardar(q, ctx, id, b) {
    const params = await parametros(q, ctx.empresa.id);
    let previa = null;
    if (id) {
      previa = await cargar(q, ctx, id);
      if (!previa) throw noEncontrado('Cotización no encontrada');
      if (!ABIERTAS.includes(previa.estado)) throw conflicto(`Una cotización ${previa.estado} ya no se puede editar`);
    }
    const cliente = await resolverCliente(q, ctx, b);
    if (b.tipo_cliente) {
      await q.query(`insert into eco.cliente_ext (tercero_id, tipo_cliente) values ($1,$2) on conflict (tercero_id) do update set tipo_cliente = excluded.tipo_cliente`, [cliente.id, b.tipo_cliente]);
    }
    if (b.lista_precio_id) {
      await q.query(`insert into eco.cliente_ext (tercero_id, lista_precio_id) values ($1,$2) on conflict (tercero_id) do update set lista_precio_id = excluded.lista_precio_id`, [cliente.id, b.lista_precio_id]);
    }
    const ext = (await q.query('select * from eco.cliente_ext where tercero_id = $1', [cliente.id])).rows[0];
    const listaId = b.lista_precio_id || ext?.lista_precio_id || null;
    const lista = listaId
      ? (await q.query('select * from eco.listas_precio where id = $1 and empresa_id = $2', [listaId, ctx.empresa.id])).rows[0]
      : (await q.query(`select * from eco.listas_precio where empresa_id = $1 and activo order by orden limit 1`, [ctx.empresa.id])).rows[0];
    const isvIncluido = lista?.isv_incluido ?? true;

    const { lineas, bajoLista, tope } = await armarLineas(q, ctx, b.lineas, { lista, params });
    const descPct = Math.min(100, Math.max(0, num(b.descuento_pct)));
    const calc = calcularCotizacion(lineas, { isv_incluido: isvIncluido, descuento_pct: descPct, cliente_exento: Boolean(cliente.exento_impuestos) });
    if (esVendedor(ctx) && calc.descuento_pct > tope) throw prohibido(`El descuento total (${calc.descuento_pct}%) supera tu tope de ${tope}%. Pide autorización a un gerente.`);
    const anticipoPct = num(b.anticipo_pct, num(params.anticipo_pct_default, 0));
    if (anticipoPct < 0 || anticipoPct > 100) throw malaPeticion('El anticipo debe estar entre 0 y 100%');
    const vigencia = Math.max(1, Math.round(num(b.vigencia_dias, num(params.vigencia_cotizacion_dias, 15))));
    const suc = previa?.sucursal_id ?? (await sucursalDe(q, ctx)).id;
    const vals = [cliente.id, cliente.nombre, cliente.rtn ?? null, b.telefono || cliente.telefono || null, b.email || cliente.correo || null, String(b.proyecto ?? '').trim(), b.direccion_obra || null,
      lista?.id ?? null, isvIncluido, vigencia, sumarDias(fechaHN(), vigencia), calc.descuento_global, descPct, calc.subtotal, calc.isv, calc.total, anticipoPct,
      b.entrega, b.fecha_entrega || null, b.notas || null, suc];
    let cot;
    if (id) {
      cot = (await q.query(
        `update eco.cotizaciones set cliente_id=$2,nombre_cliente=$3,rtn_cliente=$4,telefono=$5,email=$6,proyecto=$7,direccion_obra=$8,lista_precio_id=$9,isv_incluido=$10,vigencia_dias=$11,fecha_vigencia=$12,
                descuento=$13,descuento_pct=$14,subtotal=$15,isv=$16,total=$17,anticipo_pct=$18,entrega=$19,fecha_entrega=$20,notas=$21,sucursal_id=$22,updated_at=now() where id=$1 returning *`, [id, ...vals])).rows[0];
      await q.query('delete from eco.cotizacion_lineas where cotizacion_id = $1', [id]);
    } else {
      const numero = (await q.query('select eco.siguiente_numero($1) as n', [ctx.empresa.id])).rows[0].n;
      cot = (await q.query(
        `insert into eco.cotizaciones (empresa_id,numero,vendedor_id,cliente_id,nombre_cliente,rtn_cliente,telefono,email,proyecto,direccion_obra,lista_precio_id,isv_incluido,vigencia_dias,fecha_vigencia,
                descuento,descuento_pct,subtotal,isv,total,anticipo_pct,entrega,fecha_entrega,notas,sucursal_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) returning *`, [ctx.empresa.id, numero, ctx.usuario.id, ...vals])).rows[0];
    }
    for (const [i, l] of lineas.entries()) {
      await q.query(
        `insert into eco.cotizacion_lineas (cotizacion_id,orden,tipo,producto_id,descripcion,unidad,m2_neto,desperdicio_pct,cajas,cantidad,precio_unitario,descuento_pct,isv_tasa,monto,costo_unitario)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [cot.id, i, l.tipo, l.producto_id, l.descripcion, l.unidad, l.m2_neto, l.desperdicio_pct, l.cajas, l.cantidad, l.precio_unitario, l.descuento_pct, l.isv_tasa, calc.lineas[i].monto, l.costo_unitario]);
    }
    await auditar(q, ctx, id ? 'cotizacion_editada' : 'cotizacion_creada', 'cotizacion', cot.id, { numero: Number(cot.numero), cliente: cot.nombre_cliente, proyecto: cot.proyecto, total: calc.total, descuento_pct: calc.descuento_pct }, { sucursalId: suc });
    if (bajoLista.length) await auditar(q, ctx, 'cotizacion_precio_bajo_lista', 'cotizacion', cot.id, { numero: Number(cot.numero), productos: bajoLista, por: ctx.usuario.nombre }, { sucursalId: suc });
    const out = await cargar(q, ctx, cot.id);
    return gerencia(ctx) ? { ...out, margen: calc.margen, margen_pct: calc.margen_pct } : out;
  }

  r.use((req, _res, next) => {
    if (!req.ctx.empresa.modulos.includes('fabrica')) throw prohibido(`${req.ctx.empresa.nombre} no usa cotizaciones de piedra`);
    next();
  });

  // ── Lista ────────────────────────────────────────────────────────────────
  r.get('/', vende, async (req, res) => {
    const f = validar(z.object({ estado: z.string().max(80).optional(), q: z.string().trim().max(60).optional() }), req.query);
    const estados = f.estado ? f.estado.split(',') : null;
    const { rows } = await db.query(
      `select c.id, c.numero, c.estado, c.nombre_cliente, c.proyecto, c.total, c.fecha_vigencia::text as fecha_vigencia, c.fecha_entrega::text as fecha_entrega, c.created_at, c.vendedor_id, c.venta_id, v.numero_factura,
              coalesce((select sum(p.monto) from eco.cotizacion_pagos p where p.cotizacion_id = c.id), 0)::numeric as pagado
         from eco.cotizaciones c left join pos.ventas v on v.id = c.venta_id
        where c.empresa_id = $1 and ($2::text[] is null or c.estado = any($2::text[])) and ($3::text is null or c.nombre_cliente ilike '%'||$3||'%' or c.proyecto ilike '%'||$3||'%')
        order by c.created_at desc limit 300`, [req.ctx.empresa.id, estados, f.q || null]);
    const hoy = fechaHN();
    res.json(rows.map((c) => ({ ...c, total: Number(c.total), pagado: Number(c.pagado), venta: c.numero_factura ? { numero_factura: c.numero_factura } : null,
      vencida: ABIERTAS.includes(c.estado) && c.fecha_vigencia && c.fecha_vigencia < hoy })));
  });

  r.get('/:id', vende, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const c = await cargar(db, req.ctx, id);
    if (!c) throw noEncontrado('Cotización no encontrada');
    const [ordenes, reservas] = await Promise.all([
      db.query(`select o.id, o.lote, o.estado, o.m2_planificado, o.fecha_programada::text, o.fecha_disponible::text, p.nombre as producto from fab.ordenes o join pos.productos p on p.id = o.producto_id
                 where o.empresa_id = $1 and o.cotizacion_id = $2 and o.estado <> 'cancelada'`, [req.ctx.empresa.id, id]),
      db.query(`select p.nombre as producto, l.codigo as lote, r.cantidad as m2 from fab.reservas r join fab.lotes l on l.id = r.lote_id join pos.productos p on p.id = r.producto_id where r.empresa_id = $1 and r.ref_id = $2`, [req.ctx.empresa.id, id]),
    ]);
    const ver = gerencia(req.ctx);
    const costo = round2(c.lineas.reduce((s, l) => s + Number(l.costo_unitario) * Number(l.cantidad), 0));
    res.json({ ...c, ordenes: ordenes.rows, reservas: reservas.rows.map((x) => ({ ...x, m2: Number(x.m2) })),
      costo: ver ? costo : undefined, margen_pct: ver && Number(c.subtotal) > 0 ? round2(((Number(c.subtotal) - costo) / Number(c.subtotal)) * 100) : undefined });
  });

  r.post('/', vende, async (req, res) => res.status(201).json(await db.tx((q) => guardar(q, req.ctx, null, validar(esquema, req.body)))));
  r.put('/:id', vende, async (req, res) => res.json(await db.tx((q) => guardar(q, req.ctx, validar(uuid, req.params.id), validar(esquema, req.body)))));

  // ── Documento imprimible (el navegador lo imprime o lo guarda como PDF) ──
  r.get('/:id/documento', vende, async (req, res) => {
    const c = await cargar(db, req.ctx, validar(uuid, req.params.id));
    if (!c) throw noEncontrado('Cotización no encontrada');
    const calc = calcularCotizacion(c.lineas, { isv_incluido: c.isv_incluido, descuento: Number(c.descuento || 0), descuento_pct: Number(c.descuento_pct || 0), cliente_exento: Boolean(c.exento_impuestos) });
    const e = req.ctx.empresa;
    res.json({ cotizacion: c, calculo: calc, condiciones: [CONDICIONES[0], `Cotización válida por ${c.vigencia_dias} días a partir de su emisión.`, CONDICIONES[2]],
      empresa: { nombre: e.nombre, razon_social: e.razon_social, rtn: e.rtn, direccion: e.direccion, ciudad: e.ciudad, telefono: e.telefono, correo: e.correo, web: e.web } });
  });

  // ── Correo: el servidor aún no tiene servicio de correo; se responde claro y la pantalla ofrece «Abrir en mi correo» ──
  r.post('/:id/enviar', vende, async (req, res) => {
    const b = validar(z.object({ email: z.string().trim().max(120).optional(), solo_marcar: z.boolean().optional() }), req.body ?? {});
    const out = await db.tx(async (q) => {
      const c = await cargar(q, req.ctx, validar(uuid, req.params.id));
      if (!c) throw noEncontrado('Cotización no encontrada');
      if (!ABIERTAS.includes(c.estado)) throw conflicto(`La cotización está ${c.estado}`);
      const destino = b.email || c.email;
      if (b.solo_marcar) {
        await q.query(`update eco.cotizaciones set estado = 'enviada', updated_at = now() where id = $1`, [c.id]);
        await auditar(q, req.ctx, 'cotizacion_enviada', 'cotizacion', c.id, { numero: Number(c.numero), destino: destino ?? null, enviado: false, manual: true });
        return { enviado: false, marcada: true };
      }
      return { enviado: false, motivo: destino ? 'El envío automático por correo está pendiente de configurar en el servidor' : 'El cliente no tiene correo registrado', destino: destino ?? null };
    });
    res.json(out);
  });

  // ── Aprobación del cliente: reserva existencias y genera producción por lo que falte ──
  r.post('/:id/aprobar', vende, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const out = await db.tx(async (q) => {
      const c = await cargar(q, req.ctx, id);
      if (!c) throw noEncontrado('Cotización no encontrada');
      if (!ABIERTAS.includes(c.estado)) throw conflicto(`La cotización ya está ${c.estado}`);
      if (c.vencida) throw conflicto('La cotización está vencida: edítala y guárdala para renovar la vigencia y los precios');
      if (c.entrega === 'despacho' && !c.fecha_entrega) throw malaPeticion('Indica la fecha de entrega comprometida antes de aprobar');
      await q.query(`update eco.cotizaciones set estado='aprobada', aprobada_at=now(), aprobada_por=$2, updated_at=now() where id=$1`, [id, req.ctx.usuario.id]);
      const plan = await reservarCotizacion(q, req.ctx, c, c.lineas);
      await auditar(q, req.ctx, 'cotizacion_aprobada', 'cotizacion', id, { numero: Number(c.numero), total: Number(c.total), reservado: plan.reservado, ordenes: plan.ordenes, pendientes: plan.pendientes });
      return { cotizacion: await cargar(q, req.ctx, id), plan };
    });
    res.json(out);
  });

  r.post('/:id/rechazar', vende, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const { motivo } = validar(z.object({ motivo: z.string().trim().min(1, 'Indica el motivo').max(300) }), req.body);
    await db.tx(async (q) => {
      const c = await cargar(q, req.ctx, id);
      if (!c) throw noEncontrado('Cotización no encontrada');
      if (!ABIERTAS.includes(c.estado)) throw conflicto(`La cotización ya está ${c.estado}`);
      await q.query(`update eco.cotizaciones set estado='rechazada', motivo_cierre=$2, updated_at=now() where id=$1`, [id, motivo]);
      await auditar(q, req.ctx, 'cotizacion_rechazada', 'cotizacion', id, { numero: Number(c.numero), motivo });
    });
    res.json({ ok: true });
  });

  // Anulación de una cotización aprobada aún sin facturar (gerencia).
  r.post('/:id/anular', requierePermiso('pos:anular'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const { motivo } = validar(z.object({ motivo: z.string().trim().min(1, 'Indica el motivo de la anulación').max(300) }), req.body);
    await db.tx(async (q) => {
      const c = await cargar(q, req.ctx, id);
      if (!c) throw noEncontrado('Cotización no encontrada');
      if (c.estado === 'facturada') throw conflicto('Ya está facturada: la factura solo se puede anular desde Facturas');
      if (c.pagado > 0) throw conflicto(`Ya tiene L ${c.pagado.toFixed(2)} cobrados: devuelve o aplica el pago antes de anular`);
      const liberado = await liberarCotizacion(q, req.ctx, c);
      await q.query(`update eco.cotizaciones set estado='anulada', motivo_cierre=$2, updated_at=now() where id=$1`, [id, motivo]);
      await auditar(q, req.ctx, 'cotizacion_anulada', 'cotizacion', id, { numero: Number(c.numero), motivo, estado_anterior: c.estado, liberado });
    });
    res.json({ ok: true });
  });

  // ── Cobro (anticipo o pago) contra una cotización aprobada ──
  r.post('/:id/pagos', cobra, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(z.object({ forma_pago_id: uuid, monto: z.coerce.number().positive('El monto debe ser mayor que 0'), referencia: z.string().trim().max(60).optional().nullable() }), req.body);
    const out = await db.tx(async (q) => {
      const c = await cargar(q, req.ctx, id);
      if (!c) throw noEncontrado('Cotización no encontrada');
      if (c.estado !== 'aprobada') throw conflicto('Solo se cobra una cotización aprobada (y aún no facturada)');
      const monto = round2(b.monto);
      if (monto > c.pendiente + 0.004) throw malaPeticion(`El monto supera el saldo pendiente (L ${c.pendiente.toFixed(2)})`);
      const fp = (await q.query('select id, nombre from pos.formas_pago where id = $1 and empresa_id = $2 and activo', [b.forma_pago_id, req.ctx.empresa.id])).rows[0];
      if (!fp) throw malaPeticion('Forma de pago inválida');
      const tipo = c.pagado === 0 && Number(c.anticipo_pct) > 0 && monto < Number(c.total) ? 'anticipo' : 'pago';
      const p = (await q.query('insert into eco.cotizacion_pagos (cotizacion_id,tipo,forma_pago_id,monto,referencia,usuario_id) values ($1,$2,$3,$4,$5,$6) returning *',
        [id, tipo, fp.id, monto, b.referencia || null, req.ctx.usuario.id])).rows[0];
      await auditar(q, req.ctx, 'cotizacion_pago', 'cotizacion', id, { numero: Number(c.numero), tipo, forma: fp.nombre, monto, referencia: b.referencia ?? null, pendiente_despues: round2(c.pendiente - monto) }, { sucursalId: c.sucursal_id });
      return { pago: p, cotizacion: await cargar(q, req.ctx, id) };
    });
    res.status(201).json(out);
  });

  // ── Factura: aprobada + pagada → factura con correlativo del CAI ──
  r.post('/:id/facturar', cobra, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(z.object({ confirmar_sin_stock: z.boolean().optional() }), req.body ?? {});
    const out = await db.tx(async (q) => {
      await q.query('select 1 from eco.cotizaciones where id = $1 and empresa_id = $2 for update', [id, req.ctx.empresa.id]);
      const c = await cargar(q, req.ctx, id);
      if (!c) throw noEncontrado('Cotización no encontrada');
      if (c.estado === 'facturada') throw conflicto('Esta cotización ya fue facturada');
      if (c.estado !== 'aprobada') throw conflicto('Solo se factura una cotización aprobada');
      if (c.pendiente > 0.004) throw conflicto(`Falta cobrar L ${c.pendiente.toFixed(2)} para poder facturar`);
      if (!c.pagos.length) throw conflicto('Registra el pago antes de facturar');
      const cliente = (await q.query('select * from core.terceros where id = $1', [c.cliente_id])).rows[0];
      const calc = calcularCotizacion(c.lineas, { isv_incluido: c.isv_incluido, descuento: Number(c.descuento || 0), descuento_pct: Number(c.descuento_pct || 0), cliente_exento: Boolean(cliente?.exento_impuestos) });
      if (calc.total !== Number(c.total)) throw conflicto('Los precios cambiaron desde que se cotizó; guarda la cotización de nuevo antes de facturar');

      const cfg = await configPos(q, req.ctx.empresa.id);
      const umbral = Number(cfg.umbral_rtn) > 0 ? Number(cfg.umbral_rtn) : UMBRAL_RTN_OBLIGATORIO;
      const sinRtnAlto = calc.total > umbral && !String(cliente?.rtn ?? '').trim();
      if (sinRtnAlto && cfg.rtn_bloqueante !== false) throw malaPeticion(`Se requiere el RTN del cliente para ventas mayores a L ${umbral.toLocaleString('es-HN')}`);

      const suc = await resolverSucursal(q, req.ctx, c.sucursal_id ?? undefined);

      let exento = 0, exonerado = 0, g15 = 0, g18 = 0;
      calc.lineas.forEach((l) => {
        if (l.isv_tasa === 0.15) g15 += l.base; else if (l.isv_tasa === 0.18) g18 += l.base;
        else if (cliente?.exento_impuestos) exento += l.base; else exonerado += l.base;
      });
      const ticket = (await q.query('select pos.siguiente_ticket($1) as n', [suc.id])).rows[0].n;
      const venta = (await q.query(
        `insert into pos.ventas (empresa_id, sucursal_id, cliente_id, cajero_id, canal, tipo_orden, nombre_orden, notas, ticket_dia,
                subtotal_exento, subtotal_exonerado, subtotal_gravado_15, subtotal_gravado_18, descuento, isv_total, total)
         values ($1,$2,$3,$4,'mayoreo','llevar',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
        [req.ctx.empresa.id, suc.id, c.cliente_id, req.ctx.usuario.id, (c.proyecto || c.nombre_cliente).slice(0, 60), `Cotización #${c.numero}${c.proyecto ? ` · ${c.proyecto}` : ''}`, ticket,
          round2(exento), round2(exonerado), round2(g15), round2(g18), round2(calc.lineas.reduce((s, l) => s + l.descuento_con_isv, 0)), calc.isv, calc.total])).rows[0];
      for (const [i, l] of c.lineas.entries()) {
        const cl = calc.lineas[i];
        await q.query(
          `insert into pos.detalle_venta (venta_id, producto_id, nombre_producto, cantidad, precio_base, extras, precio_unitario, opciones, notas, descuento, descuento_porcentaje, impuesto_tasa, exento, monto, orden)
           values ($1,$2,$3,$4,$5,0,$5,'[]'::jsonb,null,$6,0,$7,false,$8,$9)`,
          [venta.id, l.producto_id, l.descripcion, l.cantidad, cl.precio_unitario_con_isv, cl.descuento_con_isv, cl.isv_tasa, cl.monto, i]);
      }
      const faltantesAvisados = await antesDeCobrar(q, req.ctx, venta.id, { confirmarSinStock: b.confirmar_sin_stock, refId: id });
      let turno = (await q.query(`select id from pos.turnos where sucursal_id = $1 and cajero_id = $2 and estado = 'abierto'`, [suc.id, req.ctx.usuario.id])).rows[0];
      if (!turno) {
        turno = (await q.query('insert into pos.turnos (empresa_id, sucursal_id, cajero_id, fondo_inicial) values ($1,$2,$3,0) returning id', [req.ctx.empresa.id, suc.id, req.ctx.usuario.id])).rows[0];
        await auditar(q, req.ctx, 'turno_abierto', 'turno', turno.id, { fondo: 0, automatico: true }, { sucursalId: suc.id });
      }
      await q.query('update pos.ventas set turno_id = $1 where id = $2', [turno.id, venta.id]);
      // Los pagos cobrados (anticipo y demás) se aplican hasta cubrir exactamente el total.
      let restante = Number(c.total);
      const pagos = [];
      for (const p of c.pagos) {
        if (restante <= 0) break;
        const m = round2(Math.min(Number(p.monto), restante));
        pagos.push({ forma_pago_id: p.forma_pago_id, monto: m, referencia: p.referencia });
        restante = round2(restante - m);
      }
      const pagada = (await q.query('select * from pos.cobrar_venta($1, $2::jsonb)', [venta.id, JSON.stringify(pagos)])).rows[0];
      await auditar(q, req.ctx, 'venta_cobrada', 'venta', venta.id, { factura: pagada.numero_factura, total: pagada.total, origen: 'cotizacion' }, { sucursalId: suc.id });
      const faltantes = await despuesDeCobrar(q, req.ctx, pagada, { refId: id, faltantesAvisados });
      if (sinRtnAlto) await auditar(q, req.ctx, 'venta_sin_rtn', 'venta', venta.id, { factura: pagada.numero_factura, total: Number(pagada.total) }, { sucursalId: suc.id });
      await q.query(`update eco.cotizaciones set estado='facturada', venta_id=$2, updated_at=now() where id=$1`, [id, venta.id]);
      await auditar(q, req.ctx, 'cotizacion_facturada', 'cotizacion', id, { numero: Number(c.numero), factura: pagada.numero_factura, total: Number(c.total) }, { sucursalId: suc.id });
      return {
        factura: { id: venta.id, numero_factura: pagada.numero_factura, es_borrador: pagada.es_borrador_fiscal, total: Number(pagada.total), faltantes_inventario: faltantes,
          aviso_rtn: sinRtnAlto ? `Recordatorio: esta factura pasa de L ${umbral.toLocaleString('es-HN')} y el cliente no tiene RTN. Trata de pedirlo y agregarlo al cliente.` : null },
        cotizacion: await cargar(q, req.ctx, id),
      };
    });
    res.status(201).json(out);
  });

  return r;
}

export { ErrorHttp };
