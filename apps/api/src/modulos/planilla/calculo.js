// Cálculo de la planilla de Honduras. Funciones puras (sin base de datos) para poder probarlas con casos conocidos.
//
// TODO lo que sale de los PARÁMETROS (porcentajes del IHSS, RAP, INFOP, techos, recargos de horas extra y tabla del ISR)
// son valores de arranque que debe validar el contador: este archivo no inventa ninguno, los recibe de plan.parametros
// y plan.isr_tramos, que el dueño edita en la pantalla de parámetros.
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIA = 86400000;

const aMs = (iso) => Date.parse(`${iso}T00:00:00Z`);
export const diasEntre = (a, b) => Math.round((aMs(b) - aMs(a)) / DIA) + 1;               // inclusivos
export const sumarDiasISO = (iso, n) => new Date(aMs(iso) + n * DIA).toISOString().slice(0, 10);
const maxF = (a, b) => (a > b ? a : b);
const minF = (a, b) => (a < b ? a : b);
/** Días calendario que comparten dos rangos de fechas (0 si no se tocan). */
export function solape(d1, h1, d2, h2) {
  const d = maxF(d1, d2), h = minF(h1, h2);
  return h < d ? 0 : diasEntre(d, h);
}
const ultimoDia = (anio, mes) => new Date(Date.UTC(anio, mes, 0)).getUTCDate();
const pad = (n) => String(n).padStart(2, '0');

/** Convierte las filas de plan.parametros a un objeto { clave: valor }. */
export const mapaParametros = (filas) => Object.fromEntries(filas.map((p) => [p.clave, Number(p.valor)]));

/** Fechas y forma de pago del periodo de una planilla. */
export function periodoDe({ tipo, anio, mes, quincena }, P) {
  if (tipo === 'quincena' || tipo === 'mensual') {
    const ult = ultimoDia(anio, mes);
    const nombreMes = `${MESES[mes - 1]} ${anio}`;
    if (tipo === 'mensual') return { desde: `${anio}-${pad(mes)}-01`, hasta: `${anio}-${pad(mes)}-${pad(ult)}`, etiqueta: `Mensual · ${nombreMes}`, fraccion: 1, diasBase: P.dias_mes, pago: `${anio}-${pad(mes)}-${pad(ult)}` };
    return quincena === 1
      ? { desde: `${anio}-${pad(mes)}-01`, hasta: `${anio}-${pad(mes)}-15`, etiqueta: `1.ª quincena · ${nombreMes}`, fraccion: 0.5, diasBase: P.dias_mes / 2, pago: `${anio}-${pad(mes)}-15` }
      : { desde: `${anio}-${pad(mes)}-16`, hasta: `${anio}-${pad(mes)}-${pad(ult)}`, etiqueta: `2.ª quincena · ${nombreMes}`, fraccion: 0.5, diasBase: P.dias_mes / 2, pago: `${anio}-${pad(mes)}-${pad(ult)}` };
  }
  if (tipo === 'aguinaldo') {
    return { desde: `${anio}-01-01`, hasta: `${anio}-12-31`, etiqueta: `Décimo tercer mes (aguinaldo) · ${anio}`, fraccion: 1, diasBase: P.decimos_dias_base,
      pago: `${anio}-${pad(P.aguinaldo_mes_pago)}-${pad(Math.min(P.aguinaldo_dia_pago, ultimoDia(anio, P.aguinaldo_mes_pago)))}` };
  }
  return { desde: `${anio - 1}-07-01`, hasta: `${anio}-06-30`, etiqueta: `Catorceavo mes · ${anio}`, fraccion: 1, diasBase: P.decimos_dias_base,
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
    const parte = Math.max(0, Math.min(base, techo) - piso);
    total += parte * (Number(t[i].tasa) / 100);
  }
  return r2(total);
}

