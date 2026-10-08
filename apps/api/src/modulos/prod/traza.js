// Trazabilidad (/api/prod/traza): del lote de materia prima a las sucursales y viceversa.
//   Hacia adelante (lote de materia prima → tiendas): «un lote de pasta salió malo, ¿a quién llamo hoy?»
//   Hacia atrás (tienda y día → tanda → lote): «un cliente devolvió algo, ¿de qué tanda y de qué lote venía?»
// Producción (rep:producir) NO entra: la ficha de una tanda dice cuánta materia prima llevó, y eso es la receta.
// El acceso queda en Inventario y en el dueño/gerente.
import { Router } from 'express';
import { requierePermiso } from '../../lib/contexto.js';
import { malaPeticion, noEncontrado, uuid, validar } from '../../lib/http.js';
import { nombreCortoSucursal } from '@grupo/shared';
import { desviacion, esDesviacionNotable } from './consumo.js';
import { hayInventario } from './existencias.js';
import { FECHA_ISO, redondear } from './comun.js';

export function rutasTraza({ db }) {
  const r = Router();
  const emp = (req) => req.ctx.empresa.id;
  r.use(requierePermiso('rep:inventario', 'rep:costeo'));

  /** De una o varias tandas, a qué tiendas fue y cuánto. */
  async function destinosDeTandas(q, empresaId, ids) {
    const mapa = new Map();
    if (!ids.length) return mapa;
    const { rows } = await q.query(
      `select dt.produccion_id, dt.gramos::float8 as gramos, d.id as despacho_id, d.fecha::text as fecha, d.estado, d.gramos_confirmados_recibidos::float8 as gramos_confirmados_recibidos,
              d.discrepancia, s.id as sucursal_id, s.nombre as nombre_largo, s.alias
         from rep.despacho_tandas dt join rep.despachos d on d.id = dt.despacho_id join core.sucursales s on s.id = d.sucursal_id
        where dt.empresa_id = $1 and dt.produccion_id = any($2::uuid[]) order by d.fecha, s.nombre`, [empresaId, ids]);
    for (const f of rows) {
      const l = mapa.get(f.produccion_id) ?? [];
      l.push({ ...f, sucursal_nombre: nombreCortoSucursal(f.nombre_largo, f.alias) });
      mapa.set(f.produccion_id, l);
    }
    return mapa;
  }

  const TANDA = `p.id, p.lote, p.fecha::text as fecha, p.kg::float8 as kg, p.kg_restante::float8 as kg_restante, p.operario, p.notas, p.created_at, p.sabor_id, sa.nombre as sabor_nombre`;

  /** Busca tandas por código de lote (lo que va impreso en la etiqueta) o por sabor. */
  r.get('/buscar', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 3) throw malaPeticion('Escribe al menos 3 caracteres');
    const { rows } = await db.query(
      `select ${TANDA} from prod.producciones p join rep.sabores sa on sa.id = p.sabor_id
        where p.empresa_id = $1 and (p.lote ilike $2 or sa.nombre ilike $2) order by p.fecha desc, p.created_at desc limit 25`, [emp(req), `%${q.replace(/[%_]/g, '')}%`]);
    res.json(rows);
  });

  /** Una tanda: qué materia prima se llevó (con su lote) y a qué tiendas fue a parar. */
  r.get('/tanda/:id', async (req, res) => {
    const tanda = (await db.query(`select ${TANDA} from prod.producciones p join rep.sabores sa on sa.id = p.sabor_id where p.id = $1 and p.empresa_id = $2`, [validar(uuid, req.params.id), emp(req)])).rows[0];
    if (!tanda) throw noEncontrado('Tanda no encontrada');
    const inv = await hayInventario(db);
    const [consumos, lotes, destinos] = await Promise.all([
      db.query(`select c.insumo_id, i.nombre, i.unidad, c.cantidad_sugerida::float8 as sugerida, c.cantidad_real::float8 as real, c.sin_lote::float8 as sin_lote
                  from prod.consumos c join prod.costeo_insumos i on i.id = c.insumo_id where c.produccion_id = $1 order by i.nombre`, [tanda.id]),
      db.query(`select pl.insumo_id, pl.lote_id, pl.cantidad::float8 as cantidad${inv ? ', l.fecha_ingreso::text as fecha_ingreso, l.fecha_vencimiento::text as fecha_vencimiento' : ''}
                  from prod.produccion_lotes pl ${inv ? 'left join rinv.lotes_mec3 l on l.id = pl.lote_id' : ''} where pl.produccion_id = $1`, [tanda.id]),
      destinosDeTandas(db, emp(req), [tanda.id]),
    ]);
    const porInsumo = new Map();
    for (const l of lotes.rows) porInsumo.set(l.insumo_id, [...(porInsumo.get(l.insumo_id) ?? []), { lote_id: l.lote_id, cantidad: l.cantidad, fecha_ingreso: l.fecha_ingreso ?? null, fecha_vencimiento: l.fecha_vencimiento ?? null }]);
    res.json({
      tanda,
      consumo_registrado: consumos.rows.length > 0,   // sin consumo registrado ≠ consumo cero
      insumos: consumos.rows.map((c) => { const d = desviacion(c.sugerida, c.real); return { ...c, desviacion: d, desviacion_notable: esDesviacionNotable(d), lotes: porInsumo.get(c.insumo_id) ?? [] }; }),
      destinos: destinos.get(tanda.id) ?? [],
    });
  });

  /** Lotes de materia prima (para empezar la búsqueda hacia adelante). */
  r.get('/lotes', async (req, res) => {
    if (!(await hayInventario(db))) return res.json([]);
    const q = String(req.query.q || '').trim();
    const { rows } = await db.query(
      `select l.id, i.nombre as insumo_nombre, i.unidad, l.cantidad_inicial::float8 as cantidad_inicial, l.cantidad_restante::float8 as cantidad_restante,
              l.fecha_ingreso::text as fecha_ingreso, l.fecha_vencimiento::text as fecha_vencimiento,
              (select count(*)::int from prod.produccion_lotes pl where pl.lote_id = l.id) as tandas
         from rinv.lotes_mec3 l join rinv.insumos_fab i on i.id = l.insumo_id
        where l.empresa_id = $1 and ($2 = '' or i.nombre ilike $3) order by l.fecha_ingreso desc, l.n desc limit 60`, [emp(req), q, `%${q.replace(/[%_]/g, '')}%`]);
    res.json(rows);
  });

  /** Un lote de materia prima: qué tandas lo usaron y a qué tiendas fueron. Es el «botón de retiro». */
  r.get('/lote/:id', async (req, res) => {
    if (!(await hayInventario(db))) throw noEncontrado('Lote no encontrado');
    const lote = (await db.query(
      `select l.id, l.insumo_id, i.nombre as insumo_nombre, i.unidad, l.cantidad_inicial::float8 as cantidad_inicial, l.cantidad_restante::float8 as cantidad_restante,
              l.fecha_ingreso::text as fecha_ingreso, l.fecha_vencimiento::text as fecha_vencimiento, l.motivo
         from rinv.lotes_mec3 l join rinv.insumos_fab i on i.id = l.insumo_id where l.id = $1 and l.empresa_id = $2`, [validar(uuid, req.params.id), emp(req)])).rows[0];
    if (!lote) throw noEncontrado('Lote no encontrado');
    const [tandas, salidas] = await Promise.all([
      db.query(`select pl.cantidad::float8 as cantidad, p.id, p.lote, p.fecha::text as fecha, p.kg::float8 as kg, p.operario, sa.nombre as sabor_nombre
                  from prod.produccion_lotes pl join prod.producciones p on p.id = pl.produccion_id join rep.sabores sa on sa.id = p.sabor_id
                 where pl.lote_id = $1 order by p.fecha, p.created_at`, [lote.id]),
      db.query('select fecha::text as fecha, sum(cantidad)::float8 as cantidad from rinv.salida_lotes where lote_id = $1 group by fecha order by fecha', [lote.id]),
    ]);
    // La materia prima también sale de bodega toda junta, no tanda por tanda: de los DÍAS en que salió se llega a las
    // tandas producidas esos días (menos preciso, pero es la diferencia entre poder rastrear y no poder).
    const fechas = salidas.rows.map((s) => s.fecha);
    const deEsosDias = fechas.length
      ? (await db.query(`select p.id, p.lote, p.fecha::text as fecha, p.kg::float8 as kg, p.operario, sa.nombre as sabor_nombre from prod.producciones p join rep.sabores sa on sa.id = p.sabor_id
                          where p.empresa_id = $1 and p.fecha = any($2::date[]) order by p.fecha, p.created_at`, [emp(req), fechas])).rows
      : [];
    const destinos = await destinosDeTandas(db, emp(req), [...new Set([...tandas.rows, ...deEsosDias].map((t) => t.id))]);
    // Lo que de verdad se necesita en una emergencia: la lista corta de a quién llamar.
    const tiendas = new Map();
    for (const t of [...tandas.rows, ...deEsosDias.filter((d) => !tandas.rows.some((x) => x.id === d.id))]) {
      for (const d of destinos.get(t.id) ?? []) {
        const a = tiendas.get(d.sucursal_id) ?? { sucursal_id: d.sucursal_id, nombre: d.sucursal_nombre, gramos: 0, fechas: new Set() };
        a.gramos = redondear(a.gramos + d.gramos); a.fechas.add(d.fecha); tiendas.set(d.sucursal_id, a);
      }
    }
    res.json({
      lote, salidas: salidas.rows,
      tandas_de_esos_dias: deEsosDias.map((t) => ({ ...t, destinos: destinos.get(t.id) ?? [] })),
      tandas: tandas.rows.map((t) => ({ ...t, destinos: destinos.get(t.id) ?? [] })),
      tiendas_afectadas: [...tiendas.values()].map((t) => ({ ...t, fechas: [...t.fechas].sort() })).sort((a, b) => b.gramos - a.gramos),
    });
  });

  r.get('/sucursales', async (req, res) => {
    const { rows } = await db.query(`select id, nombre, alias, tipo from core.sucursales where empresa_id = $1 and activo and tipo <> 'fabrica' order by orden, nombre`, [emp(req)]);
    res.json(rows.map((s) => ({ id: s.id, nombre: nombreCortoSucursal(s.nombre, s.alias) })));
  });

  /** De una tienda y un día: qué tandas recibió y de qué lotes venían (el reclamo que llega del mostrador). */
  r.get('/sucursal/:sucursalId/:fecha', async (req, res) => {
    const sucursalId = validar(uuid, req.params.sucursalId);
    if (!FECHA_ISO.test(req.params.fecha)) throw malaPeticion('Fecha inválida');
    const filas = (await db.query(
      `select dt.gramos::float8 as gramos, d.id as despacho_id, sa.nombre as sabor_nombre, p.id as produccion_id, p.lote, p.fecha::text as fecha_produccion, p.operario
         from rep.despacho_tandas dt join rep.despachos d on d.id = dt.despacho_id join prod.producciones p on p.id = dt.produccion_id join rep.sabores sa on sa.id = d.sabor_id
        where d.empresa_id = $1 and d.sucursal_id = $2 and d.fecha = $3 order by sa.nombre, p.fecha`, [emp(req), sucursalId, req.params.fecha])).rows;
    const ids = [...new Set(filas.map((f) => f.produccion_id))];
    const inv = await hayInventario(db);
    const lotes = ids.length ? (await db.query(
      `select pl.produccion_id, pl.lote_id, pl.cantidad::float8 as cantidad, ci.nombre as insumo_nombre${inv ? ', l.fecha_ingreso::text as fecha_ingreso, l.fecha_vencimiento::text as fecha_vencimiento' : ''}
         from prod.produccion_lotes pl join prod.costeo_insumos ci on ci.id = pl.insumo_id ${inv ? 'left join rinv.lotes_mec3 l on l.id = pl.lote_id' : ''}
        where pl.produccion_id = any($1::uuid[])`, [ids])).rows : [];
    res.json({ sucursal_id: sucursalId, fecha: req.params.fecha, recibido: filas.map((f) => ({ ...f, lotes: lotes.filter((l) => l.produccion_id === f.produccion_id) })) });
  });

  return r;
}
