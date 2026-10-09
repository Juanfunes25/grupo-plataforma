// Cálculo de la planilla, con el flujo de la hoja del dueño («ITALO 2026»):
//   TOTAL QUINCENAL = DIAS × SALARIO DIARIO · POR HORA = salario diario ÷ horas de la jornada
//   TOTAL HX = HORAS EXTRAS × POR HORA (× recargo, hoy 0 %) · TOTAL = total quincenal + total HX + otros − deducciones
//   Aguinaldo/catorceavo = DIAS × SALARIO DIARIO, con DIAS = 30 y proporcional por antigüedad.
// Funciones puras (sin base de datos) para probarlas con casos conocidos. NINGÚN porcentaje de ley es definitivo:
// vienen de plan.parametros, que el contador debe validar; IHSS/RAP/INFOP/ISR por porcentaje están apagados
// (aplicar_ley = 0) y la hoja usa líneas de deducción manuales.
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIA = 86400000;

const aMs = (iso) => Date.parse(`${iso}T00:00:00Z`);
export const diasEntre = (a, b) => Math.round((aMs(b) - aMs(a)) / DIA) + 1;               // inclusivos
export const sumarDiasISO = (iso, n) => new Date(aMs(iso) + n * DIA).toISOString().slice(0, 10);
export const diaSemanaISO = (iso) => ((new Date(aMs(iso)).getUTCDay() + 6) % 7) + 1;      // 1 lunes … 7 domingo
const maxF = (a, b) => (a > b ? a : b);
const minF = (a, b) => (a < b ? a : b);
/** Días calendario que comparten dos rangos de fechas (0 si no se tocan). */
export function solape(d1, h1, d2, h2) {
  const d = maxF(d1, d2), h = minF(h1, h2);
  return h < d ? 0 : diasEntre(d, h);
}
const ultimoDia = (anio, mes) => new Date(Date.UTC(anio, mes, 0)).getUTCDate();
const pad = (n) => String(n).padStart(2, '0');
const fmt = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

export const PERIODICIDADES = { semanal: 'Semanal', quincena: 'Quincenal', mensual: 'Mensual' };
/** Fracción del sueldo mensual que corresponde a una periodicidad (para deducciones fijas y límites de ley). */
export const FRACCION = { semanal: 12 / 52, quincena: 0.5, mensual: 1, aguinaldo: 1, catorceavo: 1 };

/** Convierte las filas de plan.parametros a un objeto { clave: valor }. */
export const mapaParametros = (filas) => Object.fromEntries(filas.map((p) => [p.clave, Number(p.valor)]));

/**
 * Fechas y forma de pago del periodo. spec: { tipo, anio, mes, quincena, desde } (desde = primer día de la semana, solo semanal).
 * Devuelve { error } si la semana no empieza en el día configurado.
 */
