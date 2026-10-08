import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armarRecomendacion } from './recomendacionDespacho.js';

// Fechas por offset desde un ancla, no escritas a mano: el test no depende de recordar qué
// día de la semana cae tal fecha del calendario real.
const ANCLA = '2026-06-01';
function fecha(offsetDias) {
  const d = new Date(`${ANCLA}T00:00:00`);
  d.setDate(d.getDate() + offsetDias);
  return d.toISOString().slice(0, 10);
}
function diaSemanaDe(fechaISO) {
  return (new Date(`${fechaISO}T00:00:00`).getDay() + 6) % 7;
}
const LUN = 0, VIE = 4, SAB = 5, DOM = 6;

const despacho = (extra) => ({
  sucursal_id: 'proceres', sucursal_nombre: 'Próceres',
  sabor_id: 1, sabor_nombre: 'MANGO', gramos_pana: 3000,
  gramos_enviados: 0, estado: 'recibido', ...extra,
});

/** Simula reparto DIARIO durante n días, mandando cada día exactamente la demanda de ese día
 *  de la semana. Con una visita por día cada envío cubre un solo día, así que el sistema de
 *  ecuaciones queda bien determinado y se puede comprobar que el perfil recupera la verdad. */
function repartoDiario(demandaPorDia, dias = 84, extra = {}) {
  return Array.from({ length: dias }, (_, i) =>
    despacho({ fecha: fecha(i), gramos_enviados: demandaPorDia[diaSemanaDe(fecha(i))], ...extra })
  );
}

// ══════════════════════════════════════════════ 1. separar la demanda por día de la semana

test('recupera el perfil semanal real: el sábado sale muy por encima de un lunes', () => {
  // Verdad simulada: lun-jue 6kg/día, viernes 12, sábado 18, domingo 12.
  const verdad = [6000, 6000, 6000, 6000, 12000, 18000, 12000];
  const r = armarRecomendacion({ despachos: repartoDiario(verdad), hasta: fecha(83) });
  const perfil = r.tiendas[0].perfilSemanal;

  assert.equal(r.tiendas[0].perfilAjustado, true);
  assert.ok(perfil[SAB].factor > perfil[VIE].factor, 'el sábado por encima del viernes');
  assert.ok(perfil[VIE].factor > perfil[LUN].factor, 'el viernes por encima del lunes');
  assert.ok(perfil[SAB].factor > 1.4, `el sábado debe destacar, salió ${perfil[SAB].factor}`);
  assert.ok(perfil[LUN].factor < 0.9, `el lunes debe quedar debajo, salió ${perfil[LUN].factor}`);
  assert.ok(perfil[SAB].factor / perfil[LUN].factor > 1.8, 'la brecha sábado/lunes se conserva');
});

test('con demanda pareja el perfil se aplana solo: no inventa un patrón que no existe', () => {
  const r = armarRecomendacion({ despachos: repartoDiario(new Array(7).fill(8000)), hasta: fecha(83) });
  for (const d of r.tiendas[0].perfilSemanal) {
    assert.ok(Math.abs(d.factor - 1) < 0.05, `${d.nombreDia} debería quedar en 1.0, salió ${d.factor}`);
  }
});

test('la regularización impide afirmar diferencias que los datos no pueden distinguir', () => {
  // Reparto lunes y jueves nada más: el lunes cubre lun+mar+mié y el jueves jue+vie+sáb+dom.
  // Dentro de cada bloque es IMPOSIBLE saber qué día aporta más - el modelo no debe inventarlo.
  const despachos = [];
  for (let semana = 0; semana < 12; semana++) {
    const base = semana * 7;
    despachos.push(despacho({ fecha: fecha(base + (7 - diaSemanaDe(fecha(base)))), gramos_enviados: 9000 }));
  }
  const r = armarRecomendacion({ despachos, hasta: fecha(83) });
  if (r.tiendas.length) {
    const perfil = r.tiendas[0].perfilSemanal.map((d) => d.factor);
    const max = Math.max(...perfil);
    const min = Math.min(...perfil);
    assert.ok(max / min < 2.2, `sin información para separar días, el perfil no debe abrirse tanto (${min}-${max})`);
  }
});

// ═══════════════════════════════════════════════ 2. el plan puede pedir MÁS que lo que se manda

