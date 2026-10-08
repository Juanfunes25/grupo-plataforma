-- ════════════════════════════════════════════════════════════════════════════
-- 0021 · RRHH — PERFIL COMPLETO DEL EMPLEADO
--
-- Amplía el esquema rrhh de 0002 para llevar el orden del personal de las cuatro
-- empresas: datos personales y sensibles (en `personas`, una vez por persona),
-- datos del contrato por empresa (en `empleados`), vacaciones según la ley
-- hondureña, ausencias/permisos/incapacidades, amonestaciones, evaluaciones,
-- capacitaciones, historial laboral y salarial, y el control de turno que venía
-- de italo-reposicion (horarios con estado, marcaciones con ubicación, geocerca
-- por sucursal y checklist de apertura/cierre).
--
-- Todo es aditivo: no se borra ni se cambia el significado de lo que ya existía.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── Persona: datos personales, de planilla y de emergencia ────────────────
alter table rrhh.personas
  add column sexo                  text check (sexo in ('M','F','O')),
  add column estado_civil          text check (estado_civil in ('soltero','casado','union_libre','divorciado','viudo')),
  add column nacionalidad          text not null default 'Hondureña',
  add column rtn                   text,
  add column telefono2             text,
  add column whatsapp              text,
  add column ciudad                text,
  add column foto_url              text,
  add column ihss_numero           text,
  add column rap_numero            text,
  add column infop_numero          text,
  add column talla_camisa          text,
  add column talla_pantalon        text,
  add column talla_calzado         text,
  add column banco                 text,
  add column tipo_cuenta           text check (tipo_cuenta in ('ahorro','cheque')),
  add column cuenta_bancaria       text,
  add column emergencia_nombre     text,
  add column emergencia_parentesco text,
  add column emergencia_telefono   text,
  add column emergencia_telefono2  text,
  add column updated_at            timestamptz not null default now();

-- Identidad hondureña: 13 dígitos (0000-0000-00000). `not valid` = se exige en lo que se
-- escriba de aquí en adelante sin trabar filas viejas con otro formato.
alter table rrhh.personas
  add constraint personas_identidad_formato check (identidad is null or identidad ~ '^[0-9]{13}$') not valid;
alter table rrhh.personas
  add constraint personas_rtn_formato check (rtn is null or rtn ~ '^[0-9]{14}$') not valid;

-- ─── Empleado (contrato por empresa) ───────────────────────────────────────
alter table rrhh.empleados
  add column codigo                text,                      -- número de empleado interno
  add column tipo_contrato         text not null default 'indefinido'
                                   check (tipo_contrato in ('indefinido','plazo_fijo','prueba','temporal','por_horas','servicios')),
  add column fecha_inicio_contrato date,
  add column fecha_fin_contrato    date,                      -- vencimiento (null = indefinido)
  add column fecha_fin_prueba      date,
  add column tipo_pago             text not null default 'mensual'
                                   check (tipo_pago in ('mensual','quincenal','semanal','por_hora')),
  add column salario_hora          numeric(10,2),
  add column jornada               text check (jornada in ('diurna','mixta','nocturna')),
  add column horas_semana          numeric(5,2),
  add column jefe_id               uuid references rrhh.empleados(id),
  add column motivo_estado         text,                      -- por qué está suspendido o dado de baja
  add column estado_desde          date,
  add column tipo_baja             text check (tipo_baja in ('renuncia','despido','fin_contrato','abandono','mutuo_acuerdo','fallecimiento','otro')),
  add column updated_at            timestamptz not null default now(),
  add constraint empleados_jefe_distinto check (jefe_id is null or jefe_id <> id);
-- Fecha de ingreso desconocida = null (no se inventa antigüedad: un saldo de vacaciones
-- inventado en una liquidación es peor que uno que falta y avisa que falta).
alter table rrhh.empleados alter column fecha_ingreso drop not null;
create unique index empleados_codigo_idx on rrhh.empleados (empresa_id, codigo) where codigo is not null;
create index empleados_jefe_idx on rrhh.empleados (jefe_id) where jefe_id is not null;
create index empleados_contrato_idx on rrhh.empleados (empresa_id, fecha_fin_contrato) where fecha_fin_contrato is not null;

