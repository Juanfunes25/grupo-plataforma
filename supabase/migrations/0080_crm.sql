-- ════════════════════════════════════════════════════════════════════════════
-- 0080 · CRM — Clientes 360, fidelización (puntos) y cobranza
--
--   Clientes 360    crm.perfil (etiquetas, cumpleaños) · crm.contactos · crm.notas · crm.fusiones (duplicados con aprobación)
--   Fidelización    crm.programas (reglas por empresa, APAGADO por defecto) · crm.premios · crm.puntos_movs (libro de puntos con
--                   lotes que vencen) · crm.premios_otorgados (puntos, ruleta, cumpleaños, manual) · acumulación automática
--                   por trigger al pagarse una venta
--   Cobranza        crm.v_cxc / crm.cxc(fecha): cuentas por cobrar de EcoStone y DISERCO con antigüedad (ÚNICA fuente del cálculo;
--                   Finanzas la lee) · crm.credito_cliente (límite y días de crédito de DISERCO; EcoStone sigue en eco.cliente_ext)
--                   · crm.promesas · crm.gestiones · crm.recordatorios
--
-- RLS activa y sin políticas: solo el API (rol postgres) entra. Hora de Honduras (UTC-6) en todo cálculo de fechas.
-- ════════════════════════════════════════════════════════════════════════════
create schema if not exists crm;

create function crm.hoy() returns date language sql stable as $$ select (now() at time zone 'America/Tegucigalpa')::date $$;

-- Historial por cliente (ficha 360, fidelidad, duplicados): sin este índice cada ficha recorre todas las ventas.
create index if not exists ventas_cliente_idx on pos.ventas (cliente_id) where cliente_id is not null;

-- ─── Clientes 360 ───────────────────────────────────────────────────────────
create table crm.perfil (
  tercero_id uuid primary key references core.terceros(id) on delete cascade,
  etiquetas  text[] not null default '{}',
  cumple_mes smallint check (cumple_mes between 1 and 12),
  cumple_dia smallint check (cumple_dia between 1 and 31),
  updated_by uuid references core.usuarios(id),
  updated_at timestamptz not null default now()
);
create index crm_perfil_etiquetas_idx on crm.perfil using gin (etiquetas);

create table crm.contactos (
  id         uuid primary key default gen_random_uuid(),
  tercero_id uuid not null references core.terceros(id) on delete cascade,
  nombre     text not null,
  cargo      text,
  telefono   text,
  correo     text,
  principal  boolean not null default false,
  created_by uuid references core.usuarios(id),
  created_at timestamptz not null default now()
);
create index crm_contactos_tercero_idx on crm.contactos (tercero_id);

create table crm.notas (
  id             uuid primary key default gen_random_uuid(),
  tercero_id     uuid not null references core.terceros(id) on delete cascade,
  empresa_id     uuid references core.empresas(id),
  texto          text not null check (length(texto) between 1 and 2000),
  usuario_id     uuid references core.usuarios(id),
  usuario_nombre text,
  created_at     timestamptz not null default now()
);
create index crm_notas_tercero_idx on crm.notas (tercero_id, created_at desc);

-- Fusión de duplicados: se PROPONE, y solo quien tiene clientes:fusionar la APRUEBA. Nada se borra: el absorbido queda inactivo.
create table crm.fusiones (
  id               uuid primary key default gen_random_uuid(),
  principal_id     uuid not null references core.terceros(id),
  absorbido_id     uuid not null references core.terceros(id),
  motivo           text,
  similitud        numeric(4,3),
  estado           text not null default 'propuesta' check (estado in ('propuesta','aprobada','rechazada')),
  propuesta_por    uuid references core.usuarios(id),
  propuesta_nombre text,
  propuesta_at     timestamptz not null default now(),
  resuelta_por     uuid references core.usuarios(id),
  resuelta_nombre  text,
  resuelta_at      timestamptz,
  resumen          jsonb not null default '{}'::jsonb,   -- ficha del absorbido y qué se movió (para poder revisar o deshacer a mano)
  check (principal_id <> absorbido_id)
);
create unique index crm_fusiones_abierta_idx on crm.fusiones (principal_id, absorbido_id) where estado = 'propuesta';
create index crm_fusiones_estado_idx on crm.fusiones (estado, propuesta_at desc);

