import { Router } from 'express';
import { z } from 'zod';
import { fechaHN } from '@grupo/shared';
import { requierePermiso, resolverSucursal } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { fechaISO, malaPeticion, noEncontrado, uuid, validar } from '../../lib/http.js';
import { valorInventarioFabrica } from './calculo.js';
import { lotesPorVencer } from './fabrica.js';
import { empresaDe, sucursalesVisibles } from './util.js';
import { sembrarRinv } from './siembra.js';

const TZ = "'America/Tegucigalpa'";

/** Alertas de inventario: stock bajo mínimo (fábrica y sucursales) y lotes Mec3 por vencer. */
export async function alertasInventario(q, empresaId, sucursalIds = []) {
  const [stockBajoFabrica, stockBajoSucursal, vencimientos] = await Promise.all([
    q.query(`select nombre, unidad, stock_actual, stock_minimo from rinv.insumos_fab
              where empresa_id = $1 and activo and not es_equipo and stock_minimo is not null and coalesce(stock_actual, 0) < stock_minimo order by nombre`, [empresaId]),
    q.query(`select i.nombre, su.nombre as sucursal_nombre, coalesce(st.cantidad, 0) as cantidad, i.stock_minimo
               from rep.insumos_catalogo i join core.sucursales su on su.empresa_id = i.empresa_id and su.activo
               left join rinv.stock_suc st on st.insumo_id = i.id and st.sucursal_id = su.id
              where i.empresa_id = $1 and i.activo and not i.es_equipo and i.stock_minimo is not null and coalesce(st.cantidad, 0) < i.stock_minimo
                and ($2::uuid[] = '{}' or su.id = any($2::uuid[])) order by i.nombre, su.nombre`, [empresaId, sucursalIds]),
    lotesPorVencer(q, empresaId, 14),
  ]);
  return { stockBajoFabrica: stockBajoFabrica.rows, stockBajoSucursal: stockBajoSucursal.rows, vencimientos };
}

export function formatearAlertasTexto({ stockBajoFabrica, stockBajoSucursal, vencimientos }) {
  if (!stockBajoFabrica.length && !stockBajoSucursal.length && !vencimientos.length) return '';
  const l = ['ALERTAS DE INVENTARIO:'];
  if (stockBajoFabrica.length) { l.push('Bajo el mínimo en fábrica:'); for (const i of stockBajoFabrica) l.push(`  - ${i.nombre}: ${i.stock_actual ?? 0} ${i.unidad} (mínimo ${i.stock_minimo})`); }
  if (stockBajoSucursal.length) { l.push('Bajo el mínimo en sucursales:'); for (const i of stockBajoSucursal) l.push(`  - ${i.nombre} en ${i.sucursal_nombre}: ${i.cantidad} (mínimo ${i.stock_minimo})`); }
  if (vencimientos.length) {
    l.push('Lotes Mec3 por vencer (próximos 14 días):');
    for (const v of vencimientos) l.push(`  - ${v.insumo_nombre}: ${v.cantidad_restante} ${v.unidad} (${v.dias_para_vencer < 0 ? `vencido hace ${-v.dias_para_vencer}d` : `en ${v.dias_para_vencer}d`})`);
  }
  return l.join('\n');
}

