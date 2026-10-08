import {
  GRAVEDAD, NIVEL, compuerta, crearHallazgo, diasDistintos, diasEntre, fechaCorta, kg, mediana, nivelSegunCompuertas,
  plural, redondear, resultado, sinDatos, sumarDias, agruparPor, suma,
} from '../nucleo.js';

const AREA = 'fabrica';
const nombreSabor = (datos, id) => datos.sabores.find((s) => s.id === id)?.nombre || `sabor ${id}`;

const BASE_RECETA = {
  id: 'desviacion_receta',
  nombre: 'Se gasta distinto de lo que dice la receta',
  area: AREA,
};

/**
 * Si una tanda se pasa de la receta, es ruido. Si CINCO tandas seguidas se pasan, algo es
 * distinto de lo que el sistema cree: o la receta quedó vieja (y entonces todo el costeo está
 * mal), o la materia prima se está yendo por algún lado.
 *
 * Para decir eso sin equivocarse se piden tres cosas: varias tandas, que la desviación vaya
 * casi siempre para el mismo lado (si unas veces sobra y otras falta, es variación normal), y
 * que sea más grande que lo que se explica por pesar a ojo.
 *
 * Y si el MISMO insumo se desvía en más de un sabor, el problema casi seguro no está en las
 * recetas sino en ese insumo (una unidad mal cargada, un envase de otro peso).
 */
export function desviacionReceta(datos) {
  const filas = datos.consumos.filter((c) => Number(c.cantidad_sugerida) > 0);
  if (!filas.length) return sinDatos(BASE_RECETA, 'Todavía no hay tandas con receta y consumo real registrado para comparar.');

  const grupos = agruparPor(filas, (c) => `${c.sabor_id}|${c.insumo_id}`);
  const candidatos = [];
  let ruido = 0;
  let evaluados = 0;

  for (const lista of grupos.values()) {
    if (lista.length < 4) continue;
    evaluados += 1;
    const desviaciones = lista.map((c) => ((Number(c.cantidad_real) - Number(c.cantidad_sugerida)) / Number(c.cantidad_sugerida)) * 100);
    const tipica = mediana(desviaciones);
    if (Math.abs(tipica) < 12) continue;
    const mismoLado = desviaciones.filter((d) => Math.sign(d) === Math.sign(tipica)).length / desviaciones.length;
    if (mismoLado < 0.8) {
      ruido += 1;
      continue;
    }
    candidatos.push({
      sabor_id: lista[0].sabor_id,
      insumo_id: lista[0].insumo_id,
      insumo_nombre: lista[0].insumo_nombre,
      tandas: lista.length,
      tipica,
      mismoLado,
    });
  }

  const hallazgos = [];
  const porInsumo = agruparPor(candidatos, (c) => c.insumo_id);
  for (const c of candidatos) {
    const otrosSabores = (porInsumo.get(c.insumo_id) || []).filter(
      (o) => o.sabor_id !== c.sabor_id && Math.sign(o.tipica) === Math.sign(c.tipica)
    ).length;
    const compuertas = [
      compuerta(`${c.tandas} tandas comparadas`, c.tandas >= 4),
      compuerta(`La desviación típica es de ${redondear(Math.abs(c.tipica), 0)}%, más de lo que se explica a ojo`, Math.abs(c.tipica) >= 12),
      compuerta(`${redondear(c.mismoLado * 100, 0)}% de las tandas se desvían para el mismo lado`, c.mismoLado >= 0.8),
      compuerta('El mismo insumo también se desvía en otro sabor', otrosSabores > 0, { requerida: false }),
    ];
    const nivel = nivelSegunCompuertas(compuertas);
    if (!nivel) continue;
    const usaMas = c.tipica > 0;
    hallazgos.push(crearHallazgo({
      verificacion: BASE_RECETA.id,
      area: AREA,
      clave: `${c.sabor_id}:${c.insumo_id}`,
      titulo: `${nombreSabor(datos, c.sabor_id)}: se usa ${usaMas ? 'más' : 'menos'} ${c.insumo_nombre} de lo que dice la receta`,
      detalle: `En ${c.tandas} tandas el consumo real fue ${redondear(Math.abs(c.tipica), 0)}% ${usaMas ? 'mayor' : 'menor'} al de la receta, casi siempre para el mismo lado.`,
      gravedad: Math.abs(c.tipica) >= 25 ? GRAVEDAD.ALTA : GRAVEDAD.MEDIA,
      nivel,
      evidencia: [`Mediana de ${c.tandas} tandas: ${c.tipica > 0 ? '+' : ''}${redondear(c.tipica, 0)}% contra la receta`],
      compuertas,
      descartado: ['No es variación normal: no cae para los dos lados, casi siempre va hacia el mismo.'],
      accion: otrosSabores > 0
        ? 'Como el mismo insumo se desvía en varios sabores, revisá ese insumo: unidad, peso del envase o cómo se mide, antes de tocar las recetas.'
        : usaMas
          ? 'O la receta quedó desactualizada (y el costeo subestima el costo real) o se está yendo materia prima. Pesá una tanda completa para confirmarlo.'
          : 'Revisá si se está omitiendo el ingrediente o si la receta pide de más; el costeo está sobrestimado.',
      sucursal_id: null,
    }));
  }

  return resultado(BASE_RECETA, {
    hallazgos,
    ruido,
    revisado: `${evaluados} combinaciones sabor-insumo con 4 tandas o más`,
  });
}

