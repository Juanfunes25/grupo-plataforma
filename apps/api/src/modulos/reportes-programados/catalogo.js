// Catálogo de reportes que se pueden programar o exportar. Cada reporte produce una estructura NEUTRAL
// (títulos, indicadores y tablas) que luego se convierte a Excel, PDF o al cuerpo del correo.
//
//   { titulo, subtitulo, resumen: [{ etiqueta, valor, tipo }], secciones: [{ titulo, columnas: [{ clave, titulo, tipo }], filas: [...] }],
//     notas: [texto], vacio: boolean }
//
// tipo de columna/valor: texto | moneda | entero | numero | pct | fecha
import { fechaHN, sumarDias } from '@grupo/shared';
import { resumenVentas } from '../pos/reportes.js';
import { consumoDeRango } from '../rep/datos.js';
import { proximos } from '../documentos/servicio.js';
import { tableroEmpresa, alertasEmpresa } from '../tablero/consultas.js';
import { comparar } from '../tablero/calculo.js';

const TZ = `'America/Tegucigalpa'`;
const NOTA_BORRADOR = 'Etapa de pruebas: las facturas en modo BORRADOR no tienen valor fiscal (aún no hay CAI real).';
const DIA_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const diaDe = (f) => DIA_SEMANA[new Date(`${f}T12:00:00Z`).getUTCDay()];
const num = (v) => Number(v ?? 0);
const r2 = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;
const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Día de un reporte: 'hoy' | 'ayer' | fecha explícita. Por omisión, ayer (el día completo más reciente). */
export function resolverDia(p, hoy) {
  if (FECHA_ISO.test(p.fecha ?? '')) return p.fecha;
  return p.dia === 'hoy' ? hoy : sumarDias(hoy, -1);
}
/** Rango de un reporte: desde/hasta explícitos, o los últimos `dias` días terminando ayer. */
export function resolverRangoRep(p, hoy, porDefecto = 7) {
  if (FECHA_ISO.test(p.desde ?? '') && FECHA_ISO.test(p.hasta ?? '')) return { desde: p.desde, hasta: p.hasta };
  const dias = Math.min(Math.max(Number(p.dias) || porDefecto, 1), 90);
  return { desde: sumarDias(hoy, -dias), hasta: sumarDias(hoy, -1) };
}

const COL = {
  texto: (clave, titulo) => ({ clave, titulo, tipo: 'texto' }),
  moneda: (clave, titulo) => ({ clave, titulo, tipo: 'moneda' }),
  entero: (clave, titulo) => ({ clave, titulo, tipo: 'entero' }),
  numero: (clave, titulo) => ({ clave, titulo, tipo: 'numero' }),
  pct: (clave, titulo) => ({ clave, titulo, tipo: 'pct' }),
  fecha: (clave, titulo) => ({ clave, titulo, tipo: 'fecha' }),
};

function seccionesVentas(v) {
  const sec = [];
  if (v.por_sucursal.length) sec.push({ titulo: 'Por sucursal', columnas: [COL.texto('sucursal', 'Sucursal'), COL.entero('facturas', 'Facturas'), COL.moneda('total', 'Ventas')],
    filas: v.por_sucursal.map((s) => ({ sucursal: s.sucursal, facturas: s.facturas, total: num(s.total) })) });
  if (v.por_forma_pago.length) {
    const tot = v.por_forma_pago.reduce((s, p) => s + num(p.monto), 0);
    sec.push({ titulo: 'Formas de pago', columnas: [COL.texto('forma', 'Forma de pago'), COL.moneda('monto', 'Monto'), COL.pct('pct', '% del total')],
      filas: v.por_forma_pago.map((p) => ({ forma: p.nombre, monto: num(p.monto), pct: tot > 0 ? r2((num(p.monto) / tot) * 100) : 0 })) });
  }
  if (v.top_productos.length) sec.push({ titulo: 'Productos más vendidos', columnas: [COL.texto('producto', 'Producto'), COL.numero('unidades', 'Unidades'), COL.moneda('venta', 'Venta'), COL.pct('margen', 'Margen')],
    filas: v.top_productos.map((p) => ({ producto: p.producto, unidades: num(p.unidades), venta: num(p.venta), margen: p.margen_pct })) });
  return sec;
}

