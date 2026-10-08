import { LectorBase } from './lectorBase.js';
import { errores } from '../errores.js';

/**
 * Un lector de mentira para probar la pantalla sin hardware y para las pruebas automáticas.
 * Imita lo difícil del equipo real: ráfagas de cientos de lecturas por segundo del mismo tag,
 * tags que se mueven, contraseñas de acceso, y cortes a mitad de la grabación.
 *
 *   lector.ponerTags(['E280...', ...])       tags que están "frente al lector"
 *   lector.fallosDeEscritura = ['TAG_SE_MOVIO']  fallos que se aplican, uno por intento
 */
export class LectorSimulado extends LectorBase {
  constructor({ lecturasPorSegundoPorTag = 200, intervaloMs = 100, passwordAcceso = null } = {}) {
    super();
    this.tags = [];
    this.lecturasPorSegundoPorTag = lecturasPorSegundoPorTag;
    this.intervaloMs = intervaloMs;
    this.passwordAcceso = passwordAcceso;
    this.fallosDeEscritura = [];
    this.escrituras = [];
    this._timer = null;
  }

  get nombre() { return 'Lector de demostración'; }
  get puedeEscribir() { return true; }

  ponerTags(epcs) { this.tags = epcs.map((e) => String(e).toUpperCase()); }

  async conectar() {
    this._cambiarEstado('conectando');
    this._cambiarEstado('listo');
  }

  async desconectar() {
    await this.detenerInventario();
    this._cambiarEstado('desconectado');
  }

  async iniciarInventario() {
    if (this._timer) return;
    this._cambiarEstado('escaneando');
    const porTick = Math.max(1, Math.round((this.lecturasPorSegundoPorTag * this.intervaloMs) / 1000));
    this._timer = setInterval(() => {
      for (const epc of this.tags) {
        for (let i = 0; i < porTick; i++) this._emitir('lectura', { epc, rssi: -45 - Math.floor(Math.random() * 25) });
      }
    }, this.intervaloMs);
  }

  async detenerInventario() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this.estado === 'escaneando') this._cambiarEstado('listo');
  }

  async leerEpcsEnCampo() { return [...new Set(this.tags)]; }

  async escribirEpc({ epcActual, epcNuevo, passwordAcceso = null }) {
    this._cambiarEstado('escribiendo');
    try {
      const falla = this.fallosDeEscritura.shift();
      if (falla === 'TAG_SE_MOVIO') throw errores.tagSeMovio();
      if (falla === 'TIMEOUT') throw errores.timeout();
      if (falla === 'DESCONECTADO') throw errores.desconectado();
      const i = this.tags.indexOf(String(epcActual).toUpperCase());
      if (i < 0) throw errores.tagNoEncontrado();
      if (this.passwordAcceso) {
        if (!passwordAcceso) throw errores.passwordRequerida();
        if (passwordAcceso !== this.passwordAcceso) throw errores.passwordIncorrecta();
      }
      if (falla === 'SE_GRABA_PERO_NO_RESPONDE') { this.tags[i] = String(epcNuevo).toUpperCase(); throw errores.timeout(); }
      this.tags[i] = String(epcNuevo).toUpperCase();
      this.escrituras.push({ epcActual, epcNuevo });
    } finally {
      this._cambiarEstado('listo');
    }
  }
}
