// Finanzas CONSOLIDADAS del grupo (Dirección): resultados por empresa, eliminación de operaciones internas, flujo de caja,
// por cobrar, por pagar, presupuesto del mes y saldos entre empresas. Solo lectura; usa las mismas funciones que Finanzas de cada empresa.
import { z } from 'zod';
import { fechaHN } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { validar, fechaISO } from '../../lib/http.js';
import { libroExcel, enviarLibro } from '../../lib/excel.js';
import { r2 } from '../compras/calculo.js';
import { BUCKETS_COBRAR, BUCKETS_PAGAR, cuentasPorCobrar, cuentasPorPagar, flujoCaja, netearSaldos, presupuestoVsReal } from './estados.js';
import { hojasConsolidado } from './excel.js';

const sumaObj = (objs, claves) => Object.fromEntries(claves.map((k) => [k, r2(objs.reduce((s, o) => s + (o[k] ?? 0), 0))]));

/** Pura: junta lo de cada empresa en un consolidado con eliminación de las operaciones entre empresas del grupo. */
export function consolidar(empresas, eliminacion) {
  const claves = ['facturas', 'ventas_netas', 'costo_ventas', 'utilidad_bruta', 'gastos_operativos', 'utilidad_operativa'];
  const resultados = sumaObj(empresas.map((e) => e.resultados), claves);
  resultados.margen_bruto_pct = resultados.ventas_netas > 0 ? Math.round((resultados.utilidad_bruta / resultados.ventas_netas) * 1000) / 10 : null;
  const costosYGastos = r2(resultados.costo_ventas + resultados.gastos_operativos);
  const ventasConsolidadas = r2(resultados.ventas_netas - eliminacion);
  const costosConsolidados = r2(costosYGastos - eliminacion);
  return {
    resultados, eliminacion, ventas_consolidadas: ventasConsolidadas, costos_y_gastos: costosYGastos, costos_y_gastos_consolidados: costosConsolidados,
    utilidad_consolidada: r2(ventasConsolidadas - costosConsolidados),
    flujo: sumaObj(empresas.map((e) => e.flujo), ['entradas', 'salidas', 'neto']),
    cobrar: { buckets: sumaObj(empresas.map((e) => e.cobrar.buckets), BUCKETS_COBRAR), total: r2(empresas.reduce((s, e) => s + e.cobrar.total, 0)), vencido: r2(empresas.reduce((s, e) => s + e.cobrar.vencido, 0)) },
    pagar: { buckets: sumaObj(empresas.map((e) => e.pagar.buckets), BUCKETS_PAGAR), total: r2(empresas.reduce((s, e) => s + e.pagar.total, 0)), vencido: r2(empresas.reduce((s, e) => s + e.pagar.vencido, 0)) },
  };
}

export function montarConsolidadoFin(r, { db }, empresasConsolidables, resultadosEmpresa) {
  const ver = requierePermiso('grupo:ver');
  const rango = z.object({ desde: fechaISO.optional(), hasta: fechaISO.optional() });

  async function armar(req) {
    const f = validar(rango, req.query);
    const hoy = fechaHN();
    const desde = f.desde ?? `${hoy.slice(0, 8)}01`, hasta = f.hasta ?? hoy;
    const lista = await empresasConsolidables(req.ctx.usuario);
    const ids = lista.map((e) => e.id);
    const empresas = [];
    for (const e of lista) {
      const [resultados, flujo, cobrar, pagar, pres] = await Promise.all([
        resultadosEmpresa(db, { empresaId: e.id, desde, hasta }),
        flujoCaja(db, { empresaId: e.id, desde, hasta, agrupar: 'mes' }),
        cuentasPorCobrar(db, { empresaId: e.id, hoy }),
        cuentasPorPagar(db, { empresaId: e.id, hoy }),
        presupuestoVsReal(db, resultadosEmpresa, { empresaId: e.id, mes: hoy.slice(0, 7), hoy }),
      ]);
      empresas.push({
        codigo: e.codigo, nombre: e.nombre, color: e.color, resultados, flujo: flujo.totales,
        cobrar: { buckets: cobrar.buckets, total: cobrar.total, vencido: cobrar.vencido, por_cliente: cobrar.por_cliente.slice(0, 5) },
        pagar: { buckets: pagar.buckets, total: pagar.total, vencido: pagar.vencido, por_proveedor: pagar.por_proveedor.slice(0, 5) },
        presupuesto: { mes: pres.mes, ventas_presupuesto: pres.ventas.presupuesto, ventas_real: pres.ventas.real, ventas_proyeccion: pres.ventas.proyeccion, gastos_presupuesto: pres.totales.gastos_presupuesto, gastos_real: pres.totales.gastos_real, hay_presupuesto: pres.totales.hay_presupuesto },
      });
    }
    // Operaciones entre empresas dentro del periodo: se eliminan de ambos lados; los saldos pendientes se netean por pareja.
    const ops = (await db.query(
      `select id, fecha::text as fecha, empresa_origen_id, empresa_destino_id, concepto, monto::float8 as monto, monto_pagado::float8 as monto_pagado, estado from fin.intercompania
        where empresa_origen_id = any($1::uuid[]) and empresa_destino_id = any($1::uuid[]) order by fecha desc`, [ids])).rows;
    const eliminacion = r2(ops.filter((o) => o.fecha >= desde && o.fecha <= hasta).reduce((s, o) => s + o.monto, 0));
    const nombre = (id) => lista.find((e) => e.id === id)?.nombre ?? '—';
    const saldos = netearSaldos(ops).map((s) => ({ ...s, deudor_nombre: nombre(s.deudor), acreedor_nombre: nombre(s.acreedor) }));
    const pendientes = ops.filter((o) => o.estado !== 'conciliado').slice(0, 20).map((o) => ({ ...o, origen: nombre(o.empresa_origen_id), destino: nombre(o.empresa_destino_id), pendiente: r2(o.monto - o.monto_pagado) }));
    return { desde, hasta, hoy, empresas, total: consolidar(empresas, eliminacion), interco: { saldos, pendientes_conciliar: pendientes, sin_conciliar: ops.filter((o) => o.estado !== 'conciliado').length } };
  }

  r.get('/finanzas/consolidado', ver, async (req, res) => res.json(await armar(req)));
  r.get('/finanzas/exportar', ver, async (req, res) => {
    const c = await armar(req);
    const { hojas, titulo, nombre } = hojasConsolidado(c);
    enviarLibro(res, await libroExcel({ titulo, subtitulo: `${c.desde} a ${c.hasta} · generado ${c.hoy}`, hojas }), `${nombre}.xlsx`);
  });
}