-- Sucursales adicionales donde también trabaja (la principal es empleados.sucursal_id).
create table rrhh.empleado_sucursales (
  empleado_id uuid not null references rrhh.empleados(id) on delete cascade,
  sucursal_id uuid not null references core.sucursales(id),
  primary key (empleado_id, sucursal_id)
);

-- Historial de salario: SOLO lo ve quien tenga rrhh:sensible.
create table rrhh.salarios_historial (
  id             uuid primary key default gen_random_uuid(),
  empleado_id    uuid not null references rrhh.empleados(id) on delete cascade,
  salario_anterior numeric(12,2),
  salario_nuevo  numeric(12,2),
  tipo_pago      text,
  motivo         text,
  vigente_desde  date not null default current_date,
  registrado_por uuid references core.usuarios(id),
  created_at     timestamptz not null default now()
);
create index salarios_historial_idx on rrhh.salarios_historial (empleado_id, vigente_desde desc);

-- ─── Horarios con estado (turno / libre / cubre otra tienda / vacaciones) ──
alter table rrhh.horarios
  add column estado text not null default 'turno' check (estado in ('turno','libre','otra_tienda','vacaciones'));
alter table rrhh.horarios add column sucursal_id uuid references core.sucursales(id);   -- null = su sucursal principal
alter table rrhh.horarios alter column entrada drop not null;
alter table rrhh.horarios alter column salida  drop not null;
alter table rrhh.horarios
  add constraint horarios_turno_con_horas check (estado <> 'turno' or (entrada is not null and salida is not null));

-- ─── Marcaciones con verificación de ubicación ─────────────────────────────
alter table rrhh.marcaciones
  add column lat              double precision,
  add column lon              double precision,
  add column distancia_metros integer,
  add column verificacion     text not null default 'sin_ubicacion'
                              check (verificacion in ('dentro','lejos','sin_ubicacion','sin_configurar'));

-- Geocerca de cada sucursal (para validar desde dónde se marca). Sin fila = sin_configurar.
create table rrhh.sucursal_geo (
  sucursal_id   uuid primary key references core.sucursales(id) on delete cascade,
  lat           double precision not null,
  lon           double precision not null,
  radio_metros  integer not null default 150 check (radio_metros between 20 and 2000),
  updated_at    timestamptz not null default now()
);

-- ─── Vacaciones: días tomados, estado ampliado, quién y cuándo resolvió ────
alter table rrhh.vacaciones
  add column dias            integer,
  add column motivo_rechazo  text,
  add column resuelta_at     timestamptz,
  add column registrada_por  uuid references core.usuarios(id);
update rrhh.vacaciones set dias = (hasta - desde + 1) where dias is null;
alter table rrhh.vacaciones drop constraint if exists vacaciones_estado_check;
alter table rrhh.vacaciones
  add constraint vacaciones_estado_check check (estado in ('solicitada','aprobada','rechazada','tomada','cancelada'));
alter table rrhh.vacaciones add constraint vacaciones_dias_positivos check (dias is null or dias > 0);

-- ─── Ausencias, permisos, días libres, incapacidades y llegadas tarde ──────
create table rrhh.ausencias (
  id             uuid primary key default gen_random_uuid(),
  empleado_id    uuid not null references rrhh.empleados(id) on delete cascade,
  empresa_id     uuid not null references core.empresas(id),
  tipo           text not null check (tipo in ('ausencia','permiso','dia_libre','incapacidad','tardanza','licencia')),
  subtipo        text,                                   -- p. ej. IHSS, enfermedad, duelo, trámite
  desde          date not null,
  hasta          date not null,
  dias           numeric(5,2) not null default 1 check (dias >= 0),   -- admite medio día
  minutos        integer check (minutos is null or minutos >= 0),     -- para tardanzas
  motivo         text,
  pagado         boolean not null default true,
  estado         text not null default 'aprobada' check (estado in ('pendiente','aprobada','rechazada')),
  aprobado_por   uuid references core.usuarios(id),
  aprobado_at    timestamptz,
  documento_id   uuid,                                   -- comprobante (módulo de documentos), sin FK a propósito
  registrada_por uuid references core.usuarios(id),
  created_at     timestamptz not null default now(),
  check (hasta >= desde)
);
create index ausencias_empleado_idx on rrhh.ausencias (empleado_id, desde desc);
create index ausencias_empresa_idx  on rrhh.ausencias (empresa_id, desde);

