import { decodificarEpc, normalizarEpc } from './epc.js';

/** Con 30 cm una bandeja puede no leerse una vez por escarcha o ángulo: se necesita verla faltar dos pasadas seguidas. */
export const FALTAS_PARA_CONFIRMAR = 2;

/**
 * Compara lo que el lector vio en una sección con lo que la base dice que debería haber.
 *
 * `lecturas`: [{ epc, rssi?, lecturas? }] ya sin duplicados (ver el deduplicador del frontend).
 * `tagsPorEpc`: Map epc -> tag de la base, para TODO EPC leído que exista.
 * `esperados`: tags (no dados de baja) cuya ubicación registrada es esta sección.
 *
 * No toca la base: devuelve el veredicto y los cambios a aplicar (`cambios`), para que se pueda
 * probar sin base y para que el servidor los aplique todos juntos o ninguno.
 */
export function compararAuditoria({ ubicacion, lecturas, tagsPorEpc, esperados }) {
  const vistos = new Map(); // epc -> lectura (se unifican repetidos por si el cliente mandó de más)
  let ajenos = 0;
  for (const l of lecturas) {
    const epc = normalizarEpc(l.epc);
    if (!epc) { ajenos += 1; continue; }
    const previa = vistos.get(epc);
    vistos.set(epc, previa ? { ...previa, rssi: Math.max(previa.rssi ?? -999, l.rssi ?? -999), lecturas: (previa.lecturas || 1) + (l.lecturas || 1) } : { epc, rssi: l.rssi ?? null, lecturas: l.lecturas || 1 });
  }

  const correctos = [];
  const equivocados = [];
  const sinUbicacion = [];
  const libres = [];
  const dadosDeBaja = [];
  const desconocidos = [];

  for (const lectura of vistos.values()) {
    const tag = tagsPorEpc.get(lectura.epc);
    if (!tag) {
      // Un EPC con nuestro formato y CRC válido que la base no conoce es raro y vale la pena
      // mostrarlo; uno que no cierra es de otro sistema y solo se cuenta.
      if (decodificarEpc(lectura.epc).propio) desconocidos.push(lectura);
      else ajenos += 1;
      continue;
    }
    if (tag.estado === 'baja') { dadosDeBaja.push({ tag, lectura }); continue; }
    // Un tag con sección registrada cuenta como "debería estar ahí", tenga o no un producto:
    // sirve tanto para bandejas con tanda como para tags sueltos que solo se quieren tener ubicados.
    if (!tag.ubicacion_id) {
      if (tag.estado === 'asignado') sinUbicacion.push({ tag, lectura });
      else libres.push({ tag, lectura });
    } else if (tag.ubicacion_id === ubicacion.id) correctos.push({ tag, lectura });
    else equivocados.push({ tag, lectura, registrada_en: tag.ubicacion_nombre || `sección ${tag.ubicacion_id}` });
  }

  const faltantes = esperados
    .filter((t) => !vistos.has(t.epc))
    .map((tag) => {
      const seguidas = (tag.faltas_seguidas || 0) + 1;
      return { tag, faltas_seguidas: seguidas, confirmado: seguidas >= FALTAS_PARA_CONFIRMAR };
    });

  return {
    ubicacion,
    correctos, equivocados, sinUbicacion, libres, dadosDeBaja, desconocidos, faltantes,
    ajenos,
    resumen: {
      leidos: vistos.size,
      esperados: esperados.length,
      correctos: correctos.length,
      faltantes: faltantes.length,
      faltantes_confirmados: faltantes.filter((f) => f.confirmado).length,
      equivocados: equivocados.length,
      sin_ubicacion: sinUbicacion.length,
      libres: libres.length,
      desconocidos: desconocidos.length,
      ajenos,
    },
    cambios: {
      // Lo visto en su lugar o sin lugar registrado: se anota la lectura y se ubica si no tenía.
      vistos: [...correctos, ...sinUbicacion].map((x) => x.tag.id),
      ubicar: sinUbicacion.map((x) => x.tag.id),
      // Lo que apareció donde no debía NO se mueve solo: lo confirma una persona.
      faltas: faltantes.map((f) => ({ tag_id: f.tag.id, faltas_seguidas: f.faltas_seguidas })),
    },
  };
}
