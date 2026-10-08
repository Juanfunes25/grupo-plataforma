-- finalizar_venta asigna el correlativo del CAI: sólo el backend debe poder
-- llamarla, y con search_path fijo (aviso del linter de seguridad de
-- Supabase). Con la lectura de ventas abierta a usuarios autenticados para
-- el tiempo real (migración 0007), se cierra también por la vía de RPC.
alter function public.finalizar_venta(uuid, numeric, numeric) set search_path = public, pg_temp;
revoke execute on function public.finalizar_venta(uuid, numeric, numeric) from public, anon, authenticated;
grant execute on function public.finalizar_venta(uuid, numeric, numeric) to service_role;
