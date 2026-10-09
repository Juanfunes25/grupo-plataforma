-- ════════════════════════════════════════════════════════════════════════════
-- 0080 · COBRANZA de EcoStone y DISERCO
--
--   crm.cxc(fecha) / crm.v_cxc   cuentas por cobrar con antigüedad (ÚNICA fuente del cálculo; Finanzas la lee)
--   crm.promesas                 promesas de pago con fecha y responsable
--   crm.gestiones                llamadas, visitas y notas de cobro
--   crm.recordatorios            recordatorios internos (promesa, próxima gestión). El correo lo manda Mensajería.
--
-- Cuenta por cobrar = cotización APROBADA con saldo (en ambas empresas la factura se emite al cobrar, no hay facturas a crédito).
-- Antigüedad = días desde la aprobación (hora de Honduras): 0-30 / 31-60 / 61-90 / +90. «Vencido» = más de 30 días.
-- RLS activa y sin políticas: solo el API entra.
-- ════════════════════════════════════════════════════════════════════════════
create schema if not exists crm;

create function crm.hoy() returns date language sql stable as $$ select (now() at time zone 'America/Tegucigalpa')::date $$;

create table crm.recordatorios (
  id             uuid primary key default gen_random_uuid(),
  empresa_id     uuid not null references core.empresas(id) on delete cascade,
  tipo           text not null check (tipo in ('promesa','gestion','otro')),
  tercero_id     uuid references core.terceros(id) on delete cascade,
  fecha          date not null,
  titulo         text not null,
  detalle        text,
  estado         text not null default 'pendiente' check (estado in ('pendiente','hecho','descartado')),
  responsable_id uuid references core.usuarios(id),
  clave          text,
  creado_por     uuid references core.usuarios(id),
  created_at     timestamptz not null default now(),
  hecho_at       timestamptz
);
create unique index crm_recordatorios_clave_idx on crm.recordatorios (clave) where clave is not null;
create index crm_recordatorios_cola_idx on crm.recordatorios (empresa_id, estado, fecha);

create table crm.promesas (
  id               uuid primary key default gen_random_uuid(),
  empresa_id       uuid not null references core.empresas(id) on delete cascade,
  tercero_id       uuid references core.terceros(id),
  nombre_cliente   text not null,
  origen           text not null check (origen in ('eco','dis')),
  documento_id     uuid not null,
  documento        text,
  monto            numeric(14,2) not null check (monto > 0),
  fecha_promesa    date not null,
  responsable_id   uuid references core.usuarios(id),
  responsable_nombre text,
  estado           text not null default 'pendiente' check (estado in ('pendiente','cumplida','incumplida','cancelada')),
  nota             text,
  creado_por       uuid references core.usuarios(id),
  created_at       timestamptz not null default now(),
  cerrada_at       timestamptz
);
create index crm_promesas_idx on crm.promesas (empresa_id, estado, fecha_promesa);
create index crm_promesas_doc_idx on crm.promesas (origen, documento_id);

create table crm.gestiones (
  id             uuid primary key default gen_random_uuid(),
  empresa_id     uuid not null references core.empresas(id) on delete cascade,
  tercero_id     uuid references core.terceros(id),
  nombre_cliente text not null,
  origen         text not null check (origen in ('eco','dis')),
  documento_id   uuid not null,
  documento      text,
  tipo           text not null check (tipo in ('llamada','visita','correo','mensaje','nota')),
  resultado      text,
  nota           text,
  proxima_fecha  date,
  usuario_id     uuid references core.usuarios(id),
  usuario_nombre text,
  created_at     timestamptz not null default now()
);
create index crm_gestiones_idx on crm.gestiones (empresa_id, origen, documento_id, created_at desc);

