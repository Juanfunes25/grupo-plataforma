-- ════════════════════════════════════════════════════════════════════════════
-- 0014 · FAB — Fabricación (EcoStone): insumos, recetas, órdenes, lotes, calidad
--
-- Portado de la app original «EcoStone Facturación» (migraciones 0014, 0016,
-- 0017, 0021 y 0029). Todo cuelga de empresa_id; el módulo se enciende con
-- 'fabrica' en core.empresa_modulos.
--
-- ┌─ CONTRATO CON EL LADO COMERCIAL (catálogo de piedra, cotizaciones, POS) ───┐
-- │ 1. La piedra es un producto de pos.productos con es_piedra = true. Esta    │
-- │    migración agrega (si no existen) sus atributos de fábrica:              │
-- │      es_piedra boolean, modelo text, unidad_venta text ('m2','caja',…),    │
-- │      m2_por_caja numeric, piezas_por_m2 numeric, costo_estandar numeric.   │
-- │    (pos.productos.color ya existía.) Fabricación solo LEE estos campos y   │
-- │    escribe costo_estandar al terminar un lote.                             │
-- │ 2. fab.lotes es el inventario de piedra terminada: UNA fila por            │
-- │    (empresa, código de lote, calidad). Un lote 'secado' todavía no se      │
-- │    vende. Al pasar a 'lista':                                              │
-- │      cantidad_disponible = existencia FÍSICA en bodega (incluye lo         │
-- │                            reservado)                                      │
-- │      cantidad_reservada  = parte de la física apartada para cotizaciones   │
-- │      cantidad_libre      = disponible − reservada (columna generada)       │
-- │    Cuando la física llega a 0 el lote queda 'agotado'.                     │
-- │ 3. Para RESERVAR al aprobar una cotización, LIBERAR al anular/rechazar y   │
-- │    CONSUMIR al facturar (FIFO por lote, primera calidad), usar SOLO:       │
-- │      select fab.reservar(empresa, producto, cantidad, ref_id, ref_numero,  │
-- │                          cliente, usuario);            -- jsonb            │
-- │      select fab.liberar(empresa, ref_id, usuario);     -- numeric         │
-- │      select fab.consumir(empresa, producto, cantidad, ref_id, venta_id,    │
-- │                          venta_numero, cliente, usuario, forzar);  -- jsonb │
-- │    · ref_id = id de la cotización (uuid); lo reservado con ese ref_id se   │
-- │      consume primero al facturar. reservar() es idempotente por ref_id.    │
-- │    · consumir(forzar=true) NUNCA bloquea: lo que no hay queda como         │
-- │      'faltante' en el jsonb (la plataforma deja facturar sin existencia).  │
-- │    · Existencias para mostrar: vista fab.stock_piedra (por producto).      │
-- └────────────────────────────────────────────────────────────────────────────┘
-- ════════════════════════════════════════════════════════════════════════════

create schema if not exists fab;

-- ─── Atributos de piedra en el catálogo (idempotente; F1 puede declararlos igual) ──
alter table pos.productos
  add column if not exists es_piedra      boolean not null default false,
  add column if not exists modelo         text,
  add column if not exists unidad_venta   text,
  add column if not exists m2_por_caja    numeric(10,4),
  add column if not exists piezas_por_m2  numeric(10,3),
  add column if not exists costo_estandar numeric(14,4) not null default 0;

-- ─── Contadores por empresa (lote del día, número de orden) ─────────────────
create table fab.contadores (
  empresa_id uuid not null references core.empresas(id) on delete cascade,
  clave      text not null,
  valor      bigint not null default 0,
  primary key (empresa_id, clave)
);

create function fab.siguiente(p_empresa uuid, p_clave text) returns bigint language plpgsql as $$
declare v bigint;
begin
  insert into fab.contadores (empresa_id, clave, valor) values (p_empresa, p_clave, 1)
  on conflict (empresa_id, clave) do update set valor = fab.contadores.valor + 1
  returning valor into v;
  return v;
end $$;

