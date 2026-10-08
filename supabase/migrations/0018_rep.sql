-- ════════════════════════════════════════════════════════════════════════════
-- 0018 · REP — Reposición de gelato (Italo): pesaje nocturno, despachos,
--         pedidos de insumos, catálogo de sabores y consumo.
--
-- Portado de la app original «Italo Reposición» (backend/db.js). Todo cuelga de
-- empresa_id; el módulo se enciende con 'reposicion' en core.empresa_modulos
-- (solo Italo, ver 0017). Las sucursales NO se duplican: son core.sucursales
-- (Los Andes = tipo 'fabrica', las demás 'tienda'); lo propio de reposición va
-- en rep.sucursal_config.
--
-- ┌─ CONTRATO CON PRODUCCIÓN (R2, esquema prod, 0019) E INVENTARIO (R3, 0020) ─┐
-- │ 1. rep.sabores es EL catálogo de sabores de Italo. Producción, costeo,     │
-- │    RFID e incidencias referencian rep.sabores(id) (uuid). Un sabor nace    │
-- │    en producción: POST /api/rep/sabores (permiso rep:producir) o directo   │
-- │    con INSERT en rep.sabores (empresa_id, nombre en MAYÚSCULAS, gramos_pana).│
-- │      gramos_pana = peso de UNA pana de ese sabor (3000 g; 2500 g en las    │
-- │      frutales). Es la unidad de despacho.                                  │
-- │ 2. rep.pesajes: lo que quedaba de cada sabor en la vitrina de cada         │
-- │    sucursal al cerrar (gramos). Varios por noche son válidos: manda el     │
-- │    último (created_at).                                                    │
-- │ 3. rep.despachos: una fila por (fecha del pedido, sucursal, sabor).        │
-- │    estado: pendiente → preparado → enviado → recibido | no_disponible.     │
-- │    El API calcula en el pesaje: categoria 'roja' (<3000 g: 2 panas) o      │
-- │    'amarilla' (3000–5000 g: 1 pana). enviado_en = día en que sale de       │
-- │    fábrica.                                                                │
-- │ 4. rep.despacho_tandas liga un despacho con la tanda de producción de la   │
-- │    que salió (FIFO, lo más viejo primero). produccion_id es uuid SIN FK    │
-- │    a propósito: la tabla de tandas vive en el esquema de R2. El API de     │
-- │    reposición descuenta 'kg_restante' de prod.producciones SOLO si esa     │
-- │    tabla existe (ver modulos/rep/tandas.js); si R2 cambia nombres, se      │
-- │    ajusta ahí, en un solo lugar.                                           │
-- │ 5. rep.insumos_catalogo = catálogo de insumos/empaques que las tiendas     │
-- │    PIDEN (vasos, conos…). R3 puede apoyarse en él para el inventario por   │
-- │    sucursal (cantidad por tienda: tabla de R3).                            │
-- │ 6. La venta del POS (pos.ventas) se cruza con el consumo en el módulo de   │
-- │    consumo, solo lectura. Nada aquí escribe en pos.                        │
-- └────────────────────────────────────────────────────────────────────────────┘
-- ════════════════════════════════════════════════════════════════════════════

create schema if not exists rep;

-- ─── Configuración de reposición por sucursal ──────────────────────────────
-- fuera_de_analisis: Los Andes está dentro de la fábrica y se sirve sola; no registra
--   despachos y contaminaría los modelos de demanda (ver sucursalesAnalitica.js original).
-- cerrada: tienda que cerró; conserva historial pero no cuenta en análisis.
-- (La geocerca de cada tienda para marcar asistencia vive en rrhh.sucursal_geo, de RRHH.)
create table rep.sucursal_config (
  sucursal_id        uuid primary key references core.sucursales(id) on delete cascade,
  empresa_id         uuid not null references core.empresas(id),
  fuera_de_analisis  boolean not null default false,
  motivo_exclusion   text,
  cerrada            boolean not null default false,
  updated_at         timestamptz not null default now()
);
create index rep_sucursal_config_empresa_idx on rep.sucursal_config (empresa_id);

-- ─── Catálogo de sabores ────────────────────────────────────────────────────
create table rep.sabores (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references core.empresas(id),
  nombre      text not null,
  gramos_pana int  not null default 3000 check (gramos_pana > 0 and gramos_pana <= 20000),
  activo      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (empresa_id, nombre)
);

-- Qué sabores pesa cada sucursal (sin fila = no lo pesa).
create table rep.sucursal_sabores (
  sucursal_id uuid not null references core.sucursales(id) on delete cascade,
  sabor_id    uuid not null references rep.sabores(id),
  empresa_id  uuid not null references core.empresas(id),
  activo      boolean not null default true,
  primary key (sucursal_id, sabor_id)
);
create index rep_sucursal_sabores_empresa_idx on rep.sucursal_sabores (empresa_id);

