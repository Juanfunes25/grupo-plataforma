-- ════════════════════════════════════════════════════════════════════════════
-- 0041 · Rendimiento — índices para los reportes y tableros con muchas ventas
--
-- Casi todas las consultas de reportes (dashboard, reportes, tablero, gerente digital, cierres) filtran así:
--     v.empresa_id = $1 and (v.fecha_emision at time zone 'America/Tegucigalpa')::date between $2 and $3
-- La conversión a fecha de Honduras sobre la columna impedía usar el índice (empresa, sucursal, fecha_emision):
-- con 120 000 ventas el dashboard del mes leía las 120 000 y descartaba 117 000. Este índice sobre la MISMA expresión
-- deja a la base ir directo a los días pedidos. Medido en docs/RENDIMIENTO.md.
-- ════════════════════════════════════════════════════════════════════════════

create index if not exists ventas_empresa_dia_hn_idx
  on pos.ventas (empresa_id, ((fecha_emision at time zone 'America/Tegucigalpa')::date), sucursal_id);

-- Anulaciones por día (el dashboard las cuenta aparte): pocas filas, índice parcial.
create index if not exists ventas_anuladas_dia_hn_idx
  on pos.ventas (empresa_id, ((anulada_at at time zone 'America/Tegucigalpa')::date)) where estado = 'anulada';

-- Dirección consolida varias empresas por rango de fechas sin pasar por empresa_id primero.
create index if not exists ventas_pagadas_fecha_idx
  on pos.ventas (fecha_emision desc) where estado = 'pagada';
