-- ════════════════════════════════════════════════════════════════════════════
-- 0015 · ECO — lado COMERCIAL de EcoStone (catálogo de piedra, listas de precio,
--         cotizaciones de proyecto, cobros/anticipos). Portado de la app original
--         «EcoStone Facturación» (migraciones 0014, 0015 y 0020).
--
-- La piedra es un producto de pos.productos (es_piedra, modelo, color, unidad_venta,
-- m2_por_caja, piezas_por_m2, costo_estandar: columnas declaradas en 0014_fab.sql).
-- Lo que no cabe ahí (tipo de producto, peso, rendimiento) vive en eco.producto_ext.
-- El inventario (fab.lotes) y las funciones fab.reservar/liberar/consumir son de F2.
-- ════════════════════════════════════════════════════════════════════════════
create schema if not exists eco;

-- Por si 0014 no declaró algo (idempotente)
alter table pos.productos
  add column if not exists es_piedra      boolean not null default false,
  add column if not exists modelo         text,
  add column if not exists unidad_venta   text,
  add column if not exists m2_por_caja    numeric(10,4),
  add column if not exists piezas_por_m2  numeric(10,3),
  add column if not exists costo_estandar numeric(14,4) not null default 0;

create table eco.producto_ext (
  producto_id    uuid primary key references pos.productos(id) on delete cascade,
  empresa_id     uuid not null references core.empresas(id),
  tipo           text not null default 'piedra' check (tipo in ('piedra','accesorio','servicio','otro')),
  peso_kg_m2     numeric(10,2),
  rendimiento_m2 numeric(10,3)            -- accesorios: m² que cubre una unidad
);
create index eco_producto_ext_idx on eco.producto_ext (empresa_id, tipo);

-- ─── Listas de precio (Público trae ISV incluido; las demás, ISV aparte) ────
create table eco.listas_precio (
  id           uuid primary key default gen_random_uuid(),
  empresa_id   uuid not null references core.empresas(id),
  nombre       text not null,
  isv_incluido boolean not null default false,
  orden        int not null default 0,
  activo       boolean not null default true,
  unique (empresa_id, nombre)
);
create table eco.precios_producto (
  producto_id uuid not null references pos.productos(id) on delete cascade,
  lista_id    uuid not null references eco.listas_precio(id) on delete cascade,
  precio      numeric(14,4) not null check (precio >= 0),
  primary key (producto_id, lista_id)
);

create table eco.zonas_flete (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references core.empresas(id),
  nombre     text not null,
  tarifa     numeric(12,2) not null default 0,
  activo     boolean not null default true,
  unique (empresa_id, nombre)
);

-- Datos comerciales del cliente (la ficha común sigue siendo core.terceros)
create table eco.cliente_ext (
  tercero_id      uuid primary key references core.terceros(id) on delete cascade,
  tipo_cliente    text not null default 'final' check (tipo_cliente in ('final','constructora','arquitecto','instalador','ferreteria','distribuidor')),
  lista_precio_id uuid references eco.listas_precio(id),
  limite_credito  numeric(12,2) not null default 0,
  dias_credito    int not null default 0
);

-- ─── Cotizaciones de proyecto ───────────────────────────────────────────────
create table eco.contador (
  empresa_id uuid primary key references core.empresas(id),
  ultimo     bigint not null default 1000
);
create function eco.siguiente_numero(p_empresa uuid) returns bigint language sql as $$
  insert into eco.contador (empresa_id, ultimo) values (p_empresa, 1001)
  on conflict (empresa_id) do update set ultimo = eco.contador.ultimo + 1
  returning ultimo;
$$;

