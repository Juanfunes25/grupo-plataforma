// Lectura de datos para los cálculos de reposición (portado de los «…DeDatos» del original).
// Los cálculos puros viven en ./lib (idénticos al original); aquí solo se arman sus entradas
// desde Postgres, siempre por empresa. Lo que pertenece a otros módulos (producción, RRHH,
// inventario) se lee en modo «si existe»: si la tabla aún no está o cambió, devuelve [] y la
// pantalla/auditoría lo dice como «sin datos» en vez de fallar.
import { armarRotacion } from './lib/rotacion.js';
import { armarRecomendacion } from './lib/recomendacionDespacho.js';
import { sumarDias } from './lib/gerente/nucleo.js';
import { ESTADOS_ENTREGADOS } from './lib/rotacion.js';
import { armarBase } from './lib/gerente/simulador.js';
import { armarConsumo } from './lib/consumo.js';
import { cargarPrecios, cargarRecetas, costoKgReceta, indiceRecetaPorSabor } from '../prod/costeo.js';

/** Ejecuta una lectura opcional: [] si la tabla de otro módulo todavía no existe o no coincide. */
export async function opcional(q, sql, params = []) {
  try { return (await q.query(sql, params)).rows; } catch { return []; }
}

export async function existeTabla(q, nombre) {
  try { return (await q.query('select to_regclass($1) is not null as ok', [nombre])).rows[0].ok; } catch { return false; }
}

/** Sucursales fuera del análisis de demanda (Los Andes) y cerradas, de ESTA empresa. */
export async function analisisDe(q, empresaId) {
  const { rows } = await q.query(
    `select s.id, s.nombre, coalesce(c.fuera_de_analisis,false) as fuera, coalesce(c.cerrada,false) as cerrada, c.motivo_exclusion as motivo
       from core.sucursales s left join rep.sucursal_config c on c.sucursal_id = s.id
      where s.empresa_id = $1`, [empresaId]);
  return {
    fuera: rows.filter((r) => r.fuera).map((r) => r.id),
    cerradas: rows.filter((r) => r.cerrada).map((r) => r.id),
    excluidas: rows.filter((r) => r.fuera).map((r) => ({ id: r.id, nombre: r.nombre, motivo: r.motivo || '' })),
  };
}

/** Producciones (tandas) del rango, de la tabla de Producción (R2) si existe. */
export async function produccionesRango(q, empresaId, desde, hasta) {
  return opcional(q,
    `select p.id, p.sabor_id, p.fecha::text as fecha, p.kg::float8 as kg, sa.nombre as sabor_nombre
       from prod.producciones p join rep.sabores sa on sa.id = p.sabor_id
      where p.empresa_id = $1 and p.fecha between $2 and $3`, [empresaId, desde, hasta]);
}

export async function rotacionDeSabores(q, empresaId, { desde, hasta, hoy }) {
  const [despachos, producciones, sinStock] = await Promise.all([
    q.query(
      `select d.fecha::text as fecha, d.sucursal_id, d.sabor_id, d.panas, d.gramos_enviados, d.estado,
              sa.nombre as sabor_nombre, su.nombre as sucursal_nombre
         from rep.despachos d join rep.sabores sa on sa.id = d.sabor_id join core.sucursales su on su.id = d.sucursal_id
        where d.empresa_id = $1 and d.fecha between $2 and $3`, [empresaId, desde, hasta]).then((r) => r.rows),
    produccionesRango(q, empresaId, desde, hasta),
    q.query(
      `select d.sabor_id, count(*)::int as veces, sa.nombre as sabor_nombre
         from rep.despachos d join rep.sabores sa on sa.id = d.sabor_id
        where d.empresa_id = $1 and d.fecha between $2 and $3 and d.estado = 'no_disponible'
        group by d.sabor_id, sa.nombre`, [empresaId, desde, hasta]).then((r) => r.rows),
  ]);
  // Mismo formato que el original: producciones agrupadas por sabor.
  const kgPorSabor = new Map();
  for (const p of producciones) {
    const k = kgPorSabor.get(p.sabor_id) || { sabor_id: p.sabor_id, sabor_nombre: p.sabor_nombre, kg: 0 };
    k.kg += Number(p.kg) || 0;
    kgPorSabor.set(p.sabor_id, k);
  }
  return { desde, hasta, ...armarRotacion({ despachos, producciones: [...kgPorSabor.values()], sinStock, hoy }) };
}

