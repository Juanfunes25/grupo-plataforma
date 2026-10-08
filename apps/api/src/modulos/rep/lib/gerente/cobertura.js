import { diaSemanaDe, distribucionDeConteo, mediana, redondear, sumarDias, suma } from './nucleo.js';

/**
 * AUSENTISMO Y COBERTURA: ¿qué tienda se va a quedar corta de gente en los próximos días?
 *
 * Dos clases de aviso, que no se mezclan:
 *   · "Corto en el papel": con el horario y las vacaciones YA cargadas, van a faltar personas.
 *     No es una predicción, es aritmética: no hace falta que nadie falte.
 *   · "Riesgo": el horario alcanza, pero juntando la historia de faltas de cada persona, hay
 *     una probabilidad real de quedar corto. Esto sí es una estimación, y se dice con su número.
 *
 * El sistema propone (mover a alguien que le sobra a otra tienda, o consultar a quien tiene
 * franco), nunca ordena: mover gente es una decisión de personas, y es del dueño.
 */

export const DIAS_HISTORIA = 90;
const MIN_ENTRADAS_TIENDA = 20; // para creerle algo al sistema de marcación de una tienda
const MIN_FECHAS_HABITUAL = 4; // fechas del mismo día de la semana para hablar de "lo habitual"
const KAPPA_PERSONA = 8; // cuántos turnos de "experiencia previa" pesa la tasa de su tienda
const KAPPA_TIENDA = 20;
const KAPPA_DIA = 20;
const TASA_MINIMA = 0.02; // nadie tiene 0% de chance de faltar: un buen historial no es una garantía
const PRESENCIA_MINIMA = 0.1;
const UMBRAL_RIESGO = { alta: 0.5, media: 0.25, baja: 0.1 };
const UMBRAL_PRESTAR = 0.1; // a la tienda que "presta" gente no se le puede subir el riesgo más que esto

export const NOMBRES_DIA = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

const tiendaAbierta = (datos, id) => {
  const s = datos.sucursales.find((x) => x.id === id);
  return Boolean(s && s.activa && !(datos.cerradas || []).includes(id));
};
const nombreTienda = (datos, id) => datos.sucursales.find((s) => s.id === id)?.nombre || id;
const enVacaciones = (datos, empId, fecha) => datos.vacaciones.some((v) => v.empleado_id === empId && v.fecha_inicio <= fecha && fecha <= v.fecha_fin);
const estadoDelDia = (datos, empId, dow) => datos.horarios.find((h) => h.empleado_id === empId && h.dia_semana === dow)?.estado || null;
const limitar = (x, a, b) => Math.min(b, Math.max(a, x));

// ── 1. La historia: ¿cuánto falta cada persona? ────────────────────────────────────────────

/**
 * Para cada turno asignado que ya pasó, ¿hubo entrada? Solo se cuenta un día si hay con qué
 * compararlo (alguien de esa tienda marcó ese día): si nadie marcó, puede ser feriado, un
 * apagón o el teléfono, y acusar de falta ahí sería inventar.
 */
