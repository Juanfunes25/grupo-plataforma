-- ════════════════════════════════════════════════════════════════════════════
-- 0060 · COMPRAS Y PROVEEDORES + FINANZAS DEL GRUPO (mejoras 16 y 17)
--
-- COMPRAS (esquema cmp)
--   cmp.ordenes / orden_lineas      orden de compra por empresa: borrador → enviada → recibida
--                                   parcial/total → cerrada (o anulada). Moneda L o US$ con tipo de cambio editable.
--   cmp.recepciones / lineas        cada entrega física (parcial o total) con su factura y tipo de cambio del día.
--   cmp.pagos                       pagos al proveedor (alimenta cuentas por pagar).
--   cmp.precios                     historial de precios por proveedor e ítem. SOLO SE AGREGA (trigger).
--
--   PUNTO DE INTEGRACIÓN CON INVENTARIO (sin duplicar lógica; ver modulos/compras/recepcion.js):
--     inv       → inv.compras + inv.compra_items + inv.ingresar()   (lotes FEFO, costo_actual)
--     fab       → fab.mover_insumo(... 'compra' ...)                (EcoStone: costo PROMEDIO ponderado, USD→L)
--     rinv_fab  → rinv.insumos_fab.stock_actual + kardex + lote Mec3 + rinv.precios_fab (+ prod.costeo_precios por nombre)
--     rep_suc   → rinv.stock_suc + kardex de sucursal               (vasos, servilletas, limpieza…)
--     dis       → dis.mover(... 'compra' ...)                       (DISERCO: costo estándar promedio, sin ISV)
--   Las compras que entran por una orden quedan marcadas con recepcion_id para no contarlas dos veces en el flujo de caja.
--
-- FINANZAS
--   fin.presupuestos   presupuesto mensual por empresa y categoría (o 'ventas').
--   fin.abonos_credito abonos a facturas a crédito (cuentas por cobrar).
--   fin.gastos         + vence / pagado_at   (gastos por pagar → cuentas por pagar)
--   fin.intercompania  + monto_pagado / conciliación con quién y cuándo
-- ════════════════════════════════════════════════════════════════════════════

create schema if not exists cmp;

create table cmp.contador (
  empresa_id uuid primary key references core.empresas(id),
  ultimo     bigint not null default 0
);
create function cmp.siguiente_numero(p_empresa uuid) returns bigint language sql as $$
  insert into cmp.contador (empresa_id, ultimo) values (p_empresa, 1)
  on conflict (empresa_id) do update set ultimo = cmp.contador.ultimo + 1
  returning ultimo;
$$;

