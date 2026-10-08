import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnosDeMarcaciones, armarReporte, quincenaDe } from './reporteAsistencia.js';

test('un turno normal suma las horas que se trabajaron', () => {
  // 14:00 UTC = 8am en Honduras; 23:00 UTC = 5pm. Nueve horas.
  const t = turnosDeMarcaciones([
    { tipo: 'entrada', fecha: '2026-08-25', creado_en: '2026-08-25 14:00:00', verificacion: 'dentro' },
    { tipo: 'salida', fecha: '2026-08-25', creado_en: '2026-08-25 23:00:00', verificacion: 'dentro' },
  ]);
  assert.equal(t.length, 1);
  assert.equal(t[0].horas, 9);
  assert.equal(t[0].incompleto, false);
});

test('un turno que cierra pasada la medianoche se paga en el día que empezó', () => {
  // Entrada 2pm local del 25; salida 00:30 local del 26 (que se guarda con fecha 26).
  const t = turnosDeMarcaciones([
    { tipo: 'entrada', fecha: '2026-08-25', creado_en: '2026-08-25 20:00:00' },
    { tipo: 'salida', fecha: '2026-08-26', creado_en: '2026-08-26 06:30:00' },
  ]);
  assert.equal(t.length, 1, 'es un turno, no dos medio turnos');
  assert.equal(t[0].fecha, '2026-08-25', 'se cuenta en el día en que empezó');
  assert.equal(t[0].horas, 10.5);
});

test('una entrada sin salida NO se completa inventando una hora', () => {
  const t = turnosDeMarcaciones([
    { tipo: 'entrada', fecha: '2026-08-25', creado_en: '2026-08-25 14:00:00' },
  ]);
  assert.equal(t[0].horas, null, 'inventar acá es pagar de más o de menos sin que nadie se entere');
  assert.equal(t[0].incompleto, true);
});

test('dos entradas seguidas dejan la primera marcada como incompleta', () => {
  const t = turnosDeMarcaciones([
    { tipo: 'entrada', fecha: '2026-08-25', creado_en: '2026-08-25 14:00:00' },
    { tipo: 'entrada', fecha: '2026-08-25', creado_en: '2026-08-25 15:00:00' },
    { tipo: 'salida', fecha: '2026-08-25', creado_en: '2026-08-25 23:00:00' },
  ]);
  assert.equal(t.length, 2);
  assert.equal(t[0].incompleto, true);
  assert.equal(t[1].horas, 8);
});

test('una salida sin entrada también se reporta en vez de descartarse', () => {
  const t = turnosDeMarcaciones([
    { tipo: 'salida', fecha: '2026-08-25', creado_en: '2026-08-25 23:00:00' },
  ]);
  assert.equal(t.length, 1);
  assert.equal(t[0].entrada, null);
  assert.equal(t[0].incompleto, true);
});

test('un turno absurdo de días enteros se corta: es una salida que nadie marcó', () => {
  const t = turnosDeMarcaciones([
    { tipo: 'entrada', fecha: '2026-08-25', creado_en: '2026-08-25 14:00:00' },
    { tipo: 'salida', fecha: '2026-08-27', creado_en: '2026-08-27 23:00:00' },
  ]);
  assert.equal(t[0].horas, null);
  assert.equal(t[0].incompleto, true, 'no se le pagan 57 horas a nadie por un olvido');
});

test('el orden en que llegan las marcaciones no cambia el resultado', () => {
  const desordenadas = [
    { tipo: 'salida', fecha: '2026-08-25', creado_en: '2026-08-25 23:00:00' },
    { tipo: 'entrada', fecha: '2026-08-25', creado_en: '2026-08-25 14:00:00' },
  ];
  assert.equal(turnosDeMarcaciones(desordenadas)[0].horas, 9);
});

test('marcar lejos queda señalado en el turno, sin cambiar las horas', () => {
  const t = turnosDeMarcaciones([
    { tipo: 'entrada', fecha: '2026-08-25', creado_en: '2026-08-25 14:00:00', verificacion: 'lejos', distancia_metros: 4200 },
    { tipo: 'salida', fecha: '2026-08-25', creado_en: '2026-08-25 23:00:00', verificacion: 'dentro' },
  ]);
  assert.equal(t[0].lejos, true);
  assert.equal(t[0].distancia_entrada, 4200);
  assert.equal(t[0].horas, 9, 'la verificación es para revisar, no para descontar sueldo');
});