test('con demanda variable el plan queda POR ENCIMA de lo que se manda hoy (stock de seguridad)', () => {
  // Demanda que oscila entre 7 y 11 kg: mandar "lo típico" (9) deja corto la mitad de las veces.
  const despachos = Array.from({ length: 84 }, (_, i) =>
    despacho({ fecha: fecha(i), gramos_enviados: i % 2 === 0 ? 7000 : 11000 })
  );
  const r = armarRecomendacion({ despachos, hasta: fecha(83) });
  const dia = r.tiendas[0].dias[0];
  const mango = dia.sabores[0];

  assert.ok(mango.kgSeguridad > 0, 'debe haber stock de seguridad cuando la demanda varía');
  assert.ok(mango.kgObjetivo > mango.kgActual, `el objetivo (${mango.kgObjetivo}) debe superar lo que se manda hoy (${mango.kgActual})`);
  assert.ok(mango.diferenciaKg > 0);
  assert.equal(mango.nivelServicio, 85);
  // Pero el colchón está topeado: es gelato, sobrar tampoco es gratis.
  assert.ok(mango.kgSeguridad <= mango.kgEsperado * 0.21, `el colchón no puede pasar del 20% (salió ${mango.kgSeguridad})`);
});

test('con demanda perfectamente estable no infla el plan de gusto', () => {
  const r = armarRecomendacion({ despachos: repartoDiario(new Array(7).fill(9000)), hasta: fecha(83) });
  const mango = r.tiendas[0].dias[0].sabores[0];
  assert.equal(mango.kgSeguridad, 0, 'sin variabilidad no hace falta colchón');
  assert.equal(mango.kgEsperado, 9, 'lo que se espera vender es exactamente lo que se consume');
  // El objetivo sí lleva encima el piso de vitrina, que no es demanda: es lo que tiene que
  // quedar para que la vitrina no termine vacía. Sin pesajes, ese piso es una pana.
  assert.equal(mango.kgPiso, 3, 'sin pesajes el piso es una pana entera');
  assert.equal(mango.kgObjetivo, 12, 'objetivo = lo que se vende + el piso que queda');
  assert.equal(mango.gramosFlujo, 9000, 'el FLUJO es solo lo que se repone cada ciclo, sin el piso');
});

test('el piso de vitrina sale de lo que queda de verdad cada noche, no de un número fijo', () => {
  // Esta tienda cierra todas las noches con ~8 kg de mango en vitrina: ese es su piso real,
  // bastante más que la pana mínima. Copiar el mínimo la dejaría más vacía de lo que está hoy.
  const pesajes = [];
  for (let i = 40; i <= 83; i++) {
    pesajes.push({ sucursal_id: 'proceres', sabor_id: 1, fecha: fecha(i), gramos: 8000 });
  }
  const r = armarRecomendacion({
    despachos: repartoDiario(new Array(7).fill(9000)),
    pesajes,
    hasta: fecha(83),
  });
  const mango = r.tiendas[0].dias[0].sabores[0];
  assert.equal(mango.kgPiso, 8, 'toma el típico de las noches medidas');
  assert.ok(mango.kgObjetivo > 8, 'y el objetivo lo lleva encima del consumo');
});

test('el piso no copia un sobrestock: se topea en tres panas', () => {
  // Si de un sabor vienen quedando 30 kg todas las noches, eso no es un piso a sostener, es
  // gelato parado. Copiarlo como objetivo lo volvería permanente.
  const pesajes = [];
  for (let i = 40; i <= 83; i++) {
    pesajes.push({ sucursal_id: 'proceres', sabor_id: 1, fecha: fecha(i), gramos: 30000 });
  }
  const r = armarRecomendacion({
    despachos: repartoDiario(new Array(7).fill(9000)),
    pesajes,
    hasta: fecha(83),
  });
  assert.equal(r.tiendas[0].dias[0].sabores[0].kgPiso, 9, 'tres panas de 3 kg, no los 30 del histórico');
});

// ══════════════════════════════════════════════════════════ 3. demanda censurada

