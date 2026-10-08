import { extraerEpcs } from './lectores/lectorTeclado.js';

/**
 * El asistente del lector: en vez de pedirle a la persona que entienda 25 opciones, se le pide
 * que haga dos pruebas simples (leer un tag, leer varios sin soltar el gatillo) y a partir de
 * lo que LLEGA se deduce qué ajuste está mal. Cada ajuste dice, en una línea, qué cambiar en el
 * programa de Chainway (UHFAPP) y por qué.
 *
 * No toca el lector: no tiene cómo. Solo mira lo que escribe y compara con lo que la app necesita.
 * Las opciones son las 16 que reporta el SR160 con firmware V3.0.6 (verificadas con UHFAPP): mode, power,
 * buzzer, pointer, length, new_line, prefix, suffix, epc_format, data_bank, user_addr, user_len,
 * inventory, idle, keymap y key_mode. Este modelo NO tiene filter, stay, add_pc, pc ni rssi.
 */

export const AJUSTES = {
  newLine: { opcion: 'new_line', valor: '2', porque: 'El lector no manda Enter después de cada código. Sin eso la app no sabe dónde termina un tag y empieza otro.' },
  dataBank: { opcion: 'data_bank', valor: '0 (epc)', porque: 'El lector manda el código del tag pegado a otro dato (el TID). Hay que pedirle solo el EPC.' },
  recorte: { opcion: 'pointer y length', valor: '0 y 0', porque: 'Con valores distintos de 0 el lector recorta o corre el código. En 0 manda el código completo.' },
  textoExtra: { opcion: 'prefix y suffix', valor: 'vacíos', porque: 'El lector agrega texto o un número antes o después del código.' },
  epcFormato: { opcion: 'epc_format', valor: '1 (hexadecimal, mayúsculas)', porque: 'El código no llega como letras y números hexadecimales. Tiene que ser hexadecimal, no ASCII.' },
  mode: { opcion: 'mode', valor: '3 (BT HID)', porque: 'Para que escriba por Bluetooth como teclado de forma continua. El 2 manda un solo código por apretón.' },
  inventory: { opcion: 'inventory', valor: '1', porque: 'Activa el inventario RFID continuo: lee sin parar mientras sostienes el gatillo.' },
  keyMode: { opcion: 'key_mode', valor: '1', porque: 'El gatillo funciona continuo: mientras lo sostienes, sigue leyendo (0 = una sola lectura por apretón).' },
};
const CONTINUO = [AJUSTES.mode, AJUSTES.inventory, AJUSTES.keyMode];
const TIRA_HEX = /[0-9A-Fa-f]{8,}/g;

const sinRepetir = (ajustes) => [...new Map(ajustes.map((a) => [a.opcion, a])).values()];

/**
 * Prueba 1: se acercó UN tag y se apretó el gatillo una vez. `crudos`: lo que llegó,
 * [{ texto, cierre }] (`cierre`: enter, tab o pausa).
 * @returns {{ estado: 'ok'|'ajustar'|'sin_datos', titulo, detalle, epc, ajustes }}
 */
export function analizarUnTag(crudos) {
  if (!crudos.length) {
    return { estado: 'sin_datos', titulo: 'No llegó nada', epc: null, ajustes: [],
      detalle: 'Revisa que el botón amarillo de atrás esté en RFID (luz de RFID encendida), que el lector esté emparejado como teclado y que haya un tag a unos 30 cm.' };
  }
  const c = crudos[0];
  const texto = String(c.texto || '').trim();
  const tiras = texto.match(TIRA_HEX) || [];
  const mejor = [...tiras].sort((a, b) => b.length - a.length)[0];
  const ajustes = [];

  // Un EPC tiene largo par y al menos 16 caracteres; un código de barras (13 dígitos, por ejemplo) no.
  if (!mejor || mejor.length < 16 || mejor.length % 2 !== 0) {
    return { estado: 'ajustar', titulo: 'Llegó algo, pero no parece el código de un tag', epc: null,
      ajustes: [AJUSTES.epcFormato, AJUSTES.dataBank],
      detalle: `Llegó «${texto.slice(0, 40)}». Si es un código de barras, el botón amarillo está en barras: ponlo en RFID. Si es de un tag, el formato de salida está mal.` };
  }
  if (mejor.length > 24 && mejor.length % 24 === 0) ajustes.push(AJUSTES.dataBank);
  else if (mejor.length > 24) ajustes.push(AJUSTES.dataBank, AJUSTES.recorte);

  const resto = texto.replace(mejor, '').trim();
  if (resto) ajustes.push(AJUSTES.textoExtra);
  if (c.cierre === 'pausa') ajustes.push(AJUSTES.newLine);

  const lista = sinRepetir(ajustes);
  if (!lista.length) {
    return { estado: 'ok', titulo: 'El código llega limpio', epc: mejor.toUpperCase(), ajustes: [],
      detalle: `Llegó ${mejor.toUpperCase()}, con su Enter al final y sin datos de más.` };
  }
  return { estado: 'ajustar', titulo: 'El código llega, pero hay que ajustar el lector', epc: null, ajustes: lista,
    detalle: `Llegó «${texto.slice(0, 60)}». Estos ajustes lo dejan limpio:` };
}

