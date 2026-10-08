import { z } from 'zod';

export class ErrorHttp extends Error {
  constructor(status, mensaje, codigo) {
    super(mensaje);
    this.status = status;
    this.codigo = codigo;
  }
}
export const malaPeticion = (m, c) => new ErrorHttp(400, m, c);
export const noAutenticado = (m = 'Sesión no válida') => new ErrorHttp(401, m, 'no_autenticado');
export const prohibido = (m = 'No tienes permiso para esto') => new ErrorHttp(403, m, 'prohibido');
export const noEncontrado = (m = 'No encontrado') => new ErrorHttp(404, m, 'no_encontrado');
export const conflicto = (m) => new ErrorHttp(409, m, 'conflicto');

/** Valida con zod y devuelve el dato limpio; el primer error sale como 400 legible. */
export function validar(esquema, dato) {
  const r = esquema.safeParse(dato);
  if (r.success) return r.data;
  const i = r.error.issues[0];
  const campo = i.path.length ? `${i.path.join('.')}: ` : '';
  throw malaPeticion(`${campo}${i.message}`);
}

export const uuid = z.string().uuid('id inválido');
export const dinero = z.coerce.number().finite().min(0).max(999_999_999);
export const fechaISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha inválida (YYYY-MM-DD)');
export const textoOpc = z.string().trim().max(500).optional().nullable().transform((v) => (v ? v : null));

/** Traduce errores de Postgres (incluidos los `raise exception` de las funciones) a respuestas HTTP. */
export function manejadorErrores(log = console.error) {
  return (err, req, res, _next) => {
    if (err instanceof ErrorHttp) {
      return res.status(err.status).json({ error: err.message, codigo: err.codigo });
    }
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Cuerpo demasiado grande' });
    const code = err?.code;
    if (code === 'P0001') return res.status(409).json({ error: err.message, codigo: 'regla_de_negocio' });
    if (code === '23505') return res.status(409).json({ error: 'Ya existe un registro con esos datos', codigo: 'duplicado' });
    if (code === '23503') return res.status(409).json({ error: 'El registro está enlazado con otros datos o referencia algo que no existe', codigo: 'referencia' });
    if (code === '23514' || code === '22P02' || code === '23502') return res.status(400).json({ error: 'Datos inválidos', codigo: 'dato_invalido' });
    log(`[error] ${req.method} ${req.originalUrl}:`, err);
    res.status(500).json({ error: 'Error interno del servidor' });
  };
}
