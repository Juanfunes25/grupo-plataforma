import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armarInsumosDespachados } from './insumosDespachados.js';

const item = (extra) => ({
  insumo_texto: 'Vasos 8oz', enviado: 1, sucursal_id: 'proceres', sucursal_nombre: 'Próceres', ...extra,
});

test('cuenta veces enviado, no veces pedido: lo no marcado no suma', () => {
  const r = armarInsumosDespachados([
    item(), item(), item({ enviado: 0 }),
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].veces, 2);
});

test('agrupa el mismo insumo escrito distinto (mayus/espacios) como uno solo', () => {
  const r = armarInsumosDespachados([
    item({ insumo_texto: 'vasos 8oz' }),
    item({ insumo_texto: '  Vasos   8oz ' }),
    item({ insumo_texto: 'VASOS 8OZ' }),
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].veces, 3);
  assert.equal(r[0].nombre, 'vasos 8oz', 'se queda con el texto de la primera aparicion, ya recortado');
});

test('ordena los insumos de mas a menos veces enviado', () => {
  const r = armarInsumosDespachados([
    item({ insumo_texto: 'Conos' }),
    item({ insumo_texto: 'Vasos 8oz' }), item({ insumo_texto: 'Vasos 8oz' }), item({ insumo_texto: 'Vasos 8oz' }),
    item({ insumo_texto: 'Cucharitas' }), item({ insumo_texto: 'Cucharitas' }),
  ]);
  assert.deepEqual(r.map((i) => i.nombre), ['Vasos 8oz', 'Cucharitas', 'Conos']);
});

test('el desglose por tienda tambien va de mas a menos, para "apreto el insumo y veo donde se fue"', () => {
  const r = armarInsumosDespachados([
    item({ sucursal_id: 'mackey', sucursal_nombre: 'Mackey' }),
    item({ sucursal_id: 'mackey', sucursal_nombre: 'Mackey' }),
    item({ sucursal_id: 'mackey', sucursal_nombre: 'Mackey' }),
    item({ sucursal_id: 'proceres', sucursal_nombre: 'Próceres' }),
  ]);
  assert.equal(r[0].porTienda.length, 2);
  assert.equal(r[0].porTienda[0].nombre, 'Mackey');
  assert.equal(r[0].porTienda[0].veces, 3);
  assert.equal(r[0].porTienda[1].nombre, 'Próceres');
  assert.equal(r[0].porTienda[1].veces, 1);
});

test('un insumo con texto vacio no rompe nada y se ignora', () => {
  const r = armarInsumosDespachados([item({ insumo_texto: '   ' }), item({ insumo_texto: null })]);
  assert.equal(r.length, 0);
});

test('una lista vacia da una lista vacia', () => {
  assert.deepEqual(armarInsumosDespachados([]), []);
});
