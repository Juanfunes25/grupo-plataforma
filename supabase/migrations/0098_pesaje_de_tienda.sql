-- Pesaje de tienda sin PIN (decisión del dueño): cada tienda tiene una cuenta propia («Pesaje Mackey», …) que se abre
-- eligiendo la tienda en la pantalla de entrada. La cuenta se marca es_tienda y solo puede pesar (rol «pesaje»).
alter table core.usuarios add column if not exists es_tienda boolean not null default false;
insert into core.config (empresa_id, clave, valor)
select id, 'pesaje_libre', '{"activo": true}'::jsonb from core.empresas where codigo = 'italo'
on conflict (empresa_id, clave) do nothing;
