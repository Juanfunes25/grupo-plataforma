-- ════════════════════════════════════════════════════════════════════════════
-- 0030 · REPORTES PROGRAMADOS — reportes por correo, diarios o semanales
--
--   rprog.programados   lo que el dueño programa: qué reporte, cada cuánto, a qué hora (Honduras),
--                       a quién y en qué formato (Excel y/o PDF). `ambito = 'grupo'` es el resumen
--                       de las empresas que el creador puede consolidar.
--   rprog.ejecuciones   un renglón por reporte y por DÍA de Honduras (unique): es lo que hace al
--                       disparo idempotente, sin cron externo. Si el correo aún no está configurado
--                       queda «pendiente_correo» y se reintenta solo cuando se configure.
--
-- Todo cuelga de empresa_id. RLS activa y sin políticas: solo el API (rol postgres) entra.
-- ════════════════════════════════════════════════════════════════════════════

create schema if not exists rprog;

create table rprog.programados (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references core.empresas(id) on delete cascade,
  ambito        text not null default 'empresa' check (ambito in ('empresa', 'grupo')),
  nombre        text not null check (length(btrim(nombre)) > 0),
  tipo          text not null check (tipo ~ '^[a-z0-9_]{2,40}$'),        -- código del catálogo (API)
  parametros    jsonb not null default '{}'::jsonb,                       -- {"sucursal_id": "...", "dias": 7}
  frecuencia    text not null check (frecuencia in ('diario', 'semanal')),
  dia_semana    smallint check (dia_semana between 1 and 7),             -- 1 = lunes … 7 = domingo (solo semanal)
  hora          smallint not null default 7 check (hora between 0 and 23),
  destinatarios text[] not null default '{}',
  formatos      text[] not null default '{xlsx}',                        -- xlsx y/o pdf
  activo        boolean not null default true,
  creado_por    uuid references core.usuarios(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (frecuencia = 'diario' or dia_semana is not null),
  check (cardinality(destinatarios) between 1 and 10),
  check (cardinality(formatos) between 1 and 2)
);
create index programados_empresa_idx on rprog.programados (empresa_id, activo);

create table rprog.ejecuciones (
  id             bigint generated always as identity primary key,
  programado_id  uuid not null references rprog.programados(id) on delete cascade,
  empresa_id     uuid not null references core.empresas(id) on delete cascade,
  fecha          date not null,                                          -- día de Honduras para el que corresponde
  estado         text not null check (estado in ('procesando', 'enviado', 'pendiente_correo', 'error', 'sin_datos')),
  intentos       int not null default 1,
  detalle        text,
  destinatarios  text[] not null default '{}',
  archivos       jsonb not null default '[]'::jsonb,                     -- [{nombre, tipo, bytes}]
  iniciado_at    timestamptz not null default now(),
  terminado_at   timestamptz,
  unique (programado_id, fecha)
);
create index ejecuciones_empresa_idx on rprog.ejecuciones (empresa_id, iniciado_at desc);

alter table rprog.programados enable row level security;
alter table rprog.ejecuciones enable row level security;
