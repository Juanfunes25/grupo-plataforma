-- ════════════════════════════════════════════════════════════════════════════
-- 0071 · PLANILLA HONDURAS (mejora 19)
--
-- Lee empleados, salarios, ausencias y vacaciones del esquema rrhh y calcula la
-- planilla por empresa (quincena, mes, décimo tercero y catorceavo).
--
-- ┌─ MUY IMPORTANTE ───────────────────────────────────────────────────────────┐
-- │ Los porcentajes, techos y la tabla de ISR de abajo son VALORES DE ARRANQUE │
-- │ (por_confirmar = true). NO son definitivos: el contador debe validarlos y  │
-- │ marcarlos como confirmados desde la pantalla de parámetros. La ley cambia  │
-- │ cada año (techo del IHSS, salario mínimo, tabla del ISR).                  │
-- └────────────────────────────────────────────────────────────────────────────┘
-- Los parámetros son del GRUPO (la ley es la misma para las cuatro empresas);
-- cada planilla guarda una copia exacta de los que usó, así una planilla vieja
-- se puede reconstruir aunque después cambien. Todo requiere rrhh:sensible.
-- ════════════════════════════════════════════════════════════════════════════

create schema if not exists plan;

create table plan.parametros (
  clave          text primary key,
  grupo          text not null,
  nombre         text not null,
  valor          numeric(14,4) not null,
  unidad         text not null default '',
  nota           text,
  por_confirmar  boolean not null default true,
  confirmado_por uuid references core.usuarios(id),
  confirmado_at  timestamptz,
  updated_by     uuid references core.usuarios(id),
  updated_at     timestamptz not null default now()
);

create table plan.isr_tramos (
  id            uuid primary key default gen_random_uuid(),
  orden         int  not null,
  desde         numeric(14,2) not null check (desde >= 0),   -- renta neta ANUAL gravable desde
  tasa          numeric(6,3)  not null check (tasa >= 0 and tasa <= 100),
  por_confirmar boolean not null default true,
  vigente_desde date,
  updated_at    timestamptz not null default now()
);

insert into plan.parametros (clave, grupo, nombre, valor, unidad, nota) values
  ('dias_mes',               'general', 'Días de un mes para sueldo diario',           30,  'días', 'Sueldo diario = salario mensual ÷ este número.'),
  ('horas_dia_diurna',       'general', 'Horas de la jornada diurna',                   8,  'h',    'Para el valor de la hora ordinaria.'),
  ('horas_dia_mixta',        'general', 'Horas de la jornada mixta',                    7,  'h',    NULL),
  ('horas_dia_nocturna',     'general', 'Horas de la jornada nocturna',                 6,  'h',    NULL),
  ('he_diurna_pct',          'horas',   'Recargo hora extra diurna',                   25,  '%',    'Se paga hora ordinaria + este recargo.'),
  ('he_nocturna_pct',        'horas',   'Recargo hora extra nocturna',                 75,  '%',    NULL),
  ('he_feriada_pct',         'horas',   'Recargo hora extra en feriado / descanso',   100,  '%',    NULL),
  ('ihss_techo_mensual',     'ihss',    'Techo de cotización del IHSS (mensual)',   11903.13, 'L',  'Sueldo máximo sobre el que se cotiza. Cambia cada año.'),
  ('ihss_em_empleado_pct',   'ihss',    'IHSS enfermedad-maternidad · empleado',      2.5,  '%',    NULL),
  ('ihss_em_patrono_pct',    'ihss',    'IHSS enfermedad-maternidad · patrono',         5,   '%',    NULL),
  ('ihss_ivm_empleado_pct',  'ihss',    'IHSS invalidez-vejez-muerte · empleado',     2.5,  '%',    NULL),
  ('ihss_ivm_patrono_pct',   'ihss',    'IHSS invalidez-vejez-muerte · patrono',      3.5,  '%',    NULL),
  ('rap_exento_mensual',     'rap',     'RAP: sueldo mensual libre de aporte',      11903.13, 'L',  'El RAP se calcula sobre lo que pasa de este monto.'),
  ('rap_empleado_pct',       'rap',     'RAP · empleado',                             1.5,  '%',    NULL),
  ('rap_patrono_pct',        'rap',     'RAP · patrono',                              1.5,  '%',    NULL),
  ('infop_patrono_pct',      'infop',   'INFOP · patrono (sobre la planilla)',          1,  '%',    'Normalmente lo paga solo el patrono.'),
  ('infop_empleado_pct',     'infop',   'INFOP · empleado',                             0,  '%',    NULL),
  ('isr_gastos_medicos',     'isr',     'ISR: deducción anual por gastos médicos',  40000,  'L',    'Se resta de la renta anual antes de aplicar la tabla.'),
  ('isr_deduce_ihss',        'isr',     'ISR: restar IHSS y RAP del empleado (1 = sí)', 0,  '',     'Déjalo en 0 hasta que el contador diga lo contrario.'),
  ('decimos_dias_base',      'decimos', 'Días base del año para el proporcional',     365,  'días', 'Proporcional por antigüedad = días trabajados ÷ este número (máximo 1).'),
  ('aguinaldo_mes_pago',     'decimos', 'Mes de pago del décimo tercer mes',           12,  'mes',  NULL),
  ('aguinaldo_dia_pago',     'decimos', 'Día de pago del décimo tercer mes',           20,  'día',  NULL),
  ('catorceavo_mes_pago',    'decimos', 'Mes de pago del catorceavo mes',               6,  'mes',  NULL),
  ('catorceavo_dia_pago',    'decimos', 'Día de pago del catorceavo mes',              30,  'día',  NULL),
  ('vacaciones_prima_pct',   'vacaciones', 'Pago adicional sobre los días de vacaciones', 0, '%',   'Las vacaciones ya van dentro del sueldo; esto es un extra opcional.');

