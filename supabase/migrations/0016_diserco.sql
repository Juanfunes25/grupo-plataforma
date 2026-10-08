-- ════════════════════════════════════════════════════════════════════════════
-- 0016 · DISERCO (distribuidora): catálogo, inventario por producto, cotizaciones y salidas a proyecto
--   Portado de la app original (EcoStone Facturación: 0023, 0024, 0025, 0027, 0029, 0030).
--   · El catálogo vive en pos.productos / pos.categorias (así el POS «Venta Directa» lo ve); lo propio de
--     DISERCO (marca, presentación, rendimiento, consumible, control de inventario, costo) en dis.producto_ext.
--   · El inventario es un libro por producto (dis.movimientos, + entra / − sale), con costo promedio.
--     Cada factura descuenta sola (trigger) y la anulación devuelve. Nunca bloquea la caja: puede quedar negativo.
--   · Cotizaciones de Proyecto / Productos (con secciones de texto, Excel original), cobros con factura propia.
--   · Salidas de material a proyecto con conteo al cierre y consumibles / no consumibles.
-- ════════════════════════════════════════════════════════════════════════════
create schema if not exists dis;

-- Contadores por empresa (cotizaciones: uno por año; salidas: global)
create table dis.contadores (
  empresa_id uuid not null references core.empresas(id),
  clave      text not null,
  anio       int  not null default 0,
  ultimo     int  not null default 0,
  primary key (empresa_id, clave, anio)
);
create function dis.siguiente(p_empresa uuid, p_clave text, p_anio int default 0) returns int language sql as $$
  insert into dis.contadores (empresa_id, clave, anio, ultimo) values (p_empresa, p_clave, p_anio, 1)
  on conflict (empresa_id, clave, anio) do update set ultimo = dis.contadores.ultimo + 1
  returning ultimo;
$$;
-- La última cotización de la app original fue la 0060-26.
insert into dis.contadores (empresa_id, clave, anio, ultimo)
select id, 'cot', 2026, 60 from core.empresas where codigo = 'diserco' on conflict do nothing;

-- ─── Catálogo: extensión de pos.productos ───────────────────────────────────
create table dis.producto_ext (
  producto_id         uuid primary key references pos.productos(id) on delete cascade,
  empresa_id          uuid not null references core.empresas(id),
  marca               text,
  presentacion        text,
  rendimiento_texto   text,
  consumible          boolean not null default true,     -- false = moldes / herramientas: deben regresar del proyecto
  controla_inventario boolean not null default true,
  precio_sin_isv      numeric(14,4) not null default 0,  -- precio de venta sin ISV (el ISV se suma en la cotización)
  costo_estandar      numeric(14,4) not null default 0,  -- costo promedio ponderado, sin ISV
  id_origen_wizpos    int,
  alerta              text
);
create index producto_ext_empresa_idx on dis.producto_ext (empresa_id);

-- ─── Inventario: libro de movimientos por producto ──────────────────────────
create table dis.salidas (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references core.empresas(id),
  sucursal_id uuid references core.sucursales(id),
  numero      int not null,
  proyecto    text not null,
  cotizacion_id uuid,
  responsable text not null,
  notas       text,
  estado      text not null default 'abierta' check (estado in ('abierta','cerrada')),
  resumen     jsonb,
  creada_por  uuid references core.usuarios(id),
  created_at  timestamptz not null default now(),
  cerrada_at  timestamptz,
  cerrada_por uuid references core.usuarios(id),
  unique (empresa_id, numero)
);
create index salidas_estado_idx on dis.salidas (empresa_id, estado, created_at desc);

create table dis.salida_items (
  id              uuid primary key default gen_random_uuid(),
  salida_id       uuid not null references dis.salidas(id) on delete cascade,
  producto_id     uuid not null references pos.productos(id),
  cantidad_salida  numeric(14,3) not null default 0,
  cantidad_retorno numeric(14,3) not null default 0,
  costo_unitario  numeric(14,4) not null default 0,
  unique (salida_id, producto_id)
);

create table dis.movimientos (
  id             bigint generated always as identity primary key,
  empresa_id     uuid not null references core.empresas(id),
  producto_id    uuid not null references pos.productos(id),
  tipo           text not null check (tipo in ('inicial','compra','venta','ajuste','devolucion','salida_proyecto','retorno_proyecto')),
  cantidad       numeric(14,3) not null,                  -- + entra, − sale
  costo_unitario numeric(14,4) not null default 0,        -- sin ISV
  motivo         text,
  proveedor      text,
  referencia     text,
  venta_id       uuid references pos.ventas(id),
  salida_id      uuid references dis.salidas(id) on delete set null,
  usuario_id     uuid references core.usuarios(id),
  created_at     timestamptz not null default now()
);
create index dis_mov_producto_idx on dis.movimientos (producto_id, created_at desc);
create index dis_mov_empresa_idx on dis.movimientos (empresa_id, created_at desc);
create index dis_mov_venta_idx on dis.movimientos (venta_id) where venta_id is not null;

create view dis.existencias as
select empresa_id, producto_id, coalesce(sum(cantidad), 0)::numeric(14,3) as existencia, max(created_at) as ultimo_movimiento
from dis.movimientos group by empresa_id, producto_id;

-- Mueve inventario con candado por producto. p_forzar permite dejar la existencia en negativo (ya confirmado por el usuario).
create function dis.mover(
  p_empresa uuid, p_producto uuid, p_tipo text, p_cantidad numeric, p_costo numeric, p_motivo text,
  p_venta uuid, p_proveedor text, p_referencia text, p_usuario uuid, p_forzar boolean, p_salida uuid
) returns bigint language plpgsql as $$
declare v_exist numeric; v_costo_ant numeric; v_id bigint;
begin
  select costo_estandar into v_costo_ant from dis.producto_ext where producto_id = p_producto and empresa_id = p_empresa for update;
  if not found then raise exception 'Producto no encontrado'; end if;
  if p_cantidad = 0 then raise exception 'La cantidad no puede ser cero'; end if;
  select coalesce(sum(cantidad), 0) into v_exist from dis.movimientos where producto_id = p_producto;
  if p_cantidad < 0 and v_exist + p_cantidad < 0 and not p_forzar then
    raise exception 'Existencia insuficiente: hay %, se piden %', v_exist, abs(p_cantidad);
  end if;
  insert into dis.movimientos (empresa_id, producto_id, tipo, cantidad, costo_unitario, motivo, proveedor, referencia, venta_id, salida_id, usuario_id)
  values (p_empresa, p_producto, p_tipo, p_cantidad, coalesce(p_costo, 0), p_motivo, p_proveedor, p_referencia, p_venta, p_salida, p_usuario)
  returning id into v_id;
  -- Costo promedio ponderado al entrar mercadería con costo.
  if p_cantidad > 0 and p_tipo in ('compra','inicial') and coalesce(p_costo, 0) > 0 then
    update dis.producto_ext set costo_estandar = round(((greatest(v_exist, 0) * v_costo_ant) + (p_cantidad * p_costo)) / (greatest(v_exist, 0) + p_cantidad), 4)
     where producto_id = p_producto;
  end if;
  return v_id;
end $$;

-- Facturar descuenta (aunque quede en negativo: la caja no se bloquea); anular devuelve.
create function dis.al_cambiar_estado_venta() returns trigger language plpgsql as $$
declare v_det record; v_mov record; v_costo numeric;
begin
  if old.estado = 'abierta' and new.estado = 'pagada' then
    for v_det in select d.id, d.producto_id, d.cantidad from pos.detalle_venta d
                   join dis.producto_ext x on x.producto_id = d.producto_id and x.controla_inventario
                  where d.venta_id = new.id loop
      select costo_estandar into v_costo from dis.producto_ext where producto_id = v_det.producto_id;
      perform dis.mover(new.empresa_id, v_det.producto_id, 'venta', -v_det.cantidad, v_costo, 'Venta ' || coalesce(new.numero_factura, ''), new.id, null, new.numero_factura, new.cajero_id, true, null);
      update pos.detalle_venta set costo_unitario = v_costo where id = v_det.id;
    end loop;
  elsif old.estado = 'pagada' and new.estado = 'anulada' then
    for v_mov in select * from dis.movimientos where venta_id = new.id and tipo = 'venta' loop
      perform dis.mover(v_mov.empresa_id, v_mov.producto_id, 'devolucion', -v_mov.cantidad, v_mov.costo_unitario, 'Anulación de venta ' || coalesce(new.numero_factura, ''), new.id, null, new.numero_factura, new.anulada_por, true, null);
    end loop;
  end if;
  return new;
end $$;
create trigger dis_venta_inventario after update of estado on pos.ventas
  for each row when (old.estado is distinct from new.estado)
  execute function dis.al_cambiar_estado_venta();