test('un quiebre de stock no cuenta como demanda baja, y sube el nivel de servicio de ese día', () => {
  const despachos = [];
  for (let semana = 0; semana < 12; semana++) {
    const base = semana * 7;
    // Dos visitas por semana. En la segunda, un tercio de las semanas no hubo producto.
    despachos.push(despacho({ fecha: fecha(base), gramos_enviados: 9000 }));
    if (semana % 3 === 0) {
      despachos.push(despacho({ fecha: fecha(base + 3), estado: 'no_disponible', gramos_enviados: 0 }));
    } else {
      despachos.push(despacho({ fecha: fecha(base + 3), gramos_enviados: 12000 }));
    }
  }
  const r = armarRecomendacion({ despachos, hasta: fecha(83) });
  const diaConQuiebres = r.tiendas[0].dias.find((d) => d.diaSemana === diaSemanaDe(fecha(3)));
  const mango = diaConQuiebres.sabores[0];

  assert.equal(mango.vecesSinStock, 4, 'cuenta los quiebres de ese día de la semana');
  assert.equal(mango.nivelServicio, 94, 'un día que ya se quedó sin producto apunta más alto');
  // Los quiebres no entran al promedio: la tasa sale de los envíos reales de 12kg, no de ceros.
  assert.ok(mango.kgEsperado > 10, `el promedio no debe hundirse por los ceros (salió ${mango.kgEsperado})`);
});

test('una vitrina que cierra vacía también es demanda censurada (usa los pesajes)', () => {
  const despachos = [];
  const pesajes = [];
  for (let semana = 0; semana < 12; semana++) {
    const base = semana * 7;
    despachos.push(despacho({ fecha: fecha(base), gramos_enviados: 9000 }));
    despachos.push(despacho({ fecha: fecha(base + 3), gramos_enviados: 9000 }));
    // La ventana que arranca en base+3 cierra con la vitrina en cero casi siempre.
    pesajes.push({ sucursal_id: 'proceres', sabor_id: 1, fecha: fecha(base + 6), gramos: semana % 4 === 0 ? 4000 : 100 });
  }
  const r = armarRecomendacion({ despachos, pesajes, hasta: fecha(83) });
  const dia = r.tiendas[0].dias.find((d) => d.diaSemana === diaSemanaDe(fecha(3)));

  assert.ok(dia.sabores[0].vecesVitrinaVacia >= 6, 'detecta las noches que cerró sin producto');
  assert.equal(dia.sabores[0].nivelServicio, 94);
});

test('un día marcado no_disponible SÍ corta la ventana de cobertura del envío anterior', () => {
  // Sin esto, el envío del día 0 parecería haber tenido que durar 6 días en vez de 3, y el
  // modelo concluiría que se consume la mitad justo donde faltó producto.
  const despachos = [
    despacho({ fecha: fecha(0), gramos_enviados: 6000 }),
    despacho({ fecha: fecha(3), estado: 'no_disponible', gramos_enviados: 0 }),
    despacho({ fecha: fecha(6), gramos_enviados: 6000 }),
    despacho({ fecha: fecha(9), gramos_enviados: 6000 }),
  ];
  const r = armarRecomendacion({ despachos, hasta: fecha(9) });
  const dia = r.tiendas[0].dias.find((d) => d.diaSemana === diaSemanaDe(fecha(0)));
  assert.equal(dia.diasACubrir, 3, 'la visita sin producto igual marca que el camión pasó');
});

// ══════════════════════════════════════════════════════════ 4. recencia

test('sigue la tendencia reciente en vez de quedarse anclado al promedio viejo', () => {
  // Doce semanas a 6kg/día y las últimas tres a 12kg/día: el plan tiene que estar bastante
  // más cerca de lo nuevo que de lo viejo.
  const despachos = Array.from({ length: 84 }, (_, i) =>
    despacho({ fecha: fecha(i), gramos_enviados: i >= 63 ? 12000 : 6000 })
  );
  const r = armarRecomendacion({ despachos, hasta: fecha(83) });
  const mango = r.tiendas[0].dias[0].sabores[0];
  assert.ok(mango.kgEsperado > 8, `debe haber subido bastante desde 6kg (salió ${mango.kgEsperado})`);
});

// ══════════════════════════════════════════════════════════ 5. panas

