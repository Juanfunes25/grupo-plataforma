-- ════════════════════════════════════════════════════════════════════════════
-- 0071 · PLANILLA HONDURAS (mejora 19)
--
-- Reproduce el flujo REAL de la hoja «ITALO 2026» del dueño: una hoja por quincena, agrupada por sucursal, con
-- Empleado · DIAS · SALARIO DIARIO · TOTAL QUINCENAL · POR HORA · HORAS EXTRAS · TOTAL HX · deducciones · TOTAL ·
-- número de cuenta · OBSERVACIONES; más el aguinaldo (días × salario diario). Se pre-llena desde RRHH y cada celda
-- se puede corregir antes de aprobar. Las deducciones son LÍNEAS MANUALES con concepto (anticipo, IHSS, préstamo…);
-- IHSS/RAP/INFOP/ISR por porcentaje son opcionales y están APAGADOS (aplicar_ley = 0) hasta que el contador los valide.
--
-- ┌─ MUY IMPORTANTE ───────────────────────────────────────────────────────────┐
-- │ Todo parámetro nace «por_confirmar = true». Ninguno es definitivo: el      │
-- │ contador debe validarlos y marcarlos como confirmados en la pantalla de    │
-- │ parámetros. Cada planilla guarda copia de los que usó y, aprobada, es      │
-- │ inalterable (reabrir: solo el dueño del grupo, con motivo, en bitácora).   │
-- └────────────────────────────────────────────────────────────────────────────┘
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
  ('dias_mes',               'general', 'Días del mes para el salario diario',          30,  'días', 'Salario diario del perfil = salario mensual ÷ este número.'),
  ('quincena_dias',          'general', 'Días que se pagan en una quincena completa',   15,  'días', 'La hoja del dueño paga 15 días en cada quincena (1-15 y 16-fin de mes).'),
  ('semana_dias_pago',       'general', 'Días que se pagan en una semana completa',       6,  'días', 'Planilla semanal: 6 o 7 según lo defina el dueño. Por confirmar.'),
  ('semana_inicio_dia',      'general', 'Día en que empieza la semana de pago (1 = lunes … 7 = domingo)', 1, 'día', 'La semana dura 7 días calendario desde este día.'),
  ('horas_dia_diurna',       'general', 'Horas de la jornada (valor de la hora = salario diario ÷ horas)', 8, 'h', 'En la hoja: 440 ÷ 8 = 55 por hora.'),
  ('horas_dia_mixta',        'general', 'Horas de la jornada mixta',                     7,  'h',    NULL),
  ('horas_dia_nocturna',     'general', 'Horas de la jornada nocturna',                  6,  'h',    NULL),
  ('he_diurna_pct',          'horas',   'Recargo de hora extra diurna',                  0,  '%',    'En la hoja la hora extra se paga a la tarifa normal (0 %). La ley habla de 25 %: confirmar con el contador.'),
  ('he_nocturna_pct',        'horas',   'Recargo de hora extra nocturna',                0,  '%',    'La ley habla de 75 %: confirmar con el contador.'),
  ('he_feriada_pct',         'horas',   'Recargo de hora extra en feriado / descanso',   0,  '%',    'La ley habla de 100 %: confirmar con el contador.'),
  ('salario_minimo_diario',  'general', 'Salario mínimo diario de referencia',         435,  'L',    'Solo avisa si alguien queda por debajo. Número que aparece en el encabezado de la hoja.'),
  ('ihss_fijo_mensual',      'ihss',    'IHSS: deducción fija mensual sugerida',       626,  'L',    'La hoja descuenta 313 en cada quincena (626 al mes). Se agrega como línea manual por empleado.'),
  ('decimos_dias_pago',      'decimos', 'Días de salario que paga el aguinaldo / catorceavo completo', 30, 'días', 'Aguinaldo = DIAS × salario diario; DIAS = 30 con el año completo y proporcional por antigüedad.'),
  ('decimos_dias_base',      'decimos', 'Días del año para el proporcional por antigüedad', 365, 'días', 'DIAS = 30 × días trabajados ÷ este número (máximo 30).'),
  ('aguinaldo_mes_pago',     'decimos', 'Mes de pago del décimo tercer mes',            12,  'mes',  NULL),
  ('aguinaldo_dia_pago',     'decimos', 'Día de pago del décimo tercer mes',            20,  'día',  NULL),
  ('catorceavo_mes_pago',    'decimos', 'Mes de pago del catorceavo mes',                6,  'mes',  NULL),
  ('catorceavo_dia_pago',    'decimos', 'Día de pago del catorceavo mes',               30,  'día',  NULL),
  ('aplicar_ley',            'ley',     'Calcular IHSS/RAP/INFOP/ISR por porcentaje (1 = sí, 0 = no)', 0, '', 'APAGADO. La hoja del dueño no los calcula por porcentaje. Actívalo solo cuando el contador valide lo de abajo.'),
  ('ihss_techo_mensual',     'ley',     'Techo de cotización del IHSS (mensual)',   11903.13, 'L',  'Valor de arranque: por confirmar con el contador. Cambia cada año.'),
  ('ihss_em_empleado_pct',   'ley',     'IHSS enfermedad-maternidad · empleado',      2.5,  '%',    NULL),
  ('ihss_em_patrono_pct',    'ley',     'IHSS enfermedad-maternidad · patrono',         5,  '%',    NULL),
  ('ihss_ivm_empleado_pct',  'ley',     'IHSS invalidez-vejez-muerte · empleado',     2.5,  '%',    NULL),
  ('ihss_ivm_patrono_pct',   'ley',     'IHSS invalidez-vejez-muerte · patrono',      3.5,  '%',    NULL),
  ('rap_exento_mensual',     'ley',     'RAP: sueldo mensual libre de aporte',      11903.13, 'L',  'El RAP se calcula sobre lo que pasa de este monto.'),
  ('rap_empleado_pct',       'ley',     'RAP · empleado',                             1.5,  '%',    NULL),
  ('rap_patrono_pct',        'ley',     'RAP · patrono',                              1.5,  '%',    NULL),
  ('infop_patrono_pct',      'ley',     'INFOP · patrono (sobre la planilla)',          1,  '%',    NULL),
  ('infop_empleado_pct',     'ley',     'INFOP · empleado',                             0,  '%',    NULL),
  ('isr_gastos_medicos',     'ley',     'ISR: deducción anual por gastos médicos',  40000,  'L',    NULL),
  ('isr_deduce_ihss',        'ley',     'ISR: restar IHSS y RAP del empleado (1 = sí)', 0,  '',     NULL);

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