-- ─── Proveedores de insumos ─────────────────────────────────────────────────
create table fab.proveedores (
  id           uuid primary key default gen_random_uuid(),
  empresa_id   uuid not null references core.empresas(id),
  nombre       text not null,
  rtn          text,
  contacto     text,
  telefono     text,
  email        text,
  dias_credito int not null default 0,
  notas        text,
  activo       boolean not null default true,
  created_at   timestamptz not null default now()
);
create index fab_proveedores_idx on fab.proveedores (empresa_id);

-- ─── Insumos (materias primas) ──────────────────────────────────────────────
create table fab.insumos (
  id             uuid primary key default gen_random_uuid(),
  empresa_id     uuid not null references core.empresas(id),
  codigo         text,
  nombre         text not null,
  categoria      text not null default 'otro' check (categoria in
                   ('cemento','arena','agregado','aditivo','pigmento','desmoldante','sellador','fibra','empaque','molde','otro')),
  unidad         text not null default 'kg',
  costo_promedio numeric(14,4) not null default 0,                    -- siempre en Lempiras
  moneda         text not null default 'HNL' check (moneda in ('HNL','USD')),   -- moneda habitual de compra
  stock_minimo   numeric(14,3) not null default 0,
  proveedor_id   uuid references fab.proveedores(id),
  notas          text,
  activo         boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (empresa_id, codigo)
);
create index fab_insumos_idx on fab.insumos (empresa_id) where activo;

-- Kardex: + entra / − sale. El stock es la suma del libro.
create table fab.mov_insumos (
  id             bigserial primary key,
  empresa_id     uuid not null references core.empresas(id),
  created_at     timestamptz not null default now(),
  insumo_id      uuid not null references fab.insumos(id),
  tipo           text not null check (tipo in ('inicial','compra','consumo','merma','ajuste','devolucion')),
  cantidad       numeric(14,3) not null,
  costo_unitario numeric(14,4) not null default 0,                    -- en Lempiras
  moneda         text not null default 'HNL',
  tipo_cambio    numeric(10,4) not null default 1,
  proveedor_id   uuid references fab.proveedores(id),
  documento      text,
  motivo         text,
  orden_id       uuid,
  usuario_id     uuid references core.usuarios(id)
);
create index fab_mov_insumos_idx on fab.mov_insumos (insumo_id, created_at desc);
create index fab_mov_insumos_emp_idx on fab.mov_insumos (empresa_id, created_at desc);

create view fab.stock_insumos with (security_invoker = true) as
  select empresa_id, insumo_id, coalesce(sum(cantidad), 0) as stock from fab.mov_insumos group by empresa_id, insumo_id;

-- Movimiento atómico: bloquea el insumo, impide stock negativo (salvo p_forzar:
-- la producción ya ocurrió en planta) y recalcula el costo PROMEDIO PONDERADO en
-- cada compra. Los precios en USD se convierten al tipo de cambio dado y se
-- guardan en Lempiras.
create function fab.mover_insumo(
  p_empresa uuid, p_insumo uuid, p_tipo text, p_cantidad numeric, p_costo numeric default null,
  p_moneda text default 'HNL', p_tc numeric default 1, p_proveedor uuid default null,
  p_documento text default null, p_motivo text default null, p_orden uuid default null,
  p_usuario uuid default null, p_forzar boolean default false
) returns fab.mov_insumos language plpgsql as $$
declare
  v_mp fab.insumos%rowtype;
  v_stock numeric;
  v_costo numeric;
  v_mov fab.mov_insumos%rowtype;
begin
  select * into v_mp from fab.insumos where id = p_insumo and empresa_id = p_empresa for update;
  if v_mp.id is null then raise exception 'Insumo no encontrado'; end if;
  if p_cantidad = 0 then raise exception 'La cantidad no puede ser cero'; end if;
  select coalesce(sum(cantidad), 0) into v_stock from fab.mov_insumos where insumo_id = p_insumo;
  if p_cantidad < 0 and v_stock + p_cantidad < 0 and not p_forzar then
    raise exception 'Stock insuficiente de %: hay % %, se piden %', v_mp.nombre, v_stock, v_mp.unidad, abs(p_cantidad);
  end if;
  v_costo := v_mp.costo_promedio;
  if p_tipo in ('compra','inicial') and p_cantidad > 0 then
    v_costo := coalesce(p_costo, 0) * case when p_moneda = 'USD' then p_tc else 1 end;
    update fab.insumos set
      costo_promedio = case when v_stock + p_cantidad > 0
        then round((greatest(v_stock,0) * costo_promedio + p_cantidad * v_costo) / (greatest(v_stock,0) + p_cantidad), 4)
        else v_costo end
    where id = p_insumo;
  end if;
  insert into fab.mov_insumos (empresa_id, insumo_id, tipo, cantidad, costo_unitario, moneda, tipo_cambio, proveedor_id, documento, motivo, orden_id, usuario_id)
  values (p_empresa, p_insumo, p_tipo, p_cantidad, v_costo, p_moneda, p_tc, p_proveedor, p_documento, p_motivo, p_orden, p_usuario)
  returning * into v_mov;
  return v_mov;
