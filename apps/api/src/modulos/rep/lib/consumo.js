// Consumo real por sucursal, sabor y día, cruzado con la venta del POS.
//
// El original medía el consumo (rotacion.js: «despachado») y, dentro del modelo de recomendación,
// «consumo = lo que quedaba anoche + lo que entró hoy − lo que queda esta noche». Esta pieza expone
// esa misma medición a la pantalla de Consumo y la pone al lado de lo que el POS vendió, para ver
// cuántos gramos de gelato se van por cada lempira vendido en cada tienda. No necesita saber el
// sabor de lo vendido (la factura es por tamaño); es un cruce por tienda y por día.
//
// Solo se mide una noche cuando hay pesaje esa noche Y la anterior. Una noche con consumo negativo
// (la vitrina subió sin entrada registrada) es un pesaje inconsistente: se descarta y se cuenta.
import { diasEntre, sumarDias } from './fechasSemana.js';
import { mediana } from './rotacion.js';

const kg = (g) => Math.round(g / 100) / 10;

/** Día en que el despacho entró a la tienda: enviado_en si existe; si no, el día siguiente al pedido. */
export const diaEntrega = (d) => d.enviado_en || sumarDias(d.fecha, 1);

/**
 * pesajes: { sucursal_id, sabor_id, fecha, gramos } (el último de cada noche);
 * despachos: { sucursal_id, sabor_id, fecha, enviado_en, gramos_enviados, estado } (solo entregados cuentan);
 * ventas: { sucursal_id, fecha, total, n } por tienda y día; sucursales: { id, nombre, fuera_de_analisis }.
 */
