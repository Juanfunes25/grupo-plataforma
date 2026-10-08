import {
  AREAS, GRAVEDAD, NIVEL, compuerta, crearHallazgo, diasDistintos, diasEntre, fechaCorta, kg, listar,
  mediana, percentil, nivelSegunCompuertas, plural, redondear, resultado, sinDatos, sumarDias, agruparPor, suma,
} from '../nucleo.js';

const AREA = 'tiendas';
const ESTADOS_ENTREGADOS = ['enviado', 'recibido'];

/** Tiendas que registran despachos y cuyos pesajes se pueden cruzar contra ellos. */
export function tiendasConDespachos(datos) {
  const excluidas = new Set([...(datos.fueraDeAnalisis || []), ...(datos.cerradas || [])]);
  return datos.sucursales.filter((s) => s.rol === 'sucursal' && s.activa && !excluidas.has(s.id));
}

/** Todas las tiendas abiertas, incluida Los Andes: esa sí pesa su vitrina cada noche. */
export function tiendasAbiertas(datos) {
  const cerradas = new Set(datos.cerradas || []);
  return datos.sucursales.filter((s) => s.rol === 'sucursal' && s.activa && !cerradas.has(s.id));
}

/**
 * Un pesaje por noche: si alguien pesó dos veces el mismo sabor, vale el último, que es el
 * del cierre (el mismo criterio que usa el motor de sugerencias).
 */
export function noches(datos) {
  const ultimo = new Map();
  for (const p of datos.pesajes) {
    const clave = `${p.sucursal_id}|${p.sabor_id}|${p.fecha}`;
    const previo = ultimo.get(clave);
    if (!previo || String(p.creado_en) >= String(previo.creado_en)) ultimo.set(clave, p);
  }
  return [...ultimo.values()];
}

/** sucursal|sabor -> pesajes ordenados por fecha. */
export function seriesPorSabor(datos) {
  const series = agruparPor(noches(datos), (p) => `${p.sucursal_id}|${p.sabor_id}`);
  for (const lista of series.values()) lista.sort((a, b) => a.fecha.localeCompare(b.fecha));
  return series;
}

/**
 * El día en que el gelato LLEGA a la tienda. `fecha` del despacho es la noche en que la tienda
 * lo pidió; la entrega es la mañana siguiente (`enviado_en`). Si todavía no salió, se asume
 * esa mañana siguiente. Confundir las dos hace que una entrega parezca caer un día antes de
 * lo que cayó, y toda comparación contra los pesajes de la noche sale corrida.
 */
export const fechaEntrega = (d) => d.enviado_en || sumarDias(d.fecha, 1);

const nombreSabor = (datos, id) => datos.sabores.find((s) => s.id === id)?.nombre || `sabor ${id}`;
const gramosPana = (datos, id) => datos.sabores.find((s) => s.id === id)?.gramos_pana || 3000;
const nombreTienda = (datos, id) => datos.sucursales.find((s) => s.id === id)?.nombre || id;

// ──────────────────────────────────────────────────────────────────────────────────────────

const BASE_SUBE = {
  id: 'pesaje_sube_sin_entrada',
  nombre: 'La vitrina sube sin que haya llegado nada',
  area: AREA,
};

/**
 * Si la vitrina de un sabor pesa MÁS que la noche anterior y no llegó ningún despacho, hay
 * producto que apareció de la nada. Puede ser un pesaje mal tomado, o gelato que entró a la
 * tienda sin pasar por el sistema (por ejemplo, repuesto de un congelador de la tienda).
 *
 * Importa porque el motor de sugerencias calcula el consumo como "lo que había + lo que llegó
 * - lo que quedó". Si entra producto sin registrar, ese consumo sale de menos y el plan
 * manda de menos, noche tras noche.
 *
 * Una subida suelta no se reporta: la balanza se equivoca. Tiene que repetirse.
 */
