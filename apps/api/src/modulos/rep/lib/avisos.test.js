import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lotesQueVencenConStock, desviacionesPersistentes, mediana, diasEntre } from './avisos.js';

const HOY = '2026-08-24';

function lote(id, insumoId, restante, vencimiento, ingreso = '2026-01-01') {
  return {
    id,
    insumo_id: insumoId,
    insumo_nombre: 'PASTA PISTACCHIO MEC3',
    unidad: 'kg',
    cantidad_restante: restante,
    fecha_ingreso: ingreso,
    fecha_vencimiento: vencimiento,
  };
}

// ------------------------------------------------- lotes que vencen con stock

test('no avisa de un lote que vence pronto pero se va a consumir antes', () => {
  // 10 kg, vence en 30 días, se consume 1 kg por día: sobra tiempo.
  const r = lotesQueVencenConStock({
    lotes: [lote(1, 11, 10, '2026-09-23')],
    consumoDiario: new Map([[11, 1]]),
    hoy: HOY,
  });
  assert.deepEqual(r, [], 'vencer pronto no es un problema si se consume antes');
});

test('avisa del lote que vence lejos pero tiene más stock del que se llega a usar', () => {
  // 200 kg, vence en 90 días, se consume 1 kg por día: van a sobrar ~110 kg.
  const r = lotesQueVencenConStock({
    lotes: [lote(1, 11, 200, '2026-11-22')],
    consumoDiario: new Map([[11, 1]]),
    hoy: HOY,
  });
  assert.equal(r.length, 1);
  assert.equal(r[0].dias_para_vencer, 90);
  assert.equal(r[0].sobrara, 110);
});

test('respeta el FIFO: el lote nuevo recién baja cuando se acabó el viejo', () => {
  // Caso incómodo y real: el lote que llegó primero vence DESPUÉS, pero se consume antes
  // (así descuenta el sistema, por fecha de ingreso). Con 40 kg por delante y 1 kg/día, en
  // los 30 días que le quedan al segundo lote no le llega el turno ni una vez.
  const r = lotesQueVencenConStock({
    lotes: [
      lote(1, 11, 40, '2027-01-01', '2026-01-01'),
      lote(2, 11, 5, '2026-09-23', '2026-06-01'),
    ],
    consumoDiario: new Map([[11, 1]]),
    hoy: HOY,
  });
  assert.deepEqual(r.map((x) => x.lote_id), [2], 'el segundo lote queda atrapado detrás del primero');
  assert.equal(r[0].sobrara, 5, 'se va a vencer entero, sin que se toque');
});

test('lo que sí se alcanza a consumir por detrás del lote viejo no se avisa', () => {
  // Mismo escenario pero con solo 20 kg por delante: en 30 días entran los 20 y los 5.
  const r = lotesQueVencenConStock({
    lotes: [
      lote(1, 11, 20, '2027-01-01', '2026-01-01'),
      lote(2, 11, 5, '2026-09-23', '2026-06-01'),
    ],
    consumoDiario: new Map([[11, 1]]),
    hoy: HOY,
  });
  assert.deepEqual(r, []);
});

test('un insumo sin consumo registrado no genera aviso en vez de suponer un ritmo', () => {
  const r = lotesQueVencenConStock({
    lotes: [lote(1, 11, 200, '2026-09-01')],
    consumoDiario: new Map(),
    hoy: HOY,
  });
  assert.deepEqual(r, [], 'sin saber el ritmo, adivinarlo sería inventar');
});

test('un lote vacío no molesta a nadie', () => {
  const r = lotesQueVencenConStock({
    lotes: [lote(1, 11, 0, '2026-09-01')],
    consumoDiario: new Map([[11, 1]]),
    hoy: HOY,
  });
  assert.deepEqual(r, []);
});

test('ordena por urgencia: primero el que vence antes', () => {
  const r = lotesQueVencenConStock({
    lotes: [
      lote(1, 11, 500, '2026-12-01', '2026-05-01'),
      lote(2, 12, 500, '2026-09-10', '2026-05-01'),
    ],
    consumoDiario: new Map([[11, 1], [12, 1]]),
    hoy: HOY,
  });
  assert.deepEqual(r.map((x) => x.lote_id), [2, 1]);
});

// ------------------------------------------------- desviaciones persistentes

function consumo(saborId, insumoId, sugerida, real) {
  return {
    sabor_id: saborId,
    sabor_nombre: 'PISTACHO',
    insumo_id: insumoId,
    insumo_nombre: 'PASTA PISTACCHIO MEC3',
    cantidad_sugerida: sugerida,
    cantidad_real: real,
  };
}

test('avisa cuando un sabor se pasa de la receta tanda tras tanda', () => {
  const filas = [2.3, 2.32, 2.28, 2.3, 2.35].map((real) => consumo(1, 11, 2, real));
  const r = desviacionesPersistentes({ filas });
  assert.equal(r.length, 1);
  assert.equal(r[0].tandas, 5);
  assert.ok(r[0].desviacion > 12, `esperaba ~15%, dio ${r[0].desviacion}`);
});

test('una sola tanda rara no alcanza para avisar', () => {
  const filas = [consumo(1, 11, 2, 4)];
  assert.deepEqual(desviacionesPersistentes({ filas }), []);
});

test('usar de menos también se avisa: puede ser receta mal cargada', () => {
  const filas = [1.7, 1.68, 1.72, 1.7].map((real) => consumo(1, 11, 2, real));
  const r = desviacionesPersistentes({ filas });
  assert.equal(r.length, 1);
  assert.ok(r[0].desviacion < -12);
});

test('un error de tipeo aislado no arrastra al resto del grupo', () => {
  // Cuatro tandas bien y una con un dígito de más: la mediana lo ignora.
  const filas = [2, 2, 2, 2, 20].map((real) => consumo(1, 11, 2, real));
  assert.deepEqual(desviacionesPersistentes({ filas }), [], 'la mediana no se deja arrastrar');
});

test('las tandas sin receta no se cuentan: no hay con qué comparar', () => {
  const filas = [null, null, null, null, null].map((s) => consumo(1, 11, s, 2));
  assert.deepEqual(desviacionesPersistentes({ filas }), []);
});

test('separa por sabor y por insumo, no mezcla todo', () => {
  const filas = [
    ...[2.3, 2.3, 2.3, 2.3].map((real) => consumo(1, 11, 2, real)),
    ...[2, 2, 2, 2].map((real) => consumo(2, 11, 2, real)),
  ];
  const r = desviacionesPersistentes({ filas });
  assert.deepEqual(r.map((x) => x.sabor_id), [1], 'solo el sabor que se desvía');
});

// ------------------------------------------------- utilidades

test('la mediana ignora el extremo', () => {
  assert.equal(mediana([1, 2, 3, 4, 100]), 3);
  assert.equal(mediana([1, 3]), 2);
  assert.equal(mediana([]), null);
});

test('cuenta los días entre dos fechas, incluso hacia atrás', () => {
  assert.equal(diasEntre('2026-08-24', '2026-09-23'), 30);
  assert.equal(diasEntre('2026-08-24', '2026-08-24'), 0);
  assert.equal(diasEntre('2026-08-24', '2026-08-14'), -10);
});
