import { almacen, empresaActual } from '../api.js';

/** Descarga un archivo del API (necesita el token, así que no sirve un <a href> directo). */
export async function descargarArchivo(ruta, nombre) {
  const s = almacen.leer();
  const h = { authorization: `Bearer ${s?.token ?? ''}` };
  const emp = empresaActual();
  if (emp && emp !== 'grupo') h['x-empresa'] = emp;
  let r;
  try { r = await fetch(`/api${ruta}`, { headers: h }); } catch { throw new Error('Sin conexión con el servidor. Revisa tu internet e intenta de nuevo.'); }
  if (!r.ok) {
    let msg = `Error ${r.status}`;
    try { msg = (await r.json()).error ?? msg; } catch { /* sin cuerpo */ }
    throw new Error(msg);
  }
  const url = URL.createObjectURL(await r.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: nombre });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const aBase64 = (archivo) => new Promise((ok, mal) => {
  const lector = new FileReader();
  lector.onload = () => ok(String(lector.result).split(',')[1]);
  lector.onerror = () => mal(new Error('No se pudo leer el archivo'));
  lector.readAsDataURL(archivo);
});
