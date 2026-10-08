import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datosBase, dia } from '../fixtures.js';
import { desviacionReceta, camaraEnvejecida, produccionSinConsumo } from './fabrica.js';

function consumos(saborId, insumoId, desviaciones, nombre = 'PASTA PISTACHO') {
  return desviaciones.map((d, i) => ({
    produccion_id: 1000 * saborId + i, sabor_id: saborId, insumo_id: insumoId, insumo_nombre: nombre,
    cantidad_sugerida: 10, cantidad_real: 10 + (10 * d) / 100,
  }));
}

test('una receta que se pasa 20% casi siempre, en 6 tandas, se reporta', () => {
  const r = desviacionReceta(datosBase({ consumos: consumos(1, 7, [20, 18, 22, 19, 21, 20]) }));
  assert.equal(r.hallazgos.length, 1);
  assert.match(r.hallazgos[0].titulo, /más PASTA PISTACHO/);
  assert.equal(r.hallazgos[0].nivel, 'probable', 'sin el segundo sabor, falta la corroboración');
});

test('si el mismo insumo se pasa en otro sabor, sube a confirmado y apunta al insumo', () => {
  const todos = [...consumos(1, 7, [20, 18, 22, 19, 21, 20]), ...consumos(2, 7, [22, 20, 19, 21, 18, 20])];
  const r = desviacionReceta(datosBase({ consumos: todos }));
  assert.equal(r.hallazgos.length, 2);
  assert.equal(r.hallazgos[0].nivel, 'confirmado');
  assert.match(r.hallazgos[0].accion, /revisá ese insumo/);
});

test('si unas tandas sobran y otras faltan es variación normal, no un hallazgo', () => {
  const r = desviacionReceta(datosBase({ consumos: consumos(1, 7, [25, -22, 24, -26, 23, -25]) }));
  assert.equal(r.hallazgos.length, 0);
  assert.ok(r.ruido >= 0);
});

test('una desviación chica (8%) no alcanza aunque sea constante', () => {
  const r = desviacionReceta(datosBase({ consumos: consumos(1, 7, [8, 7, 9, 8, 8, 7]) }));
  assert.equal(r.hallazgos.length, 0);
});

test('con menos de 4 tandas no compara', () => {
  const r = desviacionReceta(datosBase({ consumos: consumos(1, 7, [30, 31, 29]) }));
  assert.equal(r.hallazgos.length, 0);
});

test('un consumo menor al de la receta se explica distinto: sobra o se omite un ingrediente', () => {
  const r = desviacionReceta(datosBase({ consumos: consumos(1, 7, [-30, -28, -32, -29, -31, -30]) }));
  assert.match(r.hallazgos[0].titulo, /menos/);
  assert.match(r.hallazgos[0].accion, /omitiendo|sobrestimado/);
});

// ── cámara ─────────────────────────────────────────────────────────────────────────────────

const tanda = (extra) => ({ id: 1, fecha: dia(-30), sabor_id: 1, kg: 12, kg_restante: 5, lote: 'L-100', operario: '', ...extra });

test('una tanda de hace 30 días con 5 kg de saldo se reporta como probable, no como un hecho', () => {
  const r = camaraEnvejecida(datosBase({ producciones: [tanda()] }));
  assert.equal(r.hallazgos.length, 1);
  assert.equal(r.hallazgos[0].nivel, 'probable');
  assert.match(r.hallazgos[0].accion, /Mirá la cámara/);
});

test('una tanda reciente con saldo es lo normal', () => {
  assert.equal(camaraEnvejecida(datosBase({ producciones: [tanda({ fecha: dia(-5) })] })).hallazgos.length, 0);
});

test('un saldo de migas (menos del 25% de la tanda) no cuenta', () => {
  assert.equal(camaraEnvejecida(datosBase({ producciones: [tanda({ kg_restante: 1.2 })] })).hallazgos.length, 0);
});

test('una tanda vieja sin saldo está bien: se vendió', () => {
  assert.equal(camaraEnvejecida(datosBase({ producciones: [tanda({ kg_restante: 0 })] })).hallazgos.length, 0);
});

// ── tandas sin consumo ─────────────────────────────────────────────────────────────────────

function tandas(n, conConsumo) {
  const producciones = [];
  const registros = [];
  for (let i = 0; i < n; i++) {
    producciones.push({ id: i + 1, fecha: dia(-n + i), sabor_id: (i % 3) + 1, kg: 10, kg_restante: 0, lote: `L${i}`, operario: '' });
    if (conConsumo(i)) registros.push({ produccion_id: i + 1, sabor_id: (i % 3) + 1, insumo_id: 1, insumo_nombre: 'X', cantidad_sugerida: 1, cantidad_real: 1 });
  }
  return { producciones, consumos: registros };
}

test('si casi todas registran su consumo y 4 no, esas 4 se reportan', () => {
  const r = produccionSinConsumo(datosBase(tandas(20, (i) => i % 5 !== 0)));
  assert.equal(r.hallazgos.length, 1);
  assert.match(r.hallazgos[0].titulo, /4 tandas/);
});

test('si casi nadie registra consumo, no critica algo que no se practica', () => {
  const r = produccionSinConsumo(datosBase(tandas(20, (i) => i === 0)));
  assert.equal(r.estado, 'sin_datos');
});

test('con una o dos tandas sin consumo todavía no es un patrón', () => {
  const r = produccionSinConsumo(datosBase(tandas(20, (i) => i !== 3 && i !== 9)));
  assert.equal(r.hallazgos.length, 0);
});
