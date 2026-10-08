-- Alertas para el dueño: descuadres de caja, anulaciones, órdenes
-- descartadas, intentos de entrar a lo que no le corresponde, etc. Se
-- generan en el backend y se revisan en la pantalla Antifraude.
create table if not exists alertas (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  tipo text not null,
  severidad text not null default 'media' check (severidad in ('baja', 'media', 'alta')),
  titulo text not null,
  detalle jsonb not null default '{}'::jsonb,
  sucursal_id uuid references sucursales(id),
  usuario_id uuid references perfiles(id),
  usuario_nombre text,
  entidad text,
  entidad_id text,
  revisada boolean not null default false,
  revisada_por uuid references perfiles(id),
  revisada_at timestamptz,
  nota_revision text
);
create index if not exists alertas_pendientes_idx on alertas (revisada, created_at desc);
create index if not exists alertas_fecha_idx on alertas (created_at desc);
alter table alertas enable row level security;
-- Sin políticas: sólo el backend (service_role) lee y escribe.

-- La bitácora ahora registra también navegación y eventos de caja: índices
-- para las consultas del panel antifraude.
create index if not exists auditoria_accion_fecha_idx on auditoria (accion, created_at desc);
create index if not exists auditoria_usuario_fecha_idx on auditoria (usuario_id, created_at desc);
