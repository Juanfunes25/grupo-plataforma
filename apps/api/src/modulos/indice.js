import { rutasAdmin } from './admin/rutas.js';
import { rutasPos } from './pos/rutas.js';
import { rutasInv } from './inv/rutas.js';
import { rutasRrhh } from './rrhh/rutas.js';
import { rutasFin } from './fin/rutas.js';
import { rutasTerceros } from './terceros/rutas.js';
import { rutasGrupo } from './grupo/rutas.js';
import { rutasGerente } from './gerente/rutas.js';
import { rutasAntifraude } from './antifraude/rutas.js';
import { rutasCotizaciones } from './cotizaciones/rutas.js';
import { rutasDiserco } from './diserco/index.js';
import { rutasEco } from './eco/rutas.js';
import { rutasFab } from './fab/rutas.js';
import { rutasProd } from './prod/rutas.js';
import { rutasRep } from './rep/rutas.js';
import { rutasRinv } from './rinv/rutas.js';
import { rutasDocumentos } from './documentos/rutas.js';

/** Cada módulo expone rutas bajo /api/<modulo>. Aquí se montan todos. */
export function montarModulos(router, deps) {
  router.use('/admin', rutasAdmin(deps));
  router.use('/pos', rutasPos(deps));
  router.use('/inv', rutasInv(deps));
  router.use('/rrhh', rutasRrhh(deps));
  router.use('/fin', rutasFin(deps));
  router.use('/terceros', rutasTerceros(deps));
  router.use('/grupo', rutasGrupo(deps));
  router.use('/gerente', rutasGerente(deps));
  router.use('/antifraude', rutasAntifraude(deps));
  router.use('/cotizaciones', rutasCotizaciones(deps));
  router.use('/diserco', rutasDiserco(deps));
  router.use('/eco', rutasEco(deps));
  router.use('/fab', rutasFab(deps));
  router.use('/prod', rutasProd(deps));
  router.use('/rep', rutasRep(deps));
  router.use('/rinv', rutasRinv(deps));
  router.use('/documentos', rutasDocumentos(deps));
}
