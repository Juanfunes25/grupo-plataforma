// Reporte completo de ventas (paridad con la pantalla Reportes de Italo Facturación):
// KPIs con comparativo contra el periodo anterior, días y horas (mapa de calor), sucursales, cajeros,
// clientes, productos y categorías, formas de pago, descuentos, ISV fiscal vs borrador con numeración emitida,
// libro de ventas, anulaciones y notas de crédito, y gastos de caja chica.
import { sumarDias } from '@grupo/shared';

const FECHA = (col) => `(${col} at time zone 'America/Tegucigalpa')::date`;
const n = (v) => Number(v ?? 0);
const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const pct = (parte, total) => (total > 0 ? r2((parte / total) * 100) : 0);
const redondear = (o) => { for (const k of Object.keys(o)) if (typeof o[k] === 'number' && !Number.isInteger(o[k])) o[k] = r2(o[k]); return o; };

/** Filtro común de ventas: empresa, sucursales permitidas, sucursal elegida y rango de fechas de Honduras. */
const filtroVentas = (col = 'v.fecha_emision') =>
  `v.empresa_id = $1 and ($2::uuid[] = '{}' or v.sucursal_id = any($2::uuid[])) and ($3::uuid is null or v.sucursal_id = $3) and ${FECHA(col)} between $4::date and $5::date`;

const diasEntre = (desde, hasta) => Math.round((Date.parse(hasta) - Date.parse(desde)) / 86400000) + 1;

/** KPIs de un rango (se usan para el periodo actual y el anterior, así son comparables). */
export async function kpisDeRango(q, a) {
  const args = [a.empresaId, a.sucursalIds, a.sucursalId, a.desde, a.hasta];
  const [t, u, nc] = await Promise.all([
    q.query(`select count(*) filter (where v.estado = 'pagada')::int as facturas, coalesce(sum(v.total) filter (where v.estado = 'pagada'),0)::numeric as ventas,
                    coalesce(sum(v.descuento) filter (where v.estado = 'pagada'),0)::numeric as descuentos, coalesce(sum(v.isv_total) filter (where v.estado = 'pagada'),0)::numeric as isv,
                    count(*) filter (where v.estado = 'anulada')::int as anuladas, coalesce(sum(v.total) filter (where v.estado = 'anulada'),0)::numeric as monto_anulado
               from pos.ventas v where v.estado in ('pagada','anulada') and ${filtroVentas()}`, args),
    q.query(`select coalesce(sum(d.cantidad),0)::numeric as unidades from pos.detalle_venta d join pos.ventas v on v.id = d.venta_id where v.estado = 'pagada' and ${filtroVentas()}`, args),
    q.query(`select coalesce(sum(nc.monto),0)::numeric as monto from pos.notas_credito nc join pos.ventas v on v.id = nc.venta_id
              where v.estado <> 'anulada' and ${filtroVentas('nc.created_at')}`, args),
  ]);
  const x = t.rows[0];
  return redondear({
    ventas_brutas: n(x.ventas) + n(x.descuentos), descuentos: n(x.descuentos), ventas: n(x.ventas), notas_credito: n(nc.rows[0].monto),
    ventas_netas: n(x.ventas) - n(nc.rows[0].monto), isv: n(x.isv), facturas: x.facturas, ticket_promedio: x.facturas ? n(x.ventas) / x.facturas : 0,
    unidades: n(u.rows[0].unidades), anuladas: x.anuladas, monto_anulado: n(x.monto_anulado),
  });
}

function sumar(mapa, clave, inicial, fn) { const acc = mapa.get(clave) ?? inicial(); fn(acc); mapa.set(clave, acc); }

