-- "revoke ... from anon, authenticated" no alcanza: Postgres da EXECUTE a
-- PUBLIC por defecto en toda función nueva. Sólo el backend (service_role)
-- verifica la bitácora.
revoke execute on function verificar_auditoria() from public, anon, authenticated;
grant execute on function verificar_auditoria() to service_role;
revoke execute on function auditoria_calcular_hash(bigint, timestamptz, uuid, text, text, text, uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function auditoria_calcular_hash(bigint, timestamptz, uuid, text, text, text, uuid, jsonb, text, text) to service_role;
revoke execute on function auditoria_antes_insertar() from public, anon, authenticated;
revoke execute on function auditoria_prohibir_cambios() from public, anon, authenticated;
