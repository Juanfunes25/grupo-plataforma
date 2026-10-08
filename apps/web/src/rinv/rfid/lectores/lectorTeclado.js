import { LectorBase } from './lectorBase.js';

/**
 * Modo "teclado": el lector se empareja con la tablet como un teclado Bluetooth (o USB) y
 * "escribe" cada EPC leído. No necesita permisos del navegador y sirve para leer y auditar;
 * NO puede grabar tags (para eso hace falta hablar el protocolo del lector).
 *
 * Tolerante a cómo escriba cada lector:
 *  · termina la lectura con Enter, Tab, o simplemente con una pausa (algunos no mandan nada al final);
 *  · ignora prefijos y sufijos que no son hexadecimales («EPC:», saltos de línea...);
 *  · acepta teclas algo lentas (Bluetooth no es tan rápido como el cable);
 *  · entiende teclados que en Android reportan la tecla como «Unidentified» (usa el código físico);
 *  · si llegan varios códigos pegados (48, 72 caracteres...), los separa de a 24.
 *
 * Distingue al lector de una persona porque NUNCA captura lo que se escribe dentro de un campo de
 * texto, y porque un código de tag mide 16 caracteres o más (una persona no teclea eso de corrido).
 * Pensado para los defectos reales del teclado Bluetooth: no confirma cada tecla, puede atrasarse
 * un instante a mitad de un código (por eso se espera 400 ms antes de darlo por terminado) y,
 * con new_line=2, manda DOS teclas de fin de línea por código (LF+CR).
 * Cada intento, válido o no, se informa como evento «crudo» para poder ver qué está mandando.
 */
export const MAX_MS_ENTRE_TECLAS = 400;
export const PAUSA_FIN_LECTURA_MS = 400;
/** Un EPC mide 24 caracteres (96 bits); por debajo de 16 es un pedazo o no es un tag. */
export const MIN_EPC_HEX = 16;
const LARGO_EPC_ESTANDAR = 24;

