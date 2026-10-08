-- Antifraude avanzado.

-- Tercera edad: quién recibió el 25% (nombre + No. de identidad/carné).
alter table ventas add column if not exists tercera_edad_nombre text;
alter table ventas add column if not exists tercera_edad_identidad text;
create index if not exists ventas_tercera_edad_idx on ventas (tercera_edad_identidad, fecha_emision) where tercera_edad_identidad is not null;

-- Conteo de impresiones del ticket: la reimpresión sale marcada como COPIA.
alter table ventas add column if not exists impresiones integer not null default 0;
alter table ventas add column if not exists reimpresiones integer not null default 0;

-- Estados de seguimiento de las alertas.
alter table alertas add column if not exists estado text not null default 'pendiente';
alter table alertas drop constraint if exists alertas_estado_check;
alter table alertas add constraint alertas_estado_check check (estado in ('pendiente', 'investigando', 'resuelta', 'falso_positivo'));
update alertas set estado = 'resuelta' where revisada and estado = 'pendiente';
create index if not exists alertas_estado_idx on alertas (estado, created_at desc);

-- Reglas y umbrales configurables (una sola fila).
create table if not exists config_antifraude (
  id smallint primary key default 1 check (id = 1),
  reglas jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references perfiles(id)
);
insert into config_antifraude (id) values (1) on conflict (id) do nothing;
alter table config_antifraude enable row level security;

-- Arqueos sorpresa (conteo a mitad de turno).
create table if not exists arqueos (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  sucursal_id uuid not null references sucursales(id),
  usuario_id uuid references perfiles(id),
  desde timestamptz not null,
  fondo_caja numeric(12,2) not null default 0,
  efectivo_sistema numeric(12,2) not null default 0,
  salidas numeric(12,2) not null default 0,
  esperado numeric(12,2) not null,
  contado numeric(12,2) not null,
  diferencia numeric(12,2) not null,
  cajeros_turno text,
  nota text
);
create index if not exists arqueos_fecha_idx on arqueos (created_at desc);
alter table arqueos enable row level security;

-- Dispositivos (navegador/computadora) desde los que entra cada usuario.
create table if not exists dispositivos_usuario (
  usuario_id uuid not null references perfiles(id),
  dispositivo_id text not null,
  primera_vez timestamptz not null default now(),
  ultima_vez timestamptz not null default now(),
  navegador text,
  ip text,
  primary key (usuario_id, dispositivo_id)
);
alter table dispositivos_usuario enable row level security;
