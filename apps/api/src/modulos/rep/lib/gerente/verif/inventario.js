import {
  GRAVEDAD, NIVEL, crearLimpieza, compuerta, crearHallazgo, diasDistintos, diasEntre, fechaCorta, nivelSegunCompuertas, plural,
  redondear, resultado, sinDatos, sumarDias, agruparPor, suma,
} from '../nucleo.js';
import { lotesQueVencenConStock } from '../../avisos.js';

const AREA = 'inventario';
const fechaDeSQL = (texto) => String(texto || '').slice(0, 10);

/** Insumos de materia prima de verdad: sin equipos ni utensilios, que no se consumen. */
const mercaderia = (datos) => datos.insumos.filter((i) => !i.es_equipo);

// ──────────────────────────────────────────────────────────────────────────────────────────

const BASE_KARDEX = {
  id: 'kardex_integridad',
  nombre: 'El stock coincide con su historial de movimientos',
  area: AREA,
};

/**
 * El kardex es el libro de cada movimiento; stock_actual es el número que se muestra. Tienen
 * que contar la misma historia. Si no, alguien cambió el número sin dejar rastro, o un
 * movimiento se perdió, y entonces ningún reporte de inventario se puede creer.
 *
 * Esta es de las pocas verificaciones que NO necesita repetirse en varios días: es aritmética.
 * O cuadra o no cuadra.
 */
export function kardexIntegridad(datos) {
  const porInsumo = agruparPor(datos.movimientos, (m) => m.insumo_id);
  const insumos = mercaderia(datos).filter((i) => i.stock_actual !== null && i.stock_actual !== undefined);
  let revisados = 0;
  const problemas = [];

  for (const insumo of insumos) {
    const lista = (porInsumo.get(insumo.id) || []).sort((a, b) => a.id - b.id);
    if (!lista.length) continue;
    revisados += 1;

    const ultimo = lista[lista.length - 1];
    const diferencia = Number(insumo.stock_actual) - Number(ultimo.saldo_resultante);
    const roturas = [];
    for (let i = 1; i < lista.length; i++) {
      const esperado = Number(lista[i - 1].saldo_resultante) + (lista[i].tipo === 'entrada' ? 1 : -1) * Number(lista[i].cantidad);
      if (Math.abs(Number(lista[i].saldo_resultante) - esperado) > 0.05) roturas.push(lista[i]);
    }
    const toleranciaStock = Math.max(0.05, 0.005 * Math.abs(Number(insumo.stock_actual)));
    if (Math.abs(diferencia) > toleranciaStock || roturas.length) {
      problemas.push({ insumo, diferencia, roturas: roturas.length, ultimo });
    }
  }

  if (!revisados) return sinDatos(BASE_KARDEX, 'Todavía no hay movimientos de inventario registrados.');
  if (!problemas.length) return resultado(BASE_KARDEX, { revisado: `${revisados} insumos con historial` });

  problemas.sort((a, b) => Math.abs(b.diferencia) - Math.abs(a.diferencia));
  const grave = problemas.some((p) => Math.abs(p.diferencia) >= Math.max(1, 0.1 * Math.abs(Number(p.insumo.stock_actual))));
  const compuertas = [
    compuerta('Se comparó el stock mostrado contra el último saldo del kardex', true),
    compuerta('La diferencia supera el redondeo normal', true),
    compuerta('Es aritmética: no depende de interpretar nada', true),
  ];
  return resultado(BASE_KARDEX, {
    revisado: `${revisados} insumos con historial`,
    hallazgos: [crearHallazgo({
      verificacion: BASE_KARDEX.id,
      area: AREA,
      clave: 'global',
      titulo: `${problemas.length} ${plural(problemas.length, 'insumo cuyo stock no coincide', 'insumos cuyo stock no coincide')} con su historial`,
      detalle: 'El número que se muestra no es el que resulta de sumar y restar sus movimientos. Alguien lo cambió sin pasar por el registro, o se perdió un movimiento.',
      gravedad: grave ? GRAVEDAD.ALTA : GRAVEDAD.MEDIA,
      nivel: NIVEL.CONFIRMADO,
      evidencia: problemas.slice(0, 5).map((p) => `${p.insumo.nombre}: muestra ${redondear(p.insumo.stock_actual, 2)}, el historial termina en ${redondear(p.ultimo.saldo_resultante, 2)}${p.roturas ? ` (y ${p.roturas} ${plural(p.roturas, 'salto', 'saltos')} en la cadena)` : ''}`),
      compuertas,
      descartado: ['No es redondeo: la diferencia pasa del 0.5% del stock.'],
      accion: 'Contá físicamente esos insumos y corregí el total desde su ficha (queda registrado). Hasta entonces, el valor del inventario y las alertas de stock bajo no son confiables para ellos.',
    })],
  });
}

