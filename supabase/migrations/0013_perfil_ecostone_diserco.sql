-- ════════════════════════════════════════════════════════════════════════════
-- 0013 · Perfiles de EcoStone (fábrica) y DISERCO (distribuidora)
--   · Rol «gestor» (salidas a proyecto de DISERCO).
--   · EcoStone usa el módulo 'fabrica' y DISERCO el módulo 'distribuidora':
--     traen su propio catálogo, cotizaciones e inventario (los genéricos se ocultan).
--   · Sin antifraude en ninguna de las dos.
--   · En ambas el RTN sobre L 10,000 solo avisa (no bloquea) y se puede facturar
--     sin existencia (con confirmación y alerta), como en la app original.
-- ════════════════════════════════════════════════════════════════════════════
alter table core.accesos drop constraint if exists accesos_rol_check;
alter table core.accesos add constraint accesos_rol_check check (rol in
  ('dueno','admin','gerente','cajero','produccion','bodega','ventas','contador','solo_lectura','gestor'));

delete from core.empresa_modulos
 where modulo in ('inventario','antifraude','cotizaciones')
   and empresa_id in (select id from core.empresas where codigo in ('ecostone','diserco'));

insert into core.empresa_modulos (empresa_id, modulo)
select e.id, m.modulo from core.empresas e join (values ('ecostone','fabrica'), ('diserco','distribuidora')) as m(empresa, modulo) on m.empresa = e.codigo
on conflict (empresa_id, modulo) do update set activo = true;

insert into core.config (empresa_id, clave, valor)
select e.id, 'pos', '{"rtn_bloqueante": false, "permitir_sin_stock": true}'::jsonb from core.empresas e where e.codigo in ('ecostone','diserco')
on conflict (empresa_id, clave) do update set valor = core.config.valor || excluded.valor;