end $$;

-- ─── Moldes ─────────────────────────────────────────────────────────────────
create table fab.moldes (
  id               uuid primary key default gen_random_uuid(),
  empresa_id       uuid not null references core.empresas(id),
  codigo           text not null,
  nombre           text not null,
  producto_id      uuid references pos.productos(id),
  piezas_por_colada int not null default 1,
  m2_por_colada    numeric(10,3) not null default 0,
  vida_util_usos   int not null default 300,
  usos             int not null default 0,
  estado           text not null default 'activo' check (estado in ('activo','mantenimiento','baja')),
  notas            text,
  created_at       timestamptz not null default now(),
  unique (empresa_id, codigo)
);

-- ─── Recetas: consumo de insumos por m² terminado ───────────────────────────
create table fab.recetas (
  id                 uuid primary key default gen_random_uuid(),
  empresa_id         uuid not null references core.empresas(id),
  producto_id        uuid not null references pos.productos(id),
  nombre             text not null,
  merma_esperada_pct numeric(5,2) not null default 5,
  mano_obra_m2       numeric(12,2) not null default 0,
  indirectos_m2      numeric(12,2) not null default 0,
  notas              text,
  activa             boolean not null default true,
  created_at         timestamptz not null default now()
);
create unique index fab_recetas_activa_idx on fab.recetas (producto_id) where activa;

create table fab.receta_items (
  receta_id   uuid not null references fab.recetas(id) on delete cascade,
  insumo_id   uuid not null references fab.insumos(id),
  cantidad_m2 numeric(14,4) not null check (cantidad_m2 > 0),
  primary key (receta_id, insumo_id)
);

-- ─── Órdenes de producción ──────────────────────────────────────────────────
-- Estados: planificada → curando (en secado) → terminada (lista para vender) | cancelada
create table fab.ordenes (
  id                uuid primary key default gen_random_uuid(),
  empresa_id        uuid not null references core.empresas(id),
  numero            bigint not null,
  lote              text not null,
  producto_id       uuid not null references pos.productos(id),
  receta_id         uuid references fab.recetas(id),
  cotizacion_id     uuid,                           -- cotización que la originó (sin FK: la define el lado comercial)
  cotizacion_numero text,
  estado            text not null default 'planificada' check (estado in ('planificada','curando','terminada','cancelada')),
  m2_planificado    numeric(12,3) not null check (m2_planificado > 0),
  m2_bueno          numeric(12,3),
  m2_segunda        numeric(12,3),
  m2_merma          numeric(12,3),
  molde_id          uuid references fab.moldes(id),
  coladas           int,
  fecha_programada  date,
  fecha_colado      timestamptz,
  fecha_disponible  date,
  fecha_terminada   timestamptz,
  responsable_id    uuid references core.usuarios(id),
  costo_mp          numeric(14,2),
  costo_mano_obra   numeric(14,2),
  costo_indirectos  numeric(14,2),
  costo_total       numeric(14,2),
  costo_m2          numeric(14,4),
  etiqueta_at       timestamptz,
  etiquetas_impresas int not null default 0,
  notas             text,
  creada_por        uuid references core.usuarios(id),
  created_at        timestamptz not null default now(),
  unique (empresa_id, numero),
  unique (empresa_id, lote)
);
create index fab_ordenes_estado_idx on fab.ordenes (empresa_id, estado, fecha_programada);
create index fab_ordenes_colado_idx on fab.ordenes (empresa_id, fecha_colado);

