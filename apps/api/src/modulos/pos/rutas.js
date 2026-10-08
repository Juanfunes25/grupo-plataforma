import { Router } from 'express';
import { rutasCatalogo } from './catalogo.js';
import { rutasVentas } from './ventas.js';
import { rutasTurnos } from './turnos.js';
import { rutasFiscal } from './fiscal.js';
import { rutasReportes, rutasKds } from './reportes.js';
import { rutasAntifraude } from './antifraude.js';
import { rutasCierres } from './cierres.js';
import { rutasCajaChica } from './cajaChica.js';
import { rutasDashboard } from './dashboard.js';

export function rutasPos(deps) {
  const r = Router();
  r.use('/catalogo', rutasCatalogo(deps));
  r.use('/ventas', rutasVentas(deps));
  r.use('/turno', rutasTurnos(deps));
  r.use('/puntos-emision', rutasFiscal(deps));
  r.use('/reportes', rutasReportes(deps));
  r.use('/kds', rutasKds(deps));
  r.use('/antifraude', rutasAntifraude(deps));
  r.use('/cierres', rutasCierres(deps));
  r.use('/caja-chica', rutasCajaChica(deps));
  r.use('/dashboard', rutasDashboard(deps));
  return r;
}
