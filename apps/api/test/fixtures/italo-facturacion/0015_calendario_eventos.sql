-- Calendario de eventos: una cotización aceptada se convierte en un evento
-- agendado con hora, sucursal que lo atiende, anticipo y una lista de
-- control (checklist) para darle seguimiento hasta que se realiza y se cobra.

alter table cotizaciones_eventos add column if not exists hora_evento time;
alter table cotizaciones_eventos add column if not exists sucursal_id uuid references sucursales(id);
alter table cotizaciones_eventos add column if not exists anticipo numeric(12, 2) not null default 0 check (anticipo >= 0);
alter table cotizaciones_eventos add column if not exists checklist jsonb not null default '{}'::jsonb;
alter table cotizaciones_eventos add column if not exists notas_seguimiento text;
alter table cotizaciones_eventos add column if not exists aceptada_at timestamptz;
alter table cotizaciones_eventos add column if not exists realizado boolean not null default false;

-- Las ya aceptadas/facturadas quedan con su fecha de aceptación aproximada.
update cotizaciones_eventos
set aceptada_at = created_at
where aceptada_at is null and estado in ('aceptada', 'facturada');

create index if not exists cotizaciones_eventos_fecha_idx on cotizaciones_eventos (fecha_evento);
