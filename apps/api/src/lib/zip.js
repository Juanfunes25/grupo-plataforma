import zlib from 'node:zlib';

// ZIP mínimo sin dependencias (deflate + CRC32 de la librería estándar de Node 22). Basta para los respaldos:
// nombres en UTF-8, archivos de hasta 4 GB cada uno y menos de 65 535 archivos (sin ZIP64).

const SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_FIN = 0x06054b50;

function fechaDos(d = new Date()) {
  const hora = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const dia = ((Math.max(d.getUTCFullYear(), 1980) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { hora, dia };
}

/**
 * Escritor en flujo: `escribir(buffer)` recibe los trozos a medida que se arman (por ejemplo res.write).
 *   const z = crearZip((b) => res.write(b)); z.agregar('a.csv', 'texto'); z.cerrar();
 */
export function crearZip(escribir) {
  const central = [];
  let desplazamiento = 0;
  const { hora, dia } = fechaDos();
  const emitir = (b) => { escribir(b); desplazamiento += b.length; };
  return {
    agregar(nombre, contenido) {
      const datos = Buffer.isBuffer(contenido) ? contenido : Buffer.from(String(contenido), 'utf8');
      const crc = zlib.crc32(datos);
      const comprimido = datos.length > 64 ? zlib.deflateRawSync(datos, { level: 6 }) : datos;
      const metodo = comprimido === datos || comprimido.length >= datos.length ? 0 : 8;
      const cuerpo = metodo === 8 ? comprimido : datos;
      const nom = Buffer.from(nombre, 'utf8');
      if (datos.length > 0xfffffffe) throw new Error(`El archivo ${nombre} es demasiado grande para este ZIP`);
      const h = Buffer.alloc(30);
      h.writeUInt32LE(SIG_LOCAL, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(metodo, 8);
      h.writeUInt16LE(hora, 10); h.writeUInt16LE(dia, 12); h.writeUInt32LE(crc, 14);
      h.writeUInt32LE(cuerpo.length, 18); h.writeUInt32LE(datos.length, 22); h.writeUInt16LE(nom.length, 26); h.writeUInt16LE(0, 28);
      central.push({ nom, crc, metodo, comp: cuerpo.length, tam: datos.length, desde: desplazamiento });
      emitir(h); emitir(nom); emitir(cuerpo);
    },
    cerrar() {
      const inicio = desplazamiento;
      for (const e of central) {
        const c = Buffer.alloc(46);
        c.writeUInt32LE(SIG_CENTRAL, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(e.metodo, 10);
        c.writeUInt16LE(hora, 12); c.writeUInt16LE(dia, 14); c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.comp, 20); c.writeUInt32LE(e.tam, 24);
        c.writeUInt16LE(e.nom.length, 28); c.writeUInt32LE(e.desde, 42);
        emitir(c); emitir(e.nom);
      }
      const tamCentral = desplazamiento - inicio;
      if (central.length > 0xfffe) throw new Error('Demasiados archivos para un ZIP simple');
      const f = Buffer.alloc(22);
      f.writeUInt32LE(SIG_FIN, 0); f.writeUInt16LE(central.length, 8); f.writeUInt16LE(central.length, 10);
      f.writeUInt32LE(tamCentral, 12); f.writeUInt32LE(inicio, 16);
      emitir(f);
    },
  };
}

/** Lee un ZIP completo en memoria → Map(nombre → Buffer). Verifica el CRC de cada archivo. */
export function leerZip(buf) {
  let fin = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === SIG_FIN) { fin = i; break; }
  if (fin < 0) throw new Error('El archivo no es un ZIP válido (no se encontró el final)');
  const n = buf.readUInt16LE(fin + 10);
  let p = buf.readUInt32LE(fin + 16);
  const salida = new Map();
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('ZIP dañado (directorio central)');
    const metodo = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), comp = buf.readUInt32LE(p + 20);
    const lnom = buf.readUInt16LE(p + 28), lextra = buf.readUInt16LE(p + 30), lcom = buf.readUInt16LE(p + 32), desde = buf.readUInt32LE(p + 42);
    const nombre = buf.toString('utf8', p + 46, p + 46 + lnom);
    const lnLocal = buf.readUInt16LE(desde + 26), leLocal = buf.readUInt16LE(desde + 28);
    const ini = desde + 30 + lnLocal + leLocal;
    const crudo = buf.subarray(ini, ini + comp);
    const datos = metodo === 0 ? Buffer.from(crudo) : metodo === 8 ? zlib.inflateRawSync(crudo) : null;
    if (!datos) throw new Error(`Método de compresión no soportado en ${nombre}`);
    if (zlib.crc32(datos) !== crc) throw new Error(`ZIP dañado: el archivo ${nombre} no coincide con su suma de control`);
    salida.set(nombre, datos);
    p += 46 + lnom + lextra + lcom;
  }
  return salida;
}
