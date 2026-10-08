import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datosBase, dia, despacho } from '../fixtures.js';
import { recepcionDiferencias, despachosSinCerrar, despachosSinTrazabilidad } from './despachos.js';

/** n recepciones de una tienda, una por día, de las cuales `malas` llegan con diferencia. */
function recepciones(sucursal, n, diferencias) {
  const lista = [];
  for (let i = 0; i < n; i++) {
    const o = -n + i;
    const dif = diferencias(i);
    lista.push(despacho({
      fecha: dia(o), enviado_en: dia(o + 1), sucursal_id: sucursal, sabor_id: (i % 3) + 1,
      panas: 4, gramos_enviados: 12000, panas_recibidas: 4 + dif, discrepancia: dif ? 1 : 0,
    }));
  }
  return lista;
}

test('si en una tienda faltan panas casi siempre, y siempre del mismo lado, lo reporta', () => {
  const despachos = recepciones('mackey', 20, (i) => (i % 3 === 0 ? -1 : 0));
  const r = recepcionDiferencias(datosBase({ despachos }));
  assert.equal(r.hallazgos.length, 1);
  assert.match(r.hallazgos[0].titulo, /faltan panas/);
  assert.ok(r.hallazgos[0].compuertas.some((c) => /mismo lado/.test(c.texto)));
});

test('diferencias que caen para cualquier lado son errores de conteo, no un patrón', () => {
  const despachos = recepciones('mackey', 20, (i) => (i % 4 === 0 ? 1 : i % 4 === 1 ? -1 : 0));
  assert.equal(recepcionDiferencias(datosBase({ despachos })).hallazgos.length, 0);
});

test('un par de diferencias sueltas en muchas recepciones no alcanza', () => {
  const despachos = recepciones('mackey', 20, (i) => (i === 3 || i === 11 ? -1 : 0));
  const r = recepcionDiferencias(datosBase({ despachos }));
  assert.equal(r.hallazgos.length, 0);
  assert.ok(r.ruido >= 2);
});

test('si solo pasa en esa tienda queda confirmado; si pasa en todas, queda probable', () => {
  const sola = [...recepciones('mackey', 20, (i) => (i % 3 === 0 ? -1 : 0)), ...recepciones('proceres', 20, () => 0)];
  const todas = [...recepciones('mackey', 20, (i) => (i % 3 === 0 ? -1 : 0)), ...recepciones('proceres', 20, (i) => (i % 3 === 0 ? -1 : 0))];
  assert.equal(recepcionDiferencias(datosBase({ despachos: sola })).hallazgos[0].nivel, 'confirmado');
  assert.equal(recepcionDiferencias(datosBase({ despachos: todas })).hallazgos[0].nivel, 'probable');
});

test('con pocas recepciones no se atreve a opinar', () => {
  const r = recepcionDiferencias(datosBase({ despachos: recepciones('mackey', 5, () => -1) }));
  assert.equal(r.estado, 'sin_datos');
});

test('no audita a Los Andes, que no recibe despachos registrados', () => {
  const r = recepcionDiferencias(datosBase({ despachos: recepciones('los-andes', 20, () => -1) }));
  assert.equal(r.hallazgos.length, 0);
});

// ── despachos a medias ─────────────────────────────────────────────────────────────────────

test('un despacho enviado hace 3 días sin confirmar se reporta; si la tienda confirmó otros, se sugiere que se olvidaron', () => {
  const despachos = [
    despacho({ fecha: dia(-4), enviado_en: dia(-3), estado: 'enviado', panas_recibidas: null }),
    despacho({ fecha: dia(-2), enviado_en: dia(-1), estado: 'recibido' }),
  ];
  const r = despachosSinCerrar(datosBase({ despachos }));
  assert.equal(r.hallazgos.length, 1);
  assert.equal(r.hallazgos[0].gravedad, 'baja', 'si siguió confirmando, probablemente solo se olvidaron');
});