/** ISV de un grupo de facturas con la numeración emitida por sucursal y serie (lo que pide el contador). */
function resumenFiscal(lista, notas) {
  const validas = lista.filter((v) => v.estado === 'pagada');
  const ncIsv = notas.reduce((s, nc) => s + (n(nc.venta_total) > 0 ? (n(nc.monto) * n(nc.venta_isv)) / n(nc.venta_total) : 0), 0);
  const rangos = new Map();
  for (const v of lista) {
    if (!v.numero_factura) continue;
    const serie = v.numero_factura.replace(/\d+$/, '');
    const corr = n(v.correlativo) || Number(v.numero_factura.match(/(\d+)$/)?.[1] ?? 0);
    sumar(rangos, `${v.sucursal_id}|${serie}`, () => ({ sucursal: v.sucursal, serie, min: corr, max: corr, emitidas: 0, anuladas: 0, ancho: (v.numero_factura.match(/(\d+)$/)?.[1] ?? '').length }), (x) => {
      x.min = Math.min(x.min, corr); x.max = Math.max(x.max, corr); x.emitidas += 1; if (v.estado === 'anulada') x.anuladas += 1;
    });
  }
  const listaRangos = [...rangos.values()].map(({ serie, min, max, ancho, ...x }) => ({
    ...x, desde: `${serie}${String(min).padStart(ancho, '0')}`, hasta: `${serie}${String(max).padStart(ancho, '0')}`,
    huecos: Math.max(0, max - min + 1 - x.emitidas),   // números del rango que no aparecen en estas fechas
  }));
  const porMes = new Map();
  for (const v of validas) {
    sumar(porMes, v.fecha.slice(0, 7), () => ({ mes: v.fecha.slice(0, 7), exento: 0, exonerado: 0, gravado_15: 0, gravado_18: 0, isv: 0, total: 0, facturas: 0 }), (m) => {
      m.exento += n(v.subtotal_exento); m.exonerado += n(v.subtotal_exonerado); m.gravado_15 += n(v.subtotal_gravado_15); m.gravado_18 += n(v.subtotal_gravado_18);
      m.isv += n(v.isv_total); m.total += n(v.total); m.facturas += 1;
    });
  }
  const suma = (k) => validas.reduce((s, v) => s + n(v[k]), 0);
  return {
    ...redondear({ exento: suma('subtotal_exento'), exonerado: suma('subtotal_exonerado'), gravado_15: suma('subtotal_gravado_15'), gravado_18: suma('subtotal_gravado_18'),
      isv: suma('isv_total'), total: suma('total'), notas_credito: notas.reduce((s, x) => s + n(x.monto), 0), isv_notas_credito: ncIsv }),
    isv_neto: r2(suma('isv_total') - ncIsv), facturas: validas.length, anuladas: lista.length - validas.length,
    rangos: listaRangos.sort((a, b) => a.sucursal.localeCompare(b.sucursal) || a.desde.localeCompare(b.desde)),
    por_mes: [...porMes.values()].map(redondear).sort((a, b) => a.mes.localeCompare(b.mes)),
  };
}

