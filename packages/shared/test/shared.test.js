import test from 'node:test';
import assert from 'node:assert/strict';
import { calcularTotales, descuentoDeLinea, round2, permisosDe, modulosVisibles, fechaHN, sumarDias } from '../src/index.js';

test('ISV se separa del precio con impuesto incluido', () => {
  const r = calcularTotales([{ nombre_producto: 'Jugo', cantidad: 2, precio_base: 115, impuesto_tasa: 0.15 }], null);
  assert.equal(r.total, 230);
  assert.equal(r.subtotal_gravado_15, 200);
  assert.equal(r.isv_total, 30);
});

test('producto exento por ley va a exento; sin flag va a exonerado', () => {
  const a = calcularTotales([{ nombre_producto: 'Mango', cantidad: 1, precio_base: 50, impuesto_tasa: 0, exento: true }], null);
  assert.equal(a.subtotal_exento, 50);
  assert.equal(a.isv_total, 0);
  const b = calcularTotales([{ nombre_producto: 'X', cantidad: 1, precio_base: 50, impuesto_tasa: 0 }], null);
  assert.equal(b.subtotal_exonerado, 50);
  const c = calcularTotales([{ nombre_producto: 'X', cantidad: 1, precio_base: 50, impuesto_tasa: 0 }], { exento_impuestos: true });
  assert.equal(c.subtotal_exento, 50);
});

test('modificadores suman al precio unitario y a la base gravable', () => {
  const r = calcularTotales([{ nombre_producto: 'Smoothie', cantidad: 1, precio_base: 100, extras: 15, impuesto_tasa: 0.15 }], null);
  assert.equal(r.total, 115);
  assert.equal(r.subtotal_gravado_15, 100);
  assert.equal(r.isv_total, 15);
});

test('descuento por línea (tercera edad 25 %) reduce base e ISV', () => {
  assert.equal(descuentoDeLinea(100, 1, 25), 25);
  const r = calcularTotales([
    { nombre_producto: 'A', cantidad: 1, precio_base: 100, impuesto_tasa: 0.15, descuento_porcentaje: 25 },
    { nombre_producto: 'B', cantidad: 1, precio_base: 100, impuesto_tasa: 0.15 },
  ], null);
  assert.equal(r.total, 175);
  assert.equal(r.descuento, 25);
  assert.equal(round2(r.subtotal_gravado_15 + r.isv_total), 175);
});

test('descuento global se reparte y los centavos cuadran exacto', () => {
  const r = calcularTotales([
    { nombre_producto: 'A', cantidad: 1, precio_base: 33.33, impuesto_tasa: 0.15 },
    { nombre_producto: 'B', cantidad: 1, precio_base: 33.33, impuesto_tasa: 0.15 },
    { nombre_producto: 'C', cantidad: 1, precio_base: 33.34, impuesto_tasa: 0.15 },
  ], null, 10);
  assert.equal(r.total, 90);
  assert.equal(round2(r.lineas.reduce((s, l) => s + l.descuento, 0)), 10);
  assert.equal(round2(r.subtotal_gravado_15 + r.isv_total), 90);
});

test('gravado 18 % tiene su propio bucket', () => {
  const r = calcularTotales([{ nombre_producto: 'Licor', cantidad: 1, precio_base: 118, impuesto_tasa: 0.18 }], null);
  assert.equal(r.subtotal_gravado_18, 100);
  assert.equal(r.isv_total, 18);
});

test('roles: cajero vende pero no anula; permisos extra y quitados', () => {
  const c = permisosDe('cajero');
  assert.ok(c.has('pos:vender'));
  assert.ok(!c.has('pos:anular'));
  assert.ok(permisosDe('cajero', ['pos:anular']).has('pos:anular'));
  assert.ok(!permisosDe('cajero', [], ['pos:vender']).has('pos:vender'));
  assert.ok(permisosDe('dueno').has('grupo:ver'));
});

test('módulos visibles dependen de empresa y permisos', () => {
  const v = modulosVisibles(['pos', 'inventario'], permisosDe('cajero')).map((m) => m.id);
  assert.ok(v.includes('pos'));
  assert.ok(!v.includes('inventario'));
  assert.ok(!v.includes('grupo'));
  const d = modulosVisibles(['pos', 'inventario', 'grupo', 'kds'], permisosDe('dueno')).map((m) => m.id);
  for (const id of ['pos', 'facturas', 'cierres', 'reportes', 'catalogo', 'inventario', 'kds', 'admin']) assert.ok(d.includes(id), id);
  assert.ok(!d.includes('grupo'), 'Dirección no aparece dentro de una empresa');
});

