import { sumarDias, diaSemanaDe } from './nucleo.js';

/** Datos de prueba para las verificaciones del gerente. No es un test: lo usan los tests. */
export const HOY = '2026-10-02';

/** La fecha que queda `offset` días respecto de HOY (negativo = pasado). */
export const dia = (offset) => sumarDias(HOY, offset);

export function datosBase(extra = {}) {
  return {
    hoy: HOY,
    sucursales: [
      { id: 'mackey', nombre: 'Mackey', rol: 'sucursal', activa: 1 },
      { id: 'proceres', nombre: 'Próceres', rol: 'sucursal', activa: 1 },
      { id: 'los-andes', nombre: 'Los Andes', rol: 'sucursal', activa: 1 },
      { id: 'progreso', nombre: 'Progreso', rol: 'sucursal', activa: 1 },
    ],
    sabores: [
      { id: 1, nombre: 'PISTACHO', gramos_pana: 3000, activo: 1 },
      { id: 2, nombre: 'MANGO', gramos_pana: 3000, activo: 1 },
      { id: 3, nombre: 'CHOCOLATE', gramos_pana: 3000, activo: 1 },
    ],
    pesajes: [],
    despachos: [],
    tandas: [],
    producciones: [],
    consumos: [],
    insumos: [],
    precios: [],
    movimientos: [],
    lotes: [],
    pedidos: [],
    empleados: [],
    horarios: [],
    vacaciones: [],
    marcaciones: [],
    incidencias: [],
    mantenimientos: [],
    entorno: { produccion: false, jwtSecret: true, tursoToken: true, gemini: true },
    fueraDeAnalisis: ['los-andes'],
    cerradas: ['progreso'],
    ...extra,
  };
}

/** Una fila de pesaje por noche entre dos offsets, con el peso que devuelva `peso(offset)`. */
export function pesajesDe(sucursal, sabor, desde, hasta, peso) {
  const filas = [];
  for (let o = desde; o <= hasta; o++) {
    filas.push({
      sucursal_id: sucursal, sabor_id: sabor, fecha: dia(o), gramos: peso(o),
      fuente: 'manual', creado_en: `${dia(o)} 23:00:00`,
    });
  }
  return filas;
}

let contadorDespachos = 0;

/** Un despacho recibido y sin diferencias. `fecha` es la noche del pedido; `enviado_en`, la entrega. */
export function despacho(extra) {
  contadorDespachos += 1;
  return {
    id: contadorDespachos, fecha: dia(-1), sucursal_id: 'mackey', sabor_id: 1,
    panas: 1, gramos_enviados: 3000, estado: 'recibido', gramos_confirmados_recibidos: 3000,
    panas_recibidas: 1, discrepancia: 0, discrepancia_resuelta: 0, enviado_en: null, ...extra,
  };
}

