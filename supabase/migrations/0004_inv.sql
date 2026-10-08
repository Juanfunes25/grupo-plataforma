-- ════════════════════════════════════════════════════════════════════════════
-- 0004 · INVENTARIO COMÚN (insumos, lotes FEFO, recetas, mermas, compras)
--
-- Un solo motor para todo el grupo: frutas de Origen, insumos del gelato,
-- materia prima de EcoStone. La verdad del stock es el LIBRO de movimientos
-- (inv.movimientos, positivo entra / negativo sale). Los lotes dan FEFO
-- (primero lo que vence antes) y costo real; si se vende sin stock, el sistema
-- NUNCA bloquea la caja: registra el consumo sin lote y queda stock negativo
-- visible como alerta.
-- Al cobrar una venta, un trigger descuenta automáticamente la receta de cada
-- producto (más lo que consuman sus modificadores) y guarda el costo en la
-- línea para calcular margen real. Al anular, revierte.
-- ════════════════════════════════════════════════════════════════════════════

create schema if not exists inv;

create table inv.insumos (
  id             uuid primary key default gen_random_uuid(),
  empresa_id     uuid not null references core.empresas(id),
  codigo         text,
  nombre         text not null,
  categoria      text,
  unidad         text not null default 'kg',
  costo_actual   numeric(14,4) not null default 0 check (costo_actual >= 0),   -- último costo por unidad
  stock_minimo   numeric(14,3) not null default 0,
  perecedero     boolean not null default false,
  vida_util_dias int,
  proveedor_id   uuid references core.terceros(id),
  activo         boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (empresa_id, nombre)
);
create index insumos_empresa_idx on inv.insumos (empresa_id) where activo;

create table inv.compras (
  id             uuid primary key default gen_random_uuid(),
  empresa_id     uuid not null references core.empresas(id),
  sucursal_id    uuid not null references core.sucursales(id),
  proveedor_id   uuid references core.terceros(id),
  numero_documento text,
  fecha          date not null default current_date,
  subtotal       numeric(14,2) not null default 0,
  isv            numeric(14,2) not null default 0,
  total          numeric(14,2) not null default 0,
  notas          text,
  usuario_id     uuid references core.usuarios(id),
  created_at     timestamptz not null default now()
);
create index compras_empresa_idx on inv.compras (empresa_id, fecha desc);

create table inv.compra_items (
  id              uuid primary key default gen_random_uuid(),
  compra_id       uuid not null references inv.compras(id) on delete cascade,
  insumo_id       uuid not null references inv.insumos(id),
  cantidad        numeric(14,3) not null check (cantidad > 0),
  costo_unitario  numeric(14,4) not null check (costo_unitario >= 0),
  vence_at        date
);

create table inv.lotes (
  id               uuid primary key default gen_random_uuid(),
  empresa_id       uuid not null references core.empresas(id),
  sucursal_id      uuid not null references core.sucursales(id),
  insumo_id        uuid not null references inv.insumos(id),
  compra_id        uuid references inv.compras(id),
  cantidad_inicial numeric(14,3) not null check (cantidad_inicial > 0),
  cantidad_actual  numeric(14,3) not null check (cantidad_actual >= 0),
  costo_unitario   numeric(14,4) not null default 0,
  recibido_at      timestamptz not null default now(),
  vence_at         date,
  referencia       text
);
create index lotes_fefo_idx on inv.lotes (insumo_id, sucursal_id, vence_at nulls last, recibido_at) where cantidad_actual > 0;

create table inv.movimientos (
  id              bigint generated always as identity primary key,
  empresa_id      uuid not null references core.empresas(id),
  sucursal_id     uuid not null references core.sucursales(id),
  insumo_id       uuid not null references inv.insumos(id),
  lote_id         uuid references inv.lotes(id),
  tipo            text not null check (tipo in ('compra','consumo','merma','ajuste','traslado_salida','traslado_entrada','reversa','produccion')),
  cantidad        numeric(14,3) not null,        -- + entra / − sale
  costo_unitario  numeric(14,4),
  costo_total     numeric(14,2),
  referencia_tipo text,                          -- 'venta','compra','conteo'…
  referencia_id   uuid,
  motivo          text,
  usuario_id      uuid references core.usuarios(id),
  created_at      timestamptz not null default now()
);
create index movimientos_insumo_idx on inv.movimientos (insumo_id, sucursal_id, created_at desc);
create index movimientos_ref_idx on inv.movimientos (referencia_tipo, referencia_id);
create index movimientos_empresa_idx on inv.movimientos (empresa_id, created_at desc);

