-- ════════════════════════════════════════════════════════════════════════════
-- 0007 · Notas de crédito numeradas por empresa
-- (paridad con italo-facturacion; el antifraude y la caja chica salen de tablas ya existentes)
-- ════════════════════════════════════════════════════════════════════════════
create table pos.contador_nc (
  empresa_id uuid primary key references core.empresas(id),
  ultimo     int not null default 0
);
alter table pos.contador_nc enable row level security;

create function pos.siguiente_nc(p_empresa uuid) returns int language sql as $$
  insert into pos.contador_nc (empresa_id, ultimo) values (p_empresa, 1)
  on conflict (empresa_id) do update set ultimo = pos.contador_nc.ultimo + 1
  returning ultimo;
$$;

alter table pos.notas_credito
  add column sucursal_id  uuid references core.sucursales(id),
  add column es_borrador  boolean not null default true;   -- true = serie interna, sin CAI de nota de crédito
create index notas_credito_venta_idx on pos.notas_credito (venta_id);
