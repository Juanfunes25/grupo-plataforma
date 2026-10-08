// Validaciones y utilidades compartidas del módulo de personal.
import { z } from 'zod';
import { fechaHN } from '@grupo/shared';
import { fechaISO } from '../../lib/http.js';
import { mesesCumplidos } from './vacaciones.js';

// ── Datos sensibles: solo los ve/edita quien tenga 'rrhh:sensible' (dueño / administrador) ──
export const SENSIBLES_PERSONA = ['identidad', 'rtn', 'banco', 'tipo_cuenta', 'cuenta_bancaria'];
export const SENSIBLES_EMPLEADO = ['salario_mensual', 'salario_hora', 'tipo_pago'];
export const SENSIBLES = [...SENSIBLES_PERSONA, ...SENSIBLES_EMPLEADO];

export const soloDigitos = (s) => String(s ?? '').replace(/[\s-]/g, '');
export function formatoIdentidad(d) {
  const x = soloDigitos(d);
  return x.length === 13 ? `${x.slice(0, 4)}-${x.slice(4, 8)}-${x.slice(8)}` : (d ?? null);
}
/** 0501-1990-12345 → ****-****-*2345 (para quien no tiene permiso sensible). */
export function mascaraIdentidad(d) {
  const x = soloDigitos(d);
  return x ? `****-****-*${x.slice(-4)}` : null;
}
export const mascaraCuenta = (c) => (c ? `****${String(c).slice(-4)}` : null);

/** La identidad hondureña es 0000-0000-00000: departamento (01–18), año de nacimiento y consecutivo. */
export function identidadValida(texto) {
  const x = soloDigitos(texto);
  if (!/^\d{13}$/.test(x)) return false;
  const depto = Number(x.slice(0, 2));
  const anio = Number(x.slice(4, 8));
  return depto >= 1 && depto <= 18 && anio >= 1900 && anio <= Number(fechaHN().slice(0, 4));
}

export function edadDe(fechaNac, hoy = fechaHN()) {
  return fechaNac ? Math.floor(mesesCumplidos(fechaNac, hoy) / 12) : null;
}

// ── Esquemas zod ────────────────────────────────────────────────────────────
const vacioANull = (v) => (typeof v === 'string' && v.trim() === '' ? null : v);
export const txt = (n = 200) => z.preprocess(vacioANull, z.string().trim().max(n).nullish().transform((v) => v || null));
export const fechaN = z.preprocess(vacioANull, fechaISO.nullish());
export const numN = (max = 999_999_999) => z.preprocess(vacioANull, z.coerce.number().finite().min(0).max(max).nullish());
export const enumN = (vals) => z.preprocess(vacioANull, z.enum(vals).nullish());

const telefono = z.preprocess(vacioANull, z.string().trim().max(30).nullish()
  .refine((v) => !v || (/^[0-9+()\s.-]+$/.test(v) && v.replace(/\D/g, '').length >= 8), 'Teléfono inválido (mínimo 8 dígitos)')
  .transform((v) => v || null));

export const ESTADOS = ['activo', 'vacaciones', 'suspendido', 'baja'];
export const TIPOS_CONTRATO = ['indefinido', 'plazo_fijo', 'prueba', 'temporal', 'por_horas', 'servicios'];
export const TIPOS_PAGO = ['mensual', 'quincenal', 'semanal', 'por_hora'];
export const TIPOS_BAJA = ['renuncia', 'despido', 'fin_contrato', 'abandono', 'mutuo_acuerdo', 'fallecimiento', 'otro'];

