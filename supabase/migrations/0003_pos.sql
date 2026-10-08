-- ════════════════════════════════════════════════════════════════════════════
-- 0003 · POS + MOTOR FISCAL (SAR/CAI/ISV) — común a TODAS las empresas
--
-- Es el motor de italo-facturacion / EcoStone generalizado a multiempresa:
-- cada fila lleva empresa_id, los puntos de emisión (CAI + correlativo) cuelgan
-- de la sucursal y la facturación sigue siendo atómica (pos.cobrar_venta).
-- Cambios respecto al motor original:
--   · modificadores (extras, tamaños, "sin azúcar") con snapshot en la línea
--   · turnos de caja (apertura con fondo → cierre con cuadre) reemplazan al
--     cierre por rango de fechas
--   · estado de preparación (KDS) y canal (mostrador/recoger/delivery)
--   · cobro con pagos mixtos en una sola transacción
--   · bucket gravado 18 % y "exento por ley" por producto (frutas y verduras
--     frescas no pagan ISV; los jugos preparados SÍ — confirmar con contador)
-- ════════════════════════════════════════════════════════════════════════════

create schema if not exists pos;

-- ─── Catálogo ───────────────────────────────────────────────────────────────
create table pos.formas_pago (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references core.empresas(id),
  nombre     text not null,
  tipo       text not null default 'otro' check (tipo in ('efectivo','tarjeta','transferencia','credito','otro')),
  orden      int not null default 0,
  activo     boolean not null default true,
  unique (empresa_id, nombre)
);

create table pos.categorias (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references core.empresas(id),
  nombre     text not null,
  color      text,
  orden      int not null default 0,
  activo     boolean not null default true,
  unique (empresa_id, nombre)
);

create table pos.productos (
  id             uuid primary key default gen_random_uuid(),
  empresa_id     uuid not null references core.empresas(id),
  codigo         text,
  codigo_barras  text,
  nombre         text not null,
  descripcion    text,
  categoria_id   uuid references pos.categorias(id),
  precio         numeric(12,2) not null check (precio >= 0),   -- CON impuesto incluido
  impuesto_tasa  numeric(5,4) not null default 0.15 check (impuesto_tasa in (0, 0.15, 0.18)),
  exento         boolean not null default false,               -- exento por ley (tasa 0)
  tipo           text not null default 'simple' check (tipo in ('simple','receta','combo')),
  unidad         text not null default 'unidad',
  imagen         text,
  color          text,
  tiempo_prep_min int,
  stock_minimo   numeric(14,3) not null default 0,
  orden          int not null default 0,
  activo         boolean not null default true,
  disponible     boolean not null default true,                -- "se acabó hoy" sin desactivar
  created_at     timestamptz not null default now(),
  unique (empresa_id, codigo)
);
create unique index productos_barras_idx on pos.productos (empresa_id, codigo_barras) where codigo_barras is not null;
create index productos_empresa_idx on pos.productos (empresa_id) where activo;

-- Grupos de modificadores: "Tamaño" (1 obligatorio), "Boosters" (0..3), "Endulzante"…
create table pos.modificador_grupos (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references core.empresas(id),
  nombre     text not null,
  min_sel    int not null default 0,
  max_sel    int not null default 1 check (max_sel >= 1),
  orden      int not null default 0,
  activo     boolean not null default true,
  unique (empresa_id, nombre),
  check (min_sel <= max_sel)
);
create table pos.modificadores (
  id           uuid primary key default gen_random_uuid(),
  grupo_id     uuid not null references pos.modificador_grupos(id) on delete cascade,
  nombre       text not null,
  precio_extra numeric(12,2) not null default 0,
  orden        int not null default 0,
  activo       boolean not null default true
);
create table pos.producto_grupos (
  producto_id uuid not null references pos.productos(id) on delete cascade,
  grupo_id    uuid not null references pos.modificador_grupos(id) on delete cascade,
  orden       int not null default 0,
  primary key (producto_id, grupo_id)
);

