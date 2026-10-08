// Cálculo de horas y asistencia, portado de italo-reposicion (reporteAsistencia / asistencia).
//
// Las marcaciones llegan sueltas e imperfectas (se olvida la salida, doble entrada, turnos que
// cierran pasada la medianoche). Por eso los turnos se arman recorriendo las marcas en orden
// cronológico —no agrupando por día— y el turno se cuenta en el día en que EMPEZÓ, que es como
// se paga. Un turno sin salida NO se completa inventando una hora: queda "incompleto" y sin horas.
import { TZ_HN, sumarDias } from '@grupo/shared';

export const HORAS_MAX_TURNO = 16;
const redondear = (n, d = 2) => Math.round((Number(n) + Number.EPSILON) * 10 ** d) / 10 ** d;

const fmtFecha = new Intl.DateTimeFormat('en-CA', { timeZone: TZ_HN, year: 'numeric', month: '2-digit', day: '2-digit' });
/** Fecha local (Honduras) de un instante. */
export const fechaLocal = (d) => fmtFecha.format(new Date(d));
/** Minutos desde medianoche, hora de Honduras. */
export function minutosLocal(d) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ_HN, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(d));
  return Number(p.find((x) => x.type === 'hour').value) % 24 * 60 + Number(p.find((x) => x.type === 'minute').value);
}

/** "08:30" o "08:30:00" → 510. null si no es hora. */
export function horaAMinutos(texto) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(texto || ''));
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  return h > 23 || min > 59 ? null : h * 60 + min;
}

/** Turnos de UNA persona a partir de sus marcaciones { tipo, marcada_at, verificacion }. */
export function turnosDeMarcaciones(marcaciones) {
  const orden = [...marcaciones].sort((a, b) => new Date(a.marcada_at) - new Date(b.marcada_at));
  const turnos = [];
  let abierta = null;
  const cerrar = (salida) => {
    const ini = new Date(abierta.marcada_at), fin = salida ? new Date(salida.marcada_at) : null;
    let horas = fin ? (fin - ini) / 3_600_000 : null;
    let incompleto = !salida;
    if (horas !== null && horas > HORAS_MAX_TURNO) { horas = null; incompleto = true; salida = null; }
    turnos.push({
      fecha: fechaLocal(ini), entrada: ini.toISOString(), salida: salida ? new Date(salida.marcada_at).toISOString() : null,
      horas: horas === null ? null : redondear(horas), incompleto,
      verificacion_entrada: abierta.verificacion ?? null, distancia_entrada: abierta.distancia_metros ?? null,
      lejos: abierta.verificacion === 'lejos' || salida?.verificacion === 'lejos',
    });
    abierta = null;
  };
  for (const m of orden) {
    if (m.tipo === 'entrada') { if (abierta) cerrar(null); abierta = m; }
    else if (abierta) cerrar(m);
    else turnos.push({ fecha: fechaLocal(m.marcada_at), entrada: null, salida: new Date(m.marcada_at).toISOString(), horas: null, incompleto: true, verificacion_entrada: null, distancia_entrada: null, lejos: m.verificacion === 'lejos' });
  }
  if (abierta) cerrar(null);
  return turnos;
}

/**
 * Reporte del período listo para pagar. `empleados`: { id, nombres, apellidos, sucursal, … };
 * `marcaciones`: las del rango (traer hasta UN DÍA DESPUÉS de `hasta` para cerrar turnos nocturnos).
 * Solo cuentan los turnos que EMPEZARON dentro de [desde, hasta].
 */
export function armarReporte({ empleados, marcaciones, desde, hasta }) {
  const por = new Map();
  for (const m of marcaciones) { if (!por.has(m.empleado_id)) por.set(m.empleado_id, []); por.get(m.empleado_id).push(m); }
  const filas = empleados.map((e) => {
    const turnos = turnosDeMarcaciones(por.get(e.id) ?? []).filter((t) => t.fecha >= desde && t.fecha <= hasta);
    const completos = turnos.filter((t) => t.horas !== null);
    return {
      ...e, turnos,
      dias_trabajados: new Set(turnos.map((t) => t.fecha)).size,
      turnos_incompletos: turnos.filter((t) => t.incompleto).length,
      marcaciones_lejos: turnos.filter((t) => t.lejos).length,
      total_horas: redondear(completos.reduce((s, t) => s + t.horas, 0)),
    };
  });
  return filas.sort((a, b) => b.total_horas - a.total_horas || String(a.nombres).localeCompare(String(b.nombres)));
}