-- Recordatorios internos (cumpleaños, promesas de pago, próxima gestión). El correo lo envía Mensajería; aquí solo el registro.
create table crm.recordatorios (
  id             uuid primary key default gen_random_uuid(),
  empresa_id     uuid not null references core.empresas(id) on delete cascade,
  tipo           text not null check (tipo in ('cumpleanos','promesa','gestion','otro')),
  tercero_id     uuid references core.terceros(id) on delete cascade,
  fecha          date not null,
  titulo         text not null,
  detalle        text,
  estado         text not null default 'pendiente' check (estado in ('pendiente','hecho','descartado')),
  responsable_id uuid references core.usuarios(id),
  clave          text,                                      -- evita repetir el mismo recordatorio automático
  creado_por     uuid references core.usuarios(id),
  created_at     timestamptz not null default now(),
  hecho_at       timestamptz
);
create unique index crm_recordatorios_clave_idx on crm.recordatorios (clave) where clave is not null;
create index crm_recordatorios_cola_idx on crm.recordatorios (empresa_id, estado, fecha);

-- ─── Fidelización ───────────────────────────────────────────────────────────
create table crm.programas (
  empresa_id         uuid primary key references core.empresas(id) on delete cascade,
  activo             boolean not null default false,        -- opcional por empresa: nace APAGADO
  puntos_por_lempira numeric(8,4) not null default 0.1 check (puntos_por_lempira >= 0 and puntos_por_lempira <= 100),
  minimo_compra      numeric(12,2) not null default 0 check (minimo_compra >= 0),
  vencimiento_meses  int not null default 12 check (vencimiento_meses between 0 and 60),   -- 0 = no vencen
  cumple_activo      boolean not null default true,
  cumple_premio      text,
  updated_by         uuid references core.usuarios(id),
  updated_at         timestamptz not null default now()
);

create table crm.premios (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references core.empresas(id) on delete cascade,
  nombre     text not null,
  puntos     int not null check (puntos > 0),
  activo     boolean not null default true,
  orden      int not null default 0,
  unique (empresa_id, nombre)
);

-- Libro de puntos. Cada ganancia es un «lote» con su saldo (restante) y su vencimiento; los canjes consumen primero lo que vence antes.
create table crm.puntos_movs (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references core.empresas(id) on delete cascade,
  tercero_id uuid not null references core.terceros(id),
  tipo       text not null check (tipo in ('acumulo','canje','ajuste','vencimiento','reverso')),
  puntos     int not null,                                  -- + gana · − gasta / vence / revierte
  restante   int not null default 0 check (restante >= 0),  -- saldo vivo del lote (solo filas que suman)
  vence_el   date,
  venta_id   uuid references pos.ventas(id),
  premio_id  uuid references crm.premios(id) on delete set null,
  nota       text,
  usuario_id uuid references core.usuarios(id),
  created_at timestamptz not null default now()
);
create unique index crm_puntos_venta_idx on crm.puntos_movs (venta_id, tipo) where venta_id is not null and tipo in ('acumulo','reverso');
create index crm_puntos_cliente_idx on crm.puntos_movs (empresa_id, tercero_id, created_at desc);
create index crm_puntos_lotes_idx on crm.puntos_movs (empresa_id, tercero_id, vence_el) where restante > 0;

-- Premios entregados o por entregar: por puntos, de la ruleta, de cumpleaños o manuales («premio canjeado»).
create table crm.premios_otorgados (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references core.empresas(id) on delete cascade,
  tercero_id  uuid not null references core.terceros(id),
  origen      text not null check (origen in ('puntos','ruleta','cumpleanos','manual')),
  premio      text not null,
  puntos_costo int not null default 0,
  estado      text not null default 'disponible' check (estado in ('disponible','canjeado','vencido','anulado')),
  otorgado_at timestamptz not null default now(),
  vence_el    date,
  canjeado_at timestamptz,
  canjeado_por uuid references core.usuarios(id),
  venta_id    uuid references pos.ventas(id),
  nota        text,
  usuario_id  uuid references core.usuarios(id)
);
create index crm_premios_otorgados_idx on crm.premios_otorgados (empresa_id, tercero_id, estado);

create function crm.saldo_puntos(p_empresa uuid, p_tercero uuid) returns int language sql stable as $$
  select coalesce(sum(restante), 0)::int from crm.puntos_movs
   where empresa_id = p_empresa and tercero_id = p_tercero and restante > 0 and (vence_el is null or vence_el >= crm.hoy())
$$;

-- Registra como «vencimiento» los lotes cuya fecha ya pasó (se llama antes de mostrar o gastar un saldo).
create function crm.vencer_puntos(p_empresa uuid, p_tercero uuid default null) returns int language plpgsql as $$
declare v_n int := 0; r record;
begin
  for r in select id, tercero_id, restante from crm.puntos_movs
            where empresa_id = p_empresa and restante > 0 and vence_el < crm.hoy() and (p_tercero is null or tercero_id = p_tercero) for update
  loop
    insert into crm.puntos_movs (empresa_id, tercero_id, tipo, puntos, nota) values (p_empresa, r.tercero_id, 'vencimiento', -r.restante, 'Puntos vencidos');
    update crm.puntos_movs set restante = 0 where id = r.id;
    v_n := v_n + r.restante;
  end loop;
  return v_n;
