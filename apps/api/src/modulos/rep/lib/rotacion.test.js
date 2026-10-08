import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armarRotacion, clasificar, mediana, CLASIFICACION } from './rotacion.js';

const HOY = '2026-08-30';

const despacho = (extra) => ({
  fecha: '2026-08-20', sucursal_id: 'proceres', sucursal_nombre: 'Próceres',
  sabor_id: 1, sabor_nombre: 'MANGO', panas: 2, gramos_enviados: 5000,
  estado: 'recibido', ...extra,
});

const base = { despachos: [], producciones: [], sinStock: [], hoy: HOY };

// ------------------------------------------------------------- despachado

test('el total de un sabor es lo despachado, sumado entre todas las tiendas', () => {
  const r = armarRotacion({
    ...base,
    despachos: [
      despacho({ sucursal_id: 'proceres', sucursal_nombre: 'Próceres', gramos_enviados: 6000 }),
      despacho({ sucursal_id: 'mackey', sucursal_nombre: 'Mackey', gramos_enviados: 9000 }),
      despacho({ sucursal_id: '10-calle', sucursal_nombre: '10 Calle', gramos_enviados: 15000 }),
    ],
  });
  // 6 + 9 + 15 = 30 kg - lo que de verdad salio de fabrica hacia las tres tiendas.
  assert.equal(r.sabores[0].despachadoGramos, 30000);
  assert.equal(r.sabores[0].despachadoKg, 30);
});

test('no cuenta lo que todavia no salio de fabrica', () => {
  const r = armarRotacion({
    ...base,
    despachos: [despacho({ estado: 'pendiente' }), despacho({ estado: 'preparado' })],
  });
  assert.equal(r.sabores.length, 0);
});

test('separa lo despachado por sucursal: un sabor puede volar en una tienda y estancarse en otra', () => {
  const r = armarRotacion({
    ...base,
    despachos: [
      despacho({ sucursal_id: 'proceres', sucursal_nombre: 'Próceres', gramos_enviados: 9000 }),
      despacho({ sucursal_id: 'mackey', sucursal_nombre: 'Mackey', gramos_enviados: 1000 }),
    ],
  });
  const suc = r.sabores[0].porSucursal;
  assert.equal(suc.length, 2);
  assert.equal(suc[0].nombre, 'Próceres', 'se ordena por lo despachado, la que mas recibio primero');
  assert.equal(suc[0].despachadoGramos, 9000);
  assert.equal(suc[0].despachadoKg, 9);
});

// -------------------------------------------------------------- por tienda

test('la vista por tienda es el mismo dato mirado al reves: que sabores le mandaron a cada una', () => {
  const r = armarRotacion({
    ...base,
    despachos: [
      despacho({ sucursal_id: 'mackey', sucursal_nombre: 'Mackey', sabor_id: 1, sabor_nombre: 'MANGO', gramos_enviados: 9000 }),
      despacho({ sucursal_id: 'mackey', sucursal_nombre: 'Mackey', sabor_id: 2, sabor_nombre: 'FRESA', gramos_enviados: 3000 }),
      despacho({ sucursal_id: 'proceres', sucursal_nombre: 'Próceres', sabor_id: 1, sabor_nombre: 'MANGO', gramos_enviados: 5000 }),
    ],
  });

  assert.equal(r.tiendas.length, 2);
  assert.equal(r.tiendas[0].nombre, 'Mackey', 'la que mas recibio en total, primero');
  assert.equal(r.tiendas[0].despachadoGramos, 12000);
  assert.equal(r.tiendas[0].despachadoKg, 12);

  const saboresMackey = r.tiendas[0].porSabor;
  assert.equal(saboresMackey.length, 2);
  assert.equal(saboresMackey[0].nombre, 'MANGO', 'el que mas le mandaron a ESA tienda, primero');
  assert.equal(saboresMackey[0].despachadoGramos, 9000);
  assert.equal(saboresMackey[1].nombre, 'FRESA');

  assert.equal(r.tiendas[1].nombre, 'Próceres');
  assert.equal(r.tiendas[1].despachadoGramos, 5000);
});

test('una tienda a la que no le despacharon nada en el periodo no aparece', () => {
  const r = armarRotacion({ ...base, despachos: [] });
  assert.equal(r.tiendas.length, 0);
});

// ------------------------------------------------------- clasificacion

test('un sabor que se pidio pero no habia es quiebre de stock, NO un sabor muerto', () => {
  const c = clasificar({ consumo: 0, diasSinDespachar: null, vecesSinStock: 5, producidoKg: 0, consumoMediano: 1000 });
  assert.equal(c, CLASIFICACION.FALTA_STOCK);
});