export async function recomendacionDespachoDeDatos(q, empresaId, { desde, hasta, hoy = null }) {
  const an = await analisisDe(q, empresaId);
  const fuera = an.fuera;
  const [despachos, pesajes] = await Promise.all([
    q.query(
      `select d.fecha::text as fecha, d.sucursal_id, d.sabor_id, d.gramos_enviados, d.estado,
              sa.nombre as sabor_nombre, sa.gramos_pana, su.nombre as sucursal_nombre
         from rep.despachos d join rep.sabores sa on sa.id = d.sabor_id join core.sucursales su on su.id = d.sucursal_id
        where d.empresa_id = $1 and d.fecha between $2 and $3 and d.sucursal_id <> all($4::uuid[])
        order by d.fecha`, [empresaId, desde, hasta, fuera]).then((r) => r.rows),
    // Ordenado por creación para quedarse con el ÚLTIMO pesaje de cada noche (el del cierre).
    q.query(
      `select sucursal_id, sabor_id, fecha::text as fecha, gramos::float8 as gramos
         from rep.pesajes where empresa_id = $1 and fecha between $2 and $3 and sucursal_id <> all($4::uuid[])
        order by created_at`, [empresaId, desde, hasta, fuera]).then((r) => r.rows),
  ]);
  return {
    desde, hasta,
    // Se informan explícitamente: una tienda que no aparece tiene que ser una decisión visible.
    excluidas: an.excluidas,
    hoy: hoy || hasta,
    ...armarRecomendacion({ despachos, pesajes, hasta, hoy }),
  };
}

/** Lo que se despachó (entregado) en los últimos 28 días por sucursal, para calibrar el simulador. */
export async function enviadosPorSucursal(q, empresaId, desde, hasta) {
  const { rows } = await q.query(
    `select sucursal_id, sum(gramos_enviados)::float8 as gramos from rep.despachos
      where empresa_id = $1 and fecha >= $2 and fecha <= $3 and estado = any($4::text[]) group by sucursal_id`,
    [empresaId, desde, hasta, ESTADOS_ENTREGADOS]);
  return rows;
}

export async function insumosMasDespachados(q, empresaId, { desde, hasta }) {
  const { rows } = await q.query(
    `select i.insumo_texto, i.enviado, p.sucursal_id, su.nombre as sucursal_nombre
       from rep.pedido_items i join rep.pedidos_insumos p on p.id = i.pedido_id join core.sucursales su on su.id = p.sucursal_id
      where p.empresa_id = $1 and p.fecha between $2 and $3`, [empresaId, desde, hasta]);
  return rows;
}

// ── Cobertura (RRHH) ────────────────────────────────────────────────────────────────────────

/** Empleados, horarios, vacaciones y marcaciones de la empresa, con la forma que espera el gerente. */
export async function datosPersonal(q, empresaId, desde) {
  const [empleados, horarios, vacaciones, marcaciones] = await Promise.all([
    opcional(q,
      `select e.id, trim(p.nombres || ' ' || p.apellidos) as nombre, e.sucursal_id,
              (e.estado <> 'baja' and e.fecha_salida is null) as activo, e.fecha_ingreso::text as fecha_ingreso
         from rrhh.empleados e join rrhh.personas p on p.id = e.persona_id where e.empresa_id = $1`, [empresaId]),
    opcional(q,
      `select h.empleado_id, ((h.dia_semana + 6) % 7)::int as dia_semana, coalesce(h.estado,'turno') as estado,
              to_char(h.entrada,'HH24:MI') as hora_inicio, to_char(h.salida,'HH24:MI') as hora_fin
         from rrhh.horarios h join rrhh.empleados e on e.id = h.empleado_id where e.empresa_id = $1`, [empresaId]),
    opcional(q,
      `select v.empleado_id, v.desde::text as fecha_inicio, v.hasta::text as fecha_fin, coalesce(v.dias, (v.hasta - v.desde + 1))::int as dias
         from rrhh.vacaciones v join rrhh.empleados e on e.id = v.empleado_id
        where e.empresa_id = $1 and v.estado in ('aprobada','tomada') and v.hasta >= $2`, [empresaId, desde]),
    opcional(q,
      `select m.empleado_id, m.sucursal_id, (m.marcada_at at time zone 'America/Tegucigalpa')::date::text as fecha, m.tipo,
              m.marcada_at as creado_en, m.verificacion, m.distancia_metros
         from rrhh.marcaciones m where m.empresa_id = $1 and m.marcada_at >= ($2::date)::timestamptz order by m.marcada_at`, [empresaId, desde]),
  ]);
  return { empleados, horarios, vacaciones, marcaciones };
}

