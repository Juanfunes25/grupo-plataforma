import { Router } from 'express';
import { z } from 'zod';
import { requierePermiso } from '../../lib/contexto.js';
import { validar, uuid } from '../../lib/http.js';
import { analizar } from './analisis.js';
import { recolectar } from './recolectar.js';

/** Gerente digital de UNA empresa (la activa). */
export function rutasGerente({ db }) {
  const r = Router();
  r.get('/', requierePermiso('gerente:ver'), async (req, res) => {
    const { dias, sucursal_id } = validar(z.object({ dias: z.coerce.number().int().min(7).max(90).default(28), sucursal_id: uuid.optional() }), req.query);
    const ids = sucursal_id ? [sucursal_id] : req.ctx.sucursalIds;
    if (sucursal_id && req.ctx.sucursalIds.length && !req.ctx.sucursalIds.includes(sucursal_id)) return res.json({ error: 'Sin acceso a esa sucursal' });
    const datos = await recolectar(db, { empresa: req.ctx.empresa, sucursalIds: ids, dias });
    res.json(analizar(datos));
  });
  return r;
}
