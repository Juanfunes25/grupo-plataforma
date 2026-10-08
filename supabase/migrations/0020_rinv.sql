-- ════════════════════════════════════════════════════════════════════════════
-- 0020 · RINV — Inventario de reposición (Italo): insumos de fábrica y de sucursal,
--        kardex, lotes Mec3 con vencimiento, RFID de freezers, incidencias con foto,
--        mantenimiento de equipos y checklist de tienda.
--
-- Portado de «Italo Reposición» (db.js). Se enciende con el módulo de empresa
-- 'reposicion' (solo Italo). Todo cuelga de empresa_id.
--
-- ┌─ CONTRATO CON LOS OTROS ESQUEMAS DE REPOSICIÓN ────────────────────────────┐
-- │ · El catálogo de insumos/empaques de SUCURSAL es rep.insumos_catalogo      │
-- │   (R1, 0018): el mismo que usan las tiendas para pedir (nombre, unidad,    │
-- │   categoría, código de barras, mínimo, máximo, es_equipo, activo). Aquí    │
-- │   solo vive la CANTIDAD de cada insumo en cada sucursal (rinv.stock_suc)   │
-- │   y su kardex. Qué insumos ve cada tienda para pedir es                    │
-- │   rep.sucursal_insumos (R1).                                               │
-- │ · sabor_id (rep.sabores) y produccion_id (prod.producciones, R2) se        │
-- │   guardan como uuid «blandos», sin llave foránea: borrar una tanda o       │
-- │   fusionar sabores no debe chocar con un tag RFID o una incidencia.        │
-- │ · rinv.insumos_fab es el catálogo de materia prima de FÁBRICA (Mec3,       │
-- │   locales y Ristoris) con su stock total, mínimos y precio vigente         │
-- │   (rinv.precios_fab, solo se agrega, nunca se edita). Producción (R2)      │
-- │   lo reconoce por (empresa, nombre) y le descuenta lo que consume cada     │
-- │   tanda (ver prod/existencias.js): stock_actual puede quedar negativo.     │
-- │ · rinv.movimientos es el kardex: inalterable (triggers), idempotente por   │
-- │   cliente_id.                                                              │
-- └────────────────────────────────────────────────────────────────────────────┘
-- ════════════════════════════════════════════════════════════════════════════

create schema if not exists rinv;

-- ─── Insumos de fábrica (materia prima) ─────────────────────────────────────
create table rinv.insumos_fab (
  id                   uuid primary key default gen_random_uuid(),
  empresa_id           uuid not null references core.empresas(id),
  nombre               text not null,
  descripcion          text,
  tipo                 text not null default 'local' check (tipo in ('mec3', 'local')),
  part_number          text,
  unidad               text not null default 'unidad',
  categoria            text,
  codigo_barras        text,
  stock_actual         numeric(14,2),                 -- null = «sin cargar» (no es lo mismo que 0)
  stock_actualizado_en timestamptz,
  stock_minimo         numeric(14,2) check (stock_minimo is null or stock_minimo >= 0),
  stock_maximo         numeric(14,2) check (stock_maximo is null or stock_maximo >= 0),
  es_equipo            boolean not null default false,
  peso_unitario        numeric(12,4) check (peso_unitario is null or peso_unitario > 0),
  activo               boolean not null default true,
  created_at           timestamptz not null default now(),
  unique (empresa_id, nombre)
);
create index insumos_fab_empresa_idx on rinv.insumos_fab (empresa_id) where activo;
create index insumos_fab_pn_idx on rinv.insumos_fab (empresa_id, part_number) where part_number is not null;
create unique index insumos_fab_barras_uq on rinv.insumos_fab (empresa_id, codigo_barras) where codigo_barras is not null and activo;

-- Precios: solo se agrega (permite reconstruir «cuál era el precio vigente» en cualquier fecha).
create table rinv.precios_fab (
  id                uuid primary key default gen_random_uuid(),
  n                 bigint generated always as identity,
  empresa_id        uuid not null references core.empresas(id),
  insumo_id         uuid not null references rinv.insumos_fab(id) on delete cascade,
  fecha_vigencia    date not null,
  lps_kg            numeric(14,4) not null check (lps_kg >= 0),
  usd_kg            numeric(14,4),
  tipo_cambio_usado numeric(10,4),
  fuente            text not null check (fuente in ('factura_mec3', 'manual')),
  factura_ref       text,
  created_at        timestamptz not null default now()
);
create index precios_fab_vigente_idx on rinv.precios_fab (insumo_id, fecha_vigencia desc, n desc);

