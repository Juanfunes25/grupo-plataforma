-- La caja pregunta cada 8 segundos «¿cambió algo en las órdenes de esta sucursal?» (GET /pos/ventas/cambios):
--   ... where sucursal_id = … and (estado = 'abierta' or updated_at > now() - interval '3 days')
-- Sin índice por fecha de actualización, cada pregunta recorría TODAS las ventas de la sucursal (≈30 000 por año en una tienda
-- de Italo) y crecía sin parar. Con este índice la base combina «abiertas» (ventas_estado_idx) con «tocadas en 3 días» y lee
-- solo esas: 22,6 ms → 2,1 ms con 120 000 ventas (medido en PGlite), y ya no crece con el historial.
create index if not exists ventas_sucursal_actualizada_idx on pos.ventas (sucursal_id, updated_at);
