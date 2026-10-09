// Rol de ayuda separado del contenido: el Layout lo necesita al arrancar y el texto de la ayuda se descarga después.

/** Rol de la plataforma → rol de ayuda. */
export function rolDeAyuda(rol, esDuenoGrupo) {
  if (esDuenoGrupo) return 'dueno';
  return { dueno: 'dueno', admin: 'dueno', contador: 'dueno', solo_lectura: 'dueno', gerente: 'gerente', cajero: 'cajero', ventas: 'cajero', bodega: 'despachador', gestor: 'despachador', produccion: 'produccion' }[rol] ?? 'cajero';
}