export function pesajeSubeSinEntrada(datos) {
  const tiendas = tiendasConDespachos(datos);
  if (!tiendas.length) return sinDatos(BASE_SUBE, 'No hay tiendas que registren despachos.');
  const series = seriesPorSabor(datos);
  const ids = new Set(tiendas.map((t) => t.id));

  const entregas = new Map(); // sucursal|sabor -> [fechas con despacho de cualquier estado vivo]
  for (const d of datos.despachos) {
    if (d.estado === 'no_disponible') continue;
    const clave = `${d.sucursal_id}|${d.sabor_id}`;
    if (!entregas.has(clave)) entregas.set(clave, []);
    entregas.get(clave).push(fechaEntrega(d));
  }

  const eventos = [];
  let pares = 0;
  for (const [clave, lista] of series) {
    const [sucursalId, saborId] = clave.split('|');
    if (!ids.has(sucursalId)) continue;
    const pana = gramosPana(datos, Number(saborId));
    const fechasEntrega = entregas.get(clave) || [];
    for (let i = 1; i < lista.length; i++) {
      const previo = lista[i - 1];
      const actual = lista[i];
      if (diasEntre(previo.fecha, actual.fecha) > 2) continue;
      pares += 1;
      const subida = actual.gramos - previo.gramos;
      if (subida < Math.max(500, 0.2 * pana)) continue;
      const hayEntrega = fechasEntrega.some((f) => f > previo.fecha && f <= actual.fecha);
      if (hayEntrega) continue;
      eventos.push({
        sucursal_id: sucursalId,
        sabor_id: Number(saborId),
        fecha: actual.fecha,
        antes: previo.gramos,
        despues: actual.gramos,
        subida,
      });
    }
  }

  const hallazgos = [];
  let ruido = 0;
  for (const [sucursalId, lista] of agruparPor(eventos, (e) => e.sucursal_id)) {
    const dias = diasDistintos(lista.map((e) => e.fecha));
    const sabores = new Set(lista.map((e) => e.sabor_id)).size;
    const gramos = suma(lista.map((e) => e.subida));
    const recepciones = datos.despachos.filter(
      (d) => d.sucursal_id === sucursalId && d.discrepancia && !d.discrepancia_resuelta
    ).length;

    const compuertas = [
      compuerta(`Se repite en ${dias} noches distintas`, dias >= 3),
      compuerta('En todas esas noches los dos pesajes existen y son seguidos', true),
      compuerta('Ningún despacho (ni pendiente) de ese sabor llegó esos días', true),
      compuerta(`Suman ${kg(gramos)} kg, más de una pana`, gramos >= 3000),
      compuerta(sabores >= 2 ? `Pasa en ${sabores} sabores distintos, no en uno solo` : 'Pasa en un solo sabor (en dos o más sería más seguro que no es un error de balanza)', sabores >= 2, { requerida: false }),
    ];
    const nivel = nivelSegunCompuertas(compuertas);
    if (!nivel) {
      ruido += lista.length;
      continue;
    }

    const tienda = nombreTienda(datos, sucursalId);
    const top = [...lista].sort((a, b) => b.subida - a.subida).slice(0, 4);
    hallazgos.push(crearHallazgo({
      verificacion: BASE_SUBE.id,
      area: AREA,
      clave: sucursalId,
      titulo: `${tienda}: aparece gelato en la vitrina sin que llegue nada`,
      detalle: `${lista.length} veces en ${dias} noches el pesaje de un sabor subió respecto a la noche anterior, y no había ningún despacho que lo explique.`,
      gravedad: gramos >= 9000 ? GRAVEDAD.ALTA : GRAVEDAD.MEDIA,
      nivel,
      evidencia: top.map((e) => `${fechaCorta(e.fecha)} · ${nombreSabor(datos, e.sabor_id)}: ${kg(e.antes)} kg → ${kg(e.despues)} kg (+${kg(e.subida)} kg)`),
      compuertas,
      descartado: [
        'No es un despacho olvidado: no hay ninguno registrado esos días, ni siquiera sin confirmar.',
        'No es una noche suelta: se repite en varias fechas.',
      ],
      accion: 'Preguntale a la tienda si repone la vitrina desde su propio congelador. Si es así, tiene que registrarse como despacho; si no, revisá cómo se están pesando esos sabores. Mientras tanto el motor de sugerencias va a mandar de menos.',
      impacto: `${kg(gramos)} kg de gelato sin explicar`,
      sucursal_id: sucursalId,
      sucursal_nombre: tienda,
    }));
  }

  if (!pares) return sinDatos(BASE_SUBE, 'Todavía no hay noches seguidas con pesaje para comparar.');
  return resultado(BASE_SUBE, {
    hallazgos,
    ruido,
    revisado: `${pares} comparaciones de noches seguidas en ${ids.size} ${plural(ids.size, 'tienda', 'tiendas')}`,
  });
}