test('si la tienda no confirmó nada desde entonces, es más grave', () => {
  const despachos = [despacho({ fecha: dia(-4), enviado_en: dia(-3), estado: 'enviado', panas_recibidas: null })];
  assert.equal(despachosSinCerrar(datosBase({ despachos })).hallazgos[0].gravedad, 'alta');
});

test('un despacho que salió ayer todavía no es un problema', () => {
  const despachos = [despacho({ fecha: dia(-2), enviado_en: dia(-1), estado: 'enviado', panas_recibidas: null })];
  assert.equal(despachosSinCerrar(datosBase({ despachos })).hallazgos.length, 0);
});

test('un pedido que lleva días sin despacharse NO es un problema: no todos los pedidos se envían', () => {
  const despachos = [despacho({ fecha: dia(-3), estado: 'pendiente', panas_recibidas: null }), despacho({ fecha: dia(-5), estado: 'preparado', panas_recibidas: null })];
  const r = despachosSinCerrar(datosBase({ despachos }));
  assert.equal(r.hallazgos.length, 0);
  assert.equal(r.limpieza.length, 0, 'tampoco es "por ordenar" todavía: es demasiado reciente');
});

test('los pedidos abiertos hace más de una semana se juntan como "por ordenar", por tienda, sin ser hallazgo', () => {
  const despachos = [
    ...['mackey', 'proceres', 'peru'].flatMap((t) => [10, 20].map((n) => despacho({ id: `${t}${n}`, sucursal_id: t, fecha: dia(-n), estado: 'pendiente', panas_recibidas: null }))),
  ];
  const datos = datosBase({ despachos, sucursales: [...datosBase().sucursales, { id: 'peru', nombre: 'Perú', activa: 1, rol: 'sucursal' }] });
  const r = despachosSinCerrar(datos);
  assert.equal(r.hallazgos.length, 0);
  assert.equal(r.estado, 'ok');
  const l = r.limpieza.find((x) => x.id.endsWith('pedidos-abiertos'));
  assert.equal(l.cantidad, 6);
  assert.equal(l.mas_vieja_dias, 20);
  assert.equal(l.filas.length, 3);
  assert.match(l.detalle, /no todos los pedidos se despachan/);
});

test('un despacho "enviado" hace más de 2 semanas sin confirmar ya es un registro viejo, no una duda', () => {
  const despachos = [despacho({ fecha: dia(-21), enviado_en: dia(-20), estado: 'enviado', panas_recibidas: null })];
  const r = despachosSinCerrar(datosBase({ despachos }));
  assert.equal(r.hallazgos.length, 0);
  assert.equal(r.limpieza[0].id.endsWith('enviados-viejos'), true);
});

// ── trazabilidad ───────────────────────────────────────────────────────────────────────────

function conTandas(despachos, cubiertos) {
  return despachos.filter((d) => cubiertos(d)).map((d) => ({ despacho_id: d.id, gramos: d.gramos_enviados }));
}

test('si casi todo se rastrea y una tienda queda afuera, lo marca para observar', () => {
  const despachos = [...recepciones('mackey', 12, () => 0), ...recepciones('proceres', 12, () => 0)];
  const tandas = conTandas(despachos, (d) => d.sucursal_id === 'mackey');
  const r = despachosSinTrazabilidad(datosBase({ despachos, tandas }));
  assert.equal(r.hallazgos.length, 1);
  assert.equal(r.hallazgos[0].sucursal_id, 'proceres');
  assert.equal(r.hallazgos[0].nivel, 'observar', 'es una práctica a mejorar, no una alerta');
});

test('si nadie ata despachos a tandas, no critica algo que nunca se pidió', () => {
  const despachos = recepciones('mackey', 20, () => 0);
  const r = despachosSinTrazabilidad(datosBase({ despachos, tandas: [] }));
  assert.equal(r.estado, 'sin_datos');
});
