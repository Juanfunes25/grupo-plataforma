import { mediana, ESTADOS_ENTREGADOS } from './rotacion.js';
import { DIAS_SEMANA, DIAS_CORTOS, diasEntre, sumarDias, diaSemanaDe } from './fechasSemana.js';

/**
 * Planificador de despacho: cuántas panas de cada sabor conviene mandar a cada tienda, el día
 * que le toca reparto. Es un modelo de planificación de demanda de verdad, no un promedio
 * disfrazado - abajo está el porqué de cada pieza.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * EL PROBLEMA DE FONDO
 *
 * No hay datos de venta por sabor (la factura es por tamaño, nunca dice el sabor). Lo único
 * que hay es: cuánto salió de fábrica hacia cada tienda, en qué fecha, y cuánto quedaba en la
 * vitrina cada noche. Con eso hay que reconstruir cuánto consume cada tienda cada día.
 *
 * La trampa: un despacho NO cubre el día en que sale. Cubre desde que llega hasta que llega el
 * próximo camión. Si a Próceres se le reparte jueves y sábado, el envío del jueves aguanta 2
 * días (jue+vie) y el del sábado aguanta 5 (sáb+dom+lun+mar+mié). Los kilos de un envío son
 * entonces una SUMA de varios días distintos mezclados, y no se puede saber "cuánto consume el
 * viernes" mirando un solo envío.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * 1. SEPARAR LOS DÍAS: mínimos cuadrados con regularización
 *
 * Cada envío es una ECUACIÓN. Si el envío del jueves cubre jue+vie y llevó 6 kg:
 *     x_jueves + x_viernes = 6
 * y si el del sábado cubre sáb+dom+lun+mar+mié y llevó 9 kg:
 *     x_sábado + x_domingo + x_lunes + x_martes + x_miércoles = 9
 *
 * Con muchas semanas se junta un sistema A·x = g de 7 incógnitas (una por día de la semana) y
 * se resuelve por mínimos cuadrados. Eso SÍ separa lo que aporta cada día, en vez de atribuir
 * todo al día en que salió el camión.
 *
 * El sistema suele estar mal condicionado (un calendario fijo repite siempre las mismas
 * combinaciones), así que se resuelve con regularización de Tíjonov (ridge) tirando hacia el
 * promedio general: cuando los datos no alcanzan para distinguir un día de otro, el perfil se
 * aplana solo y el modelo deja de afirmar lo que no puede probar. Cuando los datos sí
 * alcanzan, el perfil se despega. Es honesto por construcción: nunca inventa un patrón de fin
 * de semana que los números no sostengan.
 *
 * 2. DEMANDA CENSURADA: lo que no se pudo vender no es demanda cero
 *
 * Si un sabor se marcó 'no_disponible', o si la vitrina cerró prácticamente vacía antes del
 * próximo camión, la demanda real fue MAYOR que lo despachado: el dato está censurado por
 * arriba. Promediar esos casos como si fueran demanda normal es exactamente lo que hace que un
 * sistema se quede corto para siempre en los días fuertes. Acá esos casos se sacan del
 * promedio (no arrastran el número hacia abajo) y además suben el nivel de servicio de ese
 * sabor en ese día.
 *
 * 3. NIVEL DE SERVICIO: ni la mediana ni el exceso
 *
 * Mandar "lo típico" es apuntar al percentil 50: por definición te quedás corto 1 de cada 2
 * veces. Pero el gelato es perecedero, así que apuntar al 95% tampoco sirve: lo que sobra no
 * espera, se pone viejo. El objetivo del negocio es tenerlo SIEMPRE disponible y SIEMPRE
 * fresco, y esas dos cosas tiran para lados contrarios. Se apunta entonces al ~85% (z=1.04),
 * al ~94% (z=1.55) solo en lo que ya se viene quedando sin stock, y encima el colchón nunca
 * puede pasar del 20% de lo que se espera vender (35% en lo apretado). Ese tope es el freno
 * contra el "por las dudas mandá una más".
 *
 * 3b. PISO DE VITRINA: la vitrina no puede terminar en cero
 *
 * Todo lo anterior es demanda: cubrir lo que se espera vender. Pero apuntar exactamente al
 * consumo deja la vitrina vacía al final de cada ciclo, y eso es un problema de negocio, no de
 * demanda. Una vitrina vacía a la mañana no vende, y el fondo de una pana tampoco es producto
 * servible: 100 g sueltos no son "una copa disponible".
 *
 * Por eso cada sabor lleva un PISO que se SUMA al objetivo - gramos que tienen que quedar
 * cuando ya se vendió todo lo esperado, es decir justo antes del próximo camión, que es el
 * momento más bajo del ciclo. El piso sale de los pesajes nocturnos de ese sabor en esa
 * tienda (cuánto quedaba de verdad cada noche, con el mismo decaimiento por recencia), acotado
 * entre una pana y tres: menos de una pana no se ve ni se sirve, y más de tres no es un piso
 * sino sobrestock envejeciendo que no hay que volver permanente.
 *
 * Se arma UNA sola vez: como lo que se manda es la diferencia contra lo que la tienda ya
 * tiene (punto 4), una vez que el piso está en la vitrina no se vuelve a mandar.
 *
 * 4. LO QUE SE MANDA ES LA DIFERENCIA, NO EL OBJETIVO
 *
 * El objetivo dice cuánto tiene que HABER en la tienda ese día. Lo que hay que MANDAR es lo
 * que falta para llegar ahí, y para saberlo hay que saber qué tiene la tienda. Por eso la
 * agenda arranca del pesaje de vitrina de la última noche - un dato medido, no estimado - y
 * proyecta día por día: le resta el consumo esperado de cada día y le suma las entregas (las
 * reales mientras haya datos, las sugeridas de ahí en adelante). Sin esto, el plan mandaba el
 * objetivo completo en cada viaje, como si la tienda cerrara siempre en cero, y el colchón se
 * volvía a mandar entero cada semana: es exactamente cómo se sobreproduce sin darse cuenta.
 *
 * 5. RECENCIA: la semana pasada dice más que la de hace tres meses
 *
 * Todos los envíos entran ponderados con decaimiento exponencial (semivida de 4 semanas), así
 * el plan sigue las tendencias en vez de quedarse anclado al pasado.
 *
 * 6. PANAS, NO KILOS SUELTOS
 *
 * El despachador no carga "9.3 kg", carga panas enteras. El resultado final se redondea a
 * panas usando el gramaje real de cada sabor, que es la unidad en la que se toma la decisión.
 *
 * 7. EXACTITUD MEDIDA, NO PROMETIDA
 *
 * El modelo se autoevalúa contra su propia historia dejando cada envío afuera del ajuste y
 * prediciéndolo (leave-one-out), y reporta el error porcentual medio. Si el modelo le pega mal,
 * el panel lo dice en vez de aparentar precisión.
 *
 * Todo esto sale de datos que ya existen. Cada semana que pasa suma muestras y el plan se
 * afina solo, sin tocar el código.
 */