// ──────────────────────────────────────────────────────────────────────────────────────────

const BASE_COPIADO = {
  id: 'pesaje_copiado',
  nombre: 'Pesajes que se repiten exactamente',
  area: AREA,
};

/**
 * Mismo peso al gramo tres noches seguidas: casi seguro no se pesó, se copió el de ayer.
 *
 * Pero antes de acusar hay que descartar que la balanza simplemente redondee. Si en esa
 * tienda repetir el mismo número exacto es común en general, un caso suelto no significa nada.
 * Solo se reporta cuando esa tienda NORMALMENTE no repite y de pronto un sabor sí.
 */
export function pesajeCopiado(datos) {
  const tiendas = tiendasAbiertas(datos);
  if (!tiendas.length) return sinDatos(BASE_COPIADO, 'No hay tiendas abiertas.');
  const series = seriesPorSabor(datos);
  const hallazgos = [];
  let ruido = 0;
  let evaluadas = 0;

  for (const tienda of tiendas) {
    const propias = [...series].filter(([k]) => k.startsWith(`${tienda.id}|`));

    // Base: qué tan seguido repite esta tienda el mismo número exacto en noches seguidas.
    let pares = 0;
    let iguales = 0;
    for (const [, lista] of propias) {
      for (let i = 1; i < lista.length; i++) {
        if (diasEntre(lista[i - 1].fecha, lista[i].fecha) !== 1) continue;
        if (lista[i].gramos <= 0 && lista[i - 1].gramos <= 0) continue; // vacío dos noches es normal
        pares += 1;
        if (lista[i].gramos === lista[i - 1].gramos) iguales += 1;
      }
    }
    if (pares < 40) continue; // sin base no se puede distinguir "copia" de "balanza que redondea"
    evaluadas += 1;
    const tasaBase = iguales / pares;
    if (tasaBase >= 0.12) continue;

    const rachas = [];
    for (const [clave, lista] of propias) {
      let inicio = 0;
      for (let i = 1; i <= lista.length; i++) {
        const sigue = i < lista.length
          && diasEntre(lista[i - 1].fecha, lista[i].fecha) === 1
          && lista[i].gramos === lista[inicio].gramos;
        if (sigue) continue;
        const largo = i - inicio;
        if (largo >= 3 && lista[inicio].gramos >= 500) {
          rachas.push({
            sabor_id: Number(clave.split('|')[1]),
            desde: lista[inicio].fecha,
            hasta: lista[i - 1].fecha,
            noches: largo,
            gramos: lista[inicio].gramos,
          });
        }
        inicio = i;
      }
    }
    if (!rachas.length) continue;

    // Si en medio de la racha llegó un despacho de ese sabor, el número NO podía quedar igual:
    // es la prueba de que no se pesó.
    const conEntrega = rachas.filter((r) => datos.despachos.some(
      (d) => d.sucursal_id === tienda.id && d.sabor_id === r.sabor_id && d.estado !== 'no_disponible'
        && fechaEntrega(d) > r.desde && fechaEntrega(d) <= r.hasta
    ));
    const compuertas = [
      compuerta(`Esta tienda casi nunca repite un peso exacto (${redondear(tasaBase * 100, 0)}% de las noches)`, true),
      compuerta('Hay rachas de 3 o más noches con el mismo peso al gramo', true),
      compuerta('Se ve en más de un sabor o dura 5 noches o más', rachas.length >= 2 || rachas.some((r) => r.noches >= 5)),
      compuerta('En alguna racha llegó un despacho y el peso igual no cambió', conEntrega.length > 0, { requerida: false }),
    ];
    const nivel = nivelSegunCompuertas(compuertas);
    if (!nivel) {
      ruido += rachas.length;
      continue;
    }
    hallazgos.push(crearHallazgo({
      verificacion: BASE_COPIADO.id,
      area: AREA,
      clave: tienda.id,
      titulo: `${tienda.nombre}: pesos idénticos varias noches seguidas`,
      detalle: `Hay ${rachas.length} ${plural(rachas.length, 'sabor', 'sabores')} con exactamente el mismo peso durante 3 noches o más, en una tienda que normalmente no repite números.`,
      gravedad: GRAVEDAD.MEDIA,
      nivel,
      evidencia: rachas.slice(0, 4).map((r) => `${nombreSabor(datos, r.sabor_id)}: ${kg(r.gramos)} kg, ${r.noches} noches (${fechaCorta(r.desde)} al ${fechaCorta(r.hasta)})`),
      compuertas,
      descartado: [`No es la balanza redondeando: solo el ${redondear(tasaBase * 100, 0)}% de las noches de esta tienda repite un peso.`],
      accion: 'Pedile a la tienda que pese de verdad cada sabor todas las noches. Un peso copiado hace creer al sistema que no se vendió nada.',
      sucursal_id: tienda.id,
      sucursal_nombre: tienda.nombre,
    }));
  }

  if (!evaluadas) return sinDatos(BASE_COPIADO, 'Faltan al menos 40 comparaciones de noches seguidas por tienda para distinguir una copia de una balanza que redondea.');
  return resultado(BASE_COPIADO, {
    hallazgos,
    ruido,
    revisado: `${evaluadas} ${plural(evaluadas, 'tienda', 'tiendas')} con historial suficiente`,
  });
}