insert into plan.isr_tramos (orden, desde, tasa) values
  (1,       0.00,  0),
  (2,  217493.17, 15),
  (3,  494224.41, 20),
  (4,  771252.38, 25);

-- ─── Novedades: horas extra, bonos y descuentos manuales ────────────────────
create table plan.novedades (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references core.empresas(id),
  empleado_id uuid not null references rrhh.empleados(id),
  fecha       date not null,
  tipo        text not null check (tipo in ('he_diurna','he_nocturna','he_feriada','bono','descuento')),
  horas       numeric(6,2) check (horas is null or horas > 0),
  monto       numeric(12,2) check (monto is null or monto > 0),
  concepto    text,
  estado      text not null default 'pendiente' check (estado in ('pendiente','aplicada','anulada')),
  planilla_id uuid,
  creado_por  uuid references core.usuarios(id),
  created_at  timestamptz not null default now(),
  check ((tipo like 'he_%' and horas is not null) or (tipo in ('bono','descuento') and monto is not null))
);
create index plan_novedades_idx on plan.novedades (empresa_id, fecha);
create index plan_novedades_emp_idx on plan.novedades (empleado_id, fecha);

-- ─── Planillas ──────────────────────────────────────────────────────────────
create table plan.planillas (
  id               uuid primary key default gen_random_uuid(),
  empresa_id       uuid not null references core.empresas(id),
  tipo             text not null check (tipo in ('quincena','mensual','aguinaldo','catorceavo')),
  etiqueta         text not null,
  desde            date not null,
  hasta            date not null,
  fecha_pago       date,
  estado           text not null default 'borrador' check (estado in ('borrador','aprobada','pagada','anulada')),
  parametros       jsonb not null default '{}'::jsonb,       -- copia de lo usado al calcular
  totales          jsonb not null default '{}'::jsonb,
  advertencias     jsonb not null default '[]'::jsonb,
  por_confirmar    boolean not null default true,            -- se calculó con parámetros sin confirmar
  notas            text,
  creada_por       uuid references core.usuarios(id),
  created_at       timestamptz not null default now(),
  calculada_at     timestamptz,
  aprobada_por     uuid references core.usuarios(id),
  aprobada_at      timestamptz,
  pagada_por       uuid references core.usuarios(id),
  pagada_at        timestamptz,
  anulada_por      uuid references core.usuarios(id),
  anulada_at       timestamptz,
  motivo_anulacion text,
  gasto_id         uuid,                                     -- fin.gastos creado al "enviar a Finanzas"
  check (hasta >= desde)
);
create unique index plan_planillas_periodo_uq on plan.planillas (empresa_id, tipo, desde, hasta) where estado <> 'anulada';
create index plan_planillas_idx on plan.planillas (empresa_id, desde desc);

create table plan.planilla_lineas (
  id               uuid primary key default gen_random_uuid(),
  planilla_id      uuid not null references plan.planillas(id) on delete cascade,
  empleado_id      uuid not null references rrhh.empleados(id),
  nombre           text not null,
  identidad        text,
  puesto           text,
  sucursal         text,
  salario_mensual  numeric(12,2) not null,
  dias_pagados     numeric(6,2) not null default 0,
  devengado        numeric(12,2) not null default 0,
  desc_ausencias   numeric(12,2) not null default 0,
  he_diurna_h      numeric(6,2) not null default 0,
  he_nocturna_h    numeric(6,2) not null default 0,
  he_feriada_h     numeric(6,2) not null default 0,
  he_monto         numeric(12,2) not null default 0,
  bonos            numeric(12,2) not null default 0,
  vacaciones_dias  numeric(6,2) not null default 0,
  vacaciones_extra numeric(12,2) not null default 0,
  ihss             numeric(12,2) not null default 0,
  rap              numeric(12,2) not null default 0,
  infop            numeric(12,2) not null default 0,
  isr              numeric(12,2) not null default 0,
  otros_desc       numeric(12,2) not null default 0,
  total_ingresos   numeric(12,2) not null default 0,
  total_deducciones numeric(12,2) not null default 0,
  neto             numeric(12,2) not null default 0,
  ihss_patrono     numeric(12,2) not null default 0,
  rap_patrono      numeric(12,2) not null default 0,
  infop_patrono    numeric(12,2) not null default 0,
  detalle          jsonb not null default '{}'::jsonb,
  unique (planilla_id, empleado_id)
);

-- Una planilla aprobada es inalterable: no se tocan sus renglones.
create function plan.solo_borrador() returns trigger language plpgsql as $$
declare v_estado text; v_id uuid;
begin
  v_id := case when tg_op = 'DELETE' then old.planilla_id else new.planilla_id end;
  select estado into v_estado from plan.planillas where id = v_id;
  if v_estado is not null and v_estado <> 'borrador' then
    raise exception 'La planilla ya está %: no se puede modificar', v_estado;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger planilla_lineas_solo_borrador before insert or update or delete on plan.planilla_lineas
  for each row execute function plan.solo_borrador();

alter table plan.parametros       enable row level security;
alter table plan.isr_tramos       enable row level security;
alter table plan.novedades        enable row level security;
alter table plan.planillas        enable row level security;
alter table plan.planilla_lineas  enable row level security;
