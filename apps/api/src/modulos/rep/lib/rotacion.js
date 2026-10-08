/**
 * Que sabores se mueven y cuales no, calculado SIN datos de venta.
 *
 * La facturacion es por tamaño (un vaso mediano), no por sabor, asi que el ticket nunca dice
 * que sabor se vendio. Pero el sistema ya tiene las dos mitades que hacen falta:
 *
 *   - `despachos`: cuanto gelato ENTRO a cada tienda
 *   - `pesajes`:   cuanto QUEDABA en la vitrina cada noche
 *
 * De ahi sale el consumo real, que ademas es MEJOR que una cifra de ventas: incluye lo que se
 * derritio, se regalo o se tiro, que igual hay que producir.
 *
 *   consumo = despachado + (lo que habia al empezar - lo que queda al final)
 *
 * Si no hay pesajes en el rango (sabor nuevo, tienda que no reporto), se cae a "consumo =
 * despachado", que es la mejor estimacion disponible; queda marcado en `estimado` para no
 * presentar como exacto algo que no lo es.
 */

export const ESTADOS_ENTREGADOS = ['enviado', 'recibido'];

/** Un sabor "muerto" y uno que falta por quiebre de stock se ven igual desde afuera (no se
 *  despacha), pero son problemas OPUESTOS: uno hay que sacarlo del catalogo y el otro hay que
 *  producirlo mas. Estas etiquetas existen para no confundirlos nunca. */
export const CLASIFICACION = {
  ESTRELLA: 'estrella',
  NORMAL: 'normal',
  LENTO: 'lento',
  MUERTO: 'muerto',
  FALTA_STOCK: 'falta_stock',
  SIN_PRODUCIR: 'sin_producir',
};

/**
 * Decide la etiqueta de un sabor. El orden de las preguntas importa: primero se descartan
 * las explicaciones que NO son falta de demanda (no se produjo, no habia stock), y recien
 * despues se lo juzga por lo que consumio.
 */
export function clasificar({ consumo, diasSinDespachar, vecesSinStock, producidoKg, consumoMediano }) {
  // Se pidio pero no habia: es un quiebre de stock, exactamente lo contrario a un sabor muerto.
  if (vecesSinStock >= 3) return CLASIFICACION.FALTA_STOCK;

  // Nunca se despacho en el periodo...
  if (diasSinDespachar === null) {
    // ...y tampoco se produjo: el sabor no tuvo oportunidad de venderse. No es culpa de la demanda.
    if (!producidoKg) return CLASIFICACION.SIN_PRODUCIR;
    // ...pero si se produjo: hubo producto y nadie lo pidio. Ese si esta muerto.
    return CLASIFICACION.MUERTO;
  }

  if (diasSinDespachar >= 21 && producidoKg > 0) return CLASIFICACION.MUERTO;
  if (consumo >= consumoMediano * 1.5) return CLASIFICACION.ESTRELLA;
  if (consumo <= consumoMediano * 0.4) return CLASIFICACION.LENTO;
  return CLASIFICACION.NORMAL;
}

/** Mediana y no promedio: con un par de sabores estrella muy fuertes, el promedio se dispara
 *  y hace que casi todo lo demas parezca "lento". La mediana describe al sabor tipico. */
export function mediana(numeros) {
  const orden = [...numeros].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!orden.length) return 0;
  const medio = Math.floor(orden.length / 2);
  return orden.length % 2 ? orden[medio] : (orden[medio - 1] + orden[medio]) / 2;
}

function diasEntre(desdeISO, hastaISO) {
  const a = new Date(`${desdeISO}T00:00:00`);
  const b = new Date(`${hastaISO}T00:00:00`);
  return Math.round((b - a) / 86400000);
}

/**
 * Arma la rotacion en el rango pedido, en dos vistas del mismo dato:
 *
 *   - `sabores`: por sabor, con el detalle de cuanto le tocó a cada tienda (para "elegí un
 *     sabor y mirá cómo se repartió").
 *   - `tiendas`: por tienda, con el detalle de que sabores le mandaron (para "elegí una
 *     tienda y mirá qué se movió ahí").
 *
 * El numero que manda en las dos vistas es lo DESPACHADO (lo que salio de fabrica hacia cada
 * tienda) - no un "consumo neto" descontando lo que sobro en la vitrina. Eso se probo antes y
 * confundía más de lo que aclaraba ("no sé de dónde sacás ese número"); lo que el dueño
 * reconoce es "le mandamos tantas panas", así que es eso, sumado y en kg en vez de panas.
 * `hoy` se pasa por parametro para que los tests no dependan de la fecha real del servidor.
 */