-- ─── Amonestaciones y sanciones ────────────────────────────────────────────
create table rrhh.sanciones (
  id             uuid primary key default gen_random_uuid(),
  empleado_id    uuid not null references rrhh.empleados(id) on delete cascade,
  empresa_id     uuid not null references core.empresas(id),
  tipo           text not null check (tipo in ('verbal','escrita','suspension','otra')),
  fecha          date not null default current_date,
  motivo         text not null,
  descripcion    text,
  dias_suspension integer check (dias_suspension is null or dias_suspension > 0),
  con_goce       boolean,
  estado         text not null default 'vigente' check (estado in ('vigente','anulada')),
  documento_id   uuid,
  emitida_por    uuid references core.usuarios(id),
  created_at     timestamptz not null default now()
);
create index sanciones_empleado_idx on rrhh.sanciones (empleado_id, fecha desc);

-- ─── Evaluaciones de desempeño ─────────────────────────────────────────────
create table rrhh.evaluaciones (
  id             uuid primary key default gen_random_uuid(),
  empleado_id    uuid not null references rrhh.empleados(id) on delete cascade,
  empresa_id     uuid not null references core.empresas(id),
  fecha          date not null default current_date,
  periodo        text,                                   -- p. ej. "2026 · 1er semestre"
  puntaje        numeric(5,2) check (puntaje is null or puntaje between 0 and 100),
  fortalezas     text,
  areas_mejora   text,
  comentarios    text,
  evaluador_id   uuid references core.usuarios(id),
  documento_id   uuid,
  created_at     timestamptz not null default now()
);
create index evaluaciones_empleado_idx on rrhh.evaluaciones (empleado_id, fecha desc);

-- ─── Capacitaciones ────────────────────────────────────────────────────────
create table rrhh.capacitaciones (
  id             uuid primary key default gen_random_uuid(),
  empleado_id    uuid not null references rrhh.empleados(id) on delete cascade,
  empresa_id     uuid not null references core.empresas(id),
  nombre         text not null,
  institucion    text,
  fecha          date not null default current_date,
  horas          numeric(6,1) check (horas is null or horas >= 0),
  estado         text not null default 'completada' check (estado in ('programada','completada','cancelada')),
  vence          date,                                   -- certificados que se renuevan (manipulación de alimentos, etc.)
  resultado      text,
  documento_id   uuid,
  created_at     timestamptz not null default now()
);
create index capacitaciones_empleado_idx on rrhh.capacitaciones (empleado_id, fecha desc);

-- ─── Historial laboral (cambios de puesto, empresa, sucursal, contrato, estado) ─
-- El salario NO se guarda aquí (iría a la vista de quien no debe verlo): va en salarios_historial.
create table rrhh.historial (
  id             uuid primary key default gen_random_uuid(),
  empleado_id    uuid not null references rrhh.empleados(id) on delete cascade,
  empresa_id     uuid not null references core.empresas(id),
  fecha          date not null default current_date,
  tipo           text not null check (tipo in ('ingreso','cambio_puesto','cambio_salario','cambio_sucursal','cambio_empresa','cambio_contrato','cambio_estado','suspension','reactivacion','baja','reingreso','otro')),
  descripcion    text not null,
  anterior       jsonb,
  nuevo          jsonb,
  registrado_por uuid references core.usuarios(id),
  created_at     timestamptz not null default now()
);
create index historial_empleado_idx on rrhh.historial (empleado_id, fecha desc, created_at desc);

