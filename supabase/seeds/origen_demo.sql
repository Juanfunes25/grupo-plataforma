-- ════════════════════════════════════════════════════════════════════════════
-- DEMO · Catálogo de arranque de ORIGEN (jugos prensados, smoothies, bowls, fruta)
-- Precios y recetas son de EJEMPLO para probar el sistema: se ajustan desde
-- Catálogo e Inventario. Idempotente: no hace nada si Origen ya tiene productos.
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  e uuid; s uuid;
  c_jugos uuid; c_smoothies uuid; c_bowls uuid; c_shots uuid; c_fruta uuid;
  g_tam uuid; g_boost uuid; g_leche uuid;
  p uuid;
begin
  select id into e from core.empresas where codigo = 'origen';
  select id into s from core.sucursales where empresa_id = e order by orden limit 1;
  if exists (select 1 from pos.productos where empresa_id = e) then
    raise notice 'Origen ya tiene productos; no se siembra nada.';
    return;
  end if;

  -- Insumos (unidad, costo por unidad en L, mínimo, perecedero, vida útil)
  insert into inv.insumos (empresa_id, nombre, categoria, unidad, costo_actual, stock_minimo, perecedero, vida_util_dias) values
    (e, 'Naranja',            'Fruta',     'unidad', 4.50,  40, true, 7),
    (e, 'Zanahoria',          'Verdura',   'kg',    22.00,   5, true, 10),
    (e, 'Piña',               'Fruta',     'kg',    20.00,   6, true, 5),
    (e, 'Manzana verde',      'Fruta',     'kg',    45.00,   4, true, 10),
    (e, 'Espinaca',           'Verdura',   'kg',    80.00,   2, true, 4),
    (e, 'Pepino',             'Verdura',   'kg',    25.00,   4, true, 7),
    (e, 'Apio',               'Verdura',   'kg',    40.00,   2, true, 7),
    (e, 'Jengibre',           'Verdura',   'kg',    90.00,   1, true, 14),
    (e, 'Limón',              'Fruta',     'unidad', 3.00,  40, true, 14),
    (e, 'Remolacha',          'Verdura',   'kg',    30.00,   3, true, 10),
    (e, 'Mango',              'Fruta',     'kg',    30.00,   8, true, 5),
    (e, 'Fresa',              'Fruta',     'kg',   140.00,   2, true, 4),
    (e, 'Banano',             'Fruta',     'kg',    18.00,   5, true, 5),
    (e, 'Leche de almendra',  'Lácteos',   'l',     95.00,   4, true, 30),
    (e, 'Yogur griego',       'Lácteos',   'kg',    85.00,   3, true, 12),
    (e, 'Granola',            'Despensa',  'kg',   110.00,   1, false, null),
    (e, 'Chía',               'Despensa',  'kg',   220.00, 0.5, false, null),
    (e, 'Miel de abeja',      'Despensa',  'l',    180.00, 0.5, false, null),
    (e, 'Proteína vegetal',   'Despensa',  'kg',   600.00, 0.5, false, null),
    (e, 'Cúrcuma',            'Despensa',  'kg',   260.00, 0.2, false, null),
    (e, 'Botella 12 oz',      'Empaque',   'unidad', 6.50, 60, false, null),
    (e, 'Vaso 16 oz',         'Empaque',   'unidad', 4.00, 80, false, null),
    (e, 'Tapa y sorbete',     'Empaque',   'unidad', 1.50, 80, false, null),
    (e, 'Bowl compostable',   'Empaque',   'unidad', 7.00, 40, false, null);

  -- Existencias iniciales (un lote por insumo) para poder vender desde el primer día
  perform inv.ingresar(e, s, i.id, case when i.unidad = 'unidad' then 200 else 20 end, i.costo_actual, 'ajuste',
                       case when i.perecedero then ((now() at time zone 'America/Tegucigalpa')::date + i.vida_util_dias) end, 'inicial', null, 'Existencia inicial de demostración', null)
    from inv.insumos i where i.empresa_id = e;

  -- Categorías
  insert into pos.categorias (empresa_id, nombre, orden, color) values
    (e, 'Jugos prensados', 1, '#5c9a3a'), (e, 'Smoothies', 2, '#d9568b'), (e, 'Bowls', 3, '#e08a2e'),
    (e, 'Shots', 4, '#c9a227'), (e, 'Fruta y verdura', 5, '#3f8f6b');
  select id into c_jugos from pos.categorias where empresa_id = e and nombre = 'Jugos prensados';
  select id into c_smoothies from pos.categorias where empresa_id = e and nombre = 'Smoothies';
  select id into c_bowls from pos.categorias where empresa_id = e and nombre = 'Bowls';
  select id into c_shots from pos.categorias where empresa_id = e and nombre = 'Shots';
  select id into c_fruta from pos.categorias where empresa_id = e and nombre = 'Fruta y verdura';

  -- Grupos de opciones
  insert into pos.modificador_grupos (empresa_id, nombre, min_sel, max_sel, orden) values (e, 'Tamaño', 1, 1, 1) returning id into g_tam;
  insert into pos.modificador_grupos (empresa_id, nombre, min_sel, max_sel, orden) values (e, 'Boosters', 0, 3, 2) returning id into g_boost;
  insert into pos.modificador_grupos (empresa_id, nombre, min_sel, max_sel, orden) values (e, 'Leche', 0, 1, 3) returning id into g_leche;
  insert into pos.modificadores (grupo_id, nombre, precio_extra, orden) values
    (g_tam, 'Regular 16 oz', 0, 1), (g_tam, 'Grande 24 oz', 25, 2),
    (g_boost, 'Chía', 15, 1), (g_boost, 'Proteína vegetal', 30, 2), (g_boost, 'Cúrcuma', 10, 3), (g_boost, 'Miel', 10, 4),
    (g_leche, 'Leche de almendra', 20, 1);
  -- Lo que consumen los extras
  insert into inv.modificador_consumo (modificador_id, insumo_id, cantidad)
    select m.id, i.id, v.cant from (values
      ('Chía','Chía',0.010), ('Proteína vegetal','Proteína vegetal',0.030), ('Cúrcuma','Cúrcuma',0.005),
      ('Miel','Miel de abeja',0.020), ('Leche de almendra','Leche de almendra',0.200), ('Grande 24 oz','Mango',0.080)) as v(mod, ins, cant)
    join pos.modificadores m on m.nombre = v.mod and m.grupo_id in (g_tam, g_boost, g_leche)
    join inv.insumos i on i.empresa_id = e and i.nombre = v.ins;

  -- Productos + recetas
  create temp table _prod (nombre text, cat uuid, precio numeric, tasa numeric, exento boolean, unidad text, grupos uuid[], orden int) on commit drop;
  insert into _prod values
    ('Green Detox',          c_jugos,     95, 0.15, false, 'unidad', array[g_boost], 1),
    ('Naranja Pura',         c_jugos,     75, 0.15, false, 'unidad', array[g_boost], 2),
    ('Zanahoria Vital',      c_jugos,     85, 0.15, false, 'unidad', array[g_boost], 3),
    ('Roots Remolacha',      c_jugos,     90, 0.15, false, 'unidad', array[g_boost], 4),
    ('Piña Fresca',          c_jugos,     80, 0.15, false, 'unidad', array[g_boost], 5),
    ('Mango Tropical',       c_smoothies,105, 0.15, false, 'unidad', array[g_tam, g_boost, g_leche], 1),
    ('Berry Power',          c_smoothies,115, 0.15, false, 'unidad', array[g_tam, g_boost, g_leche], 2),
    ('Bowl Tropical',        c_bowls,    135, 0.15, false, 'unidad', array[g_boost], 1),
    ('Shot Jengibre-Limón',  c_shots,     45, 0.15, false, 'unidad', array[]::uuid[], 1),
    ('Mango (por kg)',       c_fruta,     45, 0,    true,  'kg',     array[]::uuid[], 1),
    ('Banano (por kg)',      c_fruta,     28, 0,    true,  'kg',     array[]::uuid[], 2);
  insert into pos.productos (empresa_id, nombre, categoria_id, precio, impuesto_tasa, exento, unidad, tipo, orden)
    select e, nombre, cat, precio, tasa, exento, unidad, 'receta', orden from _prod;
  insert into pos.producto_grupos (producto_id, grupo_id, orden)
    select p2.id, g.gid, g.ord - 1 from _prod t join pos.productos p2 on p2.empresa_id = e and p2.nombre = t.nombre,
         lateral unnest(t.grupos) with ordinality as g(gid, ord);

  insert into inv.receta_items (producto_id, insumo_id, cantidad, merma_pct)
    select p2.id, i.id, v.cant, v.merma
    from (values
      ('Green Detox','Espinaca',0.12,8), ('Green Detox','Pepino',0.25,5), ('Green Detox','Apio',0.15,5), ('Green Detox','Manzana verde',0.20,8),
        ('Green Detox','Limón',1,0), ('Green Detox','Jengibre',0.01,0), ('Green Detox','Botella 12 oz',1,0),
      ('Naranja Pura','Naranja',5,0), ('Naranja Pura','Botella 12 oz',1,0),
      ('Zanahoria Vital','Zanahoria',0.40,10), ('Zanahoria Vital','Naranja',1,0), ('Zanahoria Vital','Jengibre',0.01,0), ('Zanahoria Vital','Botella 12 oz',1,0),
      ('Roots Remolacha','Remolacha',0.25,10), ('Roots Remolacha','Zanahoria',0.20,10), ('Roots Remolacha','Manzana verde',0.20,8), ('Roots Remolacha','Limón',1,0), ('Roots Remolacha','Botella 12 oz',1,0),
      ('Piña Fresca','Piña',0.45,35), ('Piña Fresca','Botella 12 oz',1,0),
      ('Mango Tropical','Mango',0.25,30), ('Mango Tropical','Banano',0.10,25), ('Mango Tropical','Yogur griego',0.10,0), ('Mango Tropical','Vaso 16 oz',1,0), ('Mango Tropical','Tapa y sorbete',1,0),
      ('Berry Power','Fresa',0.20,8), ('Berry Power','Banano',0.10,25), ('Berry Power','Leche de almendra',0.20,0), ('Berry Power','Vaso 16 oz',1,0), ('Berry Power','Tapa y sorbete',1,0),
      ('Bowl Tropical','Granola',0.05,0), ('Bowl Tropical','Banano',0.10,25), ('Bowl Tropical','Mango',0.10,30), ('Bowl Tropical','Fresa',0.08,8),
        ('Bowl Tropical','Miel de abeja',0.01,0), ('Bowl Tropical','Yogur griego',0.12,0), ('Bowl Tropical','Bowl compostable',1,0),
      ('Shot Jengibre-Limón','Jengibre',0.03,5), ('Shot Jengibre-Limón','Limón',2,0),
      ('Mango (por kg)','Mango',1,0), ('Banano (por kg)','Banano',1,0)
    ) as v(prod, ins, cant, merma)
    join pos.productos p2 on p2.empresa_id = e and p2.nombre = v.prod
    join inv.insumos i on i.empresa_id = e and i.nombre = v.ins;

  -- "Mango (por kg)" y "Banano (por kg)" no llevan receta de empaque, y el cobro es por peso.
  raise notice 'Origen: catálogo demo sembrado.';
end $$;