create table fab.orden_consumos (
  id             uuid primary key default gen_random_uuid(),
  orden_id       uuid not null references fab.ordenes(id) on delete cascade,
  insumo_id      uuid not null references fab.insumos(id),
  teorico        numeric(14,3) not null,
  real           numeric(14,3),
  costo_unitario numeric(14,4) not null default 0
);
create index fab_orden_consumos_idx on fab.orden_consumos (orden_id);

-- Calidad (ASTM C1670: absorción, dimensiones, resistencia, adherencia…)
create table fab.controles_calidad (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references core.empresas(id),
  orden_id   uuid not null references fab.ordenes(id) on delete cascade,
  prueba     text not null,
  resultado  text not null check (resultado in ('aprobado','observado','rechazado')),
  valor      numeric(14,3),
  unidad     text,
  notas      text,
  usuario_id uuid references core.usuarios(id),
  created_at timestamptz not null default now()
);
create index fab_calidad_idx on fab.controles_calidad (orden_id);

-- ─── Lotes = inventario de piedra terminada ─────────────────────────────────
create table fab.lotes (
  id                  uuid primary key default gen_random_uuid(),
  empresa_id          uuid not null references core.empresas(id),
  codigo              text not null,                          -- p. ej. EC-261008-01 (lo que lleva la etiqueta y el QR)
  producto_id         uuid not null references pos.productos(id),
  orden_id            uuid references fab.ordenes(id),
  calidad             text not null default 'primera' check (calidad in ('primera','segunda')),
  estado              text not null default 'secado' check (estado in ('secado','lista','agotado')),
  cantidad_producida  numeric(14,3) not null default 0,       -- lo registrado por el operario
  cantidad_disponible numeric(14,3) not null default 0 check (cantidad_disponible >= 0),   -- FÍSICO en bodega
  cantidad_reservada  numeric(14,3) not null default 0 check (cantidad_reservada >= 0),
  cantidad_libre      numeric(14,3) generated always as (cantidad_disponible - cantidad_reservada) stored,
  costo_m2            numeric(14,4) not null default 0,
  fecha_produccion    timestamptz not null default now(),
  fecha_lista         timestamptz,
  operario_id         uuid references core.usuarios(id),
  operario            text,
  etiqueta_at         timestamptz,
  etiquetas_impresas  int not null default 0,
  created_at          timestamptz not null default now(),
  unique (empresa_id, codigo, calidad),
  check (cantidad_reservada <= cantidad_disponible)
);
create index fab_lotes_fifo_idx on fab.lotes (empresa_id, producto_id, fecha_lista, created_at) where estado = 'lista';
create index fab_lotes_codigo_idx on fab.lotes (empresa_id, codigo);

-- Reservas vigentes por cotización (cuánto de cada lote está apartado para quién)
create table fab.reservas (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references core.empresas(id),
  lote_id     uuid not null references fab.lotes(id),
  producto_id uuid not null references pos.productos(id),
  ref_id      uuid not null,
  ref_numero  text,
  cliente     text,
  cantidad    numeric(14,3) not null check (cantidad > 0),
  created_at  timestamptz not null default now(),
  unique (lote_id, ref_id)
);
create index fab_reservas_ref_idx on fab.reservas (empresa_id, ref_id);

-- Libro de movimientos del lote (trazabilidad hacia adelante)
create table fab.lote_movs (
  id          bigserial primary key,
  empresa_id  uuid not null references core.empresas(id),
  created_at  timestamptz not null default now(),
  lote_id     uuid not null references fab.lotes(id),
  tipo        text not null check (tipo in ('inicial','produccion','reserva','liberacion','venta','despacho','merma','ajuste')),
  cantidad    numeric(14,3) not null,        -- reserva/liberacion: cantidad apartada (+/−); el resto: efecto físico (+ entra / − sale)
  ref_id      uuid,
  ref_numero  text,
  cliente     text,
  venta_id    uuid,
  venta_numero text,
  motivo      text,
  usuario_id  uuid references core.usuarios(id)
);
create index fab_lote_movs_idx on fab.lote_movs (lote_id, id);

-- Existencias de piedra por producto
create view fab.stock_piedra with (security_invoker = true) as
  select empresa_id, producto_id, calidad,
         sum(cantidad_disponible) as fisico,
         sum(cantidad_reservada)  as reservado,
         sum(cantidad_libre)      as libre,
         count(*) filter (where estado = 'lista' and cantidad_disponible > 0) as lotes
    from fab.lotes where estado <> 'secado' group by empresa_id, producto_id, calidad;

