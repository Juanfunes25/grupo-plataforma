-- ─────────────────────────────────────────────────────────────────────────
-- Color de cada sucursal guardado en la base de datos (antes se derivaba
-- de un hash del id sobre 4 colores: con una 5ª sucursal se repetiría un
-- color). Se conservan exactamente los colores que ya tenían.
-- ─────────────────────────────────────────────────────────────────────────
alter table sucursales add column if not exists color text;
alter table sucursales drop constraint if exists sucursales_color_formato;
alter table sucursales add constraint sucursales_color_formato check (color is null or color ~ '^#[0-9a-fA-F]{6}$');

update sucursales set color = '#6c7fd6' where alias = '10_calle_express' and color is null;
update sucursales set color = '#c5603c' where alias = 'los_andes' and color is null;
update sucursales set color = '#b08d28' where alias = 'mackey' and color is null;
update sucursales set color = '#2e9e8f' where alias = 'proceres' and color is null;

-- ─────────────────────────────────────────────────────────────────────────
-- Cierre de caja con cuadre por forma de pago: lo que dice el sistema
-- contra lo que reportan los dos POS (BAC y Ficohsa) y el efectivo contado.
-- ─────────────────────────────────────────────────────────────────────────
alter table cierres_caja add column if not exists efectivo_sistema numeric(12, 2);
alter table cierres_caja add column if not exists tarjeta_sistema numeric(12, 2);
alter table cierres_caja add column if not exists transferencia_sistema numeric(12, 2);
alter table cierres_caja add column if not exists pos_bac numeric(12, 2);
alter table cierres_caja add column if not exists pos_ficohsa numeric(12, 2);
alter table cierres_caja add column if not exists diferencia_tarjeta numeric(12, 2);
alter table cierres_caja add column if not exists diferencia_efectivo numeric(12, 2);
alter table cierres_caja add column if not exists cantidad_facturas integer;
alter table cierres_caja add column if not exists total_ventas numeric(12, 2);
alter table cierres_caja add column if not exists observaciones text;
