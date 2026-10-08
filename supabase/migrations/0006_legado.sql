-- ════════════════════════════════════════════════════════════════════════════
-- 0006 · Campos para recibir la historia de los sistemas anteriores
-- (italo-facturacion y, después, EcoStone/DISERCO) sin perder información legal
-- (identidad del adulto mayor en descuentos del 25 %, reimpresiones, cuadres BAC/Ficohsa…).
-- ════════════════════════════════════════════════════════════════════════════

alter table pos.ventas
  add column tercera_edad_nombre    text,
  add column tercera_edad_identidad text,
  add column nota_interna           text,
  add column correo_enviado         boolean not null default false,
  add column correo_error           text,
  add column impresiones            int not null default 0,
  add column reimpresiones          int not null default 0,
  add column origen_legado          text;          -- p. ej. 'italo-facturacion' (null = nació aquí)
create index ventas_legado_idx on pos.ventas (origen_legado) where origen_legado is not null;

alter table pos.turnos
  add column pos_bac        numeric(12,2),
  add column pos_ficohsa    numeric(12,2),
  add column desglose_pagos jsonb,
  add column salidas        numeric(12,2) not null default 0,
  add column propinas       numeric(12,2) not null default 0,
  add column origen_legado  text;

-- La bitácora antigua tiene su propia cadena de hashes: no cabe en la nueva sin romperla, así que se
-- conserva aparte, tal cual, como evidencia histórica de solo lectura.
create table core.auditoria_legado (
  origen          text not null,
  id              bigint not null,
  created_at      timestamptz,
  usuario_nombre  text,
  accion          text,
  entidad         text,
  entidad_id      text,
  sucursal_nombre text,
  detalle         jsonb,
  ip              text,
  hash            text,
  primary key (origen, id)
);
alter table core.auditoria_legado enable row level security;