-- Recetas: cuánto insumo consume UNA unidad de producto.
create table inv.receta_items (
  producto_id uuid not null references pos.productos(id) on delete cascade,
  insumo_id   uuid not null references inv.insumos(id),
  cantidad    numeric(14,4) not null check (cantidad > 0),
  merma_pct   numeric(5,2) not null default 0 check (merma_pct >= 0 and merma_pct < 100),
  primary key (producto_id, insumo_id)
);
-- Un modificador ("+ chía", "leche de almendra") también puede consumir insumo.
create table inv.modificador_consumo (
  modificador_id uuid not null references pos.modificadores(id) on delete cascade,
  insumo_id      uuid not null references inv.insumos(id),
  cantidad       numeric(14,4) not null check (cantidad > 0),
  primary key (modificador_id, insumo_id)
);

-- Stock actual por sucursal e insumo (suma del libro de movimientos).
create view inv.stock as
select m.empresa_id, m.sucursal_id, m.insumo_id,
       sum(m.cantidad)::numeric(14,3) as cantidad,
       i.stock_minimo,
       (sum(m.cantidad) < 0) as negativo,
       (sum(m.cantidad) <= i.stock_minimo) as bajo_minimo
from inv.movimientos m join inv.insumos i on i.id = m.insumo_id
group by m.empresa_id, m.sucursal_id, m.insumo_id, i.stock_minimo;

-- Costo teórico por unidad de producto según receta.
create view inv.costo_receta as
select r.producto_id,
       sum(r.cantidad * (1 + r.merma_pct / 100) * i.costo_actual)::numeric(14,4) as costo
from inv.receta_items r join inv.insumos i on i.id = r.insumo_id
group by r.producto_id;

-- ─── Ingreso de mercancía (compra, producción, ajuste positivo) ─────────────
create function inv.ingresar(
  p_empresa uuid, p_sucursal uuid, p_insumo uuid, p_cantidad numeric, p_costo numeric,
  p_tipo text, p_vence date, p_ref_tipo text, p_ref_id uuid, p_motivo text, p_usuario uuid, p_compra uuid default null
) returns uuid language plpgsql as $$
declare v_lote uuid;
begin
  if p_cantidad <= 0 then raise exception 'La cantidad a ingresar debe ser positiva'; end if;
  insert into inv.lotes (empresa_id, sucursal_id, insumo_id, compra_id, cantidad_inicial, cantidad_actual, costo_unitario, vence_at, referencia)
  values (p_empresa, p_sucursal, p_insumo, p_compra, p_cantidad, p_cantidad, coalesce(p_costo, 0), p_vence, p_motivo)
  returning id into v_lote;
  insert into inv.movimientos (empresa_id, sucursal_id, insumo_id, lote_id, tipo, cantidad, costo_unitario, costo_total,
                               referencia_tipo, referencia_id, motivo, usuario_id)
  values (p_empresa, p_sucursal, p_insumo, v_lote, p_tipo, p_cantidad, coalesce(p_costo, 0),
          round(p_cantidad * coalesce(p_costo, 0), 2), p_ref_tipo, p_ref_id, p_motivo, p_usuario);
  if p_costo is not null and p_costo > 0 and p_tipo in ('compra','produccion') then
    update inv.insumos set costo_actual = p_costo where id = p_insumo;
  end if;
  return v_lote;
end $$;

-- ─── Salida de mercancía: FEFO. Nunca bloquea; lo que falte queda sin lote ──
-- Devuelve el costo total de lo descontado.
create function inv.descontar(
  p_empresa uuid, p_sucursal uuid, p_insumo uuid, p_cantidad numeric,
  p_tipo text, p_ref_tipo text, p_ref_id uuid, p_motivo text, p_usuario uuid
) returns numeric language plpgsql as $$
declare
  v_resto numeric := p_cantidad;
  v_costo numeric := 0;
  v_take numeric;
  v_lote record;
  v_costo_ref numeric;
