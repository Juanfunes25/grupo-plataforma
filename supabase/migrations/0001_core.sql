-- ════════════════════════════════════════════════════════════════════════════
-- 0001 · CORE — empresas, sucursales, usuarios, accesos, terceros, auditoría
--
-- Principio rector: UNA sola base para todo el grupo. Cada fila de negocio
-- cuelga de una empresa (empresa_id) y, cuando aplica, de una sucursal.
-- Un usuario es una sola persona con un solo login y puede tener un ROL
-- DISTINTO en cada empresa (core.accesos). Los clientes/proveedores son
-- comunes (core.terceros) para poder cruzar información entre empresas.
--
-- Seguridad: el backend es el único cliente de la base (conexión directa
-- como rol `postgres`, que ignora RLS). RLS queda ACTIVA en todas las tablas
-- sin políticas: anon/authenticated de PostgREST no ven nada aunque alguien
-- exponga el esquema por error.
-- ════════════════════════════════════════════════════════════════════════════

create schema if not exists core;

-- ─── Empresas del grupo ─────────────────────────────────────────────────────
create table core.empresas (
  id            uuid primary key default gen_random_uuid(),
  codigo        text not null unique check (codigo ~ '^[a-z0-9_]+$'),
  nombre        text not null,
  razon_social  text not null,
  rtn           text,
  direccion     text,
  ciudad        text,
  telefono      text,
  correo        text,
  web           text,
  color         text not null default '#c5603c',   -- acento de marca (UI)
  logo          text,                              -- clave de logo en el frontend
  lema          text,
  tipo_negocio  text not null default 'comercio'
                check (tipo_negocio in ('gelateria','fabrica','distribuidora','fruteria','holding','comercio')),
  moneda        char(3) not null default 'HNL',
  isv_tasa      numeric(5,4) not null default 0.15,
  orden         int not null default 0,
  activo        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- Módulos que cada empresa tiene encendidos (define qué ve en su Hub).
create table core.empresa_modulos (
  empresa_id uuid not null references core.empresas(id) on delete cascade,
  modulo     text not null,
  activo     boolean not null default true,
  primary key (empresa_id, modulo)
);

-- Configuración libre por empresa (umbrales antifraude, leyendas de ticket…).
create table core.config (
  empresa_id uuid not null references core.empresas(id) on delete cascade,
  clave      text not null,
  valor      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (empresa_id, clave)
);

-- ─── Sucursales ─────────────────────────────────────────────────────────────
create table core.sucursales (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references core.empresas(id),
  nombre     text not null,
  alias      text not null,
  direccion  text,
  telefono   text,
  tipo       text not null default 'tienda' check (tipo in ('tienda','fabrica','bodega','oficina')),
  color      text,
  orden      int not null default 0,
  activo     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (empresa_id, alias)
);
create index sucursales_empresa_idx on core.sucursales (empresa_id) where activo;

-- ─── Usuarios y accesos ─────────────────────────────────────────────────────
-- auth_user_id enlaza con Supabase Auth (auth.users.id) cuando se usa en la
-- nube; password_hash permite correr 100 % local/pruebas sin Supabase.
create table core.usuarios (
  id             uuid primary key default gen_random_uuid(),
  auth_user_id   uuid unique,
  email          text unique check (email = lower(email)),
  nombre         text not null,
  password_hash  text,
  es_dueno_grupo boolean not null default false,  -- ve TODAS las empresas, incluso las futuras
  token_version  int not null default 1,          -- subirlo invalida todas sus sesiones
  activo         boolean not null default true,
  ultimo_acceso  timestamptz,
  created_at     timestamptz not null default now()
);

-- Un acceso = "este usuario trabaja en esta empresa con este rol".
-- sucursal_ids vacío = todas las sucursales de la empresa.
create table core.accesos (
  id                 uuid primary key default gen_random_uuid(),
  usuario_id         uuid not null references core.usuarios(id) on delete cascade,
  empresa_id         uuid not null references core.empresas(id),
  rol                text not null check (rol in
                      ('dueno','admin','gerente','cajero','produccion','bodega','ventas','contador','solo_lectura')),
  sucursal_ids       uuid[] not null default '{}',
  permisos_extra     text[] not null default '{}',
  permisos_quitados  text[] not null default '{}',
  pin_hash           text,                         -- HMAC-SHA256; login rápido de mostrador
  pin_cambiado_at    timestamptz,
  activo             boolean not null default true,
  created_at         timestamptz not null default now(),
  unique (usuario_id, empresa_id)
);
create index accesos_empresa_idx on core.accesos (empresa_id) where activo;
-- El PIN se guarda como HMAC (no reversible sin el pepper del servidor) y es
-- único por empresa: así el login por PIN es una búsqueda directa e indexada.
create unique index accesos_pin_idx on core.accesos (empresa_id, pin_hash) where pin_hash is not null;

-- ─── Terceros (clientes y proveedores comunes a todo el grupo) ──────────────
create table core.terceros (
  id                  uuid primary key default gen_random_uuid(),
  es_cliente          boolean not null default true,
  es_proveedor        boolean not null default false,
  nombre              text not null,
  nombre_comercial    text,
  rtn                 text,
  identidad           text,
  telefono            text,
  correo              text,
  direccion           text,
  exento_impuestos    boolean not null default false,
  es_consumidor_final boolean not null default false,
  notas               text,
  activo              boolean not null default true,
  created_by          uuid references core.usuarios(id),
  created_at          timestamptz not null default now()
);
create unique index terceros_rtn_idx on core.terceros (rtn) where rtn is not null and rtn <> '';
create unique index terceros_consumidor_final_idx on core.terceros (es_consumidor_final) where es_consumidor_final;
create index terceros_nombre_idx on core.terceros (lower(nombre));

insert into core.terceros (nombre, es_consumidor_final) values ('Consumidor Final', true);

-- ─── Auditoría transversal INALTERABLE ──────────────────────────────────────
-- Misma garantía que tenía italo-facturacion: (1) triggers que abortan
-- UPDATE/DELETE/TRUNCATE, (2) cadena de hashes SHA-256 estilo libro contable
-- (si alguien con acceso de superusuario altera o borra una fila, la cadena
-- se rompe y core.verificar_auditoria() lo detecta), (3) la fecha la pone la
-- base, no el cliente. Una sola cadena para todo el grupo.
create table core.auditoria (
  id             bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),
  empresa_id     uuid references core.empresas(id),
  usuario_id     uuid references core.usuarios(id),
  usuario_nombre text,
  accion         text not null,
  entidad        text not null default '',
  entidad_id     text,
  sucursal_id    uuid references core.sucursales(id),
  detalle        jsonb not null default '{}'::jsonb,
  ip             text,
  hash_anterior  text,
  hash           text not null default ''
);
create index auditoria_empresa_fecha_idx on core.auditoria (empresa_id, created_at desc);
create index auditoria_entidad_idx on core.auditoria (entidad, entidad_id);