-- Alertas de producción (consumo desviado, merma alta, calidad rechazada, sin receta…)
create table fab.alertas (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references core.empresas(id),
  created_at timestamptz not null default now(),
  tipo       text not null,
  severidad  text not null default 'media' check (severidad in ('baja','media','alta')),
  titulo     text not null,
  entidad    text,
  entidad_id text,
  detalle    jsonb not null default '{}'::jsonb,
  estado     text not null default 'abierta' check (estado in ('abierta','revisada')),
  usuario_id uuid references core.usuarios(id)
);
create index fab_alertas_idx on fab.alertas (empresa_id, created_at desc);

-- ─── Reservar / liberar / consumir piedra (FIFO por lote, primera calidad) ───
-- Reserva para una referencia (cotización). Idempotente: reservar de nuevo la misma
-- referencia solo aparta lo que todavía falte. NUNCA falla por falta de existencia:
-- devuelve {reservado, ya_reservado, faltante, lotes:[{lote_id,codigo,cantidad}]}.
create function fab.reservar(
  p_empresa uuid, p_producto uuid, p_cantidad numeric, p_ref_id uuid,
  p_ref_numero text default null, p_cliente text default null, p_usuario uuid default null
) returns jsonb language plpgsql as $$
declare
  v_ya numeric; v_falta numeric; v_tom numeric; v_tomado numeric := 0; v_l record; v_lotes jsonb := '[]'::jsonb;
begin
  if p_cantidad <= 0 then raise exception 'La cantidad a reservar debe ser positiva'; end if;
  select coalesce(sum(cantidad), 0) into v_ya from fab.reservas where empresa_id = p_empresa and producto_id = p_producto and ref_id = p_ref_id;
  v_falta := p_cantidad - v_ya;
  for v_l in
    select id, codigo, cantidad_libre from fab.lotes
     where empresa_id = p_empresa and producto_id = p_producto and calidad = 'primera' and estado = 'lista' and cantidad_libre > 0
     order by fecha_lista nulls last, created_at, id for update
  loop
    exit when v_falta <= 0;
    v_tom := least(v_falta, v_l.cantidad_libre);
    update fab.lotes set cantidad_reservada = cantidad_reservada + v_tom where id = v_l.id;
    insert into fab.reservas (empresa_id, lote_id, producto_id, ref_id, ref_numero, cliente, cantidad)
    values (p_empresa, v_l.id, p_producto, p_ref_id, p_ref_numero, p_cliente, v_tom)
    on conflict (lote_id, ref_id) do update set cantidad = fab.reservas.cantidad + excluded.cantidad;
    insert into fab.lote_movs (empresa_id, lote_id, tipo, cantidad, ref_id, ref_numero, cliente, motivo, usuario_id)
    values (p_empresa, v_l.id, 'reserva', v_tom, p_ref_id, p_ref_numero, p_cliente, 'Reserva ' || coalesce(p_ref_numero, ''), p_usuario);
    v_lotes := v_lotes || jsonb_build_object('lote_id', v_l.id, 'codigo', v_l.codigo, 'cantidad', v_tom);
    v_falta := v_falta - v_tom; v_tomado := v_tomado + v_tom;
  end loop;
  return jsonb_build_object('reservado', v_tomado, 'ya_reservado', v_ya, 'faltante', greatest(v_falta, 0), 'lotes', v_lotes);
end $$;

-- Libera todo lo reservado para una referencia (anulación o rechazo). Devuelve lo liberado.
create function fab.liberar(p_empresa uuid, p_ref_id uuid, p_usuario uuid default null) returns numeric language plpgsql as $$
declare v_r record; v_total numeric := 0;
begin
  for v_r in select * from fab.reservas where empresa_id = p_empresa and ref_id = p_ref_id order by created_at for update loop
    update fab.lotes set cantidad_reservada = greatest(cantidad_reservada - v_r.cantidad, 0) where id = v_r.lote_id;
    insert into fab.lote_movs (empresa_id, lote_id, tipo, cantidad, ref_id, ref_numero, cliente, motivo, usuario_id)
    values (p_empresa, v_r.lote_id, 'liberacion', -v_r.cantidad, p_ref_id, v_r.ref_numero, v_r.cliente, 'Liberación de reserva', p_usuario);
    delete from fab.reservas where id = v_r.id;
    v_total := v_total + v_r.cantidad;
  end loop;
  return v_total;
