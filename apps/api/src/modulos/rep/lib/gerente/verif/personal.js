import {
  GRAVEDAD, NIVEL, agruparPor, compuerta, crearHallazgo, diaSemanaDe, diasDistintos, diasEntre, fechaCorta, mediana,
  nivelSegunCompuertas, plural, redondear, resultado, sinDatos, sumarDias, suma,
} from '../nucleo.js';
import { turnosDeMarcaciones } from '../../reporteAsistencia.js';
import { horaAMinutos } from '../../asistencia.js';
import { minutosDelDia } from '../../fechaNegocio.js';
import { resumenVacaciones } from '../../vacaciones.js';

const AREA = 'personal';
const DIAS_VENTANA = 30;

const nombreTienda = (datos, id) => datos.sucursales.find((s) => s.id === id)?.nombre || id;
const tiendaAbierta = (datos, id) => {
  const s = datos.sucursales.find((x) => x.id === id);
  return Boolean(s && s.activa && !(datos.cerradas || []).includes(id));
};

export const empleadosActivos = (datos) => datos.empleados.filter((e) => e.activo && tiendaAbierta(datos, e.sucursal_id));
const ventana = (datos) => sumarDias(datos.hoy, -DIAS_VENTANA);

/** Las marcaciones de un empleado en la ventana, listas para armar turnos. */
function marcacionesDe(datos, empleadoId) {
  const desde = ventana(datos);
  return datos.marcaciones.filter((m) => m.empleado_id === empleadoId && m.fecha >= desde && m.fecha <= datos.hoy);
}

/** El horario cargado de un empleado para un día de la semana, o null. */
function horarioDe(datos, empleadoId, diaSemana) {
  return datos.horarios.find((h) => h.empleado_id === empleadoId && h.dia_semana === diaSemana) || null;
}

function enVacaciones(datos, empleadoId, fecha) {
  return datos.vacaciones.some((v) => v.empleado_id === empleadoId && v.fecha_inicio <= fecha && fecha <= v.fecha_fin);
}

/** Horas que dura el turno programado ("10:00" a "21:00" = 11). Cruza la medianoche si hace falta. */
function horasProgramadas(h) {
  const ini = horaAMinutos(h.hora_inicio);
  const fin = horaAMinutos(h.hora_fin);
  if (ini === null || fin === null) return null;
  return (fin >= ini ? fin - ini : fin + 24 * 60 - ini) / 60;
}