/** Salario mensual de referencia de un empleado (o null si no se puede calcular). */
export function salarioMensualDe(emp) {
  const m = Number(emp.salario_mensual);
  if (Number.isFinite(m) && m > 0) return m;
  const h = Number(emp.salario_hora), hs = Number(emp.horas_semana);
  if (emp.tipo_pago === 'por_hora' && h > 0 && hs > 0) return r2((h * hs * 52) / 12);
  return null;
}
const horasDiaDe = (jornada, P) => (jornada === 'nocturna' ? P.horas_dia_nocturna : jornada === 'mixta' ? P.horas_dia_mixta : P.horas_dia_diurna);

/**
 * Calcula UN renglón de la planilla.
 *   emp: fila de rrhh.empleados (+ nombres) · P: parámetros · tramos: tabla ISR · periodo: salida de periodoDe()
 *   novedades: [{tipo, horas, monto, concepto}] del empleado · ausencias: [{tipo, desde, hasta, dias, minutos}] SIN goce
 *   vacaciones: [{desde, hasta, dias}] aprobadas/tomadas · suspensiones: [{desde, hasta}] sin goce
 * Devuelve { linea, avisos } o { omitido: 'motivo' }.
 */
export function calcularLinea({ tipo, emp, P, tramos, periodo, novedades = [], ausencias = [], vacaciones = [], suspensiones = [] }) {
  const avisos = [];
  const sm = salarioMensualDe(emp);
  if (!sm) return { omitido: 'sin salario registrado' };
  if (['semanal', 'por_hora'].includes(emp.tipo_pago) && !(Number(emp.salario_mensual) > 0)) avisos.push('Se pagó con un sueldo mensual equivalente; revisa que el pago por hora/semana esté bien.');
  const ini = maxF(periodo.desde, emp.fecha_ingreso ?? periodo.desde);
  const fin = minF(periodo.hasta, emp.fecha_salida ?? periodo.hasta);
  if (fin < ini) return { omitido: 'no estaba contratado en el periodo' };

  const base = {
    empleado_id: emp.id, nombre: `${emp.nombres} ${emp.apellidos ?? ''}`.trim(), identidad: emp.identidad ?? null, puesto: emp.puesto ?? null, sucursal: emp.sucursal ?? null,
    salario_mensual: r2(sm),
  };

  // ── Décimo tercer y catorceavo mes: proporcional por antigüedad dentro del periodo ──
  if (tipo === 'aguinaldo' || tipo === 'catorceavo') {
    if (!emp.fecha_ingreso) avisos.push('No tiene fecha de ingreso: se pagó el mes completo. Revísalo antes de aprobar.');
    const dias = diasEntre(ini, fin);
    const proporcion = Math.min(1, dias / P.decimos_dias_base);
    const monto = r2(sm * proporcion);
    return {
      linea: { ...base, dias_pagados: dias, devengado: monto, desc_ausencias: 0, he_diurna_h: 0, he_nocturna_h: 0, he_feriada_h: 0, he_monto: 0, bonos: 0, vacaciones_dias: 0, vacaciones_extra: 0,
        ihss: 0, rap: 0, infop: 0, isr: 0, otros_desc: 0, total_ingresos: monto, total_deducciones: 0, neto: monto, ihss_patrono: 0, rap_patrono: 0, infop_patrono: 0,
        detalle: { proporcion: Math.round(proporcion * 10000) / 10000, desde: ini, hasta: fin, nota: 'Sin descuentos de IHSS, RAP ni ISR (el contador debe confirmar el tratamiento).' } },
      avisos,
    };
  }

  // ── Quincena / mes ──
  const valorDia = sm / P.dias_mes;
  const valorHora = valorDia / horasDiaDe(emp.jornada, P);
  const total = diasEntre(periodo.desde, periodo.hasta);
  const cubiertos = diasEntre(ini, fin);
  const diasPagados = cubiertos >= total ? periodo.diasBase : Math.min(periodo.diasBase, cubiertos);
  const devengado = r2(valorDia * diasPagados);

  // ausencias sin goce, tardanzas sin goce y suspensiones
  let diasSinGoce = 0, minutosTarde = 0;
  for (const a of ausencias) {
    const comp = solape(a.desde, a.hasta, periodo.desde, periodo.hasta);
    if (!comp) continue;
    if (a.tipo === 'tardanza') { minutosTarde += Number(a.minutos) || 0; continue; }
    const dur = diasEntre(a.desde, a.hasta);
    diasSinGoce += Number(a.dias) * (comp / dur);
  }
  for (const s of suspensiones) diasSinGoce += solape(s.desde, s.hasta, periodo.desde, periodo.hasta);
  let descAus = r2(diasSinGoce * valorDia + (minutosTarde / 60) * valorHora);
  if (descAus > devengado) { descAus = devengado; avisos.push('Los descuentos por ausencia superan el sueldo del periodo: se limitaron al sueldo.'); }

  // vacaciones (se pagan dentro del sueldo; el extra es opcional)
  let vacDias = 0;
  for (const v of vacaciones) {
    const comp = solape(v.desde, v.hasta, periodo.desde, periodo.hasta);
    if (comp) vacDias += (Number(v.dias) || diasEntre(v.desde, v.hasta)) * (comp / diasEntre(v.desde, v.hasta));
  }
  vacDias = Math.round(vacDias * 100) / 100;
  const vacExtra = r2(vacDias * valorDia * (P.vacaciones_prima_pct / 100));

  // novedades: horas extra, bonos, descuentos
  const hs = { he_diurna: 0, he_nocturna: 0, he_feriada: 0 };
  const rec = { he_diurna: P.he_diurna_pct, he_nocturna: P.he_nocturna_pct, he_feriada: P.he_feriada_pct };
  let heMonto = 0, bonos = 0, otros = 0;
  const lineasNov = [];
  for (const n of novedades) {
    if (n.tipo.startsWith('he_')) {
      const h = Number(n.horas); hs[n.tipo] += h;
      const m = h * valorHora * (1 + rec[n.tipo] / 100); heMonto += m;
      lineasNov.push({ tipo: n.tipo, horas: h, monto: r2(m), concepto: n.concepto ?? null });
    } else if (n.tipo === 'bono') { bonos += Number(n.monto); lineasNov.push({ tipo: 'bono', monto: r2(n.monto), concepto: n.concepto ?? null }); }
    else { otros += Number(n.monto); lineasNov.push({ tipo: 'descuento', monto: r2(n.monto), concepto: n.concepto ?? null }); }
  }
  heMonto = r2(heMonto); bonos = r2(bonos); otros = r2(otros);

  const totalIngresos = r2(devengado + heMonto + bonos + vacExtra);
  const baseCot = Math.max(0, r2(totalIngresos - descAus));      // lo que realmente se ganó en el periodo

  // IHSS (con techo), RAP (sobre lo que excede el monto libre), INFOP
  const baseIhss = Math.min(baseCot, P.ihss_techo_mensual * periodo.fraccion);
  const ihss = r2(baseIhss * ((P.ihss_em_empleado_pct + P.ihss_ivm_empleado_pct) / 100));
  const ihssPat = r2(baseIhss * ((P.ihss_em_patrono_pct + P.ihss_ivm_patrono_pct) / 100));
  const baseRap = Math.max(0, baseCot - P.rap_exento_mensual * periodo.fraccion);
  const rap = r2(baseRap * (P.rap_empleado_pct / 100));
  const rapPat = r2(baseRap * (P.rap_patrono_pct / 100));
  const infop = r2(baseCot * (P.infop_empleado_pct / 100));
  const infopPat = r2(baseCot * (P.infop_patrono_pct / 100));

  // ISR: se proyecta el ingreso del año con lo ganado en el periodo, se resta la deducción y se aplica la tabla
  const anualBruto = (baseCot / periodo.fraccion) * 12;
  const deduccion = P.isr_gastos_medicos + (P.isr_deduce_ihss ? ((ihss + rap) / periodo.fraccion) * 12 : 0);
  const gravable = Math.max(0, anualBruto - deduccion);
  const isr = r2((impuestoAnual(gravable, tramos) / 12) * periodo.fraccion);

  const totalDed = r2(descAus + ihss + rap + infop + isr + otros);
  const neto = r2(totalIngresos - totalDed);
  if (neto < 0) avisos.push('El neto a pagar es negativo: revisa los descuentos manuales.');
  if (emp.estado === 'suspendido') avisos.push('Está marcado como suspendido: confirma si se le paga este periodo.');

  return {
    linea: {
      ...base, dias_pagados: diasPagados, devengado, desc_ausencias: descAus,
      he_diurna_h: hs.he_diurna, he_nocturna_h: hs.he_nocturna, he_feriada_h: hs.he_feriada, he_monto: heMonto, bonos, vacaciones_dias: vacDias, vacaciones_extra: vacExtra,
      ihss, rap, infop, isr, otros_desc: otros, total_ingresos: totalIngresos, total_deducciones: totalDed, neto, ihss_patrono: ihssPat, rap_patrono: rapPat, infop_patrono: infopPat,
      detalle: { valor_dia: r2(valorDia), valor_hora: r2(valorHora), dias_sin_goce: Math.round(diasSinGoce * 100) / 100, minutos_tarde: minutosTarde, base_cotizable: baseCot, base_ihss: r2(baseIhss),
        base_rap: r2(baseRap), renta_anual_proyectada: r2(anualBruto), renta_anual_gravable: r2(gravable), novedades: lineasNov },
    },
    avisos,
  };
}