test('la agenda sale en panas enteras, con el gramaje real de cada sabor', () => {
  const despachos = [
    ...repartoDiario(new Array(7).fill(7400)),
    ...repartoDiario(new Array(7).fill(5100), 84, { sabor_id: 2, sabor_nombre: 'PISTACHO', gramos_pana: 2500 }),
  ];
  const r = armarRecomendacion({ despachos, hasta: fecha(83) });
  const dia = r.tiendas[0].agenda[0];
  assert.equal(dia.sabores.length, 2);
  for (const s of dia.sabores) {
    assert.equal(s.gramosEnviar % s.gramosPana, 0, `${s.nombre} debe caer en panas enteras`);
    assert.equal(s.gramosEnviar, s.panas * s.gramosPana);
    assert.ok(s.panas >= 1);
  }
  assert.equal(dia.totalPanas, dia.sabores.reduce((a, s) => a + s.panas, 0));
});

// ══════════════════════════════════════════════════════════ 6. exactitud medida

test('reporta qué tan bien le pega a su propia historia (leave-one-out)', () => {
  const r = armarRecomendacion({ despachos: repartoDiario(new Array(7).fill(9000)), hasta: fecha(83) });
  const p = r.tiendas[0].precision;
  assert.ok(p, 'debe reportar precisión con suficientes muestras');
  assert.ok(p.errorMedioPct < 1, `con demanda constante el error debe ser casi nulo (salió ${p.errorMedioPct}%)`);
  assert.ok(p.dentroDe20Pct > 99);
});

test('con demanda muy errática lo dice, en vez de aparentar precisión', () => {
  const caotico = Array.from({ length: 84 }, (_, i) =>
    despacho({ fecha: fecha(i), gramos_enviados: [3000, 15000, 6000, 21000, 9000][i % 5] })
  );
  const r = armarRecomendacion({ despachos: caotico, hasta: fecha(83) });
  assert.ok(r.tiendas[0].precision.errorMedioPct > 20, 'un patrón caótico tiene que reportar error alto');
});

// ══════════════════════════════════════════════════════════ 7. higiene de datos

test('deja fuera de la lista de carga lo que hace más de cinco semanas que no se manda', () => {
  const despachos = [
    ...repartoDiario(new Array(7).fill(9000)),
    // PISTACHO solo al comienzo de la ventana: hace más de 5 semanas que no le llega.
    ...Array.from({ length: 10 }, (_, i) =>
      despacho({ fecha: fecha(i), sabor_id: 2, sabor_nombre: 'PISTACHO', gramos_enviados: 5000 })
    ),
  ];
  const r = armarRecomendacion({ despachos, hasta: fecha(83) });
  const nombres = r.tiendas[0].dias[0].sabores.map((s) => s.nombre);
  assert.ok(nombres.includes('MANGO'));
  assert.ok(!nombres.includes('PISTACHO'), 'un sabor discontinuado no va en el camión');
});

test('un sabor nuevo no arrastra los ceros de antes de existir', () => {
  const despachos = [
    ...repartoDiario(new Array(7).fill(9000)),
    // FRESA arranca recién en la semana 9 y desde ahí va fuerte.
    ...Array.from({ length: 21 }, (_, i) =>
      despacho({ fecha: fecha(63 + i), sabor_id: 3, sabor_nombre: 'FRESA', gramos_enviados: 12000 })
    ),
  ];
  const r = armarRecomendacion({ despachos, hasta: fecha(83) });
  const fresa = r.tiendas[0].dias[0].sabores.find((s) => s.nombre === 'FRESA');
  assert.ok(fresa, 'el sabor nuevo tiene que aparecer');
  assert.ok(fresa.kgEsperado > 10, `no debe diluirse con las semanas en que no existía (salió ${fresa.kgEsperado})`);
});

test('los despachos que nunca salieron de fábrica no cuentan', () => {
  const despachos = [
    despacho({ fecha: fecha(0), estado: 'pendiente', gramos_enviados: 99000 }),
    despacho({ fecha: fecha(0), estado: 'preparado', gramos_enviados: 99000 }),
    ...repartoDiario(new Array(7).fill(9000)),
  ];
  const r = armarRecomendacion({ despachos, hasta: fecha(83) });
  assert.ok(r.tiendas[0].dias[0].sabores[0].kgEsperado < 12, 'los 99kg fantasma no deben entrar');
});

