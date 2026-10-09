-- 0090 · POS sin conexión (ventas en cola con id del cliente) y productos favoritos
--
-- · id_cliente: UUID que genera la caja al armar la venta. Con él, reenviar la misma venta (el internet se cortó a media respuesta,
--   la pestaña se cerró, el reintento automático corrió dos veces) nunca crea una segunda factura: el servidor devuelve la primera.
-- · numero_provisional: lo que se imprimió en el comprobante SIN conexión (OFF-xxxx-0001). El número fiscal real lo asigna el servidor
--   al sincronizar, con pos.cobrar_venta, bajo el mismo bloqueo de siempre: el correlativo del SAR nunca se repite ni se salta.
-- · vendida_at: hora en que el cliente pagó en la caja (reloj del equipo, acotado por el servidor). fecha_emision es la hora real de emisión.
-- · offline_info: cajero original, retraso y diferencia de precio, para que Dirección revise todo lo que se vendió sin conexión.
alter table pos.ventas
  add column if not exists id_cliente         uuid,
  add column if not exists vendida_at         timestamptz,
  add column if not exists numero_provisional text,
  add column if not exists offline_info       jsonb;

create unique index if not exists ventas_id_cliente_uk on pos.ventas (empresa_id, id_cliente) where id_cliente is not null;
create index if not exists ventas_offline_ix on pos.ventas (empresa_id, vendida_at) where numero_provisional is not null;

-- Favoritos: los fija un encargado desde la caja (estrella) y aparecen primero para todos los cajeros de la empresa.
alter table pos.productos add column if not exists favorito boolean not null default false;
