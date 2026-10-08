-- 0017 · Italo: módulo de reposición de gelato (viene de italo-reposicion)
insert into core.empresa_modulos (empresa_id, modulo)
select e.id, 'reposicion' from core.empresas e where e.codigo = 'italo'
on conflict (empresa_id, modulo) do update set activo = true;
