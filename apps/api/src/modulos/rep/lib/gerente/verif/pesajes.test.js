import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datosBase, dia, pesajesDe, despacho, ruido } from '../fixtures.js';
import { pesajeSubeSinEntrada, pesajeCopiado, pesajeAtipico, pesajesFaltantes } from './pesajes.js';

/** Una vitrina que baja de a poco y se repone: peso con algo de variación natural. */
const natural = (base, semilla) => (o) => Math.round(base + (ruido(o + semilla) - 0.5) * 600);

test('la vitrina que sube sin despacho, repetido en varias noches, se reporta', () => {
  const datos = datosBase({
    pesajes: [
      ...pesajesDe('mackey', 1, -20, -1, (o) => (o % 4 === 0 ? 4500 : 2000 + (o % 3) * 100)),
      ...pesajesDe('mackey', 2, -20, -1, (o) => (o % 5 === 0 ? 4800 : 1500 + (o % 3) * 100)),
    ],
  });
  const r = pesajeSubeSinEntrada(datos);
  assert.equal(r.estado, 'hallazgos');
  assert.equal(r.hallazgos[0].sucursal_id, 'mackey');
  assert.ok(r.hallazgos[0].compuertas.every((c) => c.ok || !c.requerida), 'las requeridas pasaron todas');
  assert.ok(r.hallazgos[0].descartado.length > 0, 'dice qué explicaciones descartó');
});

test('si hay un despacho que lo explica, no dice nada', () => {
  const pesajes = pesajesDe('mackey', 1, -20, -1, (o) => (o % 4 === 0 ? 4500 : 2000));
  // Un despacho en cada noche en que sube.
  const despachos = [];
  // La tienda pidió la noche anterior y el gelato llegó en la mañana de la noche que sube.
  for (let o = -20; o <= -1; o++) if (o % 4 === 0) despachos.push(despacho({ fecha: dia(o - 1), enviado_en: dia(o), sucursal_id: 'mackey', sabor_id: 1 }));
  const r = pesajeSubeSinEntrada(datosBase({ pesajes, despachos }));
  assert.equal(r.hallazgos.length, 0);
});

test('una subida suelta es ruido de balanza, no un hallazgo', () => {
  const pesajes = pesajesDe('mackey', 1, -20, -1, (o) => (o === -7 ? 4500 : 2000));
  const r = pesajeSubeSinEntrada(datosBase({ pesajes }));
  assert.equal(r.hallazgos.length, 0);
  assert.ok(r.ruido >= 1, 'pero se cuenta como ruido descartado');
});

test('Los Andes no se audita contra despachos: no registra ninguno por diseño', () => {
  const pesajes = pesajesDe('los-andes', 1, -20, -1, (o) => (o % 4 === 0 ? 4500 : 2000));
  const r = pesajeSubeSinEntrada(datosBase({ pesajes }));
  assert.equal(r.hallazgos.length, 0);
});

test('una tienda cerrada no genera hallazgos', () => {
  const pesajes = pesajesDe('progreso', 1, -20, -1, (o) => (o % 4 === 0 ? 4500 : 2000));
  assert.equal(pesajeSubeSinEntrada(datosBase({ pesajes })).hallazgos.length, 0);
});

test('con la corroboración (varios sabores) sube a confirmado; con un solo sabor queda probable', () => {
  const dos = datosBase({
    pesajes: [
      ...pesajesDe('mackey', 1, -20, -1, (o) => (o % 4 === 0 ? 4500 : 2000)),
      ...pesajesDe('mackey', 2, -20, -1, (o) => (o % 4 === 0 ? 4400 : 1900)),
    ],
  });
  const uno = datosBase({ pesajes: pesajesDe('mackey', 1, -20, -1, (o) => (o % 4 === 0 ? 4500 : 2000)) });
  assert.equal(pesajeSubeSinEntrada(dos).hallazgos[0].nivel, 'confirmado');
  assert.equal(pesajeSubeSinEntrada(uno).hallazgos[0].nivel, 'probable');
});

test('sin noches seguidas dice que no pudo verificar, no que está todo bien', () => {
  const r = pesajeSubeSinEntrada(datosBase());
  assert.equal(r.estado, 'sin_datos');
  assert.ok(r.motivoSinDatos);
});

// ── pesaje copiado ──────────────────────────────────────────────────────────────────────

function tiendaVariada(sucursal = 'mackey') {
  // 3 sabores con pesos que cambian cada noche: la base de la tienda "no repite".
  return [1, 2, 3].flatMap((s) => pesajesDe(sucursal, s, -30, -1, natural(1800 + s * 300, s * 7)));
}

test('un sabor con el mismo peso al gramo 5 noches, en una tienda que no repite, se reporta', () => {
  const copiado = pesajesDe('mackey', 1, -30, -1, (o) => (o >= -10 && o <= -6 ? 2400 : natural(2000, 3)(o)));
  const datos = datosBase({ pesajes: [...copiado, ...pesajesDe('mackey', 2, -30, -1, natural(2100, 11)), ...pesajesDe('mackey', 3, -30, -1, natural(2700, 5))] });
  const r = pesajeCopiado(datos);
  assert.equal(r.hallazgos.length, 1);
  assert.match(r.hallazgos[0].evidencia[0], /5 noches/);
});