export const esqPersona = z.object({
  nombres: z.string().trim().min(2, 'Escribe los nombres').max(100),
  apellidos: z.string().trim().max(100),
  identidad: z.preprocess(vacioANull, z.string().trim().nullish()
    .refine((v) => !v || identidadValida(v), 'Identidad inválida: usa el formato 0000-0000-00000 (13 dígitos)')
    .transform((v) => (v ? soloDigitos(v) : null))),
  rtn: z.preprocess(vacioANull, z.string().trim().nullish()
    .refine((v) => !v || /^\d{14}$/.test(soloDigitos(v)), 'El RTN tiene 14 dígitos')
    .transform((v) => (v ? soloDigitos(v) : null))),
  fecha_nacimiento: fechaN,
  sexo: enumN(['M', 'F', 'O']),
  estado_civil: enumN(['soltero', 'casado', 'union_libre', 'divorciado', 'viudo']),
  nacionalidad: z.preprocess(vacioANull, z.string().trim().max(60).nullish().transform((v) => v || 'Hondureña')),
  direccion: txt(250), ciudad: txt(80),
  telefono, telefono2: telefono, whatsapp: telefono,
  correo: z.preprocess(vacioANull, z.string().trim().max(120).email('Correo inválido').nullish().transform((v) => v || null)),
  foto_url: z.preprocess(vacioANull, z.string().max(260_000).nullish()
    .refine((v) => !v || /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v), 'La foto debe ser una imagen JPG, PNG o WebP')
    .transform((v) => v || null)),
  ihss_numero: txt(30), rap_numero: txt(30), infop_numero: txt(30),
  talla_camisa: txt(10), talla_pantalon: txt(10), talla_calzado: txt(10),
  banco: txt(80), tipo_cuenta: enumN(['ahorro', 'cheque']), cuenta_bancaria: txt(40),
  emergencia_nombre: txt(120), emergencia_parentesco: txt(40), emergencia_telefono: telefono, emergencia_telefono2: telefono,
});
export const CAMPOS_PERSONA = Object.keys(esqPersona.shape);

export const esqContrato = z.object({
  puesto: z.string().trim().min(2, 'Escribe el cargo o puesto').max(80),
  departamento: txt(60),
  sucursal_id: z.preprocess(vacioANull, z.string().uuid('sucursal inválida').nullish()),
  sucursales_extra: z.array(z.string().uuid()).max(10).optional(),
  codigo: txt(30),
  usuario_id: z.preprocess(vacioANull, z.string().uuid().nullish()),
  jefe_id: z.preprocess(vacioANull, z.string().uuid().nullish()),
  fecha_ingreso: fechaN,
  fecha_fin_prueba: fechaN,
  tipo_contrato: z.enum(TIPOS_CONTRATO),
  fecha_inicio_contrato: fechaN, fecha_fin_contrato: fechaN,
  tipo_pago: z.enum(TIPOS_PAGO),
  salario_mensual: numN(), salario_hora: numN(100_000),
  jornada: enumN(['diurna', 'mixta', 'nocturna']),
  horas_semana: numN(100),
  estado: z.enum(ESTADOS),
  motivo_estado: txt(300),
  estado_desde: fechaN,
  tipo_baja: enumN(TIPOS_BAJA),
  fecha_salida: fechaN,
  notas: txt(1000),
});
export const CAMPOS_CONTRATO = Object.keys(esqContrato.shape).filter((k) => k !== 'sucursales_extra');

/** Quita las claves no enviadas (undefined) para distinguir "no tocar" de "poner null". */
export const soloEnviados = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

/** Valor mostrable en la bitácora; los datos sensibles nunca se escriben tal cual. */
export function valorBitacora(campo, v) {
  if (v === undefined || v === null || v === '') return null;
  if (campo === 'cuenta_bancaria') return mascaraCuenta(v);
  if (campo === 'identidad') return mascaraIdentidad(v);
  if (campo === 'foto_url') return '(foto)';
  if (SENSIBLES.includes(campo)) return '(dato sensible)';
  return v;
}

/** Diferencias { campo: { antes, despues } } entre la fila actual y lo enviado. */
export function diferencias(actual, nuevo) {
  const out = {};
  for (const [k, v] of Object.entries(nuevo)) {
    const a = actual[k] ?? null, b = v ?? null;
    const igual = a === b || (a !== null && b !== null && String(a) === String(b));
    if (!igual) out[k] = { antes: a, despues: b };
  }
  return out;
}
export const diferenciasBitacora = (d) => Object.fromEntries(Object.entries(d).map(([k, { antes, despues }]) => [k, { antes: valorBitacora(k, antes), despues: valorBitacora(k, despues) }]));