begin
  if p_cantidad <= 0 then return 0; end if;
  for v_lote in
    select id, cantidad_actual, costo_unitario from inv.lotes
    where insumo_id = p_insumo and sucursal_id = p_sucursal and cantidad_actual > 0
    order by vence_at nulls last, recibido_at, id
    for update
  loop
    exit when v_resto <= 0;
    v_take := least(v_resto, v_lote.cantidad_actual);
    update inv.lotes set cantidad_actual = cantidad_actual - v_take where id = v_lote.id;
    insert into inv.movimientos (empresa_id, sucursal_id, insumo_id, lote_id, tipo, cantidad, costo_unitario, costo_total,
                                 referencia_tipo, referencia_id, motivo, usuario_id)
    values (p_empresa, p_sucursal, p_insumo, v_lote.id, p_tipo, -v_take, v_lote.costo_unitario,
            round(-v_take * v_lote.costo_unitario, 2), p_ref_tipo, p_ref_id, p_motivo, p_usuario);
    v_costo := v_costo + v_take * v_lote.costo_unitario;
    v_resto := v_resto - v_take;
  end loop;
  if v_resto > 0 then   -- faltante: stock negativo (alerta), costo al último precio conocido
    select costo_actual into v_costo_ref from inv.insumos where id = p_insumo;
    insert into inv.movimientos (empresa_id, sucursal_id, insumo_id, lote_id, tipo, cantidad, costo_unitario, costo_total,
                                 referencia_tipo, referencia_id, motivo, usuario_id)
    values (p_empresa, p_sucursal, p_insumo, null, p_tipo, -v_resto, v_costo_ref,
            round(-v_resto * coalesce(v_costo_ref, 0), 2), p_ref_tipo, p_ref_id, p_motivo, p_usuario);
    v_costo := v_costo + v_resto * coalesce(v_costo_ref, 0);
  end if;
  return round(v_costo, 4);
end $$;

-- ─── Trigger: cobrar → descuenta recetas; anular → revierte ─────────────────
create function inv.al_cambiar_estado_venta() returns trigger language plpgsql as $$
declare
  v_det record;
  v_it  record;
  v_op  jsonb;
  v_costo_linea numeric;
  v_mov record;
begin
  if old.estado = 'abierta' and new.estado = 'pagada' then
    for v_det in select * from pos.detalle_venta where venta_id = new.id and producto_id is not null loop
      v_costo_linea := 0;
      -- receta del producto
      for v_it in select insumo_id, cantidad * (1 + merma_pct / 100) as cant
                  from inv.receta_items where producto_id = v_det.producto_id loop
        v_costo_linea := v_costo_linea + inv.descontar(new.empresa_id, new.sucursal_id, v_it.insumo_id,
                           v_it.cant * v_det.cantidad, 'consumo', 'venta', new.id, null, new.cajero_id);
      end loop;
      -- consumo de los modificadores elegidos
      for v_op in select * from jsonb_array_elements(v_det.opciones) loop
        for v_it in select insumo_id, cantidad from inv.modificador_consumo
                    where modificador_id = nullif(v_op->>'id', '')::uuid loop
          v_costo_linea := v_costo_linea + inv.descontar(new.empresa_id, new.sucursal_id, v_it.insumo_id,
                             v_it.cantidad * v_det.cantidad, 'consumo', 'venta', new.id, null, new.cajero_id);
        end loop;
      end loop;
      if v_det.cantidad > 0 and v_costo_linea > 0 then
        update pos.detalle_venta set costo_unitario = round(v_costo_linea / v_det.cantidad, 4) where id = v_det.id;
      end if;
    end loop;

  elsif old.estado = 'pagada' and new.estado = 'anulada' then
    for v_mov in select * from inv.movimientos where referencia_tipo = 'venta' and referencia_id = new.id and tipo = 'consumo' loop
      if v_mov.lote_id is not null then
        update inv.lotes set cantidad_actual = cantidad_actual - v_mov.cantidad where id = v_mov.lote_id;  -- cantidad es negativa
      end if;
      insert into inv.movimientos (empresa_id, sucursal_id, insumo_id, lote_id, tipo, cantidad, costo_unitario, costo_total,
                                   referencia_tipo, referencia_id, motivo, usuario_id)
      values (v_mov.empresa_id, v_mov.sucursal_id, v_mov.insumo_id, v_mov.lote_id, 'reversa', -v_mov.cantidad,
              v_mov.costo_unitario, round(-v_mov.costo_total, 2), 'venta', new.id, 'Anulación de venta', new.anulada_por);
    end loop;
  end if;
  return new;
end $$;

create trigger venta_inventario after update of estado on pos.ventas
  for each row when (old.estado is distinct from new.estado)
  execute function inv.al_cambiar_estado_venta();

alter table inv.insumos             enable row level security;
alter table inv.compras             enable row level security;
alter table inv.compra_items        enable row level security;
alter table inv.lotes               enable row level security;
alter table inv.movimientos         enable row level security;
alter table inv.receta_items        enable row level security;
alter table inv.modificador_consumo enable row level security;
