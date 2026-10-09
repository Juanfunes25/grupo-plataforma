// Adaptadores del inventario unificado: cada empresa guarda su inventario en sus propias tablas
// (Origen inv.*, Italo rinv.*, EcoStone fab.*, DISERCO dis.*). Un adaptador sabe LEER esas tablas con
// los mismos conceptos (existencia, mínimo, costo, vencimiento, estado) y MOVER stock usando las funciones
// y reglas que ya existen en cada módulo, sin cambiar sus pantallas.
//
// "fuente" identifica de dónde sale un ítem: inv · rinv_suc · rinv_fab · fab_insumo · fab_piedra · dis.
// Clave estable de un ítem: `${fuente}:${ref_id}:${sucursal_id|''}`.
import { fechaHN } from '@grupo/shared';
import { malaPeticion, noEncontrado } from '../../lib/http.js';
import { consumirLotesFifo, registrarLote } from '../rinv/util.js';
import { redondearSaldo, vencimientoDe } from '../rinv/calculo.js';

const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const SIN_SUC = '00000000-0000-0000-0000-000000000000';

export const FUENTES = {
  inv:        { nombre: 'Inventario de Origen',     traslado: true,  sucursal: true  },
  rinv_suc:   { nombre: 'Insumos de sucursal',      traslado: true,  sucursal: true  },
  rinv_fab:   { nombre: 'Materia prima de fábrica', traslado: true,  sucursal: false },
  fab_insumo: { nombre: 'Insumos de fabricación',   traslado: true,  sucursal: false },
  fab_piedra: { nombre: 'Piedra terminada',         traslado: false, sucursal: false },
  dis:        { nombre: 'Productos de DISERCO',     traslado: true,  sucursal: false },
};

/** Fuentes de inventario que corresponden a una empresa según los módulos que tiene encendidos. */
export function fuentesDe(empresa) {
  const m = empresa.modulos ?? [];
  if (m.includes('reposicion')) return ['rinv_suc', 'rinv_fab'];
  if (m.includes('fabrica')) return ['fab_insumo', 'fab_piedra'];
  if (m.includes('distribuidora')) return ['dis'];
  return ['inv'];
}

export const claveItem = (fuente, ref, suc) => `${fuente}:${ref}:${suc ?? ''}`;
const esPorPeso = (u) => ['kg', 'kilo', 'kilos', 'l', 'lt', 'litro', 'litros'].includes(String(u || '').trim().toLowerCase());

/** Estado uniforme de un ítem: negativo · agotado · bajo · ok · sin_cargar. */
export function estadoDe(existencia, minimo, sinCargar = false) {
  if (sinCargar) return 'sin_cargar';
  if (existencia < 0) return 'negativo';
  if (existencia === 0) return 'agotado';
  if (minimo != null && minimo > 0 && existencia <= minimo) return 'bajo';
  return 'ok';
}