-- ─── Cotizaciones ───────────────────────────────────────────────────────────
create table dis.cotizaciones (
  id             uuid primary key default gen_random_uuid(),
  empresa_id     uuid not null references core.empresas(id),
  tipo           text not null check (tipo in ('proyecto','productos')),
  numero         int not null,
  anio           int not null,
  codigo         text not null,
  estado         text not null default 'borrador' check (estado in ('borrador','enviada','aprobada','rechazada','facturada','anulada')),
  cliente_id     uuid references core.terceros(id),
  nombre_cliente text not null,
  rtn_cliente    text, telefono text, email text, contacto text,
  proyecto       text, ubicacion text,
  vigencia_dias  int not null default 30,
  fecha_vigencia date,
  descuento_pct  numeric(5,2) not null default 0,
  subtotal       numeric(14,2) not null default 0,
  isv            numeric(14,2) not null default 0,
  total          numeric(14,2) not null default 0,
  anticipo_pct   numeric(5,2) not null default 0,
  secciones      jsonb not null default '[]'::jsonb,
  mostrar_bancos boolean not null default false,
  firma_nombre   text, firma_cargo text,
  notas_internas text,
  motivo_cierre  text,
  aprobada_at    timestamptz,
  aprobada_por   uuid references core.usuarios(id),
  vendedor_id    uuid references core.usuarios(id),
  sucursal_id    uuid references core.sucursales(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (empresa_id, codigo)
);
create index dis_cot_estado_idx on dis.cotizaciones (empresa_id, estado, created_at desc);
alter table dis.salidas add constraint salidas_cotizacion_fk foreign key (cotizacion_id) references dis.cotizaciones(id);

create table dis.cotizacion_lineas (
  id              uuid primary key default gen_random_uuid(),
  cotizacion_id   uuid not null references dis.cotizaciones(id) on delete cascade,
  orden           int not null default 0,
  producto_id     uuid references pos.productos(id),
  descripcion     text not null,
  presentacion    text,
  cantidad        numeric(14,3) not null check (cantidad > 0),
  unidad          text not null default 'm2',
  precio_unitario numeric(14,4) not null check (precio_unitario >= 0),   -- sin ISV
  isv_tasa        numeric(5,4) not null default 0.15,
  monto           numeric(14,2) not null default 0,                        -- con ISV
  costo_unitario  numeric(14,4) not null default 0
);
create index dis_cot_lineas_idx on dis.cotizacion_lineas (cotizacion_id, orden);

create table dis.cotizacion_pagos (
  id            uuid primary key default gen_random_uuid(),
  cotizacion_id uuid not null references dis.cotizaciones(id) on delete cascade,
  concepto      text not null,
  forma_pago_id uuid not null references pos.formas_pago(id),
  monto         numeric(14,2) not null check (monto > 0),
  referencia    text,
  venta_id      uuid references pos.ventas(id),
  anulado       boolean not null default false,
  usuario_id    uuid references core.usuarios(id),
  created_at    timestamptz not null default now()
);

-- Excel original de cada cotización importada (base64).
create table dis.cotizacion_archivos (
  id            uuid primary key default gen_random_uuid(),
  cotizacion_id uuid not null references dis.cotizaciones(id) on delete cascade,
  nombre        text not null,
  contenido     text not null,
  created_at    timestamptz not null default now()
);

alter table dis.contadores          enable row level security;
alter table dis.producto_ext        enable row level security;
alter table dis.movimientos         enable row level security;
alter table dis.salidas             enable row level security;
alter table dis.salida_items        enable row level security;
alter table dis.cotizaciones        enable row level security;
alter table dis.cotizacion_lineas   enable row level security;
alter table dis.cotizacion_pagos    enable row level security;
alter table dis.cotizacion_archivos enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function dis.mover(uuid,uuid,text,numeric,numeric,text,uuid,text,text,uuid,boolean,uuid), dis.siguiente(uuid,text,int) from public, anon, authenticated';
  end if;
end $$;

-- ─── Semilla: catálogo importado de WizPOS (278 productos, 16 categorías con productos, existencias iniciales) ───
-- Datos fuente: supabase/seeds/diserco de la app original (EcoStone Facturación, migración 0027). Idempotente:
-- los productos llevan un id determinístico por id_origen_wizpos y todo entra con ON CONFLICT DO NOTHING.
insert into pos.categorias (empresa_id, nombre, orden)
select e.id, v.nombre, v.orden from core.empresas e cross join (values
  ('MATERIALES', 1),
  ('SERVICIO DE CONSTRUCCIÓN', 2),
  ('HERRAMIENTAS', 3),
  ('MOLDES', 4),
  ('HARDENER SUPERSTONE', 5),
  ('RELEASE SUPERSTONE', 6),
  ('PULIDO/DISCOS', 7),
  ('COLOR HARDENER CS NUEVO', 8),
  ('COLOR RELEASE CS NUEVO', 9),
  ('ZOCALOS', 10),
  ('COLORANTE LIQUIDO', 11),
  ('SELLADORES', 12),
  ('MICROCEMENTO', 13),
  ('ALQUILER Y MOLDES USADOS', 19),
  ('RESINAS', 21),
  ('BAUMERK', 22)
) as v(nombre, orden) where e.codigo = 'diserco'
on conflict (empresa_id, nombre) do nothing;

create temp table _dis_semilla (idw int, nombre text, descripcion text, barras text, categoria text, marca text, costo numeric, con_isv numeric, sin_isv numeric, tasa numeric, existencia numeric, controla boolean, minimo numeric, venta boolean, consumible boolean, alerta text);
insert into _dis_semilla values
  (3, 'Clear Sealer Cub 5 Gal', null, null, 'SELLADORES', null, 1608.305, 5453.72, 4742.3652, 0.15, 55.7, true, 0, true, true, 'sin_marca;compuesto_sin_componentes'),
  (4, 'Clear Sealer 1 Galon', '1 Galon', null, 'SELLADORES', null, 310.66, 1217.82, 1058.9739, 0.15, 0, true, 0, true, true, 'existencia_negativa_a_cero;sin_marca;compuesto_sin_componentes'),
  (5, 'Clear Sealer Barril', null, null, 'SELLADORES', null, 13933.05, 54363.49, 47272.6, 0.15, 0, true, 0, true, true, 'existencia_negativa_a_cero;sin_marca;compuesto_sin_componentes'),
  (6, 'Color Integral Negro y Rojo', null, null, 'MATERIALES', null, 0, 196.58, 170.9391, 0.15, 0, true, 0, true, true, 'costo_cero;existencia_negativa_a_cero;sin_marca'),
  (7, 'Color Integral Amarillo', null, null, 'MATERIALES', null, 0, 223.33, 194.2, 0.15, 0, true, 0, true, true, 'costo_cero;existencia_negativa_a_cero;sin_marca'),
  (8, 'Color Integral', null, null, 'MATERIALES', null, 0, 9110.26, 7921.9652, 0.15, 0, true, 0, true, true, 'costo_cero;existencia_negativa_a_cero;sin_marca'),
  (9, 'Chlor Stain', null, null, 'COLORANTE LIQUIDO', null, 0, 3035.25, 2639.3478, 0.15, 0, true, 0, true, true, 'costo_cero;existencia_negativa_a_cero;sin_marca'),
  (10, 'Extender For Chlorstain', null, null, 'COLORANTE LIQUIDO', 'Superstone Inc', 0, 1003.07, 872.2348, 0.15, 0, true, 0, true, true, 'costo_cero'),
  (11, 'Clear Hydro Sealer', null, null, 'MATERIALES', null, 0, 0, 0, 0.15, 0, true, 0, true, true, 'costo_cero;precio_cero;existencia_negativa_a_cero;sin_marca'),
  (12, 'Seamless Epoxy System', null, null, 'MATERIALES', null, 0, 11982.62, 10419.6696, 0.15, 0, true, 0, true, true, 'costo_cero;existencia_negativa_a_cero;sin_marca;nombre_duplicado'),
  (13, 'Seamless Epoxy System', null, null, 'MATERIALES', null, 0, 0, 0, 0.15, 0, true, 0, true, true, 'costo_cero;precio_cero;sin_marca;nombre_duplicado'),
  (14, 'Sistema 2 resin: 1 Hardener', null, null, 'MATERIALES', null, 0, 13024.59, 11325.7304, 0.15, 0, true, 0, true, true, 'costo_cero;sin_marca'),
  (15, 'Arena Silica - Quartz Sans', null, null, 'MATERIALES', null, 0, 2354.5, 2047.3913, 0.15, 0, true, 0, true, true, 'costo_cero;existencia_negativa_a_cero;sin_marca'),
  (16, 'Super Tex wet&Ready blco', null, null, 'MATERIALES', null, 0, 1593.86, 1385.9652, 0.15, 0, true, 0, true, true, 'costo_cero;existencia_negativa_a_cero;sin_marca'),
  (17, 'Super Tex wet&Ready Ivory', null, null, 'MATERIALES', null, 0, 1495.22, 1300.1913, 0.15, 0, true, 0, true, true, 'costo_cero;existencia_negativa_a_cero;sin_marca'),
  (18, 'Liquid Reiease', null, null, 'MATERIALES', null, 0, 6965.9, 6057.3043, 0.15, 0, true, 0, true, true, 'costo_cero;existencia_negativa_a_cero;sin_marca'),
  (19, 'Crack Repair Epoxy Portion Pack', null, null, 'MATERIALES', null, 0, 3099.85, 2695.5217, 0.15, 0, true, 0, true, true, 'costo_cero;existencia_negativa_a_cero;sin_marca'),
  (22, 'Super Grip', null, null, 'MATERIALES', null, 0, 1114.56, 969.1826, 0.15, 0, true, 0, true, true, 'costo_cero;sin_marca'),
  (24, 'Microtopping White', null, null, 'MATERIALES', null, 0, 3343.67, 2907.5391, 0.15, 0, true, 0, true, true, 'costo_cero;sin_marca'),
  (25, 'Microtopping Resin', null, null, 'MATERIALES', null, 0, 9287.75, 8076.3043, 0.15, 0, true, 0, true, true, 'costo_cero;sin_marca'),
  (26, 'Sealer VOC Barril', null, null, 'MATERIALES', null, 0, 0, 0, 0.15, 0, true, 0, true, true, 'costo_cero;precio_cero;sin_marca'),
  (27, 'Sealer VOC Cubeta', null, null, 'SELLADORES', null, 0, 7651.86, 6653.7913, 0.15, 0, true, 0, true, true, 'costo_cero;sin_marca'),
  (28, 'Solvente', null, null, 'MATERIALES', null, 0, 420.26, 365.4435, 0.15, 0, true, 0, true, true, 'costo_cero;existencia_negativa_a_cero;sin_marca'),
  (29, 'Versa Look Kit', null, null, 'SELLADORES', 'Superstone Inc', 0, 13024.59, 11325.7304, 0.15, 2, true, 0, true, true, 'costo_cero'),
  (31, 'SR2 AMERIPOLYSH GALON', null, null, 'PULIDO/DISCOS', 'DISERCO', 0, 12118.65, 10537.9565, 0.15, 0, true, 0, true, true, 'costo_cero'),
  (32, 'Antique', null, null, 'COLORANTE LIQUIDO', 'Superstone Inc', 0, 1014.88, 882.5043, 0.15, 0, true, 0, true, true, 'costo_cero;existencia_negativa_a_cero'),
  (33, 'Hojuelas de Vinilo', null, null, 'MATERIALES', null, 0, 0, 0, 0.15, 0, true, 0, true, true, 'costo_cero;precio_cero;existencia_negativa_a_cero;sin_marca;nombre_duplicado'),
  (34, 'Hojuelas de Vinilo', null, null, 'MATERIALES', null, 0, 0, 0, 0.15, 0, true, 0, true, true, 'costo_cero;precio_cero;existencia_negativa_a_cero;sin_marca;nombre_duplicado'),
  (35, 'Sellador con Color Galon', null, null, 'SELLADORES', null, 850, 1573.93, 1368.6348, 0.15, 0, true, 0, true, true, 'existencia_negativa_a_cero;sin_marca;compuesto_sin_componentes'),
  (36, 'Decco Eco Sellador Matte', null, null, 'MICROCEMENTO', null, 0, 0, 0, 0.15, 6, true, 0, true, true, 'costo_cero;precio_cero;sin_marca'),
  (37, 'Decco Wb Color Toner', null, null, 'MICROCEMENTO', null, 0, 1745.06, 1517.4435, 0.15, 0, true, 0, true, true, 'costo_cero;existencia_negativa_a_cero;sin_marca'),
  (38, 'Decco Microtop one', null, null, 'MICROCEMENTO', null, 0, 7634.67, 6638.8435, 0.15, 6, true, 0, true, true, 'costo_cero;sin_marca'),
  (39, 'Decco Primer', null, null, 'MICROCEMENTO', null, 0, 2544.89, 2212.9478, 0.15, 14, true, 0, true, true, 'costo_cero;sin_marca'),
  (40, 'Decco MicroQuartz', null, null, 'MICROCEMENTO', null, 0, 11688.15, 10163.6087, 0.15, 1, true, 0, true, true, 'costo_cero;sin_marca'),
  (41, 'Bracket Tilt', null, null, 'HERRAMIENTAS', null, 0, 3726.53, 3240.4609, 0.15, 0, true, 0, true, false, 'costo_cero;existencia_negativa_a_cero;sin_marca'),
  (42, 'S Tool', null, null, 'HERRAMIENTAS', null, 0, 654.58, 569.2, 0.15, 0, true, 0, true, false, 'costo_cero;existencia_negativa_a_cero;sin_marca'),
  (43, 'Tamper', null, null, 'HERRAMIENTAS', null, 0, 6687.35, 5815.087, 0.15, 0, true, 0, true, false, 'costo_cero;sin_marca'),
  (44, 'Flota de Magnesio', null, null, 'HERRAMIENTAS', null, 0, 6417.91, 5580.7913, 0.15, 0, true, 0, true, false, 'costo_cero;sin_marca'),
  (45, 'Llana de mano curva 24x5"', null, null, 'HERRAMIENTAS', null, 0, 681.98, 593.0261, 0.15, 0, true, 0, true, false, 'costo_cero;existencia_negativa_a_cero;sin_marca'),
  (64, 'Servicios de Construccion', null, null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 0, 0, 0, 0, true, 0, true, true, 'costo_cero;precio_cero;existencia_negativa_a_cero;sin_marca'),
  (65, 'Trabajos Resina Epoxica m2', null, null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 0, 0, 0.15, 0, true, 0, true, true, 'costo_cero;precio_cero;existencia_negativa_a_cero;sin_marca'),
  (66, 'Trabajos Resina Epoxica ml', null, null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 0, 0, 0.15, 0, true, 0, true, true, 'costo_cero;precio_cero;existencia_negativa_a_cero;sin_marca'),
  (67, 'Trabajos Resina Durachips m2', null, null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 0, 0, 0.15, 0, true, 0, true, true, 'costo_cero;precio_cero;existencia_negativa_a_cero;sin_marca'),
  (68, 'Trabajos Resina Durachips ml', null, null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 2, 1.7391, 0.15, 0, true, 0, true, true, 'costo_cero;existencia_negativa_a_cero;sin_marca'),
  (69, 'Trabajos Uretano m2', null, null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 0, 0, 0.15, 0, true, 0, true, true, 'costo_cero;precio_cero;existencia_negativa_a_cero;sin_marca'),
  (70, 'Trabajos Uretano  ml', null, null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 0, 0, 0.15, 0, true, 0, true, true, 'costo_cero;precio_cero;existencia_negativa_a_cero;sin_marca'),
  (71, 'Trabajos Resina Industrial', null, null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 0, 0, 0.15, 0, true, 0, true, true, 'costo_cero;precio_cero;existencia_negativa_a_cero;sin_marca;nombre_duplicado'),
  (72, 'Trabajos Resina Industrial', null, null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 0, 0, 0.15, 0, true, 0, true, true, 'costo_cero;precio_cero;sin_marca;nombre_duplicado'),
  (73, 'Trabajos Estampado m2', null, null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 0, 0, 0.15, 0, true, 0, true, true, 'costo_cero;precio_cero;existencia_negativa_a_cero;sin_marca'),
  (74, 'Trabajos Estampado ml', null, null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 0, 0, 0.15, 0, true, 0, true, true, 'costo_cero;precio_cero;existencia_negativa_a_cero;sin_marca'),
  (75, 'Trabajos Permashine m2', null, null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 0, 0, 0.15, 0, true, 0, true, true, 'costo_cero;precio_cero;existencia_negativa_a_cero;sin_marca'),
  (76, 'Trabajos Permashine ml', null, null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 0, 0, 0.15, 0, true, 0, true, true, 'costo_cero;precio_cero;existencia_negativa_a_cero;sin_marca'),
  (77, 'Trabajos Microcemento m2', null, null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 0, 0, 0.15, 0, true, 0, true, true, 'costo_cero;precio_cero;sin_marca'),
  (78, 'Trabajos Microcemento ml', null, null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 0, 0, 0.15, 0, true, 0, true, true, 'costo_cero;precio_cero;sin_marca'),
  (79, 'Trabajos Resellado m2', null, null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 0, 0, 0.15, 0, true, 0, true, true, 'costo_cero;precio_cero;existencia_negativa_a_cero;sin_marca'),
  (80, 'Trabajos Resellado ml', null, null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 0, 0, 0.15, 0, true, 0, true, true, 'costo_cero;precio_cero;sin_marca'),
  (81, 'Trabajos Industriales m2', null, null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 0, 0, 0.15, 0, true, 0, true, true, 'costo_cero;precio_cero;existencia_negativa_a_cero;sin_marca'),
  (82, 'Trabajos Industriales ml', null, null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 0, 0, 0.15, 0, true, 0, true, true, 'costo_cero;precio_cero;existencia_negativa_a_cero;sin_marca'),
  (83, 'Trabajos de Concreto m2', null, null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 0, 0, 0.15, 0, true, 0, true, true, 'costo_cero;precio_cero;sin_marca'),
  (84, 'Trabajos de Concreto ml', null, null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 0, 0, 0.15, 0, true, 0, true, true, 'costo_cero;precio_cero;sin_marca'),
  (85, 'Terra Cotta Color Hardener 60lb Cub', 'Terra Cotta Color Hardener 60lb Cub', null, 'HARDENER SUPERSTONE', null, 0, 1924.13, 1673.1565, 0.15, 8, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (86, 'Ivory Sand Color Hardener 60lb Cub', 'Ivory Sand Color Hardener 60lb Cub', null, 'HARDENER SUPERSTONE', null, 0, 1924.13, 1673.1565, 0.15, 0, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (87, 'Almond Color Hardener 60lb Cub', 'Almond Color Hardener 60lb Cub', null, 'HARDENER SUPERSTONE', null, 0, 1924.13, 1673.1565, 0.15, 0, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (88, 'Eastern Tan Color Hardener 60lb Cub', 'Eastern Tan Color Hardener 60lb Cub', null, 'HARDENER SUPERSTONE', null, 0, 1924.13, 1673.1565, 0.15, 25, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (89, 'Charcoal Color Release 30lb Cub', 'Charcoal Charcoal Color Release 30lb Cub', null, 'RELEASE SUPERSTONE', null, 0, 3537.64, 3076.2087, 0.15, 16, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (90, 'Buff Color Release 30lb Cub', 'Buff Color Release 30lb Cub', null, 'RELEASE SUPERSTONE', null, 0, 3537.64, 3076.2087, 0.15, 5, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (91, 'Dark Brown Color Release 30lb Cub', 'Dark Brown Color Release 30lb Cub', null, 'RELEASE SUPERSTONE', null, 0, 3537.64, 3076.2087, 0.15, 4, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (92, 'ARRENDAMIENTO MAQUINARIAS MES DE', 'PRODUCCIÓN DE HELADOS Y CAFES INCLUYE:
MAQUINA COMBINADA Y 2 PASTEURIZADORA 
MAQUINA PROD. HELADO Y BLAST FREEZER
EXHIBIDORAS DE HELADO POZZETTI Y CORA PROG
CARRITO DE HELADO Y FREEZER 1 Y VERTICAL 			
REFRIGERADOR MAQUINA DE CAFE EXPOBAR', null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 72047.56, 62650.0522, 0.15, 0, true, -2147483648, true, true, 'costo_cero;existencia_negativa_a_cero;sin_marca'),
  (93, 'CLARO (LINEAS DE TELEFONO 60$)', null, null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 1725, 1500, 0.15, 0, true, -2147483648, true, true, 'costo_cero;existencia_negativa_a_cero;sin_marca'),
  (94, 'DOCUMENTOS, IMPRESIONES, ADMIN, TRANSP.', null, null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 8107.5, 7050, 0.15, 0, true, -2147483648, true, true, 'costo_cero;existencia_negativa_a_cero;sin_marca'),
  (95, 'Color Hardener Silver 60lb Cub', null, null, 'HARDENER SUPERSTONE', null, 0, 1924.13, 1673.1565, 0.15, 0, true, -2147483648, true, true, 'costo_cero;existencia_negativa_a_cero;sin_marca'),
  (96, 'Color Hardener Brownstone 60lb Cub', null, null, 'HARDENER SUPERSTONE', null, 0, 1924.13, 1673.1565, 0.15, 23, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (97, 'Color Hardener Oak 60lb Cub', null, null, 'HARDENER SUPERSTONE', null, 0, 1924.13, 1673.1565, 0.15, 5, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (98, 'Color Hardener LaCresenta 60lb Cub', null, null, 'HARDENER SUPERSTONE', null, 0, 1924.13, 1673.1565, 0.15, 2, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (99, 'Color Hardener Buff 60lb Cub', null, null, 'HARDENER SUPERSTONE', null, 0, 1924.13, 1673.1565, 0.15, 0, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (100, 'Brownstone Color Release 30lb Cub', null, null, 'RELEASE SUPERSTONE', null, 0, 3537.64, 3076.2087, 0.15, 1, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (101, 'Silver Color Release 30lb Cub', null, null, 'RELEASE SUPERSTONE', null, 0, 3537.64, 3076.2087, 0.15, 1, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (102, 'Clear Color Release 30lb Cub', null, null, 'RELEASE SUPERSTONE', 'Superstone Inc', 0, 3537.64, 3076.2087, 0.15, 2, true, -2147483648, true, true, 'costo_cero'),
  (103, 'Light Buff Color Release 30lb Cub', null, null, 'RELEASE SUPERSTONE', null, 0, 3537.64, 3076.2087, 0.15, 8, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (104, 'SOLVENTE BARRIL 55 GAL', null, null, 'MATERIALES', null, 0, 11553.46, 10046.487, 0.15, 0, true, -2147483648, true, true, 'costo_cero;existencia_negativa_a_cero;sin_marca'),
  (105, 'RESINA ACRILICA SOLIDA LB', null, null, 'MATERIALES', null, 0, 1.9, 1.6522, 0.15, 441, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (106, 'Cubeta Metal', null, null, 'MATERIALES', null, 0, 227.68, 197.9826, 0.15, 0, true, -2147483648, false, true, 'costo_cero;existencia_negativa_a_cero;sin_marca'),
  (107, 'Galon Metal', null, null, 'MATERIALES', null, 0, 33.89, 29.4696, 0.15, 0, true, -2147483648, false, true, 'costo_cero;existencia_negativa_a_cero;sin_marca'),
  (108, 'Epóxico Blanco en Flexo Packaging m2', null, null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 2709.4, 2356, 0.15, 0, true, -2147483648, true, true, 'costo_cero;existencia_negativa_a_cero;sin_marca'),
  (109, 'Dia de Alquiler de Moldes', 'Incluye 4 rigidos y 1 flexible', null, 'MOLDES', null, 0, 1513.14, 1315.7739, 0.15, 0, false, -2147483648, true, false, 'costo_cero;sin_marca'),
  (110, 'DISCO HIBRIDO 3" #50', null, null, 'PULIDO/DISCOS', 'DISERCO', 100.69, 253.83, 220.7217, 0.15, 0, true, -2147483648, true, true, 'existencia_negativa_a_cero'),
  (112, 'DISCO HIBRIDO 3" #200', null, null, 'PULIDO/DISCOS', 'DISERCO', 100.69, 253.83, 220.7217, 0.15, 0, true, -2147483648, true, true, null),
  (113, 'DISCO HIBRIDO 3" #100', null, null, 'PULIDO/DISCOS', 'DISERCO', 100.69, 253.83, 220.7217, 0.15, 180, true, -2147483648, true, true, null),
  (114, 'DISCO METAL 3" #30 HB', null, null, 'PULIDO/DISCOS', 'DISERCO', 537, 1353.72, 1177.1478, 0.15, 36, true, -2147483648, true, true, null),
  (115, 'DISCO METAL 3" #50 SB', null, null, 'PULIDO/DISCOS', 'DISERCO', 537, 1353.72, 1177.1478, 0.15, 0, true, -2147483648, true, true, null),
  (116, 'DISCO METAL 3" #50 MB', null, null, 'PULIDO/DISCOS', 'DISERCO', 537, 1353.72, 1177.1478, 0.15, 0, true, -2147483648, true, true, 'existencia_negativa_a_cero'),
  (117, 'DISCO METAL 3" #50 HB', null, null, 'PULIDO/DISCOS', 'DISERCO', 537, 1353.72, 1177.1478, 0.15, 0, true, -2147483648, true, true, null),
  (118, 'DISCO FLECHA 3" #30 MB', null, null, 'PULIDO/DISCOS', 'DISERCO', 151.03, 380.73, 331.0696, 0.15, 30, true, -2147483648, true, true, null),
  (119, 'PCD', null, null, 'PULIDO/DISCOS', 'DISERCO', 285.28, 719.16, 625.3565, 0.15, 54, true, -2147483648, true, true, null),
  (120, 'DISCO RESINA 3" #100', null, null, 'PULIDO/DISCOS', 'DISERCO', 117.47, 296.13, 257.5043, 0.15, 49, true, -2147483648, true, true, null),
  (121, 'DISCO RESINA 3" #200', null, null, 'PULIDO/DISCOS', 'DISERCO', 117.47, 296.13, 257.5043, 0.15, 90, true, -2147483648, true, true, null),
  (122, 'DISCO RESINA 3" #400', null, null, 'PULIDO/DISCOS', 'D. CONCRETO', 117.47, 296.13, 257.5043, 0.15, 65, true, -2147483648, true, true, null),
  (123, 'DISCO RESINA 3" #800', null, null, 'PULIDO/DISCOS', 'D. CONCRETO', 117.47, 296.13, 257.5043, 0.15, 0, true, -2147483648, true, true, 'existencia_negativa_a_cero'),
  (124, 'DISCO RESINA 3" #1500', null, null, 'PULIDO/DISCOS', 'D. CONCRETO', 117.47, 296.13, 257.5043, 0.15, 0, true, -2147483648, true, true, null),
  (125, 'DISCO RESINA 3" #3000', null, null, 'PULIDO/DISCOS', 'D. CONCRETO', 117.47, 296.13, 257.5043, 0.15, 2, true, -2147483648, true, true, null),
  (126, 'COPA FLECHA 7" #30', null, null, 'PULIDO/DISCOS', 'DISERCO', 1006.88, 2538.2, 2207.1304, 0.15, 35, true, -2147483648, true, true, null),
  (127, 'COPA FLECHA 7" #16', null, null, 'PULIDO/DISCOS', 'DISERCO', 1174.69, 2961.26, 2575.0087, 0.15, 13, true, -2147483648, true, true, null),
  (128, 'COPA FLECHA 7" #9', null, null, 'PULIDO/DISCOS', 'DISERCO', 1275.38, 3215.09, 2795.7304, 0.15, 16, true, -2147483648, true, true, null),
  (129, 'A CUALQUIER COSA NO EN LISTA', null, null, 'MATERIALES', null, 0, 0, 0, 0.15, 0, true, -2147483648, true, true, 'costo_cero;precio_cero;existencia_negativa_a_cero;sin_marca'),
  (130, 'Sellador con Color Cubeta', null, null, 'SELLADORES', null, 4000, 7494.92, 6517.3217, 0.15, 10, true, 0, true, true, 'sin_marca;compuesto_sin_componentes'),
  (131, 'NANO COLORANTE COPPER 609 GAL', 'Uso exterior e interior. Rinde 12m2', 'KS 609', 'COLORANTE LIQUIDO', 'KAIDA', 590.67, 1510.59, 1313.5565, 0.15, 20, true, -2147483648, true, true, 'compuesto_sin_componentes'),
  (132, 'NANO COLORANTE BRASS 604 GAL', 'Uso exterior e interior. Rinde 12m2', 'KS 604', 'COLORANTE LIQUIDO', 'KAIDA', 590.67, 1510.59, 1313.5565, 0.15, 20, true, -2147483648, true, true, 'compuesto_sin_componentes'),
  (133, 'NANO COLORANTE SILVER 617 GAL', 'Uso exterior e interior. Rinde 12m2', 'KS 617', 'COLORANTE LIQUIDO', 'KAIDA', 590.67, 1510.59, 1313.5565, 0.15, 20, true, -2147483648, true, true, 'compuesto_sin_componentes'),
  (134, 'NANO COLORANTE IRON 620 GAL', 'Uso exterior e interior. Rinde 12m2', 'KS 620', 'COLORANTE LIQUIDO', 'KAIDA', 590.67, 1510.59, 1313.5565, 0.15, 20, true, -2147483648, true, true, 'compuesto_sin_componentes'),
  (135, 'PRIMER Y TOP NANO COLORANT 1/2 GALON', 'rinde 20m2 1/2 de galon', null, 'COLORANTE LIQUIDO', 'KAIDA', 258.16, 660.23, 574.113, 0.15, 50, true, -2147483648, true, true, null),
  (136, 'COLORANT DYE CAMEL 003 GALON', 'Interiores y Pulido. 20m2', 'KD-003', 'COLORANTE LIQUIDO', 'KAIDA', 652.848, 1669.61, 1451.8348, 0.15, 15, true, -2147483648, true, true, null),
  (137, 'COLORANT DYE BROWN 005 GALON', 'Interiores y Pulido. 20m2', 'KD-005', 'COLORANTE LIQUIDO', 'KAIDA', 652.848, 1669.61, 1451.8348, 0.15, 15, true, -2147483648, true, true, null),
  (138, 'COLORANT DYE RED 007 GALON', 'Interiores y Pulido. 20m2', 'KD-007', 'COLORANTE LIQUIDO', 'KAIDA', 652.848, 1669.61, 1451.8348, 0.15, 10, true, -2147483648, true, true, null),
  (139, 'COLORANT DYE DARK GREEN 013 GALON', 'Interiores y Pulido. 20m2', 'KD-013', 'COLORANTE LIQUIDO', 'KAIDA', 652.848, 1669.61, 1451.8348, 0.15, 5, true, -2147483648, true, true, null),
  (140, 'COLORANT DYE LIGHT GRAY 018 GALON', 'Interiores y Pulido. 20m2', 'KD-018', 'COLORANTE LIQUIDO', 'KAIDA', 652.848, 1669.61, 1451.8348, 0.15, 15, true, -2147483648, true, true, null),
  (141, 'COLORANT DYE BLACK 020 GALON', 'Interiores y Pulido. 20m2', 'KD-020', 'COLORANTE LIQUIDO', 'KAIDA', 652.848, 1669.61, 1451.8348, 0.15, 15, true, -2147483648, true, true, null),
  (142, 'COLORANT DYE FIXER 1/2 GALON', 'Interiores y Pulido. 20m2', 'kdl', 'COLORANTE LIQUIDO', 'KAIDA', 220.41, 582.28, 506.3304, 0.15, 50, true, -2147483648, true, true, null),
  (143, 'Epóxico Quarzo AutonivelanteTop - Light Gray Kit', '10m2', 'E8308-1', 'RESINAS', 'JINYU', 3409.97, 7059.64, 6138.8174, 0.15, 5, true, -2147483648, true, true, null),
  (144, 'Epóxico Quarzo AutonivelanteTop - Dark Gray Kit', '10m2', 'E8308-3', 'RESINAS', 'JINYU', 3409.97, 7059.64, 6138.8174, 0.15, 3, true, -2147483648, true, true, null),
  (145, 'Epóxico Quarzo AutonivelanteTop - Ivory Kit', '10m2', 'E8308-11', 'RESINAS', 'JINYU', 3409.97, 7059.64, 6138.8174, 0.15, 3, true, -2147483648, true, true, null),
  (146, 'Granitex - Gray', 'Rinde 10m2', 'JD1013-3-ZQ44', 'MICROCEMENTO', 'JINYU', 748.06, 1913.09, 1663.5565, 0.15, 10, true, -2147483648, true, true, null),
  (147, 'Granitex - White', 'Rinde 10m2', 'JD1013-3-ZQ02', 'MICROCEMENTO', 'JINYU', 748.06, 1913.09, 1663.5565, 0.15, 9, true, -2147483648, true, true, null),
  (148, 'Granitex - Gold', 'Rinde 10m2', 'JD1013-3-ZQ25', 'MICROCEMENTO', 'JINYU', 748.06, 1913.09, 1663.5565, 0.15, 7, true, -2147483648, true, true, null),
  (149, 'Sellador Granitex Matte Pared 1/2 Galon', 'Rinde 12m2 aprox el medio galon', 'JD5001', 'MICROCEMENTO', 'JINYU', 174.87, 447.22, 388.887, 0.15, 49, true, -2147483648, true, true, null),
  (150, 'Primer Granitex Pared 1/2 Galon', '16m2 el galon', 'KDJD4009', 'MICROCEMENTO', 'KAIDA', 145.725, 372.68, 324.0696, 0.15, 19, true, -2147483648, true, true, null),
  (151, 'Sellador Base Agua Brillante Cubeta', '100m2 por cubeta', 'KD-LT-S', 'SELLADORES', 'CONCRETE SYSTEMS', 2564.76, 6559.18, 5703.6348, 0.15, 10, true, -2147483648, true, true, null),
  (152, 'DISCO METAL 3" #70', 'METAL', null, 'PULIDO/DISCOS', 'D. CONCRETO', 537, 1353.72, 1177.1478, 0.15, 41, true, -2147483648, true, true, null),
  (153, 'MOLDE MAJESTIC 90X90CM RIGIDO', '6KG', 'YX044', 'MOLDES', 'CONCRETE SYSTEMS', 2448.18, 6261.02, 5444.3652, 0.15, 2, true, -2147483648, true, false, null),
  (154, 'MOLDE EUROPEAN FAN 64X113CM RIGIDO', '6KG', 'YX228', 'MOLDES', 'CONCRETE SYSTEMS', 2448.18, 6261.02, 5444.3652, 0.15, 0, true, -2147483648, true, false, null),
  (155, 'MOLDE FRESH BRICK 107X120CM RIGIDO', '6KG', 'YX334', 'MOLDES', 'CONCRETE SYSTEMS', 3264.24, 8348.04, 7259.1652, 0.15, 0, true, -2147483648, true, false, null),
  (156, 'MOLDE ASHLAR SLATE JUEGO DE 4 RIGIDOS', null, null, 'MOLDES', 'D. CONCRETO', 9380, 16362.16, 14227.9652, 0.15, 1, true, -2147483648, true, false, null),
  (157, 'MOLDE RANDOM STONE 74X74CM RIGIDO', '6KG', 'YX145', 'MOLDES', 'CONCRETE SYSTEMS', 1632.12, 4174.02, 3629.5826, 0.15, 0, true, -2147483648, true, false, null),
  (158, 'ZOCALO MILAN GRAY 2.5ML CLIP-ON', null, null, 'ZOCALOS', 'CONCRETE SYSTEMS', 124.35, 302.87, 263.3652, 0.15, 109, true, -2147483648, true, true, null),
  (159, 'ZOCALO CLASSIC BLACK 2.5ML BUCKLE', null, null, 'ZOCALOS', 'CONCRETE SYSTEMS', 124.35, 302.87, 263.3652, 0.15, 17, true, -2147483648, true, true, null),
  (160, 'ZOCALO CHAMPAGNE 2.5ML GLUE-ON', null, null, 'ZOCALOS', 'CONCRETE SYSTEMS', 114.64, 279.22, 242.8, 0.15, 119, true, -2147483648, true, true, null),
  (161, 'ZOCALO SILVER 2.5ML GLUE-ON', null, null, 'ZOCALOS', 'CONCRETE SYSTEMS', 114.64, 279.22, 242.8, 0.15, 70, true, -2147483648, true, true, null),
  (162, 'ACCESORIO - MILAN GRAY - ESQUINA INTERNA', null, null, 'ZOCALOS', 'CONCRETE SYSTEMS', 7.772, 18.93, 16.4609, 0.15, 236, true, -2147483648, true, true, null),
  (163, 'ACCESORIO - MILAN GRAY - ESQUINA EXTERNA', null, null, 'ZOCALOS', 'CONCRETE SYSTEMS', 7.772, 18.93, 16.4609, 0.15, 158, true, -2147483648, true, true, null),
  (164, 'ACCESORIO - MILAN GRAY - TAPA DERECHA', null, null, 'ZOCALOS', 'CONCRETE SYSTEMS', 7.772, 18.93, 16.4609, 0.15, 112, true, -2147483648, true, true, null),
  (165, 'ACCESORIO - MILAN GRAY - TAPA IZQUIERDA', null, null, 'ZOCALOS', 'CONCRETE SYSTEMS', 7.772, 18.93, 16.4609, 0.15, 112, true, -2147483648, true, true, null),
  (166, 'ACCESORIO - MILAN GRAY - CONECTOR', null, null, 'ZOCALOS', 'CONCRETE SYSTEMS', 7.772, 18.93, 16.4609, 0.15, 150, true, -2147483648, true, true, null),
  (167, 'ACCESORIO - CLASSIC BLACK - ESQUINA INTERNA', null, null, 'ZOCALOS', 'CONCRETE SYSTEMS', 7.772, 18.93, 16.4609, 0.15, 4, true, -2147483648, true, true, null),
  (168, 'ACCESORIO - CLASSIC BLACK  - ESQUINA EXTERNA', null, null, 'ZOCALOS', 'CONCRETE SYSTEMS', 7.772, 18.93, 16.4609, 0.15, 26, true, -2147483648, true, true, null),
  (169, 'ACCESORIO - CLASSIC BLACK  - TAPA DERECHA', null, null, 'ZOCALOS', 'CONCRETE SYSTEMS', 7.772, 18.93, 16.4609, 0.15, 41, true, -2147483648, true, true, null),
  (170, 'ACCESORIO - CLASSIC BLACK  - TAPA IZQUIERDA', null, null, 'ZOCALOS', 'CONCRETE SYSTEMS', 7.772, 18.93, 16.4609, 0.15, 0, true, -2147483648, true, true, 'existencia_negativa_a_cero'),
  (171, 'ACCESORIO - CLASSIC BLACK  - CONECTOR', null, null, 'ZOCALOS', 'CONCRETE SYSTEMS', 7.772, 18.93, 16.4609, 0.15, 10, true, -2147483648, true, true, null),
  (172, 'ACCESORIO - CHAMPAGNE - ESQUINA INTERNA', null, null, 'ZOCALOS', 'CONCRETE SYSTEMS', 7.772, 18.93, 16.4609, 0.15, 120, true, -2147483648, true, true, null),
  (173, 'ACCESORIO - CHAMPAGNE - ESQUINA EXTERNA', null, null, 'ZOCALOS', 'CONCRETE SYSTEMS', 7.772, 18.93, 16.4609, 0.15, 75, true, -2147483648, true, true, null),
  (174, 'ACCESORIO - CHAMPAGNE - CONECTOR', null, null, 'ZOCALOS', 'CONCRETE SYSTEMS', 7.772, 18.93, 16.4609, 0.15, 100, true, -2147483648, true, true, null),
  (175, 'ACCESORIO - CHAMPAGNE - TAPA DERECHA', null, null, 'ZOCALOS', 'CONCRETE SYSTEMS', 7.772, 18.93, 16.4609, 0.15, 69, true, -2147483648, true, true, null),
  (176, 'ACCESORIO - CHAMPAGNE - TAPA IZQUIERDA', null, null, 'ZOCALOS', 'CONCRETE SYSTEMS', 7.772, 18.93, 16.4609, 0.15, 69, true, -2147483648, true, true, null),
  (177, 'ACCESORIO - SILVER - ESQUINA EXTERNA', null, null, 'ZOCALOS', 'CONCRETE SYSTEMS', 7.772, 18.93, 16.4609, 0.15, 44, true, -2147483648, true, true, null),
  (178, 'ACCESORIO - SILVER - ESQUINA INTERNA', null, null, 'ZOCALOS', 'CONCRETE SYSTEMS', 7.772, 18.93, 16.4609, 0.15, 70, true, -2147483648, true, true, null),
  (179, 'ACCESORIO -  SILVER - TAPA IZQUIERDA', null, null, 'ZOCALOS', 'CONCRETE SYSTEMS', 7.772, 18.93, 16.4609, 0.15, 49, true, -2147483648, true, true, null),
  (180, 'ACCESORIO - SILVER - TAPA DERECHA', null, null, 'ZOCALOS', 'CONCRETE SYSTEMS', 7.772, 18.93, 16.4609, 0.15, 44, true, -2147483648, true, true, null),
  (181, 'ACCESORIO - SILVER - CONECTOR', null, null, 'ZOCALOS', 'CONCRETE SYSTEMS', 7.772, 18.93, 16.4609, 0.15, 65, true, -2147483648, true, true, null),
  (182, 'BUCKLE PARED ZOCALO CLASSIC BLACK 2.5ML', 'Parte de pared', null, 'ZOCALOS', 'CONCRETE SYSTEMS', 0, 5.29, 4.6, 0.15, 479, true, -2147483648, true, true, 'costo_cero'),
  (183, 'CLIP PARED ZOCALO MILAN GRAY 2.5ML', 'Parte de pared', null, 'ZOCALOS', 'CONCRETE SYSTEMS', 0, 5.29, 4.6, 0.15, 996, true, -2147483648, true, true, 'costo_cero'),
  (184, 'Velcro Hembra 4 pulg. 6ml', 'Ysibbon', null, 'PULIDO/DISCOS', null, 739.75, 1351.32, 1175.0609, 0.15, 1, true, -2147483648, true, true, 'sin_marca'),
  (185, 'Velcro Macho 4 pulg. 6ml', 'Ysibbon', null, 'PULIDO/DISCOS', null, 739.75, 1351.32, 1175.0609, 0.15, 0, true, -2147483648, true, true, 'existencia_negativa_a_cero;sin_marca'),
  (186, 'SACO 25KG COLOR HARDENER TERRACOTTA', 'RINDE', null, 'COLOR HARDENER CS NUEVO', 'CONCRETE SYSTEMS', 359.46, 1313.28, 1141.9826, 0.15, 50, true, -2147483648, true, true, null),
  (187, 'SACO 25KG COLOR HARDENER IVORY SAND', 'RINDE', null, 'COLOR HARDENER CS NUEVO', 'CONCRETE SYSTEMS', 359.46, 1313.28, 1141.9826, 0.15, 26, true, -2147483648, true, true, null),
  (188, 'SACO 25KG COLOR HARDENER SILVER', 'RINDE', null, 'COLOR HARDENER CS NUEVO', 'CONCRETE SYSTEMS', 359.46, 1313.28, 1141.9826, 0.15, 0, true, -2147483648, true, true, 'existencia_negativa_a_cero'),
  (189, 'SACO 25KG COLOR HARDENER OAK', 'RINDE', null, 'COLOR HARDENER CS NUEVO', 'CONCRETE SYSTEMS', 359.46, 1313.28, 1141.9826, 0.15, 40, true, -2147483648, true, true, null),
  (190, 'SACO 25KG COLOR HARDENER FRENCH GRAY', 'RINDE', null, 'COLOR HARDENER CS NUEVO', 'CONCRETE SYSTEMS', 359.46, 1313.28, 1141.9826, 0.15, 0, true, -2147483648, true, true, null),
  (191, 'SACO 25KG COLOR HARDENER EASTERN TAN', 'RINDE', null, 'COLOR HARDENER CS NUEVO', 'CONCRETE SYSTEMS', 359.46, 1313.28, 1141.9826, 0.15, 86, true, -2147483648, true, true, null),
  (192, 'SACO 15KG COLOR RELEASE CHARCOAL', null, null, 'COLOR RELEASE CS NUEVO', 'CONCRETE SYSTEMS', 618, 1867.82, 1624.1913, 0.15, 1, true, -2147483648, true, true, null),
  (193, 'SACO 15KG COLOR RELEASE DARK BROWN', null, null, 'COLOR RELEASE CS NUEVO', 'CONCRETE SYSTEMS', 466.32, 1867.82, 1624.1913, 0.15, 5, true, -2147483648, true, true, null),
  (194, 'SACO 15KG COLOR RELEASE BUFF', null, null, 'COLOR RELEASE CS NUEVO', 'CONCRETE SYSTEMS', 466.32, 1867.82, 1624.1913, 0.15, 4, true, -2147483648, true, true, null),
  (195, 'MOLDE ABANICO CIRCULAR', null, null, 'MOLDES', 'Superstone Inc', 4994.1, 9122.87, 7932.9304, 0.15, 3, true, -2147483648, true, false, null),
  (196, 'MOLDE MAJESTIC', null, null, 'MOLDES', 'Superstone Inc', 4994.1, 10600.12, 9217.4957, 0.15, 7, true, -2147483648, true, false, null),
  (197, 'MOLDE RANDOM STONE', null, null, 'MOLDES', 'Superstone Inc', 4994.1, 9122.87, 7932.9304, 0.15, 5, true, -2147483648, true, false, null),
  (198, 'MOLDE ASHLAR', null, null, 'MOLDES', 'Superstone Inc', 4994.1, 9122.87, 7932.9304, 0.15, 2, true, -2147483648, true, false, null),
  (199, 'MOLDE BANDA GRANDE', null, null, 'MOLDES', 'Superstone Inc', 4994.1, 8063.9, 7012.087, 0.15, 1, true, -2147483648, true, false, null),
  (200, 'MOLDE COBBLESTONE', null, null, 'MOLDES', 'Superstone Inc', 4994.1, 9122.87, 7932.9304, 0.15, 2, true, -2147483648, true, false, null),
  (201, 'TAMPER / APISONADOR', null, null, 'MOLDES', 'Superstone Inc', 4994.1, 8699.28, 7564.5913, 0.15, 1, true, -2147483648, true, false, null),
  (202, 'NSS DENSIFICADOR HIBRIDO CUBETA', 'DILUIR CON AGUA 4:1 . RINDE HASTA 2000M2', null, 'PULIDO/DISCOS', 'DISERCO', 0, 16207.99, 14093.9043, 0.15, 0, true, -2147483648, true, true, 'costo_cero'),
  (203, 'SR2 AMERIPOLYSH CUBETA', null, null, 'PULIDO/DISCOS', 'DISERCO', 0, 44505.74, 38700.6435, 0.15, 1, true, 0, true, true, 'costo_cero'),
  (204, 'Decco Oxytop kit', null, null, 'MICROCEMENTO', null, 0, 12501.16, 10870.5739, 0.15, 5, true, 0, true, true, 'costo_cero;sin_marca'),
  (206, 'MOLDE USADO CERAMIC TILE RIGIDO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 11, true, -2147483648, true, false, 'costo_cero'),
  (207, 'MOLDE USADO EUROPEAN FAN RIGIDO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10441.75, 9079.7826, 0.15, 4, true, -2147483648, true, false, 'costo_cero'),
  (208, 'MOLDE USADO CERAMIC WEAVE RIGIDO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 9, true, -2147483648, true, false, 'costo_cero'),
  (209, 'MOLDE USADO HEXAGON RIGIDO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 17, true, -2147483648, true, false, 'costo_cero'),
  (210, 'MOLDE USADO PROLINE NAT BRICK RIGIDO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 6, true, -2147483648, true, false, 'costo_cero'),
  (211, 'MOLDE USADO BANDA GRANDE RIGIDO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 1, true, -2147483648, true, false, 'costo_cero'),
  (212, 'MOLDE USADO FRESH BRICK RIGIDO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 4, true, -2147483648, true, false, 'costo_cero'),
  (213, 'MOLDE USADO WATERDROP RIGIDO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 4, true, -2147483648, true, false, 'costo_cero'),
  (214, 'MOLDE USADO COBBLESTONE RIGIDO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 7, true, -2147483648, true, false, 'costo_cero'),
  (215, 'MOLDE USADO ASHLAR SLATE RIGIDO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 5, true, -2147483648, true, false, 'costo_cero'),
  (216, 'MOLDE USADO RODILLO PEQUENO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 1, true, -2147483648, true, false, 'costo_cero'),
  (217, 'MOLDE USADO RODILLO GRANDE', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 1, true, -2147483648, true, false, 'costo_cero'),
  (219, 'MOLDE USADO BORDE DELGADO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 2, true, -2147483648, true, false, 'costo_cero'),
  (220, 'MOLDE USADO LARGE TILE CUADRO RIGIDO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 3, true, -2147483648, true, false, 'costo_cero'),
  (221, 'MOLDE USADO RED TILE RIGIDO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 5, true, -2147483648, true, false, 'costo_cero'),
  (222, 'MOLDE USADO TILE 2 RIGIDO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 4, true, -2147483648, true, false, 'costo_cero'),
  (223, 'MOLDE USADO RANDOM STONE RIGIDO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 2, true, -2147483648, true, false, 'costo_cero'),
  (224, 'MOLDE USADO BANDA GRANDE 2 RIGIDO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 4, true, -2147483648, true, false, 'costo_cero'),
  (225, 'MOLDE USADO OCEAN', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 1, true, -2147483648, true, false, 'costo_cero'),
  (226, 'MOLDE USADO OCEAN PELLEJO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 2, true, -2147483648, true, false, 'costo_cero'),
  (227, 'MOLDE USADO SAND PELLEJO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 6, true, -2147483648, true, false, 'costo_cero'),
  (228, 'MOLDE USADO TIPO MADERA PEQUENO RIGIDO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 0, true, -2147483648, true, false, 'costo_cero'),
  (229, 'MOLDE USADO TIPO MADERA MEDIANO RIGIDO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 0, true, -2147483648, true, false, 'costo_cero'),
  (230, 'MOLDE USADO TIPO MADERA GRANDE RIGIDO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 2, true, -2147483648, true, false, 'costo_cero'),
  (231, 'Dia de Alquiler de Moldes Usados', null, null, 'ALQUILER Y MOLDES USADOS', 'DISERCO', 0, 1480, 1286.9565, 0.15, 0, true, -2147483648, true, false, 'costo_cero'),
  (232, 'MOLDE USADO LARGE TILE RECTANGULO RIGIDO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 3, true, -2147483648, true, false, 'costo_cero'),
  (233, 'MOLDE ASHLAR SLATE 59X59CM RIGIDO', 'NUEVO', null, 'MOLDES', 'CONCRETE SYSTEMS', 1632, 4173.71, 3629.313, 0.15, 0, true, -2147483648, true, false, null),
  (235, 'MOLDE USADO CERAMIC TILE FLEX', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 2, true, -2147483648, true, false, 'costo_cero'),
  (236, 'MOLDE USADO EUROPEAN FAN FLEX', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10441.75, 9079.7826, 0.15, 1, true, -2147483648, true, false, 'costo_cero'),
  (237, 'MOLDE USADO CERAMIC WEAVE FLEX', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 1, true, -2147483648, true, false, 'costo_cero'),
  (238, 'MOLDE USADO HEXAGON FLEX', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 2, true, -2147483648, true, false, 'costo_cero'),
  (239, 'MOLDE USADO PROLINE NAT BRICK FLEX', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 1, true, -2147483648, true, false, 'costo_cero'),
  (240, 'MOLDE USADO BANDA GRANDE FLEX', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 1, true, -2147483648, true, false, 'costo_cero'),
  (241, 'MOLDE USADO ASHLAR SLATE FLEX', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 1, true, -2147483648, true, false, 'costo_cero'),
  (242, 'MOLDE USADO BANDA GRANDE 2 FLEX', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 1, true, -2147483648, true, false, 'costo_cero'),
  (243, 'MOLDE USADO RED TILE FLEX', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 1, true, -2147483648, true, false, 'costo_cero'),
  (244, 'MOLDE USADO TILE 2 FLEX', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 1, true, -2147483648, true, false, 'costo_cero'),
  (245, 'MOLDE USADO RANDOM STONE FLEX', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 1, true, -2147483648, true, false, 'costo_cero'),
  (246, 'MOLDE USADO TIPO MADERA PEQUENO FLEX', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 1, true, -2147483648, true, false, 'costo_cero'),
  (247, 'MOLDE USADO TIPO MADERA MEDIANO FLEX', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 1, true, -2147483648, true, false, 'costo_cero'),
  (248, 'MOLDE USADO TIPO MADERA GRANDE FLEX', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 1, true, -2147483648, true, false, 'costo_cero'),
  (249, 'MOLDE USADO BANDA PEQUENA', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 0, 0, 0.15, 4, true, -2147483648, true, false, 'costo_cero;precio_cero'),
  (250, 'Epóxico Autonivelante Topcoat Kit 5:1 Gris', '24m2', 'E8300', 'RESINAS', 'JINYU', 3320.2, 8491.15, 7383.6087, 0.15, 8, true, -2147483648, true, true, null),
  (251, 'Epóxico Autonivelante Topcoat Kit 5:1 Blanco', '10m2', null, 'RESINAS', 'JINYU', 3320.2, 8491.15, 7383.6087, 0.15, 7, true, -2147483648, true, true, null),
  (252, 'Epóxico Autonivelante Topcoat Kit 5:1 Amarillo', '10m2', null, 'RESINAS', 'JINYU', 3320.2, 8491.15, 7383.6087, 0.15, 7, true, -2147483648, true, true, null),
  (253, 'Epóxico Autonivelante Topcoat Kit 5:1 Verde', '10m2', null, 'RESINAS', 'JINYU', 3320.2, 8491.15, 7383.6087, 0.15, 7, true, -2147483648, true, true, null),
  (254, 'POLIURETANO LIBRE DE SOLVENTE KIT GRIS 5:2:1', '100M2', 'PU3600', 'RESINAS', 'JINYU', 4049.21, 10355.54, 9004.8174, 0.15, 15, true, -2147483648, true, true, null),
  (255, 'CEMENT GLUE CUBETA 25KG', null, null, 'PULIDO/DISCOS', 'KAIDA', 1923.57, 4919.38, 4277.7217, 0.15, 4, true, -2147483648, true, true, null),
  (256, 'STAIN RESISTOR CUBETA', null, null, 'PULIDO/DISCOS', 'KAIDA', 2051.81, 5247.34, 4562.9043, 0.15, 3, true, -2147483648, true, true, null),
  (257, 'FELPA P/BURNISH 27"', null, null, 'PULIDO/DISCOS', 'CONCRETE SYSTEMS', 938, 1827.7, 1589.3043, 0.15, 2, true, -2147483648, true, true, null),
  (258, 'MOLDE MAJESTIC 90X90CM FLEX', '6KG', null, 'MOLDES', 'CONCRETE SYSTEMS', 2448.18, 6261.02, 5444.3652, 0.15, 1, true, -2147483648, true, false, null),
  (259, 'MOLDE EUROPEAN FAN 64X113CM FLEX', '6KG', null, 'MOLDES', 'CONCRETE SYSTEMS', 2448.18, 6261.02, 5444.3652, 0.15, 0, true, -2147483648, true, false, null),
  (260, 'MOLDE FRESH BRICK 107X120CM FLEX', '6KG', null, 'MOLDES', 'CONCRETE SYSTEMS', 3264.24, 8348.04, 7259.1652, 0.15, 0, true, -2147483648, true, false, null),
  (261, 'MOLDE RANDOM STONE 74X74CM FLEX', '6KG', null, 'MOLDES', 'CONCRETE SYSTEMS', 1632.12, 4174.02, 3629.5826, 0.15, 1, true, -2147483648, true, false, null),
  (262, 'MOLDE ASHLAR SLATE 59X59CM FLEX', 'NUEVO', null, 'MOLDES', 'CONCRETE SYSTEMS', 1632, 4173.71, 3629.313, 0.15, 0, true, -2147483648, true, false, null),
  (263, 'MOLDE USADO DELFIN PELLEJO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 0, true, -2147483648, true, false, 'costo_cero'),
  (264, 'MOLDE USADO UVAS PELLEJO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 0, true, -2147483648, true, false, 'costo_cero'),
  (265, 'MOLDE USADO 1 TIRA MADERA PELLEJO', null, null, 'ALQUILER Y MOLDES USADOS', 'Superstone Inc', 0, 10401.75, 9045, 0.15, 0, true, -2147483648, true, false, 'costo_cero'),
  (266, 'MOLDE PELLEJO TEXTURA', null, null, 'MOLDES', 'Superstone Inc', 1632.12, 4174.02, 3629.5826, 0.15, 0, true, -2147483648, true, false, null),
  (267, 'LIBRA CHIPS COYOTE 1/4', 'CAJA TRAE 40LBS', null, 'RESINAS', 'D. CONCRETO', 3484, 8485.8, 7378.9565, 0.15, 103.975, true, -2147483648, true, true, null),
  (268, 'LIBRA CHIPS ORBIT 1/4', 'CAJA TRAE 40 LIBRAS', null, 'RESINAS', 'D. CONCRETO', 3484, 8485.8, 7378.9565, 0.15, 218.975, true, -2147483648, true, true, null),
  (269, 'LIBRA CHIPS DOMINO 1/4', 'CAJA TRAE 40 LIBRAS', null, 'RESINAS', 'D. CONCRETO', 3484, 8485.8, 7378.9565, 0.15, 235.475, true, -2147483648, true, true, null),
  (270, 'LIBRA CHIPS FEATHER GRAY 1/4', 'CAJA TRAE 40 LIBRAS', null, 'RESINAS', 'D. CONCRETO', 3484, 8485.8, 7378.9565, 0.15, 220.975, true, -2147483648, true, true, null),
  (271, 'LIBRA CHIPS CREEKBED 1/4', 'CAJA TRAE 40 LIBRAS', null, 'RESINAS', 'D. CONCRETO', 3484, 8485.8, 7378.9565, 0.15, 127.975, true, -2147483648, true, true, null),
  (272, 'LIBRA CHIPS TIDAL WAVE 1/4', 'CAJA TRAE 40 LIBRAS', null, 'RESINAS', 'D. CONCRETO', 3484, 8485.8, 7378.9565, 0.15, 107.975, true, -2147483648, true, true, null),
  (273, 'LIBRA CHIPS SHORELINE 1/4', 'CAJA TRAE 40 LIBRAS', null, 'RESINAS', 'D. CONCRETO', 3484, 8485.8, 7378.9565, 0.15, 104.975, true, -2147483648, true, true, null),
  (274, 'LIBRA CHIPS STONEWASH 1/16', 'CAJA TRAE 40 LIBRAS', null, 'RESINAS', 'D. CONCRETO', 3484, 8485.77, 7378.9304, 0.15, 0, true, -2147483648, true, true, null),
  (275, 'LIBRA CHIPS CREEKBED 1/16', 'CAJA TRAE 40 LIBRAS', null, 'RESINAS', 'D. CONCRETO', 3484, 8485.77, 7378.9304, 0.15, 0, true, -2147483648, true, true, null),
  (276, 'TONER CHARCOAL', null, null, 'COLORANTE LIQUIDO', 'Superstone Inc', 3296.4, 4014.42, 3490.8, 0.15, 5, true, -2147483648, true, true, null),
  (277, 'Indutape Amarilla 2" Rollo 30ml', null, null, 'PULIDO/DISCOS', 'D. CONCRETO', 920.98, 2854.08, 2481.8087, 0.15, 0, true, -2147483648, true, true, null),
  (278, 'Indutape Amarilla 4" Rollo 30ml', null, null, 'PULIDO/DISCOS', 'D. CONCRETO', 1799.22, 4820.48, 4191.7217, 0.15, 5, true, -2147483648, true, true, null),
  (279, 'Indutape Cebra 3" Rollo 30ml', null, null, 'PULIDO/DISCOS', 'D. CONCRETO', 2477.33, 5128.8, 4459.8261, 0.15, 12, true, -2147483648, true, true, null),
  (280, 'Indutape Azul 2" Rollo 30ml', null, null, 'PULIDO/DISCOS', 'D. CONCRETO', 920.98, 2854.08, 2481.8087, 0.15, 30, true, -2147483648, true, true, null),
  (281, 'Magic Squeegee - Espátula', null, null, 'HERRAMIENTAS', 'CONCRETE SYSTEMS', 0, 3959.62, 3443.1478, 0.15, 0, true, -2147483648, true, false, 'costo_cero'),
  (282, 'Cutting Shroud - Protector de Corte', null, null, 'HERRAMIENTAS', 'CONCRETE SYSTEMS', 1527.33, 3720.03, 3234.8087, 0.15, 1, true, -2147483648, true, false, null),
  (283, 'Pulidora de Orillas', null, null, 'HERRAMIENTAS', 'CONCRETE SYSTEMS', 12473.66, 22786.01, 19813.9217, 0.15, 1, true, -2147483648, true, false, null),
  (284, 'LLANA DE MANO CURVA GRANDE', null, null, 'HERRAMIENTAS', null, 0, 720.1, 626.1739, 0.15, 7, true, -2147483648, true, false, 'costo_cero;sin_marca'),
  (285, 'LLANA DE MANO CURVA MEDIANA', null, null, 'HERRAMIENTAS', null, 0, 614.2, 534.087, 0.15, 2, true, -2147483648, true, false, 'costo_cero;sin_marca'),
  (286, 'LLANA DE MANO CURVA PEQUEÑA', null, null, 'HERRAMIENTAS', null, 0, 476.54, 414.3826, 0.15, 4, true, -2147483648, true, false, 'costo_cero;sin_marca'),
  (287, 'Pumast 600 Salchicha 600 ml', null, null, 'BAUMERK', null, 0, 273.86, 238.1391, 0.15, 0, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (288, 'PUR 625 Lata de 25 kg', null, null, 'BAUMERK', null, 0, 7099.27, 6173.2783, 0.15, 0, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (289, 'PUR 220 UV Kit 20 Kg', null, null, 'BAUMERK', null, 0, 12918.31, 11233.313, 0.15, 0, true, -2147483648, true, true, 'costo_cero;existencia_negativa_a_cero;sin_marca'),
  (290, 'Epox 305 Kit 1 Kg', null, null, 'BAUMERK', null, 0, 453.33, 394.2, 0.15, 0, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (291, 'Epox 305 Kit 5 Kg', null, null, 'BAUMERK', null, 0, 1962.46, 1706.487, 0.15, 0, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (292, 'Epox 311 Kit 1 Kg', null, null, 'BAUMERK', null, 0, 732.73, 637.1565, 0.15, 0, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (293, 'Epox 311 Kit 7.5 Kg', null, null, 'BAUMERK', null, 0, 4837.63, 4206.6348, 0.15, 0, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (294, 'Selfing 600 Bolsa 25 Kg', null, null, 'BAUMERK', null, 0, 903.61, 785.7478, 0.15, 0, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (295, 'Epox PR 300 Kit 20 Kg', null, null, 'BAUMERK', null, 0, 14002.06, 12175.7043, 0.15, 0, true, -2147483648, true, true, 'costo_cero;existencia_negativa_a_cero;sin_marca'),
  (296, 'Epox FL 700 gris 7035, Kit 20 Kg', null, null, 'BAUMERK', null, 0, 10349.86, 8999.8783, 0.15, 0, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (297, 'Epox FL 700 rojo 300G Kit 20 Kg', null, null, 'BAUMERK', null, 0, 11169.09, 9712.2522, 0.15, 0, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (298, 'Epox FL 700 amarillo 1023 Kit 20 Kg', null, null, 'BAUMERK', null, 0, 11371.74, 9888.4696, 0.15, 0, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (299, 'Epox FL 700 blanco G003 Kit 20 Kg', null, null, 'BAUMERK', null, 0, 11085.06, 9639.1826, 0.15, 0, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (300, 'Epox SL 800 gris 7035 Kit 15 Kg', null, null, 'BAUMERK', null, 0, 9267.82, 8058.9739, 0.15, 0, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (301, 'Epox SL 800 blanco G010 kit 15 Kg', null, null, 'BAUMERK', null, 0, 9844.86, 8560.7478, 0.15, 0, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (302, 'Epox SL 800 negro G005 Kit 15 Kg', null, null, 'BAUMERK', null, 0, 10293.55, 8950.913, 0.15, 0, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (303, 'Purself 201 Kit 20 Kg', null, null, 'BAUMERK', null, 0, 7538.38, 6555.113, 0.15, 0, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (304, 'Fibermesh m2', null, null, 'BAUMERK', null, 0, 39.13, 34.0261, 0.15, 0, true, -2147483648, true, true, 'costo_cero;sin_marca'),
  (305, 'SIMGUARD 5GAL', null, null, 'RESINAS', null, 8902.96, 19452.97, 16915.6261, 0.15, 1, true, -2147483648, true, true, 'sin_marca'),
  (306, 'REBAJA DE DAÑOS A MUEBLE 60%', null, null, 'SERVICIO DE CONSTRUCCIÓN', null, 0, 0, 0, 0.15, 0, true, -2147483648, true, true, 'costo_cero;precio_cero;sin_marca');

insert into pos.productos (id, empresa_id, codigo_barras, nombre, descripcion, categoria_id, precio, impuesto_tasa, exento, tipo, unidad, stock_minimo, orden, activo, disponible)
select md5('diserco-wizpos-' || s.idw)::uuid, e.id, s.barras, s.nombre, s.descripcion, c.id, s.con_isv, s.tasa, false, 'simple', 'unidad', s.minimo, s.idw, true, s.venta
from _dis_semilla s join core.empresas e on e.codigo = 'diserco'
left join pos.categorias c on c.empresa_id = e.id and c.nombre = s.categoria
where not exists (select 1 from pos.productos x where x.id = md5('diserco-wizpos-' || s.idw)::uuid)
  and not exists (select 1 from pos.productos x where x.empresa_id = e.id and x.codigo_barras = s.barras and s.barras is not null);

insert into dis.producto_ext (producto_id, empresa_id, marca, presentacion, consumible, controla_inventario, precio_sin_isv, costo_estandar, id_origen_wizpos, alerta)
select p.id, p.empresa_id, s.marca, s.descripcion, s.consumible, s.controla, s.sin_isv, s.costo, s.idw, s.alerta
from _dis_semilla s join pos.productos p on p.id = md5('diserco-wizpos-' || s.idw)::uuid
on conflict (producto_id) do nothing;

insert into dis.movimientos (empresa_id, producto_id, tipo, cantidad, costo_unitario, motivo)
select p.empresa_id, p.id, 'inicial', s.existencia, s.costo, 'Existencia inicial (importada de WizPOS)'
from _dis_semilla s join pos.productos p on p.id = md5('diserco-wizpos-' || s.idw)::uuid
where s.existencia > 0 and s.controla
  and not exists (select 1 from dis.movimientos m where m.producto_id = p.id and m.tipo = 'inicial');
drop table _dis_semilla;

-- Clientes de DISERCO (directorio común del grupo; se omiten los RTN que ya existen)
insert into core.terceros (nombre, rtn, direccion, telefono, correo, es_cliente)
select v.nombre, v.rtn, v.dir, v.tel, v.correo, true from (values
  ('ANGEL TURCIOS', '08011976115813', null, null, null),
  ('ANTARES Y ASOCIADOS S DE R.L DE C.V.', '05029014645575', null, null, null),
  ('BOOC S de RL', '05019016891301', null, null, null),
  ('CINPRO', '05019019158332', null, null, null),
  ('CLINICAS MELENDEZ S. DE R.L.', '05019022450080', null, null, null),
  ('COMPAÑÍA AVÍCOLA DE CENTRO AMÉRICA, S. DE R. L. (CADECA)', '18019003259634', 'Santa Cruz de Yojoa', null, null),
  ('CONATLA', '05019005013728', null, null, null),
  ('CONSTRUCION COMERCIAL VILLA', '03181989017003', null, null, null),
  ('CONSTRUCTORA BETEL', '05019020215952', null, null, null),
  ('CONSTRUCTORA INGENIUM S. DE R.L.', '08019018064932', 'LA PAZ', null, null),
  ('CONSTRUCTORA OMAR ABUFFELE S DE R.L DE C.V.', '05019025271305', null, null, null),
  ('CONSTRUCTORA ROMERO Y ASOCIADOS', '05019019129794', null, null, null),
  ('CONSTRUDECO', '16011987007637', null, null, null),
  ('CONSTRUYAA', '08019020189883', null, null, null),
  ('CONSTRUYE S.A. DE C.V.', '04019019131787', 'SANTA ROSA DE COPAN', null, null),
  ('CORPORACION MARSELLA', '05019015725941', null, null, null),
  ('CORUMO INTERNACIONAL S DE RL DE CV', '05019995166090', 'SAN PEDRO SULA', null, null),
  ('DECORACIONES GALLO', '15011969005833', null, null, null),
  ('DISTRIBUIDORA DE MATERIALES S DE RL DE CV.', '05119998390898', 'SAN PEDRO SULA', null, null),
  ('EDCOMS', '05019010311398', null, null, null),
  ('EDWAR SANCHEZ', '01011980021663', null, null, null),
  ('FINOS TEXTILES DE CENTROAMERICA SA', '05019002073566', 'ZIP CHOLOMA II CARRETERA A LA JUTOSA', '26269000 / 26269001', 'ssist_supplies@finotex.com'),
  ('GENERAL CONCRETE SERVICES S.A. DE C.V.', '08019002264290', null, null, null),
  ('Grupo Aec SA DE CV', '18049003003713', null, null, null),
  ('GRUPO ALPES', '08019002277587', null, null, null),
  ('GRUPO ARQUITECTOS G+A', '05019012490909', null, null, null),
  ('GRUPO CLEMAR', '16189026308899', null, null, null),
  ('GUILLERMO MILLA', '05011953038385', null, null, null),
  ('HONDURAS KITTING S.A.', '05119024115339', '21000 VILLANUEVA, CORTES', null, null),
  ('HORMIGON S DE RL', '05019001048659', 'San Pedro Sula', '25659424 / 31909939', 'ventas@diserco.hn'),
  ('IGLESIA DE CRISTO MANAHAIM', '05019007080003', null, null, null),
  ('INCOPRO', '05019020239596', null, null, null),
  ('INDEMOSA', '05019010300206', 'PLAZA MODERNA - SAN PEDRO SULA', null, null),
  ('INDUSTRIAS PANAVISION, S.A DE C.V', '05019995136860', 'SAN PEDRO SULA, CORTES', null, null),
  ('INGENIERIA H.S. DE R.L.', '05019015734781', 'San Pedro Sula', null, null),
  ('INNOVATIVE CONSTRUCTIVE SOLUTIONS', '05019019120234', 'ROATAN', null, null),
  ('INVERSIONES AMALGAMADAS, S. DE R.L. DE C.V.', '05019001047849', 'Km 5, Carretera a Puerto Cortés, Choloma', null, null),
  ('Inversiones en Infraestructura S. de R.L', '08019014633598', null, null, null),
  ('INVERSIONES FROSTY', '05019995121610', null, null, null),
  ('INVERSIONES LIMPIEX', '05019023540412', null, null, null),
  ('INVERSIONES MILANO S. DE R.L.', '05019022437491', 'SAN PEDRO SULA', '31291-2727', 'GERENCIA@DISERCO.HN'),
  ('INVERSIONES NAIFRESH, S. DE R.L. DE C.V.', '05019023550990', null, null, null),
  ('INVERSIONES RAMOS MURILLO', '18011977006468', null, null, null),
  ('INVERSIONES VILLA RIO', '05019019157625', null, null, null),
  ('Inversiones y Exportadora Jamastran S de R.L.', '08019014692926', null, null, null),
  ('INVERSIONES Y SERVICIOS JAMS S DE R.L', '05019019167070', 'San Pedro Sula', null, 'ventas@diserco.hn'),
  ('Jardines y Piscinas', '08019995372489', 'TEGUCIGALPA', null, null),
  ('JORGE LEMUS', '10161986004620', null, null, null),
  ('JUAN CARLOS MEDINA', '11011978001154', null, null, null),
  ('Kevin Martinez', '05011977006744', null, null, null),
  ('KEYNY DENILSON VALLE REYES', '14121992000295', null, null, null),
  ('LAZARUS Y LAZARUS', '05019995159167', null, null, null),
  ('LIMA TRADE COMPANY', '05019018077760', null, null, null),
  ('LUJAN S.A.', '05019005483690', null, null, null),
  ('Marbin Lopez', '05101983007733', 'San Pedro Sula', null, null),
  ('MARCO TULIO GAMEZ BANEGAS', '05011988064626', null, null, null),
  ('MEGA OFERTAS', '05011985129843', null, null, null),
  ('MIGUEL SAMUEL ARGUETA', '18041985000788', null, null, null),
  ('NG INGENIERIA', '05011993036650', 'San Luis Santa Barbara', null, null),
  ('NG INGENIERIA CONSTRUCCIONES', '05119024109981', null, null, null),
  ('OSTEN CONNER HAMILTON', '11011992002760', null, null, null),
  ('PALMEROLA INTERNATIONAL AIRPORT, S.A DE C.V.', '08019016815992', 'Kilometro 6 Carretera CA-5, Frente Alimentos Maravilla', '+504 9467-2123', null),
  ('PISCINAS ABZUS', '18031993007904', null, null, null),
  ('PISOS INDUSTRIALES', '05019023558827', null, null, null),
  ('PLATINUM APPAREL S.A DE C.V.', '05019002059950', null, null, null),
  ('POLICLINICA HONDUREÑA S DE R L', '05019995118075', 'SAN PEDRO SULA', null, null),
  ('PROQUIN', '05019015721440', null, null, null),
  ('PROYECTOS DE HONDURAS', '05069024586992', null, null, null),
  ('PUERTOS DE CRUCEROS Y MARINA', '11019006018501', null, null, null),
  ('PURATOS DE HONDURAS', '18049995000492', null, null, null),
  ('RAFAEL HUMBERTO PENA DUBON', '14011972005203', null, null, null),
  ('REMACO GA S. DE R.L.', '05119026405639', null, null, null),
  ('RLA MANUFACTURING S. DE R.L.', '05019004014454', '25 KM. CARRETERA A LA JUTOSA', null, 'GERENCIA@DISERCO.HN'),
  ('ROBERTO RODRIGUEZ', '05011982048084', null, null, null),
  ('Roger Hernandez Argueta', '13131966004702', null, null, null),
  ('SAN JOSE EDIFICA', '05019019126183', null, null, null),
  ('SERMART', '18071970002787', 'TOCOA, COLON', '99905265', null),
  ('SEYER S DE RL', '08019012507123', null, null, null),
  ('SILSA', '08019009210612', 'TEGUCIGALPA', '3292-9223', null),
  ('SMG COMERCIAL', '05019005474908', 'SAN PEDRO SULA', '+504 9870-4585', null),
  ('SOCIEDAD TURISTICA DEL VALLE', '08019002026270', 'COMAYAGUA', '9430-0465', null),
  ('SOLINFRAC', '05019014675067', null, null, null),
  ('STGONZLA S. DE R.L.', '08019021284071', null, null, null),
  ('SUPERIOR GLOVE WORKS HONDURAS S.A.', '05019018002580', 'PARQUE INDUSTRIAL ZIP BUFALO, EDIFICIO #4', null, 'ventas@diserco.hn'),
  ('TRANSPORTE ILANGUEÑO', '05069998173521', null, null, null),
  ('WILLIANS ARMANDO INESTROZA LARA', '05011987000443', null, null, null),
  ('\CINSTRUCCIONES MENDES', '05101975001071', null, null, null)
) as v(nombre, rtn, dir, tel, correo)
where not exists (select 1 from core.terceros t where (v.rtn is not null and t.rtn = v.rtn) or (v.rtn is null and lower(t.nombre) = lower(v.nombre)));
