import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datosBase, dia } from './fixtures.js';
import { VERIFICACIONES, ejecutarAuditoria, sintetizarPatrones, fechaHasta } from './auditoria.js';
import { crearHallazgo } from './nucleo.js';

const hallazgo = (verificacion, sucursal, extra = {}) => crearHallazgo({
  verificacion, area: 'tiendas', clave: sucursal || 'global', titulo: `${verificacion} ${sucursal}`, detalle: 'x',
  nivel: 'probable', gravedad: 'media', evidencia: ['a'], compuertas: [], descartado: [], accion: 'y',
  sucursal_id: sucursal, sucursal_nombre: sucursal ? sucursal.toUpperCase() : null, ...extra,
});

test('con la base vacía ninguna verificación se rompe, y el gerente dice que no pudo verificar en vez de "todo bien"', () => {
  const r = ejecutarAuditoria(datosBase());
  assert.equal(r.errores.length, 0, `se rompió: ${JSON.stringify(r.errores)}`);
  assert.equal(r.hallazgos.length, 0);
  assert.equal(r.resumen.verificaciones, VERIFICACIONES.length);
  assert.ok(r.resumen.sinDatos > 0, 'lo que no pudo mirar se cuenta aparte');
  assert.ok(r.sinDatos.every((s) => s.motivo), 'y cada una dice por qué');
});

test('una verificación que explota no tira abajo el informe: se reporta como error', () => {
  const rota = function verificacionRota() { throw new Error('se cayó'); };
  VERIFICACIONES.push(rota);
  try {
    const r = ejecutarAuditoria(datosBase());
    assert.equal(r.errores.length, 1);
    assert.equal(r.errores[0].mensaje, 'se cayó');
    assert.equal(r.resumen.conError, 1);
    assert.ok(r.resumen.verificaciones >= 2, 'las demás siguieron corriendo');
  } finally {
    VERIFICACIONES.pop();
  }
});

// ── cruce de hallazgos ────────────────────────────────────────────────────────────────────

test('lo mismo en 3 tiendas se lee como un problema común, no como 3 problemas', () => {
  const lista = ['mackey', 'proceres', 'peru'].map((t) => hallazgo('recepcion_diferencias', t));
  const p = sintetizarPatrones(lista, new Map([['recepcion_diferencias', 'Panas que no coinciden']]));
  assert.ok(p.some((x) => x.id === 'sistemico:recepcion_diferencias'));
  assert.match(p[0].detalle, /no está en cada una/);
});

test('lo mismo en solo 2 tiendas no es sistémico', () => {
  const p = sintetizarPatrones(['mackey', 'proceres'].map((t) => hallazgo('recepcion_diferencias', t)));
  assert.ok(!p.some((x) => x.id.startsWith('sistemico')));
});

test('tres problemas de tipos distintos en una tienda se ven como una historia', () => {
  const p = sintetizarPatrones([
    hallazgo('pesajes_faltantes', 'mackey'), hallazgo('marcaciones_incompletas', 'mackey'), hallazgo('recepcion_diferencias', 'mackey'),
  ]);
  const c = p.find((x) => x.id === 'concentra:mackey');
  assert.ok(c);
  assert.match(c.titulo, /3 problemas de tipos distintos/);
});

test('el mismo tipo de problema repetido tres veces en una tienda NO cuenta como "tipos distintos"', () => {
  const p = sintetizarPatrones([hallazgo('pesajes_faltantes', 'mackey', { clave: 'a' }), hallazgo('pesajes_faltantes', 'mackey', { clave: 'b' }), hallazgo('pesajes_faltantes', 'mackey', { clave: 'c' })]);
  assert.ok(!p.some((x) => x.id.startsWith('concentra')));
});

test('un problema de pesajes en una tienda NO genera el aviso de "no te fíes de las sugerencias"', () => {
  const p = sintetizarPatrones([hallazgo('pesaje_copiado', 'mackey')]);
  assert.equal(p.length, 0);
});

test('lo que está solo "para observar" no se usa para armar historias', () => {
  const p = sintetizarPatrones([
    hallazgo('pesajes_faltantes', 'mackey', { nivel: 'observar' }), hallazgo('marcaciones_incompletas', 'mackey', { nivel: 'observar' }), hallazgo('recepcion_diferencias', 'mackey', { nivel: 'observar' }),
  ]);
  assert.equal(p.length, 0);
});

// ── descartes y orden ──────────────────────────────────────────────────────────────────────

