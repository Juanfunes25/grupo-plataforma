/**
 * Errores del lector, con un código estable para que la pantalla pueda decirle a la persona
 * QUÉ hacer (acercar el tag, poner la contraseña) en vez de mostrar un error técnico.
 */
export class ErrorRfid extends Error {
  constructor(codigo, mensaje, { reintentable = false, causa } = {}) {
    super(mensaje);
    this.name = 'ErrorRfid';
    this.codigo = codigo;
    this.reintentable = reintentable;
    if (causa) this.causa = causa;
  }
}

export const errores = {
  tagNoEncontrado: () => new ErrorRfid('TAG_NO_ENCONTRADO', 'No se encontró el tag. Acércalo a unos 30 cm del lector.', { reintentable: true }),
  tagSeMovio: () => new ErrorRfid('TAG_SE_MOVIO', 'El tag se movió mientras se grababa. Mantenlo quieto frente al lector.', { reintentable: true }),
  variosTags: (n) => new ErrorRfid('VARIOS_TAGS', `Hay ${n} tags frente al lector. Para grabar tiene que haber uno solo: aleja los demás.`),
  passwordRequerida: () => new ErrorRfid('PASSWORD_REQUERIDA', 'Este tag está protegido con contraseña y esta app no trabaja con tags protegidos. Usa otro tag, sin contraseña.'),
  passwordIncorrecta: () => new ErrorRfid('PASSWORD_INCORRECTA', 'La contraseña de acceso no es correcta. No se grabó nada.'),
  timeout: () => new ErrorRfid('TIMEOUT', 'El lector no respondió a tiempo.', { reintentable: true }),
  desconectado: () => new ErrorRfid('LECTOR_DESCONECTADO', 'El lector se desconectó. Revisa el cable o el Bluetooth.'),
  noSoportado: (que) => new ErrorRfid('NO_SOPORTADO', `Este modo de conexión no puede ${que}.`),
  verificacion: (esperado, leido) => new ErrorRfid('VERIFICACION_FALLIDA', `Se grabó, pero al releer el tag el lector vio ${leido || 'nada'} en vez de ${esperado}.`),
  estadoIncierto: (leido) => new ErrorRfid('ESTADO_INCIERTO', `Después del fallo el tag muestra ${leido || 'nada'}, que no es ni el código anterior ni el nuevo. Vuelve a acercarlo y reintenta.`),
  protocolo: (detalle) => new ErrorRfid('PROTOCOLO', detalle),
};