create function core.auditoria_calcular_hash(
  p_id bigint, p_created_at timestamptz, p_empresa_id uuid, p_usuario_id uuid,
  p_accion text, p_entidad text, p_entidad_id text, p_sucursal_id uuid,
  p_detalle jsonb, p_ip text, p_hash_anterior text
) returns text language sql immutable as $$
  select encode(sha256(convert_to(concat_ws('|',
    p_id::text,
    to_char(p_created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    coalesce(p_empresa_id::text, ''),
    coalesce(p_usuario_id::text, ''),
    p_accion, p_entidad, coalesce(p_entidad_id, ''),
    coalesce(p_sucursal_id::text, ''),
    p_detalle::text, coalesce(p_ip, ''),
    coalesce(p_hash_anterior, 'GENESIS')
  ), 'UTF8')), 'hex');
$$;

create function core.auditoria_antes_insertar() returns trigger language plpgsql as $$
declare v_anterior text;
begin
  -- Serializa inserciones: la cadena nunca se bifurca aunque dos sucursales
  -- registren eventos en el mismo milisegundo.
  perform pg_advisory_xact_lock(hashtext('core.auditoria_cadena'));
  new.created_at := now();
  select a.hash into v_anterior from core.auditoria a order by a.id desc limit 1;
  new.hash_anterior := v_anterior;
  new.hash := core.auditoria_calcular_hash(new.id, new.created_at, new.empresa_id, new.usuario_id,
    new.accion, new.entidad, new.entidad_id, new.sucursal_id, new.detalle, new.ip, new.hash_anterior);
  return new;
end $$;

create function core.auditoria_prohibir_cambios() returns trigger language plpgsql as $$
begin
  raise exception 'La bitácora de auditoría es inalterable: no se permite % sobre sus registros', tg_op;
end $$;

create trigger auditoria_hash before insert on core.auditoria
  for each row execute function core.auditoria_antes_insertar();
create trigger auditoria_sin_update before update or delete on core.auditoria
  for each row execute function core.auditoria_prohibir_cambios();
create trigger auditoria_sin_truncate before truncate on core.auditoria
  for each statement execute function core.auditoria_prohibir_cambios();

create function core.verificar_auditoria()
returns table (integra boolean, total bigint, primer_id_alterado bigint)
language plpgsql as $$
declare r record; v_anterior text := null; v_total bigint := 0;
begin
  for r in select * from core.auditoria order by id loop
    v_total := v_total + 1;
    if r.hash_anterior is distinct from v_anterior
       or r.hash <> core.auditoria_calcular_hash(r.id, r.created_at, r.empresa_id, r.usuario_id,
            r.accion, r.entidad, r.entidad_id, r.sucursal_id, r.detalle, r.ip, r.hash_anterior) then
      return query select false, v_total, r.id;
      return;
    end if;
    v_anterior := r.hash;
  end loop;
  return query select true, v_total, null::bigint;
end $$;

-- En Supabase, además se le quitan los privilegios de escritura destructiva a
-- los roles de API (en un Postgres local sin esos roles no hace nada).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke update, delete, truncate on core.auditoria from anon, authenticated, service_role';
  end if;
end $$;

-- ─── RLS cerrada por defecto ────────────────────────────────────────────────
alter table core.empresas        enable row level security;
alter table core.empresa_modulos enable row level security;
alter table core.config          enable row level security;
alter table core.sucursales      enable row level security;
alter table core.usuarios        enable row level security;
alter table core.accesos         enable row level security;
alter table core.terceros        enable row level security;
alter table core.auditoria       enable row level security;

-- ─── Semilla: las empresas del grupo ────────────────────────────────────────
insert into core.empresas (codigo, nombre, razon_social, rtn, direccion, ciudad, telefono, correo, web, color, logo, lema, tipo_negocio, orden) values
  ('italo',    'Italo Gelateria', 'Inversiones Milano S. de R.L.', null,
   null, 'San Pedro Sula, Honduras', null, null, null, '#c5603c', 'italo',
   'Gelato artesanal italiano', 'gelateria', 1),
  ('origen',   'Origen', 'Origen [PENDIENTE razón social]', null,
   null, 'San Pedro Sula, Honduras', null, null, null, '#5c9a3a', 'origen',
   'Frutas, jugos y verduras · del origen a tu vaso', 'fruteria', 2),
  ('ecostone', 'EcoStone', 'Stone Factory S.A.', '05019013557791',
   '7 Calle, 14 Ave S.O.', 'San Pedro Sula, Honduras', '3191-2727', 'administracion@ecostone.com.hn', null, '#4f6b3c', 'ecostone',
   'Piedra de enchape · Stone Factory', 'fabrica', 3),
  ('diserco',  'DISERCO', 'Distribución y Servicios de la Construcción', null,
   'Prolongación Av. Junior, 18 y 19 calle, 4 ave. N.E.', 'San Pedro Sula, Honduras', '(504) 2552-2503', null, 'www.diserco.hn', '#e8762b', 'diserco',
   'Distribución y servicios de la construcción', 'distribuidora', 4);

insert into core.sucursales (empresa_id, nombre, alias, tipo, orden, color)
select e.id, s.nombre, s.alias, s.tipo, s.orden, s.color
from core.empresas e
join (values
  ('italo',    'Los Andes',            'los_andes',        'fabrica', 1, '#c5603c'),  -- producción centralizada + tienda
  ('italo',    '10 Calle EXPRESS',     '10_calle_express', 'tienda',  2, '#2e9e8f'),
  ('italo',    'Mackey',               'mackey',           'tienda',  3, '#b08d28'),
  ('italo',    'Próceres',             'proceres',         'tienda',  4, '#6c7fd6'),
  ('origen',   'Origen · Principal',   'principal',        'tienda',  1, '#5c9a3a'),
  ('ecostone', 'EcoStone · Fábrica',   'fabrica',          'fabrica', 1, '#4f6b3c'),
  ('diserco',  'DISERCO',              'diserco',          'tienda',  1, '#e8762b')
) as s(empresa, nombre, alias, tipo, orden, color) on s.empresa = e.codigo;

-- Módulos por empresa (se irán encendiendo conforme se migre cada sistema).
insert into core.empresa_modulos (empresa_id, modulo)
select e.id, m.modulo from core.empresas e join (values
  ('italo','pos'),('italo','inventario'),('italo','rrhh'),('italo','finanzas'),('italo','grupo'),
  ('origen','pos'),('origen','kds'),('origen','inventario'),('origen','rrhh'),('origen','finanzas'),('origen','grupo'),
  ('ecostone','pos'),('ecostone','inventario'),('ecostone','rrhh'),('ecostone','finanzas'),('ecostone','grupo'),
  ('diserco','pos'),('diserco','inventario'),('diserco','rrhh'),('diserco','finanzas'),('diserco','grupo')
) as m(empresa, modulo) on m.empresa = e.codigo;