end $$;

-- Descuenta piedra al facturar: primero lo reservado para p_ref_id, luego lo libre (FIFO).
-- p_forzar=true (la plataforma deja facturar sin existencia): lo que no hay vuelve como 'faltante'.
-- p_forzar=false: lanza excepción si no alcanza. Devuelve {consumido, faltante, lotes:[…]}.
create function fab.consumir(
  p_empresa uuid, p_producto uuid, p_cantidad numeric, p_ref_id uuid default null,
  p_venta_id uuid default null, p_venta_numero text default null, p_cliente text default null,
  p_usuario uuid default null, p_forzar boolean default true
) returns jsonb language plpgsql as $$
declare
  v_falta numeric := p_cantidad; v_tom numeric; v_l record; v_lotes jsonb := '[]'::jsonb;
  v_libre_total numeric;
begin
  if p_cantidad <= 0 then raise exception 'La cantidad a descontar debe ser positiva'; end if;
  if not p_forzar then
    select coalesce(sum(cantidad_disponible), 0) into v_libre_total from fab.lotes
     where empresa_id = p_empresa and producto_id = p_producto and calidad = 'primera' and estado = 'lista';
    if v_libre_total < p_cantidad then
      raise exception 'Existencia insuficiente de piedra: hay % y se piden %', v_libre_total, p_cantidad;
    end if;
  end if;
  -- 1) lo reservado para esta referencia
  if p_ref_id is not null then
    for v_l in
      select r.id as rid, r.cantidad as rcant, l.id as lote_id, l.codigo from fab.reservas r join fab.lotes l on l.id = r.lote_id
       where r.empresa_id = p_empresa and r.ref_id = p_ref_id and r.producto_id = p_producto and l.calidad = 'primera'
       order by l.fecha_lista nulls last, l.created_at, l.id for update of l, r
    loop
      exit when v_falta <= 0;
      v_tom := least(v_falta, v_l.rcant);
      update fab.lotes set cantidad_disponible = cantidad_disponible - v_tom, cantidad_reservada = cantidad_reservada - v_tom where id = v_l.lote_id;
      if v_tom >= v_l.rcant then delete from fab.reservas where id = v_l.rid; else update fab.reservas set cantidad = cantidad - v_tom where id = v_l.rid; end if;
      insert into fab.lote_movs (empresa_id, lote_id, tipo, cantidad, ref_id, ref_numero, cliente, venta_id, venta_numero, motivo, usuario_id)
      values (p_empresa, v_l.lote_id, 'venta', -v_tom, p_ref_id, null, p_cliente, p_venta_id, p_venta_numero, 'Venta ' || coalesce(p_venta_numero, ''), p_usuario);
      v_lotes := v_lotes || jsonb_build_object('lote_id', v_l.lote_id, 'codigo', v_l.codigo, 'cantidad', v_tom);
      v_falta := v_falta - v_tom;
    end loop;
  end if;
  -- 2) existencia libre, el lote más antiguo primero
  for v_l in
    select id, codigo, cantidad_libre from fab.lotes
     where empresa_id = p_empresa and producto_id = p_producto and calidad = 'primera' and estado = 'lista' and cantidad_libre > 0
     order by fecha_lista nulls last, created_at, id for update
  loop
    exit when v_falta <= 0;
    v_tom := least(v_falta, v_l.cantidad_libre);
    update fab.lotes set cantidad_disponible = cantidad_disponible - v_tom where id = v_l.id;
    insert into fab.lote_movs (empresa_id, lote_id, tipo, cantidad, ref_id, cliente, venta_id, venta_numero, motivo, usuario_id)
    values (p_empresa, v_l.id, 'venta', -v_tom, p_ref_id, p_cliente, p_venta_id, p_venta_numero, 'Venta ' || coalesce(p_venta_numero, ''), p_usuario);
    v_lotes := v_lotes || jsonb_build_object('lote_id', v_l.id, 'codigo', v_l.codigo, 'cantidad', v_tom);
    v_falta := v_falta - v_tom;
  end loop;
  update fab.lotes set estado = 'agotado' where empresa_id = p_empresa and producto_id = p_producto and estado = 'lista' and cantidad_disponible = 0;
  return jsonb_build_object('consumido', p_cantidad - v_falta, 'faltante', v_falta, 'lotes', v_lotes);