-- ─── Periodicidad de pago: por empresa (valor por defecto) y por empleado (excepción) ──
-- Italo y Origen pagan semanal; EcoStone y DISERCO conviven quincenal y semanal según el empleado.
-- Una planilla es de UNA periodicidad: solo entran los empleados cuya periodicidad efectiva es esa.
create table plan.config_empresa (
  empresa_id   uuid primary key references core.empresas(id),
  periodicidad text not null default 'quincena' check (periodicidad in ('semanal','quincena','mensual')),
  updated_by   uuid references core.usuarios(id),
  updated_at   timestamptz not null default now()
);
insert into plan.config_empresa (empresa_id, periodicidad)
select id, case when codigo in ('italo','origen') then 'semanal' else 'quincena' end from core.empresas;

create table plan.empleado_periodicidad (
  empleado_id  uuid primary key references rrhh.empleados(id) on delete cascade,
  empresa_id   uuid not null references core.empresas(id),
  periodicidad text not null check (periodicidad in ('semanal','quincena','mensual')),
  updated_by   uuid references core.usuarios(id),
  updated_at   timestamptz not null default now()
);

-- ─── Deducciones fijas por empleado (IHSS, préstamo, cuota…) ───────────────
-- monto_mensual se reparte según el periodo: semana = 12/52, quincena = mitad, mes = completo.
create table plan.deducciones_fijas (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references core.empresas(id),
  empleado_id   uuid not null references rrhh.empleados(id),
  concepto      text not null,
  monto_mensual numeric(12,2) not null check (monto_mensual > 0),
  activa        boolean not null default true,
  creada_por    uuid references core.usuarios(id),
  created_at    timestamptz not null default now()
);
create index plan_deducciones_idx on plan.deducciones_fijas (empresa_id, empleado_id) where activa;

-- ─── Planillas ──────────────────────────────────────────────────────────────
create table plan.planillas (
  id               uuid primary key default gen_random_uuid(),
  empresa_id       uuid not null references core.empresas(id),
  tipo             text not null check (tipo in ('semanal','quincena','mensual','aguinaldo','catorceavo')),
  etiqueta         text not null,
  desde            date not null,
  hasta            date not null,
  fecha_pago       date,
  estado           text not null default 'borrador' check (estado in ('borrador','aprobada','pagada','anulada')),
  parametros       jsonb not null default '{}'::jsonb,       -- copia de lo usado al calcular
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
  reaperturas      jsonb not null default '[]'::jsonb,       -- [{por, cuando, motivo}]
  gasto_id         uuid,                                     -- fin.gastos creado al "enviar a Finanzas"
  check (hasta >= desde)
);
create unique index plan_planillas_periodo_uq on plan.planillas (empresa_id, tipo, desde, hasta) where estado <> 'anulada';
create index plan_planillas_idx on plan.planillas (empresa_id, desde desc);

-- Un renglón = una fila de la hoja. Las columnas son las de la hoja del dueño.
create table plan.planilla_lineas (
  id               uuid primary key default gen_random_uuid(),
  planilla_id      uuid not null references plan.planillas(id) on delete cascade,
  empleado_id      uuid not null references rrhh.empleados(id),
  sucursal_id      uuid references core.sucursales(id),
  sucursal         text,
  nombre           text not null,
  identidad        text,
  puesto           text,
  dias             numeric(6,2) not null default 0,              -- DIAS
  salario_diario   numeric(12,2) not null default 0,             -- SALARIO DIARIO
  total_quincenal  numeric(12,2) not null default 0,             -- TOTAL QUINCENAL  (= dias × salario diario)
  por_hora         numeric(12,4) not null default 0,             -- POR HORA
  horas_extra      numeric(7,2)  not null default 0,             -- HORAS EXTRAS
  total_hx         numeric(12,2) not null default 0,             -- TOTAL HX
  otros_ingresos   numeric(12,2) not null default 0,             -- bonos y otros (se explican en observaciones)
  deducciones      jsonb not null default '[]'::jsonb,           -- [{concepto, monto, tipo: 'manual'|'fija'|'ley'}]
  total_deducciones numeric(12,2) not null default 0,
  total            numeric(12,2) not null default 0,             -- TOTAL a pagar
  banco            text,
  cuenta           text,                                         -- Numeros de cuenta
  observaciones    text,
  editado          boolean not null default false,               -- alguien tocó una celda a mano
  aportes_patronales numeric(12,2) not null default 0,           -- solo si aplicar_ley = 1
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
alter table plan.config_empresa   enable row level security;
alter table plan.empleado_periodicidad enable row level security;
alter table plan.deducciones_fijas enable row level security;
alter table plan.planillas        enable row level security;
alter table plan.planilla_lineas  enable row level security;