export function periodoDe(spec, P) {
  const { tipo, anio, mes, quincena } = spec;
  if (tipo === 'semanal') {
    const dia = Math.round(P.semana_inicio_dia || 1);
    if (diaSemanaISO(spec.desde) !== dia) return { error: `La semana debe empezar en ${['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'][dia - 1]} (así está configurado)` };
    const hasta = sumarDiasISO(spec.desde, 6);
    return { desde: spec.desde, hasta, etiqueta: `Semana del ${fmt(spec.desde)} al ${fmt(hasta)} de ${MESES[Number(hasta.slice(5, 7)) - 1]} ${hasta.slice(0, 4)}`, fraccion: FRACCION.semanal, diasBase: P.semana_dias_pago,
      pago: sumarDiasISO(spec.desde, (((Math.round(P.semana_dia_pago || 6) - dia) % 7) + 7) % 7) };
  }
  if (tipo === 'quincena' || tipo === 'mensual') {
    const ult = ultimoDia(anio, mes);
    const nombreMes = `${MESES[mes - 1]} ${anio}`;
    if (tipo === 'mensual') return { desde: `${anio}-${pad(mes)}-01`, hasta: `${anio}-${pad(mes)}-${pad(ult)}`, etiqueta: `Mensual · ${nombreMes}`, fraccion: 1, diasBase: P.dias_mes, pago: `${anio}-${pad(mes)}-${pad(ult)}` };
    return quincena === 1
      ? { desde: `${anio}-${pad(mes)}-01`, hasta: `${anio}-${pad(mes)}-15`, etiqueta: `Salarios del 1-15 de ${nombreMes}`, fraccion: 0.5, diasBase: P.quincena_dias, pago: `${anio}-${pad(mes)}-15` }
      : { desde: `${anio}-${pad(mes)}-16`, hasta: `${anio}-${pad(mes)}-${pad(ult)}`, etiqueta: `Salarios del 16-${ult} de ${nombreMes}`, fraccion: 0.5, diasBase: P.quincena_dias, pago: `${anio}-${pad(mes)}-${pad(ult)}` };
  }
  if (tipo === 'aguinaldo') {
    return { desde: `${anio}-01-01`, hasta: `${anio}-12-31`, etiqueta: `Aguinaldo (décimo tercer mes) ${anio}`, fraccion: 1, diasBase: P.decimos_dias_base,
      pago: `${anio}-${pad(P.aguinaldo_mes_pago)}-${pad(Math.min(P.aguinaldo_dia_pago, ultimoDia(anio, P.aguinaldo_mes_pago)))}` };
  }
  return { desde: `${anio - 1}-07-01`, hasta: `${anio}-06-30`, etiqueta: `Catorceavo mes ${anio}`, fraccion: 1, diasBase: P.decimos_dias_base,
    pago: `${anio}-${pad(P.catorceavo_mes_pago)}-${pad(Math.min(P.catorceavo_dia_pago, ultimoDia(anio, P.catorceavo_mes_pago)))}` };
}

/** ISR anual con la tabla progresiva: cada tramo grava solo la parte de la renta que cae dentro de él. */
export function impuestoAnual(base, tramos) {
  const t = [...tramos].sort((a, b) => a.desde - b.desde);
  let total = 0;
  for (let i = 0; i < t.length; i++) {
    // un tramo escrito «desde 217,493.17» empieza justo después de 217,493.16: así no quedan centavos sin gravar
    const piso = i === 0 ? 0 : Math.max(0, Number(t[i].desde) - 0.01);
    const techo = i + 1 < t.length ? Math.max(0, Number(t[i + 1].desde) - 0.01) : Infinity;
    total += Math.max(0, Math.min(base, techo) - piso) * (Number(t[i].tasa) / 100);
  }
  return r2(total);
}

const horasDiaDe = (jornada, P) => (jornada === 'nocturna' ? P.horas_dia_nocturna : jornada === 'mixta' ? P.horas_dia_mixta : P.horas_dia_diurna);

/** Salario diario del perfil (null si no se puede). Mensual ÷ días del mes; por hora × horas de la jornada. */
export function salarioDiarioDe(emp, P) {
  const m = Number(emp.salario_mensual);
  if (Number.isFinite(m) && m > 0) return r2(m / P.dias_mes);
  const h = Number(emp.salario_hora);
  if (h > 0) return r2(h * horasDiaDe(emp.jornada, P));
  return null;
}

/** Deducciones por porcentaje de ley (APAGADAS por defecto). Devuelve líneas + aportes patronales. */
export function deduccionesLey(base, fraccion, P, tramos) {
  const baseIhss = Math.min(base, P.ihss_techo_mensual * fraccion);
  const ihss = r2(baseIhss * ((P.ihss_em_empleado_pct + P.ihss_ivm_empleado_pct) / 100));
  const baseRap = Math.max(0, base - P.rap_exento_mensual * fraccion);
  const rap = r2(baseRap * (P.rap_empleado_pct / 100));
  const infop = r2(base * (P.infop_empleado_pct / 100));
  const anual = (base / fraccion) * 12;
  const gravable = Math.max(0, anual - (P.isr_gastos_medicos + (P.isr_deduce_ihss ? ((ihss + rap) / fraccion) * 12 : 0)));
  const isr = r2((impuestoAnual(gravable, tramos) / 12) * fraccion);
  const lineas = [['IHSS', ihss], ['RAP', rap], ['INFOP', infop], ['ISR retenido', isr]].filter(([, m]) => m > 0).map(([concepto, monto]) => ({ concepto, monto, tipo: 'ley' }));
  const patronales = r2(baseIhss * ((P.ihss_em_patrono_pct + P.ihss_ivm_patrono_pct) / 100) + baseRap * (P.rap_patrono_pct / 100) + base * (P.infop_patrono_pct / 100));
  return { lineas, patronales };
}

