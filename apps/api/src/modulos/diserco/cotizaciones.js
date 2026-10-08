import { z } from 'zod';
import { sumarDias, UMBRAL_RTN_OBLIGATORIO, lempiras } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { ErrorHttp, conflicto, malaPeticion, noEncontrado, prohibido, uuid, validar } from '../../lib/http.js';
import { DISERCO, codigoCotizacion } from './config.js';
import { calcularCotizacion, round2 } from './calculo.js';
import { hoyHn, texto } from './comun.js';
import { generarExcelCotizacion, leerCotizacionExcel } from './excel.js';

const VER = ['cotizaciones:ver', 'pos:vender'];
const normNombre = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const ABIERTAS = ['borrador', 'enviada'];

const esqLinea = z.object({
  producto_id: uuid.nullish().or(z.literal('').transform(() => null)),
  descripcion: z.string().trim().max(2000).optional().nullable(),
  presentacion: texto(80), unidad: z.string().trim().max(20).optional().nullable(),
  cantidad: z.coerce.number({ invalid_type_error: 'Indica la cantidad' }).finite(),
  precio_unitario: z.union([z.literal(''), z.null(), z.coerce.number().finite()]).optional(),
  costo_unitario: z.coerce.number().finite().min(0).optional().nullable(),
});
const esqCot = z.object({
  tipo: z.enum(['proyecto', 'productos']).optional(),
  cliente_id: uuid.nullish().or(z.literal('').transform(() => null)),
  nombre_cliente: texto(160), rtn_cliente: texto(20), telefono: texto(40), email: texto(120), contacto: texto(160),
  proyecto: texto(200), ubicacion: texto(200), vigencia_dias: z.coerce.number().int().min(1).max(365).default(30),
  descuento_pct: z.coerce.number().min(0).max(100).default(0), anticipo_pct: z.coerce.number().min(0).max(100).default(0),
  mostrar_bancos: z.boolean().default(false), firma_nombre: texto(120), firma_cargo: texto(120), notas_internas: texto(500),
  secciones: z.array(z.object({ titulo: z.string().max(120).optional().nullable(), texto: z.string().max(6000).optional().nullable() })).default([]),
  lineas: z.array(esqLinea).min(1, 'La cotización necesita al menos una línea').max(300),
}).passthrough();