test('si la balanza redondea y todos los pesos se repiten, no acusa a nadie', () => {
  // Todo en múltiplos de 500: repetir es lo normal en esta tienda.
  const redondo = [1, 2, 3].flatMap((s) => pesajesDe('mackey', s, -30, -1, (o) => 1500 + 500 * (Math.floor(o / 4) % 2)));
  const r = pesajeCopiado(datosBase({ pesajes: redondo }));
  assert.equal(r.hallazgos.length, 0);
});

test('sin historial suficiente no puede distinguir copia de redondeo y lo dice', () => {
  const r = pesajeCopiado(datosBase({ pesajes: pesajesDe('mackey', 1, -5, -1, () => 2400) }));
  assert.equal(r.estado, 'sin_datos');
});

test('si llegó un despacho en medio de la racha y el peso no cambió, queda confirmado', () => {
  const copiado = pesajesDe('mackey', 1, -30, -1, (o) => (o >= -10 && o <= -6 ? 2400 : natural(2000, 3)(o)));
  const datos = datosBase({
    pesajes: [...copiado, ...pesajesDe('mackey', 2, -30, -1, natural(2100, 11)), ...pesajesDe('mackey', 3, -30, -1, natural(2700, 5))],
    despachos: [despacho({ fecha: dia(-9), enviado_en: dia(-8), sucursal_id: 'mackey', sabor_id: 1 })],
  });
  assert.equal(pesajeCopiado(datos).hallazgos[0].nivel, 'confirmado');
});

// ── pesaje atípico ──────────────────────────────────────────────────────────────────────

test('un 24 kg donde siempre hay 2.4 y a la noche siguiente vuelve a lo normal es un error de tipeo', () => {
  const pesajes = pesajesDe('mackey', 1, -20, -1, (o) => (o === -5 ? 24000 : 2400 + (o % 3) * 50));
  const r = pesajeAtipico(datosBase({ pesajes }));
  assert.equal(r.hallazgos.length, 1);
  assert.equal(r.hallazgos[0].nivel, 'confirmado');
});

test('un salto que se queda arriba no se llama error: quizá cambió de verdad', () => {
  const pesajes = pesajesDe('mackey', 1, -20, -1, (o) => (o >= -5 ? 12000 : 2400));
  assert.equal(pesajeAtipico(datosBase({ pesajes })).hallazgos.length, 0);
});

test('un peso muy bajo NO es un error: 0.3 kg cuando lo normal es 2.1 es un sabor casi acabado', () => {
  for (const [bajo, normal] of [[300, 2100], [400, 2900]]) {
    const pesajes = pesajesDe('mackey', 1, -20, -1, (o) => (o === -5 ? bajo : normal + (o % 3) * 50));
    assert.equal(pesajeAtipico(datosBase({ pesajes })).hallazgos.length, 0, `${bajo} g contra ${normal} g`);
  }
});

test('con pocas noches no hay forma de saber qué es normal', () => {
  const r = pesajeAtipico(datosBase({ pesajes: pesajesDe('mackey', 1, -4, -1, () => 2400) }));
  assert.equal(r.estado, 'sin_datos');
});

// ── noches sin pesar ───────────────────────────────────────────────────────────────────

function tiendaCompleta() {
  return [1, 2, 3].flatMap((s) => pesajesDe('mackey', s, -28, -15, natural(2000 + s * 100, s)));
}

test('noches en que la tienda trabajó pero pesó casi nada se reportan', () => {
  // Pesaje completo los días -28..-15; después solo un sabor, con marcaciones cada día.
  const flojos = pesajesDe('mackey', 1, -14, -1, natural(2000, 9));
  const marcaciones = [];
  for (let o = -14; o <= -1; o++) marcaciones.push({ empleado_id: 1, sucursal_id: 'mackey', fecha: dia(o), tipo: 'entrada' });
  const r = pesajesFaltantes(datosBase({ pesajes: [...tiendaCompleta(), ...flojos], marcaciones }));
  assert.equal(r.hallazgos.length, 1);
  assert.match(r.hallazgos[0].descartado[0], /no eran días cerrados/i);
});

test('si la tienda no trabajó esos días (sin marcaciones ni despachos) no se acusa a nadie', () => {
  const flojos = pesajesDe('mackey', 1, -14, -1, natural(2000, 9));
  const r = pesajesFaltantes(datosBase({ pesajes: [...tiendaCompleta(), ...flojos] }));
  assert.equal(r.hallazgos.length, 0);
});

test('la noche de hoy no cuenta: todavía no es hora de pesar', () => {
  const marcaciones = [{ empleado_id: 1, sucursal_id: 'mackey', fecha: dia(0), tipo: 'entrada' }];
  const r = pesajesFaltantes(datosBase({ pesajes: tiendaCompleta(), marcaciones }));
  assert.equal(r.hallazgos.length, 0);
});
