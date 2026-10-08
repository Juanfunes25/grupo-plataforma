import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datosBase, dia } from '../fixtures.js';
import { kardexIntegridad, stockSeAcaba, preciosDudosos, pedidosAtrasados, lotesPorVencer } from './inventario.js';

const insumo = (extra) => ({ id: 1, nombre: 'BASE LECHE', tipo: 'local', unidad: 'unidad', stock_actual: 10, es_equipo: 0, ...extra });
const mov = (extra) => ({ id: 1, insumo_id: 1, tipo: 'entrada', cantidad: 10, saldo_resultante: 10, creado_en: `${dia(-5)} 12:00:00`, ...extra });

test('si el stock mostrado no es el último saldo del kardex, lo reporta como hecho', () => {
  const r = kardexIntegridad(datosBase({
    insumos: [insumo({ stock_actual: 14 })],
    movimientos: [mov({ id: 1, saldo_resultante: 10 }), mov({ id: 2, tipo: 'salida', cantidad: 2, saldo_resultante: 8 })],
  }));
  assert.equal(r.hallazgos.length, 1);
  assert.equal(r.hallazgos[0].nivel, 'confirmado');
  assert.match(r.hallazgos[0].evidencia[0], /muestra 14/);
});

test('cuando todo cuadra no dice nada', () => {
  const r = kardexIntegridad(datosBase({
    insumos: [insumo({ stock_actual: 8 })],
    movimientos: [mov({ id: 1, saldo_resultante: 10 }), mov({ id: 2, tipo: 'salida', cantidad: 2, saldo_resultante: 8 })],
  }));
  assert.equal(r.hallazgos.length, 0);
  assert.equal(r.estado, 'ok');
});

test('detecta un salto en la cadena aunque el final coincida', () => {
  const r = kardexIntegridad(datosBase({
    insumos: [insumo({ stock_actual: 8 })],
    // 10 - 2 debería dar 8, pero el movimiento dice que quedó en 7.
    movimientos: [mov({ id: 1, saldo_resultante: 10 }), mov({ id: 2, tipo: 'salida', cantidad: 2, saldo_resultante: 7 }), mov({ id: 3, tipo: 'entrada', cantidad: 1, saldo_resultante: 8 })],
  }));
  assert.equal(r.hallazgos.length, 1);
});

test('el redondeo normal no cuenta como diferencia', () => {
  const r = kardexIntegridad(datosBase({
    insumos: [insumo({ stock_actual: 8.01 })],
    movimientos: [mov({ id: 1, saldo_resultante: 10 }), mov({ id: 2, tipo: 'salida', cantidad: 2, saldo_resultante: 8 })],
  }));
  assert.equal(r.hallazgos.length, 0);
});

test('los equipos no se auditan: no se consumen', () => {
  const r = kardexIntegridad(datosBase({
    insumos: [insumo({ stock_actual: 99, es_equipo: 1 })],
    movimientos: [mov({ saldo_resultante: 10 })],
  }));
  assert.equal(r.estado, 'sin_datos');
});

// ── se acaba ───────────────────────────────────────────────────────────────────────────────

function salidas(insumoId, cantidad, cada, cuantas = 8) {
  return Array.from({ length: cuantas }, (_, i) => mov({ id: 100 + i, insumo_id: insumoId, tipo: 'salida', cantidad, saldo_resultante: 0, creado_en: `${dia(-1 - i * cada)} 10:00:00` }));
}

test('un insumo local que alcanza 2 días al ritmo actual se reporta', () => {
  // 8 salidas de 4 en 28 días = 1.14/día; con 2 de stock alcanza ~1.75 días.
  const r = stockSeAcaba(datosBase({ insumos: [insumo({ stock_actual: 2 })], movimientos: salidas(1, 4, 3) }));
  assert.equal(r.hallazgos.length, 1);
  assert.match(r.hallazgos[0].evidencia[0], /alcanza ~2/);
});

test('con stock de sobra no avisa', () => {
  const r = stockSeAcaba(datosBase({ insumos: [insumo({ stock_actual: 400 })], movimientos: salidas(1, 4, 3) }));
  assert.equal(r.hallazgos.length, 0);
});

test('un insumo que ya se acabó y se sigue usando queda confirmado', () => {
  const r = stockSeAcaba(datosBase({ insumos: [insumo({ stock_actual: 0 })], movimientos: salidas(1, 4, 3) }));
  assert.equal(r.hallazgos[0].nivel, 'confirmado');
});

test('un insumo que dejó de usarse hace un mes no tiene ritmo que valga', () => {
  const viejas = Array.from({ length: 6 }, (_, i) => mov({ id: 200 + i, tipo: 'salida', cantidad: 5, saldo_resultante: 0, creado_en: `${dia(-27 + i)} 10:00:00` }));
  const r = stockSeAcaba(datosBase({ insumos: [insumo({ stock_actual: 1 })], movimientos: viejas }));
  assert.equal(r.hallazgos.length, 0);
});

test('una sola salida no es un ritmo: no inventa uno', () => {
  const r = stockSeAcaba(datosBase({ insumos: [insumo({ stock_actual: 1 })], movimientos: salidas(1, 50, 1, 2) }));
  assert.equal(r.estado, 'sin_datos');
});