-- ─── Checklist de apertura y cierre de tienda ──────────────────────────────
create table rrhh.checklist_catalogo (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references core.empresas(id),
  momento    text not null check (momento in ('apertura','cierre')),
  texto      text not null,
  orden      integer not null default 0,
  activo     boolean not null default true
);
create index checklist_catalogo_idx on rrhh.checklist_catalogo (empresa_id, momento, orden) where activo;

create table rrhh.checklist_registros (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references core.empresas(id),
  sucursal_id uuid not null references core.sucursales(id),
  fecha       date not null,
  momento     text not null check (momento in ('apertura','cierre')),
  item_id     uuid not null references rrhh.checklist_catalogo(id) on delete cascade,
  ok          boolean not null default false,
  nota        text,
  empleado_id uuid references rrhh.empleados(id),
  usuario_id  uuid references core.usuarios(id),
  created_at  timestamptz not null default now(),
  unique (sucursal_id, fecha, momento, item_id)
);
create index checklist_registros_idx on rrhh.checklist_registros (empresa_id, fecha, sucursal_id);

-- Punto de partida del checklist de Italo (el de italo-reposicion). Solo se siembra si Italo
-- aún no tiene catálogo; después el administrador lo edita desde la pantalla.
insert into rrhh.checklist_catalogo (empresa_id, momento, texto, orden)
select e.id, c.momento, c.texto, c.orden
  from core.empresas e
  join (values
    ('apertura','Temperatura de la vitrina correcta',0), ('apertura','Vitrina limpia y sabores presentados',1),
    ('apertura','Máquina de café encendida y limpia',2), ('apertura','Molino con café y calibrado',3),
    ('apertura','Fuente de pistacho llena y limpia',4), ('apertura','Aire acondicionado encendido',5),
    ('apertura','Caja con cambio suficiente',6), ('apertura','Mesas, piso y baño limpios',7),
    ('cierre','Vitrina tapada y freezer cerrado',0), ('cierre','Máquina de café limpia y apagada',1),
    ('cierre','Molino limpio',2), ('cierre','Fuente de pistacho lavada y guardada',3),
    ('cierre','Aire acondicionado apagado',4), ('cierre','Caja cuadrada y guardada',5),
    ('cierre','Basura sacada',6), ('cierre','Luces apagadas y puertas con llave',7)
  ) as c(momento, texto, orden) on true
 where e.codigo = 'italo'
   and not exists (select 1 from rrhh.checklist_catalogo x where x.empresa_id = e.id);