-- ─── Lotes Mec3 (entrada con fecha → vence al año; salidas FIFO) ────────────
create table rinv.lotes_mec3 (
  id                uuid primary key default gen_random_uuid(),
  n                 bigint generated always as identity,
  empresa_id        uuid not null references core.empresas(id),
  insumo_id         uuid not null references rinv.insumos_fab(id),
  cantidad_inicial  numeric(14,3) not null check (cantidad_inicial > 0),
  cantidad_restante numeric(14,3) not null check (cantidad_restante >= 0),
  fecha_ingreso     date not null,
  fecha_vencimiento date not null,
  motivo            text,
  created_at        timestamptz not null default now()
);
create index lotes_mec3_insumo_idx on rinv.lotes_mec3 (insumo_id, fecha_ingreso, n);
create index lotes_mec3_venc_idx on rinv.lotes_mec3 (empresa_id, fecha_vencimiento) where cantidad_restante > 0;

-- De qué lote salió material y qué día (trazabilidad hacia adelante).
create table rinv.salida_lotes (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references core.empresas(id),
  lote_id    uuid not null references rinv.lotes_mec3(id),
  insumo_id  uuid not null references rinv.insumos_fab(id),
  cantidad   numeric(14,3) not null check (cantidad > 0),
  fecha      date not null,
  motivo     text,
  created_at timestamptz not null default now()
);
create index salida_lotes_lote_idx on rinv.salida_lotes (lote_id);
create index salida_lotes_fecha_idx on rinv.salida_lotes (empresa_id, fecha);

-- ─── Existencias por sucursal (vasos, servilletas, limpieza…) ───────────────
-- El catálogo es rep.insumos_catalogo (R1); aquí solo la cantidad física de cada insumo en CADA sucursal.
create table rinv.stock_suc (
  empresa_id     uuid not null references core.empresas(id),
  sucursal_id    uuid not null references core.sucursales(id),
  insumo_id      uuid not null references rep.insumos_catalogo(id),
  cantidad       numeric(14,2) not null default 0,
  actualizado_en timestamptz not null default now(),
  primary key (sucursal_id, insumo_id)
);

-- ─── Kardex: un renglón por cada movimiento real. Inalterable. ─────────────
create table rinv.movimientos (
  id               uuid primary key default gen_random_uuid(),
  n                bigint generated always as identity,
  empresa_id       uuid not null references core.empresas(id),
  ambito           text not null check (ambito in ('fabrica', 'sucursal')),
  sucursal_id      uuid references core.sucursales(id),
  insumo_fab_id    uuid references rinv.insumos_fab(id),
  insumo_suc_id    uuid references rep.insumos_catalogo(id),
  tipo             text not null check (tipo in ('entrada', 'salida')),
  cantidad         numeric(14,4) not null check (cantidad > 0),
  saldo_resultante numeric(14,2) not null,
  motivo           text,
  rol              text,
  usuario_id       uuid references core.usuarios(id),
  usuario_nombre   text,
  cliente_id       text,          -- id que genera el celular por acción: permite reintentar sin duplicar
  created_at       timestamptz not null default now(),
  check ((ambito = 'fabrica'  and insumo_fab_id is not null and insumo_suc_id is null and sucursal_id is null)
      or (ambito = 'sucursal' and insumo_suc_id is not null and insumo_fab_id is null and sucursal_id is not null))
);
create index movimientos_fab_idx on rinv.movimientos (insumo_fab_id, n desc) where insumo_fab_id is not null;
create index movimientos_suc_idx on rinv.movimientos (sucursal_id, insumo_suc_id, n desc) where insumo_suc_id is not null;
create index movimientos_fecha_idx on rinv.movimientos (empresa_id, created_at);
create unique index movimientos_cliente_uq on rinv.movimientos (empresa_id, cliente_id) where cliente_id is not null;

create function rinv.solo_agregar() returns trigger language plpgsql as $$
begin
  raise exception 'Este registro es inalterable: no se permite % en %', tg_op, tg_table_name;
end $$;

create trigger movimientos_sin_cambios before update or delete on rinv.movimientos
  for each row execute function rinv.solo_agregar();
create trigger movimientos_sin_truncate before truncate on rinv.movimientos
  for each statement execute function rinv.solo_agregar();
create trigger precios_sin_cambios before update or delete on rinv.precios_fab
  for each row execute function rinv.solo_agregar();
create trigger salida_lotes_sin_cambios before update or delete on rinv.salida_lotes
  for each row execute function rinv.solo_agregar();

