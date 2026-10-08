-- Descuento por producto: cada línea guarda su propio porcentaje (0, 10 o
-- 25 tercera edad). ventas.descuento_porcentaje queda como resumen (el
-- mayor porcentaje aplicado en la orden) para filtros y compatibilidad.
alter table detalle_venta add column if not exists descuento_porcentaje smallint not null default 0;
alter table detalle_venta drop constraint if exists detalle_venta_descuento_porcentaje_check;
alter table detalle_venta add constraint detalle_venta_descuento_porcentaje_check check (descuento_porcentaje in (0, 10, 25));

-- Órdenes ya emitidas con descuento general: se marca cada línea con ese
-- porcentaje (el monto ya estaba repartido proporcionalmente en "descuento").
update detalle_venta d set descuento_porcentaje = v.descuento_porcentaje
from ventas v
where v.id = d.venta_id and coalesce(v.descuento_porcentaje, 0) in (10, 25) and d.descuento > 0 and d.descuento_porcentaje = 0;
