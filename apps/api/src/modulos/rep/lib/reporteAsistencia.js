/**
 * Horas trabajadas por persona, para pagar la quincena.
 *
 * El problema real no es sumar: es que las marcaciones vienen sueltas y en el mundo real
 * salen imperfectas. Alguien marca entrada y se olvida la salida; alguien marca dos
 * entradas seguidas; un turno que cierra a las 11 de la noche puede tener la salida ya
 * pasada la medianoche, o sea con OTRA fecha.
 *
 * Por eso los turnos se arman recorriendo las marcaciones en orden cronológico y no
 * agrupando por día: una entrada se cierra con la primera salida que venga después, aunque
 * caiga al día siguiente. El turno se cuenta en el día en que EMPEZÓ, que es como se paga.
 *
 * Un turno sin salida NO se completa inventando una hora: se devuelve marcado como
 * incompleto y sin horas. Poner ahí un número inventado sería pagar de más o de menos, y
 * nadie se enteraría.
 */

// Más que esto no es un turno: es una salida que nadie marcó y una entrada del día
// siguiente que se emparejó por error. Se corta y se reporta como incompleto.
const HORAS_MAXIMAS_TURNO = 16;

/** "2026-08-25 14:30:00" (que SQLite guarda en UTC) -> Date. */
function deSQL(texto) {
  if (!texto) return null;
  const iso = String(texto).includes('T') ? texto : `${String(texto).replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function redondear(n, decimales = 2) {
  const f = 10 ** decimales;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
}

/**
 * Arma los turnos de una persona a partir de sus marcaciones ordenadas por hora.
 *
 * `marcaciones`: { tipo, creado_en, fecha, verificacion, distancia_metros }.
 */
export function turnosDeMarcaciones(marcaciones) {
  const orden = [...marcaciones].sort((a, b) => String(a.creado_en).localeCompare(String(b.creado_en)));
  const turnos = [];
  let abierta = null;

  const cerrar = (salida) => {
    const inicio = deSQL(abierta.creado_en);
    const fin = salida ? deSQL(salida.creado_en) : null;
    let horas = inicio && fin ? (fin - inicio) / 3600000 : null;
    let incompleto = !salida;

    // Un "turno" de más de 16 horas casi siempre es una salida que no se marcó.
    if (horas !== null && horas > HORAS_MAXIMAS_TURNO) {
      horas = null;
      incompleto = true;
      salida = null;
    }

    turnos.push({
      fecha: abierta.fecha,
      entrada: abierta.creado_en,
      salida: salida ? salida.creado_en : null,
      horas: horas === null ? null : redondear(horas),
      incompleto,
      verificacion_entrada: abierta.verificacion,
      distancia_entrada: abierta.distancia_metros ?? null,
      lejos: abierta.verificacion === 'lejos' || salida?.verificacion === 'lejos',
    });
    abierta = null;
  };

  for (const m of orden) {
    if (m.tipo === 'entrada') {
      // Dos entradas seguidas: la primera quedó sin cerrar. Se reporta así en vez de
      // descartarla en silencio.
      if (abierta) cerrar(null);
      abierta = m;
    } else if (m.tipo === 'salida') {
      if (abierta) cerrar(m);
      else {
        // Salida sin entrada: alguien no marcó al llegar. También se reporta.
        turnos.push({
          fecha: m.fecha,
          entrada: null,
          salida: m.creado_en,
          horas: null,
          incompleto: true,
          verificacion_entrada: null,
          distancia_entrada: null,
          lejos: m.verificacion === 'lejos',
        });
      }
    }
  }
  if (abierta) cerrar(null);

  return turnos;
}

/**
 * El reporte completo del período, listo para pagar.
 *
 * `empleados`: { id, nombre, sucursal_id, sucursal_nombre }.
 * `marcaciones`: todas las del rango, con empleado_id.
 */
export function armarReporte({ empleados, marcaciones }) {
  const porEmpleado = new Map();
  for (const m of marcaciones) {
    const lista = porEmpleado.get(Number(m.empleado_id)) || [];
    lista.push(m);
    porEmpleado.set(Number(m.empleado_id), lista);
  }

  const filas = empleados.map((e) => {
    const turnos = turnosDeMarcaciones(porEmpleado.get(Number(e.id)) || []);
    const completos = turnos.filter((t) => t.horas !== null);
    return {
      empleado_id: e.id,
      nombre: e.nombre,
      sucursal_id: e.sucursal_id,
      sucursal_nombre: e.sucursal_nombre,
      turnos,
      dias_trabajados: new Set(turnos.map((t) => t.fecha)).size,
      turnos_incompletos: turnos.filter((t) => t.incompleto).length,
      marcaciones_lejos: turnos.filter((t) => t.lejos).length,
      total_horas: redondear(completos.reduce((acc, t) => acc + t.horas, 0)),
    };
  });

  // Los que trabajaron primero; los que no aparecen en el período van al final.
  return filas.sort((a, b) => b.total_horas - a.total_horas || a.nombre.localeCompare(b.nombre));
}

/**
 * Los dos períodos de pago del mes que contiene `fecha`: del 1 al 15, y del 16 al último día.
 * Sirve para que la pantalla arranque con la quincena en curso ya elegida.
 */
export function quincenaDe(fechaISO) {
  const [anio, mes, dia] = String(fechaISO).split('-').map(Number);
  const ultimoDia = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  const dd = (n) => String(n).padStart(2, '0');
  const mm = dd(mes);
  return Number(dia) <= 15
    ? { desde: `${anio}-${mm}-01`, hasta: `${anio}-${mm}-15` }
    : { desde: `${anio}-${mm}-16`, hasta: `${anio}-${mm}-${dd(ultimoDia)}` };
}