-- ─── RFID (lector UHF en freezers) ──────────────────────────────────────────
-- Códigos numéricos pequeños para meter ids en el EPC de 96 bits: cada sabor, insumo,
-- tanda o lote que se graba en un chip recibe un número estable (el EPC no cabe un uuid).
create table rinv.rfid_refs (
  codigo     bigint generated always as identity primary key,
  empresa_id uuid not null references core.empresas(id),
  tipo       text not null check (tipo in ('sabor', 'insumo', 'tanda', 'lote', 'bandeja')),
  ref_id     uuid not null,
  unique (empresa_id, tipo, ref_id)
);

-- Dónde se puede encontrar un tag: una SECCIÓN de un freezer. orden_salida: 0 = junto a la puerta.
create table rinv.rfid_ubicaciones (
  id           uuid primary key default gen_random_uuid(),
  empresa_id   uuid not null references core.empresas(id),
  freezer      text not null,
  nombre       text not null,
  orden_salida int not null default 0 check (orden_salida between 0 and 99),
  activa       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (empresa_id, nombre)
);

-- Un tag FÍSICO. El id es estable aunque el chip se reescriba (el EPC cambia, el tag no).
-- estados: nuevo (leído, nunca grabado por nosotros) · disponible · asignado · baja.
create table rinv.rfid_tags (
  id                uuid primary key default gen_random_uuid(),
  empresa_id        uuid not null references core.empresas(id),
  epc               text not null check (epc ~ '^[0-9A-F]+$' and length(epc) >= 8),
  tid               text,
  estado            text not null default 'nuevo' check (estado in ('nuevo', 'disponible', 'asignado', 'baja')),
  produccion_id     uuid,                                   -- tanda (rep.producciones): referencia blanda
  lote_mec3_id      uuid references rinv.lotes_mec3(id),
  sabor_id          uuid,                                   -- sabor (rep.sabores): referencia blanda
  insumo_id         uuid references rinv.insumos_fab(id),
  etiqueta          text,
  ubicacion_id      uuid references rinv.rfid_ubicaciones(id),
  ubicacion_desde   timestamptz,
  ultima_lectura_en timestamptz,
  faltas_seguidas   int not null default 0,
  ciclos            int not null default 0,
  epc_pendiente     text check (epc_pendiente is null or (epc_pendiente ~ '^[0-9A-F]+$' and length(epc_pendiente) = 24)),
  pendiente_hasta   timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (not (produccion_id is not null and lote_mec3_id is not null)),
  check (estado = 'asignado' or (produccion_id is null and lote_mec3_id is null))
);
create unique index rfid_tags_epc_uq on rinv.rfid_tags (empresa_id, epc);
create unique index rfid_tags_tid_uq on rinv.rfid_tags (empresa_id, tid) where tid is not null;
create index rfid_tags_ubicacion_idx on rinv.rfid_tags (ubicacion_id);

-- Historia de cada tag: solo cambios y hechos, nunca cada lectura.
create table rinv.rfid_eventos (
  id           uuid primary key default gen_random_uuid(),
  n            bigint generated always as identity,
  empresa_id   uuid not null references core.empresas(id),
  tag_id       uuid not null references rinv.rfid_tags(id) on delete cascade,
  evento       text not null check (evento in ('registrado', 'grabado', 'grabacion_fallida', 'asignado', 'liberado', 'movido', 'ubicado', 'no_detectado', 'baja')),
  epc          text,
  ubicacion_id uuid references rinv.rfid_ubicaciones(id),
  detalle      text,
  rol          text,
  created_at   timestamptz not null default now()
);
create index rfid_eventos_tag_idx on rinv.rfid_eventos (tag_id, n desc);

-- Cada pasada de auditoría sobre una sección: qué se esperaba, qué se vio.
create table rinv.rfid_auditorias (
  id           uuid primary key default gen_random_uuid(),
  empresa_id   uuid not null references core.empresas(id),
  ubicacion_id uuid not null references rinv.rfid_ubicaciones(id),
  detectados   int not null,
  esperados    int not null,
  faltantes    int not null,
  equivocados  int not null,
  desconocidos int not null,
  resultado    jsonb not null default '{}'::jsonb,
  rol          text,
  usuario_id   uuid references core.usuarios(id),
  created_at   timestamptz not null default now()
);
create index rfid_auditorias_idx on rinv.rfid_auditorias (empresa_id, created_at desc);

