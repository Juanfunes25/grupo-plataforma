import { Router } from 'express';
import { prohibido } from '../../lib/http.js';
import { rutasCatalogoEco } from './catalogo.js';
import { rutasCotizacionesEco } from './cotizaciones.js';
import { rutasInventarioEco } from './inventario.js';

/** /api/eco — lado comercial de EcoStone: catálogo de piedra, cotizaciones de proyecto e inventario de piedra. */
export function rutasEco(deps) {
  const r = Router();
  r.use((req, _res, next) => {
    if (!req.ctx.empresa.modulos.includes('fabrica')) throw prohibido(`${req.ctx.empresa.nombre} no usa el módulo de fábrica`);
    next();
  });
  r.use('/cotizaciones', rutasCotizacionesEco(deps));
  r.use('/inventario', rutasInventarioEco(deps));
  r.use('/', rutasCatalogoEco(deps));
  return r;
}
