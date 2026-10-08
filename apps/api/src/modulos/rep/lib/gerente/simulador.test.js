import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armarBase, simular, simularTienda, mejoresDias, ventanasDe, ErrorDeSimulacion } from './simulador.js';
import { armarRecomendacion } from '../recomendacionDespacho.js';
import { dia } from './fixtures.js';

const PERFIL = [0.8, 0.8, 0.9, 1, 1.2, 1.5, 1.3]; // lun..dom
const sabor = (id, extra = {}) => ({ sabor_id: id, nombre: `S${id}`, tasa: 2000, sigma: 400, gramosPana: 3000, pisoG: 3000, apretado: false, muestras: 12, confianza: 'alta', ...extra });
const tienda = (id, dias, extra = {}) => ({
  sucursal_id: id, nombre: id.toUpperCase(), perfil: PERFIL, diasReparto: dias, sabores: [sabor(1), sabor(2, { tasa: 1000, sigma: 250 })],
  precision: { errorMedioPct: 12, dentroDe20Pct: 80, muestras: 40 }, visitas: 20, real_kg_semana: null, ...extra,
});
const base = (tiendas, costos = new Map([[1, 40], [2, 50]])) => ({ tiendas, costosPorSabor: costos, excluidas: [], hoy: '2026-10-02' });

test('las ventanas de reparto cubren toda la semana, sin huecos ni repetir días', () => {
  for (const dias of [[0], [0, 3], [1, 3, 5], [0, 2, 4, 6], [5, 6]]) {
    const cubiertos = ventanasDe(dias).flatMap((v) => v.dias).sort();
    assert.deepEqual(cubiertos, [0, 1, 2, 3, 4, 5, 6], `días ${dias}`);
  }
  assert.throws(() => ventanasDe([]), ErrorDeSimulacion);
});

test('cuántos kilos se venden en la semana no depende de qué días se reparte', () => {
  const t = tienda('mackey', [0, 3]);
  const a = simularTienda(t, { dias: [0, 3] }).kg_semana;
  const b = simularTienda(t, { dias: [1, 2, 4] }).kg_semana;
  const c = simularTienda(t, { dias: [5] }).kg_semana;
  assert.equal(a, b);
  assert.equal(a, c);
  // y es lo esperado: (2000+1000) g/día × suma del perfil (7.5) = 22.5 kg
  assert.equal(a, 22.5);
});

test('repartir más días baja los kilos por viaje y el helado pasa menos tiempo en vitrina', () => {
  const t = tienda('mackey', [0, 3]);
  const dos = simularTienda(t, { dias: [0, 3] });
  const tres = simularTienda(t, { dias: [0, 2, 4] });
  assert.equal(tres.viajes_semana, 3);
  assert.ok(tres.kg_por_viaje < dos.kg_por_viaje);
  assert.ok(tres.edad_dias < dos.edad_dias, `${tres.edad_dias} < ${dos.edad_dias}`);
  assert.ok(tres.inventario_vitrina_kg < dos.inventario_vitrina_kg);
});

test('un solo reparto a la semana es lo más viejo y lo más pesado por viaje', () => {
  const t = tienda('mackey', [0]);
  const uno = simularTienda(t, { dias: [0] });
  const dos = simularTienda(t, { dias: [0, 3] });
  assert.ok(uno.edad_dias > dos.edad_dias);
  assert.equal(uno.kg_por_viaje, uno.kg_semana);
});

test('el nivel de servicio se mantiene: el riesgo de agotarse queda en torno al 15% por diseño', () => {
  const r = simularTienda(tienda('mackey', [0, 3]), { dias: [0, 3] });
  assert.ok(r.riesgo_agotarse_pct >= 5 && r.riesgo_agotarse_pct <= 25, `riesgo ${r.riesgo_agotarse_pct}`);
});

test('con demanda +20% se produce 20% más; con -100% la tienda cierra y no queda nada', () => {
  const t = tienda('mackey', [0, 3]);
  const normal = simularTienda(t, { dias: [0, 3] });
  const sube = simularTienda(t, { dias: [0, 3], demanda: 1.2 });
  assert.equal(sube.kg_semana, redondear1(normal.kg_semana * 1.2));
  const cierra = simularTienda(t, { dias: [0, 3], demanda: 0 });
  assert.equal(cierra.abierta, false);
  assert.equal(cierra.kg_semana, 0);
});
const redondear1 = (n) => Math.round(n * 10) / 10;

