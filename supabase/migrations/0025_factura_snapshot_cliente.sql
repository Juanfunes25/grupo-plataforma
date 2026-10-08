-- ════════════════════════════════════════════════════════════════════════════
-- 0025 · La factura guarda los datos del cliente tal como estaban al emitirla
-- Antes la factura leía nombre/RTN del cliente EN VIVO: editar la ficha cambiaba facturas ya emitidas (reimpresión, PDF,
-- libro de ventas). Ahora se copian a la factura en el momento del cobro y de ahí en adelante no cambian.
-- ════════════════════════════════════════════════════════════════════════════
alter table pos.ventas
  add column if not exists cliente_nombre    text,
  add column if not exists cliente_rtn       text,
  add column if not exists cliente_direccion text;

-- Facturas ya emitidas: se rellenan con los datos ACTUALES del cliente (lo único que existe).
update pos.ventas v set cliente_nombre = t.nombre, cliente_rtn = t.rtn, cliente_direccion = t.direccion
  from core.terceros t
 where t.id = v.cliente_id and v.estado in ('pagada','anulada') and v.cliente_nombre is null;

create function pos.congelar_cliente() returns trigger language plpgsql as $$
begin
  select t.nombre, t.rtn, t.direccion into new.cliente_nombre, new.cliente_rtn, new.cliente_direccion
    from core.terceros t where t.id = new.cliente_id;
  return new;
end $$;

-- Al pasar de abierta a pagada (cobro desde la caja, cotización facturada, importaciones…) se congela el cliente.
create trigger venta_congela_cliente before update of estado on pos.ventas
  for each row when (old.estado = 'abierta' and new.estado = 'pagada')
  execute function pos.congelar_cliente();