test('un insumo de Mec3 se mide contra 21 días de reposición, no contra 7', () => {
  // Alcanza ~14 días: de sobra para uno local, justo para uno que viene de afuera.
  const datos = (tipo) => datosBase({ insumos: [insumo({ stock_actual: 16, tipo })], movimientos: salidas(1, 4, 3) });
  assert.equal(stockSeAcaba(datos('local')).hallazgos.length, 0);
  assert.equal(stockSeAcaba(datos('mec3')).hallazgos.length, 1);
});

// ── precios ────────────────────────────────────────────────────────────────────────────────

const precio = (insumoId, lps, fecha, id) => ({ id, insumo_id: insumoId, lps_kg: lps, fecha_vigencia: fecha });

test('un precio que cambió exactamente ×10 se marca como error de dígitos', () => {
  const r = preciosDudosos(datosBase({
    insumos: [insumo()],
    precios: [precio(1, 52, '2026-06-01', 1), precio(1, 520, '2026-09-01', 2)],
  }));
  const salto = r.hallazgos.find((h) => /de golpe/.test(h.titulo));
  assert.equal(salto.nivel, 'confirmado');
  assert.match(salto.detalle, /cero de más/);
});

test('un aumento normal de 8% no se marca', () => {
  const r = preciosDudosos(datosBase({
    insumos: [insumo()],
    precios: [precio(1, 100, '2026-06-01', 1), precio(1, 108, '2026-09-01', 2)],
  }));
  assert.equal(r.hallazgos.length, 0);
});

test('un insumo con stock y sin precio se reporta; uno sin stock no importa', () => {
  const r = preciosDudosos(datosBase({ insumos: [insumo({ id: 1, stock_actual: 5 }), insumo({ id: 2, nombre: 'OTRO', stock_actual: 0 })] }));
  assert.equal(r.hallazgos.length, 1);
  assert.match(r.hallazgos[0].titulo, /1 insumo con stock y sin precio/);
});

test('un precio de Mec3 de hace un año queda para observar, no como alerta', () => {
  const r = preciosDudosos(datosBase({
    insumos: [insumo({ tipo: 'mec3' })],
    precios: [precio(1, 100, dia(-400), 1)],
  }));
  assert.equal(r.hallazgos[0].nivel, 'observar');
});

// ── pedidos de insumos ─────────────────────────────────────────────────────────────────────

test('un pedido de insumos que nadie tocó NO es alarma (no todos se envían); uno ya armado que no salió, sí', () => {
  const pedido = (fecha, estado, id = Math.random()) => ({ id, sucursal_id: 'mackey', fecha, estado, items: [{ preparado: 0 }] });
  assert.equal(pedidosAtrasados(datosBase({ pedidos: [pedido(dia(-4), 'pedido')] })).hallazgos.length, 0);
  assert.equal(pedidosAtrasados(datosBase({ pedidos: [pedido(dia(-4), 'recibido')] })).hallazgos.length, 0);
  const armado = pedidosAtrasados(datosBase({ pedidos: [pedido(dia(-4), 'preparado')] }));
  assert.equal(armado.hallazgos.length, 1);
  assert.equal(armado.hallazgos[0].nivel, 'probable', 'puede haberse entregado en mano');
  assert.equal(pedidosAtrasados(datosBase({ pedidos: [pedido(dia(-1), 'preparado')] })).hallazgos.length, 0);
});

test('los pedidos de insumos abiertos hace más de una semana se juntan como "por ordenar"', () => {
  const pedido = (fecha, estado, id) => ({ id, sucursal_id: 'mackey', fecha, estado, items: [] });
  const r = pedidosAtrasados(datosBase({ pedidos: [pedido(dia(-32), 'pedido', 1), pedido(dia(-9), 'pedido', 2), pedido(dia(-20), 'preparado', 3), pedido(dia(-3), 'pedido', 4)] }));
  assert.equal(r.hallazgos.length, 0);
  assert.equal(r.limpieza[0].cantidad, 3, 'el de 3 días no cuenta: todavía es normal');
  assert.equal(r.limpieza[0].mas_vieja_dias, 32);
});

// ── lotes ──────────────────────────────────────────────────────────────────────────────────

test('un lote que vence en 10 días con más producto del que se alcanza a gastar se reporta', () => {
  const lote = { id: 1, insumo_id: 1, insumo_nombre: 'BASE', unidad: 'kg', cantidad_restante: 50, fecha_ingreso: dia(-60), fecha_vencimiento: dia(10) };
  const r = lotesPorVencer(datosBase({ lotes: [lote], movimientos: salidas(1, 5, 3) }));
  assert.equal(r.hallazgos.length, 1);
  assert.equal(r.hallazgos[0].nivel, 'confirmado', 'vence en menos de 14 días');
});

test('un lote que se alcanza a gastar antes de vencer no es un problema', () => {
  const lote = { id: 1, insumo_id: 1, insumo_nombre: 'BASE', unidad: 'kg', cantidad_restante: 5, fecha_ingreso: dia(-60), fecha_vencimiento: dia(60) };
  const r = lotesPorVencer(datosBase({ lotes: [lote], movimientos: salidas(1, 5, 3) }));
  assert.equal(r.hallazgos.length, 0);
});