export function rutasCotizacionesDis(r, { db }) {
  async function cargar(q, ctx, id) {
    const cot = (await q.query(
      `select c.*, t.exento_impuestos, t.correo as cliente_email, u.nombre as vendedor
         from dis.cotizaciones c left join core.terceros t on t.id = c.cliente_id left join core.usuarios u on u.id = c.vendedor_id
        where c.id = $1 and c.empresa_id = $2`, [id, ctx.empresa.id])).rows[0];
    if (!cot) return null;
    const [lineas, pagos, orig] = await Promise.all([
      q.query('select l.*, (p.id is not null and x.controla_inventario) as controla_inventario from dis.cotizacion_lineas l left join pos.productos p on p.id = l.producto_id left join dis.producto_ext x on x.producto_id = p.id where l.cotizacion_id = $1 order by l.orden', [id]),
      q.query(`select g.*, f.nombre as forma, u.nombre as usuario, v.numero_factura, v.estado as venta_estado from dis.cotizacion_pagos g join pos.formas_pago f on f.id = g.forma_pago_id
                 left join core.usuarios u on u.id = g.usuario_id left join pos.ventas v on v.id = g.venta_id where g.cotizacion_id = $1 order by g.created_at`, [id]),
      q.query('select 1 from dis.cotizacion_archivos where cotizacion_id = $1 limit 1', [id]),
    ]);
    const num = (v) => (v == null ? v : Number(v));
    const pagosOk = pagos.rows.filter((p) => !p.anulado);
    const pagado = round2(pagosOk.reduce((s, p) => s + Number(p.monto), 0));
    const total = Number(cot.total);
    return {
      ...cot, numero: Number(cot.numero), anio: Number(cot.anio), descuento_pct: num(cot.descuento_pct), subtotal: num(cot.subtotal), isv: num(cot.isv), total, anticipo_pct: num(cot.anticipo_pct),
      fecha_vigencia: cot.fecha_vigencia ? String(cot.fecha_vigencia).slice(0, 10) : null,
      lineas: lineas.rows.map((l) => ({ ...l, cantidad: num(l.cantidad), precio_unitario: num(l.precio_unitario), monto: num(l.monto), costo_unitario: num(l.costo_unitario) })),
      pagos: pagos.rows.map((p) => ({ ...p, monto: num(p.monto) })), pagado, pendiente: round2(total - pagado),
      tiene_original: orig.rows.length > 0,
      vencida: ABIERTAS.includes(cot.estado) && !!cot.fecha_vigencia && String(cot.fecha_vigencia).slice(0, 10) < hoyHn(),
    };
  }
  const o404 = (c) => { if (!c) throw noEncontrado('Cotización no encontrada'); return c; };

  async function resolverCliente(q, ctx, b) {
    if (b.cliente_id) {
      const t = (await q.query('select * from core.terceros where id = $1 and activo', [b.cliente_id])).rows[0];
      if (t) return t;
    }
    const rtn = String(b.rtn_cliente ?? '').replace(/[-\s]/g, '');
    if (rtn && !/^\d{13,14}$/.test(rtn)) throw malaPeticion('El RTN debe tener 13 o 14 dígitos');
    if (rtn) {
      const t = (await q.query('select * from core.terceros where rtn = $1 and activo', [rtn])).rows[0];
      if (t) return t;
    }
    const nombre = String(b.nombre_cliente ?? '').trim();
    if (!nombre) throw malaPeticion('Indica el nombre del cliente');
    const t = (await q.query('insert into core.terceros (nombre, rtn, telefono, correo, direccion, es_cliente, created_by) values ($1,$2,$3,$4,$5,true,$6) returning *',
      [nombre, rtn || null, b.telefono ?? null, b.email ?? null, b.ubicacion ?? null, ctx.usuario.id])).rows[0];
    await auditar(q, ctx, 'tercero_creado', 'tercero', t.id, { nombre, origen: 'cotizacion_diserco' });
    return t;
  }

  async function armarLineas(q, ctx, b, tipo) {
    const ids = [...new Set(b.lineas.map((l) => l.producto_id).filter(Boolean))];
    const prods = ids.length ? (await q.query(
      `select p.id, p.nombre, x.presentacion, p.unidad, x.precio_sin_isv, x.costo_estandar from pos.productos p join dis.producto_ext x on x.producto_id = p.id where p.empresa_id = $1 and p.id = any($2::uuid[])`, [ctx.empresa.id, ids])).rows : [];
    const por = new Map(prods.map((p) => [p.id, p]));
    const gerencia = ctx.permisos.has('pos:anular');
    return b.lineas.map((l, i) => {
      const p = l.producto_id ? por.get(l.producto_id) : null;
      if (l.producto_id && !p) throw malaPeticion(`Producto no encontrado en la línea ${i + 1}`);
      const descripcion = String(l.descripcion || p?.nombre || '').trim();
      if (!descripcion) throw malaPeticion(`Escribe la descripción de la línea ${i + 1}`);
      if (!(l.cantidad > 0)) throw malaPeticion(`Indica la cantidad de la línea ${i + 1}`);
      // Productos: unidades enteras (no se venden medios kits). Proyectos: el área puede llevar decimales.
      if (tipo === 'productos' && !Number.isInteger(l.cantidad)) throw malaPeticion(`La cantidad de la línea ${i + 1} debe ser un número entero`);
      const precio = l.precio_unitario === '' || l.precio_unitario == null ? Number(p?.precio_sin_isv ?? NaN) : Number(l.precio_unitario);
      if (!Number.isFinite(precio) || precio < 0) throw malaPeticion(`Indica el precio de la línea ${i + 1}`);
      if (p && !gerencia && precio < Number(p.precio_sin_isv) * 0.995) {
        throw prohibido(`El precio de ${p.nombre} (L ${precio}) está por debajo del catálogo (L ${Number(p.precio_sin_isv)}). Requiere autorización de gerente.`);
      }
      return {
        orden: i, producto_id: p?.id ?? null, descripcion, presentacion: (l.presentacion ?? p?.presentacion ?? '') || null,
        cantidad: l.cantidad, unidad: (l.unidad || (tipo === 'proyecto' ? 'm2' : p?.unidad ?? 'unidad')).trim() || 'unidad',
        precio_unitario: precio, isv_tasa: DISERCO.tasaIsv, costo_unitario: l.costo_unitario ?? Number(p?.costo_estandar ?? 0),
      };
    });
  }

  const limpiarSecciones = (s) => s.map((x) => ({ titulo: String(x.titulo ?? '').slice(0, 120), texto: String(x.texto ?? '').slice(0, 6000) })).filter((x) => x.titulo.trim() || x.texto.trim());

  /** Crea o edita una cotización dentro de la transacción `q`. Devuelve el id. */
  async function guardar(q, ctx, cuerpo, id = null) {
    const b = validar(esqCot, cuerpo);
    let previa = null;
    if (id) {
      await q.query('select 1 from dis.cotizaciones where id = $1 and empresa_id = $2 for update', [id, ctx.empresa.id]);
      previa = o404(await cargar(q, ctx, id));
      if (!ABIERTAS.includes(previa.estado)) throw conflicto(`Una cotización ${previa.estado} ya no se puede editar`);
    }
    const tipo = id ? previa.tipo : b.tipo;
    if (!['proyecto', 'productos'].includes(tipo)) throw malaPeticion('Elige si es cotización de Proyecto o de Productos');
    const cliente = await resolverCliente(q, ctx, b);
    const lineas = await armarLineas(q, ctx, b, tipo);
    if (b.descuento_pct > 0 && !ctx.permisos.has('pos:anular')) throw prohibido('Solo gerencia puede aplicar descuentos');
    const calc = calcularCotizacion(lineas, { descuento_pct: b.descuento_pct, cliente_exento: !!cliente.exento_impuestos });
    const proyecto = b.proyecto ?? null;
    if (tipo === 'proyecto' && !proyecto) throw malaPeticion('Escribe el nombre del proyecto');
    const vals = [cliente.id, cliente.nombre, cliente.rtn ?? null, b.telefono || cliente.telefono || null, b.email || cliente.correo || null, b.contacto ?? null, proyecto, b.ubicacion ?? null,
      b.vigencia_dias, sumarDias(hoyHn(), b.vigencia_dias), b.descuento_pct, calc.subtotal, calc.isv, calc.total, b.anticipo_pct,
      JSON.stringify(limpiarSecciones(b.secciones)), b.mostrar_bancos, b.firma_nombre ?? null, b.firma_cargo ?? null, b.notas_internas ?? null];
    let cotId = id;
    let suc = previa?.sucursal_id ?? null;
    if (id) {
      await q.query(
        `update dis.cotizaciones set cliente_id=$2, nombre_cliente=$3, rtn_cliente=$4, telefono=$5, email=$6, contacto=$7, proyecto=$8, ubicacion=$9, vigencia_dias=$10, fecha_vigencia=$11,
                descuento_pct=$12, subtotal=$13, isv=$14, total=$15, anticipo_pct=$16, secciones=$17::jsonb, mostrar_bancos=$18, firma_nombre=$19, firma_cargo=$20, notas_internas=$21, updated_at=now() where id=$1`, [id, ...vals]);
      await q.query('delete from dis.cotizacion_lineas where cotizacion_id = $1', [id]);
    } else {
      const anio = Number(hoyHn().slice(0, 4));
      const numero = (await q.query(`select dis.siguiente($1,'cot',$2) as n`, [ctx.empresa.id, anio])).rows[0].n;
      const sucs = (await q.query('select id from core.sucursales where empresa_id = $1 and activo order by orden, nombre', [ctx.empresa.id])).rows.map((x) => x.id);
      const pedida = cuerpo.sucursal_id;
      suc = (pedida && sucs.includes(pedida) ? pedida : sucs.find((x) => !ctx.sucursalIds.length || ctx.sucursalIds.includes(x))) ?? null;
      if (!suc) throw new ErrorHttp(500, 'DISERCO no tiene una sucursal configurada');
      cotId = (await q.query(
        `insert into dis.cotizaciones (cliente_id, nombre_cliente, rtn_cliente, telefono, email, contacto, proyecto, ubicacion, vigencia_dias, fecha_vigencia, descuento_pct, subtotal, isv, total,
                anticipo_pct, secciones, mostrar_bancos, firma_nombre, firma_cargo, notas_internas, empresa_id, tipo, numero, anio, codigo, vendedor_id, sucursal_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27) returning id`,
        [...vals, ctx.empresa.id, tipo, numero, anio, codigoCotizacion(tipo, numero, anio), ctx.usuario.id, suc])).rows[0].id;
    }
    for (const [i, l] of lineas.entries()) {
      await q.query(
        `insert into dis.cotizacion_lineas (cotizacion_id, orden, producto_id, descripcion, presentacion, cantidad, unidad, precio_unitario, isv_tasa, monto, costo_unitario)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [cotId, l.orden, l.producto_id, l.descripcion, l.presentacion, l.cantidad, l.unidad, l.precio_unitario, l.isv_tasa, calc.lineas[i].monto, l.costo_unitario]);
    }
    const codigo = id ? previa.codigo : (await q.query('select codigo from dis.cotizaciones where id = $1', [cotId])).rows[0].codigo;
    await auditar(q, ctx, id ? 'dcotizacion_editada' : 'dcotizacion_creada', 'dcotizacion', cotId, { codigo, tipo, cliente: cliente.nombre, total: calc.total }, { sucursalId: suc });
    return { id: cotId, calc };
  }

  // ── Lista ──────────────────────────────────────────────────────────────────
  r.get('/cotizaciones', requierePermiso(...VER), async (req, res) => {
    const estados = req.query.estado ? String(req.query.estado).split(',').filter((e) => ['borrador', 'enviada', 'aprobada', 'rechazada', 'facturada', 'anulada'].includes(e)) : null;
    const tipo = ['proyecto', 'productos'].includes(req.query.tipo) ? req.query.tipo : null;
    const busca = String(req.query.q ?? '').trim().slice(0, 60) || null;
    const { rows } = await db.query(
      `select c.id, c.codigo, c.tipo, c.estado, c.nombre_cliente, c.proyecto, c.total, c.fecha_vigencia, c.created_at, c.vendedor_id,
              coalesce((select sum(g.monto) from dis.cotizacion_pagos g where g.cotizacion_id = c.id and not g.anulado), 0) as pagado
         from dis.cotizaciones c
        where c.empresa_id = $1 and ($2::text[] is null or c.estado = any($2)) and ($3::text is null or c.tipo = $3)
          and ($4::text is null or c.nombre_cliente ilike '%'||$4||'%' or c.proyecto ilike '%'||$4||'%' or c.codigo ilike '%'||$4||'%')
        order by c.created_at desc, c.numero desc limit 300`, [req.ctx.empresa.id, estados, tipo, busca]);
    const hoy = hoyHn();
    res.json(rows.map((c) => {
      const fv = c.fecha_vigencia ? String(c.fecha_vigencia).slice(0, 10) : null;
      return { ...c, total: Number(c.total), pagado: Number(c.pagado), fecha_vigencia: fv, vencida: ABIERTAS.includes(c.estado) && !!fv && fv < hoy };
    }));
  });

  // ── Importar desde Excel (un archivo por llamada; la pantalla sube varios en fila) ──
  r.post('/cotizaciones/importar-excel', requierePermiso('cotizaciones:ver'), async (req, res) => {
    const nombre = String(req.body?.nombre ?? 'cotizacion.xlsx').slice(0, 200);
    const base64 = String(req.body?.contenido ?? '').replace(/^data:[^,]*,/, '');
    if (!base64) throw malaPeticion('No llegó el archivo');
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > 8 * 1024 * 1024) throw malaPeticion('El archivo es demasiado grande (máximo 8 MB)');
    let leida;
    try { leida = await leerCotizacionExcel(buffer); } catch (e) {
      throw malaPeticion(/zip|central directory|corrupt|Can't find end|signature/i.test(e.message) ? 'El archivo no es un Excel (.xlsx) válido. Si es .xls, ábrelo y guárdalo como .xlsx.' : e.message);
    }
    const { tipo, meta, lineas, secciones, anticipo, firma, codigoOriginal, fechaTexto, fecha, avisos } = leida;
    const out = await db.tx(async (q) => {
      // Cliente: si ya existe uno con el mismo RTN o nombre se usa; si no, se crea.
      let clienteId = null;
      const rtn = String(meta.rtn ?? '').replace(/[-\s]/g, '');
      if (/^\d{13,14}$/.test(rtn)) clienteId = (await q.query('select id from core.terceros where rtn = $1 and activo', [rtn])).rows[0]?.id ?? null;
      if (!clienteId) {
        const clave = normNombre(meta.cliente).split(' ').slice(0, 2).join('%');
        const cands = (await q.query(`select id, nombre from core.terceros where activo and nombre ilike $1 limit 60`, [`%${clave}%`])).rows;
        clienteId = cands.find((c) => normNombre(c.nombre) === normNombre(meta.cliente))?.id ?? null;
      }
      if (!clienteId) avisos.push(`Cliente nuevo creado: ${meta.cliente}`);
      let catalogo = new Map();
      if (tipo === 'productos') {
        const ps = (await q.query(`select p.id, p.nombre from pos.productos p join dis.producto_ext x on x.producto_id = p.id where p.empresa_id = $1 and p.activo`, [req.ctx.empresa.id])).rows;
        catalogo = new Map(ps.map((p) => [normNombre(p.nombre), p.id]));
      }
      const cuerpo = {
        tipo, cliente_id: clienteId, nombre_cliente: meta.cliente, rtn_cliente: rtn || null, telefono: meta.telefono, email: meta.email, contacto: meta.contacto,
        proyecto: meta.proyecto, ubicacion: meta.ubicacion, secciones, anticipo_pct: tipo === 'proyecto' ? anticipo : 0, mostrar_bancos: true,
        firma_nombre: firma.nombre, firma_cargo: firma.cargo, vigencia_dias: 30,
        notas_internas: `Importada desde Excel (${nombre})${codigoOriginal ? ` · número original ${codigoOriginal}` : ''}${fechaTexto ? ` · ${fechaTexto}` : ''}`,
        lineas: lineas.map((l) => ({ producto_id: catalogo.get(normNombre(l.descripcion)) ?? null, descripcion: l.descripcion, cantidad: l.cantidad, unidad: l.unidad || (tipo === 'proyecto' ? 'm2' : 'unidad'), precio_unitario: l.precio_unitario })),
      };
      const { id } = await guardar(q, req.ctx, cuerpo);
      // Conserva la fecha original (para que el historial y la vigencia tengan sentido).
      if (fecha && fecha <= hoyHn()) await q.query(`update dis.cotizaciones set created_at = $2::timestamptz, fecha_vigencia = $3 where id = $1`, [id, `${fecha}T12:00:00-06:00`, sumarDias(fecha, 30)]);
      await q.query('insert into dis.cotizacion_archivos (cotizacion_id, nombre, contenido) values ($1,$2,$3)', [id, nombre, base64]);
      const cot = await cargar(q, req.ctx, id);
      await auditar(q, req.ctx, 'dcotizacion_importada_excel', 'dcotizacion', id, { codigo: cot.codigo, archivo: nombre, original: codigoOriginal }, { sucursalId: cot.sucursal_id });
      return { cotizacion: cot, avisos };
    });
    res.status(201).json(out);
  });

  r.get('/cotizaciones/:id/excel', requierePermiso(...VER), async (req, res) => {
    const cot = o404(await cargar(db, req.ctx, validar(uuid, req.params.id)));
    const buf = await generarExcelCotizacion(cot);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="cotizacion-${cot.codigo}.xlsx"`);
    res.send(buf);
  });

  r.get('/cotizaciones/:id/excel-original', requierePermiso(...VER), async (req, res) => {
    const cot = o404(await cargar(db, req.ctx, validar(uuid, req.params.id)));
    const a = (await db.query('select nombre, contenido from dis.cotizacion_archivos where cotizacion_id = $1 order by created_at desc limit 1', [cot.id])).rows[0];
    if (!a) throw noEncontrado('Esta cotización no tiene un Excel original guardado');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${a.nombre.replace(/[^\w.\- ]/g, '_')}"`);
    res.send(Buffer.from(a.contenido, 'base64'));
  });

  // Datos para el documento imprimible (el navegador arma el HTML/PDF).
  r.get('/cotizaciones/:id/documento', requierePermiso(...VER), async (req, res) => {
    const cot = o404(await cargar(db, req.ctx, validar(uuid, req.params.id)));
    const { vendedor, cliente_email, exento_impuestos, ...limpia } = cot;
    res.json({ cotizacion: limpia, empresa: { nombre: req.ctx.empresa.nombre, razon_social: req.ctx.empresa.razon_social, rtn: req.ctx.empresa.rtn }, config: DISERCO });
  });

  r.get('/cotizaciones/:id', requierePermiso(...VER), async (req, res) => {
    res.json(o404(await cargar(db, req.ctx, validar(uuid, req.params.id))));
  });

  r.post('/cotizaciones', requierePermiso('cotizaciones:ver'), async (req, res) => {
    const out = await db.tx(async (q) => {
      const { id, calc } = await guardar(q, req.ctx, req.body);
      return { ...(await cargar(q, req.ctx, id)), margen: calc.margen, margen_pct: calc.margen_pct };
    });
    res.status(201).json(out);
  });
  r.put('/cotizaciones/:id', requierePermiso('cotizaciones:ver'), async (req, res) => {
    const out = await db.tx(async (q) => {
      const { id, calc } = await guardar(q, req.ctx, req.body, validar(uuid, req.params.id));
      return { ...(await cargar(q, req.ctx, id)), margen: calc.margen, margen_pct: calc.margen_pct };
    });
    res.json(out);
  });

  // ── Correo ─────────────────────────────────────────────────────────────────
  // La plataforma aún no tiene servicio de correo (la app original usaba nodemailer + Gmail). El endpoint valida lo mismo
  // y responde «pendiente de configurar»; la pantalla ofrece «Abrir en mi correo» y el PDF para adjuntar.
  r.post('/cotizaciones/:id/correo', requierePermiso('cotizaciones:ver'), async (req, res) => {
    const cot = o404(await cargar(db, req.ctx, validar(uuid, req.params.id)));
    const destino = String(req.body?.email ?? cot.email ?? cot.cliente_email ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destino)) throw malaPeticion('Escribe un correo válido para enviar la cotización');
    throw new ErrorHttp(501, 'El envío automático por correo está pendiente de configurar en el servidor (falta el servicio de correo). Usa «Abrir en mi correo» o descarga el PDF y envíalo tú.', 'correo_pendiente');
  });

  // ── Estados ────────────────────────────────────────────────────────────────
  async function cambiarEstado(req, res, { desde, hacia, accion, extra = '', extraVals = [], requiereMotivo = false }) {
    const id = validar(uuid, req.params.id);
    const motivo = String(req.body?.motivo ?? '').trim();
    if (requiereMotivo && !motivo) throw malaPeticion('Indica el motivo');
    const out = await db.tx(async (q) => {
      await q.query('select 1 from dis.cotizaciones where id = $1 and empresa_id = $2 for update', [id, req.ctx.empresa.id]);
      const cot = o404(await cargar(q, req.ctx, id));
      if (!desde.includes(cot.estado)) throw conflicto(`La cotización está ${cot.estado}: no se puede ${accion}`);
      if (hacia === 'anulada' && cot.pagado > 0.004) throw conflicto(`Ya tiene L ${cot.pagado.toFixed(2)} cobrados y facturados: anula primero esas facturas`);
      await q.query(`update dis.cotizaciones set estado=$2, motivo_cierre=$3, updated_at=now() ${extra} where id=$1`, [id, hacia, motivo || null, ...extraVals]);
      await auditar(q, req.ctx, `dcotizacion_${accion}`, 'dcotizacion', id, { codigo: cot.codigo, motivo }, { sucursalId: cot.sucursal_id });
      return cargar(q, req.ctx, id);
    });
    res.json(out);
  }
  r.post('/cotizaciones/:id/aprobar', requierePermiso('cotizaciones:ver'), (req, res) => cambiarEstado(req, res, { desde: ABIERTAS, hacia: 'aprobada', accion: 'aprobar', extra: ', aprobada_at=now(), aprobada_por=$4', extraVals: [req.ctx.usuario.id] }));
  r.post('/cotizaciones/:id/rechazar', requierePermiso('cotizaciones:ver'), (req, res) => cambiarEstado(req, res, { desde: ABIERTAS, hacia: 'rechazada', accion: 'rechazar', requiereMotivo: true }));
  r.post('/cotizaciones/:id/anular', requierePermiso('pos:anular'), (req, res) => cambiarEstado(req, res, { desde: ['aprobada', 'facturada'], hacia: 'anulada', accion: 'anular', requiereMotivo: true }));
  r.post('/cotizaciones/:id/reabrir', requierePermiso('pos:anular'), (req, res) => cambiarEstado(req, res, { desde: ['rechazada', 'anulada'], hacia: 'borrador', accion: 'reabrir' }));

  // ── Cobro: registra el pago Y emite su factura (una factura por cada cobro) ──
  //  · Proyecto: anticipo / avance / saldo → cada cobro sale con una factura de ese concepto.
  //  · Productos: se cobra completo y la factura lleva el detalle real (descuenta inventario).
  r.post('/cotizaciones/:id/cobros', requierePermiso('pos:vender'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(z.object({ forma_pago_id: uuid, monto: z.coerce.number().finite(), referencia: texto(80), concepto: texto(120), confirmar_sin_stock: z.boolean().optional() }), req.body);
    const monto = round2(b.monto);
    try {
      const out = await db.tx(async (q) => {
        await q.query('select 1 from dis.cotizaciones where id = $1 and empresa_id = $2 for update', [id, req.ctx.empresa.id]);
        const cot = o404(await cargar(q, req.ctx, id));
        if (cot.estado !== 'aprobada') throw conflicto(cot.estado === 'facturada' ? 'Esta cotización ya está cobrada y facturada completa' : 'Solo se cobra una cotización aprobada');
        if (!(monto > 0)) throw malaPeticion('El monto debe ser mayor que 0');
        if (monto > cot.pendiente + 0.004) throw malaPeticion(`El monto supera el saldo pendiente (L ${cot.pendiente.toFixed(2)})`);
        if (cot.tipo === 'productos' && monto < cot.pendiente - 0.004) throw malaPeticion(`Una cotización de productos se cobra completa (L ${cot.pendiente.toFixed(2)})`);
        const forma = (await q.query('select id, nombre, tipo from pos.formas_pago where id = $1 and empresa_id = $2 and activo', [b.forma_pago_id, req.ctx.empresa.id])).rows[0];
        if (!forma) throw malaPeticion('Elige la forma de pago');
        const exento = !!cot.exento_impuestos;
        const completa = monto >= cot.pendiente - 0.004;
        const previos = cot.pagos.filter((p) => !p.anulado).length;
        let concepto = b.concepto ?? '';
        if (!concepto) {
          if (cot.tipo === 'productos') concepto = 'Pago total';
          else if (previos === 0 && completa) concepto = 'Pago total';
          else if (completa) concepto = 'Saldo final';
          else if (previos === 0) concepto = `Anticipo ${Math.round((monto / cot.total) * 100)}%`;
          else concepto = 'Avance de obra';
        }
        let lineasVenta; let cab;
        if (cot.tipo === 'productos') {
          const calc = calcularCotizacion(cot.lineas, { descuento_pct: cot.descuento_pct, cliente_exento: exento });
          if (Math.abs(calc.total - monto) > 0.01) throw conflicto('El monto no coincide con el total recalculado de la cotización: guárdala de nuevo antes de cobrar');
          // Existencia: avisa (409 SIN_STOCK) salvo que ya se haya confirmado.
          const pide = new Map();
          for (const l of cot.lineas) if (l.producto_id && l.controla_inventario) pide.set(l.producto_id, (pide.get(l.producto_id) ?? 0) + l.cantidad);
          if (pide.size) {
            const { rows } = await q.query('select p.id, p.nombre, coalesce(e.existencia,0) as hay from pos.productos p left join dis.existencias e on e.producto_id = p.id where p.id = any($1::uuid[])', [[...pide.keys()]]);
            const faltantes = rows.filter((x) => Number(x.hay) < pide.get(x.id)).map((x) => ({ producto: x.nombre, pedido: pide.get(x.id), hay: Math.max(0, Math.floor(Number(x.hay))) }));
            if (faltantes.length && !b.confirmar_sin_stock) {
              const e = new ErrorHttp(409, `Sin existencia suficiente: ${faltantes.map((f) => `${f.producto} (pides ${f.pedido}, hay ${f.hay})`).join('; ')}`, 'SIN_STOCK');
              e.faltantes = faltantes;
              throw e;
            }
            if (faltantes.length) await auditar(q, req.ctx, 'inventario_factura_sin_stock', 'dcotizacion', id, { codigo: cot.codigo, faltantes: faltantes.map((f) => `${f.producto}: pidió ${f.pedido}, había ${f.hay}`) }, { sucursalId: cot.sucursal_id });
          }
          let ex = 0; let gr = 0;
          calc.lineas.forEach((l) => (l.isv_tasa > 0 ? (gr += l.base) : (ex += l.base)));
          lineasVenta = cot.lineas.map((l, i) => ({
            producto_id: l.producto_id, nombre_producto: l.descripcion, cantidad: l.cantidad, precio: round2(calc.lineas[i].precio_unitario_con_isv),
            descuento: calc.lineas[i].descuento_con_isv, tasa: calc.lineas[i].isv_tasa, monto: calc.lineas[i].monto, orden: i,
          }));
          cab = { exento: round2(ex), gravado: round2(gr), descuento: round2(calc.lineas.reduce((s, l) => s + l.descuento_con_isv, 0)), isv: calc.isv, total: calc.total };
        } else {
          const tasa = exento ? 0 : DISERCO.tasaIsv;
          const base = tasa > 0 ? round2(monto / (1 + tasa)) : monto;
          lineasVenta = [{ producto_id: null, nombre_producto: `${concepto} — ${cot.proyecto || 'Proyecto'} (Cot. ${cot.codigo})`, cantidad: 1, precio: monto, descuento: 0, tasa, monto, orden: 0 }];
          cab = { exento: tasa > 0 ? 0 : monto, gravado: tasa > 0 ? base : 0, descuento: 0, isv: round2(monto - base), total: monto };
        }
        const ticket = (await q.query('select pos.siguiente_ticket($1) as n', [cot.sucursal_id])).rows[0].n;
        const venta = (await q.query(
          `insert into pos.ventas (empresa_id, sucursal_id, cliente_id, cajero_id, canal, tipo_orden, nombre_orden, notas, ticket_dia, subtotal_exento, subtotal_exonerado, subtotal_gravado_15, subtotal_gravado_18, descuento, isv_total, total)
           values ($1,$2,$3,$4,'mayoreo','llevar',$5,$6,$7,$8,0,$9,0,$10,$11,$12) returning id`,
          [req.ctx.empresa.id, cot.sucursal_id, cot.cliente_id, req.ctx.usuario.id, (cot.proyecto || cot.nombre_cliente).slice(0, 60),
            `Cotización DISERCO ${cot.codigo}${cot.proyecto ? ` · ${cot.proyecto}` : ''} · ${concepto}`, ticket, cab.exento, cab.gravado, cab.descuento, cab.isv, cab.total])).rows[0];
        for (const l of lineasVenta) {
          await q.query(
            `insert into pos.detalle_venta (venta_id, producto_id, nombre_producto, cantidad, precio_base, extras, precio_unitario, opciones, descuento, descuento_porcentaje, impuesto_tasa, exento, monto, orden)
             values ($1,$2,$3,$4,$5,0,$5,'[]'::jsonb,$6,0,$7,$8,$9,$10)`,
            [venta.id, l.producto_id, l.nombre_producto, l.cantidad, l.precio, l.descuento, l.tasa, l.tasa === 0, l.monto, l.orden]);
        }
        // Turno: se abre solo (fondo 0) si el usuario no tiene uno, igual que al cobrar en caja.
        let turno = (await q.query(`select id from pos.turnos where sucursal_id = $1 and cajero_id = $2 and estado = 'abierto'`, [cot.sucursal_id, req.ctx.usuario.id])).rows[0];
        if (!turno) {
          turno = (await q.query('insert into pos.turnos (empresa_id, sucursal_id, cajero_id, fondo_inicial) values ($1,$2,$3,0) returning id', [req.ctx.empresa.id, cot.sucursal_id, req.ctx.usuario.id])).rows[0];
          await auditar(q, req.ctx, 'turno_abierto', 'turno', turno.id, { fondo: 0, automatico: true }, { sucursalId: cot.sucursal_id });
        }
        await q.query('update pos.ventas set turno_id = $1 where id = $2', [turno.id, venta.id]);
        const pagada = (await q.query('select * from pos.cobrar_venta($1, $2::jsonb)', [venta.id, JSON.stringify([{ forma_pago_id: forma.id, monto, referencia: b.referencia ?? undefined }])])).rows[0];
        await q.query('insert into dis.cotizacion_pagos (cotizacion_id, concepto, forma_pago_id, monto, referencia, venta_id, usuario_id) values ($1,$2,$3,$4,$5,$6,$7)', [id, concepto, forma.id, monto, b.referencia ?? null, venta.id, req.ctx.usuario.id]);
        if (round2(cot.pagado + monto) >= cot.total - 0.004) await q.query(`update dis.cotizaciones set estado='facturada', updated_at=now() where id=$1`, [id]);
        const rtn = (await q.query('select rtn from core.terceros where id = $1', [cot.cliente_id])).rows[0]?.rtn;
        const aviso_rtn = Number(pagada.total) > UMBRAL_RTN_OBLIGATORIO && !String(rtn ?? '').trim() ? `La factura supera ${lempiras(UMBRAL_RTN_OBLIGATORIO)} y el cliente no tiene RTN registrado.` : null;
        await auditar(q, req.ctx, 'venta_cobrada', 'venta', venta.id, { factura: pagada.numero_factura, total: pagada.total, origen: 'cotizacion_diserco' }, { sucursalId: cot.sucursal_id });
        await auditar(q, req.ctx, 'dcotizacion_cobro', 'dcotizacion', id, { codigo: cot.codigo, concepto, monto, factura: pagada.numero_factura, forma: forma.nombre }, { sucursalId: cot.sucursal_id });
        return { factura: { id: venta.id, numero_factura: pagada.numero_factura, es_borrador: pagada.es_borrador_fiscal, total: Number(pagada.total), aviso_rtn }, cotizacion: await cargar(q, req.ctx, id) };
      });
      res.status(201).json(out);
    } catch (e) {
      if (e.faltantes) return res.status(409).json({ error: e.message, codigo: 'SIN_STOCK', faltantes: e.faltantes });
      throw e;
    }
  });
}