export async function cargarDatosCobertura(q, empresaId, { hoy, diasHistoria }) {
  const desde = sumarDias(hoy, -diasHistoria);
  const [sucursales, personal, minimos, an] = await Promise.all([
    q.query('select id, nombre, activo as activa from core.sucursales where empresa_id = $1', [empresaId]).then((r) => r.rows),
    datosPersonal(q, empresaId, desde),
    q.query('select sucursal_id, dia_semana, minimo from rep.cobertura_minimos where empresa_id = $1', [empresaId]).then((r) => r.rows),
    analisisDe(q, empresaId),
  ]);
  return {
    datos: {
      hoy, sucursales, empleados: personal.empleados, horarios: personal.horarios, vacaciones: personal.vacaciones,
      marcaciones: personal.marcaciones.filter((m) => m.tipo === 'entrada'), cerradas: an.cerradas,
    },
    minimos,
  };
}

// ── Auditoría del gerente digital ───────────────────────────────────────────────────────────

export function entornoActual(env = process.env) {
  return {
    produccion: env.NODE_ENV === 'production',
    // El servidor se niega a arrancar en producción sin APP_JWT_SECRET: nunca es un hallazgo aquí.
    jwtSecret: true,
    tursoToken: true,
    gemini: Boolean(env.ANTHROPIC_API_KEY),
  };
}

