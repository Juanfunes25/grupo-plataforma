import { Router } from 'express';
import { z } from 'zod';
import { fechaHN, sumarDias } from '@grupo/shared';
import { requierePermiso, resolverSucursal } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { malaPeticion, noEncontrado, prohibido, uuid, validar, dinero, fechaISO } from '../../lib/http.js';

const FECHA = (col) => `(${col} at time zone 'America/Tegucigalpa')::date`;

/**
 * Estado de resultados operativo de UNA empresa (o una sucursal) en un rango.
 *   ventas netas = total cobrado − ISV
 *   costo de ventas = costo de receta congelado en cada línea al cobrar
 *   gastos = fin.gastos no anulados, agrupados por tipo
 */
export async function resultadosEmpresa(q, { empresaId, sucursalIds = [], sucursalId = null, desde, hasta }) {
  const sucArgs = [sucursalIds, sucursalId];
  const [v, c, g] = await Promise.all([
    q.query(`select count(*)::int as facturas, coalesce(sum(total),0)::numeric as bruto, coalesce(sum(isv_total),0)::numeric as isv
               from pos.ventas v where v.empresa_id = $1 and v.estado = 'pagada' and ${FECHA('v.fecha_emision')} between $2::date and $3::date
                and ($4::uuid[] = '{}' or v.sucursal_id = any($4::uuid[])) and ($5::uuid is null or v.sucursal_id = $5)`, [empresaId, desde, hasta, ...sucArgs]),
    q.query(`select coalesce(sum(d.costo_unitario * d.cantidad),0)::numeric as costo,
                    coalesce(sum(d.monto) filter (where d.costo_unitario is null),0)::numeric as venta_sin_costo
               from pos.detalle_venta d join pos.ventas v on v.id = d.venta_id
              where v.empresa_id = $1 and v.estado = 'pagada' and ${FECHA('v.fecha_emision')} between $2::date and $3::date
                and ($4::uuid[] = '{}' or v.sucursal_id = any($4::uuid[])) and ($5::uuid is null or v.sucursal_id = $5)`, [empresaId, desde, hasta, ...sucArgs]),
    q.query(`select coalesce(cg.grupo, 'otro') as grupo, sum(g.monto - g.isv)::numeric as monto
               from fin.gastos g left join fin.categorias_gasto cg on cg.id = g.categoria_id
              where g.empresa_id = $1 and not g.anulado and g.fecha between $2::date and $3::date
                and ($4::uuid[] = '{}' or g.sucursal_id is null or g.sucursal_id = any($4::uuid[])) and ($5::uuid is null or g.sucursal_id = $5)
              group by 1`, [empresaId, desde, hasta, ...sucArgs]),
  ]);
  const bruto = v.rows[0].bruto, isv = v.rows[0].isv;
  const ventasNetas = Math.round((bruto - isv) * 100) / 100;
  const costoVentas = Math.round(c.rows[0].costo * 100) / 100;
  const gastosPorGrupo = Object.fromEntries(g.rows.map((x) => [x.grupo, Math.round(x.monto * 100) / 100]));
  // Compras de mercadería registradas como gasto "costo_venta" no se suman otra vez al costo de recetas.
  const gastosOperativos = Math.round(g.rows.filter((x) => x.grupo !== 'costo_venta').reduce((s, x) => s + x.monto, 0) * 100) / 100;
  const utilidadBruta = Math.round((ventasNetas - costoVentas) * 100) / 100;
  return {
    facturas: v.rows[0].facturas, ventas_brutas: bruto, isv, ventas_netas: ventasNetas,
    costo_ventas: costoVentas, utilidad_bruta: utilidadBruta, margen_bruto_pct: ventasNetas > 0 ? Math.round((utilidadBruta / ventasNetas) * 1000) / 10 : null,
    gastos_por_grupo: gastosPorGrupo, gastos_operativos: gastosOperativos,
    utilidad_operativa: Math.round((utilidadBruta - gastosOperativos) * 100) / 100,
    venta_sin_costo: c.rows[0].venta_sin_costo,   // ventas de productos sin receta: el costo real no está capturado
  };
}

