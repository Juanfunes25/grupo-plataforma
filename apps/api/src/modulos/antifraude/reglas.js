// Umbrales del antifraude por empresa (core.config → clave 'antifraude').
// Son los de Italo Facturación más los que ya usaba el análisis del periodo
// (calcularAlertas) y el gerente digital: todo vive en el mismo registro.
export const REGLAS_DEFECTO = {
  // Análisis del periodo
  descuento_pct_max: 10,         // % de descuento sobre ventas brutas de un cajero
  descuento_min_facturas: 10,
  anulaciones_pct_max: 8,        // % de facturas anuladas de un cajero
  anulaciones_min: 3,
  reimpresiones_max: 5,          // reimpresiones por usuario en el periodo
  descuadre_max: 50,             // L de faltante/sobrante tolerado en un cierre
  // Órdenes y facturas
  monto_alerta_descarte: 150,    // L de una orden descartada que genera alerta
  minutos_orden_estacionada: 60, // orden abierta sin cobrar
  minutos_doble_factura: 5,      // ventana para detectar dos facturas idénticas
  reimpresiones_por_factura: 3,  // copias de UNA misma factura antes de alertar
  // Tercera edad
  max_usos_carne_dia: 3,
  max_tercera_edad_dia: 10,
  // Caja
  umbral_sobrante: 50,
  faltantes_reincidencia: 2,     // cierres con faltante en 7 días
  minutos_hueco: 45,             // minutos sin facturar que cuentan como hueco
  hueco_desde_hora: 11,          // franja en que la tienda debería estar vendiendo
  hueco_hasta_hora: 21,
  // Sesiones
  minutos_bloqueo_cajero: 10,
  minutos_bloqueo_otros: 20,
  intentos_login: 5,             // intentos fallidos en 15 min
  hora_apertura: 9,              // uso normal del sistema (hora de Honduras)
  hora_cierre: 24,
};

export async function obtenerReglas(q, empresaId) {
  const { rows } = await q.query(`select valor from core.config where empresa_id = $1 and clave = 'antifraude'`, [empresaId]);
  return { ...REGLAS_DEFECTO, ...(rows[0]?.valor ?? {}) };
}

/** Guarda solo claves conocidas con números válidos; devuelve las reglas completas y los cambios. */
export async function guardarReglas(q, empresaId, nuevas) {
  const antes = await obtenerReglas(q, empresaId);
  const limpias = {};
  for (const k of Object.keys(REGLAS_DEFECTO)) {
    if (nuevas?.[k] === undefined || nuevas[k] === '' || nuevas[k] === null) continue;
    const n = Number(nuevas[k]);
    if (Number.isFinite(n) && n >= 0 && n <= 100000) limpias[k] = n;
  }
  const reglas = { ...antes, ...limpias };
  await q.query(
    `insert into core.config (empresa_id, clave, valor) values ($1, 'antifraude', $2::jsonb)
     on conflict (empresa_id, clave) do update set valor = excluded.valor, updated_at = now()`,
    [empresaId, JSON.stringify(reglas)]);
  const cambios = Object.keys(limpias).filter((k) => String(antes[k]) !== String(reglas[k])).map((k) => `${k}: ${antes[k]} → ${reglas[k]}`);
  return { reglas, cambios };
}
