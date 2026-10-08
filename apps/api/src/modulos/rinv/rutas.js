import { Router } from 'express';
import { prohibido } from '../../lib/http.js';
import { rutasFabrica } from './fabrica.js';
import { rutasSucursal } from './sucursal.js';
import { rutasReportes } from './reportes.js';
import { rutasRfid } from './rfid.js';
import { rutasIncidencias } from './incidencias.js';
import { rutasMantenimiento } from './mantenimiento.js';

/**
 * /api/rinv — Inventario de reposición (Italo): insumos de fábrica y de sucursal, lotes Mec3, vencimientos, valor,
 * RFID de freezers, incidencias con foto, mantenimiento. Solo en empresas con el módulo `reposicion`.
 * Permisos: rep:inventario (mover inventario y RFID), rep:costeo (precios y valor), rep:pesar (tiendas: reportar),
 * rep:producir (producción: alertas, RFID, incidencias), rep:ver (mantenimiento).
 */
export function rutasRinv(deps) {
  const r = Router();
  r.use((req, _res, next) => {
    if (!req.ctx.empresa.modulos.includes('reposicion')) throw prohibido(`${req.ctx.empresa.nombre} no tiene el módulo de reposición`);
    next();
  });
  r.use('/rfid', rutasRfid(deps));
  r.use('/incidencias', rutasIncidencias(deps));
  r.use('/mantenimiento', rutasMantenimiento(deps));
  r.use('/', rutasFabrica(deps));
  r.use('/', rutasSucursal(deps));
  r.use('/', rutasReportes(deps));
  return r;
}
