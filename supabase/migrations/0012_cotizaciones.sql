-- ════════════════════════════════════════════════════════════════════════════
-- 0012 · Cotizaciones y eventos (módulo `cotizaciones`, hoy solo Italo)
--   Portado de italo-facturacion (0004_cotizaciones_eventos + 0015_calendario_eventos):
--   copitas + servicio − descuento, estados, anticipo, calendario con lista de
--   control, y conversión a factura. Se suman PARTIDAS libres (carrito, toppings…).
--   Todo cuelga de empresa_id; el número de cotización es por empresa.
-- ════════════════════════════════════════════════════════════════════════════
create schema if not exists cot;

create table cot.cotizaciones (
  id               uuid primary key default gen_random_uuid(),
  empresa_id       uuid not null references core.empresas(id),
  numero           bigint not null,
  sucursal_id      uuid references core.sucursales(id),       -- sucursal que atiende el evento
  cliente_id       uuid references core.terceros(id),         -- se enlaza al facturar
  nombre_cliente   text not null,
  telefono_cliente text,
  email_cliente    text,
  rtn_cliente      text,
  nombre_evento    text not null,
  fecha_evento     date,
  hora_evento      time,
  lugar            text,
  cantidad_copitas int not null default 0 check (cantidad_copitas >= 0),
  precio_copita    numeric(12,2) not null default 0 check (precio_copita >= 0),
  costo_servicio   numeric(12,2) not null default 0 check (costo_servicio >= 0),
  descuento        numeric(12,2) not null default 0 check (descuento >= 0),
  anticipo         numeric(12,2) not null default 0 check (anticipo >= 0),
  notas            text,
  notas_seguimiento text,
  estado           text not null default 'borrador' check (estado in ('borrador','enviada','aceptada','rechazada','facturada')),
  checklist        jsonb not null default '{}'::jsonb,
  realizado        boolean not null default false,
  aceptada_at      timestamptz,
  enviada_at       timestamptz,
  venta_id         uuid references pos.ventas(id),
  usuario_id       uuid references core.usuarios(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (empresa_id, numero)
);
create index cotizaciones_empresa_fecha_idx on cot.cotizaciones (empresa_id, fecha_evento);
create index cotizaciones_empresa_estado_idx on cot.cotizaciones (empresa_id, estado);

-- Partidas libres además de copitas y servicio (ej. "Carrito de gelato", "Toppings extra").
create table cot.partidas (
  id              uuid primary key default gen_random_uuid(),
  cotizacion_id   uuid not null references cot.cotizaciones(id) on delete cascade,
  descripcion     text not null,
  cantidad        numeric(12,3) not null default 1 check (cantidad > 0),
  precio_unitario numeric(12,2) not null default 0 check (precio_unitario >= 0),
  orden           int not null default 0
);
create index partidas_cotizacion_idx on cot.partidas (cotizacion_id);

-- Número correlativo por empresa (se toma dentro de la transacción de creación).
create table cot.contador (
  empresa_id uuid primary key references core.empresas(id),
  ultimo     bigint not null default 0
);
create function cot.siguiente_numero(p_empresa uuid) returns bigint language sql as $$
  insert into cot.contador (empresa_id, ultimo) values (p_empresa, 1)
  on conflict (empresa_id) do update set ultimo = cot.contador.ultimo + 1
  returning ultimo;
$$;

alter table cot.cotizaciones enable row level security;
alter table cot.partidas     enable row level security;
alter table cot.contador     enable row level security;