export function historiaDeAsistencia(datos) {
  const hasta = sumarDias(datos.hoy, -1);
  const desde = sumarDias(datos.hoy, -DIAS_HISTORIA);
  const entradas = datos.marcaciones.filter((m) => m.tipo === 'entrada' && m.fecha >= desde && m.fecha <= hasta);

  const porTienda = new Map(); // tienda → fecha → Set(empleados que entraron ahí)
  const porPersona = new Map(); // empleado → Set(fechas con entrada, en cualquier tienda)
  const entradasPorTienda = new Map();
  for (const m of entradas) {
    if (!porTienda.has(m.sucursal_id)) porTienda.set(m.sucursal_id, new Map());
    const dias = porTienda.get(m.sucursal_id);
    if (!dias.has(m.fecha)) dias.set(m.fecha, new Set());
    dias.get(m.fecha).add(m.empleado_id);
    if (!porPersona.has(m.empleado_id)) porPersona.set(m.empleado_id, new Set());
    porPersona.get(m.empleado_id).add(m.fecha);
    entradasPorTienda.set(m.sucursal_id, (entradasPorTienda.get(m.sucursal_id) || 0) + 1);
  }

  const personas = new Map();
  const porDia = Array.from({ length: 7 }, () => ({ turnos: 0, faltas: 0 }));
  let turnosTotal = 0;
  let faltasTotal = 0;

  for (const e of datos.empleados.filter((x) => x.activo && tiendaAbierta(datos, x.sucursal_id))) {
    const fechas = porPersona.get(e.id) || new Set();
    const ficha = { id: e.id, nombre: e.nombre, sucursal_id: e.sucursal_id, turnos: 0, faltas: 0, excluida: null, fechasFalta: [] };

    if (fechas.size === 0) ficha.excluida = 'no_marca';
    // Si viene seguido en los días que su horario dice "libre", el horario cargado no es el que
    // cumple: sus "faltas" serían falsas. (Trabajar un franco de vez en cuando es normal; por eso
    // se pide que haya venido a la mitad o más de sus días libres.)
    const evaluablesPropios = porTienda.get(e.sucursal_id) || new Map();
    let libres = 0;
    let libresConEntrada = 0;
    for (let f = desde; f <= hasta; f = sumarDias(f, 1)) {
      if (!evaluablesPropios.has(f) || estadoDelDia(datos, e.id, diaSemanaDe(f)) !== 'libre') continue;
      libres += 1;
      if (fechas.has(f)) libresConEntrada += 1;
    }
    if (!ficha.excluida && libresConEntrada >= 3 && libresConEntrada / libres >= 0.5) ficha.excluida = 'horario_desactualizado';

    if (!ficha.excluida) {
      const evaluables = porTienda.get(e.sucursal_id) || new Map();
      for (let f = desde; f <= hasta; f = sumarDias(f, 1)) {
        if (!evaluables.has(f)) continue;
        const dow = diaSemanaDe(f);
        if (estadoDelDia(datos, e.id, dow) !== 'turno') continue;
        if (enVacaciones(datos, e.id, f)) continue;
        if (e.fecha_ingreso && f < e.fecha_ingreso) continue;
        ficha.turnos += 1;
        porDia[dow].turnos += 1;
        if (!fechas.has(f)) { ficha.faltas += 1; porDia[dow].faltas += 1; ficha.fechasFalta.push(f); }
      }
      turnosTotal += ficha.turnos;
      faltasTotal += ficha.faltas;
    }
    personas.set(e.id, ficha);
  }
  return { personas, porDia, turnosTotal, faltasTotal, porTienda, entradasPorTienda, desde, hasta };
}

/** Tasas de falta: global, por tienda y por persona, cada una acercada a la de arriba si tiene poca muestra. */
export function tasasDeFalta(datos, historia) {
  const global = Math.max(TASA_MINIMA, historia.turnosTotal > 0 ? historia.faltasTotal / historia.turnosTotal : TASA_MINIMA);

  const tiendas = new Map();
  for (const f of historia.personas.values()) {
    if (f.excluida) continue;
    const t = tiendas.get(f.sucursal_id) || { turnos: 0, faltas: 0 };
    t.turnos += f.turnos; t.faltas += f.faltas;
    tiendas.set(f.sucursal_id, t);
  }
  const tasaTienda = new Map();
  for (const [id, t] of tiendas) tasaTienda.set(id, (t.faltas + KAPPA_TIENDA * global) / (t.turnos + KAPPA_TIENDA));

  const tasaPersona = new Map();
  for (const f of historia.personas.values()) {
    const previa = tasaTienda.get(f.sucursal_id) ?? global;
    tasaPersona.set(f.id, Math.max(TASA_MINIMA, (f.faltas + KAPPA_PERSONA * previa) / (f.turnos + KAPPA_PERSONA)));
  }

  // Los lunes o los sábados se falta distinto. Acotado: con poca muestra, un día no puede
  // "parecer" el doble de riesgoso por pura casualidad.
  const multiplicadorDia = historia.porDia.map((d) => limitar(((d.faltas + KAPPA_DIA * global) / (d.turnos + KAPPA_DIA)) / global, 0.5, 2));
  return { global, tasaTienda, tasaPersona, multiplicadorDia };
}

// ── 2. ¿Cuántos hacen falta? ─────────────────────────────────────────────────────────────────