const SQL_LISTA = {
  inv: `select i.id as ref_id, i.nombre, i.categoria, i.unidad, i.costo_actual as costo, i.stock_minimo as minimo,
               s.id as sucursal_id, s.nombre as sucursal,
               coalesce((select sum(m.cantidad) from inv.movimientos m where m.insumo_id = i.id and m.sucursal_id = s.id), 0) as existencia,
               (select min(l.vence_at) from inv.lotes l where l.insumo_id = i.id and l.sucursal_id = s.id and l.cantidad_actual > 0 and l.vence_at is not null) as vence
          from inv.insumos i cross join core.sucursales s
         where i.empresa_id = $1 and i.activo and s.empresa_id = $1 and s.activo order by i.nombre, s.orden`,
  rinv_suc: `select c.id as ref_id, c.nombre, c.categoria, c.unidad, null::numeric as costo, c.stock_minimo as minimo,
               s.id as sucursal_id, s.nombre as sucursal, coalesce(st.cantidad, 0) as existencia, null::date as vence
          from rep.insumos_catalogo c cross join core.sucursales s
          left join rinv.stock_suc st on st.insumo_id = c.id and st.sucursal_id = s.id
         where c.empresa_id = $1 and c.activo and not c.es_equipo and s.empresa_id = $1 and s.activo
           and not exists (select 1 from rep.sucursal_insumos si where si.sucursal_id = s.id and si.insumo_id = c.id and not si.activo)
         order by c.nombre, s.orden`,
  rinv_fab: `select f.id as ref_id, f.nombre, f.categoria, f.unidad, f.stock_actual as existencia, f.stock_minimo as minimo, f.peso_unitario,
               (select p.lps_kg from rinv.precios_fab p where p.insumo_id = f.id order by p.fecha_vigencia desc, p.n desc limit 1) as precio,
               (select min(l.fecha_vencimiento) from rinv.lotes_mec3 l where l.insumo_id = f.id and l.cantidad_restante > 0) as vence
          from rinv.insumos_fab f where f.empresa_id = $1 and f.activo and not f.es_equipo order by f.nombre`,
  fab_insumo: `select i.id as ref_id, i.nombre, i.categoria, i.unidad, i.costo_promedio as costo, i.stock_minimo as minimo,
               coalesce(s.stock, 0) as existencia, null::date as vence
          from fab.insumos i left join fab.stock_insumos s on s.insumo_id = i.id where i.empresa_id = $1 and i.activo order by i.nombre`,
  fab_piedra: `select l.id as ref_id, p.nombre || ' · lote ' || l.codigo || ' (' || l.calidad || ')' as nombre, 'Piedra' as categoria, 'cajas' as unidad,
               l.costo_m2 as costo, null::numeric as minimo, l.cantidad_disponible as existencia, null::date as vence
          from fab.lotes l join pos.productos p on p.id = l.producto_id
         where l.empresa_id = $1 and l.estado = 'lista' order by p.nombre, l.codigo`,
  dis: `select p.id as ref_id, p.nombre, c.nombre as categoria, coalesce(p.unidad, 'u') as unidad, e.costo_estandar as costo, p.stock_minimo as minimo,
               coalesce(x.existencia, 0) as existencia, null::date as vence
          from pos.productos p join dis.producto_ext e on e.producto_id = p.id left join dis.existencias x on x.producto_id = p.id
          left join pos.categorias c on c.id = p.categoria_id
         where p.empresa_id = $1 and p.activo and e.controla_inventario order by p.nombre`,
};

/**
 * Lista unificada de ítems de una empresa. `ctx`: { empresa:{id,modulos}, sucursalIds:[], costos:boolean }.
 * El costo y el valor solo salen si `costos` es true (quien ve inventario no siempre debe ver cuánto cuesta).
 */
export async function listarItems(q, ctx, filtros = {}) {
  const fuentes = fuentesDe(ctx.empresa).filter((f) => !filtros.fuente || f === filtros.fuente);
  const restringido = (ctx.sucursalIds ?? []).length > 0;
  const minimos = (await q.query('select fuente, ref_id, sucursal_id, minimo from invu.minimos where empresa_id = $1', [ctx.empresa.id])).rows;
  const propio = new Map(minimos.map((m) => [claveItem(m.fuente, m.ref_id, m.sucursal_id), m.minimo]));
  const items = [];
  for (const fuente of fuentes) {
    if (!FUENTES[fuente].sucursal && restringido) continue;     // fábrica/bodega central: solo para quien no está limitado a tiendas
    const { rows } = await q.query(SQL_LISTA[fuente], [ctx.empresa.id]);
    for (const f of rows) {
      if (FUENTES[fuente].sucursal && restringido && !ctx.sucursalIds.includes(f.sucursal_id)) continue;
      if (filtros.sucursal_id && (f.sucursal_id ?? null) !== filtros.sucursal_id) continue;
      let existencia = f.existencia == null ? 0 : Number(f.existencia);
      let costo = f.costo == null ? null : Number(f.costo);
      if (fuente === 'rinv_fab') {            // el precio está por kg: por unidad de conteo depende de si se cuenta en kg o en botes
        const precio = f.precio == null ? null : Number(f.precio);
        costo = precio == null ? null : esPorPeso(f.unidad) ? precio : (Number(f.peso_unitario) > 0 ? precio * Number(f.peso_unitario) : null);
      }
      const k = claveItem(fuente, f.ref_id, f.sucursal_id);
      const minimo = propio.has(k) ? propio.get(k) : (f.minimo == null ? null : Number(f.minimo));
      const sinCargar = fuente === 'rinv_fab' && f.existencia == null;
      const categoria = f.categoria || 'Sin categoría';
      if (filtros.categoria && categoria !== filtros.categoria) continue;
      items.push({
        clave: k, fuente, ref_id: f.ref_id, sucursal_id: f.sucursal_id ?? null, sucursal: f.sucursal ?? null,
        nombre: f.nombre, categoria, unidad: f.unidad, existencia: r3(existencia), minimo,
        minimo_propio: propio.has(k),
        costo: ctx.costos ? costo : null, valor: ctx.costos && costo != null ? r2(Math.max(0, existencia) * costo) : null,
        sin_costo: costo == null, vence: f.vence ?? null, estado: estadoDe(existencia, minimo, sinCargar),
      });
    }
  }
  return items;
}

