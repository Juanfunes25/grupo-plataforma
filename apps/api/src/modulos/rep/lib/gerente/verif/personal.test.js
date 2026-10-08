import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datosBase, dia, marcacion, turno, horarioSemana, persona } from '../fixtures.js';
import {
  marcacionesFueraDeLugar, marcacionesIncompletas, jornadaMasLargaQueElHorario, turnosSinMarcar, vacacionesYDatosDePersonal,
} from './personal.js';

const sucursales = (extra = {}) => [
  { id: 'mackey', nombre: 'Mackey', rol: 'sucursal', activa: 1, radio_metros: 150, ...extra },
  { id: 'progreso', nombre: 'Progreso', rol: 'sucursal', activa: 1 },
];

// ── ubicación ──────────────────────────────────────────────────────────────────────────────

test('si todo el equipo marca lejos, acusa a la ubicación de la tienda y NO a las personas', () => {
  const marcaciones = [];
  for (let o = -10; o <= -1; o++) for (const e of [1, 2, 3]) marcaciones.push(marcacion({ empleado: e, offset: o, verificacion: 'lejos', distancia: 400 }));
  const datos = datosBase({ sucursales: sucursales(), empleados: [persona(1, 'Ana'), persona(2, 'Beto'), persona(3, 'Caro')], marcaciones });
  const r = marcacionesFueraDeLugar(datos);
  assert.equal(r.hallazgos.length, 1);
  assert.match(r.hallazgos[0].titulo, /ubicación del local parece mal cargada/);
  assert.match(r.hallazgos[0].descartado[0], /No es una persona/);
});

test('si una sola persona marca lejos y sus compañeros dentro, la señala (con cautela)', () => {
  const marcaciones = [];
  for (let o = -12; o <= -1; o++) {
    marcaciones.push(marcacion({ empleado: 2, offset: o, verificacion: 'dentro' }));
    marcaciones.push(marcacion({ empleado: 3, offset: o, verificacion: 'dentro' }));
    if (o % 3 === 0) marcaciones.push(marcacion({ empleado: 1, offset: o, verificacion: 'lejos', distancia: 500 }));
    else marcaciones.push(marcacion({ empleado: 1, offset: o, verificacion: 'dentro' }));
  }
  const datos = datosBase({ sucursales: sucursales(), empleados: [persona(1, 'Ana'), persona(2, 'Beto'), persona(3, 'Caro')], marcaciones });
  const r = marcacionesFueraDeLugar(datos);
  assert.equal(r.hallazgos.length, 1);
  assert.match(r.hallazgos[0].titulo, /Ana/);
  // Sobre una persona, el sistema nunca dice "confirmado" por su cuenta: un GPS no prueba nada.
  assert.equal(r.hallazgos[0].nivel, 'probable');
  assert.ok(r.hallazgos[0].compuertas.some((c) => /más del doble del radio/.test(c.texto) && c.ok), 'pero sí registra que estaba lejos de verdad');
  assert.match(r.hallazgos[0].accion, /Hablalo con la persona/);
});

test('dos marcaciones lejos en un mes no es un patrón', () => {
  const marcaciones = [];
  for (let o = -12; o <= -1; o++) for (const e of [1, 2, 3]) marcaciones.push(marcacion({ empleado: e, offset: o, verificacion: o === -4 || o === -9 ? (e === 1 ? 'lejos' : 'dentro') : 'dentro' }));
  const r = marcacionesFueraDeLugar(datosBase({ sucursales: sucursales(), empleados: [persona(1, 'Ana'), persona(2, 'Beto'), persona(3, 'Caro')], marcaciones }));
  assert.equal(r.hallazgos.length, 0);
});

test('las marcaciones sin ubicación (el teléfono no la dio) no se cuentan como lejos', () => {
  const marcaciones = [];
  for (let o = -12; o <= -1; o++) for (const e of [1, 2]) marcaciones.push(marcacion({ empleado: e, offset: o, verificacion: 'sin_ubicacion', distancia: null }));
  const r = marcacionesFueraDeLugar(datosBase({ sucursales: sucursales(), empleados: [persona(1, 'Ana'), persona(2, 'Beto')], marcaciones }));
  assert.equal(r.estado, 'sin_datos');
});

// ── incompletas ────────────────────────────────────────────────────────────────────────────