const SUMAS = ['devengado', 'desc_ausencias', 'he_monto', 'bonos', 'vacaciones_extra', 'ihss', 'rap', 'infop', 'isr', 'otros_desc', 'total_ingresos', 'total_deducciones', 'neto', 'ihss_patrono', 'rap_patrono', 'infop_patrono'];
export function totalesDe(lineas) {
  const t = { empleados: lineas.length };
  for (const k of SUMAS) t[k] = r2(lineas.reduce((s, l) => s + Number(l[k] || 0), 0));
  t.aportes_patronales = r2(t.ihss_patrono + t.rap_patrono + t.infop_patrono);
  t.costo_empresa = r2(t.total_ingresos - t.desc_ausencias + t.aportes_patronales);
  return t;
}

/** Resumen contable de una planilla: lo que se gasta y lo que queda por pagar (cuadra al centavo). */
export function resumenContable(tipo, t) {
  const salarios = r2(t.devengado - t.desc_ausencias);
  const gastos = tipo === 'aguinaldo' || tipo === 'catorceavo'
    ? [{ cuenta: tipo === 'aguinaldo' ? 'Décimo tercer mes (aguinaldo)' : 'Catorceavo mes', monto: salarios }]
    : [
      { cuenta: 'Sueldos y salarios', monto: salarios },
      { cuenta: 'Horas extra', monto: t.he_monto },
      { cuenta: 'Bonos y otros ingresos', monto: r2(t.bonos + t.vacaciones_extra) },
      { cuenta: 'Aporte patronal IHSS', monto: t.ihss_patrono },
      { cuenta: 'Aporte patronal RAP', monto: t.rap_patrono },
      { cuenta: 'Aporte patronal INFOP', monto: t.infop_patrono },
    ];
  const por_pagar = [
    { cuenta: 'Sueldos por pagar (neto a los empleados)', monto: t.neto },
    { cuenta: 'IHSS por pagar (empleado + patrono)', monto: r2(t.ihss + t.ihss_patrono) },
    { cuenta: 'RAP por pagar (empleado + patrono)', monto: r2(t.rap + t.rap_patrono) },
    { cuenta: 'INFOP por pagar', monto: r2(t.infop + t.infop_patrono) },
    { cuenta: 'ISR retenido por pagar', monto: t.isr },
    { cuenta: 'Otros descuentos por pagar', monto: t.otros_desc },
  ].filter((x) => x.monto !== 0 || x.cuenta.startsWith('Sueldos'));
  const gastosFiltrados = gastos.filter((x) => x.monto !== 0 || x.cuenta === 'Sueldos y salarios');
  return {
    gastos: gastosFiltrados, por_pagar,
    total_gasto: r2(gastosFiltrados.reduce((s, x) => s + x.monto, 0)), total_por_pagar: r2(por_pagar.reduce((s, x) => s + x.monto, 0)),
  };
}