-- ─── Incidencias de calidad (con foto) ──────────────────────────────────────
create table rinv.incidencias (
  id            uuid primary key default gen_random_uuid(),
  numero        bigint generated always as identity,
  empresa_id    uuid not null references core.empresas(id),
  tipo          text not null check (tipo in ('producto', 'equipo', 'temperatura', 'higiene', 'otro')),
  gravedad      text not null default 'media' check (gravedad in ('baja', 'media', 'alta')),
  sucursal_id   uuid references core.sucursales(id),      -- null = pasó en fábrica
  produccion_id uuid,                                      -- tanda (rep.producciones): referencia blanda
  lote_id       uuid references rinv.lotes_mec3(id),
  sabor_id      uuid,                                      -- sabor (rep.sabores): referencia blanda
  descripcion   text not null,
  reportado_por text,
  rol           text,
  usuario_id    uuid references core.usuarios(id),
  estado        text not null default 'abierta' check (estado in ('abierta', 'en_revision', 'cerrada')),
  resolucion    text,
  cerrado_por   text,
  cerrado_en    timestamptz,
  created_at    timestamptz not null default now()
);
create index incidencias_estado_idx on rinv.incidencias (empresa_id, estado, created_at desc);
create index incidencias_prod_idx on rinv.incidencias (produccion_id) where produccion_id is not null;
create index incidencias_lote_idx on rinv.incidencias (lote_id) where lote_id is not null;

-- Las fotos van aparte para que listar incidencias no arrastre las imágenes. Tope: 400 KB cada una
-- (el celular las reduce antes de subirlas).
create table rinv.incidencia_fotos (
  id            uuid primary key default gen_random_uuid(),
  n             bigint generated always as identity,
  empresa_id    uuid not null references core.empresas(id),
  incidencia_id uuid not null references rinv.incidencias(id) on delete cascade,
  imagen        bytea not null check (octet_length(imagen) between 1 and 409600),
  mime          text not null default 'image/jpeg',
  created_at    timestamptz not null default now()
);
create index incidencia_fotos_idx on rinv.incidencia_fotos (incidencia_id, n);

-- ─── Mantenimiento: lista de equipos dañados ────────────────────────────────
create table rinv.mantenimientos (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references core.empresas(id),
  equipo      text not null check (length(trim(equipo)) >= 2),
  descripcion text,
  sucursal_id uuid references core.sucursales(id),         -- null = anotación vieja de «fábrica»
  fecha       date not null,
  listo       boolean not null default false,
  resuelto_en timestamptz,
  usuario_id  uuid references core.usuarios(id),
  created_at  timestamptz not null default now()
);
create index mantenimientos_idx on rinv.mantenimientos (empresa_id, listo, fecha);

-- ─── Checklist de apertura y cierre de tienda ───────────────────────────────
-- (En el original está «en pausa»: sin pantalla, pero con tablas y catálogo; se conserva igual.)
create table rinv.checklist_catalogo (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references core.empresas(id),
  momento    text not null check (momento in ('apertura', 'cierre')),
  texto      text not null,
  orden      int not null default 0,
  activo     boolean not null default true
);
create index checklist_catalogo_idx on rinv.checklist_catalogo (empresa_id, momento, orden);

create table rinv.checklist_registros (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references core.empresas(id),
  sucursal_id uuid not null references core.sucursales(id),
  fecha       date not null,
  momento     text not null check (momento in ('apertura', 'cierre')),
  item_id     uuid not null references rinv.checklist_catalogo(id) on delete cascade,
  ok          boolean not null default false,
  nota        text,
  empleado_id uuid,                                         -- rrhh.empleados (referencia blanda)
  usuario_id  uuid references core.usuarios(id),
  created_at  timestamptz not null default now(),
  unique (sucursal_id, fecha, momento, item_id)
);
create index checklist_registros_idx on rinv.checklist_registros (empresa_id, fecha, sucursal_id);

-- ─── RLS cerrada por defecto: solo el API (rol postgres) entra ──────────────
alter table rinv.insumos_fab           enable row level security;
alter table rinv.precios_fab           enable row level security;
alter table rinv.lotes_mec3            enable row level security;
alter table rinv.salida_lotes          enable row level security;
alter table rinv.stock_suc             enable row level security;
alter table rinv.movimientos           enable row level security;
alter table rinv.rfid_refs             enable row level security;
alter table rinv.rfid_ubicaciones      enable row level security;
alter table rinv.rfid_tags             enable row level security;
alter table rinv.rfid_eventos          enable row level security;
alter table rinv.rfid_auditorias       enable row level security;
alter table rinv.incidencias           enable row level security;
alter table rinv.incidencia_fotos      enable row level security;
alter table rinv.mantenimientos        enable row level security;
alter table rinv.checklist_catalogo    enable row level security;
alter table rinv.checklist_registros   enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke update, delete, truncate on rinv.movimientos, rinv.precios_fab, rinv.salida_lotes from anon, authenticated, service_role';
  end if;
end $$;
