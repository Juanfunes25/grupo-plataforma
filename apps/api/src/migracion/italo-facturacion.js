import { fileURLToPath } from 'node:url';
import { leerConfig } from '../config.js';
import { abrirDb } from '../db/index.js';

/**
 * Importa a la plataforma la información de `italo-facturacion` (el POS actual de las tiendas de Italo).
 *
 *   Origen  : base de italo-facturacion (Supabase) — SOLO LECTURA.
 *   Destino : la base de la plataforma, empresa «italo».
 *
 * Reglas de seguridad:
 *  · Por defecto es un ENSAYO: todo corre dentro de una transacción que se revierte al final y el
 *    resultado dice qué habría hecho. Solo con `aplicar: true` se guarda.
 *  · Es idempotente: se puede correr de nuevo sin duplicar (los registros conservan su UUID original).
 *  · El CAI/correlativo NO se toca salvo `fiscal: true`. Eso se hace UNA vez, en el corte, con el
 *    sistema viejo ya detenido, porque copia el correlativo vigente (si se copiara antes y luego se
 *    siguiera facturando en el viejo, se repetirían números fiscales).
 *  · Las contraseñas de Supabase Auth no se pueden migrar: los usuarios entran con PIN/contraseña nuevos.
 */

const ORIGEN = 'italo-facturacion';
const LOTE = 500;

