/**
 * El contrato de un lector RFID. La pantalla y el resto del sistema SOLO conocen esto: cómo se
 * conecta el equipo (cable, Bluetooth, teclado, simulador) queda escondido en cada implementación.
 *
 *   estados:  'desconectado' | 'conectando' | 'listo' | 'escaneando' | 'escribiendo' | 'error'
 *   eventos:  'estado'  → (estado, detalle)
 *             'lectura' → ({ epc, rssi })        una por cada vez que el lector oye un tag
 *             'error'   → (ErrorRfid)
 *             'crudo'   → ({ texto, aceptado, motivo })   lo que llegó tal cual, para diagnosticar
 *
 * Cada lectura cruda pasa después por el DeduplicadorDeLecturas; el lector NO deduplica.
 */
import { errores } from '../errores.js';

export class LectorBase {
  constructor() {
    this.estado = 'desconectado';
    this._oyentes = { estado: new Set(), lectura: new Set(), error: new Set(), crudo: new Set() };
  }

  on(evento, fn) {
    this._oyentes[evento].add(fn);
    return () => this._oyentes[evento].delete(fn);
  }

  _emitir(evento, ...args) {
    for (const fn of [...this._oyentes[evento]]) {
      try { fn(...args); } catch (e) { console.error(`Error en un oyente de "${evento}"`, e); }
    }
  }

  _cambiarEstado(estado, detalle = '') {
    this.estado = estado;
    this._emitir('estado', estado, detalle);
  }

  /** Nombre corto para mostrarle a la persona. */
  get nombre() { return 'Lector'; }

  /** ¿Puede grabar el chip? (el modo teclado, por ejemplo, solo lee). */
  get puedeEscribir() { return false; }

  async conectar() { throw errores.noSoportado('conectarse'); }
  async desconectar() { this._cambiarEstado('desconectado'); }
  async iniciarInventario() { throw errores.noSoportado('leer en continuo'); }
  async detenerInventario() { /* nada que detener por defecto */ }

  /** Lee durante `ms` y devuelve los EPC distintos que oyó (para saber qué hay frente al lector). */
  async leerEpcsEnCampo(_opciones) { throw errores.noSoportado('leer tags puntuales'); }

  /** Graba `epcNuevo` en el tag cuyo EPC actual es `epcActual`. Lanza ErrorRfid si falla. */
  async escribirEpc(_datos) { throw errores.noSoportado('grabar tags'); }
}
