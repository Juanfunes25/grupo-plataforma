import { agruparPor, sumarDias } from './nucleo.js';
import { VERIFICACIONES_PESAJES } from './verif/pesajes.js';
import { VERIFICACIONES_DESPACHOS } from './verif/despachos.js';
import { VERIFICACIONES_FABRICA } from './verif/fabrica.js';
import { VERIFICACIONES_INVENTARIO } from './verif/inventario.js';
import { VERIFICACIONES_PERSONAL } from './verif/personal.js';
import { VERIFICACIONES_SISTEMA } from './verif/sistema.js';

/**
 * El gerente digital: corre todas las verificaciones sobre el mismo retrato del negocio y
 * arma el informe.
 *
 * Tres cosas que lo separan de una lista de alertas:
 *
 * 1. DICE QUÉ REVISÓ. No solo lo que encontró. "Revisé 22 cosas, 3 requieren atención, 14
 *    están en orden, 5 no pude verificar" es información; una lista de 3 problemas sin más
 *    no dice si lo demás está bien o simplemente no se miró.
 *
 * 2. NO CALLA LO QUE NO PUDO VERIFICAR. Una verificación sin datos suficientes no cuenta como
 *    "todo bien": va aparte, con el motivo. Confundir "no hay problemas" con "no hay datos
 *    para saber" es exactamente cómo un auditor da una falsa tranquilidad.
 *
 * 3. UNE LOS PUNTOS. Un problema suelto es una tarea. Cinco problemas en la misma tienda son
 *    una historia: o la tienda tiene un hábito roto, o algo común a todas está fallando. Esa
 *    lectura es la que ahorra tiempo y se hace acá, cruzando los hallazgos entre sí.
 */

export const VERIFICACIONES = [
  ...VERIFICACIONES_PESAJES,
  ...VERIFICACIONES_DESPACHOS,
  ...VERIFICACIONES_FABRICA,
  ...VERIFICACIONES_INVENTARIO,
  ...VERIFICACIONES_PERSONAL,
  ...VERIFICACIONES_SISTEMA,
];

const RANGO_NIVEL = { confirmado: 0, probable: 1, observar: 2 };
const RANGO_GRAVEDAD = { alta: 0, media: 1, baja: 2 };

/** Cuánto dura "lo vi" y "no es un problema" antes de que el gerente vuelva a mencionarlo. */
export const DIAS_DESCARTE = { visto: 7, no_es_problema: 60 };

function ordenar(hallazgos) {
  return [...hallazgos].sort(
    (a, b) => RANGO_NIVEL[a.nivel] - RANGO_NIVEL[b.nivel]
      || RANGO_GRAVEDAD[a.gravedad] - RANGO_GRAVEDAD[b.gravedad]
      || a.titulo.localeCompare(b.titulo)
  );
}

/**
 * Cruza los hallazgos entre sí buscando lo que explican juntos y no por separado.
 * Solo trabaja con lo confirmado o probable: encadenar "para observar" produciría historias
 * inventadas sobre ruido.
 */
export function sintetizarPatrones(hallazgos, nombresDeVerificacion = new Map()) {
  const firmes = hallazgos.filter((h) => h.nivel !== 'observar');
  const patrones = [];
  const nombreDe = (id) => nombresDeVerificacion.get(id) || id;

  // 1. Lo mismo en varias tiendas: la causa probablemente no está en cada tienda.
  for (const [verificacion, lista] of agruparPor(firmes, (h) => h.verificacion)) {
    const tiendas = new Set(lista.map((h) => h.sucursal_id).filter(Boolean));
    if (tiendas.size < 3) continue;
    patrones.push({
      id: `sistemico:${verificacion}`,
      titulo: `Lo mismo en ${tiendas.size} tiendas: ${nombreDe(verificacion).toLowerCase()}`,
      detalle: 'Cuando un problema aparece en casi todas las tiendas, la causa probable no está en cada una sino en algo que comparten: cómo se hace en fábrica, o cómo funciona la app. Arreglarlo tienda por tienda no lo resuelve.',
      nivel: 'probable',
      huellas: lista.map((h) => h.huella),
    });
  }

  // 2. Una tienda que acumula problemas de varios tipos distintos.
  for (const [sucursalId, lista] of agruparPor(firmes.filter((h) => h.sucursal_id), (h) => h.sucursal_id)) {
    const tipos = new Set(lista.map((h) => h.verificacion));
    if (tipos.size < 3) continue;
    patrones.push({
      id: `concentra:${sucursalId}`,
      titulo: `${lista[0].sucursal_nombre} concentra ${tipos.size} problemas de tipos distintos`,
      detalle: `Aparecen juntos: ${[...tipos].map((t) => nombreDe(t).toLowerCase()).join('; ')}. Cuando una tienda falla en cosas distintas a la vez, casi siempre es el cierre de la noche o la supervisión, no mala suerte. Conviene hablar con el encargado de esa tienda antes de ir caso por caso.`,
      nivel: 'probable',
      huellas: lista.map((h) => h.huella),
      sucursal_id: sucursalId,
    });
  }

  return patrones;
}