export function rutasReportes({ db }) {
  const r = Router();
  const ver = requierePermiso('rep:inventario');

  r.get('/sucursales', requierePermiso('rep:inventario', 'rep:pesar', 'rep:ver', 'rep:producir'), async (req, res) => {
    res.json(await sucursalesVisibles(db, req.ctx));
  });

  // Resumen liviano para Producción: ¿va a faltar materia prima hoy?
  r.get('/alertas-resumen-fabrica', requierePermiso('rep:inventario', 'rep:producir'), async (req, res) => {
    const a = await alertasInventario(db, empresaDe(req));
    res.json({ insumosAlerta: a.stockBajoFabrica, vencimientos: a.vencimientos });
  });

  r.get('/alertas', ver, async (req, res) => {
    const a = await alertasInventario(db, empresaDe(req), req.ctx.sucursalIds);
    res.json({ ...a, texto: formatearAlertasTexto(a) });
  });

  /** Stock de fábrica y de las sucursales en una llamada; los insumos de sucursal vienen como matriz (insumo × sucursal). */
  r.get('/resumen-stock', ver, async (req, res) => {
    const sucursales = await sucursalesVisibles(db, req.ctx);
    const [fabrica, filas] = await Promise.all([
      db.query(`select id, nombre, tipo, unidad, categoria, codigo_barras, es_equipo, stock_minimo, stock_maximo, stock_actual, stock_actualizado_en, peso_unitario
                  from rinv.insumos_fab where empresa_id = $1 and activo order by nombre`, [empresaDe(req)]),
      db.query(`select i.id as insumo_id, i.nombre, i.categoria, i.es_equipo, i.stock_minimo, i.stock_maximo, i.unidad, st.sucursal_id, st.cantidad
                  from rep.insumos_catalogo i left join rinv.stock_suc st on st.insumo_id = i.id where i.empresa_id = $1 and i.activo order by i.nombre`, [empresaDe(req)]),
    ]);
    const porInsumo = new Map();
    for (const f of filas.rows) {
      if (!porInsumo.has(f.insumo_id)) porInsumo.set(f.insumo_id, { id: f.insumo_id, nombre: f.nombre, categoria: f.categoria, es_equipo: f.es_equipo, stock_minimo: f.stock_minimo, stock_maximo: f.stock_maximo, unidad: f.unidad, porSucursal: {} });
      if (f.sucursal_id) porInsumo.get(f.insumo_id).porSucursal[f.sucursal_id] = f.cantidad;
    }
    // Un insumo que nunca se cargó en una sucursal no trae fila: se completa en 0 para que la matriz quede pareja.
    for (const i of porInsumo.values()) for (const s of sucursales) if (!(s.id in i.porSucursal)) i.porSucursal[s.id] = 0;
    res.json({ fabrica: fabrica.rows, sucursales: sucursales.map((s) => ({ id: s.id, nombre: s.nombre })), catalogoSucursal: [...porInsumo.values()] });
  });

  /** Kardex completo (fábrica + sucursales) filtrable por fecha, ámbito, sucursal, tipo y texto del insumo. */
  r.get('/movimientos', ver, async (req, res) => {
    const f = validar(z.object({ desde: fechaISO, hasta: fechaISO, ambito: z.enum(['fabrica', 'sucursal']).optional(), sucursalId: uuid.optional(),
      tipo: z.enum(['entrada', 'salida']).optional(), busqueda: z.string().trim().max(80).optional() }), req.query);
    const visibles = req.ctx.sucursalIds;
    const { rows } = await db.query(
      `select m.id, m.ambito, m.sucursal_id, su.nombre as sucursal_nombre, coalesce(m.insumo_fab_id, m.insumo_suc_id) as insumo_id,
              coalesce(fi.nombre, si.nombre) as insumo_nombre, coalesce(fi.unidad, si.unidad, 'u') as unidad,
              coalesce(fi.categoria, si.categoria, 'Sin categoría') as categoria, m.tipo, m.cantidad, m.saldo_resultante, m.motivo, m.rol, m.usuario_nombre,
              m.created_at as creado_en
         from rinv.movimientos m
         left join rinv.insumos_fab fi on fi.id = m.insumo_fab_id left join rep.insumos_catalogo si on si.id = m.insumo_suc_id
         left join core.sucursales su on su.id = m.sucursal_id
        where m.empresa_id = $1 and (m.created_at at time zone ${TZ})::date between $2 and $3
          and ($4::text is null or m.ambito = $4) and ($5::uuid is null or m.sucursal_id = $5) and ($6::text is null or m.tipo = $6)
          and ($7::text is null or upper(coalesce(fi.nombre, si.nombre)) like '%' || upper($7) || '%')
          and (m.sucursal_id is null or $8::uuid[] = '{}' or m.sucursal_id = any($8::uuid[]))
        order by m.n desc limit 1000`,
      [empresaDe(req), f.desde, f.hasta, f.ambito ?? null, f.sucursalId ?? null, f.tipo ?? null, f.busqueda || null, visibles]);
    res.json(rows);
  });

  r.get('/reportes/categoria', ver, async (req, res) => {
    const { desde, hasta } = validar(z.object({ desde: fechaISO, hasta: fechaISO }), req.query);
    const { rows } = await db.query(
      `select m.ambito, coalesce(fi.categoria, si.categoria, 'Sin categoría') as categoria, m.tipo, sum(m.cantidad)::float8 as total
         from rinv.movimientos m left join rinv.insumos_fab fi on fi.id = m.insumo_fab_id left join rep.insumos_catalogo si on si.id = m.insumo_suc_id
        where m.empresa_id = $1 and (m.created_at at time zone ${TZ})::date between $2 and $3 group by 1, 2, 3`, [empresaDe(req), desde, hasta]);
    const combinar = (ambito) => {
      const mapa = new Map();
      for (const f of rows.filter((x) => x.ambito === ambito)) {
        if (!mapa.has(f.categoria)) mapa.set(f.categoria, { categoria: f.categoria, entradas: 0, salidas: 0 });
        mapa.get(f.categoria)[f.tipo === 'entrada' ? 'entradas' : 'salidas'] = f.total;
      }
      return [...mapa.values()].sort((a, b) => a.categoria.localeCompare(b.categoria));
    };
    res.json({ fabrica: combinar('fabrica'), sucursales: combinar('sucursal') });
  });

  /** Actividad por mes (cantidad de MOVIMIENTOS, no de unidades: kg, litros y unidades no se suman). */
  r.get('/reportes/mensual', ver, async (req, res) => {
    const { meses } = validar(z.object({ meses: z.coerce.number().int().min(1).max(24).default(6) }), req.query);
    const hoy = fechaHN();
    const etiquetas = [];
    let y = Number(hoy.slice(0, 4)); let m = Number(hoy.slice(5, 7));
    for (let i = 0; i < meses; i++) { etiquetas.unshift(`${y}-${String(m).padStart(2, '0')}`); m -= 1; if (m === 0) { m = 12; y -= 1; } }
    const { rows } = await db.query(
      `select to_char(created_at at time zone ${TZ}, 'YYYY-MM') as mes, ambito, tipo, count(*)::int as movimientos
         from rinv.movimientos where empresa_id = $1 and to_char(created_at at time zone ${TZ}, 'YYYY-MM') >= $2 group by 1, 2, 3`, [empresaDe(req), etiquetas[0]]);
    const serie = (ambito) => etiquetas.map((mes) => ({
      mes, entradas: rows.find((f) => f.mes === mes && f.ambito === ambito && f.tipo === 'entrada')?.movimientos || 0,
      salidas: rows.find((f) => f.mes === mes && f.ambito === ambito && f.tipo === 'salida')?.movimientos || 0,
    }));
    res.json({ meses: etiquetas, fabrica: serie('fabrica'), sucursales: serie('sucursal') });
  });

  /** Cuánto dinero hay parado en bodega. Precio = el más reciente entre la lista de costeo de Producción (prod.costeo_precios, por nombre) y los precios propios. Expone precios: solo quien ve costos. */
  r.get('/valor', requierePermiso('rep:costeo'), async (req, res) => {
    const { rows } = await db.query(
      `select i.id, i.nombre, i.descripcion, i.tipo, i.categoria, i.unidad, i.stock_actual, i.es_equipo, i.peso_unitario,
              (select x.lps_kg from (
                 select p.lps_kg, p.fecha_vigencia, 1 as origen, p.id::bigint as orden from prod.costeo_precios p join prod.costeo_insumos ci on ci.id = p.insumo_id
                  where ci.empresa_id = i.empresa_id and upper(ci.nombre) = upper(i.nombre)
                 union all
                 select q.lps_kg, q.fecha_vigencia, 0, q.n from rinv.precios_fab q where q.insumo_id = i.id) x
                order by x.fecha_vigencia desc, x.origen desc, x.orden desc limit 1) as precio
         from rinv.insumos_fab i where i.empresa_id = $1 and i.activo order by i.nombre`, [empresaDe(req)]);
    res.json(valorInventarioFabrica(rows));
  });

  /** Del lote de materia prima: cuánto y qué días salió de bodega, y qué tandas lo usaron. Es el «botón de retiro». */
  r.get('/trazabilidad/lote/:id', ver, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const lote = (await db.query(
      `select l.id, l.insumo_id, i.nombre as insumo_nombre, i.unidad, l.cantidad_inicial, l.cantidad_restante, l.fecha_ingreso, l.fecha_vencimiento, l.motivo
         from rinv.lotes_mec3 l join rinv.insumos_fab i on i.id = l.insumo_id where l.id = $1 and l.empresa_id = $2`, [id, empresaDe(req)])).rows[0];
    if (!lote) throw noEncontrado('Lote no encontrado');
    const salidas = (await db.query('select fecha, sum(cantidad)::float8 as cantidad from rinv.salida_lotes where lote_id = $1 group by fecha order by fecha', [id])).rows;
    const tandas = (await db.query(
      `select pl.cantidad, p.id, p.lote, p.fecha, p.kg, p.operario, sa.nombre as sabor_nombre
         from prod.produccion_lotes pl join prod.producciones p on p.id = pl.produccion_id join rep.sabores sa on sa.id = p.sabor_id
        where pl.lote_id = $1 order by p.fecha`, [id])).rows;
    const fechas = salidas.map((s) => s.fecha);
    const tandasDeEsosDias = fechas.length ? (await db.query(
      `select p.id, p.lote, p.fecha, p.kg, p.operario, sa.nombre as sabor_nombre from prod.producciones p join rep.sabores sa on sa.id = p.sabor_id
        where p.empresa_id = $1 and p.fecha = any($2::date[]) order by p.fecha`, [empresaDe(req), fechas])).rows : [];
    const ids = [...new Set([...tandas, ...tandasDeEsosDias].map((t) => t.id))];
    const destinos = ids.length ? (await db.query(
      `select dt.produccion_id, dt.gramos, d.fecha, s.id as sucursal_id, s.nombre as sucursal_nombre from rep.despacho_tandas dt
         join rep.despachos d on d.id = dt.despacho_id join core.sucursales s on s.id = d.sucursal_id where dt.produccion_id = any($1::uuid[]) order by d.fecha`, [ids])).rows : [];
    const de = (t) => destinos.filter((d) => d.produccion_id === t.id);
    const tiendas = new Map();
    for (const d of destinos) {
      const a = tiendas.get(d.sucursal_id) ?? { sucursal_id: d.sucursal_id, nombre: d.sucursal_nombre, gramos: 0, fechas: new Set() };
      a.gramos += Number(d.gramos); a.fechas.add(d.fecha); tiendas.set(d.sucursal_id, a);
    }
    const incidencias = (await db.query('select id, numero, tipo, gravedad, estado, descripcion, created_at from rinv.incidencias where lote_id = $1 order by created_at desc', [id])).rows;
    res.json({
      lote, salidas, incidencias,
      tandas: tandas.map((t) => ({ ...t, destinos: de(t) })),
      tandas_de_esos_dias: tandasDeEsosDias.map((t) => ({ ...t, destinos: de(t) })),
      tiendas_afectadas: [...tiendas.values()].map((t) => ({ ...t, fechas: [...t.fechas].sort() })).sort((a, b) => b.gramos - a.gramos),
    });
  });

  r.get('/lotes', ver, async (req, res) => {
    res.json((await db.query(
      `select l.id, i.nombre as insumo_nombre, i.unidad, l.cantidad_inicial, l.cantidad_restante, l.fecha_ingreso, l.fecha_vencimiento
         from rinv.lotes_mec3 l join rinv.insumos_fab i on i.id = l.insumo_id where l.empresa_id = $1 order by l.fecha_ingreso desc, l.n desc limit 200`, [empresaDe(req)])).rows);
  });

  // ── Checklist de apertura y cierre (en pausa en el original: sin pantalla, con datos) ──
  r.get('/checklist/catalogo', requierePermiso('rep:pesar', 'rep:inventario'), async (req, res) => {
    res.json((await db.query('select id, momento, texto, orden from rinv.checklist_catalogo where empresa_id = $1 and activo order by momento, orden', [empresaDe(req)])).rows);
  });
  r.post('/checklist/:sucursalId', requierePermiso('rep:pesar', 'rep:inventario'), async (req, res) => {
    const s = await resolverSucursal(db, req.ctx, validar(uuid, req.params.sucursalId));
    const b = validar(z.object({ item_id: uuid, momento: z.enum(['apertura', 'cierre'], { errorMap: () => ({ message: 'Momento inválido' }) }), ok: z.boolean().optional(),
      nota: z.string().trim().max(300).optional().nullable(), fecha: fechaISO.optional() }), req.body);
    const it = (await db.query('select 1 from rinv.checklist_catalogo where id = $1 and empresa_id = $2 and momento = $3', [b.item_id, empresaDe(req), b.momento])).rowCount;
    if (!it) throw malaPeticion('Ese ítem no existe');
    await db.query(
      `insert into rinv.checklist_registros (empresa_id, sucursal_id, fecha, momento, item_id, ok, nota, usuario_id) values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (sucursal_id, fecha, momento, item_id) do update set ok = excluded.ok, nota = excluded.nota, usuario_id = excluded.usuario_id, created_at = now()`,
      [empresaDe(req), s.id, b.fecha ?? fechaHN(), b.momento, b.item_id, Boolean(b.ok), b.nota || null, req.ctx.usuario.id]);
    res.json({ ok: true });
  });

  // ── Siembra de los datos reales de Italo (idempotente) ──
  r.post('/siembra', requierePermiso('admin:empresa'), async (req, res) => {
    const out = await sembrarRinv(db, empresaDe(req));
    await auditar(db, req.ctx, 'rinv.siembra', 'rinv', null, { insumos: out.catalogo.insumosCreados, ristoris: out.ristoris.insumosCreados, conteos: out.stockRistoris.cargados });
    res.json(out);
  });

  return r;
}