test('el costo sale de las recetas: kg por costo por kg, y avisa cuánto quedó sin costo', () => {
  const t = tienda('mackey', [0, 3]);
  const r = simularTienda(t, { dias: [0, 3], costosPorSabor: new Map([[1, 40], [2, 50]]) });
  // sabor 1: 2 kg/día × 7.5 = 15 kg × 40 = 600; sabor 2: 7.5 kg × 50 = 375
  assert.equal(r.costo_semana, 975);
  const sin = simularTienda(t, { dias: [0, 3], costosPorSabor: new Map([[1, 40]]) });
  assert.equal(sin.kg_sin_costo, 7.5);
  assert.equal(sin.costo_semana, 600);
});

test('para elegir 2 días, prefiere los separados (lun y jue) antes que los pegados (lun y mar)', () => {
  const r = mejoresDias(tienda('mackey', [0, 3]), 2);
  const mejor = r[0].dias;
  assert.ok(Math.abs(mejor[1] - mejor[0]) >= 3 && Math.abs(mejor[1] - mejor[0]) <= 4, `eligió ${mejor}`);
  const pegados = r.find((x) => x.dias.join() === '0,1');
  assert.ok(pegados.edad_dias > r[0].edad_dias);
  assert.equal(r.length, 21);
});

// ── escenarios ──────────────────────────────────────────────────────────────────────────────

test('"¿y si Mackey repartiera 3 días en vez de 2?": más viajes, más fresco, y la producción semanal no cambia', () => {
  const b = base([tienda('mackey', [0, 3]), tienda('proceres', [1, 4])]);
  const r = simular(b, [{ tipo: 'dias_reparto', sucursal_id: 'mackey', cantidad: 3 }]);
  const m = r.tiendas.find((t) => t.sucursal_id === 'mackey');
  const p = r.tiendas.find((t) => t.sucursal_id === 'proceres');
  assert.equal(m.dias_despues.length, 3);
  assert.equal(m.antes.viajes_semana, 2);
  assert.ok(m.despues.edad_dias < m.antes.edad_dias);
  assert.equal(p.cambia, false, 'la otra tienda no se toca');
  assert.deepEqual(p.antes, p.despues);
  assert.equal(r.totales.despues.kg_semana, r.totales.antes.kg_semana);
  assert.ok(r.lecturas.some((l) => l.tema === 'viajes'));
  assert.ok(r.lecturas.some((l) => l.tema === 'frescura'));
  assert.ok(!r.lecturas.some((l) => l.tema === 'produccion'), 'no inventa un cambio de producción que no hay');
  assert.match(r.explicaciones[0], /más fresco/);
});

test('"¿y si abro una tienda más?": suma producción, costo y viajes, y dice que es una suposición', () => {
  const b = base([tienda('mackey', [0, 3]), tienda('proceres', [1, 4])]);
  const r = simular(b, [{ tipo: 'tienda_nueva', como: 'mackey', porcentaje: 70 }]);
  const n = r.tiendas.find((t) => t.nueva);
  assert.ok(n);
  assert.equal(r.totales.despues.kg_semana, redondear1(r.totales.antes.kg_semana + 22.5 * 0.7));
  assert.ok(r.totales.despues.costo_semana > r.totales.antes.costo_semana);
  assert.equal(r.totales.despues.viajes_semana, r.totales.antes.viajes_semana + 2);
  assert.ok(r.supuestos.some((s) => /suposición/.test(s)));
  assert.equal(r.confianza, 'orientativa', 'una tienda sin historia nunca es una cifra firme');
});

test('una tienda que cierra baja la producción en lo que vendía', () => {
  const b = base([tienda('mackey', [0, 3]), tienda('proceres', [1, 4])]);
  const r = simular(b, [{ tipo: 'demanda', sucursal_id: 'proceres', porcentaje: -100 }]);
  assert.equal(r.totales.despues.kg_semana, 22.5);
  assert.equal(r.tiendas.find((t) => t.sucursal_id === 'proceres').despues.abierta, false);
});

test('un cambio que no cambia nada no genera conclusiones', () => {
  const b = base([tienda('mackey', [0, 3])]);
  const r = simular(b, [{ tipo: 'dias_reparto', sucursal_id: 'mackey', dias: [0, 3] }]);
  assert.equal(r.lecturas.length, 0);
});

