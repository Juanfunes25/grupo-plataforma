import { Router } from 'express';
import { z } from 'zod';
import { fechaHN, sumarDias } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { uuid, validar, fechaISO } from '../../lib/http.js';

// El análisis vive en modulos/antifraude (analisis.js + reglas.js); aquí se re-exporta para el gerente digital.
import { REGLAS, FECHA, calcularAlertas } from '../antifraude/analisis.js';
export { REGLAS, calcularAlertas };

export function rutasAntifraude({ db }) {
  const r = Router();
  const reglasDe = async (ctx) => ({ ...REGLAS, ...((await db.query(`select valor from core.config where empresa_id = $1 and clave = 'antifraude'`, [ctx.empresa.id])).rows[0]?.valor ?? {}) });

  r.get('/', requierePermiso('pos:reportes'), async (req, res) => {
    const f = validar(z.object({ desde: fechaISO.optional(), hasta: fechaISO.optional() }), req.query);
    const hoy = fechaHN();
    const desde = f.desde ?? sumarDias(hoy, -6), hasta = f.hasta ?? hoy;
    const reglas = await reglasDe(req.ctx);
    res.json({ desde, hasta, reglas, alertas: await calcularAlertas(db, { empresaId: req.ctx.empresa.id, sucursalIds: req.ctx.sucursalIds, desde, hasta, reglas }) });
  });

  r.put('/reglas', requierePermiso('admin:empresa'), async (req, res) => {
    const esq = Object.fromEntries(Object.keys(REGLAS).map((k) => [k, z.coerce.number().min(0).max(100000).optional()]));
    const b = validar(z.object(esq), req.body);
    const nuevas = { ...(await reglasDe(req.ctx)), ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
    await db.query(
      `insert into core.config (empresa_id, clave, valor) values ($1, 'antifraude', $2::jsonb) on conflict (empresa_id, clave) do update set valor = excluded.valor, updated_at = now()`,
      [req.ctx.empresa.id, JSON.stringify(nuevas)]);
    await auditar(db, req.ctx, 'reglas_antifraude', 'config', 'antifraude', b);
    res.json(nuevas);
  });

  // Caja chica: todas las entradas/salidas de efectivo registradas en los turnos.
  r.get('/movimientos-caja', requierePermiso('pos:reportes'), async (req, res) => {
    const f = validar(z.object({ desde: fechaISO.optional(), hasta: fechaISO.optional(), sucursal_id: uuid.optional() }), req.query);
    const hoy = fechaHN();
    const { rows } = await db.query(
      `select m.id, m.created_at, m.tipo, m.monto, m.concepto, s.nombre as sucursal, u.nombre as usuario
         from pos.movimientos_caja m join core.sucursales s on s.id = m.sucursal_id left join core.usuarios u on u.id = m.usuario_id
        where m.empresa_id = $1 and ($2::uuid[] = '{}' or m.sucursal_id = any($2::uuid[])) and ($5::uuid is null or m.sucursal_id = $5)
          and ${FECHA('m.created_at')} between $3::date and $4::date order by m.created_at desc limit 500`,
      [req.ctx.empresa.id, req.ctx.sucursalIds, f.desde ?? sumarDias(hoy, -29), f.hasta ?? hoy, f.sucursal_id ?? null]);
    res.json(rows);
  });
  return r;
}
