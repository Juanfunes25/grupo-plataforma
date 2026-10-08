-- ════════════════════════════════════════════════════════════════════════════
-- 0024 · Mínimos de inventario negativos
-- El catálogo importado de WizPOS trae -2,147,483,648 (el «sin límite» de ese sistema) como stock mínimo en 214 de los
-- 277 productos de DISERCO: la pantalla mostraba «-2,147,483,648» y editar el producto fallaba porque el mínimo debe ser ≥ 0.
-- Un mínimo negativo no significa nada: se normaliza a 0 («sin mínimo»).
-- ════════════════════════════════════════════════════════════════════════════
update pos.productos set stock_minimo = 0 where stock_minimo < 0;
update inv.insumos   set stock_minimo = 0 where stock_minimo < 0;
update fab.insumos   set stock_minimo = 0 where stock_minimo < 0;