test('una persona con 4 días sin marcar la salida se reporta, pero no el turno de hoy', () => {
  const marcaciones = [
    ...[-10, -8, -6, -4].map((o) => marcacion({ empleado: 1, offset: o, tipo: 'entrada' })),
    ...[-3, -2, -1].flatMap((o) => turno({ empleado: 1, offset: o })),
    ...turno({ empleado: 2, offset: -3 }), ...turno({ empleado: 2, offset: -2 }), ...turno({ empleado: 2, offset: -1 }),
    ...turno({ empleado: 3, offset: -3 }), ...turno({ empleado: 3, offset: -2 }),
    marcacion({ empleado: 3, offset: 0, tipo: 'entrada' }), // hoy sigue trabajando
  ];
  const r = marcacionesIncompletas(datosBase({ sucursales: sucursales(), empleados: [persona(1, 'Ana'), persona(2, 'Beto'), persona(3, 'Caro')], marcaciones }));
  assert.equal(r.hallazgos.length, 1);
  assert.match(r.hallazgos[0].titulo, /Ana/);
  assert.match(r.hallazgos[0].titulo, /4 días/);
});

test('si la mitad del equipo no marca la salida, el hallazgo es de la tienda, no de cada uno', () => {
  const marcaciones = [];
  for (const e of [1, 2]) for (const o of [-9, -7, -5, -3]) marcaciones.push(marcacion({ empleado: e, offset: o, tipo: 'entrada' }));
  for (const o of [-9, -7, -5, -3]) marcaciones.push(...turno({ empleado: 3, offset: o }));
  const r = marcacionesIncompletas(datosBase({ sucursales: sucursales(), empleados: [persona(1, 'Ana'), persona(2, 'Beto'), persona(3, 'Caro')], marcaciones }));
  assert.equal(r.hallazgos.length, 1);
  assert.match(r.hallazgos[0].titulo, /casi nadie marca la salida/);
});

test('dos olvidos en un mes no alcanzan', () => {
  const marcaciones = [marcacion({ empleado: 1, offset: -9 }), marcacion({ empleado: 1, offset: -5 }), ...turno({ empleado: 1, offset: -3 })];
  assert.equal(marcacionesIncompletas(datosBase({ sucursales: sucursales(), empleados: [persona(1, 'Ana')], marcaciones })).hallazgos.length, 0);
});

// ── jornada ────────────────────────────────────────────────────────────────────────────────

test('quedarse 3 horas más que el turno programado, 4 días, se reporta con las horas', () => {
  const marcaciones = [-8, -7, -5, -4].flatMap((o) => turno({ empleado: 1, offset: o, salida: '21:00' }));
  const horarios = horarioSemana(1, { libres: [] });
  const r = jornadaMasLargaQueElHorario(datosBase({ sucursales: sucursales(), empleados: [persona(1, 'Ana'), persona(2, 'Beto'), persona(3, 'Caro')], horarios: [...horarios, ...horarioSemana(2), ...horarioSemana(3)], marcaciones }));
  assert.equal(r.hallazgos.length, 1);
  assert.match(r.hallazgos[0].titulo, /Ana/);
  assert.match(r.hallazgos[0].impacto, /12 horas/);
});

test('media hora de más no es una jornada larga', () => {
  const marcaciones = [-8, -7, -5, -4].flatMap((o) => turno({ empleado: 1, offset: o, salida: '18:30' }));
  const r = jornadaMasLargaQueElHorario(datosBase({ sucursales: sucursales(), empleados: [persona(1, 'Ana')], horarios: horarioSemana(1, { libres: [] }), marcaciones }));
  assert.equal(r.hallazgos.length, 0);
});

test('si casi todo el equipo se queda de más, el problema es el horario cargado', () => {
  const horarios = [1, 2, 3].flatMap((e) => horarioSemana(e, { libres: [] }));
  const marcaciones = [1, 2, 3].flatMap((e) => [-8, -7, -5, -4].flatMap((o) => turno({ empleado: e, offset: o, salida: '20:00' })));
  const r = jornadaMasLargaQueElHorario(datosBase({ sucursales: sucursales(), empleados: [persona(1, 'Ana'), persona(2, 'Beto'), persona(3, 'Caro')], horarios, marcaciones }));
  assert.equal(r.hallazgos.length, 1);
  assert.match(r.hallazgos[0].titulo, /el horario cargado no refleja/);
});

test('trabajar tres veces en su día libre se reporta', () => {
  // dia(-14), dia(-7) y dia(-21) caen en el mismo día de la semana que hoy menos 7*k.
  const dowHoy = (new Date(`${dia(0)}T00:00:00Z`).getUTCDay() + 6) % 7;
  const libres = [dowHoy];
  const marcaciones = [-7, -14, -21].flatMap((o) => turno({ empleado: 1, offset: o }));
  const r = jornadaMasLargaQueElHorario(datosBase({ sucursales: sucursales(), empleados: [persona(1, 'Ana')], horarios: horarioSemana(1, { libres }), marcaciones }));
  assert.equal(r.hallazgos.length, 1);
  assert.match(r.hallazgos[0].titulo, /día libre/);
});

