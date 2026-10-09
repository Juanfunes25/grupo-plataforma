import test from 'node:test';
import assert from 'node:assert/strict';
import { accesosApp, moduloInicio, modulosVisibles, permisosDe, fechaDMA, fechaHoraDMA } from '../src/index.js';

const MEDIODIA = new Date('2026-10-09T18:00:00Z'); // 12:00 p. m. en Honduras
const accesosDe = (empresaModulos, rol, ahora = MEDIODIA) => accesosApp(modulosVisibles(empresaModulos, permisosDe(rol)), permisosDe(rol), ahora).map((a) => a.nombre);

test('barra inferior: el primer acceso es el inicio del rol y no se repite ninguno', () => {
  assert.deepEqual(accesosDe(['pos', 'antifraude'], 'cajero'), ['Facturar', 'Facturas']);
  assert.deepEqual(accesosDe(['pos', 'antifraude'], 'dueno'), ['Facturar', 'Alertas', 'Números', 'Cierre']);
  assert.deepEqual(accesosDe(['fabrica'], 'produccion').slice(0, 3), ['Inicio', 'Producción', 'Órdenes']);
  assert.deepEqual(accesosDe(['distribuidora'], 'gestor'), ['Salidas', 'Inventario']);
  for (const rol of ['dueno', 'admin', 'gerente', 'cajero', 'pesaje', 'produccion', 'prod_despacho', 'bodega', 'gestor', 'ventas', 'contador', 'solo_lectura']) {
    const n = accesosDe(['pos', 'reposicion', 'antifraude', 'fabrica', 'distribuidora', 'inventario'], rol);
    assert.ok(n.length >= 1 && n.length <= 4, rol);
    assert.equal(new Set(n).size, n.length, `${rol} sin repetidos`);
  }
});

test('barra inferior: Italo entra por el despacho (tablero en pausa), la tienda por la caja de día y por el pesaje de noche', () => {
  assert.equal(accesosDe(['pos', 'reposicion', 'antifraude'], 'dueno')[0], 'Despacho');
  assert.equal(accesosDe(['pos', 'reposicion'], 'cajero', MEDIODIA)[0], 'Facturar');
  assert.equal(accesosDe(['pos', 'reposicion'], 'cajero', new Date('2026-10-10T02:00:00Z'))[0], 'Facturar'); // la cajera nunca entra al pesaje
  assert.equal(accesosDe(['pos', 'reposicion'], 'pesaje', MEDIODIA)[0], 'Pesaje');   // el perfil de pesaje entra directo
});

test('barra inferior: las alertas llevan su marca y todo acceso tiene ruta e ícono', () => {
  const t = accesosApp(modulosVisibles(['pos', 'antifraude'], permisosDe('dueno')), permisosDe('dueno'), MEDIODIA);
  assert.equal(t.find((x) => x.alertas)?.id, 'antifraude');
  assert.ok(t.every((x) => typeof x.ruta === 'string' && x.icono));
  assert.equal(moduloInicio([], new Set()), null);
  assert.equal(accesosApp([], new Set())[0].nombre, 'Inicio');
});

test('fechas de Honduras: dd/mm/aaaa y hora de 12 h con la zona de Honduras', () => {
  assert.equal(fechaDMA('2026-10-09'), '09/10/2026');
  assert.equal(fechaDMA('2026-10-09T05:30:00Z'), '08/10/2026'); // 11:30 p. m. del día 8 en Honduras
  assert.equal(fechaDMA(null), '');
  assert.match(fechaHoraDMA('2026-10-09T18:15:00Z'), /^09\/10\/2026 12:15/);
});
