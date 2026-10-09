// Estados financieros de UNA empresa: estado de resultados por sucursal, flujo de caja, cuentas por cobrar y por pagar,
// presupuesto vs real y saldos entre empresas. Funciones puras de lectura (reciben `q`: db o transacción) para que las use
// tanto Finanzas (una empresa) como Dirección (consolidado).
import { sumarDias } from '@grupo/shared';
import { diasEntre, r2, saldosPorRecepcion } from '../compras/calculo.js';

export const FECHA = (col) => `(${col} at time zone 'America/Tegucigalpa')::date`;
const SUC = (col, n) => `($${n}::uuid[] = '{}' or ${col} = any($${n}::uuid[]))`;
const SUC_NULO = (col, n) => `($${n}::uuid[] = '{}' or ${col} is null or ${col} = any($${n}::uuid[]))`;
const num = (v) => Number(v) || 0;

export const GRUPOS_GASTO = { costo_venta: 'Compras de mercadería', operativo: 'Operación', nomina: 'Planilla', alquiler: 'Alquiler', servicios: 'Servicios', marketing: 'Publicidad', impuestos: 'Impuestos y permisos', financiero: 'Financieros', otro: 'Otros', sin_categoria: 'Sin categoría' };

/** Primer y último día del mes de una fecha 'YYYY-MM-01' o 'YYYY-MM'. */
export function limitesMes(mes) {
  const ini = `${String(mes).slice(0, 7)}-01`;
  const d = new Date(Date.parse(`${ini}T00:00:00Z`));
  const fin = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  return { ini, fin, dias: Number(fin.slice(8)) };
}

// ─── Estado de resultados ──────────────────────────────────────────────────
/**
 * `resultadosEmpresa` (fin/rutas.js) da el total; aquí se le suma el detalle por sucursal y por categoría de gasto.
 * Los gastos sin sucursal quedan en «General (toda la empresa)».
 */
export async function estadoResultados(q, resultadosEmpresa, { empresaId, sucursalIds = [], desde, hasta }) {
  const total = await resultadosEmpresa(q, { empresaId, sucursalIds, desde, hasta });
  const sucs = (await q.query('select id, nombre, color from core.sucursales where empresa_id = $1 and activo order by orden, nombre', [empresaId])).rows
    .filter((s) => !sucursalIds.length || sucursalIds.includes(s.id));
  const porSucursal = [];
  for (const s of sucs) porSucursal.push({ id: s.id, nombre: s.nombre, color: s.color, ...(await resultadosEmpresa(q, { empresaId, sucursalIds, sucursalId: s.id, desde, hasta })) });
  const gastosSuc = r2(porSucursal.reduce((a, s) => a + s.gastos_operativos, 0));
  const general = { gastos_operativos: r2(total.gastos_operativos - gastosSuc) };
  const cats = (await q.query(
    `select c.id, coalesce(c.nombre, 'Sin categoría') as nombre, coalesce(c.grupo, 'sin_categoria') as grupo, sum(g.monto - g.isv)::float8 as monto, count(*)::int as n
       from fin.gastos g left join fin.categorias_gasto c on c.id = g.categoria_id
      where g.empresa_id = $1 and not g.anulado and g.fecha between $2::date and $3::date and ${SUC_NULO('g.sucursal_id', 4)}
      group by 1, 2, 3 order by 4 desc`, [empresaId, desde, hasta, sucursalIds])).rows;
  return { desde, hasta, total, sucursales: porSucursal, general, categorias: cats.map((c) => ({ ...c, monto: r2(c.monto) })) };
}

// ─── Flujo de caja ─────────────────────────────────────────────────────────
const PERIODO = { dia: (d) => `${d}::text`, semana: (d) => `date_trunc('week', ${d})::date::text`, mes: (d) => `to_char(${d}, 'YYYY-MM') || '-01'` };
const FORMA = { efectivo: 'Ventas en efectivo', tarjeta: 'Ventas con tarjeta', transferencia: 'Ventas por transferencia', otro: 'Ventas, otras formas' };

