// Después de «vite build»: deja una copia .br (Brotli, nivel máximo) de cada archivo de texto de dist/.
// El API la sirve tal cual a los navegadores que la aceptan: ~15-20 % menos bytes que gzip y cero CPU por petición.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', process.argv[2] ?? 'dist');
const TEXTO = /\.(js|css|html|svg|json|webmanifest|txt|map)$/;
let antes = 0, despues = 0, n = 0;
const recorrer = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) { recorrer(f); continue; }
    if (!TEXTO.test(e.name) || e.name.endsWith('.map')) continue;
    const buf = fs.readFileSync(f);
    if (buf.length < 1024) continue;
    const br = zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } });
    if (br.length >= buf.length) continue;
    fs.writeFileSync(`${f}.br`, br);
    antes += buf.length; despues += br.length; n++;
  }
};
if (fs.existsSync(dist)) recorrer(dist);
console.log(`[brotli] ${n} archivos: ${(antes / 1024).toFixed(0)} kB → ${(despues / 1024).toFixed(0)} kB`);