-- ─── Pesajes nocturnos ──────────────────────────────────────────────────────
create table rep.pesajes (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references core.empresas(id),
  sucursal_id uuid not null references core.sucursales(id),
  sabor_id    uuid not null references rep.sabores(id),
  fecha       date not null,
  gramos      numeric(10,1) not null check (gramos >= 0 and gramos <= 50000),
  fuente      text not null default 'manual' check (fuente in ('manual','foto')),
  -- Idempotencia: un doble toque o un reintento de la cola sin señal no duplica el pesaje.
  cliente_id  text,
  usuario_id  uuid references core.usuarios(id),
  created_at  timestamptz not null default now()
);
create index rep_pesajes_suc_fecha_idx on rep.pesajes (empresa_id, sucursal_id, fecha);
create unique index rep_pesajes_cliente_idx on rep.pesajes (empresa_id, cliente_id) where cliente_id is not null;

-- ─── Despachos ──────────────────────────────────────────────────────────────
create table rep.despachos (
  id                           uuid primary key default gen_random_uuid(),
  empresa_id                   uuid not null references core.empresas(id),
  fecha                        date not null,                 -- noche en que la tienda lo pidió
  sucursal_id                  uuid not null references core.sucursales(id),
  sabor_id                     uuid not null references rep.sabores(id),
  categoria                    text not null check (categoria in ('roja','amarilla')),
  panas                        int  not null,
  gramos_enviados              int  not null,
  estado                       text not null default 'pendiente'
                                 check (estado in ('pendiente','preparado','enviado','recibido','no_disponible')),
  gramos_confirmados_recibidos numeric,
  panas_recibidas              int,
  discrepancia                 boolean not null default false,
  discrepancia_resuelta        boolean not null default false,
  notas                        text not null default '',
  enviado_en                   date,                          -- día en que salió de fábrica
  recibido_por                 uuid references core.usuarios(id),
  recibido_at                  timestamptz,
  created_at                   timestamptz not null default now(),
  unique (empresa_id, fecha, sucursal_id, sabor_id)
);
create index rep_despachos_fecha_idx on rep.despachos (empresa_id, fecha);
create index rep_despachos_enviado_idx on rep.despachos (empresa_id, enviado_en) where enviado_en is not null;
create index rep_despachos_sabor_idx on rep.despachos (sabor_id);

-- Qué tanda de producción se fue en qué despacho (trazabilidad). produccion_id: ver contrato (4).
create table rep.despacho_tandas (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references core.empresas(id),
  despacho_id   uuid not null references rep.despachos(id) on delete cascade,
  produccion_id uuid not null,
  gramos        numeric not null
);
create index rep_despacho_tandas_despacho_idx on rep.despacho_tandas (despacho_id);
create index rep_despacho_tandas_produccion_idx on rep.despacho_tandas (produccion_id);

-- ─── Pedidos de insumos de las tiendas ──────────────────────────────────────
create table rep.insumos_catalogo (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references core.empresas(id),
  nombre        text not null,
  unidad        text not null default 'u',
  categoria     text,
  codigo_barras text,
  stock_minimo  numeric,
  stock_maximo  numeric,
  es_equipo     boolean not null default false,
  activo        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (empresa_id, nombre)
);
create unique index rep_insumos_barcode_idx on rep.insumos_catalogo (empresa_id, codigo_barras) where codigo_barras is not null;

-- Qué insumos ve cada tienda para pedir. Sin fila = ACTIVO (a diferencia de sucursal_sabores).
create table rep.sucursal_insumos (
  sucursal_id uuid not null references core.sucursales(id) on delete cascade,
  insumo_id   uuid not null references rep.insumos_catalogo(id) on delete cascade,
  empresa_id  uuid not null references core.empresas(id),
  activo      boolean not null default true,
  primary key (sucursal_id, insumo_id)
);

create table rep.pedidos_insumos (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references core.empresas(id),
  sucursal_id uuid not null references core.sucursales(id),
  fecha       date not null,
  notas       text not null default '',
  estado      text not null default 'pedido' check (estado in ('pedido','preparado','enviado','recibido')),
  creado_por  uuid references core.usuarios(id),
  created_at  timestamptz not null default now()
);
create index rep_pedidos_idx on rep.pedidos_insumos (empresa_id, fecha);
create index rep_pedidos_suc_idx on rep.pedidos_insumos (sucursal_id, created_at desc);

create table rep.pedido_items (
  id            uuid primary key default gen_random_uuid(),
  pedido_id     uuid not null references rep.pedidos_insumos(id) on delete cascade,
  insumo_texto  text not null,
  cantidad      text not null default '',
  preparado     boolean not null default false,
  enviado       boolean not null default false,
  created_at    timestamptz not null default now()
);
create index rep_pedido_items_idx on rep.pedido_items (pedido_id);

