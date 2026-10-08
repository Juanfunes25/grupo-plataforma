// Qué producir cada día, de qué sabor y para qué salida (portado de lib/planProduccion.js del original).
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// DE DÓNDE SALE LA DEMANDA
//
// No hace falta un segundo modelo. La agenda de despacho (Reposición) ya dice, con FECHA, cuánto va a
// salir de fábrica de cada sabor hacia cada tienda, y esa agenda ya descuenta lo que cada tienda tiene
// en su vitrina (arranca del pesaje real de la última noche). Mirada desde la fábrica, es exactamente
// la demanda que hay que abastecer.
//
// LA REGLA, EN UNA LÍNEA
//
//     producir hoy = lo que sale mañana − lo que ya hay en cámara
//
// y el saldo se arrastra:  cámara(mañana) = cámara(hoy) + lo producido − lo que salió.
//
// Es deliberadamente JUSTO. Un plan que produce «un poco de más por las dudas» todos los días no
// produce un poco de más: produce un poco de más ACUMULADO, y a la semana la cámara tiene gelato de
// diez días. El colchón contra quedarse corto ya está puesto donde corresponde (el objetivo de cada
// tienda, con su nivel de servicio); ponerlo otra vez acá sería cobrarlo dos veces. Lo único que se
// redondea hacia arriba son las panas (no se puede hacer media pana) y el sobrante se arrastra al día
// siguiente, así que ese exceso no se acumula.
//
// LOS ANDES
//
// Se sirve directo de la fábrica: no registra despachos, así que NO aparece en la agenda, pero consume
// igual. Si el plan mirara solo los despachos registrados, la fábrica produciría de menos todos los días.
// Por eso se le suma un 25 % encima de lo que piden las tiendas que sí registran: es el supuesto del
// dueño (la cuarta tienda mueve más o menos lo que una). Es un SUPUESTO, no una medición, y se muestra
// como tal. El día que Los Andes registre sus salidas, este factor se baja a cero.
import { sumarDias } from '@grupo/shared';
import { conflicto } from '../../lib/http.js';
import { DIAS_CORTOS, DIAS_SEMANA, diaSemanaDe } from './comun.js';

export const FACTOR_LOS_ANDES = 0.25;
const HORIZONTE_POR_DEFECTO = 7;       // una semana: cubre el ciclo de reparto más largo de cualquier tienda
const GRAMOS_PANA_POR_DEFECTO = 3000;
const kg = (gramos) => Math.round(gramos / 100) / 10;

/**
 * `tiendas`: la salida de armarRecomendacion, con su `agenda` fechada.
 * `stock`: [{ sabor_id, nombre, gramos_pana, gramos }] — saldo real de cámara hoy.
 */