create table eco.cotizaciones (
  id              uuid primary key default gen_random_uuid(),
  empresa_id      uuid not null references core.empresas(id),
  numero          bigint not null,
  estado          text not null default 'borrador' check (estado in ('borrador','enviada','aprobada','rechazada','vencida','facturada','anulada')),
  cliente_id      uuid references core.terceros(id),
  nombre_cliente  text not null,
  rtn_cliente     text,
  telefono        text,
  email           text,
  proyecto        text not null default '',
  direccion_obra  text,
  lista_precio_id uuid references eco.listas_precio(id),
  isv_incluido    boolean not null default false,
  vigencia_dias   int not null default 15,
  fecha_vigencia  date,
  descuento       numeric(12,2) not null default 0,
  descuento_pct   numeric(5,2) not null default 0 check (descuento_pct >= 0 and descuento_pct <= 100),
  subtotal        numeric(14,2) not null default 0,
  isv             numeric(14,2) not null default 0,
  total           numeric(14,2) not null default 0,
  anticipo_pct    numeric(5,2) not null default 0,
  entrega         text not null default 'retira' check (entrega in ('retira','despacho')),
  fecha_entrega   date,
  aprobada_at     timestamptz,
  aprobada_por    uuid references core.usuarios(id),
  venta_id        uuid references pos.ventas(id),
  vendedor_id     uuid references core.usuarios(id),
  sucursal_id     uuid references core.sucursales(id),
  notas           text,
  motivo_cierre   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (empresa_id, numero)
);
create index eco_cot_estado_idx on eco.cotizaciones (empresa_id, estado, created_at desc);

create table eco.cotizacion_lineas (
  id              uuid primary key default gen_random_uuid(),
  cotizacion_id   uuid not null references eco.cotizaciones(id) on delete cascade,
  orden           int not null default 0,
  tipo            text not null default 'producto' check (tipo in ('producto','accesorio','flete','instalacion','otro')),
  producto_id     uuid references pos.productos(id),
  descripcion     text not null,
  unidad          text not null default 'm2',
  m2_neto         numeric(12,3),
  desperdicio_pct numeric(5,2) not null default 0,
  cajas           numeric(12,3),
  cantidad        numeric(12,3) not null check (cantidad > 0),   -- unidades vendidas (m² ya redondeados a cajas)
  precio_unitario numeric(14,4) not null check (precio_unitario >= 0),
  descuento_pct   numeric(5,2) not null default 0,
  isv_tasa        numeric(5,4) not null default 0.15,
  monto           numeric(14,2) not null default 0,              -- total de la línea con ISV
  costo_unitario  numeric(14,4) not null default 0
);
create index eco_cot_lineas_idx on eco.cotizacion_lineas (cotizacion_id, orden);

create table eco.cotizacion_pagos (
  id            uuid primary key default gen_random_uuid(),
  cotizacion_id uuid not null references eco.cotizaciones(id) on delete cascade,
  tipo          text not null default 'pago' check (tipo in ('anticipo','pago')),
  forma_pago_id uuid not null references pos.formas_pago(id),
  monto         numeric(14,2) not null check (monto > 0),
  referencia    text,
  usuario_id    uuid references core.usuarios(id),
  created_at    timestamptz not null default now()
);
create index eco_cot_pagos_idx on eco.cotizacion_pagos (cotizacion_id);

alter table eco.producto_ext       enable row level security;
alter table eco.listas_precio      enable row level security;
alter table eco.precios_producto   enable row level security;
alter table eco.zonas_flete        enable row level security;
alter table eco.cliente_ext        enable row level security;
alter table eco.contador           enable row level security;
alter table eco.cotizaciones       enable row level security;
alter table eco.cotizacion_lineas  enable row level security;
alter table eco.cotizacion_pagos   enable row level security;

-- ─── Semillas de EcoStone ───────────────────────────────────────────────────
insert into eco.listas_precio (empresa_id, nombre, isv_incluido, orden)
select e.id, l.nombre, l.inc, l.orden from core.empresas e,
  (values ('Público', true, 1), ('Contratista', false, 2), ('Distribuidor', false, 3)) as l(nombre, inc, orden)
 where e.codigo = 'ecostone';

insert into pos.categorias (empresa_id, nombre, orden)
select e.id, c.nombre, c.orden from core.empresas e,
  (values ('Piedra', 1), ('Accesorios', 2), ('Servicios', 3)) as c(nombre, orden)
 where e.codigo = 'ecostone'
on conflict (empresa_id, nombre) do nothing;

-- Parámetros comerciales (valores de la app original)
insert into core.config (empresa_id, clave, valor)
select e.id, 'eco', jsonb_build_object(
  'desperdicio_default_pct', 0, 'vigencia_cotizacion_dias', 15, 'anticipo_pct_default', 0,
  'descuento_max_vendedor_pct', 5, 'descuento_max_gerente_pct', 15)
from core.empresas e where e.codigo = 'ecostone'
on conflict (empresa_id, clave) do nothing;
