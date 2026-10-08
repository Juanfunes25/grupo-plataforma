-- Fase 4: motor de correlativo/CAI. finalizar_venta() hace en una sola
-- transacción: lock del punto_emision, validación de rango/fecha límite,
-- incremento atómico del correlativo y actualización de la venta. Así nunca
-- se puede saltar ni repetir un número, ni siquiera con dos cajeros
-- procesando pago al mismo tiempo en la misma sucursal.

create sequence if not exists ventas_numero_orden_seq;
alter table ventas alter column numero_orden set default nextval('ventas_numero_orden_seq');
alter sequence ventas_numero_orden_seq owned by ventas.numero_orden;

alter table ventas add column if not exists anulada boolean not null default false;

create or replace function finalizar_venta(
  p_venta_id uuid,
  p_efectivo numeric,
  p_cambio numeric
) returns ventas as $$
declare
  v_venta ventas%rowtype;
  v_pe puntos_emision%rowtype;
  v_correlativo bigint;
  v_numero text;
begin
  select * into v_venta from ventas where id = p_venta_id for update;
  if v_venta is null then
    raise exception 'Venta no encontrada';
  end if;
  if v_venta.estado not in ('abierta', 'borrador') then
    raise exception 'La venta ya fue procesada (estado actual: %)', v_venta.estado;
  end if;
  if v_venta.punto_emision_id is null then
    raise exception 'La venta no tiene punto de emisión asignado';
  end if;

  select * into v_pe from puntos_emision where id = v_venta.punto_emision_id for update;
  if v_pe is null or not v_pe.activo then
    raise exception 'Punto de emisión no encontrado o inactivo';
  end if;
  if v_pe.fecha_limite_emision is not null and v_pe.fecha_limite_emision < current_date then
    raise exception 'El rango autorizado de facturación venció el %', v_pe.fecha_limite_emision;
  end if;
  if v_pe.correlativo_actual > v_pe.correlativo_hasta then
    raise exception 'El rango de correlativos autorizado está agotado';
  end if;

  v_correlativo := v_pe.correlativo_actual;
  v_numero := v_pe.punto_emision_codigo || '-' || v_pe.punto_venta_codigo || '-'
              || v_pe.tipo_documento_codigo || '-' || lpad(v_correlativo::text, 8, '0');

  update puntos_emision set correlativo_actual = correlativo_actual + 1 where id = v_pe.id;

  update ventas set
    estado = 'pagada',
    numero_factura = v_numero,
    correlativo = v_correlativo,
    fecha_emision = now(),
    efectivo_recibido = p_efectivo,
    cambio = p_cambio
  where id = p_venta_id
  returning * into v_venta;

  return v_venta;
end;
$$ language plpgsql;