/** Quincena (1–15 / 16–fin de mes) que contiene la fecha. */
export function quincenaDe(fecha) {
  const [y, m, d] = fecha.split('-').map(Number);
  const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return d <= 15 ? { desde: `${y}-${mm}-01`, hasta: `${y}-${mm}-15` } : { desde: `${y}-${mm}-16`, hasta: `${y}-${mm}-${String(ultimo).padStart(2, '0')}` };
}

// ── Ubicación (geocerca) ────────────────────────────────────────────────────
export function distanciaMetros(lat1, lon1, lat2, lon2) {
  const rad = (g) => (g * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(a)));
}
/**
 * Veredicto de una marcación. NUNCA bloquea: una marcación lejana se guarda igual, señalada,
 * porque un registro sospechoso sirve para revisar y uno rechazado no deja rastro.
 *  dentro · lejos · sin_ubicacion (el celular no dio GPS) · sin_configurar (la tienda no tiene coordenadas)
 */
export function verificarUbicacion({ geo, lat, lon }) {
  const tiene = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
  if (!geo || !tiene(geo.lat) || !tiene(geo.lon)) return { verificacion: 'sin_configurar', distancia_metros: null };
  if (!tiene(lat) || !tiene(lon)) return { verificacion: 'sin_ubicacion', distancia_metros: null };
  const d = distanciaMetros(Number(geo.lat), Number(geo.lon), Number(lat), Number(lon));
  return { verificacion: d <= (Number(geo.radio_metros) || 150) ? 'dentro' : 'lejos', distancia_metros: Math.round(d) };
}

/**
 * Asistencia día por día de un empleado: cruza el horario semanal con lo marcado.
 *  horarios: [{ dia_semana (0=domingo), estado, entrada, salida }]
 *  tolerancia: minutos de gracia antes de contar llegada tarde.
 */
export function asistenciaDiaria({ desde, hasta, marcaciones, horarios, ausencias = [], vacaciones = [], tolerancia = 10 }) {
  const turnos = turnosDeMarcaciones(marcaciones);
  const porDia = new Map();
  for (const t of turnos) { if (!porDia.has(t.fecha)) porDia.set(t.fecha, []); porDia.get(t.fecha).push(t); }
  const hor = new Map(horarios.map((h) => [h.dia_semana, h]));
  const dias = [];
  for (let f = desde; f <= hasta; f = sumarDias(f, 1)) {
    const [y, m, d] = f.split('-').map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const h = hor.get(dow) ?? null;
    const ts = porDia.get(f) ?? [];
    const aus = ausencias.find((a) => a.estado !== 'rechazada' && a.desde <= f && a.hasta >= f && a.tipo !== 'tardanza');
    const vac = vacaciones.find((v) => (v.estado === 'aprobada' || v.estado === 'tomada') && v.desde <= f && v.hasta >= f);
    const horas = redondear(ts.reduce((s, t) => s + (t.horas ?? 0), 0));
    let tarde = 0;
    if (ts[0]?.entrada && h?.estado === 'turno' && h.entrada) tarde = Math.max(0, minutosLocal(ts[0].entrada) - horaAMinutos(h.entrada) - tolerancia);
    let situacion;
    if (ts.length) situacion = ts.some((t) => t.incompleto) ? 'incompleto' : tarde > 0 ? 'tarde' : 'presente';
    else if (vac) situacion = 'vacaciones';
    else if (aus) situacion = aus.tipo;
    else if (h?.estado === 'turno' && f < fechaLocal(new Date())) situacion = 'sin_marcar';
    else situacion = h?.estado === 'turno' ? 'pendiente' : (h?.estado ?? 'sin_horario');
    dias.push({ fecha: f, dia_semana: dow, horario: h && h.estado === 'turno' ? `${String(h.entrada).slice(0, 5)}–${String(h.salida).slice(0, 5)}` : (h?.estado ?? null), horas, entrada: ts[0]?.entrada ?? null, salida: ts.at(-1)?.salida ?? null, tarde_min: tarde, situacion });
  }
  return {
    dias,
    totales: {
      horas: redondear(dias.reduce((s, x) => s + x.horas, 0)),
      dias_trabajados: dias.filter((x) => x.horas > 0 || x.entrada).length,
      tardanzas: dias.filter((x) => x.tarde_min > 0).length,
      minutos_tarde: dias.reduce((s, x) => s + x.tarde_min, 0),
      sin_marcar: dias.filter((x) => x.situacion === 'sin_marcar').length,
      incompletos: dias.filter((x) => x.situacion === 'incompleto').length,
    },
  };
}