export function armarConsumo({ desde, hasta, pesajes, despachos, ventas = [], sucursales, sabores }) {
  const nombreSabor = new Map(sabores.map((s) => [s.id, s.nombre]));
  const ultimo = new Map();   // `suc|sabor|fecha` -> gramos
  for (const p of pesajes) ultimo.set(`${p.sucursal_id}|${p.sabor_id}|${p.fecha}`, Number(p.gramos));
  const entradas = new Map();  // `suc|sabor|fecha` -> gramos entregados ese día
  let sinEntrega = 0;
  for (const d of despachos) {
    if (!['enviado', 'recibido'].includes(d.estado)) continue;
    const k = `${d.sucursal_id}|${d.sabor_id}|${diaEntrega(d)}`;
    entradas.set(k, (entradas.get(k) || 0) + (d.gramos_enviados || 0));
  }
  const ventasPor = new Map(ventas.map((v) => [`${v.sucursal_id}|${v.fecha}`, v]));

  const porSucursal = new Map(sucursales.map((s) => [s.id, {
    sucursal_id: s.id, nombre: s.nombre, fuera_de_analisis: Boolean(s.fuera_de_analisis),
    consumoG: 0, entradaG: 0, noches: 0, descartadas: 0, ventasLps: 0, ventasN: 0, diasConVenta: 0, porSabor: new Map(), porDia: new Map(),
  }]));
  const porSabor = new Map();

  const combos = new Set();
  for (const k of ultimo.keys()) { const [suc, sab] = k.split('|'); combos.add(`${suc}|${sab}`); }
  for (const c of combos) {
    const [suc, sab] = c.split('|');
    const t = porSucursal.get(suc);
    if (!t) continue;
    for (let f = desde; f <= hasta; f = sumarDias(f, 1)) {
      const hoyG = ultimo.get(`${c}|${f}`);
      const ayerG = ultimo.get(`${c}|${sumarDias(f, -1)}`);
      if (hoyG === undefined || ayerG === undefined) continue;
      const entrada = entradas.get(`${c}|${f}`) || 0;
      const consumo = ayerG + entrada - hoyG;
      if (consumo < 0) { t.descartadas += 1; continue; }
      t.consumoG += consumo; t.entradaG += entrada; t.noches += 1;
      const dia = t.porDia.get(f) || { fecha: f, consumoG: 0 };
      dia.consumoG += consumo; t.porDia.set(f, dia);
      const s = t.porSabor.get(sab) || { sabor_id: sab, nombre: nombreSabor.get(sab) || '—', consumoG: 0, entradaG: 0, noches: 0 };
      s.consumoG += consumo; s.entradaG += entrada; s.noches += 1; t.porSabor.set(sab, s);
      const g = porSabor.get(sab) || { sabor_id: sab, nombre: nombreSabor.get(sab) || '—', consumoG: 0, entradaG: 0, porSucursal: new Map() };
      g.consumoG += consumo; g.entradaG += entrada;
      g.porSucursal.set(suc, (g.porSucursal.get(suc) || 0) + consumo);
      porSabor.set(sab, g);
    }
  }
  // Lo entregado en el rango (entre fechas de entrega), medido o no: «lo que se envía».
  const enviadoG = new Map();
  for (const d of despachos) {
    if (!['enviado', 'recibido'].includes(d.estado)) continue;
    const f = diaEntrega(d);
    if (f < desde || f > hasta) continue;
    enviadoG.set(d.sucursal_id, (enviadoG.get(d.sucursal_id) || 0) + (d.gramos_enviados || 0));
  }
  // Venta del POS por día de las noches medidas y totales del rango.
  for (const t of porSucursal.values()) {
    for (let f = desde; f <= hasta; f = sumarDias(f, 1)) {
      const v = ventasPor.get(`${t.sucursal_id}|${f}`);
      if (!v) continue;
      t.ventasLps += Number(v.total) || 0; t.ventasN += Number(v.n) || 0; t.diasConVenta += 1;
    }
  }

  // Ratio g consumidos por cada L 100 vendidos, SOLO sobre noches donde hubo medición y venta.
  const filas = [...porSucursal.values()].map((t) => {
    let consumoCruzado = 0; let ventasCruzadas = 0; let ventasNCruzadas = 0; let dias = 0;
    for (const d of t.porDia.values()) {
      const v = ventasPor.get(`${t.sucursal_id}|${d.fecha}`);
      if (!v || !(Number(v.total) > 0)) continue;
      consumoCruzado += d.consumoG; ventasCruzadas += Number(v.total); ventasNCruzadas += Number(v.n) || 0; dias += 1;
    }
    return {
      sucursal_id: t.sucursal_id, nombre: t.nombre, fuera_de_analisis: t.fuera_de_analisis,
      enviadoKg: kg(enviadoG.get(t.sucursal_id) || 0), consumoKg: kg(t.consumoG), nochesMedidas: t.noches, nochesDescartadas: t.descartadas,
      ventasLps: Math.round(t.ventasLps * 100) / 100, ventasN: t.ventasN,
      cruce: dias ? {
        dias, consumoKg: kg(consumoCruzado), ventasLps: Math.round(ventasCruzadas * 100) / 100,
        gramosPorVenta: ventasNCruzadas ? Math.round(consumoCruzado / ventasNCruzadas) : null,
        gramosPorCienLps: Math.round(consumoCruzado / (ventasCruzadas / 100)),
      } : null,
      porSabor: [...t.porSabor.values()].map((s) => ({ ...s, consumoKg: kg(s.consumoG), entradaKg: kg(s.entradaG) })).sort((a, b) => b.consumoG - a.consumoG),
      porDia: [...t.porDia.values()].sort((a, b) => a.fecha.localeCompare(b.fecha)).map((d) => ({ fecha: d.fecha, consumoKg: kg(d.consumoG), ventasLps: ventasPor.get(`${t.sucursal_id}|${d.fecha}`)?.total ?? null })),
    };
  });

  // Alerta: una tienda consume bastante más gelato por lempira vendido que el resto (merma, regalos o desperdicio).
  const medianaRatio = mediana(filas.filter((f) => f.cruce && !f.fuera_de_analisis).map((f) => f.cruce.gramosPorCienLps));
  for (const f of filas) {
    f.desviacionPct = f.cruce && !f.fuera_de_analisis && medianaRatio > 0 ? Math.round((f.cruce.gramosPorCienLps / medianaRatio - 1) * 100) : null;
    f.alerta = f.desviacionPct !== null && f.desviacionPct >= 25 && f.cruce.dias >= 5;
  }
  filas.sort((a, b) => b.consumoKg - a.consumoKg);

  return {
    desde, hasta, dias: diasEntre(desde, hasta) + 1, medianaGramosPorCienLps: Math.round(medianaRatio) || null,
    totales: { consumoKg: kg(filas.reduce((a, f) => a + f.consumoKg * 1000, 0)), enviadoKg: kg(filas.reduce((a, f) => a + f.enviadoKg * 1000, 0)), ventasLps: Math.round(filas.reduce((a, f) => a + f.ventasLps, 0) * 100) / 100 },
    sucursales: filas,
    sabores: [...porSabor.values()].map((s) => ({ sabor_id: s.sabor_id, nombre: s.nombre, consumoKg: kg(s.consumoG), entradaKg: kg(s.entradaG), porSucursal: [...s.porSucursal].map(([id, g]) => ({ sucursal_id: id, nombre: porSucursal.get(id)?.nombre, consumoKg: kg(g) })).sort((a, b) => b.consumoKg - a.consumoKg) })).sort((a, b) => b.consumoKg - a.consumoKg),
  };
}
