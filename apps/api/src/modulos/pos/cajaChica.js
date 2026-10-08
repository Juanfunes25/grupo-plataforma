import { Router } from 'express';
import { z } from 'zod';
import { fechaHN, sumarDias } from '@grupo/shared';
import { requierePermiso, resolverSucursal } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { malaPeticion, uuid, validar, dinero, fechaISO } from '../../lib/http.js';

/** Categorías de fábrica (las de Italo Facturación); cada empresa puede cambiarlas en core.config 'caja_chica'. */
export const CATEGORIAS_CAJA_CHICA = ['Agua', 'Alquileres', 'Insumos y compras menores', 'Limpieza', 'Otros gastos', 'Publicidad y RRPP',
  'Reparaciones y conservación', 'Sueldos y salarios', 'Telefonía e internet', 'Transportes'];

const FECHA = `m.fecha`;

/** Caja chica = entradas y salidas de efectivo de la sucursal (pos.movimientos_caja). No necesita turno abierto. */
export function rutasCajaChica({ db }) {
  const r = Router();
  const categoriasDe = async (empresaId) => {
    const v = (await db.query(`select valor from core.config where empresa_id = $1 and clave = 'caja_chica'`, [empresaId])).rows[0]?.valor;
    return Array.isArray(v?.categorias) && v.categorias.length ? v.categorias.map(String) : CATEGORIAS_CAJA_CHICA;
  };

  r.get('/', requierePermiso('pos:caja', 'pos:reportes'), async (req, res) => {
    const f = validar(z.object({
      sucursal_id: uuid.optional(), desde: fechaISO.optional(), hasta: fechaISO.optional(), tipo: z.enum(['ingreso', 'salida']).optional(),
      limite: z.coerce.number().int().min(1).max(1000).default(500),
    }), req.query);
    const hoy = fechaHN();
    const args = [req.ctx.empresa.id, req.ctx.sucursalIds, f.desde ?? sumarDias(hoy, -29), f.hasta ?? hoy, f.sucursal_id ?? null, f.tipo ?? null];
    const filtro = `m.empresa_id = $1 and ($2::uuid[] = '{}' or m.sucursal_id = any($2::uuid[])) and ${FECHA} between $3::date and $4::date
                    and ($5::uuid is null or m.sucursal_id = $5) and ($6::text is null or m.tipo = $6)`;
    const [items, tot, cats] = await Promise.all([
      db.query(`select m.id, m.fecha, m.created_at, m.tipo, m.categoria, m.monto, m.concepto, m.sucursal_id, s.nombre as sucursal, u.nombre as usuario
                  from pos.movimientos_caja m join core.sucursales s on s.id = m.sucursal_id left join core.usuarios u on u.id = m.usuario_id
                 where ${filtro} order by m.fecha desc, m.created_at desc limit $7`, [...args, f.limite]),
      db.query(`select m.tipo, coalesce(sum(m.monto),0)::numeric as monto, count(*)::int as n from pos.movimientos_caja m where ${filtro} group by m.tipo`, args),
      db.query(`select coalesce(m.categoria, 'Sin categoría') as categoria, coalesce(sum(m.monto),0)::numeric as monto, count(*)::int as movimientos
                  from pos.movimientos_caja m where ${filtro} and m.tipo = 'salida' group by 1 order by 2 desc`, args),
    ]);
    const t = (tipo) => tot.rows.find((x) => x.tipo === tipo) ?? { monto: 0, n: 0 };
    res.json({
      desde: args[2], hasta: args[3], items: items.rows,
      totales: { salidas: t('salida').monto, ingresos: t('ingreso').monto, movimientos: t('salida').n + t('ingreso').n, neto: Math.round((t('ingreso').monto - t('salida').monto) * 100) / 100 },
      por_categoria: cats.rows, categorias: await categoriasDe(req.ctx.empresa.id),
    });
  });

  r.post('/', requierePermiso('pos:caja'), async (req, res) => {
    const b = validar(z.object({
      sucursal_id: uuid.optional(), tipo: z.enum(['ingreso', 'salida']).default('salida'),
      categoria: z.string().trim().max(60).optional().nullable(),
      monto: dinero.refine((n) => n > 0, 'El monto debe ser mayor a 0'),
      concepto: z.string().trim().max(200).optional().nullable(), fecha: fechaISO.optional(),
    }), req.body);
    const hoy = fechaHN();
    const fecha = b.fecha ?? hoy;
    if (fecha > hoy) throw malaPeticion('La fecha no puede ser futura');
    // Solo quien ve reportes puede registrar con fecha pasada; el cajero registra el día de hoy.
    if (fecha !== hoy && !req.ctx.permisos.has('pos:reportes')) throw malaPeticion('Solo puedes registrar movimientos de hoy');
    const categorias = await categoriasDe(req.ctx.empresa.id);
    if (b.tipo === 'salida' && b.categoria && !categorias.includes(b.categoria)) throw malaPeticion('Categoría no válida');
    const concepto = (b.concepto ?? '').trim() || b.categoria;
    if (!concepto || concepto.length < 3) throw malaPeticion('Escribe el concepto o elige una categoría');
    const m = await db.tx(async (q) => {
      const suc = await resolverSucursal(q, req.ctx, b.sucursal_id);
      // Si el usuario tiene turno abierto en la sucursal, el movimiento cuenta en el cuadre de ese turno.
      const turno = (await q.query(`select id from pos.turnos where sucursal_id = $1 and cajero_id = $2 and estado = 'abierto'`, [suc.id, req.ctx.usuario.id])).rows[0];
      const m = (await q.query(
        `insert into pos.movimientos_caja (empresa_id, sucursal_id, turno_id, tipo, categoria, monto, concepto, usuario_id, fecha) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [req.ctx.empresa.id, suc.id, fecha === hoy ? (turno?.id ?? null) : null, b.tipo, b.categoria ?? null, b.monto, concepto, req.ctx.usuario.id, fecha])).rows[0];
      await auditar(q, req.ctx, 'movimiento_caja', 'caja_chica', m.id, { tipo: b.tipo, categoria: b.categoria, monto: b.monto, concepto, fecha }, { sucursalId: suc.id });
      return m;
    });
    res.status(201).json(m);
  });

  return r;
}