/**
 * Entradas: ventas cobradas por forma de pago (el crédito NO entra hasta que se abona), anticipos de cotizaciones aún sin facturar y
 * abonos a facturas a crédito. Salidas: gastos pagados, pagos a proveedores y compras de contado, compras directas de inventario
 * (las que no vienen de una orden) y salidas de caja chica. Las entradas de caja chica y los traslados no son ingresos del negocio.
 */
export async function flujoCaja(q, { empresaId, sucursalIds = [], desde, hasta, agrupar = 'mes' }) {
  const per = PERIODO[agrupar] ?? PERIODO.mes;
  const filas = [];     // { lado, concepto, periodo, monto }
  const agregar = (lado, rows, nombre) => rows.forEach((x) => filas.push({ lado, concepto: nombre(x), periodo: x.p, monto: num(x.monto) }));

  const fv = FECHA('v.fecha_emision');
  agregar('entrada', (await q.query(
    `select ${per(fv)} as p, fp.tipo, sum(vp.monto)::float8 as monto
       from pos.venta_pagos vp join pos.ventas v on v.id = vp.venta_id join pos.formas_pago fp on fp.id = vp.forma_pago_id
      where v.empresa_id = $1 and v.estado = 'pagada' and fp.tipo <> 'credito' and ${fv} between $2::date and $3::date and ${SUC('v.sucursal_id', 4)} group by 1, 2`, [empresaId, desde, hasta, sucursalIds])).rows,
  (x) => FORMA[x.tipo] ?? FORMA.otro);

  const fc = FECHA('p.created_at');
  agregar('entrada', (await q.query(
    `select ${per(fc)} as p, sum(p.monto)::float8 as monto from eco.cotizacion_pagos p join eco.cotizaciones c on c.id = p.cotizacion_id
      where c.empresa_id = $1 and c.estado = 'aprobada' and ${fc} between $2::date and $3::date and ${SUC_NULO('c.sucursal_id', 4)} group by 1`, [empresaId, desde, hasta, sucursalIds])).rows,
  () => 'Anticipos de cotizaciones por facturar');

  agregar('entrada', (await q.query(
    `select ${per('a.fecha')} as p, sum(a.monto)::float8 as monto from fin.abonos_credito a join pos.ventas v on v.id = a.venta_id
      where a.empresa_id = $1 and not a.anulado and a.fecha between $2::date and $3::date and ${SUC('v.sucursal_id', 4)} group by 1`, [empresaId, desde, hasta, sucursalIds])).rows,
  () => 'Cobros de facturas a crédito');

  // Salidas
  agregar('salida', (await q.query(
    `select ${per('coalesce(g.pagado_at, g.fecha)')} as p, coalesce(c.grupo, 'sin_categoria') as grupo, sum(g.monto)::float8 as monto
       from fin.gastos g left join fin.categorias_gasto c on c.id = g.categoria_id
      where g.empresa_id = $1 and not g.anulado and g.pagado and coalesce(g.pagado_at, g.fecha) between $2::date and $3::date and ${SUC_NULO('g.sucursal_id', 4)} group by 1, 2`, [empresaId, desde, hasta, sucursalIds])).rows,
  (x) => `Gastos: ${GRUPOS_GASTO[x.grupo] ?? x.grupo}`);

  agregar('salida', (await q.query(
    `select ${per('p.fecha')} as p, sum(p.monto_lps)::float8 as monto from cmp.pagos p where p.empresa_id = $1 and p.fecha between $2::date and $3::date group by 1`, [empresaId, desde, hasta])).rows,
  () => 'Pagos a proveedores (compras a crédito)');
  agregar('salida', (await q.query(
    `select ${per('r.fecha')} as p, sum(r.total_lps)::float8 as monto from cmp.recepciones r
      where r.empresa_id = $1 and r.vence_pago is null and r.fecha between $2::date and $3::date group by 1`, [empresaId, desde, hasta])).rows,
  () => 'Compras de contado (órdenes de compra)');

  agregar('salida', (await q.query(
    `select ${per('c.fecha')} as p, sum(c.total)::float8 as monto from inv.compras c where c.empresa_id = $1 and c.recepcion_id is null and c.fecha between $2::date and $3::date and ${SUC('c.sucursal_id', 4)} group by 1`,
    [empresaId, desde, hasta, sucursalIds])).rows, () => 'Compras directas de inventario');
  for (const tabla of ['fab.mov_insumos', 'dis.movimientos']) {
    agregar('salida', (await q.query(
      `select ${per(FECHA('m.created_at'))} as p, sum(m.cantidad * m.costo_unitario)::float8 as monto from ${tabla} m
        where m.empresa_id = $1 and m.tipo = 'compra' and m.recepcion_id is null and ${FECHA('m.created_at')} between $2::date and $3::date group by 1`, [empresaId, desde, hasta])).rows,
    () => 'Compras directas de inventario');
  }

  const fm = 'coalesce(m.fecha, ' + FECHA('m.created_at') + ')';
  agregar('salida', (await q.query(
    `select ${per(fm)} as p, sum(m.monto)::float8 as monto from pos.movimientos_caja m
      where m.empresa_id = $1 and m.tipo = 'salida' and ${fm} between $2::date and $3::date and ${SUC('m.sucursal_id', 4)} group by 1`, [empresaId, desde, hasta, sucursalIds])).rows,
  () => 'Caja chica (salidas de efectivo)');

  return armarFlujo(filas, { desde, hasta, agrupar });
}

