/**
 * Piezas comunes del gerente digital: cómo se arma un hallazgo y qué estadística se usa.
 *
 * LA IDEA DE FONDO
 *
 * Un auditor que cada tanto grita "¡lobo!" termina ignorado, y entonces el día que de verdad
 * hay un problema nadie lo mira. Por eso nada sale a la pantalla por una sola señal. Cada
 * hallazgo tiene que pasar sus COMPUERTAS: se repite en varios días distintos, hay datos
 * suficientes para creerle, las explicaciones inocentes ya se descartaron, y el monto es lo
 * bastante grande como para importar. Lo que no pasa se cuenta como "ruido descartado" en vez
 * de mostrarse, y el gerente dice cuántas cosas revisó, no solo cuántas encontró.
 *
 * Y no todo lo que sale tiene la misma certeza:
 *   confirmado -> un hecho (los números no cuadran, sin interpretación) o un patrón con dos
 *                 fuentes independientes que coinciden.
 *   probable   -> el patrón es real y repetido, pero falta la segunda fuente que lo confirme.
 *   observar   -> hay una tendencia, todavía chica o con pocos datos. No cuenta como alerta.
 */

export const NIVEL = { CONFIRMADO: 'confirmado', PROBABLE: 'probable', OBSERVAR: 'observar' };
export const GRAVEDAD = { ALTA: 'alta', MEDIA: 'media', BAJA: 'baja' };
export const AREAS = ['tiendas', 'fabrica', 'inventario', 'personal', 'sistema'];

export function redondear(n, decimales = 1) {
  const f = 10 ** decimales;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
}

export function suma(numeros) {
  return numeros.reduce((a, n) => a + Number(n || 0), 0);
}

export function promedio(numeros) {
  return numeros.length ? suma(numeros) / numeros.length : null;
}

/** Mediana: un error de tipeo no puede arrastrar el número como arrastraría un promedio. */
export function mediana(numeros) {
  if (!numeros.length) return null;
  const orden = [...numeros].sort((a, b) => a - b);
  const medio = Math.floor(orden.length / 2);
  return orden.length % 2 ? orden[medio] : (orden[medio - 1] + orden[medio]) / 2;
}

/** Percentil con interpolación lineal. q = 0.75 es "el valor bajo el cual cae el 75%". */
export function percentil(numeros, q) {
  if (!numeros.length) return null;
  const orden = [...numeros].sort((a, b) => a - b);
  const pos = (orden.length - 1) * q;
  const base = Math.floor(pos);
  const resto = pos - base;
  return orden[base + 1] !== undefined ? orden[base] + resto * (orden[base + 1] - orden[base]) : orden[base];
}

/** Desviación absoluta mediana: la dispersión que tampoco se deja arrastrar por un extremo. */
export function mad(numeros) {
  const m = mediana(numeros);
  if (m === null) return null;
  return mediana(numeros.map((n) => Math.abs(n - m)));
}

/** Probabilidad acumulada de la normal estándar (aproximación de Abramowitz-Stegun). */
export function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/**
 * Distribución de cuántos "éxitos" hay entre eventos independientes con probabilidades
 * DISTINTAS (Poisson-binomial). Devuelve un arreglo p[k] = P(exactamente k).
 * Es lo que permite decir "la probabilidad de que vengan menos de 2 de estas 3 personas".
 */
export function distribucionDeConteo(probabilidades) {
  let dist = [1];
  for (const p of probabilidades) {
    const siguiente = new Array(dist.length + 1).fill(0);
    for (let k = 0; k < dist.length; k++) {
      siguiente[k] += dist[k] * (1 - p);
      siguiente[k + 1] += dist[k] * p;
    }
    dist = siguiente;
  }
  return dist;
}

/** "2026-09-24" -> días desde una época fija. Evita las trampas de zona horaria de Date. */
function diaOrdinal(fechaISO) {
  const [a, m, d] = fechaISO.split('-').map(Number);
  return Math.round(Date.UTC(a, m - 1, d) / 86400000);
}

export function diasEntre(desde, hasta) {
  return diaOrdinal(hasta) - diaOrdinal(desde);
}

export function sumarDias(fechaISO, n) {
  const d = new Date(diaOrdinal(fechaISO) * 86400000 + n * 86400000);
  return d.toISOString().slice(0, 10);
}

/** 0 = lunes ... 6 = domingo, igual que el resto de la app. */
export function diaSemanaDe(fechaISO) {
  return (new Date(diaOrdinal(fechaISO) * 86400000).getUTCDay() + 6) % 7;
}

/** Cuántas fechas DISTINTAS hay: tres eventos el mismo día son uno solo, no un patrón. */
export function diasDistintos(fechas) {
  return new Set(fechas).size;
}

export function agruparPor(lista, clave) {
  const mapa = new Map();
  for (const item of lista) {
    const k = clave(item);
    if (!mapa.has(k)) mapa.set(k, []);
    mapa.get(k).push(item);
  }
  return mapa;
}