-- ─── Puntos de emisión: CAI + rango de correlativos por sucursal ────────────
-- es_borrador = true → sin CAI real: la factura sale "BORRADOR-…" sin validez
-- fiscal hasta cargar el CAI autorizado por el SAR.
create table pos.puntos_emision (
  id                    uuid primary key default gen_random_uuid(),
  empresa_id            uuid not null references core.empresas(id),
  sucursal_id           uuid not null references core.sucursales(id),
  punto_emision_codigo  text not null,
  punto_venta_codigo    text not null,
  tipo_documento_codigo text not null default '01',
  cai                   text,
  correlativo_desde     bigint not null,
  correlativo_hasta     bigint not null,
  correlativo_actual    bigint not null,
  fecha_limite_emision  date,
  es_borrador           boolean not null default true,
  activo                boolean not null default true,
  created_at            timestamptz not null default now(),
  constraint rango_valido check (correlativo_hasta >= correlativo_desde),
  constraint correlativo_en_rango check (correlativo_actual >= correlativo_desde and correlativo_actual <= correlativo_hasta + 1)
);
create unique index puntos_emision_activo_idx on pos.puntos_emision (sucursal_id) where activo;

-- ─── Turnos de caja ─────────────────────────────────────────────────────────
create table pos.turnos (
  id                uuid primary key default gen_random_uuid(),
  empresa_id        uuid not null references core.empresas(id),
  sucursal_id       uuid not null references core.sucursales(id),
  cajero_id         uuid not null references core.usuarios(id),
  abierto_at        timestamptz not null default now(),
  fondo_inicial     numeric(12,2) not null default 0 check (fondo_inicial >= 0),
  cerrado_at        timestamptz,
  cerrado_por       uuid references core.usuarios(id),
  efectivo_contado  numeric(12,2),
  efectivo_esperado numeric(12,2),
  diferencia        numeric(12,2),
  tarjeta_sistema   numeric(12,2),
  transferencia_sistema numeric(12,2),
  total_ventas      numeric(12,2),
  cantidad_facturas int,
  factura_desde     text,
  factura_hasta     text,
  observaciones     text,
  estado            text not null default 'abierto' check (estado in ('abierto','cerrado'))
);
create unique index turnos_abierto_idx on pos.turnos (sucursal_id, cajero_id) where estado = 'abierto';
create index turnos_empresa_idx on pos.turnos (empresa_id, abierto_at desc);

create table pos.movimientos_caja (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references core.empresas(id),
  sucursal_id uuid not null references core.sucursales(id),
  turno_id    uuid references pos.turnos(id),
  tipo        text not null check (tipo in ('ingreso','salida')),
  monto       numeric(12,2) not null check (monto > 0),
  concepto    text not null,
  usuario_id  uuid references core.usuarios(id),
  created_at  timestamptz not null default now()
);
create index movimientos_caja_turno_idx on pos.movimientos_caja (turno_id);

-- ─── Ventas ─────────────────────────────────────────────────────────────────
create sequence pos.ventas_numero_orden_seq;

create table pos.contador_dia (
  sucursal_id uuid not null references core.sucursales(id),
  fecha       date not null,
  ultimo      int not null default 0,
  primary key (sucursal_id, fecha)
);

