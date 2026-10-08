// Registra en la bitácora inalterable lo que se hace dentro de la app (productos que se quitan de una orden armada, descuentos,
// búsquedas de facturas…). Nunca bloquea ni muestra errores: si falla, la operación sigue igual.
import { post } from '../api.js';

export function registrarEvento(accion, detalle = {}, sucursalId = null) {
  post('/pos/ventas/evento', { accion, detalle, sucursal_id: sucursalId || null }).catch(() => {});
}
