import { Router } from 'express';
import { rutasCobranza } from './cobranza.js';

/** Cobranza de EcoStone y DISERCO bajo /api/crm/cobranza. */
export function rutasCrm(deps) {
  const r = Router();
  r.use('/cobranza', rutasCobranza(deps));
  return r;
}
