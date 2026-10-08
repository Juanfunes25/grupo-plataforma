/**
 * El catalogo de sabores se llena a mano, sucursal por sucursal, cada noche. Sin nada que lo
 * cuide termina con "FRESA", "FRESA CON CREMA" y "FRESA C/CREMA" como tres sabores distintos
 * (uno por cada tienda que lo escribio a su manera), y con algun "MANGO 4500" donde alguien
 * metio el peso pesado en el casillero del nombre en vez del de al lado. Estas tres
 * funciones son el filtro que se corre ANTES de crear un sabor nuevo, para atajar los dos
 * problemas en el origen en vez de tener que limpiar despues.
 */

/** Sin tildes, mayusculas, ni espacios de mas: para que un acento o una mayuscula de menos
 *  no hagan pasar como "distinto" un sabor que ya existe. */
export function normalizarNombreSabor(nombre) {
  return String(nombre || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

/**
 * Busca, en una lista de sabores existentes, el mas parecido a un nombre nuevo: igual una
 * vez normalizado, o uno contenido dentro del otro. El piso de 4 caracteres evita que un
 * nombre corto tipo "TE" o "MIL" matchee con cualquier cosa que las contenga.
 *
 * Si hay varios candidatos se devuelve el de nombre mas corto: entre "FRESA" y
 * "FRESA CON CREMA" como posibles parecidos de "FRESA C/CREMA", el corto suele ser el
 * nombre canonico y el largo una variante mas especifica.
 */
export function saborParecido(nombreNuevo, existentes) {
  const normalizado = normalizarNombreSabor(nombreNuevo);
  const candidatos = existentes.filter((s) => {
    const n = normalizarNombreSabor(s.nombre);
    if (n === normalizado) return false; // eso no es "parecido", es el mismo sabor
    return n.length > 3 && normalizado.length > 3 && (n.includes(normalizado) || normalizado.includes(n));
  });
  if (!candidatos.length) return null;
  return candidatos.sort((a, b) => a.nombre.length - b.nombre.length)[0];
}

/**
 * Detecta cuando el peso quedo pegado al nombre ("FRESA 4500", "MANGO 3.5", "PISTACHO
 * 3500G"): la ultima palabra, sacandole una unidad si la trae pegada, es un numero puro.
 *
 * Es una alerta, no un bloqueo definitivo - ningun sabor real del catalogo termina en
 * numero, pero tampoco vale arriesgarse a que un nombre valido quede imposible de crear por
 * una coincidencia rara. Quien lo escribe puede confirmar "sí, es asi" y sigue.
 */
export function pareceQueTraePeso(nombre) {
  const partes = String(nombre || '').trim().split(/\s+/);
  if (partes.length < 2) return false;

  // La unidad puede venir pegada al numero ("3500G") o suelta como su propia palabra
  // ("2 GRAMOS"); en ese segundo caso hay que mirar la palabra anterior.
  let candidato = partes[partes.length - 1];
  if (/^(gramos|gr|grs|kg|g)$/i.test(candidato) && partes.length > 2) {
    candidato = partes[partes.length - 2];
  } else {
    candidato = candidato.replace(/(gramos|gr|grs|kg|g)$/i, '');
  }
  return /^[0-9]+([.,][0-9]+)?$/.test(candidato);
}