/** Recalcula lo derivado de un renglón a partir de lo que se puede editar (dias, diario, horas, total HX, otros, deducciones). */
export function recalcularRenglon(l) {
  const ded = (l.deducciones ?? []).map((d) => ({ ...d, monto: r2(d.monto) }));
  const total_quincenal = r2(Number(l.dias) * Number(l.salario_diario));
  const total_deducciones = r2(ded.reduce((s, d) => s + d.monto, 0));
  const total = r2(total_quincenal + Number(l.total_hx) + Number(l.otros_ingresos) - total_deducciones);
  return { ...l, deducciones: ded, total_quincenal, total_deducciones, total };
}

/**
 * Pre-llena UN renglón de la hoja desde RRHH.
 *   emp: fila de rrhh.empleados (+ nombres, cuenta, banco) · P: parámetros · periodo: salida de periodoDe()
 *   novedades: [{tipo, horas, monto, concepto}] · ausencias SIN goce: [{tipo, desde, hasta, dias, minutos}] · vacaciones: [{desde, hasta, dias}]
 *   suspensiones sin goce: [{desde, hasta}] · fijas: [{concepto, monto_mensual}] · horasSugeridas: horas extra que salen del reporte de horas
 * Devuelve { linea, avisos } o { omitido }.
 */
