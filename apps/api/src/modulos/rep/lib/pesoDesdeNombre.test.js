import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pesoDesdeNombre } from './pesoDesdeNombre.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('saca el peso de las formas en que Mec3 lo escribe', () => {
  assert.equal(pesoDesdeNombre('COOKIES BLACK X 6 KG'), 6);
  assert.equal(pesoDesdeNombre('AMARENATA (WHOLE CHERRIES IN SYRUP) X 2.75 KG'), 2.75);
  assert.equal(pesoDesdeNombre('BASE ALBA COMPLETA X 1,2 KG.'), 1.2, 'coma decimal, viene de Italia');
  assert.equal(pesoDesdeNombre('BASE 50 MB CON PANNA IN POLV. E SENZA AROMI 2.5KG'), 2.5, 'sin espacio y sin la X');
  assert.equal(pesoDesdeNombre('BASE MARVA x 2 KG.'), 2, 'la x minuscula tambien');
  assert.equal(pesoDesdeNombre('COOKIES COCOBOOM X 6 KG (COCONUT COOKIE)'), 6, 'el peso no siempre va al final');
  assert.equal(pesoDesdeNombre('BIANCO CIOC x 12 KG. GALILEO'), 12);
  assert.equal(pesoDesdeNombre('EXTRA DARK BLACK X 1.625 KG'), 1.625, 'tres decimales');
});

test('NO confunde el codigo de producto con el peso', () => {
  // Estos son los nombres que rompen la version ingenua "agarra el primer numero".
  assert.equal(pesoDesdeNombre('ANGURIA 500 (WATERMELON) X 1.25 KG'), 1.25);
  assert.equal(pesoDesdeNombre('BASE 100 MB CON PANNA IN POLV 2 KG'), 2);
  assert.equal(pesoDesdeNombre('CAFFE` 500 (COFFEE) x 1.25 KG'), 1.25);
  assert.equal(pesoDesdeNombre("TUTTOPANN `C`10 x 2.5 KG."), 2.5);
});

test('no inventa multipacks', () => {
  // "BASE 6" es como MEC3 llama al producto 02006; el 6 no es una cantidad de bolsas.
  // Si esto empezara a dar 15, el inventario valdria seis veces mas de lo que vale.
  assert.equal(pesoDesdeNombre('BASE 6 X 2.5 KG'), 2.5);
  assert.equal(pesoDesdeNombre('CACAO MISCELA MEC3 x 1.5 KG'), 1.5);
  assert.equal(pesoDesdeNombre('KIT COOKIES CARAMEL C.W. LOTUS BISCOFF 2024 X 13.46 KG'), 13.46);
  assert.equal(pesoDesdeNombre('PISTACHI GRAINS 3/5 X 1 KG'), 1);
});

test('devuelve null en vez de adivinar', () => {
  assert.equal(pesoDesdeNombre('AZUCAR'), null, 'los insumos locales no traen peso en el nombre');
  assert.equal(pesoDesdeNombre('LECHE EN POLVO'), null);
  assert.equal(pesoDesdeNombre(''), null);
  assert.equal(pesoDesdeNombre(null), null);
  assert.equal(pesoDesdeNombre(undefined), null);
  assert.equal(pesoDesdeNombre('PALETA 0 KG'), null, 'cero no es un peso');
  assert.equal(pesoDesdeNombre('LOTE 2024 KG'), null, 'fuera del tope de cordura');
  assert.equal(pesoDesdeNombre('CAJA KGB'), null, 'KG tiene que ser la palabra, no el principio de otra');
});