// ──────────────────────────────────────────────────────────────────────────────────────────

const BASE_SE_ACABA = {
  id: 'stock_se_acaba',
  nombre: 'Materia prima que se va a acabar',
  area: AREA,
};

// Cuánto se tarda en reponer. Un insumo de Mec3 viene de afuera y no se consigue de un día
// para otro; uno local se compra en la semana.
const DIAS_REPOSICION = { mec3: 21, local: 7 };

/**
 * Cuántos días de producto quedan al ritmo al que realmente se viene gastando, comparado con
 * lo que tarda en llegar más. Es distinto de "bajo el mínimo": un insumo puede estar lejos de
 * su mínimo y aun así acabarse antes de que llegue el próximo pedido, si se está gastando más
 * rápido que de costumbre.
 *
 * Solo se estima de insumos que de verdad se gastan seguido (4 días distintos en un mes). Un
 * insumo que se usó una vez no tiene "ritmo" y adivinarlo sería inventar.
 */
export function stockSeAcaba(datos) {
  const desde = sumarDias(datos.hoy, -28);
  const salidas = agruparPor(
    datos.movimientos.filter((m) => m.tipo === 'salida' && fechaDeSQL(m.creado_en) >= desde),
    (m) => m.insumo_id
  );
  const aviso = [];
  let evaluados = 0;

  for (const insumo of mercaderia(datos)) {
    const lista = salidas.get(insumo.id) || [];
    const fechas = diasDistintos(lista.map((m) => fechaDeSQL(m.creado_en)));
    if (fechas < 4) continue;
    const ultimaSalida = lista.map((m) => fechaDeSQL(m.creado_en)).sort().pop();
    if (diasEntre(ultimaSalida, datos.hoy) > 14) continue; // dejó de usarse: el ritmo ya no vale
    evaluados += 1;

    const porDia = suma(lista.map((m) => m.cantidad)) / 28;
    if (!(porDia > 0)) continue;
    const stock = Number(insumo.stock_actual) || 0;
    const dias = stock / porDia;
    const limite = DIAS_REPOSICION[insumo.tipo] || 7;
    if (dias >= limite) continue;
    aviso.push({ insumo, stock, porDia, dias, limite });
  }

  if (!evaluados) return sinDatos(BASE_SE_ACABA, 'Ningún insumo tiene todavía 4 días con salidas en el último mes como para estimar su ritmo.');
  if (!aviso.length) return resultado(BASE_SE_ACABA, { revisado: `${evaluados} insumos con ritmo de consumo conocido` });

  aviso.sort((a, b) => a.dias - b.dias);
  const yaSeAcabo = aviso.some((a) => a.stock <= 0);
  return resultado(BASE_SE_ACABA, {
    revisado: `${evaluados} insumos con ritmo de consumo conocido`,
    hallazgos: [crearHallazgo({
      verificacion: BASE_SE_ACABA.id,
      area: AREA,
      clave: 'global',
      titulo: `${aviso.length} ${plural(aviso.length, 'insumo se va a acabar', 'insumos se van a acabar')} antes de que llegue más`,
      detalle: 'Al ritmo al que se vienen gastando, el stock no alcanza hasta que se pueda reponer.',
      gravedad: yaSeAcabo || aviso[0].dias < 3 ? GRAVEDAD.ALTA : GRAVEDAD.MEDIA,
      nivel: yaSeAcabo ? NIVEL.CONFIRMADO : NIVEL.PROBABLE,
      evidencia: aviso.slice(0, 6).map((a) => `${a.insumo.nombre}: ${a.stock <= 0 ? 'ya se acabó' : `alcanza ~${redondear(a.dias, 0)} ${plural(Math.round(a.dias), 'día', 'días')}`} (reponer tarda ~${a.limite})`),
      compuertas: [
        compuerta('Se gastó en 4 días distintos o más del último mes', true),
        compuerta('Se sigue usando: la última salida es de las últimas dos semanas', true),
        compuerta('El stock alcanza menos días de los que tarda en llegar más', true),
        compuerta('Alguno ya está en cero', yaSeAcabo, { requerida: false }),
      ],
      descartado: ['No es un insumo parado: se está usando seguido y hace poco.'],
      accion: 'Hacé el pedido de reposición de esos insumos ahora. Es una estimación por ritmo reciente: si viene una semana de menos producción, puede alcanzar más.',
    })],
  });
}