/** Por tienda y día de la semana: lo que dijo el dueño, o lo habitual, o lo que dice la plantilla. */
export function minimosPorTienda(datos, historia, minimos = []) {
  const definidos = new Map(minimos.map((m) => [`${m.sucursal_id}|${m.dia_semana}`, Number(m.minimo)]));
  const resultado = new Map();

  for (const s of datos.sucursales.filter((x) => tiendaAbierta(datos, x.id))) {
    const equipo = datos.empleados.filter((e) => e.activo && e.sucursal_id === s.id);
    const dias = historia.porTienda.get(s.id) || new Map();
    const lista = [];
    for (let dow = 0; dow < 7; dow++) {
      const plantilla = equipo.filter((e) => estadoDelDia(datos, e.id, dow) === 'turno').length;
      const conteos = [];
      for (const [fecha, gente] of dias) if (diaSemanaDe(fecha) === dow) conteos.push(gente.size);
      const habitual = conteos.length >= MIN_FECHAS_HABITUAL ? Math.round(mediana(conteos)) : null;

      let valor; let fuente;
      const clave = `${s.id}|${dow}`;
      if (definidos.has(clave)) { valor = definidos.get(clave); fuente = 'definido'; }
      else if (habitual !== null) { valor = plantilla > 0 ? Math.min(habitual, plantilla) : habitual; fuente = 'habitual'; }
      else { valor = plantilla; fuente = 'plantilla'; }
      lista.push({ dia_semana: dow, nombre_dia: NOMBRES_DIA[dow], valor, fuente, habitual, plantilla, fechas_observadas: conteos.length });
    }
    resultado.set(s.id, lista);
  }
  return resultado;
}

// ── 3. El pronóstico ─────────────────────────────────────────────────────────────────────────

function personasProgramadas(datos, tiendaId, fecha) {
  const dow = diaSemanaDe(fecha);
  const programadas = [];
  const enVac = [];
  const prestadas = [];
  for (const e of datos.empleados.filter((x) => x.activo && x.sucursal_id === tiendaId)) {
    const estado = estadoDelDia(datos, e.id, dow);
    if (e.fecha_ingreso && fecha < e.fecha_ingreso) continue;
    if (enVacaciones(datos, e.id, fecha)) { if (estado === 'turno' || estado === 'vacaciones') enVac.push(e); continue; }
    if (estado === 'turno') programadas.push(e);
    else if (estado === 'otra_tienda') prestadas.push(e);
  }
  return { programadas, enVac, prestadas };
}

const probCorto = (probs, requeridos) => {
  if (requeridos <= 0) return 0;
  const dist = distribucionDeConteo(probs);
  return suma(dist.slice(0, requeridos)); // P(presentes < requeridos)
};

function nivelDeRiesgo(p) {
  if (p >= UMBRAL_RIESGO.alta) return 'alta';
  if (p >= UMBRAL_RIESGO.media) return 'media';
  if (p >= UMBRAL_RIESGO.baja) return 'baja';
  return 'ok';
}

/**
 * `datos`: el retrato del negocio con marcaciones de ~90 días. `minimos`: filas { sucursal_id,
 * dia_semana, minimo } que el dueño definió a mano.
 */