export function resumirItems(items, dias = 30) {
  const limite = sumarDiasISO(fechaHN(), dias);
  return {
    items: items.length,
    valor: r2(items.reduce((s, i) => s + (i.valor ?? 0), 0)),
    sin_costo: items.filter((i) => i.sin_costo && i.existencia > 0).length,
    bajo_minimo: items.filter((i) => i.estado === 'bajo').length,
    agotados: items.filter((i) => i.estado === 'agotado' && i.minimo != null && i.minimo > 0).length,
    negativos: items.filter((i) => i.estado === 'negativo').length,
    por_vencer: items.filter((i) => i.vence && i.vence <= limite).length,
  };
}
export function sumarDiasISO(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}

/** Lotes que vencen pronto (o ya vencidos) de las fuentes con vencimiento. */
export async function vencimientos(q, ctx, dias = 30) {
  const limite = sumarDiasISO(fechaHN(), dias);
  const hoy = fechaHN();
  const out = [];
  const fuentes = fuentesDe(ctx.empresa);
  const restringido = (ctx.sucursalIds ?? []).length > 0;
  if (fuentes.includes('inv')) {
    const { rows } = await q.query(
      `select l.id, i.id as ref_id, i.nombre, i.unidad, s.id as sucursal_id, s.nombre as sucursal, l.cantidad_actual as cantidad, l.vence_at as vence
         from inv.lotes l join inv.insumos i on i.id = l.insumo_id join core.sucursales s on s.id = l.sucursal_id
        where l.empresa_id = $1 and l.cantidad_actual > 0 and l.vence_at is not null and l.vence_at <= $2::date order by l.vence_at`, [ctx.empresa.id, limite]);
    for (const l of rows) if (!restringido || ctx.sucursalIds.includes(l.sucursal_id)) out.push({ ...l, fuente: 'inv' });
  }
  if (fuentes.includes('rinv_fab') && !restringido) {
    const { rows } = await q.query(
      `select l.id, f.id as ref_id, f.nombre, f.unidad, null::uuid as sucursal_id, 'Fábrica' as sucursal, l.cantidad_restante as cantidad, l.fecha_vencimiento as vence
         from rinv.lotes_mec3 l join rinv.insumos_fab f on f.id = l.insumo_id
        where l.empresa_id = $1 and l.cantidad_restante > 0 and l.fecha_vencimiento <= $2::date order by l.fecha_vencimiento`, [ctx.empresa.id, limite]);
    for (const l of rows) out.push({ ...l, fuente: 'rinv_fab' });
  }
  return out.map((l) => ({ ...l, cantidad: r3(l.cantidad), dias_restantes: Math.round((Date.parse(`${l.vence}T00:00:00Z`) - Date.parse(`${hoy}T00:00:00Z`)) / 86400000) }))
    .sort((a, b) => a.vence.localeCompare(b.vence));
}