/** Pura: ordena los renglones en periodos y conceptos, con totales y saldo acumulado. */
export function armarFlujo(filas, { desde, hasta, agrupar }) {
  const periodos = [...new Set(filas.map((f) => f.periodo))].sort();
  const bloque = (lado) => {
    const por = new Map();
    for (const f of filas.filter((x) => x.lado === lado)) {
      if (!por.has(f.concepto)) por.set(f.concepto, { concepto: f.concepto, total: 0, periodos: {} });
      const c = por.get(f.concepto);
      c.total = r2(c.total + f.monto);
      c.periodos[f.periodo] = r2((c.periodos[f.periodo] ?? 0) + f.monto);
    }
    return [...por.values()].sort((a, b) => b.total - a.total);
  };
  const entradas = bloque('entrada'), salidas = bloque('salida');
  let acum = 0;
  const serie = periodos.map((p) => {
    const e = r2(entradas.reduce((s, c) => s + (c.periodos[p] ?? 0), 0));
    const s = r2(salidas.reduce((a, c) => a + (c.periodos[p] ?? 0), 0));
    acum = r2(acum + e - s);
    return { periodo: p, entradas: e, salidas: s, neto: r2(e - s), acumulado: acum };
  });
  const te = r2(entradas.reduce((s, c) => s + c.total, 0)), ts = r2(salidas.reduce((s, c) => s + c.total, 0));
  return { desde, hasta, agrupar, periodos, entradas, salidas, serie, totales: { entradas: te, salidas: ts, neto: r2(te - ts) } };
}

// ─── Cuentas por cobrar ────────────────────────────────────────────────────
export const BUCKETS_COBRAR = ['0-30', '31-60', '61-90', '+90'];
export const bucketCobrar = (dias) => (dias <= 30 ? '0-30' : dias <= 60 ? '31-60' : dias <= 90 ? '61-90' : '+90');

/**
 * Por cobrar = facturas a crédito (forma de pago tipo «crédito») menos sus abonos + cotizaciones aprobadas de EcoStone/DISERCO con saldo
 * (estas últimas se leen de crm.cxc, la única fuente del módulo de Cobranza). La antigüedad cuenta los días desde la factura o la aprobación.
 */
