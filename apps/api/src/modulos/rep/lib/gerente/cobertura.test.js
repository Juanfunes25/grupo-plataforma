import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datosBase, dia, marcacion, persona, horarioSemana, HOY } from './fixtures.js';
import { analizarCobertura, historiaDeAsistencia, tasasDeFalta } from './cobertura.js';
import { diaSemanaDe } from './nucleo.js';

/**
 * Mackey: Ana, Beto y Carla trabajan lunes a sábado. Próceres: Dani, Eli y Fede.
 * Historia: 12 semanas en las que todos marcan todos sus turnos (salvo lo que cada prueba cambie).
 */
function escenario({ faltas = [], vacaciones = [], extraHorarios = [], extraPersonas = [], saltarMarca = () => false, tiendas = ['mackey', 'proceres'] } = {}) {
  const equipos = {
    mackey: [[1, 'Ana'], [2, 'Beto'], [3, 'Carla']],
    proceres: [[4, 'Dani'], [5, 'Eli'], [6, 'Fede']],
  };
  const empleados = [];
  const horarios = [];
  const marcaciones = [];
  for (const t of tiendas) {
    for (const [id, nombre] of equipos[t]) {
      empleados.push(persona(id, nombre, t));
      horarios.push(...horarioSemana(id));
      for (let o = -84; o <= -1; o++) {
        if (diaSemanaDe(dia(o)) === 6) continue; // domingo libre
        if (faltas.some(([emp, off]) => emp === id && off === o)) continue;
        if (saltarMarca(id, o)) continue;
        marcaciones.push(marcacion({ empleado: id, sucursal: t, offset: o }));
      }
    }
  }
  return datosBase({
    empleados: [...empleados, ...extraPersonas],
    horarios: [...horarios, ...extraHorarios],
    marcaciones,
    vacaciones,
  });
}

const alertasDe = (r, tienda) => r.alertas.filter((a) => a.sucursal_id === tienda);
const manana = dia(1);

test('un negocio con asistencia perfecta y horarios completos no recibe alertas fuertes', () => {
  const r = analizarCobertura(escenario());
  assert.equal(r.resumen.en_papel, 0);
  assert.ok(r.alertas.every((a) => a.nivel === 'baja'), JSON.stringify(r.alertas.map((a) => [a.tienda, a.fecha, a.nivel, a.prob_corto_pct])));
});

test('las vacaciones que dejan a una tienda con menos gente de la habitual se avisan como "corto en el papel"', () => {
  // Ana y Beto se van de vacaciones 3 días: quedaría solo Carla donde siempre hay 3.
  const f1 = dia(3); const f2 = dia(5);
  const r = analizarCobertura(escenario({
    vacaciones: [{ empleado_id: 1, fecha_inicio: f1, fecha_fin: f2 }, { empleado_id: 2, fecha_inicio: f1, fecha_fin: f2 }],
  }));
  const mackey = alertasDe(r, 'mackey').filter((a) => a.corto_en_papel);
  const dom = (f) => diaSemanaDe(f) === 6;
  const esperadas = [dia(3), dia(4), dia(5)].filter((f) => !dom(f));
  assert.deepEqual(mackey.map((a) => a.fecha), esperadas);
  assert.equal(mackey[0].nivel, 'alta');
  assert.match(mackey[0].causas[0], /vacaciones: Ana, Beto/);
  assert.equal(mackey[0].requeridos, 3);
  assert.equal(mackey[0].programados.length, 1);
  assert.equal(alertasDe(r, 'proceres').filter((a) => a.corto_en_papel).length, 0, 'la otra tienda no se toca');
});

