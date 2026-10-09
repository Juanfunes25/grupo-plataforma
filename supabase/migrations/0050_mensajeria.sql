-- ════════════════════════════════════════════════════════════════════════════
-- 0050 · MSG — Correo y avisos
--
-- Canal de avisos de la plataforma: SOLO correo (Gmail por SMTP; sin WhatsApp ni push).
-- La contraseña de aplicación NUNCA se guarda aquí: vive en variables de entorno
-- (GMAIL_USER, GMAIL_APP_PASSWORD).
--
--   msg.correos       cola + historial de envíos (pendiente / enviado / fallido) con reintentos
--   msg.adjuntos      bytes de los adjuntos mientras el correo no se haya enviado (luego se purgan)
--   msg.avisos        reglas de aviso: por empresa (o del grupo si empresa_id es null), tipo y destinatarios
--   msg.avisos_estado memoria anti-inundación: cuándo se avisó por última vez cada clave / el día del resumen
--
-- RLS activa y sin políticas: solo el API (rol postgres) entra.
-- ════════════════════════════════════════════════════════════════════════════

create schema if not exists msg;

create table msg.correos (
  id               uuid primary key default gen_random_uuid(),
  empresa_id       uuid references core.empresas(id) on delete set null,
  tipo             text not null default 'general',          -- general · factura · cotizacion · resumen · alerta · prueba
  referencia       text,                                     -- id/código del documento o clave de alerta
  para             text[] not null check (cardinality(para) between 1 and 20),
  asunto           text not null,
  html             text not null,
  texto            text,
  estado           text not null default 'pendiente' check (estado in ('pendiente','enviado','fallido')),
  intentos         int not null default 0,
  ultimo_error     text,
  proximo_intento  timestamptz not null default now(),
  enviado_at       timestamptz,
  usuario_id       uuid references core.usuarios(id) on delete set null,
  usuario_nombre   text,
  created_at       timestamptz not null default now()
);
create index correos_empresa_idx on msg.correos (empresa_id, created_at desc);
create index correos_cola_idx on msg.correos (proximo_intento) where estado = 'pendiente';
create index correos_ref_idx on msg.correos (tipo, referencia);

create table msg.adjuntos (
  id         uuid primary key default gen_random_uuid(),
  correo_id  uuid not null references msg.correos(id) on delete cascade,
  nombre     text not null,
  mime       text not null default 'application/octet-stream',
  contenido  bytea not null
);
create index adjuntos_correo_idx on msg.adjuntos (correo_id);

create table msg.avisos (
  id             uuid primary key default gen_random_uuid(),
  empresa_id     uuid references core.empresas(id) on delete cascade,   -- null = avisos del grupo (resumen del dueño)
  tipo           text not null check (tipo in (
                   'resumen_diario','tienda_sin_pesar','cai','documentos','antifraude','descuadre_caja','error_grave')),
  activo         boolean not null default true,
  destinatarios  text[] not null default '{}',
  hora           smallint check (hora between 0 and 23),                 -- solo el resumen diario (hora Honduras)
  horas_entre    int not null default 12 check (horas_entre between 1 and 168),   -- una alerta de este tipo cada N horas
  umbral         numeric(12,2) check (umbral is null or umbral >= 0),             -- descuadre de caja: diferencia (L) desde la cual avisar
  updated_at     timestamptz not null default now(),
  updated_by     uuid references core.usuarios(id) on delete set null
);
create unique index avisos_unico on msg.avisos (coalesce(empresa_id, '00000000-0000-0000-0000-000000000000'::uuid), tipo);

create table msg.avisos_estado (
  clave      text primary key,                  -- p. ej. 'resumen:2026-10-09' o 'cai:<empresa>:<tipo>'
  ultimo_at  timestamptz not null default now(),
  detalle    text
);

alter table msg.correos       enable row level security;
alter table msg.adjuntos      enable row level security;
alter table msg.avisos        enable row level security;
alter table msg.avisos_estado enable row level security;
