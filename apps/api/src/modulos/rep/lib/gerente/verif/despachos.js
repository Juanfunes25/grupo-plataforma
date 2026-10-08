import {
  GRAVEDAD, NIVEL, crearLimpieza, compuerta, crearHallazgo, diasDistintos, diasEntre, fechaCorta, kg, nivelSegunCompuertas,
  plural, redondear, resultado, sinDatos, sumarDias, agruparPor, suma,
} from '../nucleo.js';
import { fechaEntrega, nombreSabor, nombreTienda, gramosPana, tiendasConDespachos } from './pesajes.js';

const AREA = 'tiendas';

const BASE_RECEPCION = {
  id: 'recepcion_diferencias',
  nombre: 'Panas que no coinciden al recibir',
  area: AREA,
};

/**
 * La tienda cuenta lo que le llegó y lo compara con lo que salió. Una diferencia suelta es un
 * error de conteo. Pero si en una tienda faltan panas una y otra vez, y casi siempre para el
 * mismo lado, ya no es azar: algo se pierde en el camino o se despacha menos de lo que se anota.
 *
 * Lo que distingue un problema de un descuido es la DIRECCIÓN. Los errores de conteo caen
 * para cualquier lado; un faltante sistemático cae siempre del mismo. Por eso se exige que
 * al menos el 70% de las diferencias vaya hacia el mismo lado.
 */
export function recepcionDiferencias(datos) {
  const tiendas = tiendasConDespachos(datos);
  const desde = sumarDias(datos.hoy, -45);
  const recibidos = datos.despachos.filter(
    (d) => d.estado === 'recibido' && d.panas_recibidas !== null && d.panas_recibidas !== undefined && d.fecha >= desde
  );
  const base = agruparPor(recibidos, (d) => d.sucursal_id);
  const hallazgos = [];
  let ruido = 0;
  let evaluadas = 0;

  const tasaDe = (lista) => (lista.length ? lista.filter((d) => d.panas_recibidas !== d.panas).length / lista.length : 0);
  const tasaGlobal = tasaDe(recibidos);

  for (const tienda of tiendas) {
    const lista = base.get(tienda.id) || [];
    if (lista.length < 8) continue;
    evaluadas += 1;

    const conDiferencia = lista.filter((d) => d.panas_recibidas !== d.panas);
    const faltan = conDiferencia.filter((d) => d.panas_recibidas < d.panas);
    const sobran = conDiferencia.filter((d) => d.panas_recibidas > d.panas);
    const dominante = faltan.length >= sobran.length ? faltan : sobran;
    const haciaFaltante = dominante === faltan;
    const netoPanas = suma(dominante.map((d) => Math.abs(d.panas - d.panas_recibidas)));
    const tasa = tasaDe(lista);
    const fechas = diasDistintos(dominante.map((d) => d.fecha));
    const direccion = conDiferencia.length ? dominante.length / conDiferencia.length : 0;
    const otras = recibidos.filter((d) => d.sucursal_id !== tienda.id);
    const tasaOtras = tasaDe(otras);

    const compuertas = [
      compuerta(`Hay diferencias en ${fechas} fechas distintas`, fechas >= 3),
      compuerta(`Pasa en ${redondear(tasa * 100, 0)}% de las recepciones (de ${lista.length})`, tasa >= 0.15),
      compuerta(`El ${redondear(direccion * 100, 0)}% de las diferencias va hacia el mismo lado`, direccion >= 0.7),
      compuerta(`Suman ${netoPanas} panas`, netoPanas >= 3),
      compuerta('En las otras tiendas pasa mucho menos', otras.length >= 8 && tasa >= 2 * tasaOtras, { requerida: false }),
    ];
    const nivel = nivelSegunCompuertas(compuertas);
    if (!nivel) {
      ruido += conDiferencia.length;
      continue;
    }

    const sinResolver = dominante.filter((d) => !d.discrepancia_resuelta).length;
    const gramos = suma(dominante.map((d) => Math.abs(d.panas - d.panas_recibidas) * gramosPana(datos, d.sabor_id)));
    hallazgos.push(crearHallazgo({
      verificacion: BASE_RECEPCION.id,
      area: AREA,
      clave: tienda.id,
      titulo: haciaFaltante
        ? `${tienda.nombre}: le faltan panas al recibir, una y otra vez`
        : `${tienda.nombre}: recibe más panas de las que salen`,
      detalle: haciaFaltante
        ? `En ${dominante.length} de ${lista.length} recepciones contaron menos panas de las que fábrica anotó que salieron.`
        : `En ${dominante.length} de ${lista.length} recepciones contaron más panas de las que fábrica anotó que salieron.`,
      gravedad: netoPanas >= 8 ? GRAVEDAD.ALTA : GRAVEDAD.MEDIA,
      nivel,
      evidencia: dominante.slice(-4).map((d) => `${fechaCorta(d.fecha)} · ${nombreSabor(datos, d.sabor_id)}: salieron ${d.panas}, contaron ${d.panas_recibidas}`),
      compuertas,
      descartado: [
        'No es un error de conteo suelto: casi todas las diferencias van hacia el mismo lado.',
        sinResolver < dominante.length ? `${dominante.length - sinResolver} ya las diste por resueltas, pero siguen repitiéndose.` : null,
      ].filter(Boolean),
      accion: haciaFaltante
        ? 'Fijate si el conteo de salida en fábrica y el de recepción en la tienda se hacen igual (¿panas llenas o a medias?). Si faltan siempre, mirá el trayecto.'
        : 'Revisá cómo se anotan las salidas en fábrica: la tienda está recibiendo más de lo que figura.',
      impacto: `${kg(gramos)} kg ${haciaFaltante ? 'sin llegar' : 'sin registrar'}`,
      sucursal_id: tienda.id,
      sucursal_nombre: tienda.nombre,
    }));
  }

  if (!evaluadas) return sinDatos(BASE_RECEPCION, 'Hacen falta al menos 8 recepciones confirmadas en una tienda para distinguir un patrón de un descuido.');
  return resultado(BASE_RECEPCION, {
    hallazgos,
    ruido,
    revisado: `${recibidos.length} recepciones en ${evaluadas} ${plural(evaluadas, 'tienda', 'tiendas')} (${redondear(tasaGlobal * 100, 0)}% con diferencia en total)`,
  });
}

