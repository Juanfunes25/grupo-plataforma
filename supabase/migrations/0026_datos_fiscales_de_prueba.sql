-- ════════════════════════════════════════════════════════════════════════════
-- 0026 · Datos fiscales de PRUEBA para poder facturar y probar el sistema
--   Todas las facturas siguen saliendo en modo BORRADOR (sin CAI real, sin valor fiscal): se
--   imprimen para probar y se destruyen. Cuando haya CAI reales se activan en CAI / Emisión.
--   · RTN y direcciones faltantes se llenan con datos ficticios claramente marcados (no pisa
--     lo que ya exista).
--   · Sobre L 10,000 sin RTN solo AVISA (no bloquea) mientras dure la etapa de pruebas.
-- ════════════════════════════════════════════════════════════════════════════
update core.empresas set
  rtn       = coalesce(rtn, '08019000000001'),
  direccion = coalesce(direccion, '12 Avenida, 9 Calle, Barrio Los Andes, San Pedro Sula'),
  telefono  = coalesce(telefono, '3149-3755')
where codigo = 'italo';

update core.empresas set
  razon_social = case when razon_social ilike '%PENDIENTE%' then 'Origen, S. de R.L. (prueba)' else razon_social end,
  rtn          = coalesce(rtn, '08019000000002'),
  direccion    = coalesce(direccion, 'San Pedro Sula, Honduras'),
  telefono     = coalesce(telefono, '0000-0000')
where codigo = 'origen';

update core.empresas set
  rtn       = coalesce(rtn, '08019000000003'),
  telefono  = coalesce(telefono, '2552-2503')
where codigo = 'diserco';

insert into core.config (empresa_id, clave, valor)
select e.id, 'pos', '{"rtn_bloqueante": false}'::jsonb from core.empresas e
on conflict (empresa_id, clave) do update set valor = core.config.valor || '{"rtn_bloqueante": false}'::jsonb;
