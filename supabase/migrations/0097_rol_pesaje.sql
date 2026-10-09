-- Roles «pesaje» (pesar el gelato desde el teléfono; la caja es otro perfil) y «prod_despacho» (la misma persona produce y despacha).
alter table core.accesos drop constraint if exists accesos_rol_check;
alter table core.accesos add constraint accesos_rol_check check (rol in
  ('dueno','admin','gerente','cajero','pesaje','produccion','prod_despacho','bodega','ventas','contador','solo_lectura','gestor'));
