// Bandeja de alertas del antifraude. Crear una alerta NUNCA debe hacer fallar la
// operación que la origina: cualquier error se registra y se ignora.
export const ESTADOS_ALERTA = ['pendiente', 'investigando', 'resuelta', 'falso_positivo'];
export const ABIERTAS = ['pendiente', 'investigando'];

/** ¿La empresa activa tiene el módulo encendido? (acepta ctx o la empresa de ctxMgr.empresas()). */
export const antifraudeActivo = (empresaOCtx) => Boolean((empresaOCtx?.empresa ?? empresaOCtx)?.modulos?.includes('antifraude'));

/**
 * @param q  db o transacción
 * @param a  { empresaId, tipo, severidad, titulo, detalle, sucursalId, usuario:{id,nombre}, entidad, entidadId,
 *             clave, cadaMin }  — con `clave` + `cadaMin` no se repite la misma alerta dentro de esa ventana.
 */
export async function crearAlerta(q, a) {
  try {
    if (a.clave && a.cadaMin) {
      const { rowCount } = await q.query(
        `select 1 from af.alertas where empresa_id = $1 and clave = $2 and created_at > now() - make_interval(mins => $3::int) limit 1`,
        [a.empresaId, a.clave, Math.ceil(a.cadaMin)]);
      if (rowCount) return null;
    }
    const { rows } = await q.query(
      `insert into af.alertas (empresa_id, tipo, severidad, titulo, detalle, sucursal_id, usuario_id, usuario_nombre, entidad, entidad_id, clave)
       values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11) returning *`,
      [a.empresaId, a.tipo, a.severidad ?? 'media', a.titulo, JSON.stringify(a.detalle ?? {}), a.sucursalId ?? null,
        a.usuario?.id ?? null, a.usuario?.nombre ?? null, a.entidad ?? null, a.entidadId != null ? String(a.entidadId) : null, a.clave ?? null]);
    return rows[0];
  } catch (e) {
    console.error('[antifraude] no se pudo crear la alerta', a.tipo, e.message);
    return null;
  }
}