end $$;

-- ─── Seguridad: RLS activa y sin políticas (solo el API entra) ──────────────
alter table fab.contadores         enable row level security;
alter table fab.proveedores        enable row level security;
alter table fab.insumos            enable row level security;
alter table fab.mov_insumos        enable row level security;
alter table fab.moldes             enable row level security;
alter table fab.recetas            enable row level security;
alter table fab.receta_items       enable row level security;
alter table fab.ordenes            enable row level security;
alter table fab.orden_consumos     enable row level security;
alter table fab.controles_calidad  enable row level security;
alter table fab.lotes              enable row level security;
alter table fab.reservas           enable row level security;
alter table fab.lote_movs          enable row level security;
alter table fab.alertas            enable row level security;

-- ─── Parámetros por empresa (core.config, clave 'fab') — valores de la app original ─
insert into core.config (empresa_id, clave, valor)
select e.id, 'fab', jsonb_build_object(
  'tipo_cambio_usd', 26.3, 'dias_a_inventario', 5, 'tolerancia_consumo_pct', 10, 'merma_maxima_pct', 8,
  'coladas_por_molde_dia', 1, 'prefijo_lote', 'EC')
from core.empresas e where e.codigo = 'ecostone'
on conflict (empresa_id, clave) do nothing;

-- ─── Semillas genéricas de insumos (marcadas [EJEMPLO]; costos en 0 hasta cargar reales) ──
insert into fab.insumos (empresa_id, codigo, nombre, categoria, unidad, moneda, notas)
select e.id, v.codigo, v.nombre, v.categoria, v.unidad, v.moneda, v.notas
  from core.empresas e,
  (values
    ('MP-CEM-01', '[EJEMPLO] Cemento gris (saco 42.5 kg)', 'cemento', 'saco', 'HNL', 'Ligante principal'),
    ('MP-ARE-01', '[EJEMPLO] Arena fina lavada', 'arena', 'kg', 'HNL', null),
    ('MP-AGR-01', '[EJEMPLO] Agregado ligero (piedra pómez / perlita)', 'agregado', 'kg', 'HNL', 'ASTM C330 para unidades livianas'),
    ('MP-PIG-01', '[EJEMPLO] Óxido de hierro rojo', 'pigmento', 'kg', 'USD', 'Pigmento mineral; guardar en USD'),
    ('MP-PIG-02', '[EJEMPLO] Óxido de hierro negro', 'pigmento', 'kg', 'USD', null),
    ('MP-PIG-03', '[EJEMPLO] Óxido de hierro amarillo/ocre', 'pigmento', 'kg', 'USD', null),
    ('MP-ADI-01', '[EJEMPLO] Superplastificante / reductor de agua', 'aditivo', 'kg', 'HNL', null),
    ('MP-ADI-02', '[EJEMPLO] Repelente de agua integral', 'aditivo', 'kg', 'HNL', null),
    ('MP-FIB-01', '[EJEMPLO] Fibra de polipropileno', 'fibra', 'kg', 'HNL', 'Refuerzo contra fisuras'),
    ('MP-DES-01', '[EJEMPLO] Desmoldante (polvo o líquido)', 'desmoldante', 'kg', 'HNL', null),
    ('MP-SEL-01', '[EJEMPLO] Sellador / hidrofugante', 'sellador', 'galon', 'HNL', null),
    ('MP-EMP-01', '[EJEMPLO] Caja de cartón para embalaje', 'empaque', 'unidad', 'HNL', null),
    ('MP-EMP-02', '[EJEMPLO] Tarima / pallet y fleje', 'empaque', 'unidad', 'HNL', null)
  ) as v(codigo, nombre, categoria, unidad, moneda, notas)
 where e.codigo = 'ecostone'
on conflict (empresa_id, codigo) do nothing;
