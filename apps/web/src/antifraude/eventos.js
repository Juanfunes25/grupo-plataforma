// Registra en la bitácora lo que se hace dentro de la app (pantallas que se abren, productos que se
// quitan de una orden, búsquedas…). Nunca bloquea ni muestra errores: si falla, la operación sigue igual.
// Cualquier pantalla puede llamarlo: registrarEvento('orden.quitar_producto', { producto, cantidad, monto }).
import { almacen, post } from '../api.js';

export function registrarEvento(accion, detalle = {}, sucursalId = null) {
  if (!almacen.leer()?.token) return;
  post('/antifraude/evento', { accion, detalle, sucursal_id: sucursalId || undefined }).catch(() => {});
}