// ------------------------------------------------------------- reporte completo

const EMPLEADOS = [
  { id: 1, nombre: 'Karla', sucursal_id: 'mackey', sucursal_nombre: 'Mackey' },
  { id: 2, nombre: 'Luis', sucursal_id: 'progreso', sucursal_nombre: 'Progreso' },
];

test('suma el total de horas por persona en el período', () => {
  const r = armarReporte({
    empleados: EMPLEADOS,
    marcaciones: [
      { empleado_id: 1, tipo: 'entrada', fecha: '2026-08-25', creado_en: '2026-08-25 14:00:00' },
      { empleado_id: 1, tipo: 'salida', fecha: '2026-08-25', creado_en: '2026-08-25 22:00:00' },
      { empleado_id: 1, tipo: 'entrada', fecha: '2026-08-26', creado_en: '2026-08-26 14:00:00' },
      { empleado_id: 1, tipo: 'salida', fecha: '2026-08-26', creado_en: '2026-08-26 20:00:00' },
    ],
  });
  const karla = r.find((e) => e.empleado_id === 1);
  assert.equal(karla.total_horas, 14);
  assert.equal(karla.dias_trabajados, 2);
  assert.equal(karla.turnos_incompletos, 0);
});

test('quien no marcó nada aparece igual, en cero: hay que poder verlo', () => {
  const r = armarReporte({ empleados: EMPLEADOS, marcaciones: [] });
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((e) => e.total_horas), [0, 0]);
});

test('los turnos incompletos se cuentan aparte para poder revisarlos antes de pagar', () => {
  const r = armarReporte({
    empleados: EMPLEADOS,
    marcaciones: [
      { empleado_id: 2, tipo: 'entrada', fecha: '2026-08-25', creado_en: '2026-08-25 14:00:00' },
      { empleado_id: 2, tipo: 'entrada', fecha: '2026-08-26', creado_en: '2026-08-26 14:00:00' },
      { empleado_id: 2, tipo: 'salida', fecha: '2026-08-26', creado_en: '2026-08-26 22:00:00' },
    ],
  });
  const luis = r.find((e) => e.empleado_id === 2);
  assert.equal(luis.turnos_incompletos, 1);
  assert.equal(luis.total_horas, 8, 'solo se suma lo que está completo');
});

test('no mezcla las marcaciones de una persona con las de otra', () => {
  const r = armarReporte({
    empleados: EMPLEADOS,
    marcaciones: [
      { empleado_id: 1, tipo: 'entrada', fecha: '2026-08-25', creado_en: '2026-08-25 14:00:00' },
      { empleado_id: 2, tipo: 'salida', fecha: '2026-08-25', creado_en: '2026-08-25 22:00:00' },
    ],
  });
  assert.equal(r.find((e) => e.empleado_id === 1).turnos_incompletos, 1);
  assert.equal(r.find((e) => e.empleado_id === 2).turnos_incompletos, 1);
});

// ------------------------------------------------------------- quincenas

test('calcula la quincena en curso', () => {
  assert.deepEqual(quincenaDe('2026-08-07'), { desde: '2026-08-01', hasta: '2026-08-15' });
  assert.deepEqual(quincenaDe('2026-08-25'), { desde: '2026-08-16', hasta: '2026-08-31' });
});

test('respeta los meses cortos, febrero incluido', () => {
  assert.deepEqual(quincenaDe('2026-02-20'), { desde: '2026-02-16', hasta: '2026-02-28' });
  assert.deepEqual(quincenaDe('2024-02-20'), { desde: '2024-02-16', hasta: '2024-02-29' }, 'año bisiesto');
  assert.deepEqual(quincenaDe('2026-04-30'), { desde: '2026-04-16', hasta: '2026-04-30' });
});

test('el día 15 y el 16 caen en quincenas distintas', () => {
  assert.equal(quincenaDe('2026-08-15').hasta, '2026-08-15');
  assert.equal(quincenaDe('2026-08-16').desde, '2026-08-16');
});
