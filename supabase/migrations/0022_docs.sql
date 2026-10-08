-- ════════════════════════════════════════════════════════════════════════════
-- 0022 · DOC — Documentos de la empresa
--
-- Contratos de arrendamiento, permisos (ARSA, operación, alcaldía), registros
-- sanitarios, pólizas, contratos de empleados… con vencimiento, versiones y el
-- archivo guardado en Postgres (bytea, hasta 15 MB; no hay Storage disponible).
--
--   doc.tipos       lista de tipos por empresa (configurable; se siembra desde el API
--                   con valores por defecto según el tipo de negocio) y checklist esperado
--   doc.documentos  el documento (metadatos). El estado «vigente / por vencer / vencido»
--                   se calcula con fecha_vencimiento y dias_aviso; archivado y borrado
--                   son marcas con motivo.
--   doc.versiones   cada archivo subido es una versión; la anterior queda en el historial
--   doc.archivos    los bytes (aparte para que los listados nunca los traigan)
--
-- Confidencialidad: 'restringido' = solo dueño y administrador (p. ej. contratos de empleados).
-- Todo cuelga de empresa_id. RLS activa y sin políticas: solo el API (rol postgres) entra.
-- ════════════════════════════════════════════════════════════════════════════

create schema if not exists doc;

create table doc.tipos (
  id                   uuid primary key default gen_random_uuid(),
  empresa_id           uuid not null references core.empresas(id) on delete cascade,
  codigo               text not null check (codigo ~ '^[a-z0-9_]{2,40}$'),
  nombre               text not null,
  grupo                text not null default 'otro',
  requiere_vencimiento boolean not null default true,
  confidencial         boolean not null default false,   -- los documentos nuevos de este tipo nacen restringidos
  dias_aviso           int not null default 30 check (dias_aviso between 0 and 730),
  de_empleado          boolean not null default false,   -- se adjunta a un empleado
  esperado             boolean not null default false,   -- entra al checklist «qué documentos debe tener la empresa»
  por_sucursal         boolean not null default false,   -- el checklist pide uno por cada sucursal
  activo               boolean not null default true,
  orden                int not null default 100,
  created_at           timestamptz not null default now(),
  unique (empresa_id, codigo)
);

create table doc.documentos (
  id                uuid primary key default gen_random_uuid(),
  empresa_id        uuid not null references core.empresas(id) on delete cascade,
  tipo              text not null,                          -- doc.tipos.codigo
  titulo            text not null check (length(btrim(titulo)) > 0),
  descripcion       text,
  numero            text,                                   -- número o referencia del documento
  entidad_emisora   text,                                   -- ARSA, alcaldía, aseguradora…
  fecha_emision     date,
  fecha_vencimiento date,
  dias_aviso        int not null default 30 check (dias_aviso between 0 and 730),
  sucursal_id       uuid references core.sucursales(id),
  empleado_id       uuid references rrhh.empleados(id),
  contraparte       text,                                   -- arrendador, proveedor…
  monto             numeric(14,2) check (monto is null or monto >= 0),
  etiquetas         text[] not null default '{}',
  confidencialidad  text not null default 'normal' check (confidencialidad in ('normal','restringido')),
  version_actual    int not null default 0,
  archivado         boolean not null default false,
  archivado_at      timestamptz,
  archivado_por     uuid references core.usuarios(id),
  archivado_motivo  text,
  eliminado_at      timestamptz,
  eliminado_por     uuid references core.usuarios(id),
  eliminado_motivo  text,
  creado_por        uuid references core.usuarios(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index documentos_empresa_idx  on doc.documentos (empresa_id, tipo) where eliminado_at is null;
create index documentos_venc_idx     on doc.documentos (empresa_id, fecha_vencimiento) where eliminado_at is null and not archivado;
create index documentos_empleado_idx on doc.documentos (empleado_id) where empleado_id is not null and eliminado_at is null;
create index documentos_sucursal_idx on doc.documentos (sucursal_id) where sucursal_id is not null and eliminado_at is null;

create table doc.versiones (
  id             uuid primary key default gen_random_uuid(),
  documento_id   uuid not null references doc.documentos(id) on delete cascade,
  empresa_id     uuid not null references core.empresas(id) on delete cascade,
  numero         int not null,
  nombre_archivo text not null,
  mime           text not null,
  extension      text not null,
  tamano         int not null check (tamano > 0 and tamano <= 15728640),   -- 15 MB
  sha256         text not null,
  nota           text,
  subido_por     uuid references core.usuarios(id),
  subido_por_nombre text,
  purgada        boolean not null default false,            -- los bytes se borraron al eliminar el documento
  created_at     timestamptz not null default now(),
  unique (documento_id, numero)
);
create index versiones_doc_idx on doc.versiones (documento_id, numero desc);

create table doc.archivos (
  version_id uuid primary key references doc.versiones(id) on delete cascade,
  empresa_id uuid not null references core.empresas(id) on delete cascade,
  contenido  bytea not null
);

alter table doc.tipos       enable row level security;
alter table doc.documentos  enable row level security;
alter table doc.versiones   enable row level security;
alter table doc.archivos    enable row level security;