test('cada tienda se calcula con su propia historia, sin mezclarse', () => {
  const despachos = [
    ...repartoDiario(new Array(7).fill(9000)),
    ...repartoDiario(new Array(7).fill(3000), 84, { sucursal_id: 'mackey', sucursal_nombre: 'Mackey' }),
  ];
  const r = armarRecomendacion({ despachos, hasta: fecha(83) });
  assert.equal(r.tiendas.length, 2);
  const mackey = r.tiendas.find((t) => t.sucursal_id === 'mackey');
  const proceres = r.tiendas.find((t) => t.sucursal_id === 'proceres');
  assert.ok(mackey.dias[0].sabores[0].kgEsperado < proceres.dias[0].sabores[0].kgEsperado);
});

test('una tienda con una sola visita no aparece: no hay ventana que medir', () => {
  const r = armarRecomendacion({ despachos: [despacho({ fecha: fecha(0), gramos_enviados: 9000 })], hasta: fecha(0) });
  assert.equal(r.tiendas.length, 0);
});

test('sin despachos devuelve vacío y no revienta', () => {
  assert.deepEqual(armarRecomendacion({ despachos: [] }), { tiendas: [] });
});

test('marca la confianza según cuántas muestras hay detrás de cada sabor', () => {
  const pocas = [
    despacho({ fecha: fecha(0), gramos_enviados: 9000 }),
    despacho({ fecha: fecha(1), gramos_enviados: 9000 }),
    despacho({ fecha: fecha(2), gramos_enviados: 9000 }),
  ];
  const r = armarRecomendacion({ despachos: pocas, hasta: fecha(2) });
  assert.equal(r.tiendas[0].dias[0].sabores[0].confianza, 'baja');

  const muchas = armarRecomendacion({ despachos: repartoDiario(new Array(7).fill(9000)), hasta: fecha(83) });
  assert.equal(muchas.tiendas[0].dias[0].sabores[0].confianza, 'alta');
});

test('dice qué días cubre cada envío, para poder revisarlo a ojo', () => {
  const despachos = [];
  for (let semana = 0; semana < 10; semana++) {
    despachos.push(despacho({ fecha: fecha(semana * 7), gramos_enviados: 9000 }));
    despachos.push(despacho({ fecha: fecha(semana * 7 + 3), gramos_enviados: 9000 }));
  }
  const r = armarRecomendacion({ despachos, hasta: fecha(69) });
  const dia = r.tiendas[0].dias.find((d) => d.diaSemana === diaSemanaDe(fecha(0)));
  assert.equal(dia.diasACubrir, 3);
  assert.equal(dia.cubre.length, 3);
  assert.ok(dia.cargaRelativa > 0, 'reporta cuánto pesa la ventana en días normales');
});

// ══════════════════════════ 8. lo que solo los pesajes pueden resolver

/** Simula una tienda con reparto solo en ciertos días y pesaje de vitrina todas las noches. */
function simularConPesajes({ demandaPorDia, diasReparto, dias = 84 }) {
  const despachos = [];
  const pesajes = [];
  const repartos = [];
  for (let i = 0; i < dias; i++) if (diasReparto.includes(diaSemanaDe(fecha(i)))) repartos.push(i);

  let stock = 0;
  for (let i = 0; i < dias; i++) {
    const f = fecha(i);
    if (diasReparto.includes(diaSemanaDe(f))) {
      const prox = repartos.find((x) => x > i) ?? i + 7;
      let necesita = 0;
      for (let k = i; k < prox; k++) necesita += demandaPorDia[diaSemanaDe(fecha(k))];
      // Reposición a nivel objetivo (par level): se repone hasta cubrir la ventana con algo de
      // colchón. Sin colchón la vitrina cerraría en cero siempre y el modelo - con razón -
      // marcaría toda la demanda como censurada.
      const enviar = Math.max(0, Math.round(necesita * 1.35 - stock));
      if (enviar > 0) {
        despachos.push(despacho({ fecha: f, gramos_enviados: enviar }));
        stock += enviar;
      }
    }
    stock -= demandaPorDia[diaSemanaDe(f)];
    pesajes.push({ sucursal_id: 'proceres', sabor_id: 1, fecha: f, gramos: stock });
  }
  return { despachos, pesajes };
}

