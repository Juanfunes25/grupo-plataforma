import { ErrorRfid, errores } from './errores.js';
import { normalizarEpc } from './deduplicador.js';

/**
 * Grabar un EPC en un tag sin dejar el sistema en un estado dudoso.
 *
 * Dos capas:
 *  · grabarTagSeguro: habla SOLO con el lector. Comprueba que haya un único tag, escribe, reintenta
 *    lo que vale la pena reintentar (tag movido, falta de respuesta), y al final RELEE el chip:
 *    "el lector dijo OK" no basta, hay que ver que el EPC quedó como se quería.
 *  · grabarYConfirmar: suma al servidor. Reserva el EPC nuevo, graba, y solo confirma si la
 *    relectura coincide; si algo falla, cancela. El servidor no cree en una grabación que nadie verificó.
 */

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const unico = (lista) => lista.map(normalizarEpc).filter(Boolean);

export async function grabarTagSeguro({ lector, epcActual, epcNuevo, passwordAcceso = null, reintentos = 2, esperaMs = 300, alProgreso = () => {} }) {
  if (!lector.puedeEscribir) throw errores.noSoportado('grabar tags (cambiá a la conexión USB)');
  const actual = normalizarEpc(epcActual);
  const nuevo = normalizarEpc(epcNuevo);
  if (!actual || !nuevo) throw errores.protocolo('El EPC actual o el nuevo no es hexadecimal válido');

  alProgreso('buscando');
  const antes = unico(await lector.leerEpcsEnCampo());
  if (antes.length > 1) throw errores.variosTags(antes.length);
  if (antes.length === 0) throw errores.tagNoEncontrado();
  if (antes[0] !== actual) throw errores.protocolo(`El tag que está frente al lector (${antes[0]}) no es el que se iba a grabar (${actual}). Acerca el correcto.`);

  let objetivoActual = actual;
  let intentos = 0;
  for (;;) {
    intentos += 1;
    alProgreso('escribiendo', intentos);
    try {
      await lector.escribirEpc({ epcActual: objetivoActual, epcNuevo: nuevo, passwordAcceso });
      break;
    } catch (e) {
      if (!(e instanceof ErrorRfid) || !e.reintentable || intentos > reintentos) throw e;
      // Antes de reintentar hay que saber en qué quedó el chip: puede haberse grabado igual.
      await esperar(esperaMs * intentos);
      const ahora = unico(await lector.leerEpcsEnCampo());
      if (ahora.length === 1 && ahora[0] === nuevo) break;
      if (ahora.length === 0) continue; // no se ve: se intenta de nuevo, el error de arriba ya se vio
      if (ahora.length > 1) throw errores.variosTags(ahora.length);
      if (ahora[0] !== objetivoActual) throw errores.estadoIncierto(ahora[0]);
    }
  }

  alProgreso('verificando');
  const despues = unico(await lector.leerEpcsEnCampo());
  if (despues.length !== 1 || despues[0] !== nuevo) throw errores.verificacion(nuevo, despues.join(', '));
  return { epc: nuevo, intentos };
}

/**
 * `api`: { preparar(datos) → {tag_id, epc_nuevo}, confirmar({tag_id, epc_leido}), cancelar({tag_id, motivo}) }.
 * `datos`: lo que el servidor necesita para decidir el EPC (epc_actual, tipo, produccion_id...).
 */
export async function grabarYConfirmar({ lector, api, datos, passwordAcceso = null, alProgreso = () => {}, ...opciones }) {
  alProgreso('reservando');
  const prep = await api.preparar(datos);
  try {
    const { epc } = await grabarTagSeguro({ lector, epcActual: datos.epc_actual, epcNuevo: prep.epc_nuevo, passwordAcceso, alProgreso, ...opciones });
    alProgreso('confirmando');
    const tag = await api.confirmar({ tag_id: prep.tag_id, epc_leido: epc });
    alProgreso('listo');
    return tag;
  } catch (e) {
    // Aviso al servidor para que libere la reserva; si esto también falla, la reserva vence sola.
    await api.cancelar({ tag_id: prep.tag_id, motivo: `${e.codigo || 'ERROR'}: ${e.message}` }).catch(() => {});
    throw e;
  }
}

/** Qué decirle a la persona según el error, en lenguaje de cocina. */
export function consejoParaError(e) {
  switch (e?.codigo) {
    case 'TAG_NO_ENCONTRADO': return 'Acerca el tag a unos 30 cm del lector y prueba de nuevo.';
    case 'TAG_SE_MOVIO': return 'Apoya el tag quieto sobre el lector mientras graba (unos 2 segundos).';
    case 'VARIOS_TAGS': return 'Deja solo el tag a grabar frente al lector; aleja las bandejas cercanas.';
    case 'PASSWORD_REQUERIDA':
    case 'PASSWORD_INCORRECTA': return 'Usa otro tag: este viene bloqueado con contraseña.';
    case 'VERIFICACION_FALLIDA':
    case 'ESTADO_INCIERTO': return 'Vuelve a leer el tag y reintenta: el sistema lo reconoce por su identificador de fábrica.';
    case 'LECTOR_DESCONECTADO': return 'Revisa el cable USB o el Bluetooth y vuelve a conectar el lector.';
    default: return '';
  }
}