// ──────────────────────────────────────────────────────────────────────────────────────────

const BASE_ATIPICO = {
  id: 'pesaje_atipico',
  nombre: 'Pesajes con un cero de más',
  area: AREA,
};

/**
 * Un 2.4 kg tipeado como 24 kg. Cae fuera de lo que esa vitrina suele tener y a la noche
 * siguiente vuelve a lo normal: esa vuelta es la prueba de que fue un error y no un cambio real.
 *
 * Solo se mira para ARRIBA. Un peso muy bajo (0.3 kg cuando lo normal es 2.1) no es un error:
 * es lo que queda cuando el sabor está por acabarse, y pasa todos los días. Si se revisara
 * también hacia abajo, cada sabor casi vacío saldría como "error de tipeo".
 *
 * Este SÍ se reporta aunque sea un solo caso, porque no es una opinión: es un número que no
 * encaja con sus vecinos, y un solo dato así corrompe el consumo que calcula el motor.
 */
export function pesajeAtipico(datos) {
  const tiendas = tiendasAbiertas(datos);
  const ids = new Set(tiendas.map((t) => t.id));
  const series = seriesPorSabor(datos);
  const limite = sumarDias(datos.hoy, -30);
  const porTienda = new Map();
  let revisadas = 0;

  for (const [clave, lista] of series) {
    const [sucursalId, saborId] = clave.split('|');
    if (!ids.has(sucursalId) || lista.length < 8) continue;
    for (let i = 0; i < lista.length; i++) {
      const p = lista[i];
      if (p.fecha < limite) continue;
      revisadas += 1;
      const vecinas = lista.filter((_, j) => j !== i && Math.abs(j - i) <= 5).map((x) => x.gramos);
      if (vecinas.length < 6) continue;
      const tipico = mediana(vecinas);
      const referencia = Math.max(tipico, 500);
      const razon = p.gramos / referencia;
      const diferencia = Math.abs(p.gramos - tipico);
      if (diferencia < 1500 || razon < 5) continue;

      const antes = lista[i - 1];
      const despues = lista[i + 1];
      const normal = (v) => v && v.gramos >= referencia / 3 && v.gramos <= referencia * 3;
      // La prueba de que fue un error es que la noche SIGUIENTE vuelve a lo normal. Que la de
      // antes fuera normal no prueba nada: es lo que pasa al comienzo de cualquier salto, real o no.
      if (!normal(despues)) continue; // si se queda arriba, quizá sí cambió de verdad: no se afirma

      const lista2 = porTienda.get(sucursalId) || [];
      lista2.push({ sabor_id: Number(saborId), fecha: p.fecha, gramos: p.gramos, tipico, ambosVecinos: normal(antes) && normal(despues) });
      porTienda.set(sucursalId, lista2);
    }
  }

  const hallazgos = [];
  for (const [sucursalId, lista] of porTienda) {
    const tienda = nombreTienda(datos, sucursalId);
    const compuertas = [
      compuerta('El peso es al menos 5 veces mayor que el de las noches de al lado', true),
      compuerta('La diferencia es de más de 1.5 kg', true),
      compuerta('A la noche siguiente vuelve a lo normal', true),
      compuerta('Las dos noches de al lado están normales', lista.every((e) => e.ambosVecinos), { requerida: false }),
    ];
    const nivel = nivelSegunCompuertas(compuertas);
    if (!nivel) continue;
    hallazgos.push(crearHallazgo({
      verificacion: BASE_ATIPICO.id,
      area: AREA,
      clave: sucursalId,
      titulo: `${tienda}: ${lista.length} ${plural(lista.length, 'pesaje con un cero de más', 'pesajes con un cero de más')}`,
      detalle: 'Un peso que no encaja con las noches de al lado y que después vuelve a lo normal: casi seguro un error al tipear.',
      gravedad: GRAVEDAD.MEDIA,
      nivel,
      evidencia: lista.slice(0, 4).map((e) => `${fechaCorta(e.fecha)} · ${nombreSabor(datos, e.sabor_id)}: se cargó ${kg(e.gramos)} kg, lo normal es ${kg(e.tipico)} kg`),
      compuertas,
      descartado: ['No es un cambio real: a la noche siguiente el peso vuelve a su rango habitual.'],
      accion: 'Corregí ese pesaje. Mientras esté mal, el motor lo toma como consumo real y distorsiona lo que sugiere producir y mandar.',
      sucursal_id: sucursalId,
      sucursal_nombre: tienda,
    }));
  }

  if (!revisadas) return sinDatos(BASE_ATIPICO, 'Todavía no hay series de pesajes lo bastante largas (8 noches) para saber qué es normal.');
  return resultado(BASE_ATIPICO, { hallazgos, revisado: `${revisadas} pesajes de los últimos 30 días` });
}