test('con los pesajes SÍ separa el sábado del lunes, aunque siempre viajen en el mismo envío', () => {
  // Reparto jueves/viernes/sábado: el envío del sábado cubre sáb+dom+lun+mar+mié, así que por
  // más semanas que pasen los despachos solos jamás podrían decir si el sábado mueve más que
  // el lunes. Los pesajes nocturnos sí, porque miden cada noche por separado.
  const verdad = [8000, 8000, 8000, 8000, 12000, 16000, 13000]; // lun..dom
  const { despachos, pesajes } = simularConPesajes({ demandaPorDia: verdad, diasReparto: [3, 4, 5] });

  const conVitrina = armarRecomendacion({ despachos, pesajes, hasta: fecha(83) });
  const p = conVitrina.tiendas[0];
  assert.equal(p.fuentePerfil, 'vitrina');
  assert.ok(p.perfilSemanal[SAB].factor > 1.35, `el sábado debe destacar (salió ${p.perfilSemanal[SAB].factor})`);
  assert.ok(p.perfilSemanal[LUN].factor < 0.9, `el lunes debe quedar abajo (salió ${p.perfilSemanal[LUN].factor})`);
  assert.ok(p.perfilSemanal[SAB].factor / p.perfilSemanal[LUN].factor > 1.7, 'sábado y lunes quedan bien separados');

  // Y sin pesajes, el mismo historial NO puede distinguirlos: quedan pegados.
  const sinVitrina = armarRecomendacion({ despachos, hasta: fecha(83) });
  const q = sinVitrina.tiendas[0];
  assert.equal(q.fuentePerfil, 'envios');
  const brecha = q.perfilSemanal[SAB].factor / q.perfilSemanal[LUN].factor;
  assert.ok(brecha < 1.25, `sin pesajes no puede separarlos, y no debe fingir que sí (brecha ${brecha.toFixed(2)})`);
});

test('con pesajes incompletos no se cree el perfil medido: vuelve al estimado por envíos', () => {
  const verdad = [8000, 8000, 8000, 8000, 12000, 16000, 13000];
  const { despachos, pesajes } = simularConPesajes({ demandaPorDia: verdad, diasReparto: [3, 4, 5] });
  // Solo se conservan los pesajes de los lunes: ningún otro día llega al mínimo de muestras.
  const pocos = pesajes.filter((p) => diaSemanaDe(p.fecha) === LUN);
  const r = armarRecomendacion({ despachos, pesajes: pocos, hasta: fecha(83) });
  assert.equal(r.tiendas[0].fuentePerfil, 'envios');
});

test('descarta pesajes imposibles en vez de dejar que ensucien el perfil', () => {
  const verdad = new Array(7).fill(9000);
  const { despachos, pesajes } = simularConPesajes({ demandaPorDia: verdad, diasReparto: [0, 3] });
  // Un pesaje con un dígito de más (900 kg en la vitrina) daría un "consumo" negativo enorme.
  const sucios = pesajes.map((p, i) => (i === 30 ? { ...p, gramos: 900000 } : p));
  const r = armarRecomendacion({ despachos, pesajes: sucios, hasta: fecha(83) });
  for (const d of r.tiendas[0].perfilSemanal) {
    assert.ok(d.factor > 0.5 && d.factor < 2, `${d.nombreDia} no debe dispararse por un pesaje malo (${d.factor})`);
  }
});

// ══════════════════ 9. la demanda se mide del consumo, no de lo que se despachó

test('con pesajes estima la demanda del consumo real, no de los gramos despachados', () => {
  // La tienda repone "a nivel objetivo": manda lo que falte para llegar a la meta. Con esa
  // política lo despachado depende de cuánto había quedado, así que como señal de demanda es
  // ruidosísimo - el consumo, en cambio, es estable. El modelo tiene que elegir el consumo.
  const verdad = [8000, 8000, 8000, 8000, 12000, 16000, 13000];
  const { despachos, pesajes } = simularConPesajes({ demandaPorDia: verdad, diasReparto: [3, 4, 5] });
  const r = armarRecomendacion({ despachos, pesajes, hasta: fecha(83) });
  const t = r.tiendas[0];

  assert.equal(t.dias[0].sabores[0].fuenteDemanda, 'vitrina');
  assert.ok(t.precision.errorMedioPct < 10, `debe predecir el consumo con buena puntería (salió ${t.precision.errorMedioPct}%)`);

  // Sin pesajes, el mismo caso se apoya en los despachos y le pega bastante peor.
  const sinPesajes = armarRecomendacion({ despachos, hasta: fecha(83) });
  assert.equal(sinPesajes.tiendas[0].dias[0].sabores[0].fuenteDemanda, 'envios');
  assert.ok(
    sinPesajes.tiendas[0].precision.errorMedioPct > t.precision.errorMedioPct,
    'medir el consumo tiene que ser más exacto que mirar lo despachado'
  );
});

