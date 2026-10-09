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

/** Adivina el tipo de documento por el nombre del archivo. `conPersona` = el archivo se emparejó con un empleado. Devuelve el código o ''. */
export function adivinarTipo(nombreArchivo, conPersona) {
  const n = norm(nombreArchivo);
  if (/\b(dni|identidad)\b|_dni_|dni_/.test(n) || /(^|[^a-z])dni([^a-z]|$)/.test(n)) return 'identidad_empleado';
  if (/^hn-[a-z]-\d{4}-\d{4}/.test(n)) return 'registro_sanitario';   // número de registro sanitario al inicio del nombre
  if (/mutuo.?acuerdo|terminacion|finiquito|renuncia/.test(n)) return 'terminacion_laboral';
  if (/contrato.?(de.?)?trabajo/.test(n)) return 'contrato_empleado';
  if (/rtn/.test(n)) return conPersona ? 'rtn_empleado' : 'rtn_sar';
  if (/senprende|mipyme/.test(n)) return 'certificado_senprende';
  if (/contrato.?societario|constitucion|instrumento|reforma|escritura.?de.?constitucion/.test(n)) return 'constitucion_sociedad';
  if (/registro.?mercantil|constancia.?de.?existencia|constancia.?existencia/.test(n)) return 'registro_mercantil';
  if (/contrato.?(de.?)?arrend|arrendamiento/.test(n)) return 'contrato_arrendamiento';
  if (/arsa/.test(n)) return 'arsa_permiso';
  return '';
}

/** Título legible: sin el número de orden del principio, sin la fecha del final, sin guiones bajos. */
export function tituloDeArchivo(nombreArchivo) {
  return String(nombreArchivo).replace(/\.[^.]+$/, '').replace(/^HN-[A-Za-z]-\d{4}-\d{4}[_\-\s]+/i, '').replace(/^\d{1,3}[_\-\s]+/, '').replace(/[_\-\s]*\d{4}-\d{2}-\d{2}$/, '').replace(/_+/g, ' ').trim();
}
/** Fecha AAAA-MM-DD escrita en el nombre del archivo, o ''. */
export const fechaDeArchivo = (nombreArchivo) => (String(nombreArchivo).match(/(\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? '';

/** Número de registro sanitario (HN-A-0626-0090) al inicio del nombre del archivo, o ''. */
export const numeroDeArchivo = (nombreArchivo) => (String(nombreArchivo).match(/^(HN-[A-Za-z]-\d{4}-\d{4})/i) ?? [])[1]?.toUpperCase() ?? '';

/** Lee un CSV simple (comillas dobles, comas dentro de comillas, saltos de línea dentro de comillas) y devuelve filas como objetos. */
export function leerCsv(texto) {
  const filas = []; let fila = [], campo = '', q = false;
  const t = String(texto).replace(/^\uFEFF/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { campo += '"'; i++; } else q = false; } else campo += c; }
    else if (c === '"') q = true;
    else if (c === ',') { fila.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; fila.push(campo); campo = ''; if (fila.some((x) => x !== '')) filas.push(fila); fila = []; }
    else campo += c;
  }
  if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
  const [enc, ...datos] = filas;
  return datos.map((f) => Object.fromEntries((enc ?? []).map((h, k) => [h.trim(), (f[k] ?? '').trim()])));
}

/** Del índice de documentos: por nombre de archivo, descripción, observaciones y fecha de vencimiento (si dice «hasta/vence AAAA-MM-DD»). */
export function metaDeIndice(filas) {
  const mapa = new Map();
  for (const f of filas) {
    if (!f.archivo) continue;
    const vig = `${f.vigencia_o_estado ?? ''}`;
    const venc = (vig.match(/(?:hasta|vence|vencimiento)[^0-9]*(\d{4}-\d{2}-\d{2})/i) ?? [])[1] ?? '';
    const emision = /nacimiento/i.test(f.fecha_documento ?? '') ? '' : (String(f.fecha_documento ?? '').match(/(\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? '';
    mapa.set(f.archivo.toLowerCase(), { descripcion: [f.descripcion, f.observaciones].filter(Boolean).join(' — ').slice(0, 900), fecha_emision: emision, fecha_vencimiento: venc, entidad: f.persona_o_entidad ?? '' });
  }
  return mapa;
}
