import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoriaParaGramos, panasParaCategoria } from './reposicion.js';

test('menos de 3000g es categoria roja', () => {
  assert.equal(categoriaParaGramos(0), 'roja');
  assert.equal(categoriaParaGramos(2999), 'roja');
});

test('entre 3000 y 5000g inclusive es categoria amarilla', () => {
  assert.equal(categoriaParaGramos(3000), 'amarilla');
  assert.equal(categoriaParaGramos(4500), 'amarilla');
  assert.equal(categoriaParaGramos(5000), 'amarilla');
});

test('mas de 5000g no amerita envio', () => {
  assert.equal(categoriaParaGramos(5001), null);
  assert.equal(categoriaParaGramos(10000), null);
});

test('panasParaCategoria mapea roja a 2 y amarilla a 1', () => {
  assert.equal(panasParaCategoria('roja'), 2);
  assert.equal(panasParaCategoria('amarilla'), 1);
  assert.equal(panasParaCategoria(null), 0);
});
