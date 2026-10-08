import { Router } from 'express';
import { prohibido } from '../../lib/http.js';
import { rutasTandas } from './tandas.js';
import { rutasCosteo } from './costeoRutas.js';
import { rutasTraza } from './traza.js';

/** Rutas /api/prod — producción de gelato, trazabilidad y costeo. Solo en empresas con el módulo `reposicion` (Italo). */
export function rutasProd(deps) {
  const r = Router();
  r.use((req, _res, next) => {
    if (!req.ctx.empresa.modulos.includes('reposicion')) throw prohibido(`${req.ctx.empresa.nombre} no tiene el módulo de reposición de gelato`);
    next();
  });
  r.use('/costeo', rutasCosteo(deps));
  r.use('/traza', rutasTraza(deps));
  r.use('/', rutasTandas(deps));
  return r;
}