create table cmp.ordenes (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references core.empresas(id),
  numero        bigint not null,
  proveedor_id  uuid not null references core.terceros(id),
  sucursal_id   uuid references core.sucursales(id),            -- dónde entra la mercadería (inv / sucursal)
  estado        text not null default 'borrador' check (estado in ('borrador','enviada','recibida_parcial','recibida','cerrada','anulada')),
  moneda        text not null default 'HNL' check (moneda in ('HNL','USD')),
  tipo_cambio   numeric(10,4) not null default 1 check (tipo_cambio > 0),
  fecha         date not null,
  fecha_esperada date,
  condicion     text not null default 'contado' check (condicion in ('contado','credito')),
  dias_credito  int not null default 0 check (dias_credito between 0 and 365),
  isv_pct       numeric(5,2) not null default 0 check (isv_pct in (0, 15, 18)),
  subtotal      numeric(14,2) not null default 0,               -- en la moneda de la orden
  isv           numeric(14,2) not null default 0,
  total         numeric(14,2) not null default 0,
  notas         text,
  enviada_at    timestamptz,
  cerrada_at    timestamptz,
  motivo_cierre text,
  creado_por    uuid references core.usuarios(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (empresa_id, numero)
);
create index cmp_ordenes_estado_idx on cmp.ordenes (empresa_id, estado, fecha desc);
create index cmp_ordenes_prov_idx on cmp.ordenes (proveedor_id);

create table cmp.orden_lineas (
  id                uuid primary key default gen_random_uuid(),
  orden_id          uuid not null references cmp.ordenes(id) on delete cascade,
  orden             int not null default 0,
  origen            text not null check (origen in ('inv','fab','rinv_fab','rep_suc','dis')),
  item_id           uuid not null,                              -- id en la tabla de su origen (sin FK: son 5 catálogos)
  descripcion       text not null,
  unidad            text not null default 'unidad',
  cantidad          numeric(14,3) not null check (cantidad > 0),
  cantidad_recibida numeric(14,3) not null default 0 check (cantidad_recibida >= 0),
  precio_unitario   numeric(14,4) not null check (precio_unitario >= 0)    -- en la moneda de la orden, sin ISV
);
create index cmp_lineas_orden_idx on cmp.orden_lineas (orden_id, orden);

create table cmp.recepciones (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references core.empresas(id),
  orden_id    uuid not null references cmp.ordenes(id),
  fecha       date not null,
  documento   text,                                             -- # de factura / remisión del proveedor
  moneda      text not null,
  tipo_cambio numeric(10,4) not null check (tipo_cambio > 0),   -- el del día de la factura
  subtotal    numeric(14,2) not null default 0,
  isv         numeric(14,2) not null default 0,
  total       numeric(14,2) not null default 0,                 -- moneda de la orden
  total_lps   numeric(14,2) not null default 0,                 -- en lempiras al cambio de la recepción
  vence_pago  date,                                             -- null = contado
  notas       text,
  usuario_id  uuid references core.usuarios(id),
  created_at  timestamptz not null default now()
);
create index cmp_recepciones_orden_idx on cmp.recepciones (orden_id);
create index cmp_recepciones_emp_idx on cmp.recepciones (empresa_id, fecha desc);

create table cmp.recepcion_lineas (
  id              uuid primary key default gen_random_uuid(),
  recepcion_id    uuid not null references cmp.recepciones(id) on delete cascade,
  linea_id        uuid not null references cmp.orden_lineas(id),
  cantidad        numeric(14,3) not null check (cantidad > 0),
  precio_unitario numeric(14,4) not null check (precio_unitario >= 0),   -- el facturado (puede diferir del ordenado)
  costo_lps       numeric(14,4) not null,                                -- precio × tipo de cambio
  vence_at        date
);
create index cmp_rec_lineas_idx on cmp.recepcion_lineas (recepcion_id);

create table cmp.pagos (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references core.empresas(id),
  orden_id    uuid not null references cmp.ordenes(id),
  fecha       date not null,
  monto_lps   numeric(14,2) not null check (monto_lps > 0),
  forma       text,
  referencia  text,
  usuario_id  uuid references core.usuarios(id),
  created_at  timestamptz not null default now()
);
create index cmp_pagos_orden_idx on cmp.pagos (orden_id);
create index cmp_pagos_emp_idx on cmp.pagos (empresa_id, fecha desc);

-- Historial de precios por proveedor: cada recepción y cada cotización manual agrega una fila. Inalterable.
create table cmp.precios (
  id            bigserial primary key,
  empresa_id    uuid not null references core.empresas(id),
  proveedor_id  uuid references core.terceros(id),
  origen        text not null check (origen in ('inv','fab','rinv_fab','rep_suc','dis')),
  item_id       uuid not null,
  descripcion   text not null,
  unidad        text,
  fecha         date not null,
  moneda        text not null default 'HNL' check (moneda in ('HNL','USD')),
  precio        numeric(14,4) not null check (precio >= 0),
  tipo_cambio   numeric(10,4) not null default 1,
  precio_lps    numeric(14,4) not null check (precio_lps >= 0),
  fuente        text not null default 'recepcion' check (fuente in ('recepcion','cotizacion')),
  orden_id      uuid references cmp.ordenes(id),
  recepcion_id  uuid references cmp.recepciones(id),
  documento     text,
  usuario_id    uuid references core.usuarios(id),
  created_at    timestamptz not null default now()
);
create index cmp_precios_item_idx on cmp.precios (empresa_id, origen, item_id, fecha desc, id desc);
create function cmp.precios_solo_agrega() returns trigger language plpgsql as $$
begin
  raise exception 'El historial de precios no se edita ni se borra: agrega un precio nuevo';
end $$;
create trigger cmp_precios_solo_agrega before update or delete on cmp.precios
  for each row execute function cmp.precios_solo_agrega();

alter table cmp.contador          enable row level security;
alter table cmp.ordenes           enable row level security;
alter table cmp.orden_lineas      enable row level security;
alter table cmp.recepciones       enable row level security;
alter table cmp.recepcion_lineas  enable row level security;
alter table cmp.pagos             enable row level security;
alter table cmp.precios           enable row level security;

-- Marca de «esta entrada vino de una orden de compra».
alter table inv.compras       add column recepcion_id uuid;
alter table fab.mov_insumos   add column recepcion_id uuid;
alter table dis.movimientos   add column recepcion_id uuid;

-- ─── Finanzas ───────────────────────────────────────────────────────────────
alter table fin.gastos add column vence date;          -- gasto a crédito (pagado = false): fecha límite de pago
alter table fin.gastos add column pagado_at date;      -- cuándo se pagó

alter table fin.intercompania add column monto_pagado numeric(14,2) not null default 0 check (monto_pagado >= 0);
alter table fin.intercompania add column conciliado_at timestamptz;
alter table fin.intercompania add column conciliado_por uuid references core.usuarios(id);
alter table fin.intercompania add column nota text;

-- Presupuesto mensual: clave = 'ventas' (ventas netas) o el id de la categoría de gasto.
create table fin.presupuestos (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references core.empresas(id),
  mes        date not null check (extract(day from mes) = 1),
  clave      text not null,
  monto      numeric(14,2) not null check (monto >= 0),
  updated_by uuid references core.usuarios(id),
  updated_at timestamptz not null default now(),
  unique (empresa_id, mes, clave)
);

-- Abonos a facturas a crédito (la venta ya está pagada en el sistema con forma de pago tipo «crédito»).
create table fin.abonos_credito (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references core.empresas(id),
  venta_id   uuid not null references pos.ventas(id),
  fecha      date not null,
  monto      numeric(14,2) not null check (monto > 0),
  forma      text,
  referencia text,
  anulado    boolean not null default false,
  usuario_id uuid references core.usuarios(id),
  created_at timestamptz not null default now()
);
create index abonos_credito_venta_idx on fin.abonos_credito (venta_id) where not anulado;
create index abonos_credito_emp_idx on fin.abonos_credito (empresa_id, fecha desc) where not anulado;

alter table fin.presupuestos   enable row level security;
alter table fin.abonos_credito enable row level security;

-- El módulo «compras» se enciende en las cuatro empresas.
insert into core.empresa_modulos (empresa_id, modulo)
select e.id, 'compras' from core.empresas e
on conflict (empresa_id, modulo) do update set activo = true;