// ──────────────────────────────────────────────────────────────────────────────────────────

const BASE_CAMARA = {
  id: 'camara_envejecida',
  nombre: 'Gelato que lleva demasiado en cámara',
  area: AREA,
};

const DIAS_CAMARA_REVISAR = 21;

/**
 * Tandas viejas que según el sistema todavía tienen producto. Hay solo dos posibilidades y las
 * dos importan: o ese gelato sigue ahí y se está poniendo viejo, o ya no está y el stock del
 * sistema está inflado (y entonces el plan de producción cree que hay de más).
 *
 * El sistema no puede saber cuál es. Por eso queda como PROBABLE y la acción es mirar la cámara.
 */
export function camaraEnvejecida(datos) {
  const conSaldo = datos.producciones.filter((p) => Number(p.kg_restante) > 0);
  if (!datos.producciones.length) return sinDatos(BASE_CAMARA, 'No hay producciones registradas.');

  const viejas = conSaldo.filter((p) => {
    const edad = diasEntre(p.fecha, datos.hoy);
    return edad >= DIAS_CAMARA_REVISAR && Number(p.kg_restante) >= 1 && Number(p.kg_restante) >= 0.25 * Number(p.kg);
  });
  const hallazgos = [];

  for (const [saborId, lista] of agruparPor(viejas, (p) => p.sabor_id)) {
    const total = suma(lista.map((p) => p.kg_restante));
    const masVieja = Math.max(...lista.map((p) => diasEntre(p.fecha, datos.hoy)));
    const compuertas = [
      compuerta(`La tanda más vieja tiene ${masVieja} días (el límite a revisar es ${DIAS_CAMARA_REVISAR})`, masVieja >= DIAS_CAMARA_REVISAR),
      compuerta(`El sistema dice que quedan ${redondear(total, 1)} kg`, total >= 1),
      compuerta('Es al menos el 25% de lo que se produjo en esa tanda', true),
    ];
    hallazgos.push(crearHallazgo({
      verificacion: BASE_CAMARA.id,
      area: AREA,
      clave: String(saborId),
      titulo: `${nombreSabor(datos, saborId)}: ${redondear(total, 1)} kg que llevan ${masVieja} días en cámara`,
      detalle: 'Según el sistema todavía queda producto de tandas de hace más de tres semanas.',
      gravedad: masVieja >= 35 || total >= 10 ? GRAVEDAD.ALTA : GRAVEDAD.MEDIA,
      nivel: NIVEL.PROBABLE,
      evidencia: lista.slice(0, 4).map((p) => `Lote ${p.lote}: quedan ${redondear(p.kg_restante, 1)} kg de ${redondear(p.kg, 1)} kg (hace ${diasEntre(p.fecha, datos.hoy)} días)`),
      compuertas,
      descartado: ['No es un saldo de tandas recientes: todas tienen más de tres semanas.'],
      accion: 'Mirá la cámara. Si el gelato está, hay que sacarlo antes de que se ponga viejo; si no está, hay que corregir el saldo: el plan de producción está contando con él.',
      impacto: `${kg(total * 1000)} kg posiblemente viejos`,
    }));
  }

  return resultado(BASE_CAMARA, {
    hallazgos,
    revisado: `${conSaldo.length} ${plural(conSaldo.length, 'tanda con saldo', 'tandas con saldo')} en cámara`,
  });
}

