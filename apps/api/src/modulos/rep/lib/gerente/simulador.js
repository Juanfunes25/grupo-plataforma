import { normalCdf, redondear, suma, sumarDias } from './nucleo.js';

/**
 * EL GEMELO DIGITAL: una réplica en números del reparto, para preguntarle "¿y si...?" sin
 * tocar nada de la operación real.
 *
 * No inventa un modelo nuevo: usa el MISMO que ya decide las cantidades del despacho (demanda
 * base por sabor, perfil de la semana, dispersión, colchón y piso de vitrina). Así, "hoy" en el
 * simulador es lo mismo que el sistema ya recomienda, y lo único que cambia entre "antes" y
 * "después" es lo que el dueño preguntó.
 *
 * Qué NO es: una predicción exacta. Es una estimación del modelo, y cada resultado trae la
 * precisión histórica del modelo y avisos cuando se apoya en suposiciones.
 */

export const NOMBRES_DIA = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const CORTOS = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];

// Los mismos parámetros que el recomendador de despacho (lib/recomendacionDespacho.js).
const Z = 1.04;
const Z_APRETADO = 1.55;
const TOPE_COLCHON = 0.2;
const TOPE_COLCHON_APRETADO = 0.35;

/** Si el modelo, con el reparto de hoy, se aleja más que esto de lo realmente enviado, se avisa. */
const DESVIO_CALIBRACION = 0.25;

export class ErrorDeSimulacion extends Error {}

// ── base: el retrato de hoy ─────────────────────────────────────────────────────────────────

/**
 * Condensa la recomendación de despacho en lo que el simulador necesita por tienda.
 * `realSemanalKg`: Map sucursal_id → kg/semana realmente enviados (para verificar el modelo).
 * `costosPorSabor`: Map sabor_id → costo por kg del lote (o null si no hay receta/precios).
 */
export function armarBase({ recomendacion, costosPorSabor = new Map(), realSemanalKg = new Map() }) {
  const tiendas = [];
  for (const t of recomendacion.tiendas || []) {
    const perfil = Array.from({ length: 7 }, (_, j) => t.perfilSemanal?.find((p) => p.diaSemana === j)?.factor ?? 1);
    const sabores = new Map();
    for (const d of t.dias || []) {
      for (const s of d.sabores || []) {
        if (!(s.gramosBaseDia > 0)) continue;
        const previo = sabores.get(s.sabor_id);
        sabores.set(s.sabor_id, {
          sabor_id: s.sabor_id,
          nombre: s.nombre,
          tasa: s.gramosBaseDia,
          sigma: s.sigmaDiaGramos,
          gramosPana: s.gramosPana,
          pisoG: Math.max(previo?.pisoG || 0, Math.round((s.kgPiso || 0) * 1000)),
          apretado: Boolean(previo?.apretado) || s.nivelServicio >= 94,
          muestras: s.muestras,
          confianza: s.confianza,
        });
      }
    }
    if (!sabores.size) continue;
    const base = {
      sucursal_id: t.sucursal_id,
      nombre: t.nombre,
      perfil,
      diasReparto: (t.dias || []).map((d) => d.diaSemana).sort((a, b) => a - b),
      sabores: [...sabores.values()],
      precision: t.precision || null,
      visitas: t.visitas,
      real_kg_semana: realSemanalKg.get(t.sucursal_id) ?? null,
    };
    tiendas.push(base);
  }
  return { tiendas, costosPorSabor, excluidas: recomendacion.excluidas || [], hoy: recomendacion.hoy };
}

// ── el modelo de una tienda ─────────────────────────────────────────────────────────────────

/** Las ventanas que cubre cada viaje: desde su día hasta el día antes del siguiente viaje. */
export function ventanasDe(dias) {
  const orden = [...new Set(dias)].sort((a, b) => a - b);
  if (!orden.length) throw new ErrorDeSimulacion('Hace falta al menos un día de reparto');
  return orden.map((d, i) => {
    const siguiente = orden[(i + 1) % orden.length];
    const largo = orden.length === 1 ? 7 : ((siguiente - d + 7) % 7) || 7;
    return { dia: d, dias: Array.from({ length: largo }, (_, k) => (d + k) % 7) };
  });
}