/** Un pseudo-aleatorio determinista: los tests no pueden depender del azar. */
export function ruido(semilla) {
  const x = Math.sin(semilla * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Una marcación como la guarda la base: `fecha` es el día local de la tienda y `creado_en` la
 * hora en UTC (Honduras es UTC-6, así que 10:00 local se guarda como 16:00).
 */
export function marcacion({ empleado = 1, sucursal = 'mackey', offset, tipo = 'entrada', hora = '10:00', verificacion = 'dentro', distancia = 20 }) {
  const [h, m] = hora.split(':').map(Number);
  const utc = new Date(`${dia(offset)}T00:00:00Z`);
  utc.setUTCHours(h + 6, m, 0, 0);
  return {
    empleado_id: empleado, sucursal_id: sucursal, fecha: dia(offset), tipo,
    creado_en: utc.toISOString().slice(0, 19).replace('T', ' '), verificacion, distancia_metros: distancia,
  };
}

/** Un turno completo (entrada y salida) de un día. */
export function turno({ empleado = 1, sucursal = 'mackey', offset, entrada = '10:00', salida = '18:00', ...resto }) {
  return [
    marcacion({ empleado, sucursal, offset, tipo: 'entrada', hora: entrada, ...resto }),
    marcacion({ empleado, sucursal, offset, tipo: 'salida', hora: salida, ...resto }),
  ];
}

/** Horario de los 7 días: lunes a sábado en turno, domingo libre (o lo que se pida). */
export function horarioSemana(empleado, { inicio = '10:00', fin = '18:00', libres = [6] } = {}) {
  return Array.from({ length: 7 }, (_, d) => ({
    empleado_id: empleado, dia_semana: d, estado: libres.includes(d) ? 'libre' : 'turno',
    hora_inicio: libres.includes(d) ? null : inicio, hora_fin: libres.includes(d) ? null : fin,
  }));
}

export const persona = (id, nombre, sucursal = 'mackey', extra = {}) => ({
  id, nombre, sucursal_id: sucursal, activo: 1, fecha_ingreso: '2022-01-10', ...extra,
});


/**
 * 60 días de un negocio que funciona bien pero NO perfecto: balanzas que varían, una pana mal
 * contada de vez en cuando, un GPS que falla, una salida sin marcar. Todo ruido normal.
 * Sirve para comprobar que el gerente NO inventa problemas, y de base para plantar uno real.
 */
const TIENDAS = ['mackey', 'proceres'];
const SABORES = [1, 2, 3];

export function negocioSano() {
  const pesajes = [];
  const despachos = [];
  const marcaciones = [];
  const horarios = [];
  const empleados = [];
  let semilla = 1;
  const azar = () => ruido(semilla++);

  // ── vitrinas: se reponen cada dos días y bajan con el consumo ─────────────────────────
  for (const tienda of TIENDAS) {
    for (const sabor of SABORES) {
      let stock = 4500;
      for (let o = -60; o <= -1; o++) {
        if (o % 2 === 0) {
          const panas = Math.max(0, Math.round((7500 - stock) / 3000));
          if (panas > 0) {
            stock += panas * 3000;
            // Una de cada 20 recepciones se cuenta mal en una pana, para un lado o para el otro.
            const error = semilla % 20 === 0 ? (semilla % 40 === 0 ? 1 : -1) : 0;
            despachos.push(despacho({
              fecha: dia(o - 1), enviado_en: dia(o), sucursal_id: tienda, sabor_id: sabor,
              panas, gramos_enviados: panas * 3000, panas_recibidas: panas + error, discrepancia: error ? 1 : 0,
            }));
          }
        }
        stock = Math.max(200 + Math.round(azar() * 400), stock - (1100 + Math.round(azar() * 900)));
        pesajes.push({
          sucursal_id: tienda, sabor_id: sabor, fecha: dia(o), gramos: Math.round(stock + (azar() - 0.5) * 120),
          fuente: 'manual', creado_en: `${dia(o)} 23:00:00`,
        });
      }
    }
  }

  // ── personal: 3 por tienda, lunes a sábado de 10 a 18 ─────────────────────────────────
  let id = 1;
  for (const tienda of TIENDAS) {
    for (let i = 0; i < 3; i++) {
      const emp = persona(id, `Empleado ${id}`, tienda, { fecha_ingreso: '2026-01-05' });
      empleados.push(emp);
      horarios.push(...horarioSemana(id));
      for (let o = -30; o <= -1; o++) {
        if (diaSemanaDe(dia(o)) === 6) continue;
        const llegada = `${String(9 + Math.floor(azar() * 0.5)).padStart(2, '0')}:${String(Math.floor(55 + azar() * 15) % 60).padStart(2, '0')}`;
        const salida = `18:${String(Math.floor(azar() * 25)).padStart(2, '0')}`;
        const lejos = azar() < 0.02;
        const sinSalida = azar() < 0.015;
        const verificacion = lejos ? 'lejos' : 'dentro';
        if (sinSalida) marcaciones.push(marcacion({ empleado: id, sucursal: tienda, offset: o, tipo: 'entrada', hora: llegada, verificacion }));
        else marcaciones.push(...turno({ empleado: id, sucursal: tienda, offset: o, entrada: llegada === '09:59' ? '10:00' : llegada.startsWith('09:5') || llegada.startsWith('10') ? llegada : '10:00', salida, verificacion, distancia: lejos ? 300 : 25 }));
      }
      id += 1;
    }
  }

  // ── fábrica: una tanda de cada sabor cada 3 días, con consumo de insumos normal ───────
  const producciones = [];
  const consumos = [];
  let tandaId = 1;
  for (let o = -57; o <= -1; o += 3) {
    for (const sabor of SABORES) {
      producciones.push({ id: tandaId, fecha: dia(o), sabor_id: sabor, kg: 12, kg_restante: 0, lote: `L${tandaId}`, operario: '' });
      // La desviación va para los dos lados, hasta ±8%: es lo normal al pesar a ojo.
      consumos.push({ produccion_id: tandaId, sabor_id: sabor, insumo_id: sabor, insumo_nombre: `INSUMO ${sabor}`, cantidad_sugerida: 10, cantidad_real: 10 + (azar() - 0.5) * 1.6 });
      tandaId += 1;
    }
  }

  // ── inventario: kardex coherente y precios estables ───────────────────────────────────
  const insumos = SABORES.map((s) => ({ id: s, nombre: `INSUMO ${s}`, tipo: 'local', unidad: 'unidad', stock_actual: 40, es_equipo: 0 }));
  const movimientos = SABORES.map((s) => ({ id: s, insumo_id: s, tipo: 'entrada', cantidad: 40, saldo_resultante: 40, creado_en: `${dia(-20)} 10:00:00` }));
  const precios = SABORES.flatMap((s) => [
    { id: s * 10, insumo_id: s, lps_kg: 100, fecha_vigencia: dia(-90) }, { id: s * 10 + 1, insumo_id: s, lps_kg: 104, fecha_vigencia: dia(-20) },
  ]);

  return datosBase({
    sucursales: [
      { id: 'mackey', nombre: 'Mackey', rol: 'sucursal', activa: 1, radio_metros: 150 },
      { id: 'proceres', nombre: 'Próceres', rol: 'sucursal', activa: 1, radio_metros: 150 },
      { id: 'los-andes', nombre: 'Los Andes', rol: 'sucursal', activa: 1 },
    ],
    pesajes, despachos, marcaciones, horarios, empleados, producciones, consumos, insumos, movimientos, precios,
  });
}