// Cuánto pesa un envío según su antigüedad: a las 4 semanas vale la mitad, a las 8 un cuarto.
const SEMIVIDA_DIAS = 28;

// Fuerza de la regularización, relativa a la escala del propio sistema. Más alto = perfil más
// plano (más conservador); más bajo = más dispuesto a afirmar diferencias entre días.
const KAPPA_RIDGE = 0.5;

// Ningún día puede quedar en 0 ni dispararse: son topes de cordura contra un sistema mal
// condicionado, no ajustes de gusto.
const PISO_PERFIL = 0.25;
const TECHO_PERFIL = 2.5;

// Nivel de servicio objetivo. El gelato es perecedero y el objetivo del negocio es tenerlo
// SIEMPRE fresco: sobrar es tan malo como faltar, solo que se nota más tarde. Por eso se apunta
// a ~85% (z=1.04) y no al 90-95% de un producto que no se echa a perder; a ~94% (z=1.55) solo
// en lo que ya se viene quedando sin stock.
const Z_SERVICIO = 1.04;
const Z_SERVICIO_APRETADO = 1.55;
const UMBRAL_APRIETE = 0.25;

// Y encima el colchón nunca puede pasar de esta fracción de lo que se espera vender. Con pocas
// semanas de historia la desviación estimada es inestable, y sin tope un sabor errático pedía
// el doble de lo que mueve. Es el freno que evita sobreproducir "por las dudas".
const TOPE_COLCHON = 0.2;
const TOPE_COLCHON_APRETADO = 0.35;

// Cuando no hay suficientes muestras para medir la variabilidad, se asume una dispersión
// típica de venta de mostrador (25%) en vez de asumir cero, que sería mentirse.
const CV_POR_DEFECTO = 0.25;

const MUESTRAS_CONFIABLES = 3;
const MUESTRAS_ALTA_CONFIANZA = 6;

// Debajo de esto no se recorta ninguna cola: con 5 datos no se puede distinguir un error de
// carga de un día que de verdad fue distinto.
const MUESTRAS_PARA_RECORTAR = 8;

// Un sabor que hace más de 5 semanas que no le llega a esa tienda ya no va en la lista de
// carga: ensucia una pantalla que se usa para armar el camión.
const DIAS_VIGENCIA_SABOR = 35;

const GRAMOS_PANA_POR_DEFECTO = 3000;

// La vitrina cerró "vacía" si quedó menos del 10% de lo que se había mandado.
const FRACCION_VITRINA_VACIA = 0.1;

// Para creerle al perfil medido día por día hacen falta al menos estas observaciones limpias
// en CADA día de la semana; con menos, se cae al perfil estimado desde los envíos.
const MIN_OBS_POR_DIA = 3;

// Cuántos días hacia adelante se arma la agenda concreta de reparto.
const DIAS_AGENDA = 14;

// Un pesaje más viejo que esto ya no dice nada útil sobre lo que la tienda tiene HOY.
const DIAS_PESAJE_VIGENTE = 4;

// El piso de vitrina nunca baja de una pana entera de cada sabor: con menos, el fondo de la
// pana no es producto servible (nadie arma una copa raspando 100 g) y además se ve vacío.
const PISO_MINIMO_PANAS = 1;

// Ni sube más allá de esto: un piso desmedido es gelato parado envejeciendo en vitrina, que
// es justo lo contrario de lo que se busca. Si el histórico dice que quedan 40 kg de un
// sabor, eso es sobrestock viejo, no un piso que haya que sostener.
const TECHO_PISO_PANAS = 3;

/** Eliminación gaussiana con pivoteo parcial. El sistema es 7x7, así que no hace falta nada
 *  más sofisticado. Devuelve null si sale singular (ahí se cae al perfil plano). */