export async function cuentasPorCobrar(q, { empresaId, sucursalIds = [], hoy }) {
  const fac = (await q.query(
    `select v.id, v.numero_factura, ${FECHA('v.fecha_emision')}::text as fecha, v.cliente_id, coalesce(t.nombre, v.nombre_orden, 'Cliente') as cliente, s.nombre as sucursal,
            sum(vp.monto)::float8 as total,
            coalesce((select sum(a.monto) from fin.abonos_credito a where a.venta_id = v.id and not a.anulado), 0)::float8 as abonado,
            coalesce(ce.dias_credito, 0) as dias_credito
       from pos.ventas v join pos.venta_pagos vp on vp.venta_id = v.id join pos.formas_pago fp on fp.id = vp.forma_pago_id and fp.tipo = 'credito'
       join core.sucursales s on s.id = v.sucursal_id left join core.terceros t on t.id = v.cliente_id left join eco.cliente_ext ce on ce.tercero_id = v.cliente_id
      where v.empresa_id = $1 and v.estado = 'pagada' and ${SUC('v.sucursal_id', 2)}
      group by v.id, t.nombre, s.nombre, ce.dias_credito`, [empresaId, sucursalIds])).rows;
  const items = [];
  for (const f of fac) {
    const saldo = r2(f.total - f.abonado);
    if (saldo <= 0.004) continue;
    const dias = Math.max(0, diasEntre(f.fecha, hoy));
    const vence = f.dias_credito ? sumarDias(f.fecha, f.dias_credito) : null;
    items.push({ tipo: 'factura', id: f.id, ref: f.numero_factura ?? 'Factura', cliente: f.cliente, cliente_id: f.cliente_id, sucursal: f.sucursal, fecha: f.fecha, vence, vencida: !!vence && vence < hoy,
      dias, total: r2(f.total), abonado: r2(f.abonado), saldo, bucket: bucketCobrar(dias) });
  }
  // Cotizaciones aprobadas con saldo: el cálculo vive una sola vez en la base (crm.cxc, módulo de Cobranza); aquí solo se lee.
  const cots = (await q.query(
    `select documento_id as id, documento as ref, nombre_cliente as cliente, tercero_id as cliente_id, fecha_documento::text as fecha, dias_atraso as dias, vencido,
            total::float8 as total, pagado::float8 as pagado, saldo::float8 as saldo, bucket
       from crm.cxc($2::date) where empresa_id = $1 and saldo > 0.004`, [empresaId, hoy])).rows;
  for (const c of cots) {
    items.push({ tipo: 'cotizacion', id: c.id, ref: c.ref, cliente: c.cliente, cliente_id: c.cliente_id, sucursal: null, fecha: c.fecha, vence: null, vencida: c.vencido, dias: c.dias,
      total: r2(c.total), abonado: r2(c.pagado), saldo: r2(c.saldo), bucket: c.bucket });
  }
  items.sort((a, b) => b.dias - a.dias);
  return { hoy, items, ...resumirCobrar(items) };
}

export function resumirCobrar(items) {
  const buckets = Object.fromEntries(BUCKETS_COBRAR.map((b) => [b, 0]));
  const porCliente = new Map();
  for (const i of items) {
    buckets[i.bucket] = r2(buckets[i.bucket] + i.saldo);
    const k = i.cliente_id ?? i.cliente;
    if (!porCliente.has(k)) porCliente.set(k, { cliente: i.cliente, cliente_id: i.cliente_id, saldo: 0, ...Object.fromEntries(BUCKETS_COBRAR.map((b) => [b, 0])) });
    const c = porCliente.get(k);
    c.saldo = r2(c.saldo + i.saldo); c[i.bucket] = r2(c[i.bucket] + i.saldo);
  }
  return { buckets, total: r2(items.reduce((s, i) => s + i.saldo, 0)), vencido: r2(items.filter((i) => i.vencida).reduce((s, i) => s + i.saldo, 0)), por_cliente: [...porCliente.values()].sort((a, b) => b.saldo - a.saldo) };
}

// ─── Cuentas por pagar ─────────────────────────────────────────────────────
export const BUCKETS_PAGAR = ['vencido', '0-7', '8-30', '+30'];
export const bucketPagar = (diasParaVencer) => (diasParaVencer < 0 ? 'vencido' : diasParaVencer <= 7 ? '0-7' : diasParaVencer <= 30 ? '8-30' : '+30');