export async function reporteCompleto(q, { empresaId, sucursalIds = [], sucursalId = null, desde, hasta }) {
  const a = { empresaId, sucursalIds, sucursalId, desde, hasta };
  const args = [empresaId, sucursalIds, sucursalId, desde, hasta];
  const dias = diasEntre(desde, hasta);
  const ant = { ...a, desde: sumarDias(desde, -dias), hasta: sumarDias(desde, -1) };

  const [ventas, pagos, prods, cats, desc, clientes, notas, gastos, ingresos, kpis, kpisAnt] = await Promise.all([
    q.query(`select v.id, v.sucursal_id, s.nombre as sucursal, v.numero_factura, v.correlativo, v.estado, v.cliente_id, coalesce(v.cliente_nombre, t.nombre) as cliente, coalesce(v.cliente_rtn, t.rtn) as rtn, t.es_consumidor_final,
                    v.cajero_id, coalesce(u.nombre, 'Sin cajero') as cajero, v.subtotal_exento, v.subtotal_exonerado, v.subtotal_gravado_15, v.subtotal_gravado_18,
                    v.descuento, v.isv_total, v.total, v.es_borrador_fiscal as borrador, v.fecha_emision, v.motivo_anulacion,
                    ${FECHA('v.fecha_emision')}::text as fecha, extract(hour from v.fecha_emision at time zone 'America/Tegucigalpa')::int as hora,
                    (extract(isodow from v.fecha_emision at time zone 'America/Tegucigalpa')::int - 1) as dia
               from pos.ventas v join core.sucursales s on s.id = v.sucursal_id left join core.terceros t on t.id = v.cliente_id left join core.usuarios u on u.id = v.cajero_id
              where v.estado in ('pagada','anulada') and ${filtroVentas()} order by v.fecha_emision, v.correlativo`, args),
    // El monto de venta_pagos ya es neto del cambio: el efectivo no se infla.
    q.query(`select f.nombre, f.tipo, count(distinct v.id)::int as facturas, sum(p.monto)::numeric as monto from pos.venta_pagos p join pos.formas_pago f on f.id = p.forma_pago_id
               join pos.ventas v on v.id = p.venta_id where v.estado = 'pagada' and ${filtroVentas()} group by f.nombre, f.tipo order by 4 desc`, args),
    q.query(`select coalesce(d.producto_id::text, d.nombre_producto) as clave, max(d.nombre_producto) as nombre, coalesce(max(c.nombre), 'Sin categoría') as categoria,
                    sum(d.cantidad)::numeric as cantidad, sum(d.monto)::numeric as total, count(distinct d.venta_id)::int as facturas,
                    sum(d.costo_unitario * d.cantidad) filter (where d.costo_unitario is not null)::numeric as costo,
                    sum(d.monto) filter (where d.costo_unitario is not null)::numeric as venta_con_costo
               from pos.detalle_venta d join pos.ventas v on v.id = d.venta_id left join pos.productos p on p.id = d.producto_id left join pos.categorias c on c.id = p.categoria_id
              where v.estado = 'pagada' and ${filtroVentas()} group by 1 order by 5 desc`, args),
    q.query(`select coalesce(c.nombre, 'Sin categoría') as nombre, sum(d.cantidad)::numeric as cantidad, sum(d.monto)::numeric as total
               from pos.detalle_venta d join pos.ventas v on v.id = d.venta_id left join pos.productos p on p.id = d.producto_id left join pos.categorias c on c.id = p.categoria_id
              where v.estado = 'pagada' and ${filtroVentas()} group by 1 order by 3 desc`, args),
    q.query(`select coalesce(nullif(d.descuento_porcentaje, 0), v.descuento_porcentaje)::int as porcentaje, count(distinct v.id)::int as facturas, sum(d.descuento)::numeric as monto,
                    sum(d.monto)::numeric as ventas, sum(d.cantidad)::numeric as unidades
               from pos.detalle_venta d join pos.ventas v on v.id = d.venta_id where v.estado = 'pagada' and d.descuento > 0 and ${filtroVentas()} group by 1 order by 1`, args),
    q.query(`select max(coalesce(v.cliente_nombre, t.nombre)) as nombre, max(coalesce(v.cliente_rtn, t.rtn)) as rtn, count(*)::int as facturas, sum(v.total)::numeric as total, max(v.fecha_emision) as ultima
               from pos.ventas v join core.terceros t on t.id = v.cliente_id where v.estado = 'pagada' and not t.es_consumidor_final and ${filtroVentas()}
              group by t.id order by 4 desc limit 50`, args),
    q.query(`select nc.numero_nota, v.numero_factura, s.nombre as sucursal, v.sucursal_id, nc.created_at as fecha, nc.monto, nc.motivo, coalesce(u.nombre, '') as usuario,
                    (v.estado = 'anulada') as venta_anulada, v.total as venta_total, v.isv_total as venta_isv, v.es_borrador_fiscal as borrador
               from pos.notas_credito nc join pos.ventas v on v.id = nc.venta_id join core.sucursales s on s.id = v.sucursal_id left join core.usuarios u on u.id = nc.usuario_id
              where ${filtroVentas('nc.created_at')} order by nc.created_at`, args),
    q.query(`select coalesce(m.categoria, 'Sin categoría') as tipo, sum(m.monto)::numeric as monto, count(*)::int as movimientos from pos.movimientos_caja m
              where m.empresa_id = $1 and ($2::uuid[] = '{}' or m.sucursal_id = any($2::uuid[])) and ($3::uuid is null or m.sucursal_id = $3)
                and m.tipo = 'salida' and m.fecha between $4::date and $5::date group by 1 order by 2 desc`, args),
    q.query(`select coalesce(sum(m.monto),0)::numeric as monto from pos.movimientos_caja m
              where m.empresa_id = $1 and ($2::uuid[] = '{}' or m.sucursal_id = any($2::uuid[])) and ($3::uuid is null or m.sucursal_id = $3)
                and m.tipo = 'ingreso' and m.fecha between $4::date and $5::date`, args),
    kpisDeRango(q, a), kpisDeRango(q, ant),
  ]);

  const todas = ventas.rows;
  const validas = todas.filter((v) => v.estado === 'pagada');
  const total = validas.reduce((s, v) => s + n(v.total), 0);
  const porDia = new Map();
  const porHora = Array.from({ length: 24 }, (_, hora) => ({ hora, facturas: 0, total: 0 }));
  const calor = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  const porDiaSemana = Array.from({ length: 7 }, (_, dia) => ({ dia, facturas: 0, total: 0, fechas: new Set() }));
  const porSucursal = new Map();
  const porCajero = new Map();
  for (const v of todas) {
    const anulada = v.estado === 'anulada';
    sumar(porSucursal, v.sucursal_id, () => ({ sucursal_id: v.sucursal_id, nombre: v.sucursal, facturas: 0, total: 0, descuentos: 0, anuladas: 0, monto_anulado: 0 }), (s) => {
      if (anulada) { s.anuladas += 1; s.monto_anulado += n(v.total); } else { s.facturas += 1; s.total += n(v.total); s.descuentos += n(v.descuento); }
    });
    sumar(porCajero, v.cajero_id ?? 'x', () => ({ nombre: v.cajero, facturas: 0, total: 0, con_descuento: 0, descuentos: 0, anuladas: 0 }), (c) => {
      if (anulada) c.anuladas += 1; else { c.facturas += 1; c.total += n(v.total); if (n(v.descuento) > 0) { c.con_descuento += 1; c.descuentos += n(v.descuento); } }
    });
    if (anulada) continue;
    sumar(porDia, v.fecha, () => ({ fecha: v.fecha, dia_semana: v.dia, facturas: 0, total: 0, descuentos: 0 }), (d) => { d.facturas += 1; d.total += n(v.total); d.descuentos += n(v.descuento); });
    porHora[v.hora].facturas += 1; porHora[v.hora].total += n(v.total);
    calor[v.dia][v.hora] += n(v.total);
    porDiaSemana[v.dia].facturas += 1; porDiaSemana[v.dia].total += n(v.total); porDiaSemana[v.dia].fechas.add(v.fecha);
  }
  const totalFormas = pagos.rows.reduce((s, f) => s + n(f.monto), 0);
  const gastosTotal = gastos.rows.reduce((s, g) => s + n(g.monto), 0);
  const notasParciales = notas.rows.filter((x) => !x.venta_anulada);
  const fiscales = todas.filter((v) => !v.borrador);
  const borrador = todas.filter((v) => v.borrador);

  return {
    desde, hasta, dias, rango_anterior: { desde: ant.desde, hasta: ant.hasta },
    kpis, kpis_anterior: kpisAnt,
    por_dia: [...porDia.values()].map((d) => redondear({ ...d, ticket_promedio: d.facturas ? d.total / d.facturas : 0 })).sort((x, y) => x.fecha.localeCompare(y.fecha)),
    por_hora: porHora.map(redondear),
    calor: calor.map((fila) => fila.map(r2)),
    por_dia_semana: porDiaSemana.map(({ fechas, ...d }) => redondear({ ...d, dias: fechas.size, promedio_dia: fechas.size ? d.total / fechas.size : 0 })),
    por_sucursal: [...porSucursal.values()].map((s) => redondear({ ...s, ticket_promedio: s.facturas ? s.total / s.facturas : 0, participacion: pct(s.total, total) })).sort((x, y) => y.total - x.total),
    por_forma_pago: pagos.rows.map((f) => redondear({ nombre: f.nombre, tipo: f.tipo, monto: n(f.monto), facturas: f.facturas, participacion: pct(n(f.monto), totalFormas) })),
    por_cajero: [...porCajero.values()].map((c) => redondear({ ...c, ticket_promedio: c.facturas ? c.total / c.facturas : 0 })).sort((x, y) => y.total - x.total),
    productos: prods.rows.map((p) => redondear({
      nombre: p.nombre, categoria: p.categoria, cantidad: n(p.cantidad), total: n(p.total), facturas: p.facturas, precio_promedio: n(p.cantidad) ? n(p.total) / n(p.cantidad) : 0,
      participacion: pct(n(p.total), total), margen_pct: p.costo != null && n(p.venta_con_costo) > 0 ? ((n(p.venta_con_costo) - n(p.costo)) / n(p.venta_con_costo)) * 100 : null,
    })),
    por_categoria: cats.rows.map((c) => redondear({ nombre: c.nombre, cantidad: n(c.cantidad), total: n(c.total), participacion: pct(n(c.total), total) })),
    clientes: clientes.rows.map((c) => redondear({ nombre: c.nombre, rtn: c.rtn ?? '', facturas: c.facturas, total: n(c.total), ultima: c.ultima })),
    descuentos: desc.rows.map((d) => redondear({ porcentaje: d.porcentaje, facturas: d.facturas, monto: n(d.monto), ventas: n(d.ventas), unidades: n(d.unidades) })),
    anuladas: todas.filter((v) => v.estado === 'anulada').map((v) => ({
      numero_factura: v.numero_factura, fecha: v.fecha_emision, sucursal: v.sucursal, cliente: v.cliente ?? 'Consumidor Final', cajero: v.cajero, total: n(v.total), motivo: v.motivo_anulacion ?? '' })),
    notas_credito: notas.rows.map((x) => ({
      numero_nota: x.numero_nota, numero_factura: x.numero_factura ?? '', sucursal: x.sucursal, fecha: x.fecha, monto: n(x.monto), motivo: x.motivo, usuario: x.usuario,
      tipo: x.venta_anulada ? 'Anulación total' : 'Parcial' })),
    isv: { fiscal: resumenFiscal(fiscales, notasParciales.filter((x) => !x.borrador)), borrador: resumenFiscal(borrador, notasParciales.filter((x) => x.borrador)) },
    gastos: redondear({ total: gastosTotal, movimientos: gastos.rows.reduce((s, g) => s + g.movimientos, 0), ingresos: n(ingresos.rows[0].monto) }),
    gastos_por_tipo: gastos.rows.map((g) => redondear({ tipo: g.tipo, monto: n(g.monto), movimientos: g.movimientos })),
    libro_ventas: todas.map((v) => ({
      fecha: v.fecha_emision, numero_factura: v.numero_factura, sucursal: v.sucursal, cliente: v.cliente ?? 'Consumidor Final', rtn: v.rtn ?? '', cajero: v.cajero,
      exento: n(v.subtotal_exento), exonerado: n(v.subtotal_exonerado), gravado_15: n(v.subtotal_gravado_15), gravado_18: n(v.subtotal_gravado_18), isv: n(v.isv_total),
      descuento: n(v.descuento), total: n(v.total), anulada: v.estado === 'anulada', borrador: v.borrador })),
  };
}