// ──────────────────────────────────────────────────────────────────────────────────────────

const BASE_PRECIOS = {
  id: 'precios_dudosos',
  nombre: 'Precios de materia prima que no cierran',
  area: AREA,
};

/**
 * El costeo vale lo que valen los precios que tiene cargados. Tres cosas los vuelven
 * sospechosos: insumos con stock y sin precio (no se pueden valorizar), un salto brusco entre
 * el último precio y el anterior (que muchas veces es un cero de más), y precios muy viejos
 * en lo que viene de afuera.
 *
 * Un salto de exactamente 10 veces es casi seguro un error de dígitos, no inflación.
 */
export function preciosDudosos(datos) {
  const conStock = mercaderia(datos).filter((i) => Number(i.stock_actual) > 0);
  if (!conStock.length) return sinDatos(BASE_PRECIOS, 'No hay insumos con stock para valorizar.');
  const preciosPor = agruparPor(datos.precios, (p) => p.insumo_id);
  for (const lista of preciosPor.values()) lista.sort((a, b) => String(a.fecha_vigencia).localeCompare(String(b.fecha_vigencia)) || a.id - b.id);

  const sinPrecio = [];
  const saltos = [];
  const viejos = [];
  for (const insumo of conStock) {
    const lista = preciosPor.get(insumo.id) || [];
    if (!lista.length) {
      sinPrecio.push(insumo);
      continue;
    }
    const ultimo = lista[lista.length - 1];
    if (lista.length >= 2) {
      const previo = lista[lista.length - 2];
      const razon = Number(ultimo.lps_kg) / Number(previo.lps_kg);
      if (Number.isFinite(razon) && (razon >= 1.25 || razon <= 0.8)) {
        const decimas = Math.abs(Math.log10(razon));
        saltos.push({ insumo, previo: Number(previo.lps_kg), ultimo: Number(ultimo.lps_kg), razon, dedos: decimas >= 0.95 && decimas <= 1.05 });
      }
    }
    if (insumo.tipo === 'mec3' && diasEntre(String(ultimo.fecha_vigencia).slice(0, 10), datos.hoy) >= 180) {
      viejos.push({ insumo, edad: diasEntre(String(ultimo.fecha_vigencia).slice(0, 10), datos.hoy) });
    }
  }

  const hallazgos = [];
  if (sinPrecio.length) {
    hallazgos.push(crearHallazgo({
      verificacion: BASE_PRECIOS.id, area: AREA, clave: 'sin-precio',
      titulo: `${sinPrecio.length} ${plural(sinPrecio.length, 'insumo con stock y sin precio', 'insumos con stock y sin precio')}`,
      detalle: 'Tienen producto en bodega pero no se pueden valorizar: el valor del inventario es un piso, no el valor real.',
      gravedad: GRAVEDAD.MEDIA,
      nivel: NIVEL.CONFIRMADO,
      evidencia: sinPrecio.slice(0, 5).map((i) => `${i.nombre}: ${redondear(i.stock_actual, 1)} en stock`),
      compuertas: [compuerta('Tienen stock mayor a cero', true), compuerta('No tienen ningún precio cargado', true)],
      descartado: ['No son equipos ni utensilios: son materia prima.'],
      accion: 'Cargales el precio desde Costeo → Insumos para que entren al valor del inventario y al costo de las recetas.',
    }));
  }
  if (saltos.length) {
    const hayDedos = saltos.some((s) => s.dedos);
    saltos.sort((a, b) => Math.abs(Math.log(b.razon)) - Math.abs(Math.log(a.razon)));
    hallazgos.push(crearHallazgo({
      verificacion: BASE_PRECIOS.id, area: AREA, clave: 'salto',
      titulo: `${saltos.length} ${plural(saltos.length, 'precio cambió', 'precios cambiaron')} de golpe`,
      detalle: hayDedos
        ? 'Al menos uno cambió exactamente 10 veces: casi seguro es un cero de más o de menos al cargarlo.'
        : 'El último precio cargado se aparta más de un 25% del anterior.',
      gravedad: hayDedos ? GRAVEDAD.ALTA : GRAVEDAD.MEDIA,
      nivel: hayDedos ? NIVEL.CONFIRMADO : NIVEL.PROBABLE,
      evidencia: saltos.slice(0, 5).map((s) => `${s.insumo.nombre}: L ${redondear(s.previo, 2)} → L ${redondear(s.ultimo, 2)} (${s.razon > 1 ? '×' : '÷'}${redondear(s.razon > 1 ? s.razon : 1 / s.razon, 1)})`),
      compuertas: [
        compuerta('Se comparó el último precio contra el anterior del mismo insumo', true),
        compuerta('El cambio es mayor al 25%', true),
        compuerta('Es exactamente 10 veces: error de dígitos', hayDedos, { requerida: false }),
      ],
      descartado: ['No es una actualización normal: sería un salto muy grande para un solo período.'],
      accion: 'Verificá esos precios contra la factura. Si es un error, corregilo: todas las recetas que usan ese insumo salen mal costeadas.',
    }));
  }
  if (viejos.length) {
    viejos.sort((a, b) => b.edad - a.edad);
    hallazgos.push(crearHallazgo({
      verificacion: BASE_PRECIOS.id, area: AREA, clave: 'viejo',
      titulo: `${viejos.length} ${plural(viejos.length, 'precio de Mec3 sin actualizar', 'precios de Mec3 sin actualizar')} hace más de 6 meses`,
      detalle: 'El costo de producción usa un precio que puede haber cambiado.',
      gravedad: GRAVEDAD.BAJA,
      nivel: NIVEL.OBSERVAR,
      evidencia: viejos.slice(0, 5).map((v) => `${v.insumo.nombre}: último precio hace ${v.edad} días`),
      compuertas: [compuerta('El último precio tiene más de 180 días', true), compuerta('Es un insumo que se importa y su precio se mueve', true)],
      descartado: [],
      accion: 'La próxima vez que llegue una factura de Mec3, actualizá estos precios.',
    }));
  }

  return resultado(BASE_PRECIOS, { hallazgos, revisado: `${conStock.length} insumos con stock` });
}