/**
 * Una tienda, con un reparto y un nivel de demanda dados.
 * Por cada viaje y sabor: se manda lo que se espera consumir en la ventana (flujo), más un
 * colchón por si la demanda sale alta, más el piso de vitrina. Justo antes del siguiente
 * camión queda colchón + piso; recién llegado el camión hay todo.
 */
export function simularTienda(tienda, { dias, demanda = 1, costosPorSabor = new Map() }) {
  if (demanda <= 0) return tiendaCerrada(tienda);
  const ventanas = ventanasDe(dias);
  const perfil = tienda.perfil;
  const porDiaKg = Array(7).fill(0);
  const porSabor = [];
  let invPonderado = 0; // kg·día
  let kgSemana = 0;
  let riesgoPonderado = 0;
  let pesoRiesgo = 0;
  let pico = { kg: 0, dia: null };

  for (const s of tienda.sabores) {
    let kgSabor = 0;
    let invSabor = 0;
    for (const v of ventanas) {
      const sumaPerfil = suma(v.dias.map((j) => perfil[j]));
      const sumaPerfil2 = suma(v.dias.map((j) => perfil[j] ** 2));
      const esperado = s.tasa * demanda * sumaPerfil;
      const sigmaVentana = s.sigma * demanda * Math.sqrt(sumaPerfil2);
      const z = s.apretado ? Z_APRETADO : Z;
      const tope = (s.apretado ? TOPE_COLCHON_APRETADO : TOPE_COLCHON) * esperado;
      const colchon = Math.min(z * sigmaVentana, tope);
      const piso = s.pisoG;

      // Inventario medio en vitrina durante la ventana: baja de a poco de (todo) a (colchón+piso).
      const inventarioMedio = piso + colchon + esperado / 2;
      invSabor += (inventarioMedio / 1000) * v.dias.length;
      kgSabor += esperado / 1000;
      porDiaKg[v.dia] += esperado / 1000;
      if (esperado / 1000 > pico.kg) pico = { kg: esperado / 1000, dia: v.dia };

      if (sigmaVentana > 0) {
        riesgoPonderado += (1 - normalCdf(colchon / sigmaVentana)) * esperado;
        pesoRiesgo += esperado;
      }
    }
    kgSemana += kgSabor;
    invPonderado += invSabor;
    const kgKilo = costosPorSabor.get(s.sabor_id);
    porSabor.push({ sabor_id: s.sabor_id, nombre: s.nombre, kg_semana: kgSabor, costo_kg: kgKilo ?? null });
  }

  const inventarioKg = invPonderado / 7;
  const kgDia = kgSemana / 7;
  const sinCosto = porSabor.filter((s) => s.costo_kg === null).reduce((a, s) => a + s.kg_semana, 0);
  const costoSemana = suma(porSabor.map((s) => (s.costo_kg === null ? 0 : s.kg_semana * s.costo_kg)));
  const valorVitrina = suma(tienda.sabores.map((s, i) => {
    const c = porSabor[i].costo_kg;
    if (c === null) return 0;
    // proporción del inventario medio que corresponde a este sabor
    return c * (kgSemana > 0 ? inventarioKg * (porSabor[i].kg_semana / kgSemana) : 0);
  }));

  return {
    abierta: true,
    dias_reparto: ventanas.map((v) => v.dia),
    viajes_semana: ventanas.length,
    kg_semana: redondear(kgSemana, 1),
    kg_por_viaje: redondear(kgSemana / ventanas.length, 1),
    kg_viaje_mayor: redondear(pico.kg, 1),
    dia_viaje_mayor: pico.dia,
    kg_por_dia: porDiaKg.map((k) => redondear(k, 1)),
    inventario_vitrina_kg: redondear(inventarioKg, 1),
    edad_dias: kgDia > 0 ? redondear(inventarioKg / kgDia, 2) : null,
    riesgo_agotarse_pct: pesoRiesgo > 0 ? redondear((riesgoPonderado / pesoRiesgo) * 100, 0) : null,
    costo_semana: redondear(costoSemana, 0),
    valor_vitrina: redondear(valorVitrina, 0),
    kg_sin_costo: redondear(sinCosto, 1),
    por_sabor: porSabor.map((s) => ({ ...s, kg_semana: redondear(s.kg_semana, 1) })),
    _crudo: { kgSemana, inventarioKg, costoSemana, valorVitrina, sinCosto, porDiaKg },
  };
}

