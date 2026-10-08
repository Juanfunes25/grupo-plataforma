import test from 'node:test';
import assert from 'node:assert/strict';
import { calcularTotales, identidadValida, requiereRtn, rtnLuceValido, rtnValido, envolverTicketHtml, nombreCortoSucursal, UMBRAL_RTN_OBLIGATORIO, OPCIONES_DESCUENTO } from '../src/index.js';

test('RTN: 14 dígitos exactos; el criterio flojo de Italo (13-14) solo avisa', () => {
  assert.equal(rtnValido('0801-1990-123456'), true);
  assert.equal(rtnValido('0801199012345'), false);
  assert.equal(rtnLuceValido('0801199012345'), true);
  assert.equal(rtnLuceValido(''), true);
  assert.equal(rtnLuceValido('12345'), false);
});

test('RTN obligatorio solo SOBRE el umbral y solo si el cliente no tiene RTN', () => {
  assert.equal(UMBRAL_RTN_OBLIGATORIO, 10000);
  assert.equal(requiereRtn(10000, null), false);
  assert.equal(requiereRtn(10000.01, null), true);
  assert.equal(requiereRtn(10000.01, { rtn: '  ' }), true);
  assert.equal(requiereRtn(50000, { rtn: '08011990123456' }), false);
  assert.equal(requiereRtn(600, null, 500), true);
});

test('carné de tercera edad: 5 o más caracteres alfanuméricos', () => {
  assert.equal(identidadValida('A-1234'), true);
  assert.equal(identidadValida('A-123'), false);
  assert.equal(identidadValida('0801-1950-00123'), true);
});

test('descuentos por porcentaje: una orden puede mezclar 10 % y 25 %', () => {
  assert.deepEqual(OPCIONES_DESCUENTO.map((o) => o.porcentaje), [0, 10, 25]);
  const r = calcularTotales([
    { nombre_producto: 'A', cantidad: 1, precio_base: 100, impuesto_tasa: 0.15, descuento_porcentaje: 25 },
    { nombre_producto: 'B', cantidad: 2, precio_base: 50, impuesto_tasa: 0.15, descuento_porcentaje: 10 },
    { nombre_producto: 'C', cantidad: 1, precio_base: 40, impuesto_tasa: 0.15 },
  ], null);
  assert.deepEqual(r.descuentos_por_porcentaje, { 10: 10, 25: 25 });
  assert.equal(r.descuento, 35);
  assert.equal(r.total, 205);
});

test('papel térmico: HTML con el ancho del rollo y nombre corto de sucursal', () => {
  const h = envolverTicketHtml('A < B & C', 32);
  assert.match(h, /size: 58mm auto/);
  assert.match(h, /A &lt; B &amp; C/);
  assert.match(envolverTicketHtml('x', 48), /size: 80mm auto/);
  assert.equal(nombreCortoSucursal('Inversiones Milano S de R.L. - 10 Calle'), '10 Calle');
  assert.equal(nombreCortoSucursal('Principal'), 'Principal');
});