function conKardexRoto() {
  return datosBase({
    insumos: [{ id: 1, nombre: 'BASE', tipo: 'local', unidad: 'u', stock_actual: 14, es_equipo: 0 }],
    movimientos: [{ id: 1, insumo_id: 1, tipo: 'entrada', cantidad: 10, saldo_resultante: 10, creado_en: `${dia(-3)} 10:00:00` }],
  });
}

test('un hallazgo descartado por el dueño se oculta, pero queda a la vista con su nota', () => {
  const sinDescartar = ejecutarAuditoria(conKardexRoto());
  const huella = sinDescartar.hallazgos.find((h) => h.verificacion === 'kardex_integridad').huella;

  const r = ejecutarAuditoria(conKardexRoto(), { descartes: [{ huella, estado: 'no_es_problema', nota: 'ya lo contamos', hasta: dia(30) }] });
  assert.ok(!r.hallazgos.some((h) => h.huella === huella));
  assert.equal(r.descartados.length, 1);
  assert.equal(r.descartados[0].descarte.nota, 'ya lo contamos');
  assert.equal(r.resumen.descartadosPorElDueno, 1);
});

test('un descarte vencido no oculta nada: si sigue pasando, el gerente vuelve a decirlo', () => {
  const huella = ejecutarAuditoria(conKardexRoto()).hallazgos.find((h) => h.verificacion === 'kardex_integridad').huella;
  const r = ejecutarAuditoria(conKardexRoto(), { descartes: [{ huella, estado: 'visto', nota: null, hasta: dia(-1) }] });
  assert.ok(r.hallazgos.some((h) => h.huella === huella));
});

test('"lo vi" dura una semana y "no es un problema" dos meses', () => {
  assert.equal(fechaHasta('visto', '2026-10-02'), '2026-10-09');
  assert.equal(fechaHasta('no_es_problema', '2026-10-02'), '2026-12-01');
});

test('los confirmados van antes que los probables, y los graves antes que los leves', () => {
  const r = ejecutarAuditoria(datosBase({
    insumos: [{ id: 1, nombre: 'BASE', tipo: 'local', unidad: 'u', stock_actual: 14, es_equipo: 0 }, { id: 2, nombre: 'SIN PRECIO', tipo: 'local', unidad: 'u', stock_actual: 5, es_equipo: 0 }],
    movimientos: [{ id: 1, insumo_id: 1, tipo: 'entrada', cantidad: 10, saldo_resultante: 10, creado_en: `${dia(-3)} 10:00:00` }],
  }));
  const niveles = r.hallazgos.map((h) => h.nivel);
  const ordenados = [...niveles].sort((a, b) => ({ confirmado: 0, probable: 1 }[a] - { confirmado: 0, probable: 1 }[b]));
  assert.deepEqual(niveles, ordenados);
});

test('todo hallazgo trae lo que el dueño necesita para creerle: evidencia, compuertas, lo descartado y qué hacer', () => {
  const r = ejecutarAuditoria(conKardexRoto());
  for (const h of [...r.hallazgos, ...r.observar]) {
    assert.ok(h.evidencia.length > 0, `${h.huella} sin evidencia`);
    assert.ok(h.compuertas.length > 0, `${h.huella} sin compuertas`);
    assert.ok(h.accion, `${h.huella} sin acción`);
    assert.ok(h.compuertas.filter((c) => c.requerida).every((c) => c.ok), `${h.huella} salió con una compuerta requerida sin pasar`);
  }
});

test('registros viejos sin cerrar en varias tiendas NO arman un patrón ni cuentan como hallazgo: van aparte, "por ordenar"', () => {
  const tiendas = ['mackey', 'proceres', 'peru', 'diez-calle'];
  const base = datosBase();
  const r = ejecutarAuditoria(datosBase({
    sucursales: [...base.sucursales, { id: 'peru', nombre: 'Perú', activa: 1, rol: 'sucursal' }, { id: 'diez-calle', nombre: '10 Calle', activa: 1, rol: 'sucursal' }],
    mantenimientos: tiendas.map((t, i) => ({ id: i + 1, equipo: 'Freezer', sucursal_id: t, fecha: dia(-40), listo: 0 })),
    pedidos: tiendas.map((t, i) => ({ id: i + 1, sucursal_id: t, fecha: dia(-32), estado: 'pedido', items: [] })),
  }));
  assert.equal(r.patrones.length, 0);
  assert.ok(!r.hallazgos.some((h) => ['mantenimiento_pendiente', 'pedidos_insumos_atrasados'].includes(h.verificacion)));
  assert.equal(r.limpieza.length, 2);
  assert.equal(r.resumen.porOrdenar, 8);
});
