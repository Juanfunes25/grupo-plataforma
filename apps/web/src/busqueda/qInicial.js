/** Texto de búsqueda con el que se abre una pantalla desde la búsqueda global (/<empresa>/<ruta>?q=…). */
export const qInicial = () => { try { return (new URLSearchParams(window.location.search).get('q') ?? '').slice(0, 80); } catch { return ''; } };
