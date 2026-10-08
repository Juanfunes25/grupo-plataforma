/**
 * Que insumos mueve mas el despachador, no que insumos PIDEN las tiendas.
 *
 * `pedido_insumo_items` es texto libre (una tienda escribe "Vasos 8oz", no elige de un
 * catalogo), asi que "cuanto se pidio" nunca fue un buen indicador: cualquiera puede escribir
 * lo que quiera y en la practica casi nunca se manda todo lo pedido. Lo unico confiable es lo
 * que el despachador de verdad TACHA como enviado (columna `enviado`, ver
 * routes/pedidos.js -> /despachar-marcados) - eso si paso por bodega de verdad.
 *
 * Se agrupa por texto normalizado (mayusculas, espacios de mas colapsados) porque dos tiendas
 * pueden escribir el mismo insumo con mayuscula/espacio distinto y tienen que contar como uno
 * solo; con insumos_catalogo sin FK en este texto libre, normalizar el texto es lo mejor que
 * hay.
 */

function normalizar(texto) {
  return (texto || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

/**
 * `items`: filas con { insumo_texto, enviado, sucursal_id, sucursal_nombre }. Devuelve los
 * insumos ordenados de mas a menos veces enviados, cada uno con el desglose de a que tienda
 * (tambien ordenado de mas a menos) - para "apreto el insumo y veo cuanto se mando a cada
 * tienda".
 */
export function armarInsumosDespachados(items) {
  const porInsumo = new Map();

  for (const it of items) {
    if (!it.enviado) continue; // lo pedido pero nunca despachado no cuenta
    const clave = normalizar(it.insumo_texto);
    if (!clave) continue;

    if (!porInsumo.has(clave)) {
      porInsumo.set(clave, { nombre: (it.insumo_texto || '').trim(), veces: 0, porTienda: new Map() });
    }
    const i = porInsumo.get(clave);
    i.veces += 1;

    const t = i.porTienda.get(it.sucursal_id) || { sucursal_id: it.sucursal_id, nombre: it.sucursal_nombre, veces: 0 };
    t.veces += 1;
    i.porTienda.set(it.sucursal_id, t);
  }

  const lista = [...porInsumo.values()].map((i) => ({
    nombre: i.nombre,
    veces: i.veces,
    porTienda: [...i.porTienda.values()].sort((a, b) => b.veces - a.veces),
  }));
  lista.sort((a, b) => b.veces - a.veces);
  return lista;
}

/** Trae de la base los items de pedido del rango pedido, y arma el ranking. */
export async function insumosMasDespachados(db, { desde, hasta }) {
  const items = await db.all(
    `SELECT i.insumo_texto, i.enviado, p.sucursal_id, su.nombre AS sucursal_nombre
     FROM pedido_insumo_items i
     JOIN pedidos_insumos p ON p.id = i.pedido_id
     JOIN sucursales su ON su.id = p.sucursal_id
     WHERE p.fecha BETWEEN ? AND ?`,
    [desde, hasta]
  );
  return { desde, hasta, insumos: armarInsumosDespachados(items) };
}
