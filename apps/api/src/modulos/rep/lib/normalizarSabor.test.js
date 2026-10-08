import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizarNombreSabor, saborParecido, pareceQueTraePeso } from './normalizarSabor.js';

test('normalizarNombreSabor iguala acentos, mayusculas y espacios de mas', () => {
  assert.equal(normalizarNombreSabor('Pistacchio'), 'PISTACCHIO');
  assert.equal(normalizarNombreSabor('  Fresa   con  Crema '), 'FRESA CON CREMA');
  assert.equal(normalizarNombreSabor('Piña Colada'), 'PINA COLADA');
  assert.equal(normalizarNombreSabor(null), '');
});

test('saborParecido encuentra un nombre contenido dentro de otro', () => {
  // Esto es lo que resuelve solo: un typo de mayuscula/acento, o que una tienda escriba la
  // version corta de un nombre y otra la larga. Una reescritura de fondo ("C/CREMA" vs "CON
  // CREMA") no la agarra un chequeo por contencion - para eso esta la fusion manual del dueño.
  const existentes = [{ id: 1, nombre: 'FRESA CON CREMA' }, { id: 2, nombre: 'MANGO' }];
  assert.equal(saborParecido('FRESA', existentes).id, 1, 'un nombre corto contenido en uno largo cuenta');
  assert.equal(saborParecido('FRESA CON CREMA Y GALLETA', existentes).id, 1, 'y al reves tambien');
});

test('saborParecido no confunde la coincidencia exacta con un parecido', () => {
  // Si ya es exactamente el mismo (una vez normalizado) no es un "parecido": es el mismo
  // sabor, y quien llama a esto lo tiene que enganchar directo, sin preguntar nada.
  const existentes = [{ id: 1, nombre: 'MANGO' }];
  assert.equal(saborParecido('mango', existentes), null);
  assert.equal(saborParecido('  Mango  ', existentes), null);
});

test('saborParecido no dispara con nombres cortos ni con sabores sin relacion', () => {
  const existentes = [{ id: 1, nombre: 'TE' }, { id: 2, nombre: 'DUBAI' }];
  assert.equal(saborParecido('TIRAMISU', existentes), null);
  assert.equal(saborParecido('MATE', existentes), null, 'TE tiene 2 letras, no debe matchear contra cualquier cosa que lo contenga');
});

test('saborParecido devuelve el candidato mas corto (el canonico) si hay varios', () => {
  const existentes = [{ id: 1, nombre: 'FRESA CON CREMA Y GALLETA' }, { id: 2, nombre: 'FRESA' }];
  assert.equal(saborParecido('FRESA CON CREMA', existentes).id, 2);
});

test('pareceQueTraePeso detecta el peso pegado al nombre', () => {
  assert.equal(pareceQueTraePeso('FRESA 4500'), true);
  assert.equal(pareceQueTraePeso('MANGO 3.5'), true);
  assert.equal(pareceQueTraePeso('MANGO 3,5'), true, 'coma decimal tambien');
  assert.equal(pareceQueTraePeso('PISTACHO 3500G'), true);
  assert.equal(pareceQueTraePeso('PISTACHO 3.5KG'), true);
  assert.equal(pareceQueTraePeso('CAFE 2 GRAMOS'), true);
});

test('pareceQueTraePeso no marca nombres normales', () => {
  assert.equal(pareceQueTraePeso('TIRAMISU'), false, 'una sola palabra, nunca es esto');
  assert.equal(pareceQueTraePeso('FRESA CON CREMA'), false);
  assert.equal(pareceQueTraePeso('COPA 3 LECHES'), false, 'termina en palabra, no en numero');
  assert.equal(pareceQueTraePeso(''), false);
});
