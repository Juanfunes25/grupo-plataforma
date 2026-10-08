/**
 * Traer a la app una lista de EPC que se leyó con OTRA herramienta, típicamente la app de
 * Chainway, que escanea sin parar y recoge todos los tags de golpe. Se puede pegar el texto o
 * subir el archivo (CSV o TXT); no importa si viene uno por línea, separado por comas, o con
 * más columnas (RSSI, cantidad de lecturas...).
 *
 * Es más estricto que el modo teclado a propósito: acá no hay un gatillo ni una pausa que
 * delimiten cada lectura, así que se aceptan solo palabras que SON un EPC completo (16 a 64
 * caracteres hexadecimales, de largo par). Una fecha como 20261007 o un RSSI nunca se confunden con uno.
 */

const SEPARADOR_DE_COLUMNAS = /[,;\t|]/;
const SEPARADOR_DE_PALABRAS = /[\s,;|]+/;
const PALABRA_EPC = /^[0-9A-F]{16,64}$/;

/** Una palabra que puede ser un EPC: sin comillas, sin «EPC:» ni «0x» adelante. null si no lo es. */
export function epcDePalabra(palabra) {
  const limpia = String(palabra ?? '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .replace(/^epc\s*[:=]?\s*/i, '')
    .replace(/^0x/i, '')
    .toUpperCase();
  return PALABRA_EPC.test(limpia) && limpia.length % 2 === 0 ? limpia : null;
}

/**
 * @returns {{ epcs: string[], ignorados: number, columna: string|null }}
 *   `epcs` sin repetir, en el orden en que aparecen; `ignorados` son palabras que no eran EPC
 *   (encabezados, RSSI, cantidades); `columna` es el nombre de la columna si el archivo traía encabezado.
 */
export function extraerListaDeEpcs(texto) {
  const lineas = String(texto ?? '').split(/\r?\n/).filter((l) => l.trim());
  if (!lineas.length) return { epcs: [], ignorados: 0, columna: null };

  // Si la primera línea es un encabezado con una columna «EPC», se usa solo esa columna: así no
  // se cuela el TID u otro código largo que venga al lado.
  let columna = null;
  let desde = 0;
  if (SEPARADOR_DE_COLUMNAS.test(lineas[0])) {
    const celdas = lineas[0].split(SEPARADOR_DE_COLUMNAS).map((c) => c.trim().replace(/^["']+|["']+$/g, ''));
    const i = celdas.findIndex((c) => /^(c[oó]digo\s+)?epc(\s*(id|code|hex|data))?$/i.test(c));
    if (i >= 0) { columna = i; desde = 1; }
  }

  const vistos = new Set();
  let ignorados = 0;
  for (const linea of lineas.slice(desde)) {
    const palabras = columna !== null
      ? [linea.split(SEPARADOR_DE_COLUMNAS)[columna] ?? '']
      : linea.split(SEPARADOR_DE_PALABRAS);
    for (const palabra of palabras) {
      if (!palabra.trim()) continue;
      const epc = epcDePalabra(palabra);
      if (epc) vistos.add(epc);
      else ignorados += 1;
    }
  }
  return { epcs: [...vistos], ignorados, columna: columna !== null ? lineas[0].split(SEPARADOR_DE_COLUMNAS)[columna].trim() : null };
}