// ──────────────────────────────────────────────────────────────────────────────────────────

const BASE_FALTANTES = {
  id: 'pesajes_faltantes',
  nombre: 'Noches sin pesar la vitrina',
  area: AREA,
};

/**
 * Noches en que la tienda trabajó pero no pesó (o pesó la mitad de los sabores).
 *
 * Sin pesaje el motor no sabe qué quedó, asume la vitrina vacía y manda de más. Es el error
 * más caro de los de registro porque no avisa: la tienda simplemente recibe de más.
 *
 * Para decir "no pesaron" hay que saber que ESE DÍA la tienda funcionó. Si nadie marcó
 * entrada ni llegó un despacho, probablemente estaba cerrada y no hay nada que reportar.
 */
export function pesajesFaltantes(datos) {
  const tiendas = tiendasAbiertas(datos);
  const porNoche = agruparPor(noches(datos), (p) => `${p.sucursal_id}|${p.fecha}`);
  const hallazgos = [];
  let ruido = 0;
  let evaluadas = 0;
  const ventana = sumarDias(datos.hoy, -14);

  for (const tienda of tiendas) {
    const propias = [...porNoche].filter(([k]) => k.startsWith(`${tienda.id}|`));
    const conteos = propias.map(([, l]) => l.length).filter((n) => n > 0);
    if (propias.length < 10) continue;
    // Percentil 75 y no mediana: si la mitad de las noches están incompletas, la mediana
    // se contamina con el mismo problema que se quiere detectar y "lo habitual" se achica solo.
    const habitual = Math.round(percentil(conteos, 0.75));
    if (!habitual || habitual < 3) continue;
    evaluadas += 1;

    const activa = (fecha) => datos.marcaciones.some((m) => m.sucursal_id === tienda.id && m.fecha === fecha)
      || datos.despachos.some((d) => d.sucursal_id === tienda.id && fechaEntrega(d) === fecha && d.estado === 'recibido');

    const faltas = [];
    for (let f = ventana; f < datos.hoy; f = sumarDias(f, 1)) {
      const hecho = (porNoche.get(`${tienda.id}|${f}`) || []).length;
      if (hecho >= 0.5 * habitual) continue;
      if (!activa(f)) continue; // no hay prueba de que ese día haya trabajado
      faltas.push({ fecha: f, hecho });
    }

    const compuertas = [
      compuerta(`En ${faltas.length} de los últimos 14 días pesaron menos de la mitad de lo habitual`, faltas.length >= 3),
      compuerta('En esos días la tienda sí trabajó (hay marcaciones o llegó un despacho)', faltas.length > 0),
      compuerta(`Lo habitual de esta tienda son ${habitual} sabores por noche`, true),
      compuerta('Alguna de esas noches no pesaron nada de nada', faltas.some((f) => f.hecho === 0), { requerida: false }),
    ];
    const nivel = nivelSegunCompuertas(compuertas);
    if (!nivel) {
      ruido += faltas.length;
      continue;
    }
    hallazgos.push(crearHallazgo({
      verificacion: BASE_FALTANTES.id,
      area: AREA,
      clave: tienda.id,
      titulo: `${tienda.nombre}: ${faltas.length} noches sin pesar la vitrina`,
      detalle: `En ${faltas.length} de los últimos 14 días la tienda trabajó pero pesó menos de la mitad de sus sabores habituales.`,
      gravedad: faltas.length >= 6 ? GRAVEDAD.ALTA : GRAVEDAD.MEDIA,
      nivel,
      evidencia: faltas.slice(-4).map((f) => `${fechaCorta(f.fecha)}: ${f.hecho} de ${habitual} sabores pesados`),
      compuertas,
      descartado: ['No eran días cerrados: esa tienda tuvo marcaciones o recibió despachos.'],
      accion: 'Recordale a la tienda que el pesaje de la noche es lo que evita que le mandemos de más. Sin él, el sistema asume vitrina vacía.',
      sucursal_id: tienda.id,
      sucursal_nombre: tienda.nombre,
    }));
  }

  if (!evaluadas) return sinDatos(BASE_FALTANTES, 'Todavía no hay 10 noches de pesajes por tienda para saber qué es lo habitual.');
  return resultado(BASE_FALTANTES, {
    hallazgos,
    ruido,
    revisado: `${evaluadas} ${plural(evaluadas, 'tienda', 'tiendas')} durante 14 días`,
  });
}

export const VERIFICACIONES_PESAJES = [pesajeSubeSinEntrada, pesajeCopiado, pesajeAtipico, pesajesFaltantes];

// Reexporta lo que otras verificaciones reutilizan.
export { nombreSabor, nombreTienda, gramosPana, ESTADOS_ENTREGADOS, listar, AREAS, NIVEL };