create table pos.ventas (
  id                  uuid primary key default gen_random_uuid(),
  empresa_id          uuid not null references core.empresas(id),
  sucursal_id         uuid not null references core.sucursales(id),
  turno_id            uuid references pos.turnos(id),
  punto_emision_id    uuid references pos.puntos_emision(id),
  numero_orden        bigint not null default nextval('pos.ventas_numero_orden_seq'),
  ticket_dia          int not null default 0,              -- 1,2,3… del día (para llamar al cliente)
  numero_factura      text,
  correlativo         bigint,
  cliente_id          uuid references core.terceros(id),
  cajero_id           uuid references core.usuarios(id),
  canal               text not null default 'mostrador' check (canal in ('mostrador','recoger','delivery','evento','mayoreo')),
  tipo_orden          text not null default 'aqui' check (tipo_orden in ('aqui','llevar')),
  estado              text not null default 'abierta' check (estado in ('abierta','pagada','anulada')),
  estado_prep         text not null default 'pendiente' check (estado_prep in ('pendiente','preparando','listo','entregado')),
  nombre_orden        text,
  notas               text,
  subtotal_exento     numeric(12,2) not null default 0,
  subtotal_exonerado  numeric(12,2) not null default 0,
  subtotal_gravado_15 numeric(12,2) not null default 0,
  subtotal_gravado_18 numeric(12,2) not null default 0,
  descuento           numeric(12,2) not null default 0,
  descuento_porcentaje smallint not null default 0 check (descuento_porcentaje in (0,10,25)),
  isv_total           numeric(12,2) not null default 0,
  propina             numeric(12,2) not null default 0,
  total               numeric(12,2) not null default 0,
  efectivo_recibido   numeric(12,2),
  cambio              numeric(12,2),
  es_borrador_fiscal  boolean not null default true,
  fecha_emision       timestamptz,
  anulada_at          timestamptz,
  anulada_por         uuid references core.usuarios(id),
  motivo_anulacion    text,
  prep_listo_at       timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index ventas_numero_factura_idx on pos.ventas (empresa_id, numero_factura) where numero_factura is not null;
create index ventas_empresa_fecha_idx on pos.ventas (empresa_id, sucursal_id, fecha_emision);
create index ventas_estado_idx on pos.ventas (sucursal_id, estado, created_at desc);
create index ventas_turno_idx on pos.ventas (turno_id);

create table pos.detalle_venta (
  id                   uuid primary key default gen_random_uuid(),
  venta_id             uuid not null references pos.ventas(id) on delete cascade,
  producto_id          uuid references pos.productos(id),
  nombre_producto      text not null,
  cantidad             numeric(12,3) not null check (cantidad > 0),
  precio_base          numeric(12,2) not null,             -- precio del producto
  extras               numeric(12,2) not null default 0,   -- suma de modificadores
  precio_unitario      numeric(12,2) not null,             -- base + extras
  opciones             jsonb not null default '[]'::jsonb, -- snapshot [{id,grupo,nombre,precio_extra}]
  notas                text,
  descuento            numeric(12,2) not null default 0,
  descuento_porcentaje smallint not null default 0 check (descuento_porcentaje in (0,10,25)),
  impuesto_tasa        numeric(5,4) not null default 0.15,
  exento               boolean not null default false,
  monto                numeric(12,2) not null,
  costo_unitario       numeric(14,4),                      -- snapshot de receta al cobrar
  orden                int not null default 0
);
create index detalle_venta_venta_idx on pos.detalle_venta (venta_id);
create index detalle_venta_producto_idx on pos.detalle_venta (producto_id);

create table pos.venta_pagos (
  id             uuid primary key default gen_random_uuid(),
  venta_id       uuid not null references pos.ventas(id) on delete cascade,
  forma_pago_id  uuid not null references pos.formas_pago(id),
  monto          numeric(12,2) not null check (monto > 0),   -- neto (sin el cambio)
  referencia     text
);
create index venta_pagos_venta_idx on pos.venta_pagos (venta_id);

create table pos.notas_credito (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references core.empresas(id),
  venta_id    uuid not null references pos.ventas(id),
  numero_nota text,
  motivo      text not null,
  monto       numeric(12,2) not null check (monto > 0),
  usuario_id  uuid references core.usuarios(id),
  created_at  timestamptz not null default now()
);

-- ─── Siguiente número de ticket del día (hora de Honduras, UTC-6) ───────────
create function pos.siguiente_ticket(p_sucursal uuid) returns int
language sql as $$
  insert into pos.contador_dia (sucursal_id, fecha, ultimo)
  values (p_sucursal, (now() at time zone 'America/Tegucigalpa')::date, 1)
  on conflict (sucursal_id, fecha) do update set ultimo = pos.contador_dia.ultimo + 1
  returning ultimo;
$$;

-- ─── COBRAR: correlativo + pagos + cierre de la venta, todo atómico ─────────
-- p_pagos = [{forma_pago_id, monto, referencia?}]. El efectivo puede exceder lo
-- que falta (genera cambio); tarjeta/transferencia nunca pueden exceder.
create function pos.cobrar_venta(p_venta_id uuid, p_pagos jsonb)
returns pos.ventas
language plpgsql as $$
declare
  v_venta   pos.ventas%rowtype;
  v_pe      pos.puntos_emision%rowtype;
  v_pago    jsonb;
  v_fp      pos.formas_pago%rowtype;
  v_monto   numeric(12,2);
  v_recibido numeric(12,2) := 0;
  v_efectivo numeric(12,2) := 0;
  v_otros   numeric(12,2) := 0;
  v_cambio  numeric(12,2) := 0;
  v_corr    bigint;
  v_numero  text;
  v_lineas  int;
begin
  select * into v_venta from pos.ventas where id = p_venta_id for update;
  if not found then raise exception 'Venta no encontrada'; end if;
  if v_venta.estado <> 'abierta' then
    raise exception 'La venta ya fue procesada (estado actual: %)', v_venta.estado;
  end if;
  select count(*) into v_lineas from pos.detalle_venta where venta_id = p_venta_id;
  if v_lineas = 0 then raise exception 'La venta no tiene productos'; end if;

  -- 1) Validar y sumar pagos
  if v_venta.total > 0 then
    if p_pagos is null or jsonb_typeof(p_pagos) <> 'array' or jsonb_array_length(p_pagos) = 0 then
      raise exception 'Falta la forma de pago';
    end if;
    for v_pago in select * from jsonb_array_elements(p_pagos) loop
      v_monto := round((v_pago->>'monto')::numeric, 2);
      if v_monto is null or v_monto <= 0 then raise exception 'Monto de pago inválido'; end if;
      select * into v_fp from pos.formas_pago
        where id = (v_pago->>'forma_pago_id')::uuid and empresa_id = v_venta.empresa_id and activo;
      if not found then raise exception 'Forma de pago inválida para esta empresa'; end if;
      v_recibido := v_recibido + v_monto;
      if v_fp.tipo = 'efectivo' then v_efectivo := v_efectivo + v_monto; else v_otros := v_otros + v_monto; end if;
    end loop;
    if v_recibido < v_venta.total then
      raise exception 'El pago (%) no cubre el total (%)', v_recibido, v_venta.total;
    end if;
    if v_otros > v_venta.total then
      raise exception 'Tarjeta/transferencia no puede exceder el total de la venta';
    end if;
    v_cambio := v_recibido - v_venta.total;
    if v_cambio > v_efectivo then raise exception 'El cambio no puede salir de un pago que no es efectivo'; end if;
  end if;

  -- 2) Correlativo (bloqueo de fila: dos cajeros nunca obtienen el mismo número)
  select * into v_pe from pos.puntos_emision
    where sucursal_id = v_venta.sucursal_id and activo
    for update;
  if not found then raise exception 'La sucursal no tiene punto de emisión activo'; end if;
  if v_pe.fecha_limite_emision is not null and v_pe.fecha_limite_emision < (now() at time zone 'America/Tegucigalpa')::date then
    raise exception 'El rango autorizado de facturación venció el %', v_pe.fecha_limite_emision;
  end if;
  if v_pe.correlativo_actual > v_pe.correlativo_hasta then
    raise exception 'El rango de correlativos autorizado está agotado';
  end if;
  v_corr := v_pe.correlativo_actual;
  v_numero := v_pe.punto_emision_codigo || '-' || v_pe.punto_venta_codigo || '-'
              || v_pe.tipo_documento_codigo || '-' || lpad(v_corr::text, 8, '0');
  if v_pe.es_borrador then v_numero := 'BORRADOR-' || v_numero; end if;
  update pos.puntos_emision set correlativo_actual = correlativo_actual + 1 where id = v_pe.id;

  -- 3) Pagos netos (el cambio se descuenta del efectivo)
  if v_venta.total > 0 then
    declare v_cambio_pend numeric(12,2) := v_cambio; v_neto numeric(12,2);
    begin
      for v_pago in select * from jsonb_array_elements(p_pagos) loop
        v_monto := round((v_pago->>'monto')::numeric, 2);
        select * into v_fp from pos.formas_pago where id = (v_pago->>'forma_pago_id')::uuid;
        v_neto := v_monto;
        if v_fp.tipo = 'efectivo' and v_cambio_pend > 0 then
          v_neto := v_monto - least(v_monto, v_cambio_pend);
          v_cambio_pend := v_cambio_pend - least(v_monto, v_cambio_pend);
        end if;
        if v_neto > 0 then
          insert into pos.venta_pagos (venta_id, forma_pago_id, monto, referencia)
          values (p_venta_id, v_fp.id, v_neto, nullif(v_pago->>'referencia', ''));
        end if;
      end loop;
    end;
  end if;

  update pos.ventas set
    estado = 'pagada',
    punto_emision_id = v_pe.id,
    numero_factura = v_numero,
    correlativo = v_corr,
    es_borrador_fiscal = v_pe.es_borrador,
    fecha_emision = now(),
    efectivo_recibido = case when v_efectivo > 0 then v_efectivo else null end,
    cambio = case when v_cambio > 0 then v_cambio else null end,
    updated_at = now()
  where id = p_venta_id
  returning * into v_venta;

  return v_venta;
