import { Router } from 'express';
import { prohibido } from '../../lib/http.js';
import { rutasCatalogo } from './catalogo.js';
import { rutasSalidas } from './salidas.js';
import { rutasCotizacionesDis } from './cotizaciones.js';

/** /api/diserco — catálogo, inventario, cotizaciones y salidas a proyecto. Solo empresas con el módulo `distribuidora`. */
export function rutasDiserco(deps) {
  const r = Router();
  r.use((req, _res, next) => {
    if (!req.ctx.empresa.modulos.includes('distribuidora')) throw prohibido(`${req.ctx.empresa.nombre} no usa el módulo de distribuidora`);
    next();
  });
  rutasCatalogo(r, deps);
  rutasSalidas(r, deps);
  rutasCotizacionesDis(r, deps);
  return r;
}
