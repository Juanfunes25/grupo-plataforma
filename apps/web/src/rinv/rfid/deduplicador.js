/**
 * El Chainway lee cientos de veces por segundo cada tag que tiene enfrente: un solo tag a 30 cm
 * puede dar 200 lecturas por segundo. Mandar cada una a la pantalla o al servidor sería ahogarse.
 *
 * Este deduplicador se queda con UNA ficha por EPC:
 *   · la primera vez que aparece → 'nuevo' (se avisa de inmediato)
 *   · mientras siga sonando dentro de la ventana (3 a 5 s) → 'repetido' (solo cuenta; no avisa)
 *   · si vuelve a sonar pasada la ventana → 'actualizado' (sigue ahí; se refresca el aviso)
 * Memoria acotada: nunca guarda más de `maxTags` fichas, pase lo que pase en el aire.
 *
 * No depende del navegador ni de React (el reloj se inyecta), así que se prueba solo.
 */

const HEX = /^[0-9A-F]+$/;
export const VENTANA_MS = 4000;
export const MAX_TAGS = 5000;

/** Mayúsculas, sin espacios ni 0x; null si no es un EPC hexadecimal de largo par y razonable. */
export function normalizarEpc(texto) {
  const limpio = String(texto ?? '').replace(/\s+/g, '').replace(/^0x/i, '').toUpperCase();
  return limpio.length >= 8 && limpio.length <= 64 && limpio.length % 2 === 0 && HEX.test(limpio) ? limpio : null;
}

export class DeduplicadorDeLecturas {
  constructor({ ventanaMs = VENTANA_MS, maxTags = MAX_TAGS, ahora = () => Date.now() } = {}) {
    if (ventanaMs < 1000 || ventanaMs > 10000) throw new RangeError('La ventana tiene que estar entre 1 y 10 segundos');
    this.ventanaMs = ventanaMs;
    this.maxTags = maxTags;
    this.ahora = ahora;
    this.fichas = new Map();
    this.descartadas = 0; // lecturas que no eran EPC válidos (ruido, otros protocolos)
    this.saturado = false;
    this.lecturasTotales = 0;
  }

  /** @returns {'nuevo'|'repetido'|'actualizado'|'invalido'|'saturado'} */
  registrar({ epc, rssi = null }) {
    this.lecturasTotales += 1;
    const clave = normalizarEpc(epc);
    if (!clave) { this.descartadas += 1; return 'invalido'; }
    const t = this.ahora();
    const ficha = this.fichas.get(clave);

    if (!ficha) {
      if (this.fichas.size >= this.maxTags) { this.saturado = true; return 'saturado'; }
      this.fichas.set(clave, { epc: clave, lecturas: 1, rssiMax: rssi, primera: t, ultima: t, ultimoAviso: t });
      return 'nuevo';
    }
    ficha.lecturas += 1;
    ficha.ultima = t;
    if (rssi !== null && (ficha.rssiMax === null || rssi > ficha.rssiMax)) ficha.rssiMax = rssi;
    if (t - ficha.ultimoAviso >= this.ventanaMs) { ficha.ultimoAviso = t; return 'actualizado'; }
    return 'repetido';
  }

  get cantidad() { return this.fichas.size; }

  /** Lo detectado, en orden de aparición. Es lo que se manda UNA vez al servidor al terminar. */
  instantanea() {
    return [...this.fichas.values()].sort((a, b) => a.primera - b.primera);
  }

  /** Para el servidor: epc, rssi y cuántas veces sonó. */
  paraEnviar() {
    return this.instantanea().map((f) => ({ epc: f.epc, rssi: f.rssiMax, lecturas: f.lecturas }));
  }

  /** Modo "en vivo": olvida lo que lleva más de `ms` sin sonar (un tag que se llevaron). */
  purgarAusentes(ms) {
    const limite = this.ahora() - ms;
    const quitados = [];
    for (const [epc, f] of this.fichas) if (f.ultima < limite) { this.fichas.delete(epc); quitados.push(epc); }
    if (quitados.length) this.saturado = false;
    return quitados;
  }

  reiniciar() {
    this.fichas.clear();
    this.descartadas = 0;
    this.saturado = false;
    this.lecturasTotales = 0;
  }
}

/**
 * Agrupa avisos para no repintar la pantalla 200 veces por segundo: llama a `cuandoCambia` a lo
 * sumo cada `cadaMs`, y solo si hubo algo nuevo. Devuelve { marcar, detener }.
 */
export function limitadorDeRepintado(cuandoCambia, cadaMs = 250, { setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  let sucio = false;
  const id = setIntervalFn(() => { if (sucio) { sucio = false; cuandoCambia(); } }, cadaMs);
  return {
    marcar() { sucio = true; },
    detener() { clearIntervalFn(id); if (sucio) { sucio = false; cuandoCambia(); } },
  };
}