/** Por pagar = recepciones de órdenes a crédito sin pagar del todo (pagos aplicados a la más vieja primero) + gastos registrados como «por pagar». */
export async function cuentasPorPagar(q, { empresaId, hoy }) {
  const items = [];
  const recs = (await q.query(
    `select r.id, r.orden_id, r.fecha::text as fecha, r.vence_pago::text as vence, r.documento, r.total_lps::float8 as total_lps, o.numero::int as numero, o.proveedor_id, t.nombre as proveedor
       from cmp.recepciones r join cmp.ordenes o on o.id = r.orden_id join core.terceros t on t.id = o.proveedor_id
      where r.empresa_id = $1 and r.vence_pago is not null order by r.fecha`, [empresaId])).rows;
  const pagos = new Map((await q.query('select orden_id, sum(monto_lps)::float8 as pagado from cmp.pagos where empresa_id = $1 group by 1', [empresaId])).rows.map((p) => [p.orden_id, p.pagado]));
  const porOrden = new Map();
  for (const r of recs) { if (!porOrden.has(r.orden_id)) porOrden.set(r.orden_id, []); porOrden.get(r.orden_id).push(r); }
  for (const [ordenId, rs] of porOrden) {
    for (const r of saldosPorRecepcion(rs, pagos.get(ordenId) ?? 0)) {
      const dv = diasEntre(hoy, r.vence);
      items.push({ tipo: 'orden', id: ordenId, ref: `OC-${r.numero}`, documento: r.documento, proveedor: r.proveedor, proveedor_id: r.proveedor_id, fecha: r.fecha, vence: r.vence, dias_para_vencer: dv, total: r2(r.total_lps), saldo: r.saldo, bucket: bucketPagar(dv) });
    }
  }
  const gastos = (await q.query(
    `select g.id, g.fecha::text as fecha, coalesce(g.vence, g.fecha)::text as vence, g.descripcion, g.documento, g.monto::float8 as monto, g.proveedor_id, coalesce(t.nombre, 'Sin proveedor') as proveedor
       from fin.gastos g left join core.terceros t on t.id = g.proveedor_id where g.empresa_id = $1 and not g.anulado and not g.pagado`, [empresaId])).rows;
  for (const g of gastos) {
    const dv = diasEntre(hoy, g.vence);
    items.push({ tipo: 'gasto', id: g.id, ref: g.descripcion, documento: g.documento, proveedor: g.proveedor, proveedor_id: g.proveedor_id, fecha: g.fecha, vence: g.vence, dias_para_vencer: dv, total: r2(g.monto), saldo: r2(g.monto), bucket: bucketPagar(dv) });
  }
  items.sort((a, b) => a.dias_para_vencer - b.dias_para_vencer);
  return { hoy, items, ...resumirPagar(items) };
}

export function resumirPagar(items) {
  const buckets = Object.fromEntries(BUCKETS_PAGAR.map((b) => [b, 0]));
  const porProv = new Map();
  for (const i of items) {
    buckets[i.bucket] = r2(buckets[i.bucket] + i.saldo);
    const k = i.proveedor_id ?? i.proveedor;
    if (!porProv.has(k)) porProv.set(k, { proveedor: i.proveedor, proveedor_id: i.proveedor_id, saldo: 0, vencido: 0 });
    const p = porProv.get(k);
    p.saldo = r2(p.saldo + i.saldo);
    if (i.bucket === 'vencido') p.vencido = r2(p.vencido + i.saldo);
  }
  return { buckets, total: r2(items.reduce((s, i) => s + i.saldo, 0)), vencido: buckets.vencido, por_proveedor: [...porProv.values()].sort((a, b) => b.saldo - a.saldo) };
}

// ─── Presupuesto vs real ───────────────────────────────────────────────────
/** Estado de una línea. Gasto: pasarse es malo; ventas: no llegar es malo. La proyección extrapola el ritmo del mes. */
export function estadoLinea({ tipo, presupuesto, real, proyeccion }) {
  if (!(presupuesto > 0)) return 'sin_presupuesto';
  if (tipo === 'gasto') return real > presupuesto ? 'excedido' : proyeccion > presupuesto ? 'riesgo' : 'ok';
  return real >= presupuesto ? 'ok' : proyeccion >= presupuesto ? 'ok' : proyeccion >= presupuesto * 0.9 ? 'riesgo' : 'bajo';
}