// ──────────────────────────────────────────────────────────────────────────────────────────

const BASE_SIN_CONSUMO = {
  id: 'produccion_sin_consumo',
  nombre: 'Tandas sin materia prima registrada',
  area: AREA,
};

/**
 * Cuando casi todas las tandas registran qué materia prima se usó, las que no lo hacen son un
 * agujero: el stock de insumos no baja y el costo de esa tanda no existe. Solo se audita si
 * la práctica está en uso; si nadie lo registra, no hay nada que comparar.
 */
export function produccionSinConsumo(datos) {
  const desde = sumarDias(datos.hoy, -30);
  const tandas = datos.producciones.filter((p) => p.fecha >= desde && p.fecha < datos.hoy);
  if (tandas.length < 6) return sinDatos(BASE_SIN_CONSUMO, 'Hay muy pocas tandas en los últimos 30 días.');

  const conConsumo = new Set(datos.consumos.map((c) => c.produccion_id));
  const cobertura = tandas.filter((p) => conConsumo.has(p.id)).length / tandas.length;
  if (cobertura < 0.5) {
    return sinDatos(BASE_SIN_CONSUMO, `Solo el ${redondear(cobertura * 100, 0)}% de las tandas registra su consumo: la práctica todavía no está en uso como para auditarla.`);
  }

  const huecos = tandas.filter((p) => !conConsumo.has(p.id));
  const fechas = diasDistintos(huecos.map((p) => p.fecha));
  const compuertas = [
    compuerta(`${huecos.length} tandas sin consumo, en ${fechas} fechas distintas`, huecos.length >= 3 && fechas >= 3),
    compuerta(`El resto sí lo registra (${redondear(cobertura * 100, 0)}% de las tandas)`, true),
  ];
  const nivel = nivelSegunCompuertas(compuertas);
  if (!nivel) return resultado(BASE_SIN_CONSUMO, { revisado: `${tandas.length} tandas`, ruido: huecos.length });

  const kgSin = suma(huecos.map((p) => p.kg));
  return resultado(BASE_SIN_CONSUMO, {
    revisado: `${tandas.length} tandas de los últimos 30 días`,
    hallazgos: [crearHallazgo({
      verificacion: BASE_SIN_CONSUMO.id,
      area: AREA,
      clave: 'global',
      titulo: `${huecos.length} tandas no registraron qué materia prima usaron`,
      detalle: 'La mayoría de las tandas sí lo anota, pero estas no: el stock de insumos no bajó y su costo quedó sin calcular.',
      gravedad: GRAVEDAD.MEDIA,
      nivel,
      evidencia: huecos.slice(-4).map((p) => `${fechaCorta(p.fecha)} · ${nombreSabor(datos, p.sabor_id)}: ${redondear(p.kg, 1)} kg${p.operario ? ` (${p.operario})` : ''}`),
      compuertas,
      descartado: ['No es que nadie lo haga: el resto de las tandas sí lo registra.'],
      accion: 'Cargá el consumo de esas tandas y recordale al equipo que se registra siempre. Sin eso, el inventario de materia prima se va inflando.',
      impacto: `${redondear(kgSin, 1)} kg de gelato sin costo calculado`,
    })],
  });
}

export const VERIFICACIONES_FABRICA = [desviacionReceta, camaraEnvejecida, produccionSinConsumo];