-- ─── Personal real de Italo (de italo-reposicion · seedEmpleadosData.js) ───
-- Nombres cortos y horario semanal reales entregados por el dueño. NO traen identidad, teléfono
-- ni fecha de ingreso: esos datos se completan desde la ficha (y la pantalla "Importar fechas de
-- ingreso" cruza la planilla de contratos). Idempotente: no pisa a quien ya esté cargado.
-- Códigos por día [lunes..domingo]: "HH-HH" turno · L libre · OT cubre otra tienda · V vacaciones
-- · "HH-HH@alias" turno en otra sucursal. Progreso (cerrada) no se carga.
do $seed$
declare
  r record; v_empresa uuid; v_pers uuid; v_emp uuid; v_suc uuid; v_otra uuid;
  i int; cod text; est text; ini text; fin text; alias_otro text;
begin
  select id into v_empresa from core.empresas where codigo = 'italo';
  if v_empresa is null then return; end if;
  for r in select * from (values
    ('Maryury',         '10_calle_express', array['10-21','L','10-21','13-21','13-21','10-21','10-21']),
    ('Jennifer',        '10_calle_express', array['L','10-21','10-21','10-19','10-21','13-21','10-21']),
    ('Gabriela',        '10_calle_express', array['10-21','10-21','L','10-21','10-19','10-21','13-21']),
    ('Astrid',          'mackey',           array['L','10-21','10-21','10-21','13-21','10-21','13-21']),
    ('Claudia Licona',  'mackey',           array['10-21','L','10-21','13-21','10-21','13-21','10-19']),
    ('Fernanda',        'mackey',           array['10-21','10-21','L','10-19','10-21','13-21','13-21']),
    -- Daisy figuraba en Mackey y en Próceres con horarios que se complementan: es una sola persona.
    ('Daisy',           'proceres',         array['11-22','9-18','14-22','L','14-22','10-21@mackey','10-21@mackey']),
    ('Jose',            'proceres',         array['L','14-22','11-22','14-22','11-22','14-22','14-22']),
    ('Soriano',         'proceres',         array['9-18','L','9-18','9-18','9-18','11-22','11-22']),
    ('Olga',            'proceres',         array['14-22','11-22','L','11-22','14-22','14-22','14-22']),
    ('Deysi',           'los_andes',        array['OT','OT','OT','OT','OT','OT','OT']),
    ('Emerson',         'los_andes',        array['V','V','V','V','V','V','V']),
    ('Waleska',         'los_andes',        array['L','9-18','9-18','9-18','9-18','9-18','9-18']),
    ('Neyli',           'los_andes',        array['L','13-21','9-18','13-21','13-21','13-21','13-21']),
    ('Carlos',          'los_andes',        array['7-16','7-16','7-16','7-16','7-16','7-16','7-16']),
    ('Jose David',      'los_andes',        array['7-16','7-16','L','7-16','7-16','7-16','7-16']),
    ('Thelma',          'los_andes',        array['7-16','7-16','7-16','L','7-16','7-16','7-16']),
    ('Jorge',           'los_andes',        array['13-21','13-21','13-21','7-16','L','13-21','13-21'])
  ) as t(nombre, suc, dias)
  loop
    select id into v_suc from core.sucursales where empresa_id = v_empresa and alias = r.suc;
    continue when v_suc is null;
    continue when exists (select 1 from rrhh.empleados e join rrhh.personas p on p.id = e.persona_id
                           where e.empresa_id = v_empresa and p.nombres = r.nombre and p.apellidos = '');
    insert into rrhh.personas (nombres, apellidos) values (r.nombre, '') returning id into v_pers;
    insert into rrhh.empleados (persona_id, empresa_id, sucursal_id, puesto, fecha_ingreso, notas)
      values (v_pers, v_empresa, v_suc, 'Atención al cliente', null,
              'Cargado de italo-reposicion: falta identidad, teléfono y fecha de ingreso.') returning id into v_emp;
    insert into rrhh.historial (empleado_id, empresa_id, fecha, tipo, descripcion)
      values (v_emp, v_empresa, current_date, 'otro', 'Alta por migración desde italo-reposicion (datos incompletos)');
    for i in 1..7 loop
      cod := r.dias[i];
      alias_otro := nullif(split_part(cod, '@', 2), '');
      cod := split_part(cod, '@', 1);
      v_otra := null;
      if alias_otro is not null then
        select id into v_otra from core.sucursales where empresa_id = v_empresa and alias = alias_otro;
        insert into rrhh.empleado_sucursales (empleado_id, sucursal_id) values (v_emp, v_otra) on conflict do nothing;
      end if;
      est := case cod when 'L' then 'libre' when 'OT' then 'otra_tienda' when 'V' then 'vacaciones' else 'turno' end;
      ini := null; fin := null;
      if est = 'turno' then
        ini := lpad(split_part(cod, '-', 1), 2, '0') || ':00';
        fin := lpad(split_part(cod, '-', 2), 2, '0') || ':00';
      end if;
      insert into rrhh.horarios (empleado_id, dia_semana, estado, entrada, salida, sucursal_id)
        values (v_emp, i % 7, est, ini::time, fin::time, v_otra);
    end loop;
  end loop;
end
$seed$;

-- ─── RLS cerrada: solo el API (rol postgres) entra ─────────────────────────
alter table rrhh.empleado_sucursales   enable row level security;
alter table rrhh.salarios_historial    enable row level security;
alter table rrhh.sucursal_geo          enable row level security;
alter table rrhh.ausencias             enable row level security;
alter table rrhh.sanciones             enable row level security;
alter table rrhh.evaluaciones          enable row level security;
alter table rrhh.capacitaciones        enable row level security;
alter table rrhh.historial             enable row level security;
alter table rrhh.checklist_catalogo    enable row level security;
alter table rrhh.checklist_registros   enable row level security;