// ──────────────────────────────────────────────────────────────────────────────────────────

const BASE_PENDIENTES = {
  id: 'despachos_sin_cerrar',
  nombre: 'Despachos que quedaron a medias',
  area: AREA,
};

/**
 * Lo que salió de fábrica y nadie confirmó que llegó, y lo que se pidió y nunca se mandó.
 *
 * Son hechos, no patrones: o están cerrados o no lo están. Lo único que se mira es la
 * antigüedad, para no gritar por algo que salió esta mañana y todavía está en el camión.
 */
/** Más allá de esto, un "enviado sin confirmar" ya no es una duda sobre ese envío: es un registro viejo. */
const DIAS_ENVIO_VIGENTE = 14;
/** Un pedido que no salió en una semana se quedó abierto: no todos los pedidos se despachan. */
const DIAS_PEDIDO_ABIERTO = 7;

export function despachosSinCerrar(datos) {
  const tiendas = new Set(tiendasConDespachos(datos).map((t) => t.id));
  const enviados = datos.despachos.filter((d) => tiendas.has(d.sucursal_id) && d.estado === 'enviado' && diasEntre(fechaEntrega(d), datos.hoy) >= 2);
  const enviadosSinConfirmar = enviados.filter((d) => diasEntre(fechaEntrega(d), datos.hoy) <= DIAS_ENVIO_VIGENTE);
  const enviadosViejos = enviados.filter((d) => diasEntre(fechaEntrega(d), datos.hoy) > DIAS_ENVIO_VIGENTE);
  const pedidosAbiertos = datos.despachos.filter(
    (d) => tiendas.has(d.sucursal_id) && ['pendiente', 'preparado'].includes(d.estado) && diasEntre(d.fecha, datos.hoy) >= DIAS_PEDIDO_ABIERTO
  );
  const hallazgos = [];

  for (const [sucursalId, lista] of agruparPor(enviadosSinConfirmar, (d) => d.sucursal_id)) {
    const tienda = nombreTienda(datos, sucursalId);
    // ¿La tienda confirmó otros despachos más nuevos? Entonces lo más probable es que solo se
    // olvidaron de tocar el botón; si no confirmó nada desde entonces, hay que preguntarse si llegó.
    const ultimaViejo = lista.map(fechaEntrega).sort().pop();
    const confirmoDespues = datos.despachos.some(
      (d) => d.sucursal_id === sucursalId && d.estado === 'recibido' && fechaEntrega(d) > ultimaViejo
    );
    const gramos = suma(lista.map((d) => d.gramos_enviados));
    const compuertas = [
      compuerta(`Salieron hace 2 días o más (el más viejo, hace ${diasEntre(lista.map(fechaEntrega).sort()[0], datos.hoy)})`, true),
      compuerta('El sistema los tiene como "enviado", ninguno como recibido', true),
      compuerta('La tienda sí confirmó despachos más nuevos', confirmoDespues, { requerida: false }),
    ];
    hallazgos.push(crearHallazgo({
      verificacion: BASE_PENDIENTES.id,
      area: AREA,
      clave: `sin-confirmar:${sucursalId}`,
      titulo: `${tienda}: ${lista.length} ${plural(lista.length, 'despacho', 'despachos')} sin confirmar que llegó`,
      detalle: confirmoDespues
        ? 'La tienda confirmó otros despachos más nuevos, así que casi seguro solo se olvidaron de confirmar estos.'
        : 'La tienda no confirmó nada desde entonces. Conviene preguntar si el gelato realmente llegó.',
      gravedad: confirmoDespues ? GRAVEDAD.BAJA : GRAVEDAD.ALTA,
      nivel: NIVEL.CONFIRMADO,
      evidencia: lista.slice(0, 4).map((d) => `${fechaCorta(fechaEntrega(d))} · ${nombreSabor(datos, d.sabor_id)}: ${d.panas} ${plural(d.panas, 'pana', 'panas')}`),
      compuertas,
      descartado: ['No es algo de hoy: salieron hace al menos dos días.'],
      accion: confirmoDespues ? 'Pedile a la tienda que confirme la recepción.' : 'Llamá a la tienda: si no llegó, el sistema cree que tienen producto que no tienen.',
      impacto: `${kg(gramos)} kg sin confirmar`,
      sucursal_id: sucursalId,
      sucursal_nombre: tienda,
    }));
  }

  // Lo viejo que quedó abierto no es una falla: se junta en un solo aviso de "por ordenar".
  const filasPorTienda = (lista, fechaDe) => [...agruparPor(lista, (d) => d.sucursal_id)].map(([id, l]) => ({
    tienda: nombreTienda(datos, id), cantidad: l.length, mas_vieja_dias: Math.max(...l.map((d) => diasEntre(fechaDe(d), datos.hoy))),
  }));
  const limpieza = [];
  if (enviadosViejos.length) {
    limpieza.push(crearLimpieza({
      verificacion: BASE_PENDIENTES.id, area: AREA, clave: 'enviados-viejos',
      titulo: `${enviadosViejos.length} ${plural(enviadosViejos.length, 'despacho viejo', 'despachos viejos')} sin marcar como recibido`,
      detalle: `Salieron hace más de ${DIAS_ENVIO_VIGENTE} días y nadie tocó «recibido». Lo más probable es que llegaron y solo falta cerrarlos.`,
      accion: 'Cuando puedas, ciérralos como recibidos para que no ensucien los reportes.',
      evidencia: enviadosViejos.slice(0, 3).map((d) => `${fechaCorta(fechaEntrega(d))} · ${nombreTienda(datos, d.sucursal_id)} · ${nombreSabor(datos, d.sabor_id)}`),
      filas: filasPorTienda(enviadosViejos, fechaEntrega),
    }));
  }
  if (pedidosAbiertos.length) {
    limpieza.push(crearLimpieza({
      verificacion: BASE_PENDIENTES.id, area: AREA, clave: 'pedidos-abiertos',
      titulo: pedidosAbiertos.length === 1 ? '1 pedido que quedó abierto y nunca se envió' : `${pedidosAbiertos.length} pedidos que quedaron abiertos y nunca se enviaron`,
      detalle: `Son pedidos de hace más de ${DIAS_PEDIDO_ABIERTO} días que nunca salieron. Como no todos los pedidos se despachan, lo normal es que simplemente se quedaron abiertos. No cambian lo que se manda ni lo que se produce.`,
      accion: 'No hace falta hacer nada. Si quieres limpiar el conteo, ciérralos o anúlalos.',
      evidencia: pedidosAbiertos.slice(0, 3).map((d) => `Pedido del ${fechaCorta(d.fecha)} · ${nombreTienda(datos, d.sucursal_id)} · ${nombreSabor(datos, d.sabor_id)} (${d.estado})`),
      filas: filasPorTienda(pedidosAbiertos, (d) => d.fecha),
    }));
  }

  const revisado = `${datos.despachos.length} despachos de los últimos 60 días`;
  if (!datos.despachos.length) return sinDatos(BASE_PENDIENTES, 'No hay despachos registrados.');
  return resultado(BASE_PENDIENTES, { hallazgos, revisado, limpieza });
}