end $$;

-- Gasta puntos de los lotes que vencen primero. Devuelve cuántos pudo gastar (nunca deja saldos negativos).
create function crm.consumir_puntos(p_empresa uuid, p_tercero uuid, p_puntos int) returns int language plpgsql as $$
declare r record; v_falta int := p_puntos; v_toma int;
begin
  perform crm.vencer_puntos(p_empresa, p_tercero);
  for r in select id, restante from crm.puntos_movs
            where empresa_id = p_empresa and tercero_id = p_tercero and restante > 0
            order by vence_el nulls last, created_at for update
  loop
    exit when v_falta <= 0;
    v_toma := least(r.restante, v_falta);
    update crm.puntos_movs set restante = restante - v_toma where id = r.id;
    v_falta := v_falta - v_toma;
  end loop;
  return p_puntos - v_falta;
end $$;

-- Acumula al pagarse una venta con cliente (y revierte si se anula). Sirve venga la venta de caja, API o importación.
create function crm.al_cambiar_estado_venta() returns trigger language plpgsql as $$
declare
  p crm.programas%rowtype; v_pts int; v_prev crm.puntos_movs%rowtype; v_quitado int; v_base numeric;
begin
  if new.cliente_id is null then return new; end if;
  select * into p from crm.programas where empresa_id = new.empresa_id and activo;
  if not found then return new; end if;
  if new.estado = 'pagada' and old.estado = 'abierta' then
    if exists (select 1 from core.terceros where id = new.cliente_id and es_consumidor_final) then return new; end if;
    v_base := new.total - coalesce(new.propina, 0);
    if v_base < p.minimo_compra then return new; end if;
    v_pts := floor(v_base * p.puntos_por_lempira + 0.000001);
    if v_pts > 0 then
      insert into crm.puntos_movs (empresa_id, tercero_id, tipo, puntos, restante, vence_el, venta_id, nota)
      values (new.empresa_id, new.cliente_id, 'acumulo', v_pts, v_pts,
              case when p.vencimiento_meses > 0 then (crm.hoy() + make_interval(months => p.vencimiento_meses))::date end, new.id,
              'Compra ' || coalesce(new.numero_factura, '#' || new.ticket_dia))
      on conflict do nothing;
    end if;
  elsif new.estado = 'anulada' and old.estado = 'pagada' then
    select * into v_prev from crm.puntos_movs where venta_id = new.id and tipo = 'acumulo';
    if found and not exists (select 1 from crm.puntos_movs where venta_id = new.id and tipo = 'reverso') then
      v_quitado := crm.consumir_puntos(new.empresa_id, new.cliente_id, v_prev.puntos);
      insert into crm.puntos_movs (empresa_id, tercero_id, tipo, puntos, venta_id, nota)
      values (new.empresa_id, new.cliente_id, 'reverso', -v_quitado, new.id,
              'Venta anulada' || case when v_quitado < v_prev.puntos then ' (el cliente ya había gastado ' || (v_prev.puntos - v_quitado) || ' puntos)' else '' end);
    end if;
  end if;
  return new;
end $$;
create trigger crm_venta_puntos after update of estado on pos.ventas
  for each row when (old.estado is distinct from new.estado)
  execute function crm.al_cambiar_estado_venta();

-- ─── Cobranza ───────────────────────────────────────────────────────────────
-- Límite y días de crédito. EcoStone los guarda en eco.cliente_ext (ya existía); DISERCO aquí.
create table crm.credito_cliente (
  empresa_id     uuid not null references core.empresas(id) on delete cascade,
  tercero_id     uuid not null references core.terceros(id) on delete cascade,
  limite_credito numeric(14,2) not null default 0 check (limite_credito >= 0),
  dias_credito   int not null default 0 check (dias_credito between 0 and 365),
  updated_by     uuid references core.usuarios(id),
  updated_at     timestamptz not null default now(),
  primary key (empresa_id, tercero_id)
);

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
       coalesce(x.dias_credito, 0)::int as dias_credito, coalesce(x.limite_credito, 0)::numeric(14,2) as limite_credito, c.vendedor_id
  from eco.cotizaciones c
  left join lateral (select sum(g.monto) as pagado from eco.cotizacion_pagos g where g.cotizacion_id = c.id) p on true
  left join eco.cliente_ext x on x.tercero_id = c.cliente_id
 where c.estado = 'aprobada' and c.total - coalesce(p.pagado, 0) > 0.004