function resolverSistema(S, b) {
  const n = b.length;
  const M = S.map((fila, i) => [...fila, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let f = col + 1; f < n; f++) {
      if (Math.abs(M[f][col]) > Math.abs(M[piv][col])) piv = f;
    }
    if (Math.abs(M[piv][col]) < 1e-9) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let f = col + 1; f < n; f++) {
      const factor = M[f][col] / M[col][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[f][c] -= factor * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let f = n - 1; f >= 0; f--) {
    let acc = M[f][n];
    for (let c = f + 1; c < n; c++) acc -= M[f][c] * x[c];
    x[f] = acc / M[f][f];
  }
  return x.every((v) => Number.isFinite(v)) ? x : null;
}

function cuantilPonderado(valores, pesos, q) {
  if (!valores.length) return 0;
  const pares = valores.map((v, i) => ({ v, w: pesos[i] ?? 1 })).sort((a, b) => a.v - b.v);
  const total = pares.reduce((acc, p) => acc + p.w, 0);
  if (!(total > 0)) return pares[0].v;
  let acumulado = 0;
  for (const p of pares) {
    acumulado += p.w;
    if (acumulado >= q * total) return p.v;
  }
  return pares[pares.length - 1].v;
}

const medianaPonderada = (valores, pesos) => cuantilPonderado(valores, pesos, 0.5);

/**
 * Media ponderada con winsorización por cuantiles: los valores absurdos (una carga con un
 * dígito de más, un día de fiesta patronal) se recortan al borde del rango razonable en vez de
 * descartarse - así siguen contando como "fue un día alto" sin arrastrar el promedio.
 *
 * Por cuantiles y NO por MAD a propósito: la MAD mide la dispersión del grupo mayoritario, así
 * que cuando los datos son bimodales - una demanda que se duplicó hace tres semanas, o un día
 * de la semana muy distinto al resto - marca como "outlier" justo la mitad de la señal que
 * interesa y devuelve el nivel viejo. Los cuantiles no asumen ninguna forma de distribución.
 */
function estimadorRobusto(valores, pesos) {
  const n = valores.length;
  if (n === 0) return { media: 0, sigma: 0, n: 0 };
  if (n === 1) return { media: valores[0], sigma: 0, n: 1 };

  const w = valores.map((_, i) => pesos[i] ?? 1);
  // Con pocas muestras no se recorta nada: no hay forma de distinguir un error de carga de un
  // día realmente distinto, y recortar sería inventar una certeza que no existe.
  let acotados = valores;
  if (n >= MUESTRAS_PARA_RECORTAR) {
    const inf = cuantilPonderado(valores, w, 0.05);
    const sup = cuantilPonderado(valores, w, 0.95);
    acotados = valores.map((v) => Math.min(Math.max(v, inf), sup));
  }

  const sumaW = w.reduce((a, b) => a + b, 0) || n;
  const media = acotados.reduce((a, v, i) => a + v * w[i], 0) / sumaW;

  // Varianza ponderada con corrección por pesos de confiabilidad (Bessel generalizado).
  const sumaW2 = w.reduce((a, b) => a + b * b, 0);
  const denom = sumaW - sumaW2 / sumaW;
  const disp = acotados.reduce((a, v, i) => a + w[i] * (v - media) ** 2, 0);
  const sigma = denom > 0 ? Math.sqrt(disp / denom) : 0;

  return { media, sigma, n };
}

/**
 * Perfil semanal de una tienda: cuánto consume cada día de la semana respecto de un día
 * promedio (1.0 = día normal, 1.4 = 40% más que un día normal). Sale de resolver el sistema
 * de todos los envíos por mínimos cuadrados regularizados (ver el encabezado del archivo).
 */
function perfilSemanal(todosLosEventos) {
  const plano = { perfil: new Array(7).fill(1), mu: 0, ajustado: false };
  // Una visita en la que faltó la mitad o más del surtido no mide la demanda de esos días:
  // mide que no había producto. Meterla al ajuste haría que el modelo aprenda que se consume
  // menos justo donde más faltó - exactamente al revés de la realidad.
  const eventos = todosLosEventos.filter((e) => e.fraccionCensurada < 0.5);
  if (!eventos.length) return plano;

  const sumaPesoDias = eventos.reduce((a, e) => a + e.peso * e.dias, 0);
  const sumaPesoGramos = eventos.reduce((a, e) => a + e.peso * e.gramosTotalPerfil, 0);
  const mu = sumaPesoDias > 0 ? sumaPesoGramos / sumaPesoDias : 0;
  if (!(mu > 0)) return plano;

  // Ecuaciones normales ponderadas: (AᵀWA + λI)·x = AᵀWg + λμ
  const AtWA = Array.from({ length: 7 }, () => new Array(7).fill(0));
  const AtWg = new Array(7).fill(0);
  for (const e of eventos) {
    for (let j = 0; j < 7; j++) {
      if (!e.conteo[j]) continue;
      AtWg[j] += e.peso * e.conteo[j] * e.gramosTotalPerfil;
      for (let k = 0; k < 7; k++) {
        if (e.conteo[k]) AtWA[j][k] += e.peso * e.conteo[j] * e.conteo[k];
      }
    }
  }

  const traza = AtWA.reduce((a, fila, j) => a + fila[j], 0);
  const lambda = (traza / 7) * KAPPA_RIDGE;
  if (!(lambda > 0)) return { ...plano, mu };

  const S = AtWA.map((fila, j) => fila.map((v, k) => (j === k ? v + lambda : v)));
  const b = AtWg.map((v) => v + lambda * mu);
  const x = resolverSistema(S, b);
  if (!x) return { ...plano, mu };

  const acotado = x.map((v) => Math.min(Math.max(v, PISO_PERFIL * mu), TECHO_PERFIL * mu));
  const promedio = acotado.reduce((a, v) => a + v, 0) / 7;
  if (!(promedio > 0)) return { ...plano, mu };

  return { perfil: acotado.map((v) => v / promedio), mu, ajustado: true };
}


/**
 * Consumo diario medido con los pesajes nocturnos:
 *
 *     consumo del día d = lo que quedaba anoche + lo que entró hoy - lo que queda esta noche
 *
 * Esto es lo único que resuelve el problema de fondo. Con reparto jueves/viernes/sábado, el
 * envío del sábado cubre sáb+dom+lun+mar+mié: por más semanas que pasen, los despachos NUNCA
 * van a poder decir si el sábado mueve más que el lunes, porque siempre viajan juntos en el
 * mismo envío. Los pesajes sí lo separan, porque miden cada noche por separado.
 *
 * Se trabaja con índices (consumo del día ÷ consumo típico de ESE sabor) y no con gramos, así
 * un sabor grande y uno chico pesan lo mismo en la forma de la semana, y no hace falta que
 * todos los sabores tengan pesaje todas las noches para poder usar los que sí lo tienen.
 *
 * Se descartan: días con consumo negativo (error de pesaje), y días en que la vitrina cerró
 * casi vacía - esos últimos no miden cuánto se consumió sino cuánto había, que es otra cosa.
 */
function consumoDiarioPorSabor(tienda, vitrina, finVentana) {
  const porSabor = new Map(); // saborId -> [{ diaSemana, consumo, peso }]

  for (const saborId of tienda.sabores.keys()) {
    const observaciones = [];
    for (const fecha of tienda.fechasConPesaje) {
      const hoyGr = vitrina.get(`${tienda.sucursal_id}|${saborId}|${fecha}`);
      const ayerGr = vitrina.get(`${tienda.sucursal_id}|${saborId}|${sumarDias(fecha, -1)}`);
      if (hoyGr === undefined || ayerGr === undefined) continue;

      const entrada = tienda.visitas.get(fecha)?.entregas.get(saborId) || 0;
      const disponible = ayerGr + entrada;
      const consumo = disponible - hoyGr;
      if (!(consumo >= 0) || disponible <= 0) continue; // pesaje inconsistente
      if (hoyGr <= FRACCION_VITRINA_VACIA * disponible) continue; // se agotó: dato censurado

      observaciones.push({
        diaSemana: diaSemanaDe(fecha),
        consumo,
        peso: Math.pow(0.5, Math.max(0, diasEntre(fecha, finVentana)) / SEMIVIDA_DIAS),
      });
    }
    if (observaciones.length >= 7) porSabor.set(saborId, observaciones);
  }
  return porSabor;
}

/** Arma el perfil semanal con el consumo medido (ver consumoDiarioPorSabor). null si la
 *  cobertura de pesajes no alcanza para hablar de todos los días de la semana. */
function perfilDeVitrina(porSabor) {
  if (!porSabor.size) return null;

  // Índice de cada día contra el consumo típico de su propio sabor.
  const indices = Array.from({ length: 7 }, () => ({ suma: 0, peso: 0, n: 0 }));
  for (const observaciones of porSabor.values()) {
    const pesoTotal = observaciones.reduce((a, o) => a + o.peso, 0);
    const tipico = observaciones.reduce((a, o) => a + o.consumo * o.peso, 0) / pesoTotal;
    if (!(tipico > 0)) continue;
    for (const o of observaciones) {
      const slot = indices[o.diaSemana];
      slot.suma += (o.consumo / tipico) * o.peso;
      slot.peso += o.peso;
      slot.n += 1;
    }
  }

  if (indices.some((s) => s.n < MIN_OBS_POR_DIA)) return null; // cobertura insuficiente
  const crudo = indices.map((s) => s.suma / s.peso);
  const promedio = crudo.reduce((a, v) => a + v, 0) / 7;
  if (!(promedio > 0)) return null;

  const perfil = crudo.map((v) => {
    const normalizado = v / promedio;
    return Math.min(Math.max(normalizado, PISO_PERFIL), TECHO_PERFIL);
  });
  const reescala = perfil.reduce((a, v) => a + v, 0) / 7;
  return { perfil: perfil.map((v) => v / reescala), observaciones: indices.reduce((a, s) => a + s.n, 0) };
}


/**
 * El PISO DE VITRINA de un sabor en una tienda: los gramos que tienen que quedar SIEMPRE,
 * aunque no se vendan.
 *
 * El resto del modelo apunta a cubrir el consumo, así que por construcción la vitrina termina
 * cada ciclo cerca de cero. Eso está mal por dos razones que no son de demanda sino de
 * negocio: una vitrina vacía a la mañana no vende, y el fondo de una pana no es producto
 * servible - 100 g sueltos no son "una copa disponible", no se puede armar nada decente
 * raspando el fondo.
 *
 * De dónde sale el número: de los pesajes nocturnos de ESE sabor en ESA tienda - cuánto
 * quedaba de verdad cada noche - tomando el típico con el mismo decaimiento por recencia que
 * usa el resto del modelo. Es lo que pidió el dueño: que salga de lo que queda casi siempre,
 * no de un número inventado.
 *
 * Y se acota por los dos lados. Por abajo, nunca menos de una pana entera. Por arriba, nunca
 * más de tres: si el histórico dice que quedan 40 kg de un sabor, eso no es un piso a
 * sostener, es sobrestock envejeciendo, y copiarlo como objetivo lo volvería permanente.
 *
 * Importante: esto se SUMA al objetivo, no lo reemplaza, y se arma UNA sola vez. La agenda
 * manda la diferencia contra lo que la tienda ya tiene, así que una vez que el piso está en
 * la vitrina no se vuelve a mandar.
 */
function pisoDeVitrina(nochesGramos, hoy, gramosPana) {
  const pana = gramosPana > 0 ? gramosPana : GRAMOS_PANA_POR_DEFECTO;
  const minimo = PISO_MINIMO_PANAS * pana;
  const maximo = TECHO_PISO_PANAS * pana;
  if (!nochesGramos.length) return minimo;

  const valores = nochesGramos.map((n) => n.gramos);
  const pesos = nochesGramos.map((n) => Math.pow(0.5, diasEntre(n.fecha, hoy) / SEMIVIDA_DIAS));
  const tipico = cuantilPonderado(valores, pesos, 0.5);

  return Math.min(Math.max(tipico, minimo), maximo);
}

/**
 * ¿Conviene sumar un día de reparto?
 *
 * El resto del modelo describe el calendario que YA existe: dice cuánto mandar los días en que
 * de hecho pasa el camión. Pero el calendario también es una decisión, y suele ser la que más
 * plata mueve. Si la ventana más larga concentra mucha carga - y encima cae sobre los días
 * fuertes - partirla con un reparto extra baja el pico del camión, baja el riesgo de quedarse
 * corto al final de la ventana, y deja el producto más fresco en vitrina.
 *
 * Se busca el día que parte la ventana más pareja (el que minimiza el pico de los dos tramos) y
 * solo se sugiere si el pico baja de verdad; si mover el calendario no cambia nada, no se dice
 * nada. Es una sugerencia sobre el calendario, no sobre cuánto mandar.
 */
function oportunidadDeCalendario(dias, perfil) {
  if (!dias.length) return null;
  const masLarga = dias.reduce((a, d) => (d.diasACubrir > a.diasACubrir ? d : a), dias[0]);
  if (masLarga.diasACubrir < 3) return null;

  const ventana = ventanaDeDias(masLarga.diaSemana, masLarga.diasACubrir);
  const total = ventana.reduce((a, j) => a + perfil[j], 0);
  if (!(total > 0)) return null;

  let mejor = null;
  for (let k = 1; k < ventana.length; k++) {
    const primero = ventana.slice(0, k).reduce((a, j) => a + perfil[j], 0);
    const pico = Math.max(primero, total - primero);
    if (!mejor || pico < mejor.pico) mejor = { pico, dia: ventana[k], k };
  }

  const reduccionPct = Math.round((1 - mejor.pico / total) * 100);
  if (reduccionPct < 15) return null; // partirla no cambiaría nada que valga la pena

  return {
    diaSugerido: mejor.dia,
    nombreDia: DIAS_SEMANA[mejor.dia],
    parteEl: masLarga.nombreDia,
    diasACubrirActual: masLarga.diasACubrir,
    kgPicoActual: masLarga.totalKgObjetivo,
    kgPicoTrasDividir: Math.round(masLarga.totalKgObjetivo * (mejor.pico / total) * 10) / 10,
    reduccionPct,
    // Los días fuertes que hoy quedan al final de la ventana son los que más sufren: llegan
    // con producto de varios días de antigüedad y con el stock ya bajo.
    diasFuertesAlFinal: ventana
      .slice(mejor.k)
      .filter((j) => perfil[j] >= 1.15)
      .map((j) => DIAS_SEMANA[j]),
  };
}

/**
 * La agenda concreta de reparto: qué mandar, en qué fecha, en panas.
 *
 * El plan semanal dice cuánto tiene que HABER en la tienda un jueves normal. Lo que hay que
 * MANDAR es la diferencia entre eso y lo que la tienda va a tener ese jueves - y eso no se
 * adivina: se arranca del pesaje de vitrina de la última noche, que es una medición, y se
 * proyecta hacia adelante día por día.
 *
 *     stock(mañana) = stock(hoy) + lo que entra mañana - tasaBase · perfil[día de mañana]
 *
 * Mientras haya datos, "lo que entra" son los despachos REALES ya registrados. De ahí en
 * adelante son los sugeridos, que se calculan sobre el stock ya proyectado. Así la sugerencia
 * del sábado ya sabe cuánto se mandó el jueves: la agenda es consistente consigo misma, no
 * siete decisiones sueltas que se pisan.
 *
 * Se redondea a panas enteras al mandar (es la unidad en que se carga el camión) y el stock
 * que se arrastra es el de las panas enteras, no el ideal, así que el sobrante de redondear
 * de un viaje se descuenta del siguiente en vez de acumularse viaje tras viaje.
 */
function construirAgenda({ t, porSabor, perfil, dias, ultimoPesaje, finVentana, hoy }) {
  const planPorDiaSemana = new Map(dias.map((d) => [d.diaSemana, d]));
  // La agenda empieza donde terminan los datos: lo ya despachado no se vuelve a sugerir.
  const inicio = hoy > finVentana ? hoy : sumarDias(finVentana, 1);
  const fin = sumarDias(hoy, DIAS_AGENDA - 1);
  if (inicio > fin) return { agenda: [], pesajeDesde: null, saboresSinPesaje: 0 };

  const fechas = [];
  for (let f = inicio; f <= fin; f = sumarDias(f, 1)) fechas.push(f);

  // Objetivo de cada sabor según el día de la semana en que le toca reparto.
  const objetivoDe = new Map(); // saborId -> Map(diaSemana -> gramos)
  const metaSabor = new Map();
  for (const d of dias) {
    for (const s of d.sabores) {
      if (!objetivoDe.has(s.sabor_id)) objetivoDe.set(s.sabor_id, new Map());
      objetivoDe.get(s.sabor_id).set(d.diaSemana, s.gramosObjetivo);
      metaSabor.set(s.sabor_id, s);
    }
  }

  const salidas = new Map(fechas.map((f) => [f, []]));
  let pesajeDesde = null;
  let saboresSinPesaje = 0;

  for (const [saborId, meta] of metaSabor) {
    const s = porSabor.get(saborId);
    if (!s) continue;

    const pesaje = ultimoPesaje.get(`${t.sucursal_id}|${saborId}`);
    const antiguedad = pesaje ? diasEntre(pesaje.fecha, hoy) : null;
    // Un pesaje de hace una semana no dice nada de lo que hay hoy. Sin uno reciente se asume
    // la vitrina en cero: es el supuesto que garantiza que no falte, y se marca en pantalla
    // para que se vea que ahí el número viene de un supuesto y no de una medición.
    const medido = Boolean(pesaje && antiguedad >= 0 && antiguedad <= DIAS_PESAJE_VIGENTE);
    if (!medido) saboresSinPesaje += 1;
    if (medido && (!pesajeDesde || pesaje.fecha > pesajeDesde)) pesajeDesde = pesaje.fecha;

    let stock = medido ? Math.max(0, pesaje.gramos) : 0;
    const desde = medido ? sumarDias(pesaje.fecha, 1) : inicio;

    for (let f = desde; f <= fin; f = sumarDias(f, 1)) {
      const diaSemana = diaSemanaDe(f);
      let entrada = 0;

      if (f < inicio) {
        // Todavía hay datos: lo que entró de verdad, no lo que el modelo hubiera sugerido.
        entrada = t.visitas.get(f)?.entregas.get(saborId) || 0;
      } else if (planPorDiaSemana.has(diaSemana)) {
        const objetivo = objetivoDe.get(saborId)?.get(diaSemana);
        if (objetivo !== undefined) {
          const faltan = Math.max(0, objetivo - stock);
          const panas = Math.round(faltan / meta.gramosPana);
          entrada = panas * meta.gramosPana;
          salidas.get(f).push({
            sabor_id: saborId,
            nombre: meta.nombre,
            panas,
            gramosEnviar: entrada,
            kgEnviar: Math.round(entrada / 100) / 10,
            kgStock: Math.round(stock / 100) / 10,
            kgObjetivo: Math.round(objetivo / 100) / 10,
            kgPiso: meta.kgPiso,
            stockMedido: medido,
            gramosPana: meta.gramosPana,
            confianza: meta.confianza,
            vecesSinStock: meta.vecesSinStock,
            vecesVitrinaVacia: meta.vecesVitrinaVacia,
          });
        }
      }

      stock = Math.max(0, stock + entrada - s.tasaBase * (perfil[diaSemana] || 1));
    }
  }

  const agenda = [];
  for (const f of fechas) {
    const items = salidas.get(f);
    if (!items.length) continue;
    const diaSemana = diaSemanaDe(f);
    const plan = planPorDiaSemana.get(diaSemana);
    items.sort((a, b) => b.gramosEnviar - a.gramosEnviar || a.nombre.localeCompare(b.nombre));
    agenda.push({
      fecha: f,
      diaSemana,
      nombreDia: DIAS_SEMANA[diaSemana],
      nombreCorto: DIAS_CORTOS[diaSemana],
      diasACubrir: plan?.diasACubrir ?? 1,
      cubre: plan?.cubre ?? [DIAS_CORTOS[diaSemana]],
      totalPanas: items.reduce((a, i) => a + i.panas, 0),
      totalKg: Math.round(items.reduce((a, i) => a + i.gramosEnviar, 0) / 100) / 10,
      sabores: items,
    });
  }

  return { agenda, pesajeDesde, saboresSinPesaje };
}

/** Los días de la semana que cubre un despacho que sale el día `diaSemana` y dura `dias`. */
export function ventanaDeDias(diaSemana, dias) {
  return Array.from({ length: dias }, (_, i) => (diaSemana + i) % 7);
}

/**
 * `despachos`: { fecha, sucursal_id, sucursal_nombre, sabor_id, sabor_nombre, gramos_pana,
 * gramos_enviados, estado }. `pesajes`: { sucursal_id, sabor_id, fecha, gramos } (opcional,
 * solo se usa para detectar vitrinas que cerraron vacías). `hasta`: fin de la ventana pedida,
 * para ponderar por recencia.
 */
export function armarRecomendacion({ despachos, pesajes = [], hasta = null, hoy = null }) {
  const fechasTodas = despachos.map((d) => d.fecha).filter(Boolean).sort();
  const finVentana = hasta || fechasTodas[fechasTodas.length - 1];
  if (!finVentana) return { tiendas: [] };
  const hoyEfectivo = hoy || finVentana;

  const vitrina = new Map();
  const fechasPesaje = new Map(); // sucursal_id -> Set(fecha)
  // La última medición de cada vitrina: el punto de partida real de la agenda.
  const ultimoPesaje = new Map(); // `sucursal|sabor` -> { fecha, gramos }
  // TODAS las mediciones de cada vitrina, para saber cuánto queda típicamente de cada sabor.
  const nochesPorSabor = new Map(); // `sucursal|sabor` -> [{ fecha, gramos }]
  for (const p of pesajes) {
    vitrina.set(`${p.sucursal_id}|${p.sabor_id}|${p.fecha}`, p.gramos);
    if (!fechasPesaje.has(p.sucursal_id)) fechasPesaje.set(p.sucursal_id, new Set());
    fechasPesaje.get(p.sucursal_id).add(p.fecha);
    const clave = `${p.sucursal_id}|${p.sabor_id}`;
    const previo = ultimoPesaje.get(clave);
    if (!previo || p.fecha >= previo.fecha) ultimoPesaje.set(clave, { fecha: p.fecha, gramos: Number(p.gramos) || 0 });
    if (!nochesPorSabor.has(clave)) nochesPorSabor.set(clave, []);
    nochesPorSabor.get(clave).push({ fecha: p.fecha, gramos: Math.max(0, Number(p.gramos) || 0) });
  }

  // ── 1. Agrupar por tienda y por VISITA (fecha en que pasó el camión) ────────────────────
  // Un 'no_disponible' también es una visita: el despachador estuvo, pero de ese sabor no
  // había. Tratarlo como "no hubo visita" alargaría la ventana del envío anterior sin sumarle
  // gramos, y el modelo concluiría que se consume MENOS justo donde faltó producto.
  const tiendas = new Map();
  for (const d of despachos) {
    const entregado = ESTADOS_ENTREGADOS.includes(d.estado);
    const quiebre = d.estado === 'no_disponible';
    if (!entregado && !quiebre) continue;

    if (!tiendas.has(d.sucursal_id)) {
      tiendas.set(d.sucursal_id, {
        sucursal_id: d.sucursal_id,
        nombre: d.sucursal_nombre,
        visitas: new Map(),
        sabores: new Map(),
        fechasConPesaje: fechasPesaje.get(d.sucursal_id) || new Set(),
      });
    }
    const t = tiendas.get(d.sucursal_id);
    if (!t.visitas.has(d.fecha)) t.visitas.set(d.fecha, { entregas: new Map(), quiebres: new Set() });
    const visita = t.visitas.get(d.fecha);

    if (!t.sabores.has(d.sabor_id)) {
      t.sabores.set(d.sabor_id, {
        nombre: d.sabor_nombre,
        gramosPana: Number(d.gramos_pana) > 0 ? Number(d.gramos_pana) : GRAMOS_PANA_POR_DEFECTO,
        primeraEntrega: null,
        ultimaEntrega: null,
      });
    }
    const s = t.sabores.get(d.sabor_id);

    if (quiebre) {
      visita.quiebres.add(d.sabor_id);
    } else {
      const gramos = d.gramos_enviados || 0;
      visita.entregas.set(d.sabor_id, (visita.entregas.get(d.sabor_id) || 0) + gramos);
      if (gramos > 0) {
        if (!s.primeraEntrega || d.fecha < s.primeraEntrega) s.primeraEntrega = d.fecha;
        if (!s.ultimaEntrega || d.fecha > s.ultimaEntrega) s.ultimaEntrega = d.fecha;
      }
    }
  }

  const resultado = [];

  for (const t of tiendas.values()) {
    const fechas = [...t.visitas.keys()].sort();

    // ── 2. Eventos: cada visita con la ventana que tuvo que cubrir hasta la siguiente ─────
    // La última visita queda afuera: todavía no se sabe cuánto tuvo que durar (dato censurado
    // por el borde de la ventana, no un dato real).
    const eventos = [];
    for (let i = 0; i < fechas.length - 1; i++) {
      const fecha = fechas[i];
      const dias = diasEntre(fecha, fechas[i + 1]);
      if (dias <= 0) continue;
      const diaSemana = diaSemanaDe(fecha);
      const conteo = new Array(7).fill(0);
      for (const j of ventanaDeDias(diaSemana, dias)) conteo[j] += 1;
      const visita = t.visitas.get(fecha);
      let gramosTotal = 0;
      let conEntrega = 0;
      for (const g of visita.entregas.values()) {
        gramosTotal += g;
        if (g > 0) conEntrega += 1;
      }
      // Si en esa visita faltó producto, el total NO es una medición limpia de la demanda de
      // esos días: le falta lo que se habría mandado de los sabores que no había. Se completa
      // suponiendo que los faltantes habrían aportado como el promedio de los presentes, que es
      // la corrección mínima. Si faltó la mitad o más del surtido, el dato ya no sirve para
      // ajustar el perfil y se descarta (ver perfilSemanal).
      const censurados = visita.quiebres.size;
      const fraccionCensurada = conEntrega + censurados > 0 ? censurados / (conEntrega + censurados) : 0;
      const gramosTotalPerfil = fraccionCensurada > 0 && fraccionCensurada < 1
        ? gramosTotal / (1 - fraccionCensurada)
        : gramosTotal;
      eventos.push({
        fecha,
        fechaFin: fechas[i + 1],
        diaSemana,
        dias,
        conteo,
        gramosTotal,
        gramosTotalPerfil,
        fraccionCensurada,
        entregas: visita.entregas,
        quiebres: visita.quiebres,
        peso: Math.pow(0.5, Math.max(0, diasEntre(fecha, finVentana)) / SEMIVIDA_DIAS),
      });
    }
    if (!eventos.length) continue;

    // ── 3. Perfil semanal de la tienda ───────────────────────────────────────────────────
    // Primero se intenta MEDIRLO día por día con los pesajes: es la única fuente que puede
    // separar un sábado de un lunes cuando los dos viajan siempre en el mismo envío. Si no
    // alcanza la cobertura de pesajes, se ESTIMA desde los envíos, que es lo mejor que se
    // puede hacer con esos datos y no llega tan fino.
    const consumoPorSabor = consumoDiarioPorSabor(t, vitrina, finVentana);
    const medido = perfilDeVitrina(consumoPorSabor);
    const estimado = perfilSemanal(eventos);
    const perfil = medido ? medido.perfil : estimado.perfil;
    const ajustado = medido ? true : estimado.ajustado;
    const fuentePerfil = medido ? 'vitrina' : estimado.ajustado ? 'envios' : 'ninguna';

    // Peso de perfil de cada ventana: cuántos "días normales" equivale la ventana que cubrió.
    for (const e of eventos) {
      e.pesoPerfil = e.conteo.reduce((a, c, j) => a + c * perfil[j], 0);
    }

    // ── 4. Tasa base y variabilidad por sabor ────────────────────────────────────────────
    const porSabor = new Map();
    for (const [saborId, info] of t.sabores) {
      if (!info.primeraEntrega) continue; // solo hubo quiebres: no hay nada que estimar

      const tasas = [];
      const pesos = [];
      const multiplicadores = [];
      const porDia = new Map(); // diaSemana -> { eventos, quiebres, vacias }

      for (const e of eventos) {
        // Antes de la primera entrega el sabor no existía para esta tienda: contar esos ceros
        // sería inventar demanda cero de algo que ni se ofrecía.
        if (e.fecha < info.primeraEntrega) continue;

        if (!porDia.has(e.diaSemana)) porDia.set(e.diaSemana, { eventos: 0, quiebres: 0, vacias: 0 });
        const dia = porDia.get(e.diaSemana);
        dia.eventos += 1;

        if (e.quiebres.has(saborId)) {
          dia.quiebres += 1;
          continue; // demanda censurada: no había producto, no es "demanda baja"
        }

        const gramos = e.entregas.get(saborId) || 0;

        // ¿Cerró la vitrina prácticamente vacía antes del próximo camión? También es demanda
        // censurada: pudo haberse vendido más y no había. Se busca el pesaje del último día
        // de la ventana, con hasta 2 días de tolerancia si esa noche no se reportó.
        let vacia = false;
        if (gramos > 0) {
          for (let atras = 1; atras <= 3; atras++) {
            const f = sumarDias(e.fechaFin, -atras);
            if (f < e.fecha) break;
            const sobra = vitrina.get(`${t.sucursal_id}|${saborId}|${f}`);
            if (sobra === undefined) continue;
            vacia = sobra <= FRACCION_VITRINA_VACIA * gramos;
            break;
          }
        }
        if (vacia) {
          dia.vacias += 1;
          continue;
        }

        if (e.pesoPerfil > 0) {
          tasas.push(gramos / e.pesoPerfil);
          pesos.push(e.peso);
          multiplicadores.push(e.pesoPerfil);
        }
      }

      // Con qué medir la demanda. Si hay pesajes, se mide del CONSUMO real y no de los gramos
      // despachados: en una reposición a nivel objetivo, lo que se manda depende de cuánto
      // había quedado en la vitrina, así que los despachos son una señal mucho más ruidosa
      // que el consumo - y esa diferencia es justo lo que hace que un plan basado en envíos
      // le erre feo. El consumo, en cambio, es lo que de verdad se quiere predecir.
      const obsVitrina = medido ? consumoPorSabor.get(saborId) : null;
      let serie;
      if (obsVitrina && obsVitrina.length >= MUESTRAS_CONFIABLES) {
        serie = {
          fuente: 'vitrina',
          valores: obsVitrina.map((o) => o.consumo / (perfil[o.diaSemana] || 1)),
          pesos: obsVitrina.map((o) => o.peso),
          multiplicadores: obsVitrina.map((o) => perfil[o.diaSemana] || 1),
        };
      } else if (tasas.length) {
        serie = { fuente: 'envios', valores: tasas, pesos, multiplicadores };
      } else {
        continue;
      }

      const { media: tasaBase, sigma, n } = estimadorRobusto(serie.valores, serie.pesos);
      if (!(tasaBase > 0)) continue;

      porSabor.set(saborId, { info, tasaBase, sigma, n, serie, porDia });
    }

    // ── 5. Autoevaluación leave-one-out: qué tan bien le pega el modelo a su propia historia
    let apeSuma = 0;
    let apePeso = 0;
    let dentro = 0;
    for (const s of porSabor.values()) {
      if (s.n < MUESTRAS_CONFIABLES) continue;
      const { valores, pesos: pesosSerie, multiplicadores: mult } = s.serie;
      for (let k = 0; k < valores.length; k++) {
        const real = valores[k] * mult[k];
        if (!(real > 0)) continue;
        // Se reajusta el modelo SIN esta observación y recién ahí se la predice: si no, se
        // estaría evaluando con la respuesta a la vista y cualquier modelo parecería exacto.
        const { media } = estimadorRobusto(
          valores.filter((_, i) => i !== k),
          pesosSerie.filter((_, i) => i !== k)
        );
        const ape = Math.abs(media * mult[k] - real) / real;
        apeSuma += ape * pesosSerie[k];
        apePeso += pesosSerie[k];
        if (ape <= 0.2) dentro += pesosSerie[k];
      }
    }
    const precision = apePeso > 0
      ? {
          errorMedioPct: Math.round((apeSuma / apePeso) * 1000) / 10,
          dentroDe20Pct: Math.round((dentro / apePeso) * 1000) / 10,
          muestras: Math.round(apePeso * 10) / 10,
        }
      : null;

    // ── 6. El plan: por cada día en que esta tienda recibe despacho ──────────────────────
    const diasConDespacho = [...new Set(eventos.map((e) => e.diaSemana))].sort((a, b) => a - b);
    const dias = [];

    for (const diaSemana of diasConDespacho) {
      const delDia = eventos.filter((e) => e.diaSemana === diaSemana);
      const diasACubrir = Math.max(1, Math.round(medianaPonderada(delDia.map((e) => e.dias), delDia.map((e) => e.peso))));
      const ventana = ventanaDeDias(diaSemana, diasACubrir);
      const sumaPerfil = ventana.reduce((a, j) => a + perfil[j], 0);
      const sumaPerfil2 = ventana.reduce((a, j) => a + perfil[j] ** 2, 0);

      const sabores = [];
      for (const [saborId, s] of porSabor) {
        // Fuera de la lista de carga lo que hace más de 5 semanas que no se le manda.
        if (!s.info.ultimaEntrega || diasEntre(s.info.ultimaEntrega, finVentana) > DIAS_VIGENCIA_SABOR) continue;

        const dia = s.porDia.get(diaSemana);
        const observados = dia?.eventos || 0;
        const censurados = (dia?.quiebres || 0) + (dia?.vacias || 0);
        const aprieteDia = observados > 0 ? censurados / observados : 0;

        const esperado = s.tasaBase * sumaPerfil;
        // Sin muestras suficientes para medir dispersión, se asume una típica en vez de cero.
        const sigmaEfectivo = s.n >= 2 && s.sigma > 0 ? s.sigma : CV_POR_DEFECTO * s.tasaBase;
        const apretado = aprieteDia >= UMBRAL_APRIETE;
        const z = apretado ? Z_SERVICIO_APRETADO : Z_SERVICIO;
        const tope = (apretado ? TOPE_COLCHON_APRETADO : TOPE_COLCHON) * esperado;
        const seguridad = Math.min(z * sigmaEfectivo * Math.sqrt(sumaPerfil2), tope);

        const gramosPana = s.info.gramosPana;
        // El piso es lo que tiene que SOBRAR al final de la ventana, justo antes del próximo
        // camión, que es el momento más bajo del ciclo. Por eso se suma: se consume
        // `esperado` y abajo de eso todavía queda vitrina armada.
        const piso = pisoDeVitrina(nochesPorSabor.get(`${t.sucursal_id}|${saborId}`) || [], hoyEfectivo, gramosPana);
        // Cuánto tiene que HABER disponible para cubrir la ventana sin quedarse corto NI
        // terminar con la vitrina vacía.
        const objetivo = esperado + seguridad + piso;

        const bruteosDia = delDia
          .filter((e) => !e.quiebres.has(saborId) && (e.entregas.get(saborId) || 0) > 0)
          .map((e) => e.entregas.get(saborId));
        const gramosActual = bruteosDia.length ? mediana(bruteosDia) : 0;

        sabores.push({
          sabor_id: saborId,
          nombre: s.info.nombre,
          // El FLUJO es lo que de verdad se repone cada ciclo en régimen: el colchón se arma
          // una sola vez, no se vuelve a mandar entero cada semana. Proyectar el objetivo en
          // cada ciclo (como se hacía antes) inflaba la producción ciclo tras ciclo.
          gramosFlujo: Math.round(esperado),
          gramosObjetivo: Math.round(objetivo),
          kgEsperado: Math.round(esperado / 100) / 10,
          kgSeguridad: Math.round(seguridad / 100) / 10,
          kgPiso: Math.round(piso / 100) / 10,
          panasPiso: Math.round((piso / gramosPana) * 10) / 10,
          kgObjetivo: Math.round(objetivo / 100) / 10,
          fuenteDemanda: s.serie.fuente,
          kgActual: Math.round(gramosActual / 100) / 10,
          diferenciaKg: Math.round((objetivo - gramosActual) / 100) / 10,
          gramosPana,
          // Insumos del simulador del gerente: la demanda base por día "normal" y su dispersión.
          gramosBaseDia: Math.round(s.tasaBase),
          sigmaDiaGramos: Math.round(sigmaEfectivo),
          muestras: s.n,
          confianza: s.n >= MUESTRAS_ALTA_CONFIANZA ? 'alta' : s.n >= MUESTRAS_CONFIABLES ? 'media' : 'baja',
          vecesSinStock: dia?.quiebres || 0,
          vecesVitrinaVacia: dia?.vacias || 0,
          nivelServicio: apretado ? 94 : 85,
        });
      }
      sabores.sort((a, b) => b.gramosObjetivo - a.gramosObjetivo);
      if (!sabores.length) continue;

      dias.push({
        diaSemana,
        nombreDia: DIAS_SEMANA[diaSemana],
        diasACubrir,
        cubre: ventana.map((j) => DIAS_CORTOS[j]),
        muestras: delDia.length,
        totalKgObjetivo: Math.round(sabores.reduce((a, s) => a + s.kgObjetivo, 0) * 10) / 10,
        totalKgActual: Math.round(sabores.reduce((a, s) => a + s.kgActual, 0) * 10) / 10,
      // Cuánto pesa esta ventana en días normales: 5 días flojos pueden pesar menos que 3 fuertes.
        cargaRelativa: Math.round(sumaPerfil * 10) / 10,
        sabores,
      });
    }

    if (!dias.length) continue;

    // ── 7. La agenda concreta: qué mandar, qué día, partiendo de lo que la tienda TIENE ───
    const { agenda, pesajeDesde, saboresSinPesaje } = construirAgenda({
      t, porSabor, perfil, dias, ultimoPesaje, finVentana, hoy: hoyEfectivo,
    });

    resultado.push({
      sucursal_id: t.sucursal_id,
      nombre: t.nombre,
      visitas: eventos.length,
      perfilAjustado: ajustado,
      fuentePerfil,
      observacionesVitrina: medido ? medido.observaciones : 0,
      perfilSemanal: perfil.map((factor, j) => ({
        diaSemana: j,
        nombreDia: DIAS_SEMANA[j],
        nombreCorto: DIAS_CORTOS[j],
        factor: Math.round(factor * 100) / 100,
      })),
      precision,
      oportunidad: oportunidadDeCalendario(dias, perfil),
      dias,
      agenda,
      pesajeDesde,
      saboresSinPesaje,
    });
  }

  resultado.sort((a, b) => a.nombre.localeCompare(b.nombre));
  return { tiendas: resultado };
}