// ──────────────────────────────────────────────────────────────────────────────────────────

const BASE_TRAZA = {
  id: 'despachos_sin_trazabilidad',
  nombre: 'Despachos que no se pueden rastrear a un lote',
  area: AREA,
};

/**
 * Si un cliente reclama un helado, la trazabilidad dice de qué tanda venía. Pero solo sirve
 * si cada despacho quedó atado a su tanda. Si la fábrica los rastrea casi todos y una tienda
 * queda siempre afuera, en el día del reclamo esa tienda es un agujero.
 *
 * Solo se audita si la práctica existe: si nadie ata despachos a tandas, no hay nada que
 * comparar y reportarlo sería criticar algo que nunca se pidió.
 */
export function despachosSinTrazabilidad(datos) {
  const tiendas = new Set(tiendasConDespachos(datos).map((t) => t.id));
  const desde = sumarDias(datos.hoy, -30);
  const entregados = datos.despachos.filter(
    (d) => tiendas.has(d.sucursal_id) && ['enviado', 'recibido'].includes(d.estado) && d.fecha >= desde && d.fecha < sumarDias(datos.hoy, -1)
  );
  if (entregados.length < 10) return sinDatos(BASE_TRAZA, 'Hay muy pocos despachos entregados en los últimos 30 días.');

  const cubiertos = new Map();
  for (const t of datos.tandas) cubiertos.set(t.despacho_id, (cubiertos.get(t.despacho_id) || 0) + Number(t.gramos || 0));
  const estaCubierto = (d) => (cubiertos.get(d.id) || 0) >= 0.9 * d.gramos_enviados;

  const cobertura = entregados.filter(estaCubierto).length / entregados.length;
  if (cobertura < 0.5) {
    return sinDatos(BASE_TRAZA, `Solo el ${redondear(cobertura * 100, 0)}% de los despachos se ata a una tanda: la práctica todavía no está en uso como para auditarla.`);
  }

  const hallazgos = [];
  for (const [sucursalId, lista] of agruparPor(entregados, (d) => d.sucursal_id)) {
    const huecos = lista.filter((d) => !estaCubierto(d));
    const fechas = diasDistintos(huecos.map((d) => d.fecha));
    const compuertas = [
      compuerta(`${huecos.length} despachos sin tanda en ${fechas} fechas distintas`, huecos.length >= 5 && fechas >= 3),
      compuerta(`El resto de la fábrica sí lo hace (${redondear(cobertura * 100, 0)}% rastreado)`, true),
    ];
    if (!nivelSegunCompuertas(compuertas)) continue;
    hallazgos.push(crearHallazgo({
      verificacion: BASE_TRAZA.id,
      area: AREA,
      clave: sucursalId,
      titulo: `${nombreTienda(datos, sucursalId)}: ${huecos.length} despachos sin tanda asignada`,
      detalle: 'Si hay un reclamo de producto de esta tienda, no se va a poder decir de qué tanda venía.',
      gravedad: GRAVEDAD.BAJA,
      nivel: NIVEL.OBSERVAR,
      evidencia: huecos.slice(-4).map((d) => `${fechaCorta(d.fecha)} · ${nombreSabor(datos, d.sabor_id)}`),
      compuertas,
      descartado: ['No es que la práctica no exista: el resto de los despachos sí se rastrea.'],
      accion: 'Pedile a quien despacha que ate cada salida a su tanda al prepararla.',
      sucursal_id: sucursalId,
      sucursal_nombre: nombreTienda(datos, sucursalId),
    }));
  }
  return resultado(BASE_TRAZA, { hallazgos, revisado: `${entregados.length} despachos entregados, ${redondear(cobertura * 100, 0)}% rastreados` });
}

export const VERIFICACIONES_DESPACHOS = [recepcionDiferencias, despachosSinCerrar, despachosSinTrazabilidad];