test('un sabor que nunca se produjo no se marca como muerto: no tuvo oportunidad', () => {
  const c = clasificar({ consumo: 0, diasSinDespachar: null, vecesSinStock: 0, producidoKg: 0, consumoMediano: 1000 });
  assert.equal(c, CLASIFICACION.SIN_PRODUCIR);
});

test('se produjo pero nadie lo pidio: ese si esta muerto', () => {
  const c = clasificar({ consumo: 0, diasSinDespachar: null, vecesSinStock: 0, producidoKg: 30, consumoMediano: 1000 });
  assert.equal(c, CLASIFICACION.MUERTO);
});

test('muchos dias sin despachar habiendo producido tambien es muerto', () => {
  const c = clasificar({ consumo: 100, diasSinDespachar: 25, vecesSinStock: 0, producidoKg: 10, consumoMediano: 1000 });
  assert.equal(c, CLASIFICACION.MUERTO);
});

test('bien por encima del sabor tipico es estrella; bien por debajo es lento', () => {
  const comun = { diasSinDespachar: 1, vecesSinStock: 0, producidoKg: 10, consumoMediano: 1000 };
  assert.equal(clasificar({ ...comun, consumo: 2000 }), CLASIFICACION.ESTRELLA);
  assert.equal(clasificar({ ...comun, consumo: 300 }), CLASIFICACION.LENTO);
  assert.equal(clasificar({ ...comun, consumo: 1000 }), CLASIFICACION.NORMAL);
});

test('la clasificacion se calcula sobre lo despachado, igual que el numero que se muestra', () => {
  // Si la clasificacion usara otro numero por dentro, dos sabores con el mismo kg en
  // pantalla podrian salir con etiquetas distintas - inconsistencia invisible.
  const r = armarRotacion({
    ...base,
    despachos: [
      despacho({ sabor_id: 1, sabor_nombre: 'ESTRELLA', gramos_enviados: 20000 }),
      despacho({ sabor_id: 2, sabor_nombre: 'NORMAL', gramos_enviados: 5000 }),
      despacho({ sabor_id: 3, sabor_nombre: 'LENTO', gramos_enviados: 500 }),
    ],
  });
  const porNombre = Object.fromEntries(r.sabores.map((s) => [s.nombre, s.clasificacion]));
  assert.equal(porNombre.ESTRELLA, CLASIFICACION.ESTRELLA);
  assert.equal(porNombre.LENTO, CLASIFICACION.LENTO);
});

test('usa la mediana y no el promedio, para que un estrella no haga parecer lento al resto', () => {
  // Promedio = 2620 (lo infla el 10000); mediana = 300.
  assert.equal(mediana([100, 200, 300, 500, 10000]), 300);
});

test('mediana con cantidad par promedia los dos del medio', () => {
  assert.equal(mediana([10, 20, 30, 40]), 25);
});

test('mediana de una lista vacia es 0 y no rompe', () => {
  assert.equal(mediana([]), 0);
});

// ------------------------------------------------------------ integracion

test('ordena los sabores por lo despachado y cuenta dias desde el ultimo despacho', () => {
  const r = armarRotacion({
    ...base,
    despachos: [
      despacho({ sabor_id: 1, sabor_nombre: 'MANGO', gramos_enviados: 2000, fecha: '2026-08-29' }),
      despacho({ sabor_id: 2, sabor_nombre: 'FRESA', gramos_enviados: 8000, fecha: '2026-08-10' }),
    ],
  });
  assert.equal(r.sabores[0].nombre, 'FRESA');
  assert.equal(r.sabores[1].nombre, 'MANGO');
  assert.equal(r.sabores[1].diasSinDespachar, 1, 'del 29 al 30 es un dia');
  assert.equal(r.sabores[0].diasSinDespachar, 20);
});

test('un sabor solo producido (nunca despachado) igual aparece, para poder verlo', () => {
  const r = armarRotacion({
    ...base,
    producciones: [{ sabor_id: 9, sabor_nombre: 'TIRAMISU', kg: 20 }],
  });
  assert.equal(r.sabores.length, 1);
  assert.equal(r.sabores[0].clasificacion, CLASIFICACION.MUERTO);
  assert.equal(r.sabores[0].diasSinDespachar, null);
  assert.equal(r.tiendas.length, 0, 'no se despacho a ninguna tienda, no hay nada que ver por tienda');
});
