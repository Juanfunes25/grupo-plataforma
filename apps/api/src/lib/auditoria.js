/** Registra en la bitácora inalterable (con cadena de hashes). `q` puede ser db o la transacción. */
export async function auditar(q, ctx, accion, entidad = '', entidadId = null, detalle = {}, extra = {}) {
  await q.query(
    `insert into core.auditoria (empresa_id, usuario_id, usuario_nombre, accion, entidad, entidad_id, sucursal_id, detalle, ip)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
    [
      ctx?.empresa?.id ?? extra.empresaId ?? null,
      ctx?.usuario?.id ?? extra.usuarioId ?? null,
      ctx?.usuario?.nombre ?? extra.usuarioNombre ?? null,
      accion,
      entidad,
      entidadId ? String(entidadId) : null,
      extra.sucursalId ?? null,
      JSON.stringify(detalle ?? {}),
      ctx?.ip ?? extra.ip ?? null,
    ],
  );
}