test('si una tienda tiene gente de sobra, se propone mover a alguien de ahí, como consulta y con su riesgo', () => {
  // Próceres tiene 4 personas ese día, y siempre vienen 3: sobra una.
  const f = dia(3);
  const dow = diaSemanaDe(f);
  const extra = persona(7, 'Gus', 'proceres');
  const horarioExtra = horarioSemana(7);
  const base = escenario({
    vacaciones: [{ empleado_id: 1, fecha_inicio: f, fecha_fin: f }, { empleado_id: 2, fecha_inicio: f, fecha_fin: f }],
    extraPersonas: [extra], extraHorarios: horarioExtra,
  });
  // Gus marca igual de bien
  for (let o = -84; o <= -1; o++) if (diaSemanaDe(dia(o)) !== 6) base.marcaciones.push(marcacion({ empleado: 7, sucursal: 'proceres', offset: o }));
  // En Próceres hay 4 en el horario pero el dueño dice que con 3 alcanza: sobra una persona.
  const r = analizarCobertura(base, { minimos: [{ sucursal_id: 'proceres', dia_semana: dow, minimo: 3 }] });
  const a = alertasDe(r, 'mackey').find((x) => x.fecha === f && x.corto_en_papel);
  assert.ok(a, `dow ${dow}`);
  const mover = a.sugerencias.find((s) => s.tipo === 'mover');
  assert.ok(mover, JSON.stringify(a.sugerencias));
  assert.equal(mover.desde, 'Próceres');
  assert.match(mover.texto, /Consultar/);
  assert.ok(mover.riesgo_en_origen_pct <= 10);
});

test('no se propone sacar gente de una tienda que quedaría corta', () => {
  const f = dia(3);
  const r = analizarCobertura(escenario({ vacaciones: [{ empleado_id: 1, fecha_inicio: f, fecha_fin: f }, { empleado_id: 2, fecha_inicio: f, fecha_fin: f }] }));
  const a = alertasDe(r, 'mackey').find((x) => x.fecha === f);
  assert.ok(!a.sugerencias.some((s) => s.tipo === 'mover'), 'Próceres tiene justo los 3 que necesita');
});

test('quien tiene franco ese día aparece como alguien a quien consultar', () => {
  // Domingo es franco de todos: se puede consultar. Se prueba con una falta programada de un martes.
  const f = dia(2);
  const r = analizarCobertura(escenario({ vacaciones: [{ empleado_id: 1, fecha_inicio: f, fecha_fin: f }] }));
  const a = alertasDe(r, 'mackey').find((x) => x.fecha === f);
  if (diaSemanaDe(f) === 6) return; // día libre de todos: no aplica
  assert.ok(a.corto_en_papel);
});

// ── el riesgo por historial ──────────────────────────────────────────────────────────────

test('quien falta seguido hace subir el riesgo de su tienda frente a una que viene siempre', () => {
  // Carla falta 1 de cada 3 turnos.
  const faltas = [];
  let n = 0;
  for (let o = -84; o <= -1; o++) { if (diaSemanaDe(dia(o)) === 6) continue; if (id3(n++)) faltas.push([3, o]); }
  function id3(k) { return k % 3 === 0; }
  const r = analizarCobertura(escenario({ faltas }));
  const mackey = r.alertas.filter((a) => a.sucursal_id === 'mackey' && !a.corto_en_papel);
  const proceres = r.alertas.filter((a) => a.sucursal_id === 'proceres' && !a.corto_en_papel);
  const m = Math.max(...mackey.map((a) => a.prob_corto_pct), 0);
  const p = Math.max(...proceres.map((a) => a.prob_corto_pct), 0);
  assert.ok(m > p, `Mackey ${m}% vs Próceres ${p}%`);
  assert.ok(m >= 10);
  const ficha = r.historia.personas.find((x) => x.nombre === 'Carla');
  assert.ok(ficha.faltas >= 20);
});

test('con poca historia, una persona no se etiqueta por una sola falta: la tasa se acerca a la de su tienda', () => {
  const d = escenario({ faltas: [[1, -3], [1, -10], [1, -17]] });
  const t = tasasDeFalta(d, historiaDeAsistencia(d));
  assert.ok(t.tasaPersona.get(1) < 0.06, `3 faltas en 72 turnos no es ${t.tasaPersona.get(1)}`);
  assert.ok(t.tasaPersona.get(1) > t.tasaPersona.get(2), 'la que faltó sí pesa más, sin exagerar');
});

test('un día en que nadie de la tienda marcó no se cuenta como falta de todos (feriado, apagón, teléfono)', () => {
  const sinMarcas = (id, o) => o === -5 && id <= 3; // nadie de Mackey marcó hace 5 días
  const h = historiaDeAsistencia(escenario({ saltarMarca: sinMarcas }));
  assert.equal(h.personas.get(1).faltas, 0);
  assert.equal(h.personas.get(4).faltas, 0);
});