-- Cuentas por cobrar de EcoStone y DISERCO: cotización APROBADA con saldo. (En ambas la factura se emite al cobrar, así que no hay
-- facturas a crédito: lo que el cliente debe es lo aprobado y aún no pagado.) Fecha del documento = día de aprobación en hora de Honduras.
create view crm.v_cxc_base as
select 'eco'::text as origen, c.empresa_id, c.id as documento_id, ('COT-' || c.numero)::text as documento, c.cliente_id as tercero_id,
       c.nombre_cliente, coalesce(c.proyecto, '')::text as proyecto, c.estado, c.total::numeric(14,2) as total,
       coalesce(p.pagado, 0)::numeric(14,2) as pagado, round(c.total - coalesce(p.pagado, 0), 2)::numeric(14,2) as saldo,
       case when c.anticipo_pct > 0 then round(c.total * c.anticipo_pct / 100, 2) else 0 end::numeric(14,2) as anticipo_requerido,
       (coalesce(c.aprobada_at, c.updated_at) at time zone 'America/Tegucigalpa')::date as fecha_documento,
       c.vendedor_id
  from eco.cotizaciones c
  left join lateral (select sum(g.monto) as pagado from eco.cotizacion_pagos g where g.cotizacion_id = c.id) p on true
 where c.estado = 'aprobada' and c.total - coalesce(p.pagado, 0) > 0.004
union all
select 'dis'::text, c.empresa_id, c.id, c.codigo::text, c.cliente_id,
       c.nombre_cliente, coalesce(c.proyecto, '')::text, c.estado, c.total::numeric(14,2),
       coalesce(p.pagado, 0)::numeric(14,2), round(c.total - coalesce(p.pagado, 0), 2)::numeric(14,2),
       case when c.anticipo_pct > 0 then round(c.total * c.anticipo_pct / 100, 2) else 0 end::numeric(14,2),
       (coalesce(c.aprobada_at, c.updated_at) at time zone 'America/Tegucigalpa')::date,
       c.vendedor_id
  from dis.cotizaciones c
  left join lateral (select sum(g.monto) as pagado from dis.cotizacion_pagos g where g.cotizacion_id = c.id and not g.anulado) p on true
 where c.estado = 'aprobada' and c.total - coalesce(p.pagado, 0) > 0.004;

-- ANTIGÜEDAD DE SALDOS (única fuente del cálculo): días desde la aprobación de la cotización. Finanzas y el tablero de cobranza
-- leen esta función (o la vista crm.v_cxc, que usa la fecha de hoy en Honduras).
create function crm.cxc(p_hoy date default null)
returns table (origen text, empresa_id uuid, documento_id uuid, documento text, tercero_id uuid, nombre_cliente text, proyecto text, estado text,
               total numeric, pagado numeric, saldo numeric, anticipo_requerido numeric, anticipo_pendiente numeric, fecha_documento date,
               vendedor_id uuid, dias_atraso int, vencido boolean, bucket text)
language sql stable as $$
  select b.origen, b.empresa_id, b.documento_id, b.documento, b.tercero_id, b.nombre_cliente, b.proyecto, b.estado,
         b.total, b.pagado, b.saldo, b.anticipo_requerido, greatest(0, b.anticipo_requerido - b.pagado), b.fecha_documento, b.vendedor_id,
         greatest(0, coalesce(p_hoy, crm.hoy()) - b.fecha_documento)::int,
         (coalesce(p_hoy, crm.hoy()) - b.fecha_documento > 30),
         case when coalesce(p_hoy, crm.hoy()) - b.fecha_documento <= 30 then '0-30'
              when coalesce(p_hoy, crm.hoy()) - b.fecha_documento <= 60 then '31-60'
              when coalesce(p_hoy, crm.hoy()) - b.fecha_documento <= 90 then '61-90'
              else '+90' end
    from crm.v_cxc_base b
$$;
create view crm.v_cxc as select * from crm.cxc();

-- ─── RLS cerrada y funciones fuera del alcance de la API REST de Supabase ───
alter table crm.recordatorios enable row level security;
alter table crm.promesas      enable row level security;
alter table crm.gestiones     enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema crm from anon, authenticated';
    execute 'revoke execute on all functions in schema crm from public, anon, authenticated';
  end if;
end $$;

-- ─── Módulo de cobranza en EcoStone y DISERCO ───────────────────────────────
insert into core.empresa_modulos (empresa_id, modulo)
select e.id, 'cobranza' from core.empresas e where e.codigo in ('ecostone','diserco')
on conflict (empresa_id, modulo) do update set activo = true;
