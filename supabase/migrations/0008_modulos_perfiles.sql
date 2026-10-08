-- ════════════════════════════════════════════════════════════════════════════
-- 0008 · Perfiles de negocio por empresa (módulos encendidos)
--   · «Dirección» deja de ser módulo de empresa (vive solo en /grupo).
--   · Antifraude: solo Italo y Origen (EcoStone y DISERCO no lo usan).
--   · Cotizaciones/eventos: Italo.
-- ════════════════════════════════════════════════════════════════════════════
delete from core.empresa_modulos where modulo = 'grupo';

insert into core.empresa_modulos (empresa_id, modulo)
select e.id, m.modulo from core.empresas e join (values
  ('italo','antifraude'), ('origen','antifraude'), ('italo','cotizaciones')
) as m(empresa, modulo) on m.empresa = e.codigo
on conflict (empresa_id, modulo) do update set activo = true;
