// Puesto de planta: la persona de producción y despacho entra eligiendo UNA función (Despacho, Producción o Inventario)
// y ve solo esa pantalla, sin menú lateral ni barra inferior. Vive en la pestaña (sessionStorage): al cerrar sesión desaparece.
export const FUNCIONES_PLANTA = {
  despacho: { titulo: 'Despacho', ruta: 'despacho' },
  produccion: { titulo: 'Producción', ruta: 'gelato-produccion' },
  inventario: { titulo: 'Inventario', ruta: 'gelato-inventario' },
};
const CLAVE = 'grupo.planta';
export function leerPlanta(empresa) {
  try {
    const v = JSON.parse(sessionStorage.getItem(CLAVE) || 'null');
    return v && v.empresa === empresa && FUNCIONES_PLANTA[v.funcion] ? v : null;
  } catch { return null; }
}
export function ponerPlanta(empresa, funcion) { try { sessionStorage.setItem(CLAVE, JSON.stringify({ empresa, funcion })); } catch { /* */ } }
export function quitarPlanta() { try { sessionStorage.removeItem(CLAVE); } catch { /* */ } }