/**
 * Aplica lo que el dueño ya vio o descartó. Un descarte tiene fecha de vencimiento: "lo vi"
 * dura una semana y "no es un problema" dos meses, y pasado el plazo el gerente vuelve a
 * decirlo si sigue pasando. Nada se oculta para siempre.
 */
function aplicarDescartes(hallazgos, descartes, hoy) {
  const vigentes = new Map(descartes.filter((d) => d.hasta >= hoy).map((d) => [d.huella, d]));
  const visibles = [];
  const ocultos = [];
  for (const h of hallazgos) {
    const d = vigentes.get(h.huella);
    if (d) ocultos.push({ ...h, descarte: { estado: d.estado, nota: d.nota, hasta: d.hasta } });
    else visibles.push(h);
  }
  return { visibles, ocultos };
}

/** Corre una verificación sin dejar que una falla suya tire abajo todo el informe. */
function correr(verificacion, datos) {
  try {
    return verificacion(datos);
  } catch (err) {
    return {
      id: verificacion.name,
      nombre: verificacion.name,
      area: 'sistema',
      estado: 'error',
      mensajeError: err.message,
      hallazgos: [],
      ruido: 0,
    };
  }
}

export function ejecutarAuditoria(datos, { descartes = [], ahora = new Date() } = {}) {
  const resultados = VERIFICACIONES.map((v) => correr(v, datos));
  const nombres = new Map(resultados.map((r) => [r.id, r.nombre]));

  const todos = resultados.flatMap((r) => r.hallazgos);
  const { visibles, ocultos } = aplicarDescartes(todos, descartes, datos.hoy);
  const firmes = ordenar(visibles.filter((h) => h.nivel !== 'observar'));
  const observar = ordenar(visibles.filter((h) => h.nivel === 'observar'));
  const patrones = sintetizarPatrones(firmes, nombres);

  const contar = (estado) => resultados.filter((r) => r.estado === estado);
  const resumen = {
    verificaciones: resultados.length,
    conHallazgos: contar('hallazgos').length,
    enOrden: contar('ok').length,
    sinDatos: contar('sin_datos').length,
    conError: contar('error').length,
    hallazgos: {
      confirmado: firmes.filter((h) => h.nivel === 'confirmado').length,
      probable: firmes.filter((h) => h.nivel === 'probable').length,
      observar: observar.length,
    },
    altas: firmes.filter((h) => h.gravedad === 'alta').length,
    ruidoDescartado: resultados.reduce((a, r) => a + (r.ruido || 0), 0),
    descartadosPorElDueno: ocultos.length,
    porOrdenar: resultados.reduce((a, r) => a + (r.limpieza || []).reduce((b, l) => b + l.cantidad, 0), 0),
  };

  return {
    hoy: datos.hoy,
    generadoEn: ahora.toISOString(),
    resumen,
    patrones,
    hallazgos: firmes,
    observar,
    descartados: ocultos,
    limpieza: resultados.flatMap((r) => r.limpieza || []),
    enOrden: resultados.filter((r) => r.estado === 'ok').map((r) => ({ id: r.id, nombre: r.nombre, area: r.area, revisado: r.revisado })),
    sinDatos: resultados.filter((r) => r.estado === 'sin_datos').map((r) => ({ id: r.id, nombre: r.nombre, area: r.area, motivo: r.motivoSinDatos })),
    errores: resultados.filter((r) => r.estado === 'error').map((r) => ({ id: r.id, nombre: r.nombre, mensaje: r.mensajeError })),
  };
}

export function fechaHasta(estado, hoy) {
  return sumarDias(hoy, DIAS_DESCARTE[estado] ?? DIAS_DESCARTE.visto);
}

