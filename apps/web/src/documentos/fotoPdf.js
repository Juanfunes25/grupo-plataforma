// Convierte una foto (JPG/PNG/HEIC que el navegador sepa abrir) en un PDF de una página, para guardar DNI y otros papeles como PDF.
// Sin librerías: se dibuja la foto en un canvas (ya girada si hace falta), se exporta a JPEG y se envuelve en un PDF mínimo.
const A4 = [595.28, 841.89];

export async function fotoABytesJpeg(archivo, grados = 0, maxLado = 1800) {
  const bmp = await createImageBitmap(archivo);   // respeta la orientación EXIF del teléfono
  const g = ((grados % 360) + 360) % 360;
  const k = Math.min(1, maxLado / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const c = document.createElement('canvas');
  const girado = g === 90 || g === 270;
  c.width = girado ? h : w; c.height = girado ? w : h;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.translate(c.width / 2, c.height / 2); x.rotate((g * Math.PI) / 180);
  x.drawImage(bmp, -w / 2, -h / 2, w, h);
  bmp.close?.();
  const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.85));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), ancho: c.width, alto: c.height };
}

/** PDF de una página A4 con la imagen JPEG centrada y a su proporción. */
export function jpegAPdf(jpeg, ancho, alto) {
  const enc = new TextEncoder();
  const [pw, ph] = A4, margen = 24;
  const esc = Math.min((pw - 2 * margen) / ancho, (ph - 2 * margen) / alto);
  const w = ancho * esc, h = alto * esc, x = (pw - w) / 2, y = (ph - h) / 2;
  const contenido = enc.encode(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im0 Do Q`);
  const piezas = []; const offsets = []; let largo = 0;
  const poner = (u8) => { piezas.push(u8); largo += u8.length; };
  const txt = (s) => poner(enc.encode(s));
  txt('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const obj = (n, cuerpo) => { offsets[n] = largo; txt(`${n} 0 obj\n${cuerpo}\nendobj\n`); };
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = largo;
  txt(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${ancho} /Height ${alto} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  poner(jpeg); txt('\nendstream\nendobj\n');
  offsets[5] = largo;
  txt(`5 0 obj\n<< /Length ${contenido.length} >>\nstream\n`); poner(contenido); txt('\nendstream\nendobj\n');
  const xref = largo;
  txt(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => `${String(offsets[n]).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(largo); let p = 0;
  for (const u of piezas) { out.set(u, p); p += u.length; }
  return out;
}

/** Foto → archivo PDF listo para subir. */
export async function fotoAArchivoPdf(archivo, grados = 0, nombre = 'documento') {
  const { bytes, ancho, alto } = await fotoABytesJpeg(archivo, grados);
  return new File([jpegAPdf(bytes, ancho, alto)], `${nombre.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'documento'}.pdf`, { type: 'application/pdf' });
}
