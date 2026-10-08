/** Reparto FIFO (lo más viejo primero), portado de lib/trazabilidad.js del original. */
// Tolerancia para comparar cantidades con decimales. Sin esto, restar 1.5 tres veces a 4.5
// deja un 0.0000000000000004 colgando que haria buscar un lote mas para cubrirlo.
const EPSILON = 1e-6;

/** Redondea a 4 decimales: mas que suficiente para gramos expresados en kg, y evita que la
 *  basura binaria de los flotantes se guarde en la base y se muestre en pantalla. */
export function redondear(n, decimales = 4) {
  const f = 10 ** decimales;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
}

/**
 * Reparte una cantidad entre origenes FIFO (lo mas viejo primero), tomando parcialmente de
 * cada uno hasta cubrirla.
 *
 * Sirve para las dos mitades de la cadena, que son el mismo problema:
 *   - una tanda consumiendo lotes de materia prima (una lata de 4.5 kg alcanza para 3
 *     tandas de pesos distintos: se toma 1.5, despues 2.0, y el ultimo 1.0 sigue en el
 *     lote siguiente)
 *   - un despacho consumiendo tandas ya producidas
 *
 * `disponibles` tiene que venir YA ordenado por antiguedad; `restante` es lo que le queda a
 * cada origen.
 *
 * `sinOrigen` es lo que no se pudo cubrir, y se devuelve en vez de silenciarse: es stock
 * real que existe pero sin lote de origen registrado (lo que ya habia antes de que este
 * sistema existiera, o una carga que se salteo). Para trazabilidad eso no es un error a
 * ocultar, es justamente lo que hay que poder mostrar: "de esta tanda, 2 kg no se sabe de
 * que lote venian".
 */
export function repartirFifo({ disponibles, cantidad }) {
  const tomas = [];
  let pendiente = redondear(cantidad);

  for (const origen of disponibles) {
    if (pendiente <= EPSILON) break;
    const restante = redondear(Number(origen.restante) || 0);
    if (restante <= EPSILON) continue;

    const toma = Math.min(restante, pendiente);
    tomas.push({ id: origen.id, cantidad: redondear(toma) });
    pendiente = redondear(pendiente - toma);
  }

  return { tomas, sinOrigen: pendiente > EPSILON ? pendiente : 0 };
}

export { EPSILON };
