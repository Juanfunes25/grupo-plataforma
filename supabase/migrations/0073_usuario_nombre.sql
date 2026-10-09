-- Nombre de usuario para entrar sin correo (solo dueño y administradores exigen correo).
alter table core.usuarios add column if not exists usuario text;
alter table core.usuarios drop constraint if exists usuarios_usuario_formato;
alter table core.usuarios add constraint usuarios_usuario_formato check (usuario is null or usuario ~ '^[a-z0-9._-]{3,30}$');
create unique index if not exists usuarios_usuario_uq on core.usuarios (usuario) where usuario is not null;