export function armarRotacion({ despachos, producciones, sinStock, hoy }) {
  const porSabor = new Map();
  const porTienda = new Map();

  const asegurarSabor = (saborId, nombre) => {
    if (!porSabor.has(saborId)) {
      porSabor.set(saborId, {
        sabor_id: saborId,
        nombre,
        despachadoGramos: 0,
        panas: 0,
        ultimoDespacho: null,
        producidoKg: 0,
        vecesSinStock: 0,
        porSucursal: new Map(),
      });
    }
    return porSabor.get(saborId);
  };

  const asegurarTienda = (sucursalId, nombre) => {
    if (!porTienda.has(sucursalId)) {
      porTienda.set(sucursalId, { sucursal_id: sucursalId, nombre, despachadoGramos: 0, porSabor: new Map() });
    }
    return porTienda.get(sucursalId);
  };

  for (const d of despachos) {
    if (!ESTADOS_ENTREGADOS.includes(d.estado)) continue;
    const gramos = d.gramos_enviados || 0;

    const s = asegurarSabor(d.sabor_id, d.sabor_nombre);
    s.despachadoGramos += gramos;
    s.panas += d.panas || 0;
    if (!s.ultimoDespacho || d.fecha > s.ultimoDespacho) s.ultimoDespacho = d.fecha;

    const suc = s.porSucursal.get(d.sucursal_id) || {
      sucursal_id: d.sucursal_id, nombre: d.sucursal_nombre, despachadoGramos: 0, panas: 0, ultimoDespacho: null,
    };
    suc.despachadoGramos += gramos;
    suc.panas += d.panas || 0;
    if (!suc.ultimoDespacho || d.fecha > suc.ultimoDespacho) suc.ultimoDespacho = d.fecha;
    s.porSucursal.set(d.sucursal_id, suc);

    // El mismo despacho, mirado del otro lado: por tienda en vez de por sabor.
    const t = asegurarTienda(d.sucursal_id, d.sucursal_nombre);
    t.despachadoGramos += gramos;
    const sab = t.porSabor.get(d.sabor_id) || {
      sabor_id: d.sabor_id, nombre: d.sabor_nombre, despachadoGramos: 0, panas: 0, ultimoDespacho: null,
    };
    sab.despachadoGramos += gramos;
    sab.panas += d.panas || 0;
    if (!sab.ultimoDespacho || d.fecha > sab.ultimoDespacho) sab.ultimoDespacho = d.fecha;
    t.porSabor.set(d.sabor_id, sab);
  }

  for (const p of producciones) {
    const s = asegurarSabor(p.sabor_id, p.sabor_nombre);
    s.producidoKg += p.kg || 0;
  }

  for (const n of sinStock) {
    const s = asegurarSabor(n.sabor_id, n.sabor_nombre);
    s.vecesSinStock += n.veces || 0;
  }

  const despachos_ = [...porSabor.values()].map((s) => s.despachadoGramos).filter((d) => d > 0);
  const despachadoMediano = mediana(despachos_);

  const listaSabores = [...porSabor.values()].map((s) => {
    const diasSinDespachar = s.ultimoDespacho ? diasEntre(s.ultimoDespacho, hoy) : null;
    return {
      sabor_id: s.sabor_id,
      nombre: s.nombre,
      despachadoGramos: Math.round(s.despachadoGramos),
      despachadoKg: Math.round(s.despachadoGramos / 100) / 10,
      panas: s.panas,
      producidoKg: Math.round(s.producidoKg * 10) / 10,
      ultimoDespacho: s.ultimoDespacho,
      diasSinDespachar,
      vecesSinStock: s.vecesSinStock,
      clasificacion: clasificar({
        consumo: s.despachadoGramos,
        diasSinDespachar,
        vecesSinStock: s.vecesSinStock,
        producidoKg: s.producidoKg,
        consumoMediano: despachadoMediano,
      }),
      porSucursal: [...s.porSucursal.values()]
        .map((x) => ({
          ...x,
          despachadoGramos: Math.round(x.despachadoGramos),
          despachadoKg: Math.round(x.despachadoGramos / 100) / 10,
          diasSinDespachar: x.ultimoDespacho ? diasEntre(x.ultimoDespacho, hoy) : null,
        }))
        .sort((a, b) => b.despachadoGramos - a.despachadoGramos),
    };
  });
  listaSabores.sort((a, b) => b.despachadoGramos - a.despachadoGramos);

  const listaTiendas = [...porTienda.values()].map((t) => ({
    sucursal_id: t.sucursal_id,
    nombre: t.nombre,
    despachadoGramos: Math.round(t.despachadoGramos),
    despachadoKg: Math.round(t.despachadoGramos / 100) / 10,
    porSabor: [...t.porSabor.values()]
      .map((x) => ({
        ...x,
        despachadoGramos: Math.round(x.despachadoGramos),
        despachadoKg: Math.round(x.despachadoGramos / 100) / 10,
        diasSinDespachar: x.ultimoDespacho ? diasEntre(x.ultimoDespacho, hoy) : null,
      }))
      .sort((a, b) => b.despachadoGramos - a.despachadoGramos),
  }));
  listaTiendas.sort((a, b) => b.despachadoGramos - a.despachadoGramos);

  return { despachadoMediano: Math.round(despachadoMediano), sabores: listaSabores, tiendas: listaTiendas };
}