test('se pueden combinar cambios: más días y más demanda a la vez', () => {
  const b = base([tienda('mackey', [0, 3])]);
  const r = simular(b, [{ tipo: 'dias_reparto', sucursal_id: 'mackey', dias: [0, 2, 4] }, { tipo: 'demanda', sucursal_id: 'mackey', porcentaje: 10 }]);
  assert.equal(r.tiendas[0].despues.kg_semana, redondear1(22.5 * 1.1));
  assert.equal(r.tiendas[0].despues.viajes_semana, 3);
});

test('rechaza lo que no se puede simular, en vez de inventar una respuesta', () => {
  const b = base([tienda('mackey', [0, 3])]);
  assert.throws(() => simular(b, []), ErrorDeSimulacion);
  assert.throws(() => simular(b, [{ tipo: 'dias_reparto', sucursal_id: 'nadie', cantidad: 2 }]), /No tengo datos/);
  assert.throws(() => simular(b, [{ tipo: 'dias_reparto', sucursal_id: 'mackey', dias: [9] }]), /inválido/);
  assert.throws(() => simular(b, [{ tipo: 'dias_reparto', sucursal_id: 'mackey', cantidad: 0 }]), ErrorDeSimulacion);
  assert.throws(() => simular(b, [{ tipo: 'demanda', sucursal_id: 'mackey', porcentaje: -300 }]), ErrorDeSimulacion);
  assert.throws(() => simular(b, [{ tipo: 'magia' }]), /No sé simular/);
});

test('si el modelo no reproduce lo que de verdad se envió, lo avisa en vez de callarse', () => {
  const b = base([tienda('mackey', [0, 3], { real_kg_semana: 40 })]);
  const r = simular(b, [{ tipo: 'dias_reparto', sucursal_id: 'mackey', cantidad: 3 }]);
  assert.ok(r.avisos.some((a) => /No se ajusta bien/.test(a)));
  assert.equal(r.confianza, 'orientativa');
  const ok = simular(base([tienda('mackey', [0, 3], { real_kg_semana: 23 })]), [{ tipo: 'dias_reparto', sucursal_id: 'mackey', cantidad: 3 }]);
  assert.ok(!ok.avisos.some((a) => /No se ajusta/.test(a)));
  assert.equal(ok.confianza, 'razonable');
});

// ── contra el recomendador real ─────────────────────────────────────────────────────────────

test('con datos de despacho de verdad, el modelo reproduce los kilos enviados por semana', () => {
  // Reparto lunes y jueves durante 12 semanas; cada envío cubre su ventana según la demanda real.
  const real = [2000, 2000, 2250, 2500, 3000, 3750, 3250]; // g por día de un sabor
  const despachos = [];
  const lunes = dia(-84 + ((7 - (new Date(`${dia(-84)}T00:00:00Z`).getUTCDay() + 6) % 7) % 7));
  for (let s = 0; s < 12; s++) {
    for (const [off, cubre] of [[0, [0, 1, 2]], [3, [3, 4, 5, 6]]]) {
      const f = new Date(`${lunes}T00:00:00Z`); f.setUTCDate(f.getUTCDate() + s * 7 + off);
      const fecha = f.toISOString().slice(0, 10);
      despachos.push({
        fecha, sucursal_id: 'mackey', sucursal_nombre: 'Mackey', sabor_id: 1, sabor_nombre: 'MANGO', gramos_pana: 3000,
        gramos_enviados: cubre.reduce((a, j) => a + real[j], 0), estado: 'recibido',
      });
    }
  }
  const rec = armarRecomendacion({ despachos, hasta: despachos[despachos.length - 1].fecha });
  const b = armarBase({ recomendacion: rec, costosPorSabor: new Map([[1, 40]]) });
  assert.equal(b.tiendas.length, 1);
  assert.deepEqual(b.tiendas[0].diasReparto, [0, 3]);
  const modelo = simularTienda(b.tiendas[0], { dias: [0, 3], costosPorSabor: b.costosPorSabor });
  const verdad = real.reduce((a, x) => a + x, 0) / 1000; // 20 kg/semana
  assert.ok(Math.abs(modelo.kg_semana - verdad) / verdad < 0.1, `modelo ${modelo.kg_semana} vs real ${verdad}`);
  const r = simular(b, [{ tipo: 'dias_reparto', sucursal_id: 'mackey', cantidad: 3 }]);
  assert.equal(r.tiendas[0].despues.viajes_semana, 3);
});
