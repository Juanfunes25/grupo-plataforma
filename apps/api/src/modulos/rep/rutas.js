import { Router } from 'express';
import { soloReposicion } from './util.js';
import { rutasPesajes } from './pesajes.js';
import { rutasDespachos } from './despachos.js';
import { rutasPedidos } from './pedidos.js';
import { rutasCatalogo } from './catalogo.js';
import { rutasAnalitica } from './analitica.js';
import { rutasGerente } from './gerente.js';
import { rutasExtraccion } from './extraccion.js';
import { rutasTablero } from './tablero.js';

/**
 * /api/rep — Reposición de gelato (Italo). Solo funciona en empresas con el módulo `reposicion`.
 * Permisos: rep:pesar (tienda), rep:despachar (bodega), rep:producir, rep:ver (consumo), rep:costeo (administración).
 */
export function rutasRep(deps) {
  const r = Router();
  r.use(soloReposicion);
  r.use('/pesajes', rutasPesajes(deps));
  r.use('/despachos', rutasDespachos(deps));
  r.use('/pedidos', rutasPedidos(deps));
  r.use('/extraccion', rutasExtraccion(deps));
  r.use('/analitica', rutasAnalitica(deps));
  r.use('/gerente', rutasGerente(deps));
  r.use('/tablero', rutasTablero(deps));
  r.use('/', rutasCatalogo(deps));
  return r;
}
