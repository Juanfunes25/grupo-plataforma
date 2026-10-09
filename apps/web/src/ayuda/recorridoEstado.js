// Estado compartido del recorrido: «ya lo vio» por usuario y rol (en el navegador) y petición de repetirlo.
const clave = (usuarioId, rol) => `grupo.ayuda.visto.${usuarioId}.${rol}`;
export const yaVisto = (usuarioId, rol) => { try { return localStorage.getItem(clave(usuarioId, rol)) === '1'; } catch { return true; } };
export const marcarVisto = (usuarioId, rol) => { try { localStorage.setItem(clave(usuarioId, rol), '1'); } catch { /* sin almacenamiento */ } };
/** Pide mostrar el recorrido de un rol (lo escucha AyudaGlobal). */
export const pedirRecorrido = (rol) => window.dispatchEvent(new CustomEvent('grupo:recorrido', { detail: { rol } }));