export async function cargarDatosAuditoria(q, empresaId, { hoy, entorno = entornoActual() }) {
  const hace35 = sumarDias(hoy, -35);
  const hace60 = sumarDias(hoy, -60);
  const hace120 = sumarDias(hoy, -120);
  const [
    sucursales, sabores, pesajes, despachos, tandas, pedidos, itemsPedido, personal, an,
    producciones, consumos, insumos, precios, movimientos, lotes, incidencias, mantenimientos, geos,
  ] = await Promise.all([
    q.query(`select id, nombre, 'sucursal' as rol, activo as activa from core.sucursales where empresa_id = $1`, [empresaId]).then((r) => r.rows),
    q.query('select id, nombre, gramos_pana, activo from rep.sabores where empresa_id = $1', [empresaId]).then((r) => r.rows),
    q.query(`select sucursal_id, sabor_id, fecha::text as fecha, gramos::float8 as gramos, fuente, created_at as creado_en
               from rep.pesajes where empresa_id = $1 and fecha >= $2 order by fecha`, [empresaId, hace60]).then((r) => r.rows),
    q.query(`select id, fecha::text as fecha, sucursal_id, sabor_id, panas, gramos_enviados, estado, gramos_confirmados_recibidos::float8 as gramos_confirmados_recibidos,
                    panas_recibidas, discrepancia::int as discrepancia, discrepancia_resuelta::int as discrepancia_resuelta, enviado_en::text as enviado_en
               from rep.despachos where empresa_id = $1 and fecha >= $2`, [empresaId, hace60]).then((r) => r.rows),
    q.query(`select t.despacho_id, t.gramos::float8 as gramos from rep.despacho_tandas t join rep.despachos d on d.id = t.despacho_id
              where d.empresa_id = $1 and d.fecha >= $2`, [empresaId, hace60]).then((r) => r.rows),
    q.query(`select id, sucursal_id, fecha::text as fecha, estado, created_at as creado_en from rep.pedidos_insumos where empresa_id = $1 and fecha >= $2`, [empresaId, hace60]).then((r) => r.rows),
    q.query(`select it.pedido_id, it.preparado::int as preparado, it.enviado::int as enviado from rep.pedido_items it
               join rep.pedidos_insumos p on p.id = it.pedido_id where p.empresa_id = $1 and p.fecha >= $2`, [empresaId, hace60]).then((r) => r.rows),
    datosPersonal(q, empresaId, hace35),
    analisisDe(q, empresaId),
    // ── de otros módulos, si existen ──
    opcional(q, `select id, fecha::text as fecha, sabor_id, kg::float8 as kg, kg_restante::float8 as kg_restante, lote, operario
                   from prod.producciones where empresa_id = $1 and (fecha >= $2 or kg_restante > 0)`, [empresaId, hace120]),
    opcional(q, `select pc.produccion_id, p.fecha::text as fecha, p.sabor_id, pc.insumo_id, i.nombre as insumo_nombre, pc.cantidad_sugerida::float8 as cantidad_sugerida, pc.cantidad_real::float8 as cantidad_real
                   from prod.consumos pc join prod.producciones p on p.id = pc.produccion_id join prod.costeo_insumos i on i.id = pc.insumo_id
                  where p.empresa_id = $1 and p.fecha >= $2`, [empresaId, hace120]),
    opcional(q, `select id, nombre, tipo, unidad, categoria, stock_actual::float8 as stock_actual, stock_minimo::float8 as stock_minimo, es_equipo, peso_unitario::float8 as peso_unitario, stock_actualizado_en
                   from rinv.insumos_fab where empresa_id = $1 and activo`, [empresaId]),
    opcional(q, `select p.id, p.insumo_id, p.fecha_vigencia::text as fecha_vigencia, p.lps_kg::float8 as lps_kg from prod.costeo_precios p where p.empresa_id = $1`, [empresaId]),
    opcional(q, `select id, insumo_fab_id as insumo_id, tipo, cantidad::float8 as cantidad, saldo_resultante::float8 as saldo_resultante, motivo, created_at as creado_en
                   from rinv.movimientos where empresa_id = $1 and ambito = 'fabrica' and created_at >= $2::date`, [empresaId, hace120]),
    opcional(q, `select l.id, l.insumo_id, i.nombre as insumo_nombre, i.unidad, l.cantidad_restante::float8 as cantidad_restante, l.fecha_ingreso::text as fecha_ingreso, l.fecha_vencimiento::text as fecha_vencimiento
                   from rinv.lotes_mec3 l join rinv.insumos_fab i on i.id = l.insumo_id where l.empresa_id = $1 and l.cantidad_restante > 0`, [empresaId]),
    opcional(q, `select id, tipo, gravedad, sucursal_id, descripcion, estado, created_at as creado_en from rinv.incidencias where empresa_id = $1 and estado <> 'cerrada'`, [empresaId]),
    opcional(q, `select id, equipo, sucursal_id, fecha::text as fecha, listo from rinv.mantenimientos where empresa_id = $1 and not listo`, [empresaId]),
    opcional(q, `select g.sucursal_id, g.lat, g.lon, g.radio_metros from rrhh.sucursal_geo g join core.sucursales s on s.id = g.sucursal_id where s.empresa_id = $1`, [empresaId]),
  ]);
  const geo = new Map(geos.map((g) => [g.sucursal_id, g]));
  const itemsPorPedido = new Map();
  for (const it of itemsPedido) {
    if (!itemsPorPedido.has(it.pedido_id)) itemsPorPedido.set(it.pedido_id, []);
    itemsPorPedido.get(it.pedido_id).push({ preparado: it.preparado, enviado: it.enviado });
  }
  return {
    hoy,
    sucursales: sucursales.map((s) => ({ ...s, lat: geo.get(s.id)?.lat ?? null, lon: geo.get(s.id)?.lon ?? null, radio_metros: geo.get(s.id)?.radio_metros ?? 150 })),
    sabores, pesajes, despachos, tandas, producciones, consumos, insumos, precios, movimientos, lotes,
    pedidos: pedidos.map((p) => ({ ...p, items: itemsPorPedido.get(p.id) || [] })),
    empleados: personal.empleados, horarios: personal.horarios, vacaciones: personal.vacaciones, marcaciones: personal.marcaciones,
    incidencias, mantenimientos, entorno,
    fueraDeAnalisis: an.fuera, cerradas: an.cerradas,
  };
}