export function armarLinea({ tipo, emp, P, tramos = [], periodo, novedades = [], ausencias = [], vacaciones = [], suspensiones = [], fijas = [], horasSugeridas = 0 }) {
  const avisos = [];
  const diario = salarioDiarioDe(emp, P);
  if (!diario) return { omitido: 'sin salario registrado' };
  const ini = maxF(periodo.desde, emp.fecha_ingreso ?? periodo.desde);
  const fin = minF(periodo.hasta, emp.fecha_salida ?? periodo.hasta);
  if (fin < ini) return { omitido: 'no estaba contratado en el periodo' };
  if (P.salario_minimo_diario > 0 && diario < P.salario_minimo_diario) avisos.push(`Su salario diario (${diario}) está por debajo del mínimo de referencia (${P.salario_minimo_diario}).`);

  const base = {
    empleado_id: emp.id, sucursal_id: emp.sucursal_id ?? null, sucursal: emp.sucursal ?? null,
    nombre: `${emp.nombres} ${emp.apellidos ?? ''}`.trim(), identidad: emp.identidad ?? null, puesto: emp.puesto ?? null,
    banco: emp.banco ?? null, cuenta: emp.cuenta_bancaria ?? null, salario_diario: diario,
  };
  if (!base.cuenta) avisos.push('No tiene número de cuenta en su perfil.');

  // ── Aguinaldo y catorceavo: DIAS × salario diario, proporcional por antigüedad ──
  if (tipo === 'aguinaldo' || tipo === 'catorceavo') {
    if (!emp.fecha_ingreso) avisos.push('No tiene fecha de ingreso: se calculó el año completo. Revísalo antes de aprobar.');
    const trabajados = diasEntre(ini, fin);
    const dias = r2(Math.min(P.decimos_dias_pago, (P.decimos_dias_pago * trabajados) / P.decimos_dias_base));
    return {
      linea: recalcularRenglon({ ...base, dias, por_hora: 0, horas_extra: 0, total_hx: 0, otros_ingresos: 0, deducciones: [], aportes_patronales: 0,
        observaciones: dias < P.decimos_dias_pago ? `Proporcional: ${trabajados} días trabajados` : '', detalle: { dias_trabajados: trabajados } }),
      avisos,
    };
  }

  // ── Semana / quincena / mes ──
  const valorHora = diario / horasDiaDe(emp.jornada, P);
  const total = diasEntre(periodo.desde, periodo.hasta);
  const cubiertos = diasEntre(ini, fin);
  const diasBase = periodo.diasBase;
  let dias = cubiertos >= total ? diasBase : Math.min(diasBase, cubiertos);
  const obs = [];
  if (cubiertos < total) obs.push(emp.fecha_ingreso && emp.fecha_ingreso > periodo.desde ? 'Empleado nuevo' : 'Salió en el periodo');

  let sinGoce = 0, minutosTarde = 0;
  for (const a of ausencias) {
    const comp = solape(a.desde, a.hasta, periodo.desde, periodo.hasta);
    if (!comp) continue;
    if (a.tipo === 'tardanza') { minutosTarde += Number(a.minutos) || 0; continue; }
    sinGoce += Number(a.dias) * (comp / diasEntre(a.desde, a.hasta));
  }
  for (const s of suspensiones) sinGoce += solape(s.desde, s.hasta, periodo.desde, periodo.hasta);
  sinGoce = Math.round(sinGoce * 100) / 100;
  if (sinGoce > 0) { dias = Math.max(0, r2(dias - sinGoce)); obs.push(`${sinGoce} día(s) sin goce`); }

  let vacDias = 0;
  for (const v of vacaciones) {
    const comp = solape(v.desde, v.hasta, periodo.desde, periodo.hasta);
    if (comp) vacDias += (Number(v.dias) || diasEntre(v.desde, v.hasta)) * (comp / diasEntre(v.desde, v.hasta));
  }
  vacDias = Math.round(vacDias * 100) / 100;
  if (vacDias > 0) obs.push(`Vacaciones pagadas: ${vacDias} día(s)`);

  // horas extra: las del reporte de horas (a tarifa diurna) + las anotadas a mano
  const rec = { he_diurna: P.he_diurna_pct, he_nocturna: P.he_nocturna_pct, he_feriada: P.he_feriada_pct };
  let horas = Math.round(Number(horasSugeridas) * 100) / 100, hx = horas * valorHora * (1 + rec.he_diurna / 100);
  let otros = 0;
  const deducciones = [];
  for (const n of novedades) {
    if (n.tipo.startsWith('he_')) { horas += Number(n.horas); hx += Number(n.horas) * valorHora * (1 + rec[n.tipo] / 100); }
    else if (n.tipo === 'bono') { otros += Number(n.monto); obs.push(`Bono ${r2(n.monto)}${n.concepto ? ` (${n.concepto})` : ''}`); }
    else deducciones.push({ concepto: n.concepto || 'Descuento', monto: r2(n.monto), tipo: 'manual' });
  }
  if (minutosTarde > 0) deducciones.push({ concepto: 'Tardanzas sin goce', monto: r2((minutosTarde / 60) * valorHora), tipo: 'manual' });
  for (const f of fijas) deducciones.push({ concepto: f.concepto, monto: r2(Number(f.monto_mensual) * periodo.fraccion), tipo: 'fija' });

  const bruto = dias * diario + hx + otros;
  let aportes = 0;
  if (P.aplicar_ley) { const ley = deduccionesLey(bruto, periodo.fraccion, P, tramos); deducciones.push(...ley.lineas); aportes = ley.patronales; }

  const linea = recalcularRenglon({
    ...base, dias, por_hora: Math.round(valorHora * 10000) / 10000, horas_extra: Math.round(horas * 100) / 100, total_hx: r2(hx), otros_ingresos: r2(otros),
    deducciones, aportes_patronales: aportes, observaciones: obs.join(' · '),
    detalle: { horas_sugeridas_reporte: Math.round(Number(horasSugeridas) * 100) / 100, dias_base: diasBase, dias_sin_goce: sinGoce, vacaciones_dias: vacDias },
  });
  if (linea.total < 0) avisos.push('El total a pagar es negativo: revisa las deducciones.');
  if (emp.estado === 'suspendido') avisos.push('Está marcado como suspendido: confirma si se le paga este periodo.');
  return { linea, avisos };
}