/** Minutos desde la medianoche, hora de Honduras, de una marcación guardada en UTC. */
function minutosLocales(creadoEn) {
  const d = new Date(`${String(creadoEn).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : minutosDelDia(d);
}

// ──────────────────────────────────────────────────────────────────────────────────────────

const BASE_LUGAR = {
  id: 'marcaciones_fuera_de_lugar',
  nombre: 'Marcaciones lejos del local',
  area: AREA,
};

/**
 * Cuando alguien marca "lejos", hay dos explicaciones muy distintas: que esa persona marcó
 * desde afuera, o que la UBICACIÓN DE LA TIENDA está mal cargada y por eso todos marcan lejos.
 * Acusar a una persona por un problema de configuración es el peor error posible acá.
 *
 * Por eso primero se mira la tienda entera. Si casi todos marcan lejos, el problema es el
 * punto del mapa; solo si el resto marca dentro y UNA persona marca afuera, es de esa persona.
 */
export function marcacionesFueraDeLugar(datos) {
  const desde = ventana(datos);
  const medidas = datos.marcaciones.filter((m) => m.fecha >= desde && ['dentro', 'lejos'].includes(m.verificacion));
  if (medidas.length < 12) return sinDatos(BASE_LUGAR, 'Hay muy pocas marcaciones con ubicación verificada en los últimos 30 días.');

  const hallazgos = [];
  let evaluadas = 0;
  for (const [sucursalId, lista] of agruparPor(medidas, (m) => m.sucursal_id)) {
    if (!tiendaAbierta(datos, sucursalId) || lista.length < 12) continue;
    evaluadas += 1;
    const tienda = nombreTienda(datos, sucursalId);
    const lejos = lista.filter((m) => m.verificacion === 'lejos');
    const tasa = lejos.length / lista.length;
    const personas = new Set(lejos.map((m) => m.empleado_id)).size;

    if (tasa >= 0.6) {
      const distancias = lejos.map((m) => Number(m.distancia_metros)).filter(Number.isFinite);
      const compuertas = [
        compuerta(`${redondear(tasa * 100, 0)}% de las marcaciones de la tienda caen lejos (${lejos.length} de ${lista.length})`, true),
        compuerta('Es un porcentaje que una persona sola no puede explicar', true),
        compuerta(`Les pasa a ${personas} personas distintas`, personas >= 2, { requerida: false }),
      ];
      const nivel = nivelSegunCompuertas(compuertas);
      if (nivel) {
        hallazgos.push(crearHallazgo({
          verificacion: BASE_LUGAR.id, area: AREA, clave: `tienda:${sucursalId}`,
          titulo: `${tienda}: la ubicación del local parece mal cargada`,
          detalle: 'Casi todas las marcaciones de la tienda salen como "lejos". No es una persona: es el punto del mapa.',
          gravedad: GRAVEDAD.MEDIA, nivel,
          evidencia: [
            `${lejos.length} de ${lista.length} marcaciones fuera del radio`,
            distancias.length ? `Distancia típica: ${redondear(mediana(distancias), 0)} metros del punto cargado` : null,
          ].filter(Boolean),
          compuertas,
          descartado: ['No es una persona marcando desde afuera: les pasa casi a todos.'],
          accion: 'Corregí la ubicación de la tienda en su configuración. Mientras tanto, cualquier reporte de "marcó lejos" de esa tienda no sirve.',
          sucursal_id: sucursalId, sucursal_nombre: tienda,
        }));
      }
      continue; // con la tienda mal ubicada no se señala a nadie
    }

    if (tasa >= 0.25) continue; // zona gris: ni la tienda está claramente mal ni hay una persona aislada

    for (const [empleadoId, propias] of agruparPor(lista, (m) => m.empleado_id)) {
      const suyasLejos = propias.filter((m) => m.verificacion === 'lejos');
      const fechas = diasDistintos(suyasLejos.map((m) => m.fecha));
      const emp = datos.empleados.find((e) => e.id === empleadoId);
      if (!emp || fechas < 3) continue;
      const share = suyasLejos.length / propias.length;
      const distancias = suyasLejos.map((m) => Number(m.distancia_metros)).filter(Number.isFinite);
      const radio = datos.sucursales.find((s) => s.id === sucursalId)?.radio_metros || 150;
      // Contra los DEMÁS, no contra toda la tienda: si esta persona es la que arrastra el
      // porcentaje, compararla con un promedio que ya la incluye la disimula a sí misma.
      const delResto = lista.filter((m) => m.empleado_id !== empleadoId);
      const restoLejos = delResto.length ? delResto.filter((m) => m.verificacion === 'lejos').length / delResto.length : 0;
      const compuertas = [
        compuerta(`Marcó lejos en ${fechas} días distintos`, fechas >= 3),
        compuerta(`Es el ${redondear(share * 100, 0)}% de sus marcaciones, mucho más que un GPS que a veces falla`, share >= 0.25),
        compuerta(`Sus compañeros de ${tienda} marcan dentro (solo ${redondear(restoLejos * 100, 0)}% de las suyas cae lejos)`, delResto.length >= 6 && restoLejos <= 0.1),
        compuerta('Cuando marca lejos, está a más del doble del radio permitido', distancias.length > 0 && mediana(distancias) >= 2 * radio, { requerida: false }),
      ];
      const nivel = nivelSegunCompuertas(compuertas, { base: NIVEL.PROBABLE });
      if (!nivel) continue;
      hallazgos.push(crearHallazgo({
        verificacion: BASE_LUGAR.id, area: AREA, clave: `emp:${empleadoId}`,
        titulo: `${emp.nombre} (${tienda}): marcó fuera del local en ${fechas} días`,
        detalle: 'Sus compañeros marcan dentro del radio y esta persona repetidamente no.',
        gravedad: GRAVEDAD.MEDIA, nivel,
        evidencia: suyasLejos.slice(-4).map((m) => `${fechaCorta(m.fecha)} · ${m.tipo}: a ${redondear(m.distancia_metros, 0)} m del local`),
        compuertas,
        descartado: [
          'No es la ubicación de la tienda: sus compañeros marcan dentro.',
          'No es un caso suelto: se repite en varios días.',
        ],
        accion: 'Hablalo con la persona antes de concluir nada: puede ser un problema de señal del teléfono o que marca antes de llegar. Mirá las distancias, no solo la cantidad.',
        sucursal_id: sucursalId, sucursal_nombre: tienda,
      }));
    }
  }

  return resultado(BASE_LUGAR, { hallazgos, revisado: `${medidas.length} marcaciones verificadas en ${evaluadas} ${plural(evaluadas, 'tienda', 'tiendas')}` });
}

// ──────────────────────────────────────────────────────────────────────────────────────────

const BASE_INCOMPLETAS = {
  id: 'marcaciones_incompletas',
  nombre: 'Marcaciones sin salida o sin entrada',
  area: AREA,
};

/**
 * Entrada sin salida (o al revés): las horas de ese día no se pueden calcular, y la quincena
 * se paga con horas que faltan. Una vez es un olvido. Varias veces es un hábito, y si le pasa
 * a casi toda la tienda, el problema no es cada persona sino que nadie sabe que hay que marcar
 * la salida.
 */
export function marcacionesIncompletas(datos) {
  const personas = empleadosActivos(datos);
  const conMarcaciones = personas.filter((e) => marcacionesDe(datos, e.id).length > 0);
  if (!conMarcaciones.length) return sinDatos(BASE_INCOMPLETAS, 'Todavía no hay marcaciones de entrada y salida en los últimos 30 días.');

  const hallazgos = [];
  const porTienda = new Map();
  for (const emp of conMarcaciones) {
    const turnos = turnosDeMarcaciones(marcacionesDe(datos, emp.id)).filter((t) => t.fecha !== datos.hoy);
    const incompletos = turnos.filter((t) => t.incompleto);
    const fechas = diasDistintos(incompletos.map((t) => t.fecha));
    if (fechas < 3) continue;
    const lista = porTienda.get(emp.sucursal_id) || [];
    lista.push({ emp, incompletos, turnos: turnos.length, fechas });
    porTienda.set(emp.sucursal_id, lista);
  }

  for (const [sucursalId, lista] of porTienda) {
    const tienda = nombreTienda(datos, sucursalId);
    const plantilla = conMarcaciones.filter((e) => e.sucursal_id === sucursalId).length;
    const sistemico = plantilla >= 3 && lista.length / plantilla >= 0.5;

    if (sistemico) {
      hallazgos.push(crearHallazgo({
        verificacion: BASE_INCOMPLETAS.id, area: AREA, clave: `tienda:${sucursalId}`,
        titulo: `${tienda}: casi nadie marca la salida`,
        detalle: `${lista.length} de ${plantilla} personas tienen 3 días o más sin salida (o sin entrada) en el último mes. Es un hábito de la tienda, no de una persona.`,
        gravedad: GRAVEDAD.ALTA, nivel: NIVEL.CONFIRMADO,
        evidencia: lista.slice(0, 4).map((l) => `${l.emp.nombre}: ${l.fechas} días incompletos de ${l.turnos}`),
        compuertas: [
          compuerta(`${lista.length} de ${plantilla} personas con 3 días o más incompletos`, true),
          compuerta('Es la mitad de la plantilla o más: no es un olvido individual', true),
        ],
        descartado: ['No es una persona descuidada: pasa en casi todo el equipo.'],
        accion: 'Explicales a todos que hay que marcar también al salir. Hasta entonces las horas de la quincena de esa tienda salen incompletas.',
        impacto: `${suma(lista.map((l) => l.incompletos.length))} turnos sin horas calculables`,
        sucursal_id: sucursalId, sucursal_nombre: tienda,
      }));
      continue;
    }
    for (const l of lista) {
      hallazgos.push(crearHallazgo({
        verificacion: BASE_INCOMPLETAS.id, area: AREA, clave: `emp:${l.emp.id}`,
        titulo: `${l.emp.nombre} (${tienda}): ${l.fechas} días sin marcar la salida`,
        detalle: 'En esos días no se pueden calcular sus horas para la quincena.',
        gravedad: GRAVEDAD.MEDIA, nivel: NIVEL.CONFIRMADO,
        evidencia: l.incompletos.slice(-4).map((t) => `${fechaCorta(t.fecha)}: ${t.entrada ? 'entrada sin salida' : 'salida sin entrada'}`),
        compuertas: [
          compuerta(`${l.fechas} días distintos con la marcación incompleta`, true),
          compuerta('No es la jornada de hoy, que todavía está abierta', true),
          compuerta('Sus compañeros no tienen el mismo problema', true),
        ],
        descartado: ['No es un turno que todavía no terminó: se excluyó el de hoy.'],
        accion: 'Recordale que marque al salir. Esas horas hay que completarlas a mano antes de pagar.',
        sucursal_id: sucursalId, sucursal_nombre: tienda,
      }));
    }
  }
  return resultado(BASE_INCOMPLETAS, { hallazgos, revisado: `${conMarcaciones.length} personas con marcaciones en el último mes` });
}

// ──────────────────────────────────────────────────────────────────────────────────────────

const BASE_JORNADA = {
  id: 'jornada_mas_larga_que_el_horario',
  nombre: 'Se trabaja más (o en días libres) de lo que dice el horario',
  area: AREA,
};

/**
 * Compara lo que cada persona de verdad trabajó contra el horario que tiene cargado. Si se
 * queda 2 horas más casi cada día, o viene en su día libre, una de dos: hay horas extra que
 * nadie está contando, o el horario cargado quedó viejo.
 *
 * Importa por dos lados: lo que se paga en la quincena y lo que dice el contrato. Esto no
 * dice qué corresponde pagar; dice dónde mirar.
 */
export function jornadaMasLargaQueElHorario(datos) {
  const personas = empleadosActivos(datos);
  const evaluables = personas.filter((e) => marcacionesDe(datos, e.id).length > 0);
  if (!evaluables.length) return sinDatos(BASE_JORNADA, 'Todavía no hay marcaciones para comparar contra los horarios.');

  const casos = [];
  for (const emp of evaluables) {
    const turnos = turnosDeMarcaciones(marcacionesDe(datos, emp.id)).filter((t) => !t.incompleto && t.horas !== null);
    const extras = [];
    const enLibre = [];
    for (const t of turnos) {
      const h = horarioDe(datos, emp.id, diaSemanaDe(t.fecha));
      if (!h) continue;
      if (h.estado === 'libre') {
        enLibre.push(t);
        continue;
      }
      if (h.estado !== 'turno') continue;
      const prog = horasProgramadas(h);
      if (prog !== null && t.horas - prog >= 1.5) extras.push({ fecha: t.fecha, horas: t.horas, prog, extra: t.horas - prog });
    }
    casos.push({ emp, extras, enLibre, turnos: turnos.length });
  }

  const hallazgos = [];
  const porTienda = agruparPor(casos, (c) => c.emp.sucursal_id);
  for (const [sucursalId, lista] of porTienda) {
    const tienda = nombreTienda(datos, sucursalId);
    const conExtra = lista.filter((c) => diasDistintos(c.extras.map((e) => e.fecha)) >= 3);
    const sistemico = lista.length >= 3 && conExtra.length / lista.length >= 0.5;
    if (sistemico) {
      const horas = suma(conExtra.flatMap((c) => c.extras.map((e) => e.extra)));
      hallazgos.push(crearHallazgo({
        verificacion: BASE_JORNADA.id, area: AREA, clave: `tienda:${sucursalId}`,
        titulo: `${tienda}: el horario cargado no refleja cuánto se trabaja`,
        detalle: `${conExtra.length} de ${lista.length} personas trabajan 1.5 horas más que su turno programado, 3 días o más al mes.`,
        gravedad: GRAVEDAD.ALTA, nivel: NIVEL.PROBABLE,
        evidencia: conExtra.slice(0, 4).map((c) => `${c.emp.nombre}: ${diasDistintos(c.extras.map((e) => e.fecha))} días con ~${redondear(mediana(c.extras.map((e) => e.extra)), 1)} h de más`),
        compuertas: [
          compuerta(`${conExtra.length} de ${lista.length} personas con 3 días o más de exceso`, true),
          compuerta('Es la mitad o más del equipo: parece cómo está armado el horario, no cada persona', true),
          compuerta('Las horas son turnos completos con entrada y salida marcadas', true),
        ],
        descartado: ['No es una persona que se queda de más: pasa en casi todo el equipo.'],
        accion: 'O el horario de cierre real es más largo que el cargado (actualizalo), o hay horas extra que no se están contando. Revisalo con tu contador.',
        impacto: `~${redondear(horas, 0)} horas de más en 30 días`,
        sucursal_id: sucursalId, sucursal_nombre: tienda,
      }));
      continue;
    }
    for (const c of lista) {
      const fechasExtra = diasDistintos(c.extras.map((e) => e.fecha));
      const fechasLibre = diasDistintos(c.enLibre.map((t) => t.fecha));
      if (fechasExtra >= 3) {
        const horas = suma(c.extras.map((e) => e.extra));
        const compuertas = [
          compuerta(`Se quedó 1.5 horas o más de lo programado en ${fechasExtra} días distintos`, true),
          compuerta('Las horas son de turnos con entrada y salida marcadas', true),
          compuerta('Pasa en 6 días o más', fechasExtra >= 6, { requerida: false }),
        ];
        hallazgos.push(crearHallazgo({
          verificacion: BASE_JORNADA.id, area: AREA, clave: `extra:${c.emp.id}`,
          titulo: `${c.emp.nombre} (${tienda}): ${fechasExtra} días trabajando más que su turno`,
          detalle: 'Sus horas reales superan las del horario cargado, varios días.',
          gravedad: GRAVEDAD.MEDIA, nivel: nivelSegunCompuertas(compuertas, { base: NIVEL.CONFIRMADO }),
          evidencia: c.extras.slice(-4).map((e) => `${fechaCorta(e.fecha)}: trabajó ${redondear(e.horas, 1)} h, programado ${redondear(e.prog, 1)} h`),
          compuertas,
          descartado: ['No es un caso suelto: se repite en varios días.', 'No es un turno sin cerrar: tiene entrada y salida marcadas.'],
          accion: 'Revisá si esas horas se están pagando como extra, o si el horario de esa persona hay que actualizarlo.',
          impacto: `~${redondear(horas, 1)} horas de más en 30 días`,
          sucursal_id: sucursalId, sucursal_nombre: tienda,
        }));
      }
      if (fechasLibre >= 3) {
        hallazgos.push(crearHallazgo({
          verificacion: BASE_JORNADA.id, area: AREA, clave: `libre:${c.emp.id}`,
          titulo: `${c.emp.nombre} (${tienda}): ${fechasLibre} veces trabajó en su día libre`,
          detalle: 'Marcó turno completo en días que su horario dice que descansa.',
          gravedad: GRAVEDAD.MEDIA, nivel: NIVEL.PROBABLE,
          evidencia: c.enLibre.slice(-4).map((t) => `${fechaCorta(t.fecha)}: trabajó ${redondear(t.horas, 1)} h en día libre`),
          compuertas: [compuerta(`${fechasLibre} días distintos`, true), compuerta('Con entrada y salida marcadas', true)],
          descartado: ['No es un turno suelto: se repite en varias fechas.'],
          accion: 'Si esos días libres cambiaron, actualizá su horario. Si no, hay trabajo en día de descanso que revisar.',
          sucursal_id: sucursalId, sucursal_nombre: tienda,
        }));
      }
    }
  }
  return resultado(BASE_JORNADA, { hallazgos, revisado: `${evaluables.length} personas, comparadas contra su horario` });
}

// ──────────────────────────────────────────────────────────────────────────────────────────

const BASE_NO_MARCA = {
  id: 'turnos_sin_marcar',
  nombre: 'Personas con turnos asignados que nunca marcan',
  area: AREA,
};

/**
 * Alguien con turnos en el horario y ninguna marcación en todo el mes, en una tienda donde el
 * resto SÍ marca todos los días. Hay tres explicaciones: ya no trabaja ahí, no usa el sistema
 * de marcación, o el horario es de otra época. El sistema no puede saber cuál; sí puede decir
 * que alguien tiene que preguntar.
 *
 * Es también lo que impide medir el ausentismo de esa persona: sin marcaciones no se puede
 * distinguir "faltó" de "nunca marca".
 */
export function turnosSinMarcar(datos) {
  const desde = ventana(datos);
  const personas = empleadosActivos(datos);
  const porTienda = agruparPor(personas, (e) => e.sucursal_id);
  const hallazgos = [];
  let evaluadas = 0;

  for (const [sucursalId, plantilla] of porTienda) {
    const marcasTienda = datos.marcaciones.filter((m) => m.sucursal_id === sucursalId && m.fecha >= desde && m.tipo === 'entrada');
    if (marcasTienda.length < 20) continue; // el sistema de marcación casi no se usa ahí: no hay con qué comparar
    evaluadas += 1;
    const diasConMarcas = diasDistintos(marcasTienda.map((m) => m.fecha));

    const sospechosos = [];
    for (const emp of plantilla) {
      if (marcacionesDe(datos, emp.id).length > 0) continue;
      let turnos = 0;
      for (let f = desde; f < datos.hoy; f = sumarDias(f, 1)) {
        const h = horarioDe(datos, emp.id, diaSemanaDe(f));
        if (!h || h.estado !== 'turno') continue;
        if (enVacaciones(datos, emp.id, f)) continue;
        if (emp.fecha_ingreso && f < emp.fecha_ingreso) continue;
        turnos += 1;
      }
      if (turnos >= 8) sospechosos.push({ emp, turnos });
    }
    if (!sospechosos.length) continue;

    const compuertas = [
      compuerta(`Tienen 8 turnos asignados o más en el último mes`, true),
      compuerta('No tienen ni una sola marcación en todo ese período', true),
      compuerta(`En esa tienda sí se marca: hubo marcaciones en ${diasConMarcas} días distintos`, diasConMarcas >= 10),
      compuerta('Esos turnos no caen en vacaciones ni antes de su fecha de ingreso', true),
    ];
    if (!nivelSegunCompuertas(compuertas)) continue;
    hallazgos.push(crearHallazgo({
      verificacion: BASE_NO_MARCA.id, area: AREA, clave: sucursalId,
      titulo: `${nombreTienda(datos, sucursalId)}: ${sospechosos.length} ${plural(sospechosos.length, 'persona con turnos y sin marcar nunca', 'personas con turnos y sin marcar nunca')}`,
      detalle: 'Tienen horario asignado pero no aparecen marcando en todo el mes, mientras el resto de su tienda sí marca.',
      gravedad: GRAVEDAD.MEDIA, nivel: NIVEL.PROBABLE,
      evidencia: sospechosos.slice(0, 5).map((s) => `${s.emp.nombre}: ${s.turnos} turnos asignados, 0 marcaciones`),
      compuertas,
      descartado: ['No es que la tienda no use el sistema: el resto marca casi todos los días.', 'No son vacaciones ni gente que todavía no había entrado.'],
      accion: 'Preguntá: ¿sigue trabajando ahí? Si ya no, desactivala en Horarios. Si sí, tiene que marcar; mientras no lo haga no se puede calcular su asistencia ni sus horas.',
      sucursal_id: sucursalId, sucursal_nombre: nombreTienda(datos, sucursalId),
    }));
  }

  if (!evaluadas) return sinDatos(BASE_NO_MARCA, 'Ninguna tienda tiene todavía suficientes marcaciones (20 entradas en el mes) como para comparar.');
  return resultado(BASE_NO_MARCA, { hallazgos, revisado: `${evaluadas} ${plural(evaluadas, 'tienda', 'tiendas')} donde el sistema de marcación está en uso` });
}

// ──────────────────────────────────────────────────────────────────────────────────────────

const BASE_VACACIONES = {
  id: 'vacaciones_y_datos_de_personal',
  nombre: 'Vacaciones acumuladas y datos del personal',
  area: AREA,
};

/**
 * Lo que se acumula sin tomarse se le debe a la persona. Con un día por mes, alguien que lleva
 * tres años sin salir tiene 36 días: es plata que se paga en la liquidación, y mientras más
 * crece, más pesa. También se revisa que los datos de los que depende el cálculo estén completos
 * y que no haya gente activa en una tienda que ya cerró.
 */
export function vacacionesYDatosDePersonal(datos) {
  const activos = datos.empleados.filter((e) => e.activo);
  if (!activos.length) return sinDatos(BASE_VACACIONES, 'No hay empleados activos.');
  const hallazgos = [];

  const resumenes = activos.map((e) => ({
    emp: e,
    r: resumenVacaciones({
      fechaIngreso: e.fecha_ingreso,
      vacaciones: datos.vacaciones.filter((v) => v.empleado_id === e.id),
      hoy: datos.hoy,
    }),
  }));

  const acumulan = resumenes.filter((x) => !x.r.sinFechaIngreso && x.r.saldo >= 24).sort((a, b) => b.r.saldo - a.r.saldo);
  if (acumulan.length) {
    const total = suma(acumulan.map((x) => x.r.saldo));
    hallazgos.push(crearHallazgo({
      verificacion: BASE_VACACIONES.id, area: AREA, clave: 'acumuladas',
      titulo: `${acumulan.length} ${plural(acumulan.length, 'persona acumula', 'personas acumulan')} 24 días de vacaciones o más sin tomar`,
      detalle: `Entre todas suman ${total} días pendientes. Es un pasivo que se paga al liquidar y que sigue creciendo un día por mes.`,
      gravedad: acumulan[0].r.saldo >= 36 ? GRAVEDAD.MEDIA : GRAVEDAD.BAJA,
      nivel: acumulan[0].r.saldo >= 36 ? NIVEL.PROBABLE : NIVEL.OBSERVAR,
      evidencia: acumulan.slice(0, 5).map((x) => `${x.emp.nombre}: ${x.r.saldo} días (acumuló ${x.r.ganados}, tomó ${x.r.tomados})`),
      compuertas: [
        compuerta('El saldo sale de la fecha de ingreso y de lo ya registrado', true),
        compuerta('Cada uno tiene 24 días o más pendientes', true),
        compuerta('Alguno pasa de 36 días', acumulan[0].r.saldo >= 36, { requerida: false }),
      ],
      descartado: ['No es un dato sin fecha de ingreso: solo se cuentan personas con fecha cargada.'],
      accion: 'Si alguno ya tomó vacaciones que no están anotadas, cargalas para que el saldo sea real. Si no, conviene planificar cuándo las toman.',
      impacto: `${total} días acumulados`,
    }));
  }

  const negativos = resumenes.filter((x) => !x.r.sinFechaIngreso && x.r.saldo < 0);
  if (negativos.length) {
    hallazgos.push(crearHallazgo({
      verificacion: BASE_VACACIONES.id, area: AREA, clave: 'negativas',
      titulo: `${negativos.length} ${plural(negativos.length, 'persona tomó', 'personas tomaron')} más días de los que acumuló`,
      detalle: 'Su saldo de vacaciones es negativo: les dieron más de lo que ganaron.',
      gravedad: GRAVEDAD.MEDIA, nivel: NIVEL.CONFIRMADO,
      evidencia: negativos.map((x) => `${x.emp.nombre}: ${x.r.saldo} días (acumuló ${x.r.ganados}, tomó ${x.r.tomados})`),
      compuertas: [compuerta('El saldo es aritmética pura: acumulado menos tomado', true), compuerta('Es menor que cero', true)],
      descartado: ['No es redondeo: son días enteros de diferencia.'],
      accion: 'Verificá la fecha de ingreso (si está mal, el acumulado sale de menos) y las vacaciones cargadas.',
    }));
  }

  const sinFecha = resumenes.filter((x) => x.r.sinFechaIngreso);
  if (sinFecha.length) {
    hallazgos.push(crearHallazgo({
      verificacion: BASE_VACACIONES.id, area: AREA, clave: 'sin-fecha',
      titulo: `${sinFecha.length} ${plural(sinFecha.length, 'empleado sin fecha de ingreso', 'empleados sin fecha de ingreso')}`,
      detalle: 'Sin esa fecha no se puede calcular cuántos días de vacaciones lleva acumulados.',
      gravedad: GRAVEDAD.BAJA, nivel: NIVEL.CONFIRMADO,
      evidencia: sinFecha.slice(0, 6).map((x) => `${x.emp.nombre} (${nombreTienda(datos, x.emp.sucursal_id)})`),
      compuertas: [compuerta('Están activos', true), compuerta('No tienen fecha de ingreso cargada', true)],
      descartado: [],
      accion: 'Cargala en Personal → Vacaciones, con "Cargar fechas desde la planilla" o a mano.',
    }));
  }

  const enCerradas = activos.filter((e) => (datos.cerradas || []).includes(e.sucursal_id) || !tiendaAbierta(datos, e.sucursal_id));
  if (enCerradas.length) {
    hallazgos.push(crearHallazgo({
      verificacion: BASE_VACACIONES.id, area: AREA, clave: 'en-tienda-cerrada',
      titulo: `${enCerradas.length} ${plural(enCerradas.length, 'empleado activo', 'empleados activos')} en una tienda cerrada`,
      detalle: 'Siguen figurando como activos en una sucursal que ya no funciona.',
      gravedad: GRAVEDAD.BAJA, nivel: NIVEL.CONFIRMADO,
      evidencia: enCerradas.slice(0, 6).map((e) => `${e.nombre} (${nombreTienda(datos, e.sucursal_id)})`),
      compuertas: [compuerta('La tienda está cerrada o inactiva', true), compuerta('La persona sigue activa', true)],
      descartado: [],
      accion: 'Si ya no trabajan, desactivalos; si pasaron a otra tienda, cambialos de sucursal. Mientras sigan así, ensucian las listas y la cobertura.',
    }));
  }

  const sinHorario = empleadosActivos(datos).filter((e) => !datos.horarios.some((h) => h.empleado_id === e.id));
  if (sinHorario.length) {
    hallazgos.push(crearHallazgo({
      verificacion: BASE_VACACIONES.id, area: AREA, clave: 'sin-horario',
      titulo: `${sinHorario.length} ${plural(sinHorario.length, 'empleado activo sin horario', 'empleados activos sin horario')}`,
      detalle: 'Sin horario cargado no se puede saber cuándo les toca trabajar ni medir su asistencia.',
      gravedad: GRAVEDAD.BAJA, nivel: NIVEL.OBSERVAR,
      evidencia: sinHorario.slice(0, 6).map((e) => `${e.nombre} (${nombreTienda(datos, e.sucursal_id)})`),
      compuertas: [compuerta('Están activos en una tienda abierta', true), compuerta('No tienen ningún día cargado', true)],
      descartado: [],
      accion: 'Cargales el horario en Personal → Horarios.',
    }));
  }

  return resultado(BASE_VACACIONES, { hallazgos, revisado: `${activos.length} empleados activos` });
}

export const VERIFICACIONES_PERSONAL = [
  marcacionesFueraDeLugar,
  marcacionesIncompletas,
  jornadaMasLargaQueElHorario,
  turnosSinMarcar,
  vacacionesYDatosDePersonal,
];

export { diasEntre };
