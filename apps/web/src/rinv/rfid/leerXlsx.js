/**
 * Lee un archivo de Excel moderno (.xlsx, o un .xls que en realidad lo es) SIN librerías: es un
 * ZIP con XML adentro. La app de Chainway (UHFAPP) exporta así, aunque lo llame «.xls», y trae las
 * columnas EPC, TID, USER, COUNT, ANT y RSSI. Se devuelve como texto CSV para que lo entienda
 * `extraerListaDeEpcs` (que usa la columna EPC).
 *
 * Solo hace lo necesario: primera hoja, texto y números. Usa DecompressionStream, que traen
 * los navegadores actuales y Node.
 */

const FIRMA_FIN_DIRECTORIO = 0x06054b50;
const FIRMA_ENTRADA = 0x02014b50;
const FIRMA_LOCAL = 0x04034b50;

export const esZip = (bytes) => bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;

async function descomprimir(bytes) {
  const flujo = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(flujo).arrayBuffer());
}

/** Los archivos del ZIP: nombre -> función que devuelve su contenido. */
function listarEntradas(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fin = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (v.getUint32(i, true) === FIRMA_FIN_DIRECTORIO) { fin = i; break; }
  }
  if (fin < 0) throw new Error('El archivo no parece un Excel válido');
  const cantidad = v.getUint16(fin + 10, true);
  let p = v.getUint32(fin + 16, true);
  const entradas = new Map();
  for (let n = 0; n < cantidad; n++) {
    if (v.getUint32(p, true) !== FIRMA_ENTRADA) throw new Error('El archivo Excel está dañado');
    const metodo = v.getUint16(p + 10, true);
    const comprimido = v.getUint32(p + 20, true);
    const largoNombre = v.getUint16(p + 28, true);
    const largoExtra = v.getUint16(p + 30, true);
    const largoComentario = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const nombre = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + largoNombre));
    entradas.set(nombre, async () => {
      if (v.getUint32(local, true) !== FIRMA_LOCAL) throw new Error('El archivo Excel está dañado');
      const inicio = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const datos = bytes.subarray(inicio, inicio + comprimido);
      return new TextDecoder().decode(metodo === 0 ? datos : await descomprimir(datos));
    });
    p += 46 + largoNombre + largoExtra + largoComentario;
  }
  return entradas;
}

const desescapar = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const sinEtiquetas = (t) => desescapar(t.replace(/<[^>]+>/g, ''));

/** "C12" -> 2 (columna C = índice 2). */
function indiceDeColumna(referencia) {
  const letras = /^[A-Z]+/.exec(referencia || '')?.[0] || 'A';
  return [...letras].reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;
}

const csv = (celda) => (/[",\n]/.test(celda) ? `"${celda.replace(/"/g, '""')}"` : celda);

/** @param {ArrayBuffer|Uint8Array} contenido  @returns {Promise<string>} la primera hoja como CSV */
export async function xlsxATexto(contenido) {
  const bytes = contenido instanceof Uint8Array ? contenido : new Uint8Array(contenido);
  if (!esZip(bytes)) throw new Error('Este archivo no es un Excel moderno. Guárdalo como CSV desde Excel y vuelve a subirlo.');
  const entradas = listarEntradas(bytes);

  const compartidos = [];
  if (entradas.has('xl/sharedStrings.xml')) {
    const xml = await entradas.get('xl/sharedStrings.xml')();
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) compartidos.push(sinEtiquetas(m[1]));
  }
  const hoja = entradas.get('xl/worksheets/sheet1.xml');
  if (!hoja) throw new Error('No encontré la primera hoja del Excel');
  const xml = await hoja();

  const filas = [];
  for (const fila of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const celdas = [];
    for (const c of fila[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const atributos = c[1];
      const cuerpo = c[2] || '';
      const referencia = /\br="([^"]+)"/.exec(atributos)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(cuerpo);
      const t = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(cuerpo);
      let valor = '';
      if (/\bt="s"/.test(atributos) && v) valor = compartidos[Number(v[1])] ?? '';
      else if (t) valor = desescapar(t[1]);
      else if (v) valor = desescapar(v[1]);
      celdas[indiceDeColumna(referencia ?? `${String.fromCharCode(65 + celdas.length)}1`)] = valor;
    }
    filas.push(Array.from(celdas, (c) => c ?? '').map(csv).join(','));
  }
  return filas.join('\n');
}