function tiendaCerrada(tienda) {
  return {
    abierta: false, dias_reparto: [], viajes_semana: 0, kg_semana: 0, kg_por_viaje: 0, kg_viaje_mayor: 0, dia_viaje_mayor: null,
    kg_por_dia: Array(7).fill(0), inventario_vitrina_kg: 0, edad_dias: null, riesgo_agotarse_pct: null,
    costo_semana: 0, valor_vitrina: 0, kg_sin_costo: 0, por_sabor: [],
    _crudo: { kgSemana: 0, inventarioKg: 0, costoSemana: 0, valorVitrina: 0, sinCosto: 0, porDiaKg: Array(7).fill(0) },
  };
}

/** Todas las formas de elegir `n` días de 7, y cuál deja el producto más fresco. */
export function mejoresDias(tienda, n, { demanda = 1, costosPorSabor = new Map() } = {}) {
  if (!Number.isInteger(n) || n < 1 || n > 7) throw new ErrorDeSimulacion('La cantidad de días tiene que estar entre 1 y 7');
  const combos = [];
  const armar = (desde, actual) => {
    if (actual.length === n) { combos.push([...actual]); return; }
    for (let d = desde; d < 7; d++) { actual.push(d); armar(d + 1, actual); actual.pop(); }
  };
  armar(0, []);
  return combos
    .map((dias) => {
      const r = simularTienda(tienda, { dias, demanda, costosPorSabor });
      return { dias, edad_dias: r.edad_dias, pico_kg: r.kg_viaje_mayor, inventario_kg: r.inventario_vitrina_kg };
    })
    .sort((a, b) => (a.edad_dias - b.edad_dias) || (a.pico_kg - b.pico_kg));
}

// ── escenarios ──────────────────────────────────────────────────────────────────────────────

const nombreDias = (dias) => dias.map((d) => NOMBRES_DIA[d]).join(', ');

/**
 * `cambios`: lista de
 *   { tipo: 'dias_reparto', sucursal_id, dias: [0..6] }  ó  { ..., cantidad: 3 } (elige los mejores)
 *   { tipo: 'demanda', sucursal_id | 'todas', porcentaje }   (-100 = cerrar)
 *   { tipo: 'tienda_nueva', como: sucursal_id, porcentaje?, dias?, nombre? }
 */
