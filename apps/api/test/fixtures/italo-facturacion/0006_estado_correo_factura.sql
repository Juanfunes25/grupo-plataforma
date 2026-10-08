-- Para poder avisar en el listado de facturas si el envío automático del
-- PDF al cliente falló, en vez de fallar en silencio como antes.
alter table ventas add column if not exists correo_enviado boolean;
alter table ventas add column if not exists correo_error text;