/** Costo por kg de cada sabor para el simulador, con el costeo de Producción (prod.*) a la fecha de hoy. */
export async function costosPorSabor(q, empresaId, hoy) {
  try {
    const [precios, recetas] = await Promise.all([cargarPrecios(q, empresaId), cargarRecetas(q, empresaId)]);
    const mapa = new Map();
    for (const [saborId, recetaId] of indiceRecetaPorSabor(recetas)) mapa.set(saborId, costoKgReceta(recetaId, hoy, recetas, precios));
    return mapa;
  } catch { return new Map(); }
}

/** La base del simulador, leída al día de hoy. */
export async function baseSimulador(q, empresaId, { hoy, dias = 90 }) {
  const desde = sumarDias(hoy, -dias);
  const [recomendacion, enviados, costos, an] = await Promise.all([
    recomendacionDespachoDeDatos(q, empresaId, { desde, hasta: hoy, hoy }),
    enviadosPorSucursal(q, empresaId, sumarDias(hoy, -28), hoy),
    costosPorSabor(q, empresaId, hoy),
    analisisDe(q, empresaId),
  ]);
  const realSemanalKg = new Map(enviados.map((r) => [r.sucursal_id, (Number(r.gramos) || 0) / 1000 / 4]));
  const base = armarBase({ recomendacion, costosPorSabor: costos, realSemanalKg });
  base.tiendas = base.tiendas.filter((t) => !an.cerradas.includes(t.sucursal_id) && !an.fuera.includes(t.sucursal_id));
  return base;
}

/** Consumo medido en vitrina por sucursal/sabor/día, cruzado con la venta del POS (solo lectura). `x` = { desde, hasta }. */
export async function consumoDeRango(q, empresaId, x) {
  const holgura = sumarDias(x.desde, -1);
  const [sucursales, sabores, pesajes, despachos, ventas] = await Promise.all([
    q.query(`select s.id, s.nombre, coalesce(c.fuera_de_analisis,false) as fuera_de_analisis from core.sucursales s left join rep.sucursal_config c on c.sucursal_id = s.id
              where s.empresa_id = $1 and s.activo and not coalesce(c.cerrada,false)`, [empresaId]).then((r) => r.rows),
    q.query('select id, nombre from rep.sabores where empresa_id = $1', [empresaId]).then((r) => r.rows),
    // el último pesaje de cada noche
    q.query(`select distinct on (sucursal_id, sabor_id, fecha) sucursal_id, sabor_id, fecha::text as fecha, gramos::float8 as gramos
               from rep.pesajes where empresa_id = $1 and fecha between $2 and $3 order by sucursal_id, sabor_id, fecha, created_at desc`, [empresaId, holgura, x.hasta]).then((r) => r.rows),
    q.query(`select sucursal_id, sabor_id, fecha::text as fecha, enviado_en::text as enviado_en, gramos_enviados, estado from rep.despachos
              where empresa_id = $1 and fecha between $2 and $3 and estado in ('enviado','recibido')`, [empresaId, sumarDias(holgura, -1), x.hasta]).then((r) => r.rows),
    // Venta del POS de Italo por tienda y día (hora de Honduras). Solo lectura; nada se escribe en pos.
    opcional(q, `select v.sucursal_id, ((v.fecha_emision at time zone 'America/Tegucigalpa')::date)::text as fecha, sum(v.total)::float8 as total, count(*)::int as n
                   from pos.ventas v where v.empresa_id = $1 and v.estado = 'pagada' and v.fecha_emision is not null
                    and (v.fecha_emision at time zone 'America/Tegucigalpa')::date between $2 and $3 group by 1, 2`, [empresaId, x.desde, x.hasta]),
  ]);
  return { ...armarConsumo({ desde: x.desde, hasta: x.hasta, pesajes, despachos, ventas, sucursales, sabores }), hayVentas: ventas.length > 0 };
}