// ══════════════════ 10. la agenda: se manda la diferencia, no el objetivo entero

test('la agenda arranca del pesaje real y solo manda lo que falta', () => {
  const verdad = new Array(7).fill(9000);
  // Esta simulación repone a 1.35x, así que la tienda llega al reparto con vitrina de sobra.
  const { despachos, pesajes } = simularConPesajes({ demandaPorDia: verdad, diasReparto: [0, 3] });
  const t = armarRecomendacion({ despachos, pesajes, hasta: fecha(83) }).tiendas[0];

  assert.equal(t.pesajeDesde, fecha(83), 'usa la última noche pesada como punto de partida');
  assert.equal(t.saboresSinPesaje, 0);

  const primero = t.agenda[0];
  const s = primero.sabores[0];
  assert.equal(s.stockMedido, true);
  assert.ok(s.kgStock > 0, 'proyecta lo que la tienda va a tener ese día');
  assert.ok(s.kgEnviar < s.kgObjetivo + 3, 'nunca manda el objetivo entero si ya tiene stock');
  // Con la vitrina llena, lo correcto es no mandar nada: ese es justo el caso que antes
  // sobreproducía, porque mandaba el objetivo completo como si la tienda cerrara en cero.
  assert.equal(s.kgEnviar, 0, `con la vitrina llena no hace falta mandar (salió ${s.kgEnviar})`);
});

test('la agenda es consistente consigo misma: cada envío parte del stock que dejó el anterior', () => {
  const verdad = new Array(7).fill(9000);
  const { despachos, pesajes } = simularConPesajes({ demandaPorDia: verdad, diasReparto: [0, 3] });
  const t = armarRecomendacion({ despachos, pesajes, hasta: fecha(83) }).tiendas[0];

  // A medida que la vitrina se vacía, los envíos aparecen. Si cada día se calculara solo,
  // todos pedirían lo mismo y el plan mandaría de más semana tras semana.
  const enviados = t.agenda.map((d) => d.sabores[0].kgEnviar);
  assert.ok(enviados.some((k) => k === 0), 'algún día no hace falta mandar nada');
  assert.ok(enviados.some((k) => k > 0), 'y otros días sí');
  // Ningún envío puede superar el objetivo de ese día por más de una pana de redondeo.
  for (const d of t.agenda) {
    const s = d.sabores[0];
    assert.ok(s.kgEnviar <= s.kgObjetivo + s.gramosPana / 1000, `${d.fecha}: ${s.kgEnviar} kg contra objetivo ${s.kgObjetivo}`);
  }
});

test('sin pesaje reciente lo dice, y asume la vitrina en cero para no dejar corta a la tienda', () => {
  const t = armarRecomendacion({ despachos: repartoDiario(new Array(7).fill(9000)), hasta: fecha(83) }).tiendas[0];
  const s = t.agenda[0].sabores[0];

  assert.equal(t.pesajeDesde, null, 'no hay ninguna medición en que apoyarse');
  assert.equal(t.saboresSinPesaje, 1);
  assert.equal(s.stockMedido, false, 'la pantalla tiene que poder avisar que es un supuesto');
  assert.equal(s.kgStock, 0);
  assert.equal(s.kgEnviar, 12, 'sin stock conocido manda el objetivo completo: consumo + piso');
});

test('la agenda va con fecha y día concretos, no con "los jueves"', () => {
  const t = armarRecomendacion({ despachos: repartoDiario(new Array(7).fill(9000)), hasta: fecha(83) }).tiendas[0];
  assert.ok(t.agenda.length >= 7, 'cubre las próximas dos semanas de reparto');
  for (const d of t.agenda) {
    assert.match(d.fecha, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(d.diaSemana, diaSemanaDe(d.fecha));
    assert.ok(d.fecha > fecha(83), 'la agenda mira hacia adelante, no repite lo ya despachado');
  }
  const fechas = t.agenda.map((d) => d.fecha);
  assert.deepEqual(fechas, [...fechas].sort(), 'en orden cronológico');
});