const TIPOS_QUE_NO_ESCRIBEN = ['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'file', 'color', 'image'];

/** ¿Es un lugar donde la persona está escribiendo texto de verdad? (un menú desplegable o un botón no lo es) */
const esCampoDeTexto = (el) => Boolean(el && (
  el.tagName === 'TEXTAREA' || el.isContentEditable
  || (el.tagName === 'INPUT' && !TIPOS_QUE_NO_ESCRIBEN.includes(String(el.type || 'text').toLowerCase()))
));

/** El carácter de la tecla, aunque el navegador la reporte sin nombre (pasa con algunos teclados Bluetooth en Android). */
export function caracterDe(e) {
  if (typeof e.key === 'string' && e.key.length === 1) return e.key;
  if (e.key === 'Unidentified' || !e.key) {
    const m = /^(?:Key([A-Z])|Digit(\d)|Numpad(\d))$/.exec(e.code || '');
    if (m) return m[1] ? (e.shiftKey ? m[1] : m[1].toLowerCase()) : (m[2] || m[3]);
  }
  return null;
}
const esEnter = (e) => e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter';
const esTab = (e) => e.key === 'Tab' || e.code === 'Tab';

/** Saca los EPC de lo que llegó: la tira hexadecimal más larga, de largo par y al menos 16 caracteres. */
export function extraerEpcs(texto) {
  const limpio = String(texto || '').trim();
  if (!limpio) return { epcs: [], motivo: 'no llegó nada' };
  const tiras = limpio.match(/[0-9A-Fa-f]{16,}/g);
  if (!tiras) return { epcs: [], motivo: `no tiene un código hexadecimal de al menos ${MIN_EPC_HEX} caracteres (puede haber llegado incompleto)` };
  const mejor = tiras.sort((a, b) => b.length - a.length)[0].toUpperCase();
  if (mejor.length % 2 !== 0) return { epcs: [], motivo: `el código tiene ${mejor.length} caracteres (tiene que ser un número par)` };
  // Varios códigos estándar pegados sin separador.
  if (mejor.length > LARGO_EPC_ESTANDAR && mejor.length % LARGO_EPC_ESTANDAR === 0 && mejor.length <= LARGO_EPC_ESTANDAR * 8) {
    return { epcs: mejor.match(/.{24}/g), motivo: null };
  }
  if (mejor.length > 64) return { epcs: [], motivo: 'el código es demasiado largo' };
  return { epcs: [mejor], motivo: null };
}

export class LectorTeclado extends LectorBase {
  constructor({ destino = typeof window !== 'undefined' ? window : null, ahora = () => Date.now(), pausaMs = PAUSA_FIN_LECTURA_MS } = {}) {
    super();
    this.destino = destino;
    this.ahora = ahora;
    this.pausaMs = pausaMs;
    this._buffer = '';
    this._ultimaTecla = 0;
    this._timer = null;
    this._ultimoCierre = -Infinity;
    this._alTeclear = (e) => this._tecla(e);
  }

  get nombre() { return 'Lector en modo teclado'; }

  async conectar() {
    this._cambiarEstado('conectando');
    this.destino?.addEventListener('keydown', this._alTeclear, true);
    this._cambiarEstado('listo');
  }

  async desconectar() {
    this.destino?.removeEventListener('keydown', this._alTeclear, true);
    clearTimeout(this._timer);
    this._buffer = '';
    this._cambiarEstado('desconectado');
  }

  async iniciarInventario() {
    // Si quedó un menú o un botón con el foco, que no se lleve las teclas del lector.
    try { this.destino?.document?.activeElement?.blur?.(); } catch { /* sin documento: nada que soltar */ }
    this._cambiarEstado('escaneando');
  }
  async detenerInventario() { if (this.estado === 'escaneando') this._cambiarEstado('listo'); }

  /**
   * Espera a que la persona apriete el gatillo: no hay una "ventana de lectura" que acertar.
   * Devuelve los EPC distintos que llegan dentro de `agruparMs` desde el primero, o una lista
   * vacía si en `esperaMs` no llegó ninguno.
   */
  async leerEpcsEnCampo({ esperaMs = 15000, agruparMs = 700 } = {}) {
    const vistos = new Set();
    await new Promise((resolver) => {
      let cierre = null;
      let quitar = () => {};
      const terminar = () => { clearTimeout(limite); clearTimeout(cierre); quitar(); resolver(); };
      const limite = setTimeout(terminar, esperaMs);
      quitar = this.on('lectura', ({ epc }) => {
        vistos.add(epc);
        if (!cierre) cierre = setTimeout(terminar, agruparMs);
      });
    });
    return [...vistos];
  }

  /** Cierra lo acumulado: lo reporta como crudo y, si trae EPC, como lecturas. `cierre` dice cómo terminó (enter, tab o pausa). */
  _cerrar(cierre = 'pausa') {
    clearTimeout(this._timer);
    const texto = this._buffer;
    this._buffer = '';
    if (!texto) return false;
    this._ultimoCierre = this.ahora();
    const { epcs, motivo } = extraerEpcs(texto);
    this._emitir('crudo', { texto, aceptado: epcs.length > 0, motivo, cantidad: epcs.length, cierre, hora: this.ahora() });
    for (const epc of epcs) this._emitir('lectura', { epc, rssi: null });
    return epcs.length > 0;
  }

  _tecla(e) {
    // Lo que se escribe en un formulario es de la persona, no del lector.
    if (esCampoDeTexto(e.target)) return;
    // Ctrl, Alt o Meta no son parte del código (algunos lectores mandan el fin de línea como Ctrl+J).
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const t = this.ahora();
    if (t - this._ultimaTecla > MAX_MS_ENTRE_TECLAS) this._buffer = '';
    this._ultimaTecla = t;

    if (esEnter(e) || esTab(e)) {
      const cerro = this._cerrar(esEnter(e) ? 'enter' : 'tab');
      // Con LF+CR llega un segundo Enter sin código: sigue siendo del lector, y si se dejara pasar
      // «apretaría» el botón que tenga el foco en pantalla.
      if (cerro || t - this._ultimoCierre <= MAX_MS_ENTRE_TECLAS) e.preventDefault?.();
      return;
    }
    const c = caracterDe(e);
    if (c === null) return;
    this._buffer += c;
    // Si hay un menú desplegable con el foco, que lo que escribe el lector no le cambie la opción.
    if (e.target?.tagName === 'SELECT') e.preventDefault?.();
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._cerrar('pausa'), this.pausaMs);
  }
}
