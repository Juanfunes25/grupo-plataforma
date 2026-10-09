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
import { rutasTablero } from './tablero/rutas.js';
import { rutasBusqueda } from './busqueda/rutas.js';
import { rutasMensajeria } from './mensajeria/rutas.js';
import { rutasCompras } from './compras/rutas.js';
import { rutasFiscalAsistente } from './fiscal/rutas.js';
import { rutasSistema } from './salud/rutas.js';
import { rutasCrm } from './crm/rutas.js';

/**
 * Monta un módulo que se importa la primera vez que alguien lo usa (no al arrancar). Para módulos poco usados que arrastran
 * dependencias pesadas: Planilla trae exceljs (~250 ms de arranque, varias veces más en el plan gratuito de Render).
 */
function perezoso(cargar, deps) {
  let listo = null;
  return (req, res, next) => {
    listo ??= cargar().then((fabrica) => fabrica(deps)).catch((e) => { listo = null; throw e; });
    listo.then((r) => r(req, res, next), next);
  };
}

/** Cada módulo expone rutas bajo /api/<modulo>. Aquí se montan todos. */
export function montarModulos(router, deps) {
  router.use('/admin', rutasAdmin(deps));
  router.use('/pos', rutasPos(deps));
  router.use('/inv', rutasInv(deps));
  router.use('/rrhh', rutasRrhh(deps));
  router.use('/planilla', perezoso(() => import('./planilla/rutas.js').then((m) => m.rutasPlanilla), deps));
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
  router.use('/crm', rutasCrm(deps));
  router.use('/tablero', rutasTablero(deps));
  router.use('/busqueda', rutasBusqueda(deps));
  router.use('/mensajeria', rutasMensajeria(deps));
  router.use('/compras', rutasCompras(deps));
  router.use('/fiscal', rutasFiscalAsistente(deps));
  router.use('/sistema', rutasSistema(deps));
}