export function rutasFin({ db, ctxMgr }) {
  const r = Router();
  const rango = z.object({ desde: fechaISO.optional(), hasta: fechaISO.optional(), sucursal_id: uuid.optional() });

  r.get('/categorias', requierePermiso('fin:ver', 'fin:gastos'), async (req, res) =>
    res.json((await db.query('select * from fin.categorias_gasto where empresa_id = $1 and activo order by grupo, nombre', [req.ctx.empresa.id])).rows));
  r.post('/categorias', requierePermiso('fin:gastos'), async (req, res) => {
    const b = validar(z.object({ nombre: z.string().trim().min(2).max(60), grupo: z.enum(['costo_venta', 'operativo', 'nomina', 'alquiler', 'servicios', 'marketing', 'impuestos', 'financiero', 'otro']) }), req.body);
    res.status(201).json((await db.query('insert into fin.categorias_gasto (empresa_id, nombre, grupo) values ($1,$2,$3) returning *', [req.ctx.empresa.id, b.nombre, b.grupo])).rows[0]);
  });

  r.get('/gastos', requierePermiso('fin:ver'), async (req, res) => {
    const f = validar(rango.extend({ categoria_id: uuid.optional() }), req.query);
    const hoy = fechaHN();
    const { rows } = await db.query(
      `select g.*, c.nombre as categoria, c.grupo, s.nombre as sucursal, p.nombre as proveedor
         from fin.gastos g left join fin.categorias_gasto c on c.id = g.categoria_id left join core.sucursales s on s.id = g.sucursal_id left join core.terceros p on p.id = g.proveedor_id
        where g.empresa_id = $1 and g.fecha between $2::date and $3::date and ($4::uuid is null or g.sucursal_id = $4) and ($5::uuid is null or g.categoria_id = $5)
          and ($6::uuid[] = '{}' or g.sucursal_id is null or g.sucursal_id = any($6::uuid[]))
        order by g.fecha desc, g.created_at desc limit 500`,
      [req.ctx.empresa.id, f.desde ?? sumarDias(hoy, -30), f.hasta ?? hoy, f.sucursal_id ?? null, f.categoria_id ?? null, req.ctx.sucursalIds]);
    res.json(rows);
  });
  r.post('/gastos', requierePermiso('fin:gastos'), async (req, res) => {
    const b = validar(z.object({
      fecha: fechaISO.optional(), sucursal_id: uuid.optional().nullable(), categoria_id: uuid, proveedor_id: uuid.optional().nullable(),
      descripcion: z.string().trim().min(3).max(200), monto: dinero.refine((n) => n > 0, 'El monto debe ser mayor a 0'), isv: dinero.default(0),
      documento: z.string().trim().max(40).optional().nullable(), forma_pago: z.string().trim().max(30).optional().nullable(), pagado: z.boolean().default(true),
    }), req.body);
    if (b.isv > b.monto) throw malaPeticion('El ISV no puede ser mayor al monto');
    const out = await db.tx(async (q) => {
      const suc = b.sucursal_id ? await resolverSucursal(q, req.ctx, b.sucursal_id) : null;
      const cat = await q.query('select 1 from fin.categorias_gasto where id = $1 and empresa_id = $2', [b.categoria_id, req.ctx.empresa.id]);
      if (!cat.rowCount) throw noEncontrado('Categoría inexistente');
      const g = (await q.query(
        `insert into fin.gastos (empresa_id,sucursal_id,fecha,categoria_id,proveedor_id,descripcion,monto,isv,documento,forma_pago,pagado,registrado_por)
         values ($1,$2,coalesce($3::date,(now() at time zone 'America/Tegucigalpa')::date),$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
        [req.ctx.empresa.id, suc?.id ?? null, b.fecha ?? null, b.categoria_id, b.proveedor_id ?? null, b.descripcion, b.monto, b.isv, b.documento ?? null, b.forma_pago ?? null, b.pagado, req.ctx.usuario.id])).rows[0];
      await auditar(q, req.ctx, 'gasto_registrado', 'gasto', g.id, { monto: g.monto, descripcion: g.descripcion }, { sucursalId: suc?.id });
      return g;
    });
    res.status(201).json(out);
  });
  r.post('/gastos/:id/anular', requierePermiso('fin:gastos'), async (req, res) => {
    const { motivo } = validar(z.object({ motivo: z.string().trim().min(3).max(200) }), req.body);
    const g = (await db.query('update fin.gastos set anulado = true where id = $1 and empresa_id = $2 and not anulado returning id, monto', [validar(uuid, req.params.id), req.ctx.empresa.id])).rows[0];
    if (!g) throw noEncontrado('Gasto no encontrado o ya anulado');
    await auditar(db, req.ctx, 'gasto_anulado', 'gasto', g.id, { motivo, monto: g.monto });
    res.json({ ok: true });
  });

  r.get('/resultados', requierePermiso('fin:ver'), async (req, res) => {
    const f = validar(rango, req.query);
    const hoy = fechaHN();
    res.json(await resultadosEmpresa(db, { empresaId: req.ctx.empresa.id, sucursalIds: req.ctx.sucursalIds, sucursalId: f.sucursal_id ?? null,
      desde: f.desde ?? `${hoy.slice(0, 8)}01`, hasta: f.hasta ?? hoy }));
  });

  // ── Operaciones entre empresas del grupo ─────────────────────────────────
  r.get('/intercompania', requierePermiso('fin:ver'), async (req, res) => {
    const { rows } = await db.query(
      `select i.*, o.nombre as origen, d.nombre as destino from fin.intercompania i join core.empresas o on o.id = i.empresa_origen_id join core.empresas d on d.id = i.empresa_destino_id
        where i.empresa_origen_id = $1 or i.empresa_destino_id = $1 order by i.fecha desc limit 200`, [req.ctx.empresa.id]);
    res.json(rows);
  });
  r.post('/intercompania', requierePermiso('fin:gastos'), async (req, res) => {
    const b = validar(z.object({ fecha: fechaISO.optional(), destino: z.string().min(1), concepto: z.string().trim().min(3).max(200), monto: dinero.refine((n) => n > 0, 'El monto debe ser mayor a 0') }), req.body);
    const dest = (await ctxMgr.empresas()).find((e) => e.codigo === b.destino);
    if (!dest || dest.id === req.ctx.empresa.id) throw malaPeticion('Elige otra empresa del grupo como contraparte');
    if (!req.ctx.usuario.es_dueno_grupo && req.ctx.rol !== 'dueno' && req.ctx.rol !== 'admin') throw prohibido('Solo dirección registra operaciones entre empresas');
    const i = (await db.query(
      `insert into fin.intercompania (fecha, empresa_origen_id, empresa_destino_id, concepto, monto, registrado_por)
       values (coalesce($1::date,(now() at time zone 'America/Tegucigalpa')::date),$2,$3,$4,$5,$6) returning *`,
      [b.fecha ?? null, req.ctx.empresa.id, dest.id, b.concepto, b.monto, req.ctx.usuario.id])).rows[0];
    await auditar(db, req.ctx, 'intercompania_registrada', 'intercompania', i.id, { destino: dest.codigo, monto: i.monto });
    res.status(201).json(i);
  });
  return r;
}