// ── turnos sin marcar ──────────────────────────────────────────────────────────────────────

function tiendaQueMarca() {
  const marcaciones = [];
  for (let o = -28; o <= -1; o++) for (const e of [2, 3]) marcaciones.push(...turno({ empleado: e, offset: o }));
  return marcaciones;
}

test('alguien con turnos todos los días y ni una marcación, en una tienda que sí marca, se señala', () => {
  const horarios = [1, 2, 3].flatMap((e) => horarioSemana(e, { libres: [] }));
  const r = turnosSinMarcar(datosBase({ sucursales: sucursales(), empleados: [persona(1, 'Ana'), persona(2, 'Beto'), persona(3, 'Caro')], horarios, marcaciones: tiendaQueMarca() }));
  assert.equal(r.hallazgos.length, 1);
  assert.match(r.hallazgos[0].evidencia[0], /Ana/);
});

test('si esa persona estuvo de vacaciones todo el mes no se la señala', () => {
  const horarios = [1, 2, 3].flatMap((e) => horarioSemana(e, { libres: [] }));
  const vacaciones = [{ empleado_id: 1, fecha_inicio: dia(-40), fecha_fin: dia(-1), dias: 40 }];
  const r = turnosSinMarcar(datosBase({ sucursales: sucursales(), empleados: [persona(1, 'Ana'), persona(2, 'Beto'), persona(3, 'Caro')], horarios, vacaciones, marcaciones: tiendaQueMarca() }));
  assert.equal(r.hallazgos.length, 0);
});

test('si en la tienda casi nadie marca, no hay con qué comparar y lo dice', () => {
  const horarios = horarioSemana(1, { libres: [] });
  const r = turnosSinMarcar(datosBase({ sucursales: sucursales(), empleados: [persona(1, 'Ana')], horarios, marcaciones: [] }));
  assert.equal(r.estado, 'sin_datos');
});

// ── vacaciones y datos ─────────────────────────────────────────────────────────────────────

test('alguien con 3 años sin tomarse vacaciones acumula 36 días y se avisa', () => {
  const r = vacacionesYDatosDePersonal(datosBase({
    sucursales: sucursales(), empleados: [persona(1, 'Ana', 'mackey', { fecha_ingreso: '2023-10-02' })], horarios: horarioSemana(1),
  }));
  const h = r.hallazgos.find((x) => /acumula/.test(x.titulo));
  assert.ok(h);
  assert.match(h.evidencia[0], /36 días/);
  assert.equal(h.nivel, 'probable');
});

test('quien tomó las vacaciones que le tocan no aparece', () => {
  const r = vacacionesYDatosDePersonal(datosBase({
    sucursales: sucursales(), empleados: [persona(1, 'Ana', 'mackey', { fecha_ingreso: '2023-10-02' })], horarios: horarioSemana(1),
    vacaciones: [{ empleado_id: 1, fecha_inicio: dia(-100), fecha_fin: dia(-70), dias: 30 }],
  }));
  assert.ok(!r.hallazgos.some((x) => /acumula/.test(x.titulo)));
});

test('empleados sin fecha de ingreso, en tienda cerrada y sin horario se avisan por separado', () => {
  const r = vacacionesYDatosDePersonal(datosBase({
    sucursales: sucursales(),
    empleados: [persona(1, 'Ana', 'mackey', { fecha_ingreso: null }), persona(2, 'Beto', 'progreso')],
    horarios: [],
  }));
  const titulos = r.hallazgos.map((h) => h.titulo).join(' | ');
  assert.match(titulos, /sin fecha de ingreso/);
  assert.match(titulos, /tienda cerrada/);
  assert.match(titulos, /sin horario/);
});

test('un saldo negativo es un hecho aritmético y queda confirmado', () => {
  const r = vacacionesYDatosDePersonal(datosBase({
    sucursales: sucursales(), empleados: [persona(1, 'Ana', 'mackey', { fecha_ingreso: '2026-03-02' })], horarios: horarioSemana(1),
    vacaciones: [{ empleado_id: 1, fecha_inicio: dia(-30), fecha_fin: dia(-15), dias: 16 }],
  }));
  const h = r.hallazgos.find((x) => /más días de los que acumuló/.test(x.titulo));
  assert.equal(h.nivel, 'confirmado');
});
