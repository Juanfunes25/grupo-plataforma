/**
 * Avisos para las 3 personas que entran a Inventario.
 *
 * No son notificaciones push ni correos: son avisos que aparecen al abrir la pantalla. En
 * el plan gratis de Render la instancia se duerme, asi que cualquier cosa agendada en el
 * proceso es poco confiable - un aviso que se calcula cuando alguien mira siempre llega,
 * uno que depende de un temporizador no.
 *
 * La regla de todos: solo avisar de algo sobre lo que se puede hacer ALGO hoy. Un aviso que
 * no cambia ninguna decision entrena a la gente a ignorar el resto.
 *
 * Aca vive el calculo puro; quien llama lee la base y arma la respuesta.
 */

/** Mediana: una sola tanda con un error de tipeo no puede arrastrar el promedio. */
export function mediana(numeros) {
  if (!numeros.length) return null;
  const orden = [...numeros].sort((a, b) => a - b);
  const medio = Math.floor(orden.length / 2);
  return orden.length % 2 ? orden[medio] : (orden[medio - 1] + orden[medio]) / 2;
}

/**
 * Lotes que van a vencer con producto adentro, al ritmo al que se estan consumiendo.
 *
 * Es distinto -y mas util- que "vence en 60 dias": un lote que vence en 30 dias pero se
 * consume en 10 no es un problema, y uno que vence en 90 dias con stock para 200 SI lo es.
 * Avisarlo con anticipacion es lo que permite hacer algo (empujar ese sabor, cambiar el
 * orden de produccion) en vez de enterarse el dia que ya no sirve.
 *
 * Se respeta el FIFO: dentro de un mismo insumo, el lote viejo se consume primero, asi que
 * el segundo lote recien empieza a bajar cuando el primero se acabo.
 *
 * `consumoDiario` es un Map insumoId -> unidades por dia. Un insumo sin consumo registrado
 * no genera aviso: no se sabe el ritmo, y adivinarlo seria inventar.
 */
export function lotesQueVencenConStock({ lotes, consumoDiario, hoy }) {
  const porInsumo = new Map();
  for (const lote of lotes) {
    const lista = porInsumo.get(lote.insumo_id) || [];
    lista.push(lote);
    porInsumo.set(lote.insumo_id, lista);
  }

  const avisos = [];
  for (const [insumoId, lista] of porInsumo) {
    const tasa = Number(consumoDiario.get(insumoId)) || 0;
    if (tasa <= 0) continue;

    // FIFO: se van acumulando los kg que hay por delante de cada lote.
    const orden = [...lista].sort((a, b) => String(a.fecha_ingreso).localeCompare(String(b.fecha_ingreso)));
    let acumulado = 0;
    for (const lote of orden) {
      const restante = Number(lote.cantidad_restante) || 0;
      if (restante <= 0) continue;

      const diasHastaVencer = diasEntre(hoy, lote.fecha_vencimiento);
      // Cuanto de ESTE lote se alcanza a consumir antes de que venza, descontando lo que
      // hay que consumir antes que el.
      const consumibleTotal = tasa * diasHastaVencer;
      const consumibleDeEste = Math.max(0, consumibleTotal - acumulado);
      const sobrante = restante - consumibleDeEste;

      if (sobrante > 0.001 && diasHastaVencer >= 0) {
        avisos.push({
          lote_id: lote.id,
          insumo_id: insumoId,
          insumo_nombre: lote.insumo_nombre,
          unidad: lote.unidad,
          fecha_vencimiento: lote.fecha_vencimiento,
          dias_para_vencer: diasHastaVencer,
          cantidad_restante: redondear(restante),
          sobrara: redondear(sobrante),
        });
      }
      acumulado += restante;
    }
  }

  return avisos.sort((a, b) => a.dias_para_vencer - b.dias_para_vencer);
}

/**
 * Sabores donde el consumo real se aparta de la receta una y otra vez.
 *
 * Una tanda que se pasa es ruido. Cinco tandas seguidas que se pasan un 15% significan una
 * de dos cosas, y las dos importan: o la receta esta desactualizada (y entonces todo el
 * costeo esta mal), o se esta yendo materia prima por algun lado.
 *
 * `filas` son consumos ya cargados: { sabor_id, sabor_nombre, insumo_id, insumo_nombre,
 * cantidad_sugerida, cantidad_real }.
 */
export function desviacionesPersistentes({ filas, minimoTandas = 4, umbralPorciento = 12 }) {
  const grupos = new Map();
  for (const f of filas) {
    const sugerida = Number(f.cantidad_sugerida);
    if (!Number.isFinite(sugerida) || sugerida <= 0) continue; // sin receta no hay con que comparar

    const clave = `${f.sabor_id}:${f.insumo_id}`;
    const grupo = grupos.get(clave) || {
      sabor_id: f.sabor_id,
      sabor_nombre: f.sabor_nombre,
      insumo_id: f.insumo_id,
      insumo_nombre: f.insumo_nombre,
      desviaciones: [],
    };
    grupo.desviaciones.push(((Number(f.cantidad_real) - sugerida) / sugerida) * 100);
    grupos.set(clave, grupo);
  }

  return [...grupos.values()]
    .filter((g) => g.desviaciones.length >= minimoTandas)
    .map((g) => ({
      sabor_id: g.sabor_id,
      sabor_nombre: g.sabor_nombre,
      insumo_id: g.insumo_id,
      insumo_nombre: g.insumo_nombre,
      tandas: g.desviaciones.length,
      desviacion: redondear(mediana(g.desviaciones), 1),
    }))
    .filter((g) => Math.abs(g.desviacion) >= umbralPorciento)
    .sort((a, b) => Math.abs(b.desviacion) - Math.abs(a.desviacion));
}

/** Dias entre dos fechas ISO (negativo si la segunda ya paso). */
export function diasEntre(desde, hasta) {
  const a = new Date(`${desde}T00:00:00`);
  const b = new Date(`${hasta}T00:00:00`);
  return Math.round((b - a) / 86400000);
}

function redondear(n, decimales = 3) {
  const f = 10 ** decimales;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
}
