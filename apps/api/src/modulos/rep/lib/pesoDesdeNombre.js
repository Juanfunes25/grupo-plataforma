/**
 * Saca el peso del envase del NOMBRE del insumo.
 *
 * Casi todo el catalogo Mec3 trae el peso escrito en el nombre, porque asi viene la factura:
 *
 *   COOKIES BLACK X 6 KG            -> 6
 *   BASE ALBA COMPLETA X 1,2 KG.    -> 1.2   (la coma tambien es decimal, viene de Italia)
 *   BASE 50 MB CON PANNA ... 2.5KG  -> 2.5   (a veces sin espacio y sin la X)
 *   COOKIES COCOBOOM X 6 KG (COCONUT COOKIE) -> 6  (el peso no siempre esta al final)
 *
 * Eso es lo que falta para valorizar: el precio de costeo esta POR KILO y el inventario se
 * cuenta por BOTE, asi que sin este numero el insumo no se puede sumar al total.
 *
 * DOS REGLAS QUE IMPORTAN:
 *
 * 1. Se ancla en la palabra KG y toma el numero que la precede. NO agarra "cualquier numero
 *    del nombre", porque casi todos los nombres traen codigos de producto que se verian
 *    igual de bien: ANGURIA *500* (WATERMELON) X 1.25 KG, BASE *100* MB ... 2 KG,
 *    CAFFE` *500* (COFFEE) x 1.25 KG. Tomar el primer numero daria 500 kg de sandia.
 *
 * 2. NO interpreta "N x M KG" como multipack. Sonaba razonable, pero al revisar los 262
 *    nombres del catalogo los unicos candidatos eran falsos positivos: "CACAO MISCELA
 *    ME*C3* x 1.5 KG", "... LOTUS BISCOFF *2024* X 13.46 KG", "TUTTOPANN `C`*10* x 2.5 KG",
 *    "PISTACHI GRAINS 3/*5* X 1 KG". El unico que parecia de verdad, "BASE 6 X 2.5 KG", es
 *    el producto 02006 que MEC3 llama "Base 6": el 6 es parte del nombre, no una cantidad.
 *    Un multipack inventado multiplicaria el valor del inventario por 6 sin que se note.
 *
 * Si el nombre no dice el peso devuelve null, no un estimado. El insumo cae en `sinPeso`
 * (queda a la vista en la pantalla de valor) y alguien le pone el peso a mano. Un total
 * incompleto y avisado es mejor que uno completo e inventado.
 */

// Tope de cordura: el envase mas pesado del catalogo real es de 13.46 kg. Un numero mas
// grande casi seguro es un ano o un codigo pegado a la palabra KG, no un peso.
const PESO_MAXIMO_KG = 60;

const PESO = /([0-9]+(?:[.,][0-9]+)?)\s*KG\b/i;

export function pesoDesdeNombre(nombre) {
  const m = PESO.exec(String(nombre || ''));
  if (!m) return null;
  const peso = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(peso) || peso <= 0 || peso > PESO_MAXIMO_KG) return null;
  return peso;
}