export async function presupuestoVsReal(q, resultadosEmpresa, { empresaId, mes, hoy, sucursalIds = [] }) {
  const { ini, fin, dias } = limitesMes(mes);
  const hasta = hoy < fin ? (hoy < ini ? ini : hoy) : fin;
  const transcurridos = hoy < ini ? 0 : hoy >= fin ? dias : Number(hoy.slice(8));
  const [pres, ventas, cats, reales] = await Promise.all([
    q.query('select clave, monto::float8 as monto from fin.presupuestos where empresa_id = $1 and mes = $2::date', [empresaId, ini]),
    resultadosEmpresa(q, { empresaId, sucursalIds, desde: ini, hasta }),
    q.query('select id, nombre, grupo from fin.categorias_gasto where empresa_id = $1 and activo order by grupo, nombre', [empresaId]),
    q.query(
      `select coalesce(g.categoria_id::text, 'sin_categoria') as clave, sum(g.monto - g.isv)::float8 as monto from fin.gastos g
        where g.empresa_id = $1 and not g.anulado and g.fecha between $2::date and $3::date and ${SUC_NULO('g.sucursal_id', 4)} group by 1`, [empresaId, ini, hasta, sucursalIds]),
  ]);
  const p = new Map(pres.rows.map((x) => [x.clave, x.monto]));
  const r = new Map(reales.rows.map((x) => [x.clave, x.monto]));
  const linea = (clave, nombre, grupo, tipo, real) => {
    const presupuesto = p.get(clave) ?? 0;
    const proyeccion = transcurridos > 0 ? r2((real / transcurridos) * dias) : 0;
    return { clave, nombre, grupo, tipo, presupuesto, real: r2(real), diferencia: r2(presupuesto - real), pct: presupuesto > 0 ? Math.round((real / presupuesto) * 1000) / 10 : null, proyeccion,
      estado: estadoLinea({ tipo, presupuesto, real, proyeccion }) };
  };
  const lineaVentas = linea('ventas', 'Ventas netas', 'ventas', 'ventas', ventas.ventas_netas);
  const lineas = cats.rows.map((c) => linea(c.id, c.nombre, c.grupo, 'gasto', r.get(c.id) ?? 0));
  if (r.get('sin_categoria')) lineas.push(linea('sin_categoria', 'Sin categoría', 'sin_categoria', 'gasto', r.get('sin_categoria')));
  const gp = r2(lineas.reduce((s, l) => s + l.presupuesto, 0)), gr = r2(lineas.reduce((s, l) => s + l.real, 0));
  return {
    mes: ini, dias, transcurridos, ventas: lineaVentas, gastos: lineas,
    totales: { gastos_presupuesto: gp, gastos_real: gr, resultado_presupuesto: r2(lineaVentas.presupuesto - gp), resultado_real: r2(lineaVentas.real - gr), hay_presupuesto: p.size > 0 },
  };
}

// ─── Saldos entre empresas ─────────────────────────────────────────────────
/**
 * La empresa «origen» le vendió o le cobra a la «destino» (que le debe). Pendiente = monto − pagado. Los saldos de un par se compensan:
 * si A le debe 100 a B y B le debe 30 a A, queda «A debe 70 a B».
 */
export function netearSaldos(ops) {
  const par = new Map();
  for (const o of ops) {
    const pend = r2(num(o.monto) - num(o.monto_pagado));
    if (pend <= 0.004) continue;
    const [a, b] = [o.empresa_origen_id, o.empresa_destino_id].sort();
    const k = `${a}|${b}`;
    if (!par.has(k)) par.set(k, { a, b, a_le_debe_a_b: 0, ops: 0, sin_conciliar: 0 });
    const x = par.get(k);
    // origen es acreedor: si origen = a, entonces b le debe a a.
    x.a_le_debe_a_b = r2(x.a_le_debe_a_b + (o.empresa_origen_id === b ? pend : -pend));
    x.ops += 1; if (o.estado !== 'conciliado') x.sin_conciliar += 1;
  }
  return [...par.values()].filter((x) => Math.abs(x.a_le_debe_a_b) > 0.004).map((x) => (
    x.a_le_debe_a_b > 0
      ? { deudor: x.a, acreedor: x.b, saldo: x.a_le_debe_a_b, operaciones: x.ops, sin_conciliar: x.sin_conciliar }
      : { deudor: x.b, acreedor: x.a, saldo: r2(-x.a_le_debe_a_b), operaciones: x.ops, sin_conciliar: x.sin_conciliar }));
}
