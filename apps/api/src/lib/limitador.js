// Límite de intentos en memoria (login / PIN). Un servidor = un proceso, suficiente aquí.
export function crearLimitador({ max = 5, ventanaMs = 10 * 60 * 1000 } = {}) {
  const intentos = new Map();
  const limpiar = () => {
    const ahora = Date.now();
    for (const [k, v] of intentos) if (ahora - v.desde > ventanaMs) intentos.delete(k);
  };
  return {
    bloqueado(clave) {
      limpiar();
      const v = intentos.get(clave);
      return Boolean(v && v.n >= max);
    },
    fallo(clave) {
      const v = intentos.get(clave);
      if (!v || Date.now() - v.desde > ventanaMs) intentos.set(clave, { n: 1, desde: Date.now() });
      else v.n += 1;
    },
    exito(clave) { intentos.delete(clave); },
    reiniciar() { intentos.clear(); },
  };
}