// ──────────────────────────────────────────────────────────────────────────────────────────

const BASE_PEDIDOS = {
  id: 'pedidos_insumos_atrasados',
  nombre: 'Pedidos de insumos sin atender',
  area: AREA,
};

/**
 * Lo que una tienda pidió (vasos, conos, servilletas). No todo pedido se despacha, así que un
 * pedido viejo sin tocar es casi siempre un registro que quedó abierto, no una tienda sin insumos.
 * Solo se avisa lo que sí es una pista de olvido: un pedido ya PREPARADO (alguien lo armó) que
 * lleva días sin salir. Todo lo demás, cuando es viejo, se junta como "por ordenar".
 */
const DIAS_PEDIDO_VIEJO = 7;
const DIAS_PREPARADO_VIGENTE = 14;

export function pedidosAtrasados(datos) {
  if (!datos.pedidos.length) return sinDatos(BASE_PEDIDOS, 'No hay pedidos de insumos registrados.');
  const edad = (p) => diasEntre(p.fecha, datos.hoy);
  const abiertos = datos.pedidos.filter((p) => ['pedido', 'preparado'].includes(p.estado));
  const preparadosSinSalir = abiertos.filter((p) => p.estado === 'preparado' && edad(p) >= 2 && edad(p) <= DIAS_PREPARADO_VIGENTE);
  const viejos = abiertos.filter((p) => !preparadosSinSalir.includes(p) && edad(p) >= DIAS_PEDIDO_VIEJO);
  const hallazgos = [];
  const nombre = (id) => datos.sucursales.find((s) => s.id === id)?.nombre || id;

  for (const [sucursalId, lista] of agruparPor(preparadosSinSalir, (p) => p.sucursal_id)) {
    const masVieja = Math.max(...lista.map(edad));
    hallazgos.push(crearHallazgo({
      verificacion: BASE_PEDIDOS.id,
      area: AREA,
      clave: sucursalId,
      titulo: `${nombre(sucursalId)}: ${lista.length} ${plural(lista.length, 'pedido de insumos armado', 'pedidos de insumos armados')} que no salió hace ${masVieja} días`,
      detalle: 'Alguien lo preparó, pero no figura como enviado.',
      gravedad: masVieja >= 5 ? GRAVEDAD.ALTA : GRAVEDAD.MEDIA,
      nivel: NIVEL.PROBABLE,
      evidencia: lista.slice(0, 4).map((p) => `Pedido del ${fechaCorta(p.fecha)} (${p.estado}): ${p.items.length} ${plural(p.items.length, 'artículo', 'artículos')}`),
      compuertas: [compuerta('Está en estado «preparado» (alguien lo armó)', true), compuerta('Tiene entre 2 y 14 días', true)],
      descartado: ['No es un pedido que nadie tocó: ya está armado.', 'Puede que se haya entregado en mano sin marcarlo como enviado.'],
      accion: 'Revisa si ya se entregó (y márcalo enviado) o si quedó olvidado en la fábrica.',
      sucursal_id: sucursalId,
      sucursal_nombre: nombre(sucursalId),
    }));
  }

  const limpieza = [];
  if (viejos.length) {
    limpieza.push(crearLimpieza({
      verificacion: BASE_PEDIDOS.id, area: AREA, clave: 'pedidos-viejos',
      titulo: `${viejos.length} ${plural(viejos.length, 'pedido de insumos abierto', 'pedidos de insumos abiertos')} hace más de una semana`,
      detalle: 'Como no todos los pedidos de insumos se envían, lo normal es que se hayan quedado abiertos sin cerrarse. No quiere decir que las tiendas se hayan quedado sin insumos.',
      accion: 'No hace falta hacer nada. Si quieres limpiar el conteo, ciérralos.',
      evidencia: viejos.slice(0, 3).map((p) => `Pedido del ${fechaCorta(p.fecha)} · ${nombre(p.sucursal_id)} (${p.estado})`),
      filas: [...agruparPor(viejos, (p) => p.sucursal_id)].map(([id, l]) => ({ tienda: nombre(id), cantidad: l.length, mas_vieja_dias: Math.max(...l.map(edad)) })),
    }));
  }
  return resultado(BASE_PEDIDOS, { hallazgos, revisado: `${datos.pedidos.length} pedidos de insumos`, limpieza });
}

