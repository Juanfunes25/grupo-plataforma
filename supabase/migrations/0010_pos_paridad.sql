-- ════════════════════════════════════════════════════════════════════════════
-- 0010 · POS: paridad con Italo Facturación
--   · contadores de impresión por factura (la 1.ª impresión es original; las demás salen COPIA #n)
--   · color por sucursal (para que un cajero no confunda en cuál factura) con la misma paleta de Italo
-- ════════════════════════════════════════════════════════════════════════════
alter table pos.ventas
  add column if not exists impresiones        int not null default 0,
  add column if not exists reimpresiones      int not null default 0,
  add column if not exists ultima_impresion_at timestamptz;

-- Las sucursales sin color reciben uno de la paleta, sin repetir dentro de la empresa.
update core.sucursales s set color = p.color
from (
  select id, (array['#c5603c','#2e9e8f','#b08d28','#6c7fd6','#d2567a','#3d9fd6','#7fa83e','#a47bd6'])[1 + ((row_number() over (partition by empresa_id order by orden, nombre) - 1) % 8)::int] as color
  from core.sucursales
) p
where p.id = s.id and s.color is null;

-- Búsqueda rápida por número de factura en el listado de Facturas.
create index if not exists ventas_factura_busqueda_idx on pos.ventas (empresa_id, numero_factura) where numero_factura is not null;
