-- ─────────────────────────────────────────────────────────────────────────
-- Código de barras por producto (lector de barras en el POS).
-- ─────────────────────────────────────────────────────────────────────────
alter table productos add column if not exists codigo_barras text;
create unique index if not exists productos_codigo_barras_idx
  on productos(codigo_barras) where codigo_barras is not null;

-- ─────────────────────────────────────────────────────────────────────────
-- Descuento sólo por porcentaje fijo: 0, 10 o 25 (25 = tercera edad).
-- El monto en ventas.descuento se sigue guardando (lo calcula el backend),
-- pero el porcentaje queda registrado para reportar descuentos de tercera
-- edad por separado.
-- ─────────────────────────────────────────────────────────────────────────
alter table ventas add column if not exists descuento_porcentaje smallint not null default 0;
alter table ventas drop constraint if exists ventas_descuento_porcentaje_check;
alter table ventas add constraint ventas_descuento_porcentaje_check
  check (descuento_porcentaje in (0, 10, 25));

-- ─────────────────────────────────────────────────────────────────────────
-- Conversión cotización → factura en un clic.
-- ─────────────────────────────────────────────────────────────────────────
alter type estado_cotizacion add value if not exists 'facturada';
alter table cotizaciones_eventos add column if not exists rtn_cliente text;
alter table cotizaciones_eventos add column if not exists venta_id uuid references ventas(id);

-- ─────────────────────────────────────────────────────────────────────────
-- Bitácora de auditoría inalterable.
--
-- Tres capas:
--   1. Nadie (ni la service_role del backend) puede UPDATE/DELETE/TRUNCATE:
--      privilegios revocados + triggers que abortan la operación.
--   2. Cadena de hashes (como un libro contable): cada fila guarda el
--      SHA-256 de su contenido + el hash de la fila anterior. Si alguien
--      con acceso de superusuario alterara o borrara una fila, la cadena se
--      rompe desde ese punto y verificar_auditoria() lo detecta.
--   3. La fecha la pone la base de datos, no el cliente.
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists auditoria (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  usuario_id uuid references perfiles(id),
  usuario_nombre text,
  accion text not null,
  entidad text not null,
  entidad_id text,
  sucursal_id uuid references sucursales(id),
  detalle jsonb not null default '{}'::jsonb,
  ip text,
  hash_anterior text,
  hash text not null
);

create index if not exists auditoria_created_idx on auditoria(created_at desc);
create index if not exists auditoria_entidad_idx on auditoria(entidad, entidad_id);
create index if not exists auditoria_usuario_idx on auditoria(usuario_id);

alter table auditoria enable row level security;

create or replace function auditoria_calcular_hash(
  p_id bigint,
  p_created_at timestamptz,
  p_usuario_id uuid,
  p_accion text,
  p_entidad text,
  p_entidad_id text,
  p_sucursal_id uuid,
  p_detalle jsonb,
  p_ip text,
  p_hash_anterior text
) returns text
language sql immutable
set search_path = ''
as $$
  select encode(
    extensions.digest(
      concat_ws('|',
        p_id::text,
        to_char(p_created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
        coalesce(p_usuario_id::text, ''),
        p_accion,
        p_entidad,
        coalesce(p_entidad_id, ''),
        coalesce(p_sucursal_id::text, ''),
        p_detalle::text,
        coalesce(p_ip, ''),
        coalesce(p_hash_anterior, 'GENESIS')
      ),
      'sha256'
    ),
    'hex'
  );
$$;

create or replace function auditoria_antes_insertar() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_anterior text;
begin
  -- Serializa las inserciones para que la cadena nunca se bifurque aunque
  -- dos sucursales registren eventos en el mismo milisegundo.
  perform pg_advisory_xact_lock(hashtext('auditoria_cadena'));

  new.created_at := now();
  select a.hash into v_anterior from public.auditoria a order by a.id desc limit 1;
  new.hash_anterior := v_anterior;
  new.hash := public.auditoria_calcular_hash(
    new.id, new.created_at, new.usuario_id, new.accion, new.entidad,
    new.entidad_id, new.sucursal_id, new.detalle, new.ip, new.hash_anterior
  );
  return new;
end;
$$;

create or replace function auditoria_prohibir_cambios() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'La bitácora de auditoría es inalterable: no se permite % sobre sus registros', tg_op;
end;
$$;

drop trigger if exists auditoria_hash on auditoria;
create trigger auditoria_hash
  before insert on auditoria
  for each row execute function auditoria_antes_insertar();

drop trigger if exists auditoria_sin_update on auditoria;
create trigger auditoria_sin_update
  before update or delete on auditoria
  for each row execute function auditoria_prohibir_cambios();

drop trigger if exists auditoria_sin_truncate on auditoria;
create trigger auditoria_sin_truncate
  before truncate on auditoria
  for each statement execute function auditoria_prohibir_cambios();

revoke update, delete, truncate on auditoria from anon, authenticated, service_role;

-- Recorre la cadena completa y devuelve la primera fila alterada (o null
-- si todo está íntegro).
create or replace function verificar_auditoria()
returns table (integra boolean, total bigint, primer_id_alterado bigint)
language plpgsql
set search_path = ''
as $$
declare
  r record;
  v_anterior text := null;
  v_total bigint := 0;
begin
  for r in select * from public.auditoria order by id loop
    v_total := v_total + 1;
    if r.hash_anterior is distinct from v_anterior
       or r.hash <> public.auditoria_calcular_hash(
         r.id, r.created_at, r.usuario_id, r.accion, r.entidad,
         r.entidad_id, r.sucursal_id, r.detalle, r.ip, r.hash_anterior
       ) then
      return query select false, v_total, r.id;
      return;
    end if;
    v_anterior := r.hash;
  end loop;
  return query select true, v_total, null::bigint;
end;
$$;

revoke execute on function verificar_auditoria() from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- Tiempo real (Supabase Realtime, sobre WebSockets): las pantallas reciben
-- los cambios de ventas y catálogo al instante, sin recargar.
-- Realtime respeta RLS, así que cada usuario sólo recibe eventos de lo que
-- puede ver: un cajero con sucursal fija, sólo su sucursal.
-- ─────────────────────────────────────────────────────────────────────────
drop policy if exists "ventas: lectura segun sucursal del perfil" on ventas;
create policy "ventas: lectura segun sucursal del perfil"
  on ventas for select to authenticated
  using (
    exists (
      select 1 from perfiles p
      where p.id = (select auth.uid())
        and p.activo
        and (p.rol <> 'cajero' or p.sucursal_id is null or p.sucursal_id = ventas.sucursal_id)
    )
  );

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'ventas') then
    alter publication supabase_realtime add table ventas;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'productos') then
    alter publication supabase_realtime add table productos;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'categorias') then
    alter publication supabase_realtime add table categorias;
  end if;
end $$;
