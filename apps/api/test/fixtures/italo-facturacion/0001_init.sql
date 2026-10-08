-- Esquema inicial: sistema de facturación fiscal Italo Gelateria
-- Fase 1 del proyecto (esquema + auth). No fija CAI real todavía: los puntos_emision
-- se crean en modo borrador (es_borrador = true, cai = null) hasta que el contador
-- confirme los datos del SAR (ver preguntas 1 y 3 del entregable).

create extension if not exists "pgcrypto";

create type rol_usuario as enum ('admin', 'manager', 'cajero');
create type estado_venta as enum ('abierta', 'pagada', 'anulada', 'borrador');
create type tipo_orden_venta as enum ('restaurante', 'para_llevar');
create type estado_cierre as enum ('abierto', 'cerrado');
create type estado_nota_credito as enum ('emitida', 'anulada');

-- ─────────────────────────────────────────────────────────────────────────
-- Sucursales
-- ─────────────────────────────────────────────────────────────────────────
create table sucursales (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  alias text not null unique,
  direccion text not null,
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- Puntos de emisión: CAI + rango de correlativos por sucursal.
-- Mientras no haya CAI confirmado por el SAR, es_borrador = true y cai = null:
-- el sistema sigue asignando correlativo interno pero la factura se marca
-- como documento sin validez fiscal (ver preguntas 1 y 3).
-- ─────────────────────────────────────────────────────────────────────────
create table puntos_emision (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references sucursales(id),
  punto_emision_codigo text not null,
  punto_venta_codigo text not null,
  tipo_documento_codigo text not null default '01',
  cai text,
  correlativo_desde bigint not null,
  correlativo_hasta bigint not null,
  correlativo_actual bigint not null,
  fecha_limite_emision date,
  es_borrador boolean not null default true,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  constraint rango_valido check (correlativo_hasta >= correlativo_desde),
  constraint correlativo_en_rango check (
    correlativo_actual >= correlativo_desde and correlativo_actual <= correlativo_hasta + 1
  )
);
create unique index puntos_emision_sucursal_activo_idx on puntos_emision(sucursal_id) where activo;

-- ─────────────────────────────────────────────────────────────────────────
-- Perfiles (usuarios ligados a Supabase Auth)
-- ─────────────────────────────────────────────────────────────────────────
create table perfiles (
  id uuid primary key references auth.users(id) on delete cascade,
  sucursal_id uuid references sucursales(id),
  nombre text not null,
  rol rol_usuario not null default 'cajero',
  cierre_ciego boolean not null default false,
  sin_horario boolean not null default false,
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- Catálogo: categorías y productos
-- ─────────────────────────────────────────────────────────────────────────
create table categorias (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  orden int not null default 0,
  activo boolean not null default true
);

create table productos (
  id uuid primary key default gen_random_uuid(),
  codigo text unique,
  nombre text not null,
  categoria_id uuid references categorias(id),
  precio numeric(12, 2) not null check (precio >= 0),
  impuesto1_tasa numeric(5, 4) not null default 0.15,
  impuesto2_tasa numeric(5, 4) not null default 0,
  impuesto3_tasa numeric(5, 4) not null default 0,
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- Clientes
-- ─────────────────────────────────────────────────────────────────────────
create table clientes (
  id uuid primary key default gen_random_uuid(),
  nombre text not null default 'Consumidor Final',
  rtn text,
  direccion text,
  telefono text,
  email text,
  exento_impuestos boolean not null default false,
  es_consumidor_final boolean not null default false,
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- Formas de pago
-- ─────────────────────────────────────────────────────────────────────────
create table formas_pago (
  id uuid primary key default gen_random_uuid(),
  nombre text not null unique
);

-- ─────────────────────────────────────────────────────────────────────────
-- Ventas (cabecera de factura) y detalle
-- ─────────────────────────────────────────────────────────────────────────
create table ventas (
  id uuid primary key default gen_random_uuid(),
  numero_orden bigint not null,
  sucursal_id uuid not null references sucursales(id),
  punto_emision_id uuid references puntos_emision(id),
  numero_factura text,
  correlativo bigint,
  cliente_id uuid references clientes(id),
  cajero_id uuid references perfiles(id),
  tipo_orden tipo_orden_venta,
  estado estado_venta not null default 'abierta',
  subtotal_exento numeric(12, 2) not null default 0,
  subtotal_exonerado numeric(12, 2) not null default 0,
  subtotal_gravado_15 numeric(12, 2) not null default 0,
  descuento numeric(12, 2) not null default 0,
  isv_total numeric(12, 2) not null default 0,
  total numeric(12, 2) not null default 0,
  efectivo_recibido numeric(12, 2),
  cambio numeric(12, 2),
  fecha_emision timestamptz,
  created_at timestamptz not null default now()
);
create index ventas_sucursal_fecha_idx on ventas(sucursal_id, fecha_emision);
create unique index ventas_numero_factura_idx on ventas(numero_factura) where numero_factura is not null;

create table detalle_venta (
  id uuid primary key default gen_random_uuid(),
  venta_id uuid not null references ventas(id) on delete cascade,
  producto_id uuid references productos(id),
  nombre_producto text not null,
  cantidad numeric(12, 3) not null check (cantidad > 0),
  precio_unitario numeric(12, 2) not null,
  descuento numeric(12, 2) not null default 0,
  impuesto_tasa numeric(5, 4) not null default 0.15,
  monto numeric(12, 2) not null
);

create table venta_pagos (
  id uuid primary key default gen_random_uuid(),
  venta_id uuid not null references ventas(id) on delete cascade,
  forma_pago_id uuid not null references formas_pago(id),
  monto numeric(12, 2) not null check (monto > 0)
);

-- ─────────────────────────────────────────────────────────────────────────
-- Cierres de caja
-- ─────────────────────────────────────────────────────────────────────────
create table cierres_caja (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references sucursales(id),
  cajero_id uuid references perfiles(id),
  elaboro_id uuid references perfiles(id),
  fecha_inicio timestamptz not null,
  fecha_fin timestamptz not null,
  efectivo_contado numeric(12, 2),
  fondo_caja numeric(12, 2) not null default 0,
  salidas numeric(12, 2) not null default 0,
  propinas numeric(12, 2) not null default 0,
  descuentos numeric(12, 2) not null default 0,
  factura_desde text,
  factura_hasta text,
  total_esperado numeric(12, 2),
  total_contado numeric(12, 2),
  diferencia numeric(12, 2),
  cierre_ciego boolean not null default false,
  estado estado_cierre not null default 'abierto',
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- Notas de crédito / anulaciones
-- ─────────────────────────────────────────────────────────────────────────
create table notas_credito (
  id uuid primary key default gen_random_uuid(),
  venta_id uuid not null references ventas(id),
  numero_nota text,
  motivo text not null,
  usuario_id uuid references perfiles(id),
  monto numeric(12, 2) not null,
  estado estado_nota_credito not null default 'emitida',
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- Caja chica (fase posterior; tabla incluida desde ya en el esquema)
-- ─────────────────────────────────────────────────────────────────────────
create table caja_chica (
  id uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references sucursales(id),
  tipo text not null,
  monto numeric(12, 2) not null,
  concepto text,
  usuario_id uuid references perfiles(id),
  fecha date not null default current_date
);

-- ─────────────────────────────────────────────────────────────────────────
-- RLS: el backend usa la service_role key (bypassa RLS) para toda la
-- lógica de negocio. Estas policies son defensa en profundidad para el uso
-- futuro de clientes autenticados directos contra Supabase.
-- ─────────────────────────────────────────────────────────────────────────
alter table sucursales enable row level security;
alter table puntos_emision enable row level security;
alter table perfiles enable row level security;
alter table categorias enable row level security;
alter table productos enable row level security;
alter table clientes enable row level security;
alter table formas_pago enable row level security;
alter table ventas enable row level security;
alter table detalle_venta enable row level security;
alter table venta_pagos enable row level security;
alter table cierres_caja enable row level security;
alter table notas_credito enable row level security;
alter table caja_chica enable row level security;

create policy "perfiles: usuario ve su propio perfil"
  on perfiles for select
  using (id = auth.uid());

create policy "catalogo: lectura para autenticados"
  on categorias for select to authenticated using (true);
create policy "productos: lectura para autenticados"
  on productos for select to authenticated using (true);
create policy "sucursales: lectura para autenticados"
  on sucursales for select to authenticated using (true);
create policy "formas_pago: lectura para autenticados"
  on formas_pago for select to authenticated using (true);

-- ─────────────────────────────────────────────────────────────────────────
-- Seed mínimo
-- ─────────────────────────────────────────────────────────────────────────
insert into clientes (nombre, es_consumidor_final, exento_impuestos)
values ('Consumidor Final', true, false);

insert into formas_pago (nombre) values ('Efectivo'), ('Tarjeta'), ('Transferencia');

insert into sucursales (nombre, alias, direccion) values
  ('Inversiones Milano S de R.L. - Los Andes', 'los_andes', 'Los Andes, San Pedro Sula'),
  ('Inversiones Milano S de R.L. - 10 Calle', '10_calle_express', '10 Calle, San Pedro Sula'),
  ('Inversiones Milano S de R.L. - Mackey', 'mackey', 'Mackey, San Pedro Sula'),
  ('Inversiones Milano S de R.L. - Próceres', 'proceres', 'Próceres, San Pedro Sula');

-- Un punto de emisión "borrador" por sucursal: sin CAI, correlativo interno
-- arrancando en 1. Reemplazar cai/correlativo_desde/correlativo_hasta/
-- fecha_limite_emision en cuanto el contador confirme los datos del SAR.
insert into puntos_emision (
  sucursal_id, punto_emision_codigo, punto_venta_codigo, tipo_documento_codigo,
  cai, correlativo_desde, correlativo_hasta, correlativo_actual, fecha_limite_emision, es_borrador
)
select id, '001', '001', '01', null, 1, 99999999, 1, null, true
from sucursales;
