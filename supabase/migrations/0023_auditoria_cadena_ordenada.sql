-- ════════════════════════════════════════════════════════════════════════════
-- 0023 · Bitácora: la cadena de hashes ya no se rompe con escrituras simultáneas
--
-- El id de core.auditoria se asignaba ANTES de tomar el candado de la cadena (el candado estaba en el
-- trigger por fila, que corre después del DEFAULT del id). Con dos transacciones escribiendo a la vez
-- podía pasar que la de id menor tomara el candado después: su hash_anterior apuntaba a la fila de id
-- mayor y core.verificar_auditoria() (que recorre por id) lo reportaba como alteración.
-- Ahora el candado se toma en un trigger POR SENTENCIA, que corre antes de que se asigne el id:
-- el orden por id es siempre el orden de la cadena. (Probado con 400 escrituras concurrentes en Postgres 16.)
-- ════════════════════════════════════════════════════════════════════════════
create function core.auditoria_candado_cadena() returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtext('core.auditoria_cadena'));
  return null;
end $$;

create trigger auditoria_candado before insert on core.auditoria
  for each statement execute function core.auditoria_candado_cadena();
