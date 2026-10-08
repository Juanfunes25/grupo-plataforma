-- ════════════════════════════════════════════════════════════════════════════
-- 0011 · Cierre de caja (paridad con Italo Facturación) y caja chica
--
--  · pos.cierres_caja: el cierre por sucursal y rango (normalmente el día), con el
--    desglose por forma de pago, lo que reportan los POS de tarjeta de cada banco
--    (BAC / Ficohsa…), el efectivo contado (con conteo de billetes y monedas) y la
--    diferencia. Un cierre es inalterable.
--  · Relación con pos.turnos: los turnos siguen abriéndose solos al primer cobro. Al
--    cerrar la caja del día se cierran los turnos que sigan abiertos en esa sucursal
--    (pos.turnos.cierre_id apunta al cierre que los cerró).
--  · pos.movimientos_caja pasa a ser la "caja chica": categoría y fecha propias, y ya
--    no necesita turno abierto para registrarse.
-- ════════════════════════════════════════════════════════════════════════════

create table pos.cierres_caja (
  id                    uuid primary key default gen_random_uuid(),
  empresa_id            uuid not null references core.empresas(id),
  sucursal_id           uuid not null references core.sucursales(id),
  fecha                 date not null,                          -- día de Honduras en que termina el cierre
  fecha_inicio          timestamptz not null,
  fecha_fin             timestamptz not null,
  cajero_id             uuid not null references core.usuarios(id),
  -- Lo que dice el sistema (recalculado en el servidor con las facturas reales)
  cantidad_facturas     int not null default 0,
  factura_desde         text,
  factura_hasta         text,
  total_ventas          numeric(12,2) not null default 0,
  efectivo_sistema      numeric(12,2) not null default 0,       -- neto del cambio
  tarjeta_sistema       numeric(12,2) not null default 0,
  transferencia_sistema numeric(12,2) not null default 0,
  otros_sistema         numeric(12,2) not null default 0,       -- crédito y otras formas
  anuladas              int not null default 0,
  monto_anulado         numeric(12,2) not null default 0,
  desglose_pagos        jsonb not null default '[]'::jsonb,     -- [{nombre,tipo,facturas,monto}]
  -- Lo que se contó / reportó
  pos_bancos            jsonb not null default '{}'::jsonb,     -- {"BAC": 1200, "Ficohsa": 800}
  tarjeta_reportada     numeric(12,2) not null default 0,
  fondo_caja            numeric(12,2) not null default 0,
  ingresos              numeric(12,2) not null default 0,       -- entradas de caja chica
  salidas               numeric(12,2) not null default 0,       -- salidas de caja chica
  efectivo_contado      numeric(12,2) not null default 0,
  conteo                jsonb,                                   -- {"500": 2, "0.5": 4} cantidad por denominación
  -- Resultado del cuadre
  efectivo_esperado     numeric(12,2) not null default 0,
  diferencia_tarjeta    numeric(12,2) not null default 0,
  diferencia_efectivo   numeric(12,2) not null default 0,
  diferencia            numeric(12,2) not null default 0,
  observaciones         text,
  cierre_ciego          boolean not null default false,
  alertas               jsonb not null default '[]'::jsonb,
  turnos_cerrados       int not null default 0,
  estado                text not null default 'cerrado' check (estado in ('cerrado')),
  created_at            timestamptz not null default now(),
  check (fecha_fin > fecha_inicio)
);
create index cierres_caja_empresa_idx on pos.cierres_caja (empresa_id, fecha_fin desc);
create index cierres_caja_sucursal_idx on pos.cierres_caja (sucursal_id, fecha_fin desc);
create index cierres_caja_cajero_idx on pos.cierres_caja (cajero_id, fecha_fin desc);
alter table pos.cierres_caja enable row level security;

-- Inalterable: un cierre no se edita ni se borra (si hubo un error se explica en un cierre/observación posterior).
create function pos.cierres_inalterables() returns trigger language plpgsql as $$
begin
  raise exception 'Un cierre de caja no se puede modificar ni borrar';
end $$;
create trigger cierres_caja_no_update before update or delete on pos.cierres_caja
  for each row execute function pos.cierres_inalterables();

-- Turnos: quién los cerró (el cierre del día) — null si los cerró el propio cajero.
alter table pos.turnos add column cierre_id uuid references pos.cierres_caja(id);
create index turnos_cierre_idx on pos.turnos (cierre_id) where cierre_id is not null;

-- ─── Caja chica sobre pos.movimientos_caja ──────────────────────────────────
alter table pos.movimientos_caja add column categoria text;
alter table pos.movimientos_caja add column fecha date;
update pos.movimientos_caja set fecha = (created_at at time zone 'America/Tegucigalpa')::date where fecha is null;
alter table pos.movimientos_caja alter column fecha set not null;
alter table pos.movimientos_caja alter column fecha set default ((now() at time zone 'America/Tegucigalpa')::date);
create index movimientos_caja_fecha_idx on pos.movimientos_caja (empresa_id, sucursal_id, fecha desc);