export function simular(base, cambios) {
  if (!Array.isArray(cambios) || !cambios.length) throw new ErrorDeSimulacion('No hay nada que simular: falta indicar un cambio');
  const costos = base.costosPorSabor;
  const porId = new Map(base.tiendas.map((t) => [t.sucursal_id, t]));
  const buscar = (id) => {
    const t = porId.get(id);
    if (!t) throw new ErrorDeSimulacion(`No tengo datos de reparto de "${id}"`);
    return t;
  };

  // Estado "después" por tienda, partiendo de hoy.
  const despues = new Map(base.tiendas.map((t) => [t.sucursal_id, { tienda: t, dias: t.diasReparto, demanda: 1, nueva: false }]));
  const supuestos = [];
  const avisos = [];
  const explicaciones = [];

  for (const c of cambios) {
    if (c.tipo === 'dias_reparto') {
      const t = buscar(c.sucursal_id);
      const estado = despues.get(t.sucursal_id);
      if (Array.isArray(c.dias) && c.dias.length) {
        const dias = [...new Set(c.dias.map(Number))].sort((a, b) => a - b);
        if (dias.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new ErrorDeSimulacion('Día de reparto inválido');
        estado.dias = dias;
      } else if (c.cantidad) {
        const ranking = mejoresDias(t, Number(c.cantidad), { demanda: estado.demanda, costosPorSabor: costos });
        estado.dias = ranking[0].dias;
        explicaciones.push(`Para ${t.nombre} con ${c.cantidad} día(s) de reparto, los días que dejan el helado más fresco son ${nombreDias(ranking[0].dias)}.`);
      } else {
        throw new ErrorDeSimulacion('Falta indicar los días de reparto o cuántos días');
      }
    } else if (c.tipo === 'demanda') {
      const pct = Number(c.porcentaje);
      if (!Number.isFinite(pct) || pct < -100 || pct > 300) throw new ErrorDeSimulacion('El porcentaje de demanda tiene que estar entre -100 y 300');
      const objetivos = c.sucursal_id === 'todas' || !c.sucursal_id ? [...despues.keys()] : [buscar(c.sucursal_id).sucursal_id];
      for (const id of objetivos) despues.get(id).demanda *= 1 + pct / 100;
      supuestos.push(`La demanda ${pct >= 0 ? 'sube' : 'baja'} ${Math.abs(pct)}% parejo en todos los días y sabores${pct < 0 ? ' (en la realidad suele bajar más los días flojos)' : ''}.`);
    } else if (c.tipo === 'tienda_nueva') {
      const modelo = buscar(c.como);
      const factor = c.porcentaje === undefined || c.porcentaje === null ? 1 : Number(c.porcentaje) / 100;
      if (!(factor > 0) || factor > 3) throw new ErrorDeSimulacion('La tienda nueva tiene que vender entre 1% y 300% de la tienda modelo');
      const id = `nueva-${[...despues.keys()].filter((k) => k.startsWith('nueva-')).length + 1}`;
      const dias = Array.isArray(c.dias) && c.dias.length ? [...new Set(c.dias.map(Number))].sort((a, b) => a - b) : modelo.diasReparto;
      despues.set(id, {
        tienda: { ...modelo, sucursal_id: id, nombre: c.nombre || `Tienda nueva (como ${modelo.nombre})`, precision: null, real_kg_semana: null },
        dias, demanda: factor, nueva: true,
      });
      supuestos.push(`La tienda nueva venderá como ${modelo.nombre}${factor === 1 ? '' : ` al ${Math.round(factor * 100)}%`}, con sus mismos sabores y días fuertes. Es una suposición: no hay historia propia.`);
    } else {
      throw new ErrorDeSimulacion(`No sé simular "${c.tipo}"`);
    }
  }

  const tiendas = [];
  for (const [id, e] of despues) {
    const antes = e.nueva ? tiendaCerrada(e.tienda) : simularTienda(e.tienda, { dias: e.tienda.diasReparto, costosPorSabor: costos });
    const luego = simularTienda(e.tienda, { dias: e.dias, demanda: e.demanda, costosPorSabor: costos });
    const cambio = e.nueva || e.demanda !== 1 || e.dias.join() !== e.tienda.diasReparto.join();
    tiendas.push({
      sucursal_id: id, nombre: e.tienda.nombre, nueva: e.nueva, cambia: cambio,
      dias_antes: e.nueva ? [] : e.tienda.diasReparto, dias_despues: luego.dias_reparto,
      antes: publico(antes), despues: publico(luego),
      precision: e.tienda.precision,
      confianza_sabores: e.tienda.sabores.some((s) => s.confianza === 'baja') ? 'baja' : 'normal',
    });
  }

  const sumas = resumirTotales(despues, costos);

  // Avisos del propio modelo: cada uno nace de una verificación, no de un presentimiento.
  for (const t of tiendas) {
    if (t.nueva) continue;
    const b = base.tiendas.find((x) => x.sucursal_id === t.sucursal_id);
    if (b?.real_kg_semana > 0 && t.antes.kg_semana > 0) {
      const desvio = (t.antes.kg_semana - b.real_kg_semana) / b.real_kg_semana;
      t.calibracion = { modelo_kg: t.antes.kg_semana, real_kg: redondear(b.real_kg_semana, 1), desvio_pct: redondear(desvio * 100, 0) };
      if (Math.abs(desvio) > DESVIO_CALIBRACION && t.cambia) {
        avisos.push(`Para ${t.nombre}, el modelo con el reparto de hoy da ${t.antes.kg_semana} kg/semana y en las últimas 4 semanas se enviaron ${redondear(b.real_kg_semana, 1)} kg. No se ajusta bien, tomá estos números con más cautela.`);
      }
    }
    if (t.cambia && (t.precision === null || t.precision.errorMedioPct > 25)) {
      avisos.push(`Para ${t.nombre} el modelo tiene poca historia o error alto (${t.precision ? `${t.precision.errorMedioPct}% de error medio` : 'sin medición'}): el resultado es una orientación, no una cifra firme.`);
    }
    if (t.cambia && t.confianza_sabores === 'baja') avisos.push(`En ${t.nombre} hay sabores con pocas muestras: esos números son los menos firmes.`);
    if (t.cambia && t.antes.kg_sin_costo + t.despues.kg_sin_costo > 0 && t.despues.kg_sin_costo > 0) {
      avisos.push(`En ${t.nombre} hay ${t.despues.kg_sin_costo} kg/semana de sabores sin receta o precios completos: el costo está subestimado.`);
    }
  }
  if (tiendas.some((t) => t.nueva && t.despues.kg_sin_costo > 0)) avisos.push('La tienda nueva incluye sabores sin costo completo: el costo está subestimado.');

  const lecturas = lecturasDe(tiendas, sumas);
  const baja = avisos.length > 0 || tiendas.some((t) => t.cambia && (t.nueva || t.precision === null || t.precision.errorMedioPct > 25));

  return {
    hoy: base.hoy,
    tiendas, totales: sumas, lecturas, explicaciones, supuestos,
    avisos: [...new Set(avisos)],
    confianza: baja ? 'orientativa' : 'razonable',
    metodo: 'Es una estimación del modelo que ya usa el sistema para sugerir cantidades de despacho (demanda por sabor, perfil de la semana, colchón y piso de vitrina). Mantiene el mismo nivel de servicio; lo que cambia es cuántos viajes, cuánto producto y cuánto tiempo pasa en vitrina.',
  };
}

function publico(r) {
  const { _crudo, ...resto } = r;
  return resto;
}

function resumirTotales(despues, costos) {
  const lados = { antes: [], despues: [] };
  const diasCamion = { antes: new Set(), despues: new Set() };
  for (const e of despues.values()) {
    if (!e.nueva) {
      lados.antes.push(simularTienda(e.tienda, { dias: e.tienda.diasReparto, costosPorSabor: costos }));
      e.tienda.diasReparto.forEach((d) => diasCamion.antes.add(d));
    }
    const d = simularTienda(e.tienda, { dias: e.dias, demanda: e.demanda, costosPorSabor: costos });
    lados.despues.push(d);
    d.dias_reparto.forEach((x) => diasCamion.despues.add(x));
  }
  const total = (lista, dias) => {
    const kgSemana = suma(lista.map((r) => r._crudo.kgSemana));
    const inv = suma(lista.map((r) => r._crudo.inventarioKg));
    const kgPorDia = Array.from({ length: 7 }, (_, j) => suma(lista.map((r) => r._crudo.porDiaKg[j])));
    return {
      viajes_semana: suma(lista.map((r) => r.viajes_semana)),
      dias_de_camion: dias.size,
      kg_semana: redondear(kgSemana, 1),
      kg_por_dia: kgPorDia.map((k) => redondear(k, 1)),
      kg_dia_mayor: redondear(Math.max(...kgPorDia), 1),
      dia_mayor: kgPorDia.indexOf(Math.max(...kgPorDia)),
      inventario_vitrina_kg: redondear(inv, 1),
      edad_dias: kgSemana > 0 ? redondear(inv / (kgSemana / 7), 2) : null,
      costo_semana: redondear(suma(lista.map((r) => r._crudo.costoSemana)), 0),
      valor_vitrina: redondear(suma(lista.map((r) => r._crudo.valorVitrina)), 0),
      kg_sin_costo: redondear(suma(lista.map((r) => r._crudo.sinCosto)), 1),
    };
  };
  return { antes: total(lados.antes, diasCamion.antes), despues: total(lados.despues, diasCamion.despues) };
}

const signo = (n) => (n > 0 ? `+${n}` : `${n}`);

/** Frases cortas para el dueño: solo lo que de verdad cambió. */
function lecturasDe(tiendas, { antes, despues }) {
  const L = [];
  const dif = (a, b, dec = 1) => redondear(b - a, dec);
  if (despues.kg_semana !== antes.kg_semana) {
    const d = dif(antes.kg_semana, despues.kg_semana);
    L.push({ tema: 'produccion', texto: `Producción: ${antes.kg_semana} → ${despues.kg_semana} kg por semana (${signo(d)} kg).`, peso: Math.abs(d) });
  }
  if (despues.costo_semana !== antes.costo_semana) {
    L.push({ tema: 'costo', texto: `Costo de producir: L ${antes.costo_semana} → L ${despues.costo_semana} por semana (${signo(dif(antes.costo_semana, despues.costo_semana, 0))}).`, peso: 1 });
  }
  if (despues.viajes_semana !== antes.viajes_semana) {
    L.push({ tema: 'viajes', texto: `Viajes de reparto: ${antes.viajes_semana} → ${despues.viajes_semana} por semana. Días con camión en la calle: ${antes.dias_de_camion} → ${despues.dias_de_camion}.`, peso: 1 });
  }
  if (despues.edad_dias !== antes.edad_dias && despues.edad_dias !== null && antes.edad_dias !== null) {
    const mejor = despues.edad_dias < antes.edad_dias;
    L.push({ tema: 'frescura', texto: `Frescura: el helado pasa ${antes.edad_dias} → ${despues.edad_dias} días en vitrina en promedio (${mejor ? 'más fresco' : 'más viejo'}).`, peso: 1 });
  }
  if (despues.kg_dia_mayor !== antes.kg_dia_mayor) {
    L.push({ tema: 'pico', texto: `El día de mayor carga pasa de ${antes.kg_dia_mayor} kg (${CORTOS[antes.dia_mayor]}) a ${despues.kg_dia_mayor} kg (${CORTOS[despues.dia_mayor]}).`, peso: 1 });
  }
  for (const t of tiendas.filter((x) => x.cambia && !x.nueva && x.antes.kg_por_viaje !== x.despues.kg_por_viaje && x.despues.abierta)) {
    L.push({ tema: 'viaje_tienda', texto: `${t.nombre}: cada viaje lleva ${t.antes.kg_por_viaje} → ${t.despues.kg_por_viaje} kg.`, peso: 0 });
  }
  return L;
}

// ── de la base de datos ─────────────────────────────────────────────────────────────────────

/** Lo que la pantalla necesita para armar el formulario y mostrar "cómo estás hoy". */
export function resumenDeBase(base) {
  return {
    hoy: base.hoy,
    excluidas: base.excluidas,
    dias: NOMBRES_DIA,
    tiendas: base.tiendas.map((t) => {
      const hoyModelo = simularTienda(t, { dias: t.diasReparto, costosPorSabor: base.costosPorSabor });
      const calibracion = t.real_kg_semana > 0
        ? { modelo_kg: hoyModelo.kg_semana, real_kg: redondear(t.real_kg_semana, 1), desvio_pct: redondear(((hoyModelo.kg_semana - t.real_kg_semana) / t.real_kg_semana) * 100, 0) }
        : null;
      return {
        sucursal_id: t.sucursal_id, nombre: t.nombre, dias_reparto: t.diasReparto,
        kg_semana: hoyModelo.kg_semana, edad_dias: hoyModelo.edad_dias, viajes_semana: hoyModelo.viajes_semana,
        sabores: t.sabores.length, precision: t.precision, calibracion,
      };
    }),
  };
}
