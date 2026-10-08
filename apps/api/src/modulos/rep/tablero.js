// Tablero de gelato: la noche de un vistazo para dueño, administrador y manager.
// Solo lectura. Junta lo que ya existe (pesajes, despachos, pedidos, rotación, inventario, incidencias) en UNA respuesta.
import { Router } from 'express';
import { fechaHN, horaDeHN, nocheDeTrabajo, sumarDias } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { validar, fechaISO } from '../../lib/http.js';
import { CLASIFICACION } from './lib/rotacion.js';
import { PERM_ADMIN, empresaDe, listarSucursales } from './util.js';
import { consumoDeRango, opcional, rotacionDeSabores } from './datos.js';
import { planProduccionDeDatos } from '../prod/plan.js';

/** Hora (HN) desde la que se arma el despacho: antes de esta hora la noche anterior todavía se considera abierta. */
export const HORA_ARMADO_DESPACHO = 6;
const DIAS_RACHA = 7;
const diaCorto = (f) => { const [y, m, d] = f.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('es-HN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }); };
const dif = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

/**
 * Estado de una tienda en la noche: 'completo' (pesó todo) · 'parcial' (pesó parte) · 'pendiente' (la noche sigue abierta) · 'falta'.
 * Sin hora fija: «falta» solo cuando se llega al momento de armar el despacho (la mañana siguiente, noche ya cerrada) sin pesaje.
 * Las que no entran al análisis (la fábrica Los Andes) nunca se pintan de rojo: se informan en neutro.
 */
export function estadoDeTienda({ pesados, esperados, abierta, fuera = false }) {
  if (pesados > 0) return esperados > 0 && pesados < esperados ? 'parcial' : 'completo';
  if (fuera) return 'opcional';
  return abierta ? 'pendiente' : 'falta';
}

export function rutasTablero({ db }) {
  const r = Router();

  r.get('/', requierePermiso(PERM_ADMIN), async (req, res) => {
    const emp = empresaDe(req);
    const ahora = new Date();
    const hoy = fechaHN(ahora);
    const hora = horaDeHN(ahora);
    const fecha = req.query.fecha ? validar(fechaISO, req.query.fecha) : nocheDeTrabajo(ahora).fecha;
    const esHoy = fecha === hoy;
    // La noche está abierta mientras sea hoy, o de madrugada (antes de que se arme el despacho).
    const abierta = esHoy || (fecha === sumarDias(hoy, -1) && hora < HORA_ARMADO_DESPACHO);
    const desdeRacha = sumarDias(fecha, -(DIAS_RACHA - 1));

    const [sucursales, esperadosF, pesajesF, despachos, pedidos, porRecibir, discrepancias, rotacion, bajoMinimoF, incidencias, mantenimiento, consumo, produccionHoy] = await Promise.all([
      listarSucursales(db, req.ctx),
      db.query(`select ss.sucursal_id, count(*)::int as n from rep.sucursal_sabores ss join rep.sabores sa on sa.id = ss.sabor_id
                 where ss.empresa_id = $1 and ss.activo and sa.activo group by ss.sucursal_id`, [emp]).then((x) => x.rows),
      // Un pesaje hecho después de la medianoche lleva la fecha del día nuevo; si es de madrugada (antes del mediodía) sigue siendo el de esa noche.
      db.query(`select sucursal_id, (case when fecha > $3::date then $3::date else fecha end)::text as fecha, count(distinct sabor_id)::int as sabores, max(created_at) as reportado_en
                  from rep.pesajes where empresa_id = $1 and (fecha between $2 and $3 or (fecha = $3::date + 1 and created_at < ((($3::date + 1)::timestamp + interval '18 hours') at time zone 'UTC')))
                 group by sucursal_id, 2`, [emp, desdeRacha, fecha]).then((x) => x.rows),
      db.query(`select d.id, d.sucursal_id, d.categoria, d.panas, d.estado, d.discrepancia::int as discrepancia, sa.nombre as sabor_nombre
                  from rep.despachos d join rep.sabores sa on sa.id = d.sabor_id where d.empresa_id = $1 and d.fecha = $2`, [emp, fecha]).then((x) => x.rows),
      db.query(`select p.sucursal_id, p.estado, count(i.id) filter (where not i.enviado)::int as sin_enviar, count(i.id)::int as items
                  from rep.pedidos_insumos p left join rep.pedido_items i on i.pedido_id = p.id where p.empresa_id = $1 and p.fecha = $2 group by p.sucursal_id, p.estado`, [emp, fecha]).then((x) => x.rows),
      // Enviado desde fábrica y todavía sin confirmar por la tienda (últimos 4 días).
      db.query(`select d.sucursal_id, su.nombre as sucursal_nombre, sa.nombre as sabor_nombre, d.panas, d.enviado_en::text as enviado_en
                  from rep.despachos d join rep.sabores sa on sa.id = d.sabor_id join core.sucursales su on su.id = d.sucursal_id
                 where d.empresa_id = $1 and d.estado = 'enviado' and d.enviado_en >= $2 order by d.enviado_en, su.nombre`, [emp, sumarDias(hoy, -4)]).then((x) => x.rows),
      db.query(`select d.id, d.fecha::text as fecha, su.nombre as sucursal_nombre, sa.nombre as sabor_nombre, d.panas, d.panas_recibidas
                  from rep.despachos d join rep.sabores sa on sa.id = d.sabor_id join core.sucursales su on su.id = d.sucursal_id
                 where d.empresa_id = $1 and d.discrepancia and not d.discrepancia_resuelta and d.fecha >= $2 order by d.fecha desc`, [emp, sumarDias(hoy, -14)]).then((x) => x.rows),
      rotacionDeSabores(db, emp, { desde: sumarDias(fecha, -29), hasta: fecha, hoy: fecha }).catch(() => ({ sabores: [] })),
      opcional(db, `select id, nombre, unidad, stock_actual::float8 as stock_actual, stock_minimo::float8 as stock_minimo from rinv.insumos_fab
                     where empresa_id = $1 and activo and not es_equipo and stock_minimo is not null and coalesce(stock_actual,0) < stock_minimo
                     order by coalesce(stock_actual,0) / nullif(stock_minimo,0)`, [emp]),
      opcional(db, `select gravedad, count(*)::int as n from rinv.incidencias where empresa_id = $1 and estado <> 'cerrada' group by gravedad`, [emp]),
      opcional(db, `select count(*)::int as n from rinv.mantenimientos where empresa_id = $1 and not listo`, [emp]),
      consumoDeRango(db, emp, { desde: sumarDias(fecha, -6), hasta: fecha }).catch(() => null),
      planProduccionDeDatos(db, emp, { desde: sumarDias(hoy, -90), hasta: hoy, hoy, horizonteDias: 1 }).then((p) => p.porDia?.[0] ?? null).catch(() => null),
    ]);

    // ── Semáforo por sucursal ──
    const esperados = new Map(esperadosF.map((f) => [f.sucursal_id, f.n]));
    const porSuc = new Map();
    for (const f of pesajesF) { if (!porSuc.has(f.sucursal_id)) porSuc.set(f.sucursal_id, []); porSuc.get(f.sucursal_id).push(f); }
    const tiendas = sucursales.filter((s) => (esperados.get(s.id) ?? 0) > 0 || s.tipo === 'tienda').map((s) => {
      const filas = porSuc.get(s.id) ?? [];
      const deNoche = filas.find((f) => f.fecha === fecha);
      const pesados = deNoche?.sabores ?? 0;
      const ultima = filas.map((f) => f.fecha).sort().pop() ?? null;
      const ds = despachos.filter((d) => d.sucursal_id === s.id);
      const pend = ds.filter((d) => d.estado === 'pendiente' || d.estado === 'preparado');
      const ped = pedidos.filter((p) => p.sucursal_id === s.id);
      return {
        id: s.id, nombre: s.nombre, tipo: s.tipo, fuera_de_analisis: s.fuera_de_analisis,
        estado: estadoDeTienda({ pesados, esperados: esperados.get(s.id) ?? 0, abierta, fuera: s.fuera_de_analisis }),
        pesados, esperados: esperados.get(s.id) ?? 0, reportado_en: deNoche?.reportado_en ?? null,
        ultima_noche: ultima, noches_sin_reporte: ultima ? dif(fecha, ultima) : null, noches_con_reporte_7d: filas.length,
        rojas: ds.filter((d) => d.categoria === 'roja' && d.estado !== 'no_disponible').length,
        amarillas: ds.filter((d) => d.categoria === 'amarilla' && d.estado !== 'no_disponible').length,
        panas_por_armar: pend.reduce((a, d) => a + d.panas, 0),
        insumos_por_juntar: ped.filter((p) => p.estado !== 'recibido').reduce((a, p) => a + p.sin_enviar, 0),
        pidio_insumos: ped.length > 0,
      };
    });
    const cuenta = (e) => tiendas.filter((t) => t.estado === e).length;

    // ── Despacho de la noche ──
    const pendientes = despachos.filter((d) => d.estado === 'pendiente' || d.estado === 'preparado');
    const porSabor = new Map();
    for (const d of pendientes) porSabor.set(d.sabor_nombre, (porSabor.get(d.sabor_nombre) ?? 0) + d.panas);
    const despacho = {
      sabores_totales: despachos.filter((d) => d.estado !== 'no_disponible').length,
      pendientes: pendientes.length,
      panas_por_armar: pendientes.reduce((a, d) => a + d.panas, 0),
      enviados: despachos.filter((d) => d.estado === 'enviado' || d.estado === 'recibido').length,
      recibidos: despachos.filter((d) => d.estado === 'recibido').length,
      no_disponibles: despachos.filter((d) => d.estado === 'no_disponible').length,
      insumos_por_juntar: pedidos.filter((p) => p.estado !== 'recibido').reduce((a, p) => a + p.sin_enviar, 0),
      top_sabores: [...porSabor.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([nombre, panas]) => ({ nombre, panas })),
    };

    // ── Qué producir hoy (plan de Producción: salida de mañana − lo que hay en cámara) ──
    const producir = produccionHoy ? { panas: produccionHoy.totalPanas, kg: produccionHoy.totalKg, sabores: produccionHoy.sabores.slice(0, 6).map((s) => ({ nombre: s.nombre, panas: s.panas, kg: s.kg })) } : null;

    // ── Consumo de la última noche medida, por sucursal ──
    const estadoPor = new Map(tiendas.map((t) => [t.id, t.estado]));
    const consumoAyer = (consumo?.sucursales ?? []).map((s) => {
      // Si la tienda todavía no terminó de pesar esta noche, el consumo de esta noche saldría incompleto: se muestra el de la anterior.
      const dias = [...(s.porDia ?? [])].filter((d) => estadoPor.get(s.sucursal_id) === 'completo' || d.fecha < fecha).sort((a, b) => a.fecha.localeCompare(b.fecha));
      const ultimoDia = dias.pop() ?? null;
      return { sucursal_id: s.sucursal_id, nombre: s.nombre, fecha: ultimoDia?.fecha ?? null, consumoKg: ultimoDia?.consumoKg ?? null, ventasLps: ultimoDia?.ventasLps ?? null, noches_medidas_7d: (s.porDia ?? []).length };
    }).filter((s) => s.consumoKg != null).sort((a, b) => b.consumoKg - a.consumoKg);

    // ── Alertas (lo que el dueño tiene que mirar), de más a menos grave ──
    const alertas = [];
    for (const t of tiendas.filter((x) => x.estado === 'falta')) {
      alertas.push({ id: `sin-pesar-${t.id}`, tono: 'mal', titulo: `${t.nombre} no envió su pesaje`, detalle: t.noches_sin_reporte != null && t.noches_sin_reporte > 1 ? `Lleva ${t.noches_sin_reporte} noches sin pesar.` : t.ultima_noche ? 'Anoche sí lo hizo.' : 'No hay pesajes en la última semana.', ir: 'pesaje' });
    }
    if (discrepancias.length) alertas.push({ id: 'discrepancias', tono: 'mal', titulo: `${discrepancias.length} discrepancia${discrepancias.length === 1 ? '' : 's'} de recepción sin resolver`, detalle: discrepancias.slice(0, 3).map((d) => `${d.sucursal_nombre} · ${d.sabor_nombre}: enviadas ${d.panas}, llegaron ${d.panas_recibidas ?? '?'}`).join(' | '), ir: 'consumo', tab: 'panorama' });
    const viejas = porRecibir.filter((d) => d.enviado_en < hoy);
    for (const [nombre, lista] of Object.entries(Object.groupBy(viejas, (d) => d.sucursal_nombre))) {
      alertas.push({ id: `sin-confirmar-${nombre}`, tono: 'aviso', titulo: `${nombre}: ${lista.length} sabor${lista.length === 1 ? '' : 'es'} enviado${lista.length === 1 ? '' : 's'} sin confirmar`, detalle: `Salieron de fábrica el ${diaCorto(lista[0].enviado_en)} y la tienda no marcó que llegaron.`, ir: 'pesaje' });
    }
    // Incidencias: ya no se usan en la operación; el módulo se quitó del menú y no genera alertas.
    const faltaStock = rotacion.sabores.filter((s) => s.clasificacion === CLASIFICACION.FALTA_STOCK);
    if (faltaStock.length) alertas.push({ id: 'falta-stock', tono: 'aviso', titulo: `${faltaStock.length} sabor${faltaStock.length === 1 ? '' : 'es'} se pidieron y no había`, detalle: `${faltaStock.slice(0, 4).map((s) => s.nombre).join(', ')}: conviene producir más.`, ir: 'gelato-produccion', tab: 'plan' });
    const parados = rotacion.sabores.filter((s) => s.clasificacion === CLASIFICACION.MUERTO || s.clasificacion === CLASIFICACION.LENTO);
    if (parados.length) alertas.push({ id: 'parados', tono: 'aviso', titulo: `${parados.length} sabor${parados.length === 1 ? '' : 'es'} sin moverse`, detalle: `${parados.slice(0, 4).map((s) => s.nombre).join(', ')}: producidos en 30 días y casi no salieron.`, ir: 'consumo', tab: 'rotacion' });
    if (bajoMinimoF.length) alertas.push({ id: 'insumos-bajos', tono: 'aviso', titulo: `${bajoMinimoF.length} insumo${bajoMinimoF.length === 1 ? '' : 's'} bajo el mínimo`, detalle: bajoMinimoF.slice(0, 3).map((i) => i.nombre).join(', '), ir: 'gelato-inventario' });
    if (mantenimiento[0]?.n) alertas.push({ id: 'mantenimiento', tono: 'aviso', titulo: `${mantenimiento[0].n} mantenimiento${mantenimiento[0].n === 1 ? '' : 's'} pendiente${mantenimiento[0].n === 1 ? '' : 's'}`, detalle: 'Equipos y checklist.', ir: 'mantenimiento' });

    res.json({
      hoy, hora, noche: { fecha, esHoy, abierta },
      semaforo: { completo: cuenta('completo'), parcial: cuenta('parcial'), pendiente: cuenta('pendiente'), falta: cuenta('falta'), opcional: cuenta('opcional'), total: tiendas.length },
      tiendas, despacho, producir,
      por_recibir: porRecibir.map((d) => ({ sucursal: d.sucursal_nombre, sabor: d.sabor_nombre, panas: d.panas, enviado_en: d.enviado_en })),
      discrepancias, alertas, consumo: consumoAyer, hay_ventas: Boolean(consumo?.hayVentas),
    });
  });

  return r;
}
