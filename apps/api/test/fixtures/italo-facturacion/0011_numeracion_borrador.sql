-- Facturas emitidas en modo borrador (sin CAI real) llevan el prefijo
-- "BORRADOR-". Antes usaban el mismo formato que las fiscales
-- (002-001-01-00000001), y al activar el CAI real con el rango del SAR
-- empezando en 1, la primera factura real chocaba con el índice único de
-- numero_factura contra la de prueba. Además así nadie confunde un
-- comprobante interno con una factura fiscal.

create or replace function public.finalizar_venta(p_venta_id uuid, p_efectivo numeric, p_cambio numeric)
returns ventas
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
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
  if v_pe.es_borrador then
    v_numero := 'BORRADOR-' || v_numero;
  end if;

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
$function$;

revoke execute on function public.finalizar_venta(uuid, numeric, numeric) from public, anon, authenticated;
grant execute on function public.finalizar_venta(uuid, numeric, numeric) to service_role;

-- Renombrar las facturas de prueba ya emitidas en modo borrador (y los
-- rangos de los cierres que las citan).
update cierres_caja c set
  factura_desde = case when c.factura_desde is not null and c.factura_desde not like 'BORRADOR-%'
                       and exists (select 1 from ventas v join puntos_emision pe on pe.id = v.punto_emision_id
                                   where v.numero_factura = c.factura_desde and pe.es_borrador)
                  then 'BORRADOR-' || c.factura_desde else c.factura_desde end,
  factura_hasta = case when c.factura_hasta is not null and c.factura_hasta not like 'BORRADOR-%'
                       and exists (select 1 from ventas v join puntos_emision pe on pe.id = v.punto_emision_id
                                   where v.numero_factura = c.factura_hasta and pe.es_borrador)
                  then 'BORRADOR-' || c.factura_hasta else c.factura_hasta end;

update ventas v set numero_factura = 'BORRADOR-' || v.numero_factura
from puntos_emision pe
where pe.id = v.punto_emision_id
  and pe.es_borrador
  and v.numero_factura is not null
  and v.numero_factura not like 'BORRADOR-%';
