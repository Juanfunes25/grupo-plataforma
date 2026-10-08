// Portado de italo-reposicion (lib/fechasIngreso.js). Propone el cruce entre los nombres cortos del personal y la planilla de contratos.
/**
 * Cruce entre los nombres CORTOS con que está cargada la gente en la app ("Soriano", "Daisy")
 * y los nombres LEGALES completos de la planilla de contratos ("Jennifer Alejandra Soriano
 * Goff"). De ahí sale la fecha de ingreso de cada uno.
 *
 * No decide nada solo: propone, marca qué tan seguro está, y el dueño confirma antes de que
 * se guarde. Un cruce mal hecho le asigna a alguien la antigüedad de otra persona, y eso
 * termina en una liquidación - es exactamente el tipo de error que no se nota hasta que ya
 * cuesta plata.
 */

/** Sin tildes, sin mayúsculas y sin dobles espacios: "José" y "jose" son la misma persona. */
function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const tokens = (texto) => normalizar(texto).split(' ').filter(Boolean);

/** Distancia de edición: cuántas letras hay que cambiar, meter o sacar para llegar de una
 *  palabra a la otra. */
function distancia(a, b) {
  const fila = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let anterior = fila[0];
    fila[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const diagonal = anterior;
      anterior = fila[j];
      fila[j] = Math.min(
        fila[j] + 1,
        fila[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return fila[b.length];
}

/** 1 = idénticas, 0 = no se parecen en nada. */
function parecido(a, b) {
  if (a === b) return 1;
  const largo = Math.max(a.length, b.length);
  return largo ? 1 - distancia(a, b) / largo : 0;
}

/**
 * Qué tan parecida es una palabra corta a la más parecida del nombre completo.
 *
 * Las mismas personas están escritas distinto en los dos lados: "Daisy" en la app es "Maria
 * DEISY Lopez Reyes" en la planilla, y "Marlen" es "MARELYN Sarahi Andino". A pedido del
 * dueño se aceptan esos parecidos, pero con un piso: por debajo de 0.7 ya no es la misma
 * palabra escrita distinto sino otro nombre ("Jose" contra "Jorge" da 0.6 y queda afuera).
 */
const PARECIDO_MINIMO = 0.7;

function palabrasEnComun(nombreCorto, nombreCompleto) {
  const delCompleto = tokens(nombreCompleto);
  const delCorto = tokens(nombreCorto);
  if (!delCorto.length || !delCompleto.length) return { coinciden: 0, total: 0, exactas: 0 };

  let coinciden = 0;
  let exactas = 0;
  for (const corta of delCorto) {
    const mejor = Math.max(...delCompleto.map((larga) => parecido(corta, larga)));
    if (mejor === 1) exactas += 1;
    if (mejor >= PARECIDO_MINIMO) coinciden += 1;
  }
  return { coinciden, total: delCorto.length, exactas };
}

/**
 * Arma la propuesta: por cada empleado de la app, con qué fila de la planilla lo cruzaría.
 *
 * - 'segura'  : todas las palabras del nombre corto están en el completo, y es el único que
 *               cumple. Viene pre-marcado para guardar.
 * - 'dudosa'  : cruza con más de uno (pasa con los dos "Nicol"), o cruza parcialmente. NO
 *               viene marcado: lo tiene que mirar una persona.
 * - 'sin_match': nadie de la planilla se le parece.
 */
export function proponerCruces({ empleados, planilla }) {
  const candidatosPorEmpleado = empleados.map((e) => {
    const calceLiteral = [];
    const calcePorParecido = [];
    const parciales = [];
    for (const p of planilla) {
      const { coinciden, total, exactas } = palabrasEnComun(e.nombre, p.nombre_completo);
      if (!coinciden) continue;
      if (coinciden < total) parciales.push(p);
      else if (exactas === total) calceLiteral.push(p);
      else calcePorParecido.push(p);
    }

    // Lo escrito igual le gana a lo que solo se parece: "Nicol" es Nicol Alejandra, no
    // Maryury NICOLE Palma. Sin esta regla el parecido ensucia un cruce que era claro.
    const exactos = calceLiteral.length ? calceLiteral : calcePorParecido;
    const porParecido = !calceLiteral.length && calcePorParecido.length > 0;
    return { empleado: e, exactos, parciales, porParecido };
  });

  // Si dos empleados distintos apuntan a la misma fila de la planilla, ninguno de los dos es
  // seguro: uno de los dos se la estaría robando y no hay forma de saber cuál.
  const vecesUsado = new Map();
  for (const c of candidatosPorEmpleado) {
    if (c.exactos.length !== 1) continue;
    const nombre = c.exactos[0].nombre_completo;
    vecesUsado.set(nombre, (vecesUsado.get(nombre) || 0) + 1);
  }

  const cruces = candidatosPorEmpleado.map(({ empleado, exactos, parciales, porParecido }) => {
    const disputado = exactos.length === 1 && vecesUsado.get(exactos[0].nombre_completo) > 1;
    const seguro = exactos.length === 1 && !disputado;
    const opciones = [...exactos, ...parciales];

    return {
      empleado_id: empleado.id,
      nombre_app: empleado.nombre,
      sucursal_nombre: empleado.sucursal_nombre,
      fecha_actual: empleado.fecha_ingreso || null,
      // 'parecida' también viene pre-marcada, pero se muestra aparte: el nombre no está
      // escrito igual en los dos lados y conviene que alguien le pase el ojo.
      estado: seguro ? (porParecido ? 'parecida' : 'segura') : opciones.length ? 'dudosa' : 'sin_match',
      // Sin fecha en la planilla (un reingreso pendiente) tampoco se puede dar por seguro.
      sugerencia: seguro && exactos[0].fecha_ingreso ? exactos[0] : null,
      motivoDuda: disputado
        ? 'Dos empleados de la app calzan con esta misma persona'
        : exactos.length > 1
          ? 'Calza con más de una persona de la planilla'
          : !exactos.length && opciones.length
            ? 'El nombre se parece pero no es igual'
            : seguro && !exactos[0].fecha_ingreso
              ? exactos[0].nota || 'La planilla no trae fecha para esta persona'
              : null,
      opciones: opciones.map((p) => ({
        nombre_completo: p.nombre_completo,
        fecha_ingreso: p.fecha_ingreso,
        grupo: p.grupo,
        cargo: p.cargo,
        nota: p.nota,
      })),
    };
  });

  // Filas de la planilla que no le tocaron a nadie: gente que quizá falte dar de alta.
  const usados = new Set();
  for (const c of cruces) {
    for (const o of c.opciones) usados.add(o.nombre_completo);
  }
  const soloDatos = (p) => ({
    nombre_completo: p.nombre_completo, fecha_ingreso: p.fecha_ingreso, grupo: p.grupo, cargo: p.cargo, nota: p.nota,
  });
  const sinEmpleado = planilla.filter((p) => !usados.has(p.nombre_completo)).map(soloDatos);

  // La planilla entera, para que quien no cruzó con nadie igual se pueda elegir de una lista
  // en vez de tener que tipear la fecha: "Daisy" y "Maria Deisy Lopez Reyes" son la misma
  // persona escrita distinto, y eso lo resuelve un ojo humano en un toque, no un algoritmo.
  return { cruces, sinEmpleado, planilla: planilla.map(soloDatos) };
}
