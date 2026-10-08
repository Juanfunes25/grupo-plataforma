/** Días enteros entre dos fechas YYYY-MM-DD. */
const diasEntre = (desde, hasta) => Math.round((Date.parse(`${String(hasta).slice(0, 10)}T00:00:00Z`) - Date.parse(`${String(desde).slice(0, 10)}T00:00:00Z`)) / 86400000);

/**
 * FIFO con lo que el RFID sí sabe: en qué SECCIÓN de qué freezer está cada bandeja, y qué tan
 * cerca de la puerta queda esa sección (`orden_salida`: 0 = adelante, mayor = más al fondo).
 * No sabe la profundidad dentro de una misma sección: 30 cm de lectura dan sección, no centímetros.
 *
 * Dos avisos:
 *  · "fifo": en un mismo freezer y sabor, una tanda más vieja está MÁS AL FONDO que una más
 *    nueva. Sacando por la puerta, saldría primero la nueva.
 *  · "vejez": una tanda lleva demasiados días guardada, esté donde esté.
 *
 * `tags`: { id, epc, sabor_id, sabor_nombre, lote, fecha (de producción), ubicacion_id,
 *           ubicacion_nombre, freezer, orden_salida }. Solo cuentan los que tienen ubicación y fecha.
 */
export const DIAS_VEJEZ = 21;

export function alertasFifo(tags, { hoy, diasVejez = DIAS_VEJEZ } = {}) {
  const alertas = [];
  const utiles = tags.filter((t) => t.fecha && t.ubicacion_id && t.sabor_id);

  const grupos = new Map();
  for (const t of utiles) {
    const clave = `${t.freezer}|${t.sabor_id}`;
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(t);
  }

  for (const lista of grupos.values()) {
    const porFecha = [...new Set(lista.map((t) => t.fecha))].sort();
    if (porFecha.length < 2) continue;
    // El caso más claro: la tanda más vieja que quedó detrás de alguna más nueva.
    const bloqueadas = [];
    for (const viejo of lista) {
      const delante = lista.filter((n) => n.fecha > viejo.fecha && n.orden_salida < viejo.orden_salida);
      if (delante.length) bloqueadas.push({ viejo, delante });
    }
    if (!bloqueadas.length) continue;
    bloqueadas.sort((a, b) => a.viejo.fecha.localeCompare(b.viejo.fecha));
    const { viejo, delante } = bloqueadas[0];
    const nuevo = delante.sort((a, b) => b.fecha.localeCompare(a.fecha))[0];
    alertas.push({
      tipo: 'fifo',
      gravedad: hoy && diasEntre(viejo.fecha, hoy) >= diasVejez ? 'alta' : 'media',
      freezer: viejo.freezer,
      sabor: viejo.sabor_nombre,
      epc: viejo.epc,
      mensaje: `${viejo.sabor_nombre}: la tanda del ${viejo.fecha} está en «${viejo.ubicacion_nombre}», detrás de la del ${nuevo.fecha} que está en «${nuevo.ubicacion_nombre}». Pasa la vieja adelante para que salga primero.`,
      viejo: { epc: viejo.epc, fecha: viejo.fecha, ubicacion: viejo.ubicacion_nombre, lote: viejo.lote },
      nuevo: { epc: nuevo.epc, fecha: nuevo.fecha, ubicacion: nuevo.ubicacion_nombre, lote: nuevo.lote },
      tandas_bloqueadas: bloqueadas.length,
    });
  }

  if (hoy) {
    for (const t of utiles) {
      const edad = diasEntre(t.fecha, hoy);
      if (edad >= diasVejez) {
        alertas.push({
          tipo: 'vejez', gravedad: edad >= diasVejez * 2 ? 'alta' : 'media', freezer: t.freezer, sabor: t.sabor_nombre, epc: t.epc,
          mensaje: `${t.sabor_nombre} (tanda del ${t.fecha}) lleva ${edad} días guardado en «${t.ubicacion_nombre}».`,
          dias: edad,
        });
      }
    }
  }
  return alertas.sort((a, b) => (a.gravedad === b.gravedad ? 0 : a.gravedad === 'alta' ? -1 : 1));
}