test('fecha Honduras (UTC-6) y sumarDias', () => {
  assert.equal(fechaHN(new Date('2026-03-02T03:00:00Z')), '2026-03-01');
  assert.equal(sumarDias('2026-02-28', 1), '2026-03-01');
});

test('antifraude y cotizaciones solo existen donde la empresa los enciende', () => {
  const sin = modulosVisibles(['pos'], permisosDe('dueno')).map((m) => m.id);
  assert.ok(!sin.includes('antifraude') && !sin.includes('cotizaciones'));
  const con = modulosVisibles(['pos', 'antifraude', 'cotizaciones'], permisosDe('dueno')).map((m) => m.id);
  assert.ok(con.includes('antifraude') && con.includes('cotizaciones'));
  assert.ok(!modulosVisibles(['pos', 'antifraude'], permisosDe('cajero')).some((m) => m.id === 'antifraude'));
});

test('reposición de gelato: el módulo de empresa muestra su grupo y oculta el inventario genérico', () => {
  const d = modulosVisibles(['pos', 'inventario', 'reposicion'], permisosDe('dueno')).map((m) => m.id);
  for (const id of ['rep_pesaje', 'rep_despacho', 'rep_produccion', 'rep_consumo', 'rep_costeo', 'rep_inventario', 'rep_incidencias', 'rep_mantenimiento', 'rep_tablero']) assert.ok(d.includes(id), id);
  assert.ok(!d.includes('inventario'));
  // roles de tienda: la cajera pesa y recibe; producción produce; bodega despacha
  assert.ok(modulosVisibles(['reposicion'], permisosDe('cajero')).map((m) => m.id).includes('rep_pesaje'));
  assert.ok(modulosVisibles(['reposicion'], permisosDe('produccion')).map((m) => m.id).includes('rep_produccion'));
  assert.ok(modulosVisibles(['reposicion'], permisosDe('bodega')).map((m) => m.id).includes('rep_despacho'));
  assert.ok(!modulosVisibles(['pos'], permisosDe('dueno')).some((m) => m.id.startsWith('rep_')));
});

test('gelato: cada rol entra a lo suyo y la noche cambia al mediodía (hora de Honduras)', async () => {
  const { inicioGelato, nocheDeTrabajo } = await import('../src/index.js');
  const vis = (rol) => modulosVisibles(['pos', 'reposicion'], permisosDe(rol));
  assert.equal(inicioGelato(vis('dueno'), permisosDe('dueno')), 'gelato');
  assert.equal(inicioGelato(vis('gerente'), permisosDe('gerente')), 'gelato');
  assert.equal(inicioGelato(vis('bodega'), permisosDe('bodega')), 'despacho');
  assert.equal(inicioGelato(vis('produccion'), permisosDe('produccion')), 'gelato-produccion');
  const noche = new Date('2026-10-09T02:00:00Z'), dia = new Date('2026-10-08T18:00:00Z');   // 8 p. m. y 12 m. en Honduras
  assert.equal(inicioGelato(vis('cajero'), permisosDe('cajero'), noche), 'pesaje');
  assert.equal(inicioGelato(vis('cajero'), permisosDe('cajero'), dia), null);   // de día entra a la caja
  assert.equal(inicioGelato(modulosVisibles(['reposicion'], permisosDe('cajero')), permisosDe('cajero'), dia), 'pesaje');   // sin POS, siempre pesaje
  assert.equal(inicioGelato(modulosVisibles(['pos'], permisosDe('cajero')), permisosDe('cajero')), null);
  // 09:00 HN = 15:00 UTC → anoche; 15:00 HN = 21:00 UTC → hoy
  assert.deepEqual(nocheDeTrabajo(new Date('2026-10-08T15:00:00Z')), { fecha: '2026-10-07', esHoy: false });
  assert.deepEqual(nocheDeTrabajo(new Date('2026-10-08T21:00:00Z')), { fecha: '2026-10-08', esHoy: true });
});

test('gelato: un pesaje después de medianoche lleva la fecha del día nuevo (hora de Honduras)', async () => {
  const { fechaHN } = await import('../src/index.js');
  assert.equal(fechaHN(new Date('2026-10-09T05:59:00Z')), '2026-10-08');   // 11:59 p. m.
  assert.equal(fechaHN(new Date('2026-10-09T06:01:00Z')), '2026-10-09');   // 12:01 a. m. = día nuevo
});