// ──────────────────────────────────────────────────────────────────────────────────────────

const BASE_LOTES = {
  id: 'lotes_por_vencer',
  nombre: 'Lotes de Mec3 que vencen antes de gastarse',
  area: AREA,
};

/**
 * Cruza lo que queda de cada lote con el ritmo al que se gasta ese insumo. "Vence en 30 días"
 * solo es un problema si al ritmo actual no se alcanza a gastar; esta verificación dice cuánto
 * va a sobrar, que es lo que se puede decidir (empujar un sabor, cambiar el orden de producción).
 */
export function lotesPorVencer(datos) {
  if (!datos.lotes.length) return sinDatos(BASE_LOTES, 'No hay lotes de Mec3 con producto.');
  const desde = sumarDias(datos.hoy, -28);
  const consumoDiario = new Map();
  for (const [insumoId, lista] of agruparPor(
    datos.movimientos.filter((m) => m.tipo === 'salida' && fechaDeSQL(m.creado_en) >= desde),
    (m) => m.insumo_id
  )) {
    if (diasDistintos(lista.map((m) => fechaDeSQL(m.creado_en))) >= 3) consumoDiario.set(insumoId, suma(lista.map((m) => m.cantidad)) / 28);
  }
  if (!consumoDiario.size) return sinDatos(BASE_LOTES, 'Todavía no hay ritmo de consumo conocido para comparar contra los vencimientos.');

  const avisos = lotesQueVencenConStock({ lotes: datos.lotes, consumoDiario, hoy: datos.hoy });
  if (!avisos.length) return resultado(BASE_LOTES, { revisado: `${datos.lotes.length} lotes con producto` });

  const cercano = avisos[0].dias_para_vencer <= 14;
  return resultado(BASE_LOTES, {
    revisado: `${datos.lotes.length} lotes con producto`,
    hallazgos: [crearHallazgo({
      verificacion: BASE_LOTES.id,
      area: AREA,
      clave: 'global',
      titulo: `${avisos.length} ${plural(avisos.length, 'lote va a vencerse', 'lotes van a vencerse')} con producto adentro`,
      detalle: 'Al ritmo actual de consumo no se alcanza a gastar todo antes de que venza.',
      gravedad: cercano ? GRAVEDAD.ALTA : GRAVEDAD.MEDIA,
      nivel: cercano ? NIVEL.CONFIRMADO : NIVEL.PROBABLE,
      evidencia: avisos.slice(0, 5).map((a) => `${a.insumo_nombre}: vence en ${a.dias_para_vencer} días, sobrarían ~${a.sobrara}`),
      compuertas: [
        compuerta('Se comparó lo que queda del lote contra el ritmo de consumo reciente', true),
        compuerta('El insumo se usa seguido (3 días o más en el último mes)', true),
        compuerta('Alguno vence en 14 días o menos', cercano, { requerida: false }),
      ],
      descartado: ['No es solo "vence pronto": se tomó en cuenta cuánto se alcanza a gastar antes.'],
      accion: 'Empujá los sabores que usan ese insumo o cambiá el orden de producción para gastarlo primero.',
    })],
  });
}

export const VERIFICACIONES_INVENTARIO = [kardexIntegridad, stockSeAcaba, preciosDudosos, pedidosAtrasados, lotesPorVencer];