export function armarPlanProduccion({ tiendas, stock = [], hoy, horizonteDias = HORIZONTE_POR_DEFECTO, factorLosAndes = FACTOR_LOS_ANDES }) {
  // Se produce HOY para la salida de MAÑANA: el último día planificado produce para el día siguiente al horizonte.
  const diasDeProduccion = Array.from({ length: horizonteDias }, (_, i) => sumarDias(hoy, i));

  const porSabor = new Map();
  const asegurar = (saborId, nombre, gramosPana) => {
    if (!porSabor.has(saborId)) {
      porSabor.set(saborId, { sabor_id: saborId, nombre, gramosPana: gramosPana > 0 ? gramosPana : GRAMOS_PANA_POR_DEFECTO, gramosEnCamara: 0, salidas: new Map(), destinos: new Map() });
    }
    return porSabor.get(saborId);
  };

  for (const s of stock) asegurar(s.sabor_id, s.nombre, Number(s.gramos_pana)).gramosEnCamara = Math.max(0, Number(s.gramos) || 0);

  // 1. Volcar la agenda de todas las tiendas a un solo calendario de salidas.
  for (const tienda of tiendas) {
    for (const dia of tienda.agenda || []) {
      for (const sabor of dia.sabores) {
        if (!(sabor.gramosEnviar > 0)) continue;
        const e = asegurar(sabor.sabor_id, sabor.nombre, sabor.gramosPana);
        e.salidas.set(dia.fecha, (e.salidas.get(dia.fecha) || 0) + sabor.gramosEnviar);
        if (!e.destinos.has(dia.fecha)) e.destinos.set(dia.fecha, new Set());
        e.destinos.get(dia.fecha).add(tienda.nombre);
      }
    }
  }

  // 2. Simular día por día: producir lo justo para la salida del día siguiente.
  const produccionPorDia = new Map(diasDeProduccion.map((f) => [f, []]));
  const resumen = [];
  for (const s of porSabor.values()) {
    let camara = s.gramosEnCamara, totalProducir = 0, totalSalidas = 0, primerDia = null;
    const detalle = [];
    for (const fecha of diasDeProduccion) {
      const salida = sumarDias(fecha, 1);
      const pedido = (s.salidas.get(salida) || 0) * (1 + factorLosAndes);    // el +25 % de Los Andes consume de la misma cámara
      totalSalidas += pedido;
      if (pedido <= 0) continue;
      const faltan = Math.max(0, pedido - camara);
      const panas = Math.ceil(faltan / s.gramosPana);                         // no hay media pana
      const producir = panas * s.gramosPana;
      camara = camara + producir - pedido;
      totalProducir += producir;
      if (producir > 0 && !primerDia) primerDia = fecha;
      if (producir > 0) {
        const item = {
          sabor_id: s.sabor_id, nombre: s.nombre, panas, kg: kg(producir), kgParaSalida: kg(pedido),
          kgEnCamaraAntes: kg(Math.max(0, camara - producir + pedido)), saleEl: salida, nombreDiaSalida: DIAS_SEMANA[diaSemanaDe(salida)],
          tiendas: [...(s.destinos.get(salida) || [])].sort(),
        };
        produccionPorDia.get(fecha).push(item);
        detalle.push({ fecha, panas, kg: item.kg, saleEl: salida });
      }
    }
    if (totalSalidas <= 0) continue;
    resumen.push({
      sabor_id: s.sabor_id, nombre: s.nombre, gramosPana: s.gramosPana, kgEnCamara: kg(s.gramosEnCamara), kgSalidas: kg(totalSalidas),
      kgAProducir: kg(totalProducir), panasAProducir: Math.round(totalProducir / s.gramosPana), primerDia, detalle,
    });
  }
  resumen.sort((a, b) => b.kgAProducir - a.kgAProducir || a.nombre.localeCompare(b.nombre));

  const porDia = diasDeProduccion.map((fecha) => {
    const items = produccionPorDia.get(fecha).sort((a, b) => b.kg - a.kg || a.nombre.localeCompare(b.nombre));
    const dia = diaSemanaDe(fecha);
    return {
      fecha, diaSemana: dia, nombreDia: DIAS_SEMANA[dia], nombreCorto: DIAS_CORTOS[dia], esHoy: fecha === hoy, paraSalidaDel: sumarDias(fecha, 1),
      totalPanas: items.reduce((a, i) => a + i.panas, 0), totalKg: Math.round(items.reduce((a, i) => a + i.kg, 0) * 10) / 10, sabores: items,
    };
  });
  const suma = (campo) => Math.round(resumen.reduce((a, s) => a + s[campo], 0) * 10) / 10;
  return {
    hoy, horizonteDias, desde: diasDeProduccion[0], hasta: diasDeProduccion[diasDeProduccion.length - 1], factorLosAndes,
    totalKgAProducir: suma('kgAProducir'), totalKgSalidas: suma('kgSalidas'), totalKgEnCamara: suma('kgEnCamara'), sabores: resumen, porDia,
  };
}

/** Cámara real: kg de cada tanda que todavía no salieron en un despacho, por sabor. */
export async function stockEnCamara(q, empresaId) {
  const { rows } = await q.query(
    `select p.sabor_id, sa.nombre, sa.gramos_pana, coalesce(sum(p.kg_restante), 0)::float8 * 1000 as gramos
       from prod.producciones p join rep.sabores sa on sa.id = p.sabor_id
      where p.empresa_id = $1 group by p.sabor_id, sa.nombre, sa.gramos_pana having coalesce(sum(p.kg_restante), 0) > 0`, [empresaId]);
  return rows;
}

/**
 * Junta la agenda de despacho (Reposición) con la cámara real y arma el plan.
 * La agenda sale de modulos/rep/datos.js (recomendacionDespachoDeDatos), que es de R1: se importa al
 * usarlo, así un cambio allá no tumba el arranque del API.
 */
export async function planProduccionDeDatos(q, empresaId, { desde, hasta, hoy, horizonteDias }) {
  let recomendacion;
  try {
    const rep = await import('../rep/datos.js');
    recomendacion = await rep.recomendacionDespachoDeDatos(q, empresaId, { desde, hasta, hoy });
  } catch (e) {
    const err = conflicto('La agenda de despacho (Reposición) no está disponible, así que no se puede proyectar la producción.');
    err.cause = e;
    throw err;
  }
  const stock = await stockEnCamara(q, empresaId);
  return { ...armarPlanProduccion({ tiendas: recomendacion.tiendas, stock, hoy, horizonteDias }), baseDesde: recomendacion.desde, baseHasta: recomendacion.hasta, excluidas: recomendacion.excluidas };
}