// ─── Lectura puntual de un ítem ─────────────────────────────────────────────
/** Existencia actual de un ítem (y datos básicos). Lanza 404 si no es de la empresa. `bloquear` toma candado de fila. */
export async function leerItem(q, empresaId, fuente, ref, sucursalId, { bloquear = false } = {}) {
  const lock = bloquear ? 'for update' : '';
  let fila;
  if (fuente === 'inv') {
    fila = (await q.query(`select i.id, i.nombre, i.unidad, i.categoria, i.costo_actual as costo, i.activo from inv.insumos i where i.id = $1 and i.empresa_id = $2 ${lock}`, [ref, empresaId])).rows[0];
    if (fila) {
      if (!sucursalId) throw malaPeticion('Falta la sucursal del ítem');
      fila.existencia = Number((await q.query('select coalesce(sum(cantidad),0) as s from inv.movimientos where insumo_id = $1 and sucursal_id = $2', [ref, sucursalId])).rows[0].s);
    }
  } else if (fuente === 'rinv_suc') {
    fila = (await q.query(`select c.id, c.nombre, c.unidad, c.categoria, null::numeric as costo, c.activo from rep.insumos_catalogo c where c.id = $1 and c.empresa_id = $2 ${lock}`, [ref, empresaId])).rows[0];
    if (fila) {
      if (!sucursalId) throw malaPeticion('Falta la sucursal del ítem');
      fila.existencia = Number((await q.query(`select cantidad from rinv.stock_suc where sucursal_id = $1 and insumo_id = $2 ${lock}`, [sucursalId, ref])).rows[0]?.cantidad ?? 0);
    }
  } else if (fuente === 'rinv_fab') {
    fila = (await q.query(`select f.id, f.nombre, f.unidad, f.categoria, f.stock_actual as existencia, f.tipo, f.peso_unitario, f.activo,
        (select p.lps_kg from rinv.precios_fab p where p.insumo_id = f.id order by p.fecha_vigencia desc, p.n desc limit 1) as precio
        from rinv.insumos_fab f where f.id = $1 and f.empresa_id = $2 ${lock}`, [ref, empresaId])).rows[0];
    if (fila) {
      fila.existencia = Number(fila.existencia) || 0;
      fila.costo = fila.precio == null ? null : esPorPeso(fila.unidad) ? Number(fila.precio) : (Number(fila.peso_unitario) > 0 ? Number(fila.precio) * Number(fila.peso_unitario) : null);
    }
  } else if (fuente === 'fab_insumo') {
    fila = (await q.query(`select i.id, i.nombre, i.unidad, i.categoria, i.costo_promedio as costo, i.activo,
        (select coalesce(sum(cantidad),0) from fab.mov_insumos where insumo_id = i.id) as existencia from fab.insumos i where i.id = $1 and i.empresa_id = $2 ${lock}`, [ref, empresaId])).rows[0];
  } else if (fuente === 'fab_piedra') {
    fila = (await q.query(`select l.id, p.nombre || ' · lote ' || l.codigo || ' (' || l.calidad || ')' as nombre, 'cajas' as unidad, 'Piedra' as categoria, l.costo_m2 as costo,
        l.cantidad_disponible as existencia, l.cantidad_reservada as reservada, l.estado, true as activo
        from fab.lotes l join pos.productos p on p.id = l.producto_id where l.id = $1 and l.empresa_id = $2 ${bloquear ? 'for update of l' : ''}`, [ref, empresaId])).rows[0];
  } else if (fuente === 'dis') {
    fila = (await q.query(`select p.id, p.nombre, coalesce(p.unidad,'u') as unidad, null as categoria, e.costo_estandar as costo, p.activo,
        (select coalesce(sum(cantidad),0) from dis.movimientos where producto_id = p.id) as existencia
        from pos.productos p join dis.producto_ext e on e.producto_id = p.id where p.id = $1 and p.empresa_id = $2 ${bloquear ? 'for update of e' : ''}`, [ref, empresaId])).rows[0];
  } else throw malaPeticion('Fuente de inventario desconocida');
  if (!fila) throw noEncontrado('Ítem de inventario no encontrado');
  return { ...fila, fuente, ref_id: fila.id, sucursal_id: FUENTES[fuente].sucursal ? sucursalId : null, existencia: Number(fila.existencia) || 0, costo: fila.costo == null ? null : Number(fila.costo) };
}

