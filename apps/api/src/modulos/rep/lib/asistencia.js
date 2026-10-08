/**
 * Marcacion de entrada/salida verificada por ubicacion.
 *
 * La ubicacion del navegador se puede falsear con una app, asi que esto NO es una prueba
 * infalible: es un filtro que hace que marcar desde la casa deje de ser trivial y quede
 * registrado como sospechoso. La verificacion final sigue siendo humana (las camaras) - por
 * eso la marcacion lejana se GUARDA igual, marcada, en vez de rechazarse: un registro
 * señalado sirve para revisar, uno rechazado no deja rastro de que alguien lo intento.
 */

const RADIO_TIERRA_M = 6371000;

/** Distancia en metros entre dos coordenadas (haversine). */
export function distanciaMetros(lat1, lon1, lat2, lon2) {
  const rad = (g) => (g * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * RADIO_TIERRA_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export const VERIFICACION = {
  DENTRO: 'dentro',
  LEJOS: 'lejos',
  SIN_UBICACION: 'sin_ubicacion',
  SIN_CONFIGURAR: 'sin_configurar',
};

/**
 * Decide el veredicto de una marcacion. Devuelve { verificacion, distancia_metros }.
 *
 * Los cuatro casos son distintos a proposito y ninguno bloquea:
 *  - dentro:         marco donde debia
 *  - lejos:          marco fuera del radio (queda para revisar)
 *  - sin_ubicacion:  el celular no dio ubicacion (permiso denegado, GPS sin señal adentro)
 *  - sin_configurar: la tienda todavia no tiene coordenadas cargadas
 */
export function verificarUbicacion({ sucursal, lat, lon }) {
  const tieneCoordsTienda = Number.isFinite(sucursal?.lat) && Number.isFinite(sucursal?.lon);
  const tieneCoordsPersona = Number.isFinite(lat) && Number.isFinite(lon);

  if (!tieneCoordsTienda) return { verificacion: VERIFICACION.SIN_CONFIGURAR, distancia_metros: null };
  if (!tieneCoordsPersona) return { verificacion: VERIFICACION.SIN_UBICACION, distancia_metros: null };

  const distancia = distanciaMetros(sucursal.lat, sucursal.lon, lat, lon);
  const radio = Number(sucursal.radio_metros) > 0 ? Number(sucursal.radio_metros) : 150;
  return {
    verificacion: distancia <= radio ? VERIFICACION.DENTRO : VERIFICACION.LEJOS,
    distancia_metros: Math.round(distancia),
  };
}

/**
 * Que tiendas deberian estar abiertas a esta hora y todavia nadie marco entrada.
 *
 * `horarios` trae, por sucursal, la hora de entrada mas temprana de HOY segun el horario
 * semanal cargado. Una tienda solo se reporta si ya paso su hora + la tolerancia; asi el
 * aviso llega cuando de verdad hay algo raro y no apenas empieza el turno.
 */
export function tiendasSinAbrir({ horarios, marcaciones, ahoraMinutos, toleranciaMinutos = 20 }) {
  const conEntrada = new Set(marcaciones.filter((m) => m.tipo === 'entrada').map((m) => m.sucursal_id));

  return horarios
    .filter((h) => {
      if (conEntrada.has(h.sucursal_id)) return false;
      if (h.entrada_minutos == null) return false; // hoy nadie tiene turno ahi
      return ahoraMinutos >= h.entrada_minutos + toleranciaMinutos;
    })
    .map((h) => ({
      sucursal_id: h.sucursal_id,
      nombre: h.nombre,
      esperadaMinutos: h.entrada_minutos,
      minutosDeAtraso: ahoraMinutos - h.entrada_minutos,
    }))
    .sort((a, b) => b.minutosDeAtraso - a.minutosDeAtraso);
}

/** "08:30" -> 510. null si el texto no es una hora. */
export function horaAMinutos(texto) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(texto || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