/**
 * Prueba 2: varios tags juntos, gatillo sostenido unos segundos. `crudos`: [{ texto, hora }].
 * Mide si llegaron varios tags en una sola tirada (continuo) o de a uno por apretón.
 */
export function analizarContinuo(crudos, { huecoMs = 1500 } = {}) {
  const lecturas = crudos.filter((c) => c.aceptado !== false).flatMap((c) => extraerEpcs(c.texto).epcs.map((epc) => ({ epc, hora: c.hora ?? 0 })));
  if (!lecturas.length) {
    return { estado: 'sin_datos', titulo: 'No llegó nada', ajustes: [], datos: { distintos: 0, total: 0, tiradas: 0 },
      detalle: 'No llegó ninguna lectura. Revisa el botón amarillo (RFID), y que los tags estén cerca.' };
  }
  const horas = lecturas.map((l) => l.hora).sort((a, b) => a - b);
  const tiradas = 1 + horas.slice(1).filter((h, i) => h - horas[i] > huecoMs).length;
  const distintos = new Set(lecturas.map((l) => l.epc)).size;
  // Velocidad real: el teclado Bluetooth tiene un tope, y con muchos tags eso decide cuánto tarda un inventario.
  const segundos = Math.max(0.5, (horas[horas.length - 1] - horas[0]) / 1000);
  const primeras = new Map();
  for (const l of [...lecturas].sort((a, b) => a.hora - b.hora)) if (!primeras.has(l.epc)) primeras.set(l.epc, l.hora);
  const tardoEnVerTodos = Math.max(...primeras.values()) - horas[0];
  const datos = { distintos, total: lecturas.length, tiradas, segundos: Math.round(segundos * 10) / 10, porSegundo: Math.round((lecturas.length / segundos) * 10) / 10, tardoEnVerTodosMs: tardoEnVerTodos };
  const velocidad = `Ritmo: ${datos.porSegundo} lecturas por segundo; los ${distintos} tags aparecieron en ${Math.round(tardoEnVerTodos / 100) / 10} s.${datos.porSegundo < 3 ? ' Es lento: el Bluetooth como teclado tiene un tope. Con muchos tags tardará; para un freezer grande conviene escanear con la app de Chainway e importar el Excel.' : ''}`;

  if (lecturas.length === 1 || (tiradas > 1 && lecturas.length / tiradas <= 3)) {
    return { estado: 'ajustar', titulo: 'Lee de a un tag por apretón', ajustes: CONTINUO, datos,
      detalle: lecturas.length === 1 ? 'En toda la prueba llegó una sola lectura: el lector manda un código cada vez que aprietas el gatillo.' : `Llegaron ${lecturas.length} lecturas en ${tiradas} apretones separados: no lee de corrido.` };
  }
  if (distintos >= 2) {
    return { estado: 'ok', titulo: 'Lee sin parar', ajustes: [], datos,
      detalle: `Con el gatillo sostenido llegaron ${distintos} tags distintos de una sola tirada (${lecturas.length} lecturas). ${velocidad}` };
  }
  return { estado: 'parcial', titulo: 'Lee sin parar, pero solo vio un tag', ajustes: [], datos,
    detalle: 'El gatillo sí funciona continuo (el mismo tag llegó varias veces). Pero solo apareció 1 tag distinto: ¿había 3 o más cerca? Acércalos, o sube el power.' };
}

/** Junta lo que dejaron las dos pruebas en una sola lista de cambios, sin repetir. */
export function cambiosPendientes(...resultados) {
  return sinRepetir(resultados.filter(Boolean).flatMap((r) => r.ajustes || []));
}
