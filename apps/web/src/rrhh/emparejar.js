// Empareja nombres de archivo («Apellido_Apellido_Nombre_Nombre.pdf») con empleados por las palabras que comparten.
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const palabras = (s) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);

/** Devuelve el id del empleado que más palabras comparte con el archivo; '' si no hay uno claro (empate o sin coincidencias). */
export function emparejarArchivo(nombreArchivo, empleados) {
  const archivo = new Set(palabras(String(nombreArchivo).replace(/\.[^.]+$/, '')));
  let mejor = '', puntos = 0, empate = false;
  for (const e of empleados) {
    const p = [...new Set(palabras(`${e.nombres} ${e.apellidos ?? ''}`))].filter((w) => archivo.has(w)).length;
    if (p > puntos) { mejor = e.id; puntos = p; empate = false; } else if (p === puntos && p > 0) empate = true;
  }
  return puntos > 0 && !empate ? mejor : '';
}