union all
select 'dis'::text, c.empresa_id, c.id, c.codigo::text, c.cliente_id,
       c.nombre_cliente, coalesce(c.proyecto, '')::text, c.estado, c.total::numeric(14,2),
       coalesce(p.pagado, 0)::numeric(14,2), round(c.total - coalesce(p.pagado, 0), 2)::numeric(14,2),
       case when c.anticipo_pct > 0 then round(c.total * c.anticipo_pct / 100, 2) else 0 end::numeric(14,2),
       (coalesce(c.aprobada_at, c.updated_at) at time zone 'America/Tegucigalpa')::date,
       coalesce(x.dias_credito, 0)::int, coalesce(x.limite_credito, 0)::numeric(14,2), c.vendedor_id
  from dis.cotizaciones c
  left join lateral (select sum(g.monto) as pagado from dis.cotizacion_pagos g where g.cotizacion_id = c.id and not g.anulado) p on true
  left join crm.credito_cliente x on x.empresa_id = c.empresa_id and x.tercero_id = c.cliente_id
 where c.estado = 'aprobada' and c.total - coalesce(p.pagado, 0) > 0.004;

-- ANTIGÜEDAD DE SALDOS (única fuente del cálculo). Se cuenta desde el VENCIMIENTO = fecha del documento + días de crédito del cliente;
-- lo que aún no vence cae en «0-30». Finanzas y el tablero de cobranza leen esta función (o la vista crm.v_cxc, que usa la fecha de hoy).
create function crm.cxc(p_hoy date default null)
returns table (origen text, empresa_id uuid, documento_id uuid, documento text, tercero_id uuid, nombre_cliente text, proyecto text, estado text,
               total numeric, pagado numeric, saldo numeric, anticipo_requerido numeric, anticipo_pendiente numeric, fecha_documento date,
               dias_credito int, limite_credito numeric, vendedor_id uuid, fecha_vencimiento date, dias_atraso int, vencido boolean, bucket text)
language sql stable as $$
  select b.origen, b.empresa_id, b.documento_id, b.documento, b.tercero_id, b.nombre_cliente, b.proyecto, b.estado,
         b.total, b.pagado, b.saldo, b.anticipo_requerido, greatest(0, b.anticipo_requerido - b.pagado), b.fecha_documento,
         b.dias_credito, b.limite_credito, b.vendedor_id,
         (b.fecha_documento + b.dias_credito) as fecha_vencimiento,
         greatest(0, coalesce(p_hoy, crm.hoy()) - (b.fecha_documento + b.dias_credito))::int as dias_atraso,
         (coalesce(p_hoy, crm.hoy()) > (b.fecha_documento + b.dias_credito)) as vencido,
         case when coalesce(p_hoy, crm.hoy()) - (b.fecha_documento + b.dias_credito) <= 30 then '0-30'
              when coalesce(p_hoy, crm.hoy()) - (b.fecha_documento + b.dias_credito) <= 60 then '31-60'
              when coalesce(p_hoy, crm.hoy()) - (b.fecha_documento + b.dias_credito) <= 90 then '61-90'
              else '+90' end
    from crm.v_cxc_base b
$$;
create view crm.v_cxc as select * from crm.cxc();

-- ─── RLS cerrada y funciones fuera del alcance de la API REST de Supabase ───
alter table crm.perfil             enable row level security;
alter table crm.contactos          enable row level security;
alter table crm.notas              enable row level security;
alter table crm.fusiones           enable row level security;
alter table crm.recordatorios      enable row level security;
alter table crm.programas          enable row level security;
alter table crm.premios            enable row level security;
alter table crm.puntos_movs        enable row level security;
alter table crm.premios_otorgados  enable row level security;
alter table crm.credito_cliente    enable row level security;
alter table crm.promesas           enable row level security;
alter table crm.gestiones          enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema crm from anon, authenticated';
    execute 'revoke execute on all functions in schema crm from public, anon, authenticated';
  end if;
end $$;

-- ─── Módulos: puntos en Italo y Origen · cobranza en EcoStone y DISERCO ─────
insert into core.empresa_modulos (empresa_id, modulo)
select e.id, m.modulo from core.empresas e join (values
  ('italo','fidelidad'), ('origen','fidelidad'), ('ecostone','cobranza'), ('diserco','cobranza')
) as m(empresa, modulo) on m.empresa = e.codigo
on conflict (empresa_id, modulo) do update set activo = true;

-- El programa nace apagado: el dueño lo enciende cuando decida las reglas.
insert into crm.programas (empresa_id) select id from core.empresas where codigo in ('italo','origen') on conflict do nothing;
