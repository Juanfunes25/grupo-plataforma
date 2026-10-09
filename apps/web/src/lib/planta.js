// Puestos de una sola pantalla: ciertas personas (producción y despacho de Italo, fabricación de EcoStone, gestión de proyectos de DISERCO)
// entran eligiendo su puesto y ven SOLO esa pantalla, sin menú lateral ni barra inferior. Vive en la pestaña (sessionStorage):
// al cerrar sesión desaparece.
export const PUESTOS = {
  italo: {
    rol: 'prod_despacho', boton: 'Despacho, producción e inventario', pregunta: '¿Qué vas a hacer?',
    funciones: { despacho: { titulo: 'Despacho', ruta: 'despacho' }, produccion: { titulo: 'Producción', ruta: 'gelato-produccion' }, inventario: { titulo: 'Inventario', ruta: 'gelato-inventario' } },
  },
  ecostone: { rol: 'produccion', boton: 'Fabricación', pregunta: '', funciones: { fabricacion: { titulo: 'Registrar producción', ruta: 'registrar-produccion' } } },
  diserco: { rol: 'gestor', boton: 'Gestión de proyecto', pregunta: '', funciones: { proyecto: { titulo: 'Salidas a proyecto', ruta: 'salidas' } } },
};
export const funcionDe = (empresa, funcion) => PUESTOS[empresa]?.funciones[funcion] ?? null;
const CLAVE = 'grupo.planta';
export function leerPlanta(empresa) {
  try {
    const v = JSON.parse(sessionStorage.getItem(CLAVE) || 'null');
    return v && v.empresa === empresa && funcionDe(empresa, v.funcion) ? v : null;
  } catch { return null; }
}
export function ponerPlanta(empresa, funcion) { try { sessionStorage.setItem(CLAVE, JSON.stringify({ empresa, funcion })); } catch { /* */ } }
export function quitarPlanta() { try { sessionStorage.removeItem(CLAVE); } catch { /* */ } }