export async function importarItaloFacturacion({ origen, destino, empresa = 'italo', aplicar = false, fiscal = false, desde = null, log = () => {} }) {
  const r = { modo: aplicar ? 'APLICADO' : 'ENSAYO', tablas: {}, avisos: [], usuarios_sin_acceso: 0, fiscal: fiscal ? 'copiado' : 'no tocado' };
  const cuenta = (t, ins, tot) => { r.tablas[t] = { leidos: tot, nuevos: ins, omitidos: tot - ins }; log(`  ${t}: ${ins} nuevos de ${tot}`); };

  class Ensayo extends Error {}
  try {
    await destino.tx(async (q) => {
      const emp = (await q.query('select id from core.empresas where codigo = $1', [empresa])).rows[0];
      if (!emp) throw new Error(`La empresa "${empresa}" no existe en la plataforma`);
      const E = emp.id;

      /** Inserta filas (JSON) con un INSERT…SELECT por lote. Devuelve cuántas quedaron nuevas. */
      const insertar = async (sql, filas) => {
        let n = 0;
        for (let i = 0; i < filas.length; i += LOTE) n += (await q.query(sql, [JSON.stringify(filas.slice(i, i + LOTE))])).rowCount;
        return n;
      };
      const leer = async (sql, args) => (await origen.query(sql, args)).rows;

      // ── 1. Sucursales: se emparejan por alias con las de la plataforma (se crean si faltan) ──
      const sucs = await leer('select * from public.sucursales order by created_at');
      const mapSuc = new Map();
      for (const s of sucs) {
        let d = (await q.query('select id from core.sucursales where empresa_id = $1 and alias = $2', [E, s.alias])).rows[0];
        if (!d) {
          const orden = (await q.query('select coalesce(max(orden),0)+1 as n from core.sucursales where empresa_id = $1', [E])).rows[0].n;
          d = (await q.query(`insert into core.sucursales (empresa_id, nombre, alias, direccion, color, activo, orden) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
            [E, s.nombre.replace(/^Inversiones Milano S de R\.L\. - /, ''), s.alias, s.direccion, s.color, s.activo, orden])).rows[0];
          await q.query(`insert into pos.puntos_emision (empresa_id, sucursal_id, punto_emision_codigo, punto_venta_codigo, correlativo_desde, correlativo_hasta, correlativo_actual, es_borrador)
                         values ($1,$2,$3,'001',1,99999999,1,true)`, [E, d.id, String(orden).padStart(3, '0')]);
          r.avisos.push(`Sucursal "${s.alias}" no existía: se creó con facturación en borrador.`);
        }
        mapSuc.set(s.id, d.id);
      }
      cuenta('sucursales', 0, sucs.length);

      // ── 2. Usuarios (perfiles) ──────────────────────────────────────────────────────────────
      let emails = new Map();
      try { emails = new Map((await leer('select id, lower(email) as email from auth.users')).map((u) => [u.id, u.email])); }
      catch { r.avisos.push('No se pudo leer auth.users (correos): los usuarios se crean sin correo; asígnalos en Administración.'); }
      const perfiles = await leer('select * from public.perfiles');
      const mapUsr = new Map();
      let nuevosUsr = 0;
      const ROL = { admin: 'admin', manager: 'gerente', cajero: 'cajero' };
      for (const p of perfiles) {
        const email = emails.get(p.id) ?? null;
        let u = email ? (await q.query('select id from core.usuarios where email = $1', [email])).rows[0] : null;
        if (!u) u = (await q.query('select id from core.usuarios where id = $1', [p.id])).rows[0];
        if (!u) {
          u = (await q.query('insert into core.usuarios (id, email, nombre, activo) values ($1,$2,$3,$4) returning id', [p.id, email, p.nombre, p.activo])).rows[0];
          nuevosUsr += 1;
        }
        mapUsr.set(p.id, u.id);
        await q.query(
          `insert into core.accesos (usuario_id, empresa_id, rol, sucursal_ids, activo) values ($1,$2,$3,$4::uuid[],$5) on conflict (usuario_id, empresa_id) do nothing`,
          [u.id, E, ROL[p.rol] ?? 'cajero', p.sucursal_id && mapSuc.get(p.sucursal_id) ? [mapSuc.get(p.sucursal_id)] : [], p.activo]);
      }
      cuenta('usuarios', nuevosUsr, perfiles.length);
      r.usuarios_sin_acceso = (await q.query(
        `select count(*)::int as n from core.accesos a join core.usuarios u on u.id = a.usuario_id
          where a.empresa_id = $1 and a.activo and u.password_hash is null and a.pin_hash is null and u.id = any($2::uuid[])`, [E, [...mapUsr.values()]])).rows[0].n;

      // ── 3. Categorías (por nombre) y productos ──────────────────────────────────────────────
      const cats = await leer('select * from public.categorias');
      const mapCat = new Map();
      let nCat = 0;
      for (const c of cats) {
        const ex = (await q.query('select id from pos.categorias where empresa_id = $1 and nombre = $2', [E, c.nombre])).rows[0];
        if (ex) mapCat.set(c.id, ex.id);
        else { mapCat.set(c.id, (await q.query('insert into pos.categorias (empresa_id, nombre, orden, activo) values ($1,$2,$3,$4) returning id', [E, c.nombre, c.orden, c.activo])).rows[0].id); nCat += 1; }
      }
      cuenta('categorias', nCat, cats.length);

      const prods = await leer('select * from public.productos');
      const filasProd = prods.map((p) => ({
        id: p.id, codigo: p.codigo, codigo_barras: p.codigo_barras, nombre: p.nombre, categoria_id: mapCat.get(p.categoria_id) ?? null, precio: p.precio,
        tasa: Number(p.impuesto1_tasa) >= 0.17 ? 0.18 : Number(p.impuesto1_tasa) > 0 ? 0.15 : 0, activo: p.activo,
      }));
      for (const p of prods) if (Number(p.impuesto2_tasa) > 0 || Number(p.impuesto3_tasa) > 0) r.avisos.push(`Producto "${p.nombre}" tenía impuestos 2/3: no se importan (revisar con el contador).`);
      cuenta('productos', await insertar(
        `insert into pos.productos (id, empresa_id, codigo, codigo_barras, nombre, categoria_id, precio, impuesto_tasa, activo)
         select x.id, '${E}', x.codigo, x.codigo_barras, x.nombre, x.categoria_id, x.precio, x.tasa, x.activo
           from jsonb_to_recordset($1::jsonb) as x(id uuid, codigo text, codigo_barras text, nombre text, categoria_id uuid, precio numeric, tasa numeric, activo boolean)
         on conflict do nothing`, filasProd), prods.length);
      const prodsDestino = new Set((await q.query('select id from pos.productos where empresa_id = $1', [E])).rows.map((x) => x.id));

      // ── 4. Clientes → terceros comunes (se une por RTN; el consumidor final ya existe) ───────
      const clientes = await leer('select * from public.clientes');
      const mapCli = new Map();
      const cf = (await q.query('select id from core.terceros where es_consumidor_final')).rows[0].id;
      const rtns = clientes.map((c) => c.rtn).filter(Boolean);
      const porRtn = new Map((await q.query('select id, rtn from core.terceros where rtn = any($1::text[])', [rtns])).rows.map((x) => [x.rtn, x.id]));
      const nuevosCli = [];
      const vistos = new Set();
      for (const c of clientes) {
        if (c.es_consumidor_final) { mapCli.set(c.id, cf); continue; }
        const rtn = c.rtn && /^\d{14}$/.test(c.rtn.replace(/[\s-]/g, '')) ? c.rtn.replace(/[\s-]/g, '') : null;
        if (c.rtn && !rtn) r.avisos.push(`Cliente "${c.nombre}": RTN "${c.rtn}" no tiene 14 dígitos; se importó sin RTN.`);
        if (rtn && (porRtn.has(rtn) || vistos.has(rtn))) { mapCli.set(c.id, porRtn.get(rtn) ?? [...nuevosCli].find((n) => n.rtn === rtn).id); continue; }
        if (rtn) vistos.add(rtn);
        mapCli.set(c.id, c.id);
        nuevosCli.push({ id: c.id, nombre: c.nombre, rtn, direccion: c.direccion, telefono: c.telefono, correo: c.email, exento: c.exento_impuestos });
      }
      cuenta('clientes', await insertar(
        `insert into core.terceros (id, nombre, rtn, direccion, telefono, correo, exento_impuestos, es_cliente)
         select x.id, x.nombre, x.rtn, x.direccion, x.telefono, x.correo, x.exento, true
           from jsonb_to_recordset($1::jsonb) as x(id uuid, nombre text, rtn text, direccion text, telefono text, correo text, exento boolean)
         on conflict do nothing`, nuevosCli), clientes.length);

      // ── 5. Formas de pago (por nombre) ──────────────────────────────────────────────────────
      const fps = await leer('select * from public.formas_pago');
      const mapFp = new Map();
      for (const f of fps) {
        let d = (await q.query('select id from pos.formas_pago where empresa_id = $1 and lower(nombre) = lower($2)', [E, f.nombre])).rows[0];
        if (!d) {
          const tipo = /efectivo/i.test(f.nombre) ? 'efectivo' : /tarjeta|visa|master|credomatic|bac|ficohsa/i.test(f.nombre) ? 'tarjeta' : /transfer|deposito|depósito/i.test(f.nombre) ? 'transferencia' : 'otro';
          d = (await q.query('insert into pos.formas_pago (empresa_id, nombre, tipo, orden) values ($1,$2,$3,9) returning id', [E, f.nombre, tipo])).rows[0];
        }
        mapFp.set(f.id, d.id);
      }

      // ── 6. Puntos de emisión: solo en el corte (fiscal: true) ───────────────────────────────
      const pes = await leer('select * from public.puntos_emision where activo');
      const mapPe = new Map();
      for (const pe of pes) {
        const sid = mapSuc.get(pe.sucursal_id);
        if (!sid) continue;
        const dest = (await q.query('select id from pos.puntos_emision where sucursal_id = $1 and activo', [sid])).rows[0];
        if (!dest) continue;
        mapPe.set(pe.id, dest.id);
        if (fiscal) {
          await q.query(
            `update pos.puntos_emision set cai=$2, punto_emision_codigo=$3, punto_venta_codigo=$4, tipo_documento_codigo=$5, correlativo_desde=$6, correlativo_hasta=$7,
                    correlativo_actual=$8, fecha_limite_emision=$9, es_borrador=$10 where id=$1`,
            [dest.id, pe.cai, pe.punto_emision_codigo, pe.punto_venta_codigo, pe.tipo_documento_codigo, pe.correlativo_desde, pe.correlativo_hasta, pe.correlativo_actual, pe.fecha_limite_emision, pe.es_borrador]);
        }
      }
      if (!fiscal && pes.some((p) => !p.es_borrador)) r.avisos.push('Hay CAI reales en el sistema anterior: NO se copiaron (use fiscal:true solo en el corte, con el sistema viejo detenido).');

      // ── 7. Ventas pagadas/anuladas, con su detalle y pagos ──────────────────────────────────
      const filtroFecha = desde ? 'and coalesce(v.fecha_emision, v.created_at) >= $1::date' : '';
      const ventas = await leer(`select v.* from public.ventas v where v.estado in ('pagada','anulada') ${filtroFecha} order by v.created_at`, desde ? [desde] : []);
      const idsVenta = new Set(ventas.map((v) => v.id));
      const filasVenta = ventas.filter((v) => mapSuc.has(v.sucursal_id)).map((v) => ({
        id: v.id, sucursal_id: mapSuc.get(v.sucursal_id), punto_emision_id: mapPe.get(v.punto_emision_id) ?? null, numero_orden: v.numero_orden,
        numero_factura: v.numero_factura, correlativo: v.correlativo, cliente_id: mapCli.get(v.cliente_id) ?? cf, cajero_id: mapUsr.get(v.cajero_id) ?? null,
        tipo_orden: v.tipo_orden === 'para_llevar' ? 'llevar' : 'aqui', estado: v.anulada || v.estado === 'anulada' ? 'anulada' : 'pagada',
        exento: v.subtotal_exento, exonerado: v.subtotal_exonerado, g15: v.subtotal_gravado_15, descuento: v.descuento, dpct: [0, 10, 25].includes(Number(v.descuento_porcentaje)) ? Number(v.descuento_porcentaje) : 0,
        isv: v.isv_total, total: v.total, recibido: v.efectivo_recibido, cambio: v.cambio, borrador: String(v.numero_factura ?? '').startsWith('BORRADOR-'),
        fecha_emision: v.fecha_emision, created_at: v.created_at, nota: v.nota_interna, te_nombre: v.tercera_edad_nombre, te_id: v.tercera_edad_identidad,
        correo_enviado: v.correo_enviado, correo_error: v.correo_error, impresiones: v.impresiones ?? 0, reimpresiones: v.reimpresiones ?? 0,
      }));
      const nVentas = await insertar(
        `insert into pos.ventas (id, empresa_id, sucursal_id, punto_emision_id, numero_orden, numero_factura, correlativo, cliente_id, cajero_id, tipo_orden, estado, estado_prep,
                                 subtotal_exento, subtotal_exonerado, subtotal_gravado_15, descuento, descuento_porcentaje, isv_total, total, efectivo_recibido, cambio,
                                 es_borrador_fiscal, fecha_emision, created_at, nota_interna, tercera_edad_nombre, tercera_edad_identidad, correo_enviado, correo_error,
                                 impresiones, reimpresiones, motivo_anulacion, origen_legado)
         select x.id, '${E}', x.sucursal_id, x.punto_emision_id, x.numero_orden, x.numero_factura, x.correlativo, x.cliente_id, x.cajero_id, x.tipo_orden, x.estado, 'entregado',
                coalesce(x.exento,0), coalesce(x.exonerado,0), coalesce(x.g15,0), coalesce(x.descuento,0), x.dpct, coalesce(x.isv,0), x.total, x.recibido, x.cambio,
                x.borrador, x.fecha_emision, x.created_at, x.nota, x.te_nombre, x.te_id, coalesce(x.correo_enviado,false), x.correo_error,
                x.impresiones, x.reimpresiones, case when x.estado = 'anulada' then 'Anulada en el sistema anterior' end, '${ORIGEN}'
           from jsonb_to_recordset($1::jsonb) as x(id uuid, sucursal_id uuid, punto_emision_id uuid, numero_orden bigint, numero_factura text, correlativo bigint, cliente_id uuid, cajero_id uuid,
                tipo_orden text, estado text, exento numeric, exonerado numeric, g15 numeric, descuento numeric, dpct int, isv numeric, total numeric, recibido numeric, cambio numeric,
                borrador boolean, fecha_emision timestamptz, created_at timestamptz, nota text, te_nombre text, te_id text, correo_enviado boolean, correo_error text, impresiones int, reimpresiones int)
         on conflict do nothing`, filasVenta);
      cuenta('ventas', nVentas, ventas.length);

      const importables = new Set(filasVenta.map((v) => v.id));
      const idsLista = [...importables];
      let detalles = [], pagos = [];
      for (let i = 0; i < idsLista.length; i += 2000) {
        const ids = idsLista.slice(i, i + 2000);
        detalles = detalles.concat(await leer('select * from public.detalle_venta where venta_id = any($1::uuid[])', [ids]));
        pagos = pagos.concat(await leer('select * from public.venta_pagos where venta_id = any($1::uuid[])', [ids]));
      }
      const porVenta = new Map();
      const filasDet = detalles.map((d) => {
        const n = (porVenta.get(d.venta_id) ?? 0) + 1; porVenta.set(d.venta_id, n);
        return { id: d.id, venta_id: d.venta_id, producto_id: prodsDestino.has(d.producto_id) ? d.producto_id : null, nombre: d.nombre_producto, cantidad: d.cantidad, precio: d.precio_unitario,
          descuento: d.descuento ?? 0, dpct: [0, 10, 25].includes(Number(d.descuento_porcentaje)) ? Number(d.descuento_porcentaje) : 0, tasa: d.impuesto_tasa, monto: d.monto, orden: n };
      });
      cuenta('detalle_venta', await insertar(
        `insert into pos.detalle_venta (id, venta_id, producto_id, nombre_producto, cantidad, precio_base, precio_unitario, descuento, descuento_porcentaje, impuesto_tasa, monto, orden)
         select x.id, x.venta_id, x.producto_id, x.nombre, x.cantidad, x.precio, x.precio, x.descuento, x.dpct, x.tasa, x.monto, x.orden
           from jsonb_to_recordset($1::jsonb) as x(id uuid, venta_id uuid, producto_id uuid, nombre text, cantidad numeric, precio numeric, descuento numeric, dpct int, tasa numeric, monto numeric, orden int)
         on conflict do nothing`, filasDet), detalles.length);
      cuenta('venta_pagos', await insertar(
        `insert into pos.venta_pagos (id, venta_id, forma_pago_id, monto)
         select x.id, x.venta_id, x.forma_pago_id, x.monto from jsonb_to_recordset($1::jsonb) as x(id uuid, venta_id uuid, forma_pago_id uuid, monto numeric) on conflict do nothing`,
        pagos.filter((p) => mapFp.has(p.forma_pago_id)).map((p) => ({ id: p.id, venta_id: p.venta_id, forma_pago_id: mapFp.get(p.forma_pago_id), monto: p.monto }))), pagos.length);

      // Consecutivo del día (para llamar al cliente) y secuencia de órdenes sin choques con lo importado.
      await q.query(
        `update pos.ventas v set ticket_dia = t.n from (
           select id, row_number() over (partition by sucursal_id, (coalesce(fecha_emision, created_at) at time zone 'America/Tegucigalpa')::date order by created_at) as n
             from pos.ventas where origen_legado = $1) t where v.id = t.id and v.ticket_dia = 0`, [ORIGEN]);
      await q.query(`select setval('pos.ventas_numero_orden_seq', greatest((select coalesce(max(numero_orden), 1) from pos.ventas), 1))`);

      // ── 8. Cierres de caja → turnos cerrados, y se enlazan sus ventas ───────────────────────
      const cierres = (await leer(`select * from public.cierres_caja where estado = 'cerrado'`)).filter((c) => mapSuc.has(c.sucursal_id));
      let sinCajero = 0;
      const filasT = [];
      for (const c of cierres) {
        const cajero = mapUsr.get(c.cajero_id) ?? mapUsr.get(c.elaboro_id);
        if (!cajero) { sinCajero += 1; continue; }
        filasT.push({ id: c.id, sucursal_id: mapSuc.get(c.sucursal_id), cajero_id: cajero, cerrado_por: mapUsr.get(c.elaboro_id) ?? cajero, abierto: c.fecha_inicio, cerrado: c.fecha_fin,
          fondo: c.fondo_caja ?? 0, contado: c.efectivo_contado, esperado: c.efectivo_sistema ?? c.total_esperado, dif: c.diferencia_efectivo ?? c.diferencia, tarjeta: c.tarjeta_sistema,
          transf: c.transferencia_sistema, total: c.total_ventas, facturas: c.cantidad_facturas, desde: c.factura_desde, hasta: c.factura_hasta, obs: c.observaciones,
          bac: c.pos_bac, fico: c.pos_ficohsa, desglose: c.desglose_pagos ?? null, salidas: c.salidas ?? 0, propinas: c.propinas ?? 0 });
      }
      if (sinCajero) r.avisos.push(`${sinCajero} cierre(s) sin cajero identificable no se importaron.`);
      cuenta('turnos (cierres)', await insertar(
        `insert into pos.turnos (id, empresa_id, sucursal_id, cajero_id, abierto_at, fondo_inicial, cerrado_at, cerrado_por, efectivo_contado, efectivo_esperado, diferencia, tarjeta_sistema,
                                transferencia_sistema, total_ventas, cantidad_facturas, factura_desde, factura_hasta, observaciones, pos_bac, pos_ficohsa, desglose_pagos, salidas, propinas, estado, origen_legado)
         select x.id, '${E}', x.sucursal_id, x.cajero_id, x.abierto, x.fondo, x.cerrado, x.cerrado_por, x.contado, x.esperado, x.dif, x.tarjeta, x.transf, x.total, x.facturas, x.desde, x.hasta,
                x.obs, x.bac, x.fico, x.desglose, x.salidas, x.propinas, 'cerrado', '${ORIGEN}'
           from jsonb_to_recordset($1::jsonb) as x(id uuid, sucursal_id uuid, cajero_id uuid, cerrado_por uuid, abierto timestamptz, cerrado timestamptz, fondo numeric, contado numeric, esperado numeric,
                dif numeric, tarjeta numeric, transf numeric, total numeric, facturas int, desde text, hasta text, obs text, bac numeric, fico numeric, desglose jsonb, salidas numeric, propinas numeric)
         on conflict do nothing`, filasT), cierres.length);
      await q.query(
        `update pos.ventas v set turno_id = (
            select t.id from pos.turnos t where t.origen_legado = $1 and t.sucursal_id = v.sucursal_id and v.fecha_emision between t.abierto_at and t.cerrado_at order by t.abierto_at desc limit 1)
          where v.origen_legado = $1 and v.turno_id is null and v.fecha_emision is not null`, [ORIGEN]);

      // ── 9. Notas de crédito y bitácora antigua ──────────────────────────────────────────────
      const ncs = (await leer('select * from public.notas_credito')).filter((n) => importables.has(n.venta_id));
      cuenta('notas_credito', await insertar(
        `insert into pos.notas_credito (id, empresa_id, venta_id, numero_nota, motivo, monto, usuario_id, created_at)
         select x.id, '${E}', x.venta_id, x.numero_nota, x.motivo, x.monto, x.usuario_id, x.created_at
           from jsonb_to_recordset($1::jsonb) as x(id uuid, venta_id uuid, numero_nota text, motivo text, monto numeric, usuario_id uuid, created_at timestamptz) on conflict do nothing`,
        ncs.map((n) => ({ id: n.id, venta_id: n.venta_id, numero_nota: n.numero_nota, motivo: n.motivo, monto: n.monto, usuario_id: mapUsr.get(n.usuario_id) ?? null, created_at: n.created_at }))), ncs.length);

      const aud = await leer('select a.*, s.nombre as sucursal_nombre from public.auditoria a left join public.sucursales s on s.id = a.sucursal_id order by a.id');
      cuenta('auditoria (archivo)', await insertar(
        `insert into core.auditoria_legado (origen, id, created_at, usuario_nombre, accion, entidad, entidad_id, sucursal_nombre, detalle, ip, hash)
         select '${ORIGEN}', x.id, x.created_at, x.usuario_nombre, x.accion, x.entidad, x.entidad_id, x.sucursal_nombre, x.detalle, x.ip, x.hash
           from jsonb_to_recordset($1::jsonb) as x(id bigint, created_at timestamptz, usuario_nombre text, accion text, entidad text, entidad_id text, sucursal_nombre text, detalle jsonb, ip text, hash text)
         on conflict do nothing`, aud), aud.length);

      const cc = Number((await leer('select count(*)::int as n from public.caja_chica'))[0]?.n ?? 0);
      if (cc) r.avisos.push(`${cc} movimientos de caja chica NO se importaron (se revisarán con el contador antes de llevarlos a Finanzas).`);
      if (idsVenta.size !== filasVenta.length) r.avisos.push(`${idsVenta.size - filasVenta.length} venta(s) de sucursales desconocidas se omitieron.`);

      if (!aplicar) throw new Ensayo();
    });
  } catch (e) {
    if (!(e instanceof Ensayo)) throw e;
  }
  return r;
}

// Uso: LEGACY_DATABASE_URL=… DATABASE_URL=… node src/migracion/italo-facturacion.js [--aplicar] [--fiscal] [--desde=2026-01-01]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const config = leerConfig();
  if (!process.env.LEGACY_DATABASE_URL) { console.error('Falta LEGACY_DATABASE_URL (la base de italo-facturacion, solo lectura).'); process.exit(1); }
  const origen = await abrirDb({ driver: 'pg', databaseUrl: process.env.LEGACY_DATABASE_URL });
  const destino = await abrirDb(config);
  const aplicar = args.includes('--aplicar');
  console.log(aplicar ? 'APLICANDO importación…' : 'ENSAYO (no se guarda nada). Usa --aplicar para guardar.');
  try {
    const res = await importarItaloFacturacion({
      origen, destino, aplicar, fiscal: args.includes('--fiscal'), desde: args.find((a) => a.startsWith('--desde='))?.split('=')[1] ?? null, log: console.log });
    console.log(JSON.stringify({ modo: res.modo, fiscal: res.fiscal, usuarios_sin_pin_ni_contraseña: res.usuarios_sin_acceso, avisos: res.avisos }, null, 2));
  } catch (e) { console.error('Falló la importación (no se guardó nada):', e.message); process.exitCode = 1; }
  await origen.close(); await destino.close();
}
