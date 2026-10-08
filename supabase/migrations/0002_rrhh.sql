-- ════════════════════════════════════════════════════════════════════════════
-- 0002 · RRHH ÚNICO
--
-- "Un solo recurso humano para todo": una PERSONA existe una vez en el grupo
-- (rrhh.personas) y puede tener varios CONTRATOS, uno por empresa
-- (rrhh.empleados). Asistencia, horarios y vacaciones cuelgan del contrato,
-- así que Administración ve a la misma gente completa sin duplicar fichas.
-- ════════════════════════════════════════════════════════════════════════════

create schema if not exists rrhh;

create table rrhh.personas (
  id                uuid primary key default gen_random_uuid(),
  nombres           text not null,
  apellidos         text not null default '',
  identidad         text,                         -- DNI hondureño
  fecha_nacimiento  date,
  telefono          text,
  correo            text,
  direccion         text,
  contacto_emergencia jsonb,
  notas             text,
  created_at        timestamptz not null default now()
);
create unique index personas_identidad_idx on rrhh.personas (identidad) where identidad is not null and identidad <> '';

create table rrhh.empleados (
  id             uuid primary key default gen_random_uuid(),
  persona_id     uuid not null references rrhh.personas(id),
  empresa_id     uuid not null references core.empresas(id),
  sucursal_id    uuid references core.sucursales(id),
  usuario_id     uuid references core.usuarios(id),   -- si además tiene login
  puesto         text not null,
  departamento   text,
  fecha_ingreso  date not null default current_date,
  fecha_salida   date,
  salario_mensual numeric(12,2),
  estado         text not null default 'activo' check (estado in ('activo','vacaciones','suspendido','baja')),
  notas          text,
  created_at     timestamptz not null default now()
);
create unique index empleados_persona_empresa_vigente_idx
  on rrhh.empleados (persona_id, empresa_id) where estado <> 'baja';
create index empleados_empresa_idx on rrhh.empleados (empresa_id, estado);

create table rrhh.horarios (
  id          uuid primary key default gen_random_uuid(),
  empleado_id uuid not null references rrhh.empleados(id) on delete cascade,
  dia_semana  smallint not null check (dia_semana between 0 and 6),   -- 0 = domingo
  entrada     time not null,
  salida      time not null,
  unique (empleado_id, dia_semana)
);

create table rrhh.marcaciones (
  id          uuid primary key default gen_random_uuid(),
  empleado_id uuid not null references rrhh.empleados(id) on delete cascade,
  empresa_id  uuid not null references core.empresas(id),
  sucursal_id uuid references core.sucursales(id),
  tipo        text not null check (tipo in ('entrada','salida')),
  marcada_at  timestamptz not null default now(),
  origen      text not null default 'manual' check (origen in ('manual','pin','rfid','import')),
  nota        text,
  registrada_por uuid references core.usuarios(id)
);
create index marcaciones_empleado_idx on rrhh.marcaciones (empleado_id, marcada_at desc);
create index marcaciones_empresa_idx  on rrhh.marcaciones (empresa_id, marcada_at desc);

create table rrhh.vacaciones (
  id          uuid primary key default gen_random_uuid(),
  empleado_id uuid not null references rrhh.empleados(id) on delete cascade,
  desde       date not null,
  hasta       date not null,
  estado      text not null default 'solicitada' check (estado in ('solicitada','aprobada','rechazada','tomada')),
  nota        text,
  resuelta_por uuid references core.usuarios(id),
  created_at  timestamptz not null default now(),
  check (hasta >= desde)
);
create index vacaciones_empleado_idx on rrhh.vacaciones (empleado_id, desde);

alter table rrhh.personas    enable row level security;
alter table rrhh.empleados   enable row level security;
alter table rrhh.horarios    enable row level security;
alter table rrhh.marcaciones enable row level security;
alter table rrhh.vacaciones  enable row level security;