export function analizarCobertura(datos, { dias = 14, minimos = [] } = {}) {
  const historia = historiaDeAsistencia(datos);
  const tasas = tasasDeFalta(datos, historia);
  const minimosTienda = minimosPorTienda(datos, historia, minimos);
  const avisos = [];

  const personaPresencia = (e, dow) => {
    const tasa = tasas.tasaPersona.get(e.id) ?? tasas.global;
    return limitar(1 - tasa * tasas.multiplicadorDia[dow], PRESENCIA_MINIMA, 1);
  };

  const tiendas = [];
  for (const s of datos.sucursales.filter((x) => tiendaAbierta(datos, x.id))) {
    const equipo = datos.empleados.filter((e) => e.activo && e.sucursal_id === s.id);
    if (!equipo.length) continue;

    const entradas = historia.entradasPorTienda.get(s.id) || 0;
    const datosSuficientes = entradas >= MIN_ENTRADAS_TIENDA;
    const minimo = minimosTienda.get(s.id);
    const fichas = equipo.map((e) => historia.personas.get(e.id)).filter(Boolean);
    const sinMarcar = fichas.filter((f) => f.excluida === 'no_marca');
    const desactualizados = fichas.filter((f) => f.excluida === 'horario_desactualizado');

    const diasTienda = [];
    for (let i = 1; i <= dias; i++) {
      const fecha = sumarDias(datos.hoy, i);
      const dow = diaSemanaDe(fecha);
      const { programadas, enVac, prestadas } = personasProgramadas(datos, s.id, fecha);
      const req = minimo[dow].valor;
      if (req <= 0 && programadas.length === 0) continue; // tienda sin actividad prevista ese día

      const probs = programadas.map((e) => personaPresencia(e, dow));
      const esperados = suma(probs);
      const cortoEnPapel = programadas.length < req;
      const pCorto = datosSuficientes && !cortoEnPapel ? probCorto(probs, req) : null;

      const causas = [];
      if (cortoEnPapel) {
        if (enVac.length) causas.push(`${enVac.length === 1 ? 'Está' : 'Están'} de vacaciones: ${enVac.map((e) => e.nombre).join(', ')}.`);
        if (prestadas.length) causas.push(`${prestadas.map((e) => e.nombre).join(', ')} ${prestadas.length === 1 ? 'figura' : 'figuran'} en otra tienda ese día.`);
        const libres = equipo.filter((e) => estadoDelDia(datos, e.id, dow) === 'libre');
        if (libres.length) causas.push(`Con franco ese día: ${libres.map((e) => e.nombre).join(', ')}.`);
        if (!causas.length) causas.push('El horario cargado tiene menos gente de la que suele atender ese día.');
      }

      const nivel = cortoEnPapel ? 'alta' : (pCorto === null ? 'ok' : nivelDeRiesgo(pCorto));
      diasTienda.push({
        fecha, dia_semana: dow, nombre_dia: NOMBRES_DIA[dow],
        requeridos: req, fuente_minimo: minimo[dow].fuente,
        programados: programadas.map((e) => e.nombre),
        en_vacaciones: enVac.map((e) => e.nombre),
        esperados_presentes: redondear(esperados, 1),
        corto_en_papel: cortoEnPapel,
        prob_corto_pct: pCorto === null ? null : redondear(pCorto * 100, 0),
        nivel, causas, sugerencias: [],
        _programadas: programadas, _probs: probs,
      });
    }

    tiendas.push({
      sucursal_id: s.id, nombre: nombreTienda(datos, s.id),
      personas: equipo.length,
      datos_suficientes: datosSuficientes, entradas_90d: entradas,
      sin_marcar: sinMarcar.map((f) => f.nombre),
      horario_desactualizado: desactualizados.map((f) => f.nombre),
      minimo_por_dia: minimo,
      tasa_falta_pct: redondear((tasas.tasaTienda.get(s.id) ?? tasas.global) * 100, 1),
      dias: diasTienda,
    });
    if (!datosSuficientes) avisos.push(`${nombreTienda(datos, s.id)}: casi no se usa el sistema de marcación (${entradas} entradas en 90 días), así que solo se avisa lo que ya se ve en el horario y las vacaciones, no el riesgo por faltas.`);
    if (sinMarcar.length) avisos.push(`${nombreTienda(datos, s.id)}: ${sinMarcar.map((f) => f.nombre).join(', ')} no ${sinMarcar.length === 1 ? 'marca' : 'marcan'} nunca; para ${sinMarcar.length === 1 ? 'esa persona' : 'esas personas'} se usó la tasa de su tienda, no su historia.`);
    if (desactualizados.length) avisos.push(`${nombreTienda(datos, s.id)}: ${desactualizados.map((f) => f.nombre).join(', ')} ${desactualizados.length === 1 ? 'marca' : 'marcan'} seguido en días que su horario dice libre. El horario cargado parece desactualizado; no se contaron sus faltas.`);
  }

  sugerir(datos, tiendas, personaPresencia);

  for (const t of tiendas) for (const d of t.dias) { delete d._programadas; delete d._probs; }

  const alertas = tiendas
    .flatMap((t) => t.dias.filter((d) => d.nivel !== 'ok').map((d) => ({ sucursal_id: t.sucursal_id, tienda: t.nombre, ...d })))
    .sort((a, b) => a.fecha.localeCompare(b.fecha) || (b.corto_en_papel - a.corto_en_papel));

  const ficha = (f) => ({ id: f.id, nombre: f.nombre, sucursal_id: f.sucursal_id, turnos: f.turnos, faltas: f.faltas, excluida: f.excluida });
  return {
    hoy: datos.hoy,
    desde: sumarDias(datos.hoy, 1), hasta: sumarDias(datos.hoy, dias), dias,
    resumen: {
      alertas: alertas.length,
      en_papel: alertas.filter((a) => a.corto_en_papel).length,
      riesgo: alertas.filter((a) => !a.corto_en_papel).length,
      tiendas_revisadas: tiendas.length,
    },
    alertas, tiendas,
    historia: {
      dias: DIAS_HISTORIA, turnos_evaluados: historia.turnosTotal, faltas: historia.faltasTotal,
      tasa_global_pct: redondear(tasas.global * 100, 1),
      por_dia_semana: tasas.multiplicadorDia.map((m, j) => ({ dia_semana: j, nombre: NOMBRES_DIA[j], multiplicador: redondear(m, 2) })),
      personas: [...historia.personas.values()].map(ficha),
    },
    avisos,
    metodo: 'Cada día futuro se arma con el horario semanal y las vacaciones ya cargadas. "Corto en el papel" es cuenta directa. El riesgo usa la historia de faltas de los últimos 90 días (solo turnos asignados en días en que alguien de esa tienda marcó), acercando a cada persona al promedio de su tienda cuando tiene pocos turnos, y calcula la probabilidad de que vengan menos personas de las necesarias. Lo que dice cuántos hacen falta es lo habitual de cada día, salvo que vos lo definas.',
  };
}

