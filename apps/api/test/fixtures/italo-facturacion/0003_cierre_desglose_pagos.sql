-- Desglose por forma de pago (efectivo/tarjeta/transferencia) dentro del
-- turno, calculado al cerrar y guardado junto con el cierre para que el
-- historial no tenga que recalcularlo después.
alter table cierres_caja add column if not exists desglose_pagos jsonb;
