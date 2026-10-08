-- Cotización de eventos (bodas, cumpleaños, corporativos): cantidad de
-- copitas + costo de servicio, con un PDF presentable para enviar al
-- cliente. No es un documento fiscal — no usa correlativo de CAI.

create type estado_cotizacion as enum ('borrador', 'enviada', 'aceptada', 'rechazada');

create sequence if not exists cotizaciones_eventos_numero_seq;

create table cotizaciones_eventos (
  id uuid primary key default gen_random_uuid(),
  numero bigint not null default nextval('cotizaciones_eventos_numero_seq'),
  nombre_cliente text not null,
  telefono_cliente text,
  email_cliente text,
  nombre_evento text not null,
  fecha_evento date,
  lugar text,
  cantidad_copitas int not null check (cantidad_copitas > 0),
  precio_copita numeric(12, 2) not null check (precio_copita >= 0),
  costo_servicio numeric(12, 2) not null default 0 check (costo_servicio >= 0),
  descuento numeric(12, 2) not null default 0 check (descuento >= 0),
  notas text,
  estado estado_cotizacion not null default 'borrador',
  usuario_id uuid references perfiles(id),
  created_at timestamptz not null default now()
);

alter sequence cotizaciones_eventos_numero_seq owned by cotizaciones_eventos.numero;

alter table cotizaciones_eventos enable row level security;
