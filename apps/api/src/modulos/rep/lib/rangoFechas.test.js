import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolverRango } from './rangoFechas.js';

test('sin desde: arma los ultimos N dias anclados a hasta', () => {
  const r = resolverRango({ dias: '7', hasta: '2026-08-20' });
  assert.equal(r.desde, '2026-08-14');
  assert.equal(r.hasta, '2026-08-20');
});

import { hoyNegocio } from './fechaNegocio.js';

test('sin dias ni hasta: usa 30 dias hasta hoy', () => {
  const hoy = hoyNegocio();
  const r = resolverRango({});
  assert.equal(r.hasta, hoy);
});

test('dias se acota entre 7 y 180', () => {
  assert.equal(resolverRango({ dias: '2', hasta: '2026-08-20' }).desde, '2026-08-14');
  assert.equal(resolverRango({ dias: '9999', hasta: '2026-08-20' }).desde, '2026-02-22');
});

test('con desde: arma un periodo calendarizado exacto', () => {
  const r = resolverRango({ desde: '2026-08-01', hasta: '2026-08-10' });
  assert.deepEqual(r, { desde: '2026-08-01', hasta: '2026-08-10' });
});

test('con desde sin hasta: hasta es hoy', () => {
  const hoy = hoyNegocio();
  const desde = new Date(`${hoy}T12:00:00Z`);
  desde.setUTCDate(desde.getUTCDate() - 30); // dentro del tope de 180 dias
  const r = resolverRango({ desde: desde.toISOString().slice(0, 10) });
  assert.equal(r.hasta, hoy);
});

test('rechaza fechas con formato invalido', () => {
  assert.ok(resolverRango({ desde: '01-08-2026', hasta: '2026-08-10' }).error);
  assert.ok(resolverRango({ desde: '2026-08-01', hasta: 'ayer' }).error);
});

test('rechaza desde posterior a hasta', () => {
  assert.ok(resolverRango({ desde: '2026-08-20', hasta: '2026-08-01' }).error);
});

test('rechaza un periodo calendarizado de mas de 180 dias', () => {
  assert.ok(resolverRango({ desde: '2026-01-01', hasta: '2026-12-31' }).error);
});