/** Totales de un conjunto de renglones (la planilla entera, o una sucursal). */
export function totalesDe(lineas) {
  const t = { empleados: lineas.length, total_quincenal: 0, total_hx: 0, otros_ingresos: 0, total_deducciones: 0, total: 0, aportes_patronales: 0, horas_extra: 0, sin_cuenta: 0, por_concepto: {} };
  for (const l of lineas) {
    t.total_quincenal += Number(l.total_quincenal); t.total_hx += Number(l.total_hx); t.otros_ingresos += Number(l.otros_ingresos);
    t.total_deducciones += Number(l.total_deducciones); t.total += Number(l.total); t.aportes_patronales += Number(l.aportes_patronales || 0); t.horas_extra += Number(l.horas_extra);
    if (!l.cuenta) t.sin_cuenta++;
    for (const d of l.deducciones ?? []) t.por_concepto[d.concepto] = r2((t.por_concepto[d.concepto] ?? 0) + Number(d.monto));
  }
  for (const k of ['total_quincenal', 'total_hx', 'otros_ingresos', 'total_deducciones', 'total', 'aportes_patronales', 'horas_extra']) t[k] = r2(t[k]);
  t.costo_empresa = r2(t.total_quincenal + t.total_hx + t.otros_ingresos + t.aportes_patronales);
  return t;
}

/** Agrupa por sucursal (como la hoja: un bloque por sucursal con su «Total») y deja el total general. */
export function agruparPorSucursal(lineas) {
  const orden = [];
  const mapa = new Map();
  for (const l of lineas) {
    const k = l.sucursal ?? 'Sin sucursal';
    if (!mapa.has(k)) { mapa.set(k, []); orden.push(k); }
    mapa.get(k).push(l);
  }
  return orden.map((nombre) => ({ sucursal: nombre, lineas: mapa.get(nombre), totales: totalesDe(mapa.get(nombre)) }));
}

/** Resumen contable de una planilla: lo que se gasta y lo que queda por pagar (cuadra al centavo). */
export function resumenContable(tipo, t) {
  const decimo = tipo === 'aguinaldo' || tipo === 'catorceavo';
  const gastos = (decimo
    ? [{ cuenta: tipo === 'aguinaldo' ? 'Aguinaldo (décimo tercer mes)' : 'Catorceavo mes', monto: t.total_quincenal }]
    : [{ cuenta: 'Sueldos y salarios', monto: t.total_quincenal }, { cuenta: 'Horas extra', monto: t.total_hx }, { cuenta: 'Bonos y otros ingresos', monto: t.otros_ingresos },
      { cuenta: 'Aportes patronales (IHSS, RAP, INFOP)', monto: t.aportes_patronales }]).filter((x) => x.monto !== 0 || x.cuenta.startsWith('Sueldos') || x.cuenta.startsWith('Aguinaldo') || x.cuenta.startsWith('Catorceavo'));
  const por_pagar = [
    { cuenta: 'Sueldos por pagar (neto a los empleados)', monto: t.total },
    ...Object.entries(t.por_concepto ?? {}).map(([c, m]) => ({ cuenta: `${c} por pagar`, monto: m })),
    ...(t.aportes_patronales ? [{ cuenta: 'Aportes patronales por pagar', monto: t.aportes_patronales }] : []),
  ];
  return { gastos, por_pagar, total_gasto: r2(gastos.reduce((s, x) => s + x.monto, 0)), total_por_pagar: r2(por_pagar.reduce((s, x) => s + x.monto, 0)) };
}
