import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIAS_POR_ANIO,
  mesesCumplidos,
  diasGanados,
  diasDeVacacion,
  resumenVacaciones,
} from './vacaciones.js';

test('son 12 dias al año, o sea uno por mes cumplido', () => {
  assert.equal(DIAS_POR_ANIO, 12);
  assert.equal(diasGanados(1), 1);
  assert.equal(diasGanados(6), 6);
  assert.equal(diasGanados(12), 12, 'al año cumplido, 12');
  assert.equal(diasGanados(36), 36, 'a los tres años, 36');
});

test('el mes se cumple el mismo dia del mes, no a los 30 dias', () => {
  assert.equal(mesesCumplidos('2026-08-15', '2026-09-14'), 0, 'un dia antes todavia no');
  assert.equal(mesesCumplidos('2026-08-15', '2026-09-15'), 1, 'el dia que se cumple ya suma');
  assert.equal(mesesCumplidos('2026-08-15', '2026-09-16'), 1);
  assert.equal(mesesCumplidos('2025-09-21', '2026-09-21'), 12, 'un año son 12 meses');
  assert.equal(mesesCumplidos('2019-04-10', '2026-09-21'), 89, '7 años y 5 meses');
});

test('quien recien entro no tiene dias todavia', () => {
  const r = resumenVacaciones({ fechaIngreso: '2026-09-10', vacaciones: [], hoy: '2026-09-21' });
  assert.equal(r.meses, 0);
  assert.equal(r.ganados, 0);
  assert.equal(r.saldo, 0);
});

test('los dias SE ACUMULAN: no se reinician en el aniversario', () => {
  // Tres años justos sin tomarse nada: los 36 siguen ahi, no vuelve a 12.
  const r = resumenVacaciones({ fechaIngreso: '2023-09-21', vacaciones: [], hoy: '2026-09-21' });
  assert.equal(r.anios, 3);
  assert.equal(r.ganados, 36);
  assert.equal(r.saldo, 36);
});

test('se descuenta TODO lo tomado, de cualquier año, no solo lo del año en curso', () => {
  const r = resumenVacaciones({
    fechaIngreso: '2023-09-21',
    hoy: '2026-09-21',
    vacaciones: [
      { fecha_inicio: '2026-09-01', fecha_fin: '2026-09-07', dias: 7 },
      { fecha_inicio: '2024-12-20', fecha_fin: '2024-12-29', dias: 10 },
    ],
  });
  assert.equal(r.ganados, 36);
  assert.equal(r.tomados, 17, 'suma los dos, aunque sean de años distintos');
  assert.equal(r.saldo, 19);
});

test('la antiguedad se muestra en años y meses sueltos', () => {
  const r = resumenVacaciones({ fechaIngreso: '2024-04-21', vacaciones: [], hoy: '2026-09-21' });
  assert.equal(r.anios, 2);
  assert.equal(r.mesesSueltos, 5);
  assert.equal(r.ganados, 29);
});

test('los dias se cuentan corridos e incluyendo los dos extremos', () => {
  assert.equal(diasDeVacacion('2026-09-01', '2026-09-01'), 1, 'un solo dia es 1, no 0');
  assert.equal(diasDeVacacion('2026-09-01', '2026-09-07'), 7, 'de lunes a domingo son 7');
  assert.equal(diasDeVacacion('2026-12-28', '2027-01-03'), 7, 'cruzar el año no lo confunde');
});

test('el saldo puede quedar negativo si se le dieron mas dias de los que gano', () => {
  // No se recorta a cero: si alguien ya salio 12 dias habiendo ganado 6, el dueño tiene que verlo.
  const r = resumenVacaciones({
    fechaIngreso: '2026-03-21',
    hoy: '2026-09-21',
    vacaciones: [{ fecha_inicio: '2026-04-01', fecha_fin: '2026-04-12', dias: 12 }],
  });
  assert.equal(r.ganados, 6);
  assert.equal(r.saldo, -6);
});

test('sin fecha de ingreso no se inventa un saldo, pero el historial no se pierde', () => {
  const r = resumenVacaciones({
    fechaIngreso: null,
    hoy: '2026-09-21',
    vacaciones: [{ fecha_inicio: '2026-09-01', fecha_fin: '2026-09-07', dias: 7 }],
  });
  assert.equal(r.sinFechaIngreso, true);
  assert.equal(r.saldo, undefined, 'mejor sin saldo que con un saldo inventado');
  assert.equal(r.tomados, 7);
  assert.equal(r.historial.length, 1);
});

test('el historial vuelve ordenado de lo mas reciente a lo mas viejo', () => {
  const r = resumenVacaciones({
    fechaIngreso: '2020-01-01',
    hoy: '2026-09-21',
    vacaciones: [
      { fecha_inicio: '2024-03-01', fecha_fin: '2024-03-05', dias: 5 },
      { fecha_inicio: '2026-01-10', fecha_fin: '2026-01-15', dias: 6 },
    ],
  });
  assert.equal(r.historial[0].fecha_inicio, '2026-01-10');
});
