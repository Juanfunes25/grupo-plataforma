-- ════════════════════════════════════════════════════════════════════════════
-- 0005 · FINANZAS — gastos por empresa/sucursal y cuentas intercompañía
--
-- Con ventas (pos), costo de insumos (inv) y gastos (fin) en la misma base,
-- el consolidado del grupo calcula utilidad operativa real por empresa y
-- sucursal sin pasar datos a mano entre sistemas.
-- ════════════════════════════════════════════════════════════════════════════

create schema if not exists fin;

create table fin.categorias_gasto (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references core.empresas(id),
  nombre     text not null,
  grupo      text not null default 'operativo'
             check (grupo in ('costo_venta','operativo','nomina','alquiler','servicios','marketing','impuestos','financiero','otro')),
  activo     boolean not null default true,
  unique (empresa_id, nombre)
);

create table fin.gastos (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references core.empresas(id),
  sucursal_id   uuid references core.sucursales(id),
  fecha         date not null default current_date,
  categoria_id  uuid references fin.categorias_gasto(id),
  proveedor_id  uuid references core.terceros(id),
  descripcion   text not null,
  monto         numeric(14,2) not null check (monto > 0),   -- total pagado, ISV incluido
  isv           numeric(14,2) not null default 0,
  documento     text,                                         -- # de factura del proveedor
  comprobante   text,                                         -- URL en Supabase Storage
  forma_pago    text,
  pagado        boolean not null default true,
  anulado       boolean not null default false,
  registrado_por uuid references core.usuarios(id),
  created_at    timestamptz not null default now()
);
create index gastos_empresa_fecha_idx on fin.gastos (empresa_id, fecha desc) where not anulado;

-- Operaciones entre empresas del grupo (ej. DISERCO le vende a EcoStone).
-- Sirve para netear en el consolidado y que no se infle la venta del grupo.
create table fin.intercompania (
  id                 uuid primary key default gen_random_uuid(),
  fecha              date not null default current_date,
  empresa_origen_id  uuid not null references core.empresas(id),
  empresa_destino_id uuid not null references core.empresas(id),
  concepto           text not null,
  monto              numeric(14,2) not null check (monto > 0),
  estado             text not null default 'pendiente' check (estado in ('pendiente','conciliado')),
  registrado_por     uuid references core.usuarios(id),
  created_at         timestamptz not null default now(),
  check (empresa_origen_id <> empresa_destino_id)
);

alter table fin.categorias_gasto enable row level security;
alter table fin.gastos           enable row level security;
alter table fin.intercompania    enable row level security;

insert into fin.categorias_gasto (empresa_id, nombre, grupo)
select e.id, c.nombre, c.grupo from core.empresas e cross join (values
  ('Materia prima / mercadería', 'costo_venta'),
  ('Empaque y desechables',      'costo_venta'),
  ('Planilla y cargas sociales', 'nomina'),
  ('Alquiler',                   'alquiler'),
  ('Energía eléctrica',          'servicios'),
  ('Agua y teléfono / internet', 'servicios'),
  ('Mantenimiento y reparaciones','operativo'),
  ('Transporte y combustible',   'operativo'),
  ('Publicidad y redes',         'marketing'),
  ('Impuestos y permisos',       'impuestos'),
  ('Comisiones bancarias',       'financiero'),
  ('Otros',                      'otro')
) as c(nombre, grupo);