-- ─── Gerente digital: cobertura mínima y hallazgos descartados ──────────────
create table rep.cobertura_minimos (
  sucursal_id uuid not null references core.sucursales(id) on delete cascade,
  empresa_id  uuid not null references core.empresas(id),
  dia_semana  int  not null check (dia_semana between 0 and 6),   -- 0 = lunes
  minimo      int  not null check (minimo between 0 and 20),
  primary key (sucursal_id, dia_semana)
);

create table rep.gerente_descartes (
  empresa_id uuid not null references core.empresas(id),
  huella     text not null,
  estado     text not null check (estado in ('visto','no_es_problema')),
  nota       text,
  hasta      date not null,
  created_at timestamptz not null default now(),
  primary key (empresa_id, huella)
);

-- ─── Resumen diario: dejado listo, envío pendiente de configurar correo ─────
create table rep.resumenes (
  empresa_id uuid not null references core.empresas(id),
  fecha      date not null,
  estado     text not null default 'pendiente_configurar' check (estado in ('pendiente_configurar','enviado','error')),
  asunto     text,
  texto      text,
  html       text,
  detalle    text,
  updated_at timestamptz not null default now(),
  primary key (empresa_id, fecha)
);

-- ─── Seguridad: RLS activa y sin políticas (solo el API entra) ──────────────
alter table rep.sucursal_config   enable row level security;
alter table rep.sabores           enable row level security;
alter table rep.sucursal_sabores  enable row level security;
alter table rep.pesajes           enable row level security;
alter table rep.despachos         enable row level security;
alter table rep.despacho_tandas   enable row level security;
alter table rep.insumos_catalogo  enable row level security;
alter table rep.sucursal_insumos  enable row level security;
alter table rep.pedidos_insumos   enable row level security;
alter table rep.pedido_items      enable row level security;
alter table rep.cobertura_minimos enable row level security;
alter table rep.gerente_descartes enable row level security;
alter table rep.resumenes         enable row level security;

-- ─── Siembra idempotente para Italo (backend/scripts/seedSabores.js) ────────
-- Configuración de sucursales: Los Andes se sirve sola desde la fábrica y queda fuera del análisis.
insert into rep.sucursal_config (sucursal_id, empresa_id, fuera_de_analisis, motivo_exclusion)
select s.id, s.empresa_id, s.alias = 'los_andes',
       case when s.alias = 'los_andes' then 'Se sirve directo de la fábrica: no registra despachos, así que sus datos no son comparables con los de las demás tiendas.' end
from core.sucursales s join core.empresas e on e.id = s.empresa_id
where e.codigo = 'italo'
on conflict (sucursal_id) do nothing;

insert into rep.sabores (empresa_id, nombre, gramos_pana)
select e.id, v.nombre, v.pana
from core.empresas e
cross join (values
  ('ALMENDRA VEGANO',3000),('ARANDANO',3000),('BISCOTTO DELLA NONNA',3000),('BISCOTTO LIMON MERENGUE',3000),
  ('CAFFE',3000),('CHEESECAKE GUAYABA',3000),('CHOCOLATE FONDENTE',3000),('CHOCOLATE PROTEICO',3000),
  ('CHOCOLATE SIN AZUCAR',3000),('CREMA DE LIMON',3000),('CROCCANTE',3000),('DOPPIO PECCATO',3000),
  ('DULCE DE LECHE AL COCO',3000),('DUBAI',3000),('FIOR DI LATTE',3000),('GIANDUIA',3000),('HORCHATA',3000),
  ('MALAGA',3000),('MANI PROTEICO',3000),('MARACUYA',3000),('MOCCARPONE',3000),('NOCCIOLA',3000),('NUVOLA',3000),
  ('PISTACCHIO',3000),('PRETZEL',3000),('STRACCIATELLA',3000),('TORTA DI FORMAGGIO',3000),
  ('VAINILLA PROTEICO',3000),('WHISKY',3000),('YOGURT DE FRAGOLA',3000),('YOGURT MIEL Y NUEZ',3000),
  ('MANGO',2500),('FRAGOLA',2500),('ARANDANO SIN AZUCAR',2500),('FRUTOS ROJOS',2500)
) as v(nombre, pana)
where e.codigo = 'italo'
on conflict (empresa_id, nombre) do nothing;

-- Catálogo inicial: todos los sabores activos en todas las sucursales (ajustar subconjuntos reales desde la app).
insert into rep.sucursal_sabores (sucursal_id, sabor_id, empresa_id, activo)
select s.id, sa.id, s.empresa_id, true
from core.sucursales s
join core.empresas e on e.id = s.empresa_id and e.codigo = 'italo'
join rep.sabores sa on sa.empresa_id = e.id
on conflict (sucursal_id, sabor_id) do nothing;
