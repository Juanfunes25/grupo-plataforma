// Reglas de aviso por correo: qué tipos existen, sus valores por defecto y a quién le llegan.
// Se guardan en msg.avisos (una fila por empresa+tipo, o por tipo del grupo con empresa_id null).
import { correoValido } from '../../lib/correo.js';

/** ambito 'grupo' = una sola regla para todo el grupo (la ve el dueño); 'empresa' = una por empresa. */
export const TIPOS_AVISO = {
  resumen_diario:   { ambito: 'grupo',   nombre: 'Resumen diario', descripcion: 'Ventas por empresa y sucursal, cierres de caja, tiendas que no pesaron, despachos, documentos por vencer y alertas del antifraude.', horasEntre: 24, hora: 7 },
  error_grave:      { ambito: 'grupo',   nombre: 'Errores graves del sistema', descripcion: 'Fallas internas (error 500) agrupadas: un solo correo con lo ocurrido.', horasEntre: 6 },
  tienda_sin_pesar: { ambito: 'empresa', nombre: 'Tienda sin pesar', descripcion: 'En la mañana de despacho, tiendas que no pesaron el gelato la noche anterior.', horasEntre: 24, solo: ['reposicion'] },
  cai:              { ambito: 'empresa', nombre: 'CAI por vencer o agotarse', descripcion: 'Un CAI real que vence en 15 días o menos, o al que le queda 10 % o menos del rango.', horasEntre: 24 },
  documentos:       { ambito: 'empresa', nombre: 'Documentos por vencer', descripcion: 'Contratos, permisos y registros vencidos o dentro de su plazo de aviso.', horasEntre: 24 },
  antifraude:       { ambito: 'empresa', nombre: 'Alertas altas del antifraude', descripcion: 'Alertas de severidad alta que siguen pendientes de revisar.', horasEntre: 4, solo: ['antifraude'] },
  descuadre_caja:   { ambito: 'empresa', nombre: 'Descuadre de caja', descripcion: 'Cierres de caja con diferencia (sobrante o faltante) mayor al umbral.', horasEntre: 4, umbral: 50 },
};
export const ORDEN_TIPOS = Object.keys(TIPOS_AVISO);

/** Normaliza una lista de correos a un arreglo sin repetidos; lanza si alguno no es válido. */
export function listaCorreos(valor) {
  const lista = (Array.isArray(valor) ? valor : String(valor ?? '').split(/[,;\s]+/)).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const mal = lista.find((e) => !correoValido(e));
  if (mal) { const e = new Error(`Correo no válido: ${mal}`); e.status = 400; throw e; }
  return [...new Set(lista)].slice(0, 10);
}

/** Correos de los dueños del grupo: destinatarios por defecto cuando una regla no tiene lista propia. */
export async function correosDueno(db) {
  const { rows } = await db.query(`select email from core.usuarios where es_dueno_grupo and activo and email is not null and email <> '' order by created_at`);
  return rows.map((r) => r.email.toLowerCase()).filter(correoValido);
}

/** Regla efectiva (fila guardada o valores por defecto) para (empresaId|null, tipo). */
export async function reglaDe(db, empresaId, tipo) {
  const def = TIPOS_AVISO[tipo];
  const { rows } = await db.query(
    `select * from msg.avisos where tipo = $1 and coalesce(empresa_id,'00000000-0000-0000-0000-000000000000'::uuid) = coalesce($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid)`, [tipo, empresaId]);
  const f = rows[0];
  return {
    tipo, empresa_id: empresaId, guardada: Boolean(f),
    activo: f ? f.activo : true,
    destinatarios: f?.destinatarios ?? [],
    hora: f?.hora ?? def.hora ?? null,
    horas_entre: f?.horas_entre ?? def.horasEntre,
    umbral: f?.umbral != null ? Number(f.umbral) : (def.umbral ?? null),
  };
}

/** Destinatarios finales: los de la regla o, si no hay, los dueños. */
export async function destinatariosDe(db, regla) {
  return regla.destinatarios?.length ? regla.destinatarios : correosDueno(db);
}

export async function guardarRegla(db, { empresaId, tipo, activo, destinatarios, hora, horas_entre, umbral, usuarioId }) {
  const def = TIPOS_AVISO[tipo];
  await db.query(
    `insert into msg.avisos (empresa_id, tipo, activo, destinatarios, hora, horas_entre, umbral, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (coalesce(empresa_id,'00000000-0000-0000-0000-000000000000'::uuid), tipo)
     do update set activo=excluded.activo, destinatarios=excluded.destinatarios, hora=excluded.hora, horas_entre=excluded.horas_entre, umbral=excluded.umbral, updated_at=now(), updated_by=excluded.updated_by`,
    [empresaId, tipo, activo, destinatarios, def.hora !== undefined ? hora : null, horas_entre, def.umbral !== undefined ? umbral : null, usuarioId ?? null]);
}

/**
 * Reclama (de forma atómica) el derecho a avisar por esta clave: devuelve true solo si pasó el tiempo mínimo desde el último aviso.
 * Así dos instancias o dos vueltas del temporizador no mandan lo mismo dos veces.
 */
export async function reclamar(db, clave, { horas, detalle = null, ahora = new Date() }) {
  const { rows } = await db.query(
    `insert into msg.avisos_estado (clave, ultimo_at, detalle) values ($1, $3::timestamptz, $2)
     on conflict (clave) do update set ultimo_at = excluded.ultimo_at, detalle = excluded.detalle
       where msg.avisos_estado.ultimo_at <= $3::timestamptz - ($4::int * interval '1 hour')
     returning clave`, [clave, detalle, ahora.toISOString(), horas]);
  return rows.length > 0;
}

export async function estadoClave(db, clave) {
  const { rows } = await db.query('select ultimo_at, detalle from msg.avisos_estado where clave = $1', [clave]);
  return rows[0] ?? null;
}
export async function fijarClave(db, clave, detalle, ahora = new Date()) {
  await db.query(
    `insert into msg.avisos_estado (clave, ultimo_at, detalle) values ($1,$3::timestamptz,$2)
     on conflict (clave) do update set detalle = excluded.detalle`, [clave, detalle, ahora.toISOString()]);
}
