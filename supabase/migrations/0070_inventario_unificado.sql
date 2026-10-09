-- ════════════════════════════════════════════════════════════════════════════
-- 0070 · INVENTARIO UNIFICADO (mejora 18)
--
-- Una sola vista de inventario para las cuatro empresas SIN mover sus tablas:
--   Origen   → inv.*           Italo → rinv.* (+ rep.insumos_catalogo)
--   EcoStone → fab.*           DISERCO → dis.*
-- Lo que se agrega aquí es lo que no existía: conteos cíclicos con aprobación,
-- traslados con documento (entre sucursales y entre empresas) y mínimos
-- configurables para lo que no tenía (p. ej. DISERCO).
-- "fuente" dice de qué tabla viene el ítem: inv · rinv_suc · rinv_fab ·
-- fab_insumo · fab_piedra · dis. ref_id es el id del ítem en esa fuente (blando,
-- sin llave foránea: cada módulo es dueño de sus tablas).
-- ════════════════════════════════════════════════════════════════════════════

create schema if not exists invu;

create table invu.contadores (
  empresa_id uuid not null references core.empresas(id),
  clave      text not null,
  ultimo     int  not null default 0,
  primary key (empresa_id, clave)
);

create function invu.siguiente(p_empresa uuid, p_clave text) returns int language plpgsql as $$
declare v int;
begin
  insert into invu.contadores (empresa_id, clave, ultimo) values (p_empresa, p_clave, 1)
  on conflict (empresa_id, clave) do update set ultimo = invu.contadores.ultimo + 1
  returning ultimo into v;
  return v;
end $$;

-- Mínimo propio (pisa al de la fuente). Útil donde la fuente no lleva mínimos.
create table invu.minimos (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references core.empresas(id),
  fuente      text not null,
  ref_id      uuid not null,
  sucursal_id uuid references core.sucursales(id),
  minimo      numeric(14,3) not null check (minimo >= 0),
  updated_by  uuid references core.usuarios(id),
  updated_at  timestamptz not null default now()
);
create unique index invu_minimos_uq on invu.minimos (empresa_id, fuente, ref_id, coalesce(sucursal_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ─── Conteos cíclicos ───────────────────────────────────────────────────────
create table invu.conteos (
  id               uuid primary key default gen_random_uuid(),
  empresa_id       uuid not null references core.empresas(id),
  numero           int  not null,
  nombre           text not null,
  fecha_programada date not null,
  sucursal_id      uuid references core.sucursales(id),    -- ubicación (null = todas)
  fuente           text,                                   -- null = todas las fuentes de la empresa
  categoria        text,                                   -- null = todas
  ciego            boolean not null default true,          -- quien cuenta no ve la existencia del sistema
  estado           text not null default 'programado'
                   check (estado in ('programado','en_conteo','por_aprobar','aplicado','cancelado')),
  notas            text,
  creado_por       uuid references core.usuarios(id),
  created_at       timestamptz not null default now(),
  iniciado_at      timestamptz,
  enviado_por      uuid references core.usuarios(id),
  enviado_at       timestamptz,
  aprobado_por     uuid references core.usuarios(id),
  aprobado_at      timestamptz,
  nota_aprobacion  text,
  unique (empresa_id, numero)
);
create index invu_conteos_idx on invu.conteos (empresa_id, estado, fecha_programada desc);

create table invu.conteo_lineas (
  id              uuid primary key default gen_random_uuid(),
  conteo_id       uuid not null references invu.conteos(id) on delete cascade,
  fuente          text not null,
  ref_id          uuid not null,
  sucursal_id     uuid references core.sucursales(id),
  nombre          text not null,
  categoria       text,
  unidad          text,
  esperado        numeric(14,3) not null,                  -- existencia del sistema al iniciar el conteo
  costo_unitario  numeric(14,4),
  contado         numeric(14,3) check (contado is null or contado >= 0),
  contado_por     uuid references core.usuarios(id),
  contado_at      timestamptz,
  decision        text check (decision in ('ajustar','ignorar')),
  ajuste_aplicado numeric(14,3),
  nota            text
);
create unique index invu_conteo_lineas_uq on invu.conteo_lineas (conteo_id, fuente, ref_id, coalesce(sucursal_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ─── Traslados (entre sucursales de una empresa o entre empresas del grupo) ──
create table invu.traslados (
  id                  uuid primary key default gen_random_uuid(),
  numero              int  not null,                       -- correlativo por empresa de ORIGEN
  empresa_origen_id   uuid not null references core.empresas(id),
  sucursal_origen_id  uuid references core.sucursales(id),
  empresa_destino_id  uuid not null references core.empresas(id),
  sucursal_destino_id uuid references core.sucursales(id),
  estado              text not null default 'en_transito' check (estado in ('en_transito','recibido','anulado')),
  notas               text,
  valor_total         numeric(14,2) not null default 0,
  creado_por          uuid references core.usuarios(id),
  created_at          timestamptz not null default now(),
  recibido_por        uuid references core.usuarios(id),
  recibido_at         timestamptz,
  nota_recepcion      text,
  con_diferencia      boolean not null default false,
  anulado_por         uuid references core.usuarios(id),
  anulado_at          timestamptz,
  motivo_anulacion    text,
  intercompania_id    uuid,                                -- fin.intercompania (solo entre empresas)
  unique (empresa_origen_id, numero)
);
create index invu_traslados_origen_idx  on invu.traslados (empresa_origen_id, created_at desc);
create index invu_traslados_destino_idx on invu.traslados (empresa_destino_id, estado, created_at desc);

create table invu.traslado_lineas (
  id                uuid primary key default gen_random_uuid(),
  traslado_id       uuid not null references invu.traslados(id) on delete cascade,
  fuente_origen     text not null,
  ref_origen        uuid not null,
  nombre            text not null,
  unidad            text,
  cantidad          numeric(14,3) not null check (cantidad > 0),
  costo_unitario    numeric(14,4),                         -- costo en origen al despachar (null = sin costo conocido)
  fuente_destino    text,
  ref_destino       uuid,
  cantidad_recibida numeric(14,3) check (cantidad_recibida is null or cantidad_recibida >= 0),
  nota              text
);
create index invu_traslado_lineas_idx on invu.traslado_lineas (traslado_id);

alter table invu.contadores      enable row level security;
alter table invu.minimos         enable row level security;
alter table invu.conteos         enable row level security;
alter table invu.conteo_lineas   enable row level security;
alter table invu.traslados       enable row level security;
alter table invu.traslado_lineas enable row level security;