// ─── Movimientos (siempre dentro de una transacción `q`) ─────────────────────
const usuarioDe = (ctx) => ctx.usuario.id;

async function guardarStockSuc(q, empresaId, sucursalId, insumoId, cantidad) {
  await q.query(
    `insert into rinv.stock_suc (empresa_id, sucursal_id, insumo_id, cantidad, actualizado_en) values ($1,$2,$3,$4,now())
     on conflict (sucursal_id, insumo_id) do update set cantidad = excluded.cantidad, actualizado_en = excluded.actualizado_en`, [empresaId, sucursalId, insumoId, cantidad]);
}
async function kardexRinv(q, ctx, m) {
  await q.query(
    `insert into rinv.movimientos (empresa_id, ambito, sucursal_id, insumo_fab_id, insumo_suc_id, tipo, cantidad, saldo_resultante, motivo, rol, usuario_id, usuario_nombre)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [ctx.empresa.id, m.ambito, m.sucursalId ?? null, m.insumoFabId ?? null, m.insumoSucId ?? null, m.tipo, m.cantidad, m.saldo, m.motivo ?? null, ctx.rol ?? null, ctx.usuario.id, ctx.usuario.nombre]);
}

/**
 * Cambia la existencia de un ítem por `delta` (+ entra / − sale). Devuelve { costo_unitario } (costo al que salió o entró).
 *  · tipo 'ajuste'   → conteo/corrección (no valida existencia: el conteo manda).
 *  · tipo 'traslado' → entrada o salida de un traslado; `costo` es el costo con el que entra.
 */
export async function moverItem(q, ctx, { fuente, ref, sucursalId, delta, tipo = 'ajuste', motivo, costo = null, documento = null, proveedor = null }) {
  if (!delta) return { costo_unitario: null, delta: 0 };
  const e = ctx.empresa.id;
  const item = await leerItem(q, e, fuente, ref, sucursalId, { bloquear: true });
  const entra = delta > 0, cant = Math.abs(delta);
  if (fuente === 'inv') {
    if (entra) {
      const c = tipo === 'traslado' ? (costo ?? 0) : item.costo;
      await q.query('select inv.ingresar($1,$2,$3,$4,$5,$6,null,$7,null,$8,$9)', [e, sucursalId, ref, cant, c, tipo === 'traslado' ? 'traslado_entrada' : 'ajuste', tipo === 'traslado' ? 'traslado' : 'conteo', motivo, usuarioDe(ctx)]);
      return { costo_unitario: c, delta };
    }
    const total = Number((await q.query('select inv.descontar($1,$2,$3,$4,$5,$6,null,$7,$8) as c', [e, sucursalId, ref, cant, tipo === 'traslado' ? 'traslado_salida' : 'ajuste', tipo === 'traslado' ? 'traslado' : 'conteo', motivo, usuarioDe(ctx)])).rows[0].c);
    return { costo_unitario: cant ? total / cant : null, delta };
  }
  if (fuente === 'rinv_suc') {
    const nuevo = redondearSaldo(Math.max(0, item.existencia + delta));
    const real = redondearSaldo(nuevo - item.existencia);
    if (real === 0) return { costo_unitario: null, delta: 0 };
    await guardarStockSuc(q, e, sucursalId, ref, nuevo);
    await kardexRinv(q, ctx, { ambito: 'sucursal', sucursalId, insumoSucId: ref, tipo: real > 0 ? 'entrada' : 'salida', cantidad: Math.abs(real), saldo: nuevo, motivo });
    return { costo_unitario: null, delta: real };
  }
  if (fuente === 'rinv_fab') {
    const nuevo = redondearSaldo(Math.max(0, item.existencia + delta));
    const real = redondearSaldo(nuevo - item.existencia);
    if (real === 0) return { costo_unitario: item.costo, delta: 0 };
    await q.query('update rinv.insumos_fab set stock_actual = $2, stock_actualizado_en = now() where id = $1', [ref, nuevo]);
    await kardexRinv(q, ctx, { ambito: 'fabrica', insumoFabId: ref, tipo: real > 0 ? 'entrada' : 'salida', cantidad: Math.abs(real), saldo: nuevo, motivo });
    if (item.tipo === 'mec3') {
      if (real > 0) { const hoy = fechaHN(); await registrarLote(q, e, { insumoId: ref, cantidad: real, fechaIngreso: hoy, fechaVencimiento: vencimientoDe(hoy), motivo }); }
      else await consumirLotesFifo(q, e, ref, Math.abs(real), motivo);
    }
    return { costo_unitario: item.costo, delta: real };
  }
  if (fuente === 'fab_insumo') {
    const mov = (await q.query(
      `select * from fab.mover_insumo($1,$2,$3,$4,$5,'HNL',1,null,$6,$7,null,$8,$9)`,
      [e, ref, entra && tipo === 'traslado' ? 'compra' : 'ajuste', delta, entra && tipo === 'traslado' ? (costo ?? 0) : null, documento, motivo, usuarioDe(ctx), tipo === 'ajuste'])).rows[0];
    return { costo_unitario: Number(mov?.costo_unitario ?? item.costo ?? 0), delta };
  }
  if (fuente === 'dis') {
    await q.query('select dis.mover($1,$2,$3,$4,$5,$6,null,$7,$8,$9,$10,null)',
      [e, ref, entra && tipo === 'traslado' ? 'compra' : 'ajuste', delta, entra ? (costo ?? item.costo ?? 0) : 0, motivo, proveedor, documento, usuarioDe(ctx), tipo === 'ajuste']);
    return { costo_unitario: item.costo, delta };
  }
  if (fuente === 'fab_piedra') {
    if (tipo === 'traslado') throw malaPeticion('La piedra terminada no se traslada entre empresas: se vende con factura');
    if (!Number.isInteger(delta)) throw malaPeticion('La piedra se maneja en cajas completas de 1 m²: la cantidad debe ser un número entero');
    const nuevo = r3(item.existencia + delta);
    if (nuevo < 0) throw malaPeticion(`No puede quedar existencia negativa en ${item.nombre}`);
    if (nuevo < Number(item.reservada)) throw malaPeticion(`${item.nombre} tiene ${item.reservada} reservadas para cotizaciones: libera la reserva antes de bajar la existencia`);
    await q.query(`update fab.lotes set cantidad_disponible = $2, estado = case when $2::numeric = 0 then 'agotado' when estado = 'agotado' then 'lista' else estado end where id = $1`, [ref, nuevo]);
    await q.query('insert into fab.lote_movs (empresa_id, lote_id, tipo, cantidad, motivo, usuario_id) values ($1,$2,$3,$4,$5,$6)', [e, ref, 'ajuste', delta, motivo, usuarioDe(ctx)]);
    return { costo_unitario: item.costo, delta };
  }
  throw malaPeticion('Fuente de inventario desconocida');
}

// ─── Kardex consolidado ─────────────────────────────────────────────────────
/**
 * Movimientos de TODAS las fuentes de la empresa, con el mismo formato. cantidad es con signo (+ entra / − sale).
 * Filtros: desde/hasta (fechas de Honduras), q (nombre), fuente, limite.
 */
export async function kardex(q, ctx, { desde, hasta, texto, fuente, limite = 300 } = {}) {
  const fuentes = fuentesDe(ctx.empresa).filter((f) => !fuente || f === fuente);
  const e = ctx.empresa.id;
  const restringido = (ctx.sucursalIds ?? []).length > 0;
  const f = (col) => `(${col} at time zone 'America/Tegucigalpa')::date between coalesce($2::date, '1900-01-01') and coalesce($3::date, '2999-12-31')`;
  const like = '($4::text is null or lower(x.nombre) like \'%\' || lower($4) || \'%\')';
  const filas = [];
  const p = [e, desde ?? null, hasta ?? null, texto ?? null, limite];
  for (const fu of fuentes) {
    if (!FUENTES[fu].sucursal && restringido) continue;
    let sql;
    if (fu === 'inv') sql = `select m.id::text as id, m.created_at as fecha, i.nombre, i.unidad, s.nombre as sucursal, s.id as sucursal_id, m.tipo, m.cantidad, m.costo_unitario as costo, m.motivo, u.nombre as usuario, null::numeric as saldo
        from inv.movimientos m join inv.insumos i on i.id = m.insumo_id join core.sucursales s on s.id = m.sucursal_id left join core.usuarios u on u.id = m.usuario_id
        where m.empresa_id = $1 and ${f('m.created_at')} order by m.id desc limit $5`;
    else if (fu === 'rinv_suc') sql = `select m.n::text as id, m.created_at as fecha, c.nombre, c.unidad, s.nombre as sucursal, s.id as sucursal_id, m.tipo, case when m.tipo = 'salida' then -m.cantidad else m.cantidad end as cantidad,
        null::numeric as costo, m.motivo, m.usuario_nombre as usuario, m.saldo_resultante as saldo
        from rinv.movimientos m join rep.insumos_catalogo c on c.id = m.insumo_suc_id join core.sucursales s on s.id = m.sucursal_id
        where m.empresa_id = $1 and m.ambito = 'sucursal' and ${f('m.created_at')} order by m.n desc limit $5`;
    else if (fu === 'rinv_fab') sql = `select m.n::text as id, m.created_at as fecha, c.nombre, c.unidad, 'Fábrica' as sucursal, null::uuid as sucursal_id, m.tipo, case when m.tipo = 'salida' then -m.cantidad else m.cantidad end as cantidad,
        null::numeric as costo, m.motivo, m.usuario_nombre as usuario, m.saldo_resultante as saldo
        from rinv.movimientos m join rinv.insumos_fab c on c.id = m.insumo_fab_id
        where m.empresa_id = $1 and m.ambito = 'fabrica' and ${f('m.created_at')} order by m.n desc limit $5`;
    else if (fu === 'fab_insumo') sql = `select m.id::text as id, m.created_at as fecha, i.nombre, i.unidad, null as sucursal, null::uuid as sucursal_id, m.tipo, m.cantidad, m.costo_unitario as costo, coalesce(m.motivo, m.documento) as motivo, u.nombre as usuario, null::numeric as saldo
        from fab.mov_insumos m join fab.insumos i on i.id = m.insumo_id left join core.usuarios u on u.id = m.usuario_id
        where m.empresa_id = $1 and ${f('m.created_at')} order by m.id desc limit $5`;
    else if (fu === 'fab_piedra') sql = `select m.id::text as id, m.created_at as fecha, pr.nombre || ' · lote ' || l.codigo as nombre, 'cajas' as unidad, null as sucursal, null::uuid as sucursal_id, m.tipo, m.cantidad, null::numeric as costo, m.motivo, u.nombre as usuario, null::numeric as saldo
        from fab.lote_movs m join fab.lotes l on l.id = m.lote_id join pos.productos pr on pr.id = l.producto_id left join core.usuarios u on u.id = m.usuario_id
        where m.empresa_id = $1 and m.tipo not in ('reserva','liberacion') and ${f('m.created_at')} order by m.id desc limit $5`;
    else sql = `select m.id::text as id, m.created_at as fecha, pr.nombre, coalesce(pr.unidad,'u') as unidad, null as sucursal, null::uuid as sucursal_id, m.tipo, m.cantidad, m.costo_unitario as costo, m.motivo, u.nombre as usuario, null::numeric as saldo
        from dis.movimientos m join pos.productos pr on pr.id = m.producto_id left join core.usuarios u on u.id = m.usuario_id
        where m.empresa_id = $1 and ${f('m.created_at')} order by m.id desc limit $5`;
    const { rows } = await q.query(`select * from (${sql}) x where ${like} and ($6::uuid[] = '{}' or x.sucursal_id is null or x.sucursal_id = any($6::uuid[]))`, [...p, ctx.sucursalIds ?? []]);
    for (const m of rows) filas.push({ ...m, id: `${fu}:${m.id}`, fuente: fu, cantidad: Number(m.cantidad), costo: ctx.costos && m.costo != null ? Number(m.costo) : null });
  }
  return filas.sort((a, b) => new Date(b.fecha) - new Date(a.fecha)).slice(0, limite);
}

export { SIN_SUC };