end $$;

-- ─── Anular una venta ya cobrada (el correlativo NO se reutiliza) ───────────
create function pos.anular_venta(p_venta_id uuid, p_motivo text, p_usuario uuid)
returns pos.ventas language plpgsql as $$
declare v_venta pos.ventas%rowtype;
begin
  select * into v_venta from pos.ventas where id = p_venta_id for update;
  if not found then raise exception 'Venta no encontrada'; end if;
  if v_venta.estado = 'anulada' then raise exception 'La venta ya está anulada'; end if;
  if coalesce(trim(p_motivo), '') = '' then raise exception 'El motivo de anulación es obligatorio'; end if;
  update pos.ventas set estado = 'anulada', anulada_at = now(), anulada_por = p_usuario,
         motivo_anulacion = p_motivo, updated_at = now()
   where id = p_venta_id returning * into v_venta;
  return v_venta;
end $$;

-- ─── RLS cerrada ────────────────────────────────────────────────────────────
alter table pos.formas_pago         enable row level security;
alter table pos.categorias          enable row level security;
alter table pos.productos           enable row level security;
alter table pos.modificador_grupos  enable row level security;
alter table pos.modificadores       enable row level security;
alter table pos.producto_grupos     enable row level security;
alter table pos.puntos_emision      enable row level security;
alter table pos.turnos              enable row level security;
alter table pos.movimientos_caja    enable row level security;
alter table pos.contador_dia        enable row level security;
alter table pos.ventas              enable row level security;
alter table pos.detalle_venta       enable row level security;
alter table pos.venta_pagos         enable row level security;
alter table pos.notas_credito       enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function pos.cobrar_venta(uuid, jsonb), pos.anular_venta(uuid, text, uuid), pos.siguiente_ticket(uuid) from public, anon, authenticated';
  end if;
end $$;

-- ─── Semilla: formas de pago y punto de emisión borrador por sucursal ───────
insert into pos.formas_pago (empresa_id, nombre, tipo, orden)
select e.id, f.nombre, f.tipo, f.orden
from core.empresas e cross join (values
  ('Efectivo', 'efectivo', 1), ('Tarjeta', 'tarjeta', 2), ('Transferencia', 'transferencia', 3)
) as f(nombre, tipo, orden);

insert into pos.puntos_emision (empresa_id, sucursal_id, punto_emision_codigo, punto_venta_codigo,
                                correlativo_desde, correlativo_hasta, correlativo_actual, es_borrador)
select s.empresa_id, s.id, lpad(s.orden::text, 3, '0'), '001', 1, 99999999, 1, true from core.sucursales s;