export function kg(gramos) {
  return redondear(Number(gramos) / 1000, 1);
}

export function fechaCorta(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

export function plural(n, uno, varios) {
  return n === 1 ? uno : varios;
}

/** Une una lista en una frase: "A, B y C". */
export function listar(items, tope = 4) {
  const lista = items.filter(Boolean);
  if (lista.length <= tope) {
    if (lista.length <= 1) return lista.join('');
    return `${lista.slice(0, -1).join(', ')} y ${lista[lista.length - 1]}`;
  }
  return `${lista.slice(0, tope).join(', ')} y ${lista.length - tope} más`;
}

/**
 * Una compuerta es una pregunta que el hallazgo tiene que contestar que sí.
 * `requerida: true` -> si falla, el hallazgo NO se muestra.
 * `requerida: false` -> es la corroboración: si falla, baja de "confirmado" a "probable".
 */
export function compuerta(texto, ok, { requerida = true } = {}) {
  return { texto, ok: Boolean(ok), requerida };
}

/**
 * Decide qué hacer con un hallazgo según sus compuertas.
 * Devuelve null si alguna requerida falló (no se dice nada), o el nivel que le corresponde.
 */
export function nivelSegunCompuertas(compuertas, { base = NIVEL.CONFIRMADO } = {}) {
  if (compuertas.some((c) => c.requerida && !c.ok)) return null;
  const corroboracion = compuertas.filter((c) => !c.requerida);
  if (corroboracion.length && corroboracion.some((c) => !c.ok)) {
    return base === NIVEL.CONFIRMADO ? NIVEL.PROBABLE : base;
  }
  return base;
}

/**
 * Arma un hallazgo completo. Todo campo de texto está pensado para leerse en un teléfono por
 * alguien que no es técnico: oraciones cortas, números con unidad, y qué hacer al final.
 */
export function crearHallazgo({
  verificacion,
  area,
  clave,
  titulo,
  detalle,
  gravedad = GRAVEDAD.MEDIA,
  nivel,
  evidencia = [],
  compuertas = [],
  descartado = [],
  accion,
  impacto = null,
  sucursal_id = null,
  sucursal_nombre = null,
}) {
  // Garantías que valen para TODOS los hallazgos, no solo para los que tienen test: un hallazgo
  // que llega sin evidencia, sin saber qué hacer, o con una compuerta obligatoria sin pasar,
  // es una afirmación sin sostén. Es preferible que la verificación falle (y quede reportada
  // como error) a que le muestre al dueño algo que el propio gerente no pudo respaldar.
  const id = `${verificacion}:${clave}`;
  if (!titulo || !detalle || !accion) throw new Error(`Hallazgo incompleto (${id}): faltan título, detalle o acción`);
  if (!evidencia.length) throw new Error(`Hallazgo sin evidencia (${id})`);
  if (!Object.values(NIVEL).includes(nivel)) throw new Error(`Hallazgo sin nivel de certeza válido (${id})`);
  if (compuertas.some((c) => c.requerida && !c.ok)) throw new Error(`Hallazgo con una compuerta obligatoria sin pasar (${id})`);

  return {
    huella: id,
    verificacion,
    area,
    titulo,
    detalle,
    gravedad,
    nivel,
    evidencia,
    compuertas,
    descartado,
    accion,
    impacto,
    sucursal_id,
    sucursal_nombre,
  };
}

/** Resultado de una verificación que no pudo correr: dice por qué en vez de callar. */
export function sinDatos(base, motivo) {
  return { ...base, estado: 'sin_datos', motivoSinDatos: motivo, hallazgos: [], ruido: 0 };
}

/**
 * Un "registro por ordenar": algo viejo que quedó abierto (un pedido que nunca se despachó, un
 * reporte de equipo que nadie marcó como listo). En un negocio donde no todo pedido se envía,
 * eso es acumulación normal y no una falla: no cuenta como hallazgo ni arma patrones, pero se
 * muestra aparte para que se pueda cerrar de una vez y no infle los números.
 *
 * `filas`: [{ tienda, cantidad, mas_vieja_dias }]
 */
export function crearLimpieza({ verificacion, area, clave, titulo, detalle, accion, evidencia = [], filas = [] }) {
  const id = `${verificacion}:${clave}`;
  if (!titulo || !detalle || !accion) throw new Error(`Registro por ordenar incompleto (${id})`);
  if (!filas.length) throw new Error(`Registro por ordenar sin filas (${id})`);
  return {
    id, verificacion, area, titulo, detalle, accion, evidencia,
    cantidad: filas.reduce((a, f) => a + f.cantidad, 0),
    mas_vieja_dias: Math.max(...filas.map((f) => f.mas_vieja_dias)),
    filas,
  };
}

/** Resultado de una verificación que sí corrió. */
export function resultado(base, { hallazgos = [], revisado, ruido = 0, limpieza = [] }) {
  return {
    ...base,
    estado: hallazgos.length ? 'hallazgos' : 'ok',
    revisado,
    hallazgos,
    ruido,
    limpieza,
  };
}
