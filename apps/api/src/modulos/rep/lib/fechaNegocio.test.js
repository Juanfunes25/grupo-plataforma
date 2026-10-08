import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hoyNegocio, minutosDelDia } from './fechaNegocio.js';

test('a las 7 de la tarde en Honduras todavía es hoy, no mañana', () => {
  // 2026-08-26 01:00 UTC = 2026-08-25 19:00 en Honduras. Este es el caso que rompía:
  // toISOString() ya decía 26.
  const momento = new Date('2026-08-26T01:00:00Z');
  assert.equal(momento.toISOString().slice(0, 10), '2026-08-26', 'así se comportaba antes');
  assert.equal(hoyNegocio(momento), '2026-08-25', 'y así tiene que ser');
});

test('pasada la medianoche local sí cambia el día', () => {
  // 2026-08-26 06:30 UTC = 2026-08-26 00:30 en Honduras.
  assert.equal(hoyNegocio(new Date('2026-08-26T06:30:00Z')), '2026-08-26');
});

test('al mediodía local no hay ambigüedad', () => {
  assert.equal(hoyNegocio(new Date('2026-08-25T18:00:00Z')), '2026-08-25');
});

test('la hora es la de acá, no la del servidor en UTC', () => {
  // 14:00 UTC = 08:00 en Honduras: la hora a la que abre una tienda.
  const momento = new Date('2026-08-25T14:00:00Z');
  assert.equal(momento.getUTCHours() * 60, 840, 'UTC diría las 14:00');
  assert.equal(minutosDelDia(momento), 480, 'acá son las 8:00');
});

test('la medianoche local da cero, no un número negativo', () => {
  assert.equal(minutosDelDia(new Date('2026-08-25T06:00:00Z')), 0);
});

test('funciona en enero igual que en agosto (Honduras no mueve el reloj)', () => {
  assert.equal(hoyNegocio(new Date('2026-01-15T23:00:00Z')), '2026-01-15');
  assert.equal(minutosDelDia(new Date('2026-01-15T23:00:00Z')), 17 * 60);
});