// ── 4. Qué se podría hacer ───────────────────────────────────────────────────────────────────

/**
 * Para cada día con alerta: de dónde podría salir gente. Se prefiere mover a alguien de una
 * tienda a la que le sobra (sin que a esa le suba el riesgo) antes que pedirle a alguien que
 * cambie su franco. Son propuestas para consultar, no órdenes.
 */
function sugerir(datos, tiendas, personaPresencia) {
  const porId = new Map(tiendas.map((t) => [t.sucursal_id, t]));
  const usados = new Set(); // `${fecha}|${empleado}`: una persona no se promete dos veces el mismo día

  for (const t of tiendas) {
    for (const d of t.dias) {
      if (d.nivel === 'ok' || d.nivel === 'baja') continue;
      const falta = Math.max(1, d.requeridos - d.programados.length);
      const sugerencias = [];

      // a) Tiendas a las que les sobra gente ese día.
      for (const otra of tiendas) {
        if (otra.sucursal_id === t.sucursal_id) continue;
        const od = otra.dias.find((x) => x.fecha === d.fecha);
        if (!od || od.nivel === 'alta' || od.nivel === 'media' || od.programados.length <= od.requeridos) continue;
        // ¿Quién se puede ir con el menor riesgo para la tienda que lo presta?
        let mejor = null;
        od._programadas.forEach((e, i) => {
          if (usados.has(`${d.fecha}|${e.id}`)) return;
          const resto = od._probs.filter((_, k) => k !== i);
          const riesgo = otra.datos_suficientes ? probCorto(resto, od.requeridos) : (resto.length < od.requeridos ? 1 : 0);
          if (!mejor || riesgo < mejor.riesgo) mejor = { e, riesgo };
        });
        if (mejor && mejor.riesgo <= UMBRAL_PRESTAR) {
          sugerencias.push({
            tipo: 'mover', empleado: mejor.e.nombre, desde: otra.nombre,
            texto: `Consultar si ${mejor.e.nombre} puede cubrir en ${t.nombre}: en ${otra.nombre} ese día sobran (${od.programados.length} programados, hacen falta ${od.requeridos}).`,
            riesgo_en_origen_pct: redondear(mejor.riesgo * 100, 0),
            _id: mejor.e.id,
          });
        }
      }

      // b) Gente con franco ese día (de esta tienda primero).
      const libres = datos.empleados
        .filter((e) => e.activo && tiendaAbierta(datos, e.sucursal_id) && estadoDelDia(datos, e.id, d.dia_semana) === 'libre')
        .filter((e) => !(e.fecha_ingreso && d.fecha < e.fecha_ingreso) && !enVacaciones(datos, e.id, d.fecha))
        .sort((a, b) => (b.sucursal_id === t.sucursal_id) - (a.sucursal_id === t.sucursal_id) || personaPresencia(b, d.dia_semana) - personaPresencia(a, d.dia_semana));
      for (const e of libres) {
        if (sugerencias.length >= 4) break;
        if (usados.has(`${d.fecha}|${e.id}`)) continue;
        const propia = e.sucursal_id === t.sucursal_id;
        sugerencias.push({
          tipo: 'franco', empleado: e.nombre, desde: porId.get(e.sucursal_id)?.nombre || e.sucursal_id,
          texto: `${e.nombre}${propia ? '' : ` (de ${porId.get(e.sucursal_id)?.nombre || e.sucursal_id})`} tiene franco ese día: se le podría pedir que cambie su día libre.`,
          riesgo_en_origen_pct: null,
          _id: e.id,
        });
      }

      const elegidas = [...sugerencias.filter((x) => x.tipo === 'mover').slice(0, 2), ...sugerencias.filter((x) => x.tipo === 'franco')].slice(0, 3);
      for (const x of elegidas) if (elegidas.indexOf(x) < falta + 1) usados.add(`${d.fecha}|${x._id}`);
      d.sugerencias = elegidas.map(({ _id, ...resto }) => resto);
    }
  }
}
