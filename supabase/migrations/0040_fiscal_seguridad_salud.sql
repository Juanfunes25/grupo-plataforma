-- ════════════════════════════════════════════════════════════════════════════
-- 0040 · Agente 4 — Asistente fiscal, seguridad (2FA, sesiones, políticas) y salud
--   · core.sucursales.correo           → dato de contacto de cada sucursal para la factura
--   · core.sesiones_activas            → dispositivos con sesión abierta (cierre remoto)
--   · core.usuarios_mfa / mfa_recuperacion → verificación en dos pasos (TOTP) y códigos de recuperación
--   · core.seguridad_politica          → política global (2FA obligatoria para dirección, largo del PIN)
--   · core.errores_sistema             → errores del servidor y del navegador, caídas detectadas
--   · core.sistema_estado              → pequeños valores del sistema (latido, último respaldo, avisos enviados)
-- Todas con RLS activa y sin políticas (solo el API entra), como el resto del esquema.
-- ════════════════════════════════════════════════════════════════════════════

alter table core.sucursales add column if not exists correo text;

-- ─── Sesiones activas ───────────────────────────────────────────────────────
create table core.sesiones_activas (
  id             uuid primary key default gen_random_uuid(),
  usuario_id     uuid not null references core.usuarios(id) on delete cascade,
  via            text not null check (via in ('password','pin')),
  empresa_codigo text,
  dispositivo    text,                -- id anónimo del equipo (X-Dispositivo)
  navegador      text,                -- «Chrome en Windows», para que la persona reconozca el equipo
  ip             text,
  creada_at      timestamptz not null default now(),
  ultimo_uso     timestamptz not null default now(),
  expira_at      timestamptz not null,
  revocada_at    timestamptz,
  revocada_motivo text
);
create index sesiones_activas_usuario_idx on core.sesiones_activas (usuario_id, creada_at desc);
alter table core.sesiones_activas enable row level security;

-- ─── Verificación en dos pasos (TOTP, compatible con Google Authenticator) ───
create table core.usuarios_mfa (
  usuario_id      uuid primary key references core.usuarios(id) on delete cascade,
  secreto_cifrado text not null,                  -- AES-256-GCM; nunca en claro
  confirmado      boolean not null default false, -- true cuando la persona demostró que su app genera códigos
  confirmado_at   timestamptz,
  ultimo_paso     bigint,                         -- último intervalo de 30 s aceptado: un código no sirve dos veces
  created_at      timestamptz not null default now()
);
alter table core.usuarios_mfa enable row level security;

create table core.mfa_recuperacion (
  id          bigint generated always as identity primary key,
  usuario_id  uuid not null references core.usuarios(id) on delete cascade,
  codigo_hash text not null,                      -- scrypt: los códigos se muestran una sola vez
  usado_at    timestamptz,
  created_at  timestamptz not null default now()
);
create index mfa_recuperacion_usuario_idx on core.mfa_recuperacion (usuario_id) where usado_at is null;
alter table core.mfa_recuperacion enable row level security;

-- ─── Política de seguridad del grupo (una sola fila) ────────────────────────
create table core.seguridad_politica (
  id                        boolean primary key default true check (id),
  mfa_obligatoria_direccion boolean not null default false,   -- dueño y administradores deben usar 2FA
  pin_largo_min             int not null default 4 check (pin_largo_min between 4 and 6),
  pin_largo_max             int not null default 6 check (pin_largo_max between 4 and 6),
  actualizado_at            timestamptz not null default now(),
  actualizado_por           uuid references core.usuarios(id),
  check (pin_largo_max >= pin_largo_min)
);
insert into core.seguridad_politica (id) values (true);
alter table core.seguridad_politica enable row level security;

-- ─── Errores y caídas ───────────────────────────────────────────────────────
create table core.errores_sistema (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  origen     text not null check (origen in ('servidor','navegador','caida','aviso')),
  mensaje    text not null,
  pila       text,
  huella     text not null,                       -- agrupa el mismo error repetido
  ruta       text,
  metodo     text,
  estado     int,
  usuario_id uuid,
  empresa_id uuid,
  agente     text,
  version    text,
  extra      jsonb not null default '{}'::jsonb
);
create index errores_sistema_fecha_idx on core.errores_sistema (created_at desc);
create index errores_sistema_huella_idx on core.errores_sistema (huella, created_at desc);
alter table core.errores_sistema enable row level security;

-- ─── Valores del sistema ────────────────────────────────────────────────────
create table core.sistema_estado (
  clave      text primary key,
  valor      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table core.sistema_estado enable row level security;
