// Identificador de este navegador/equipo. Se manda en cada petición (X-Dispositivo) para detectar
// entradas desde dispositivos nuevos y el uso de una misma cuenta en dos equipos a la vez.
const CLAVE = 'grupo.dispositivo';
let id = null;

export function idDispositivo() {
  if (id) return id;
  try {
    id = localStorage.getItem(CLAVE);
    if (!id) {
      id = (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).replace(/-/g, '');
      localStorage.setItem(CLAVE, id);
    }
  } catch {
    id = id ?? `tmp${Math.random().toString(36).slice(2)}`;
  }
  return id;
}