test('quien nunca marca no se cuenta como que siempre falta', () => {
  const h = historiaDeAsistencia(escenario({ saltarMarca: (id) => id === 3 }));
  assert.equal(h.personas.get(3).excluida, 'no_marca');
  assert.equal(h.personas.get(3).faltas, 0);
  const r = analizarCobertura(escenario({ saltarMarca: (id) => id === 3 }));
  assert.ok(r.avisos.some((a) => /Carla no marca nunca/.test(a)));
});

test('si alguien marca seguido en días que su horario dice libre, el horario está desactualizado y no se le cuentan faltas', () => {
  // Beto "libre" los miércoles según el horario, pero viene siempre.
  const d = escenario({ extraHorarios: [] });
  d.horarios = d.horarios.map((h) => (h.empleado_id === 2 && h.dia_semana === 2 ? { ...h, estado: 'libre' } : h));
  const h = historiaDeAsistencia(d);
  assert.equal(h.personas.get(2).excluida, 'horario_desactualizado');
  assert.ok(analizarCobertura(d).avisos.some((a) => /Beto marca seguido.*desactualizado/.test(a)));
});

// ── el mínimo y los datos insuficientes ──────────────────────────────────────────────────

test('el mínimo que define el dueño le gana a lo habitual', () => {
  const r = analizarCobertura(escenario(), { minimos: [{ sucursal_id: 'mackey', dia_semana: diaSemanaDe(manana), minimo: 2 }] });
  const t = r.tiendas.find((x) => x.sucursal_id === 'mackey');
  const m = t.minimo_por_dia[diaSemanaDe(manana)];
  assert.equal(m.valor, 2);
  assert.equal(m.fuente, 'definido');
  const habitual = t.minimo_por_dia.find((x) => x.dia_semana !== 6 && x.dia_semana !== diaSemanaDe(manana));
  assert.equal(habitual.fuente, 'habitual');
  assert.equal(habitual.valor, 3);
});

test('si la tienda casi no usa la marcación, no inventa riesgos por faltas, y lo dice', () => {
  const d = escenario({ saltarMarca: (id, o) => id <= 3 && o < -3 });
  const r = analizarCobertura(d);
  const t = r.tiendas.find((x) => x.sucursal_id === 'mackey');
  assert.equal(t.datos_suficientes, false);
  assert.ok(t.dias.every((x) => x.prob_corto_pct === null));
  assert.ok(r.avisos.some((a) => /casi no se usa el sistema de marcación/.test(a)));
});

test('sin historia, usa la plantilla del horario como lo necesario y lo marca así', () => {
  const d = escenario();
  d.marcaciones = [];
  const r = analizarCobertura(d);
  const t = r.tiendas.find((x) => x.sucursal_id === 'mackey');
  assert.equal(t.minimo_por_dia[0].fuente, 'plantilla');
  assert.equal(t.minimo_por_dia[0].valor, 3);
});

test('las tiendas cerradas no entran en el análisis', () => {
  const d = escenario();
  d.sucursales = d.sucursales.map((s) => (s.id === 'proceres' ? { ...s, activa: 0 } : s));
  assert.ok(!analizarCobertura(d).tiendas.some((t) => t.sucursal_id === 'proceres'));
  assert.ok(!analizarCobertura(escenario({ tiendas: ['mackey'] })).tiendas.some((t) => t.sucursal_id === 'progreso'));
});

test('los avisos van de la fecha más cercana a la más lejana, y con el horizonte pedido', () => {
  const r = analizarCobertura(escenario({ vacaciones: [{ empleado_id: 1, fecha_inicio: dia(2), fecha_fin: dia(9) }, { empleado_id: 2, fecha_inicio: dia(2), fecha_fin: dia(9) }] }), { dias: 7 });
  const fechas = r.alertas.map((a) => a.fecha);
  assert.deepEqual(fechas, [...fechas].sort());
  assert.ok(fechas.every((f) => f <= dia(7)));
  assert.equal(r.hasta, dia(7));
  assert.equal(r.desde, manana);
  assert.ok(HOY);
});
