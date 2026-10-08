-- ════════════════════════════════════════════════════════════════════════════
-- 0009 · ANTIFRAUDE (portado de italo-facturacion 0013 + 0014)
--
-- Esquema `af`, todo por empresa (solo lo usan las empresas con el módulo
-- 'antifraude' encendido: Italo y Origen).
--   · alertas      bandeja con estados (pendiente → investigando → resuelta / falso_positivo)
--   · arqueos      conteos sorpresa de efectivo a mitad de turno
--   · dispositivos navegadores desde los que entra cada usuario (nuevo / simultáneo)
-- Las reglas y umbrales viven en core.config (clave 'antifraude'); los eventos de
-- uso (pantallas, sesiones) van a la bitácora inalterable core.auditoria.
-- ════════════════════════════════════════════════════════════════════════════

create schema if not exists af;

create table af.alertas (
  id             bigint generated always as identity primary key,
  empresa_id     uuid not null references core.empresas(id),
  created_at     timestamptz not null default now(),
  tipo           text not null,
  severidad      text not null default 'media' check (severidad in ('baja','media','alta')),
  titulo         text not null,
  detalle        jsonb not null default '{}'::jsonb,
  sucursal_id    uuid references core.sucursales(id),
  usuario_id     uuid references core.usuarios(id),
  usuario_nombre text,
  entidad        text,
  entidad_id     text,
  clave          text,                       -- para no repetir la misma alerta (ver af.alertas_clave_idx)
  estado         text not null default 'pendiente' check (estado in ('pendiente','investigando','resuelta','falso_positivo')),
  revisada_por   uuid references core.usuarios(id),
  revisada_at    timestamptz,
  nota_revision  text
);
create index alertas_empresa_estado_idx on af.alertas (empresa_id, estado, created_at desc);
create index alertas_empresa_fecha_idx  on af.alertas (empresa_id, created_at desc);
create index alertas_clave_idx          on af.alertas (empresa_id, clave, created_at desc) where clave is not null;
create index alertas_entidad_idx        on af.alertas (empresa_id, tipo, entidad_id) where entidad_id is not null;

create table af.arqueos (
  id               bigint generated always as identity primary key,
  empresa_id       uuid not null references core.empresas(id),
  created_at       timestamptz not null default now(),
  sucursal_id      uuid not null references core.sucursales(id),
  usuario_id       uuid references core.usuarios(id),
  desde            timestamptz not null,
  fondo_caja       numeric(12,2) not null default 0,
  efectivo_sistema numeric(12,2) not null default 0,
  salidas          numeric(12,2) not null default 0,
  esperado         numeric(12,2) not null,
  contado          numeric(12,2) not null,
  diferencia       numeric(12,2) not null,
  cajeros_turno    text,
  nota             text
);
create index arqueos_empresa_fecha_idx on af.arqueos (empresa_id, created_at desc);

create table af.dispositivos (
  empresa_id     uuid not null references core.empresas(id),
  usuario_id     uuid not null references core.usuarios(id),
  dispositivo_id text not null,
  primera_vez    timestamptz not null default now(),
  ultima_vez     timestamptz not null default now(),
  navegador      text,
  ip             text,
  primary key (empresa_id, usuario_id, dispositivo_id)
);

alter table af.alertas      enable row level security;
alter table af.arqueos      enable row level security;
alter table af.dispositivos enable row level security;
-- Sin políticas: solo el API (rol postgres) lee y escribe.

-- Consultas del panel (línea de tiempo y señales por usuario) sobre la bitácora.
create index if not exists auditoria_usuario_fecha_idx on core.auditoria (usuario_id, created_at desc);
create index if not exists auditoria_empresa_accion_idx on core.auditoria (empresa_id, accion, created_at desc);