const REPORTES = {
  ventas_dia: {
    nombre: 'Ventas del día', descripcion: 'Total vendido, facturas, ticket promedio, margen, sucursales, formas de pago y productos, comparado con el mismo día de la semana pasada.',
    permiso: 'pos:reportes', modulo: 'dashboard', parametros: ['dia', 'sucursal_id'],
    async generar({ db, empresa, sucursalIds, hoy, params }) {
      const fecha = resolverDia(params, hoy);
      const base = { empresaId: empresa.id, sucursalIds, sucursalId: params.sucursal_id ?? null };
      const [v, previo] = await Promise.all([resumenVentas(db, { ...base, desde: fecha, hasta: fecha }), resumenVentas(db, { ...base, desde: sumarDias(fecha, -7), hasta: sumarDias(fecha, -7) })]);
      const c = comparar(v.total, previo.total);
      return {
        titulo: `Ventas del día · ${empresa.nombre}`, subtitulo: `${diaDe(fecha)} ${fecha}`,
        resumen: [
          { etiqueta: 'Ventas', valor: num(v.total), tipo: 'moneda' }, { etiqueta: 'Facturas', valor: v.facturas, tipo: 'entero' },
          { etiqueta: 'Ticket promedio', valor: num(v.ticket_promedio), tipo: 'moneda' }, { etiqueta: 'Margen', valor: v.margen_pct, tipo: 'pct' },
          { etiqueta: `Mismo ${diaDe(fecha)} anterior (${sumarDias(fecha, -7)})`, valor: num(previo.total), tipo: 'moneda' },
          { etiqueta: 'Variación', valor: c.pct, tipo: 'pct' },
          { etiqueta: 'Anuladas', valor: v.anuladas?.n ?? 0, tipo: 'entero' },
        ],
        secciones: seccionesVentas(v), notas: [NOTA_BORRADOR], vacio: v.facturas === 0,
      };
    },
  },

  ventas_periodo: {
    nombre: 'Ventas de la semana o el mes', descripcion: 'Ventas por día, sucursal, forma de pago y producto de los últimos días (termina ayer).',
    permiso: 'pos:reportes', modulo: 'dashboard', parametros: ['dias', 'sucursal_id'],
    async generar({ db, empresa, sucursalIds, hoy, params }) {
      const { desde, hasta } = resolverRangoRep(params, hoy, 7);
      const v = await resumenVentas(db, { empresaId: empresa.id, sucursalIds, sucursalId: params.sucursal_id ?? null, desde, hasta });
      const secciones = [{ titulo: 'Ventas por día', columnas: [COL.fecha('fecha', 'Fecha'), COL.entero('facturas', 'Facturas'), COL.moneda('total', 'Ventas')],
        filas: v.por_dia.map((d) => ({ fecha: d.fecha, facturas: d.facturas, total: num(d.total) })) }, ...seccionesVentas(v)];
      return {
        titulo: `Ventas del periodo · ${empresa.nombre}`, subtitulo: `${desde} al ${hasta}`,
        resumen: [{ etiqueta: 'Ventas', valor: num(v.total), tipo: 'moneda' }, { etiqueta: 'Facturas', valor: v.facturas, tipo: 'entero' },
          { etiqueta: 'Ticket promedio', valor: num(v.ticket_promedio), tipo: 'moneda' }, { etiqueta: 'Margen', valor: v.margen_pct, tipo: 'pct' },
          { etiqueta: 'ISV', valor: num(v.isv), tipo: 'moneda' }, { etiqueta: 'Anuladas', valor: v.anuladas?.n ?? 0, tipo: 'entero' }],
        secciones, notas: [NOTA_BORRADOR], vacio: v.facturas === 0,
      };
    },
  },

  libro_ventas: {
    nombre: 'Libro de ventas', descripcion: 'Una fila por factura con sus importes (formato para el contador).',
    permiso: 'pos:reportes', modulo: 'reportes', parametros: ['dias', 'sucursal_id'],
    async generar({ db, empresa, sucursalIds, hoy, params }) {
      const { desde, hasta } = resolverRangoRep(params, hoy, 7);
      const { rows } = await db.query(
        `select (v.fecha_emision at time zone ${TZ})::date::text as fecha, v.numero_factura, v.estado, s.nombre as sucursal,
                coalesce(v.cliente_nombre, c.nombre, 'Consumidor Final') as cliente, coalesce(v.cliente_rtn, c.rtn) as rtn,
                v.subtotal_exento as exento, v.subtotal_exonerado as exonerado, v.subtotal_gravado_15 as gravado_15, v.subtotal_gravado_18 as gravado_18,
                v.isv_total as isv, v.descuento, v.total, v.es_borrador_fiscal as borrador
           from pos.ventas v join core.sucursales s on s.id = v.sucursal_id left join core.terceros c on c.id = v.cliente_id
          where v.empresa_id = $1 and ($2::uuid[] = '{}' or v.sucursal_id = any($2::uuid[])) and ($5::uuid is null or v.sucursal_id = $5)
            and v.estado in ('pagada','anulada') and v.numero_factura is not null and (v.fecha_emision at time zone ${TZ})::date between $3::date and $4::date
          order by v.fecha_emision, v.correlativo`, [empresa.id, sucursalIds, desde, hasta, params.sucursal_id ?? null]);
      const validas = rows.filter((r) => r.estado === 'pagada');
      const suma = (k) => r2(validas.reduce((s, r) => s + num(r[k]), 0));
      return {
        titulo: `Libro de ventas · ${empresa.nombre}`, subtitulo: `${desde} al ${hasta}`,
        resumen: [{ etiqueta: 'Facturas válidas', valor: validas.length, tipo: 'entero' }, { etiqueta: 'Anuladas', valor: rows.length - validas.length, tipo: 'entero' },
          { etiqueta: 'ISV', valor: suma('isv'), tipo: 'moneda' }, { etiqueta: 'Total', valor: suma('total'), tipo: 'moneda' }],
        secciones: [{ titulo: 'Facturas', columnas: [COL.fecha('fecha', 'Fecha'), COL.texto('numero_factura', 'Factura'), COL.texto('estado', 'Estado'), COL.texto('sucursal', 'Sucursal'), COL.texto('cliente', 'Cliente'), COL.texto('rtn', 'RTN'),
          COL.moneda('exento', 'Exento'), COL.moneda('exonerado', 'Exonerado'), COL.moneda('gravado_15', 'Gravado 15%'), COL.moneda('gravado_18', 'Gravado 18%'), COL.moneda('isv', 'ISV'), COL.moneda('descuento', 'Descuento'), COL.moneda('total', 'Total'), COL.texto('borrador', 'Fiscal')],
          filas: rows.map((r) => ({ ...r, estado: r.estado === 'anulada' ? 'Anulada' : 'Válida', borrador: r.borrador ? 'Borrador (sin CAI)' : 'CAI' })) }],
        notas: [NOTA_BORRADOR], vacio: rows.length === 0,
      };
    },
  },

  cierre_caja: {
    nombre: 'Cierre de caja', descripcion: 'Cierres del día por sucursal: ventas, efectivo esperado y contado, diferencias; y las sucursales que vendieron sin cerrar caja.',
    permiso: 'pos:reportes', modulo: 'cierres', parametros: ['dia'],
    async generar({ db, empresa, sucursalIds, hoy, params }) {
      const fecha = resolverDia(params, hoy);
      const [cierres, sinCierre] = await Promise.all([
        db.query(`select s.nombre as sucursal, u.nombre as cajero, c.cantidad_facturas, c.total_ventas, c.efectivo_sistema, c.tarjeta_sistema, c.transferencia_sistema,
                         c.efectivo_esperado, c.efectivo_contado, c.diferencia, c.observaciones
                    from pos.cierres_caja c join core.sucursales s on s.id = c.sucursal_id join core.usuarios u on u.id = c.cajero_id
                   where c.empresa_id = $1 and c.fecha = $2::date and ($3::uuid[] = '{}' or c.sucursal_id = any($3::uuid[])) order by s.nombre, c.fecha_fin`, [empresa.id, fecha, sucursalIds]).then((r) => r.rows),
        db.query(`select s.nombre, coalesce(sum(v.total), 0)::numeric as ventas from core.sucursales s join pos.ventas v on v.sucursal_id = s.id and v.estado = 'pagada' and (v.fecha_emision at time zone ${TZ})::date = $2::date
                   where s.empresa_id = $1 and s.activo and ($3::uuid[] = '{}' or s.id = any($3::uuid[]))
                     and not exists (select 1 from pos.cierres_caja c where c.sucursal_id = s.id and c.fecha = $2::date) group by s.nombre order by s.nombre`, [empresa.id, fecha, sucursalIds]).then((r) => r.rows),
      ]);
      const conDif = cierres.filter((c) => Math.abs(num(c.diferencia)) >= 0.005);
      const secciones = [];
      if (cierres.length) secciones.push({ titulo: 'Cierres del día', columnas: [COL.texto('sucursal', 'Sucursal'), COL.texto('cajero', 'Cajero'), COL.entero('cantidad_facturas', 'Facturas'), COL.moneda('total_ventas', 'Ventas'),
        COL.moneda('efectivo_sistema', 'Efectivo (sistema)'), COL.moneda('tarjeta_sistema', 'Tarjeta'), COL.moneda('efectivo_esperado', 'Efectivo esperado'), COL.moneda('efectivo_contado', 'Efectivo contado'), COL.moneda('diferencia', 'Diferencia'), COL.texto('observaciones', 'Observaciones')], filas: cierres });
      if (sinCierre.length) secciones.push({ titulo: 'Vendieron pero no hicieron cierre', columnas: [COL.texto('nombre', 'Sucursal'), COL.moneda('ventas', 'Ventas del día')], filas: sinCierre });
      return {
        titulo: `Cierre de caja · ${empresa.nombre}`, subtitulo: `${diaDe(fecha)} ${fecha}`,
        resumen: [{ etiqueta: 'Cierres hechos', valor: cierres.length, tipo: 'entero' }, { etiqueta: 'Ventas cerradas', valor: r2(cierres.reduce((s, c) => s + num(c.total_ventas), 0)), tipo: 'moneda' },
          { etiqueta: 'Cierres con diferencia', valor: conDif.length, tipo: 'entero' }, { etiqueta: 'Diferencia neta', valor: r2(cierres.reduce((s, c) => s + num(c.diferencia), 0)), tipo: 'moneda' },
          { etiqueta: 'Sucursales sin cierre', valor: sinCierre.length, tipo: 'entero' }],
        secciones, notas: [], vacio: cierres.length === 0 && sinCierre.length === 0,
      };
    },
  },

  gelato_consumido: {
    nombre: 'Gelato consumido', descripcion: 'Kilos de gelato enviados y consumidos por sucursal y sabor, cruzado con la venta (merma probable).',
    permiso: 'rep:ver', modulo: 'rep_consumo', parametros: ['dias'],
    async generar({ db, empresa, hoy, params }) {
      const { desde, hasta } = resolverRangoRep(params, hoy, 7);
      const c = await consumoDeRango(db, empresa.id, { desde, hasta });
      return {
        titulo: `Gelato consumido · ${empresa.nombre}`, subtitulo: `${desde} al ${hasta}`,
        resumen: [{ etiqueta: 'Consumido (kg)', valor: c.totales.consumoKg, tipo: 'numero' }, { etiqueta: 'Enviado (kg)', valor: c.totales.enviadoKg, tipo: 'numero' }, { etiqueta: 'Ventas', valor: c.totales.ventasLps, tipo: 'moneda' }],
        secciones: [
          { titulo: 'Por sucursal', columnas: [COL.texto('nombre', 'Sucursal'), COL.numero('enviadoKg', 'Enviado (kg)'), COL.numero('consumoKg', 'Consumido (kg)'), COL.entero('nochesMedidas', 'Noches medidas'), COL.moneda('ventasLps', 'Ventas'), COL.numero('gramosPorCienLps', 'g por cada L 100'), COL.pct('desviacionPct', 'Frente a la mediana'), COL.texto('alerta', 'Alerta')],
            filas: c.sucursales.map((s) => ({ ...s, gramosPorCienLps: s.cruce?.gramosPorCienLps ?? null, alerta: s.alerta ? 'Consume mucho más por lempira vendido' : '' })) },
          ...(c.sabores.length ? [{ titulo: 'Por sabor', columnas: [COL.texto('nombre', 'Sabor'), COL.numero('consumoKg', 'Consumido (kg)'), COL.numero('entradaKg', 'Entró (kg)')], filas: c.sabores.slice(0, 40) }] : []),
        ],
        notas: ['El consumo se mide por diferencia de pesajes nocturnos; las noches sin pesaje consecutivo no cuentan.'], vacio: c.totales.consumoKg === 0 && c.totales.enviadoKg === 0,
      };
    },
  },

  documentos_por_vencer: {
    nombre: 'Documentos por vencer', descripcion: 'Contratos, permisos y registros vencidos o que vencen pronto. No se envía si no hay ninguno.',
    permiso: 'doc:ver', modulo: 'documentos', parametros: ['dias'], omitirSiVacio: true,
    async generar({ db, empresa, sucursalIds, hoy, params, restringidos = false }) {
      const dias = [30, 60, 90].includes(Number(params.dias)) ? Number(params.dias) : 30;
      const filas = await proximos(db, empresa.id, { hoy, dias, verRestringido: restringidos, sucursalIds, limite: 300 });
      const vencidos = filas.filter((d) => d.fecha_vencimiento < hoy).length;
      return {
        titulo: `Documentos por vencer · ${empresa.nombre}`, subtitulo: `Vencidos y que vencen en los próximos ${dias} días`,
        resumen: [{ etiqueta: 'Vencidos', valor: vencidos, tipo: 'entero' }, { etiqueta: 'Por vencer', valor: filas.length - vencidos, tipo: 'entero' }],
        secciones: filas.length ? [{ titulo: 'Documentos', columnas: [COL.texto('titulo', 'Documento'), COL.texto('tipo_nombre', 'Tipo'), COL.texto('numero', 'Número'), COL.texto('sucursal', 'Sucursal'), COL.fecha('fecha_vencimiento', 'Vence'), COL.entero('dias_restantes', 'Días'), COL.texto('situacion', 'Situación')],
          filas: filas.map((d) => { const dr = Math.round((Date.parse(d.fecha_vencimiento) - Date.parse(hoy)) / 86400000); return { ...d, dias_restantes: dr, situacion: dr < 0 ? 'Vencido' : 'Por vencer' }; }) }] : [],
        notas: [], vacio: filas.length === 0,
      };
    },
  },

  resumen_grupo: {
    nombre: 'Resumen del grupo', descripcion: 'Las empresas que consolidas: ventas del día, comparación con la semana pasada, ticket, margen y alertas.',
    permiso: 'grupo:ver', modulo: null, ambito: 'grupo', parametros: ['dia'],
    async generar({ db, hoy, empresasGrupo = [], params }) {
      const fecha = resolverDia(params, hoy);
      const filas = [];
      const alertas = [];
      for (const e of empresasGrupo) {
        // Se mide el día completo pedido: la «hora de corte» se fija al final del día para que ayer cuente completo.
        const t = await tableroEmpresa(db, { empresaId: e.id, ahora: fecha === hoy ? new Date() : new Date(`${sumarDias(fecha, 1)}T05:59:00Z`) });
        const d = t.hoy;
        filas.push({ empresa: e.nombre, ventas: d.total, facturas: d.facturas, ticket: d.ticket_promedio, margen: d.margen_pct, semana: t.semana_pasada.total_corte, vs: t.vs_semana_pasada.misma_hora.pct });
        if (fecha === hoy) alertas.push(...await alertasEmpresa(db, { empresaId: e.id, empresaNombre: e.nombre, hoy, ver: { cai: true, inventario: true, caja: true, antifraude: true, documentos: true } }));
      }
      const total = r2(filas.reduce((s, f) => s + f.ventas, 0));
      return {
        titulo: 'Resumen del grupo', subtitulo: `${diaDe(fecha)} ${fecha}`,
        resumen: [{ etiqueta: 'Ventas del grupo', valor: total, tipo: 'moneda' }, { etiqueta: 'Facturas', valor: filas.reduce((s, f) => s + f.facturas, 0), tipo: 'entero' }],
        secciones: [
          { titulo: 'Por empresa', columnas: [COL.texto('empresa', 'Empresa'), COL.moneda('ventas', 'Ventas'), COL.entero('facturas', 'Facturas'), COL.moneda('ticket', 'Ticket promedio'), COL.pct('margen', 'Margen'), COL.moneda('semana', 'Mismo día semana pasada'), COL.pct('vs', 'Variación')], filas },
          ...(alertas.length ? [{ titulo: 'Alertas', columnas: [COL.texto('empresa', 'Empresa'), COL.texto('titulo', 'Alerta'), COL.texto('detalle', 'Detalle')], filas: alertas }] : []),
        ],
        notas: ['Suma de las ventas de cada empresa; no descuenta operaciones entre empresas del grupo.', NOTA_BORRADOR], vacio: false,
      };
    },
  },
};

export const CATALOGO = REPORTES;
export const listarCatalogo = () => Object.entries(REPORTES).map(([id, r]) => ({ id, nombre: r.nombre, descripcion: r.descripcion, permiso: r.permiso, ambito: r.ambito ?? 'empresa', parametros: r.parametros, omitirSiVacio: Boolean(r.omitirSiVacio) }));

export async function generarReporte(tipo, contexto) {
  const def = REPORTES[tipo];
  if (!def) throw Object.assign(new Error('Ese reporte no existe'), { status: 400 });
  const rep = await def.generar({ hoy: fechaHN(), params: {}, ...contexto });
  return { tipo, omitirSiVacio: Boolean(def.omitirSiVacio), ...rep };
}

export { fechaHN };
