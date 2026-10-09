import { BarrasH, Estado, Kpi, useDatos } from '../ui/kit.jsx';
import { get, qs } from '../api.js';
import { BotonExcel, fmt, neg } from './comun.jsx';

export const GRUPOS = { costo_venta: 'Compras de mercadería', operativo: 'Operación', nomina: 'Planilla', alquiler: 'Alquiler', servicios: 'Servicios', marketing: 'Publicidad', impuestos: 'Impuestos y permisos', financiero: 'Financieros', otro: 'Otros', sin_categoria: 'Sin categoría' };

function Fila({ n, d, clase }) {
  return (
    <tr className={clase}>
      <td data-etq="">{n}</td><td className="der num" data-etq="Ventas netas">{fmt(d.ventas_netas ?? 0)}</td><td className="der num" data-etq="Costo de ventas">{fmt(d.costo_ventas ?? 0)}</td>
      <td className="der num" data-etq="Utilidad bruta">{fmt(d.utilidad_bruta ?? 0)}</td><td className="der num" data-etq="Margen">{d.margen_bruto_pct == null ? '—' : `${d.margen_bruto_pct} %`}</td>
      <td className="der num" data-etq="Gastos">{fmt(d.gastos_operativos ?? 0)}</td><td className={`der num ${neg(d.utilidad_operativa) ?? ''}`} data-etq="Utilidad operativa"><b>{d.utilidad_operativa === undefined ? '—' : fmt(d.utilidad_operativa)}</b></td>
    </tr>
  );
}

export default function Resultados({ desde, hasta }) {
  const d = useDatos(() => get(`/fin/estado-resultados${qs({ desde, hasta })}`), [desde, hasta]);
  return (
    <Estado d={d}>{(r) => {
      const t = r.total;
      const porGrupo = Object.values(r.categorias.reduce((a, c) => { (a[c.grupo] ??= { grupo: c.grupo, monto: 0 }).monto += c.monto; return a; }, {})).sort((a, b) => b.monto - a.monto);
      return (
        <>
          <div className="fila espacio"><span className="fin-nota">Ventas sin ISV; el costo sale de las recetas y costos de cada producto vendido.</span><BotonExcel ruta={`/fin/exportar${qs({ reporte: 'resultados', desde, hasta })}`} nombre={`estado-de-resultados-${desde}.xlsx`} /></div>
          <div className="rejilla cols-4">
            <Kpi acento etiqueta="Ventas netas (sin ISV)" valor={fmt(t.ventas_netas)} sub={`${t.facturas} facturas`} />
            <Kpi etiqueta="Costo de ventas" valor={fmt(t.costo_ventas)} sub={t.margen_bruto_pct == null ? '' : `Margen bruto ${t.margen_bruto_pct} %`} />
            <Kpi etiqueta="Gastos operativos" valor={fmt(t.gastos_operativos)} />
            <Kpi etiqueta="Utilidad operativa" tono={t.utilidad_operativa < 0 ? 'mal' : undefined} valor={fmt(t.utilidad_operativa)} sub={t.ventas_netas ? `${Math.round((t.utilidad_operativa / t.ventas_netas) * 1000) / 10} % de las ventas` : ''} />
          </div>
          {t.venta_sin_costo > 0 && <div className="aviso-caja">Hay {fmt(t.venta_sin_costo)} vendidos de productos sin receta ni costo: la utilidad se ve más alta de lo real. Completa las recetas en Inventario.</div>}
          <div className="tarjeta pad0"><div className="tabla-wrap libre"><table data-tarjetas>
            <thead><tr><th>Sucursal</th><th className="der">Ventas netas</th><th className="der">Costo de ventas</th><th className="der">Utilidad bruta</th><th className="der">Margen</th><th className="der">Gastos</th><th className="der">Utilidad operativa</th></tr></thead>
            <tbody>
              {r.sucursales.map((s) => <Fila key={s.id} n={s.nombre} d={s} />)}
              {r.general.gastos_operativos !== 0 && <Fila n="General (toda la empresa)" d={{ gastos_operativos: r.general.gastos_operativos, utilidad_operativa: -r.general.gastos_operativos }} clase="fin-sub" />}
              <Fila n="Total de la empresa" d={t} clase="fin-total" />
            </tbody>
          </table></div></div>
          <div className="rejilla cols-2">
            <div className="tarjeta"><h3>Utilidad operativa por sucursal</h3>
              <BarrasH datos={r.sucursales} etiqueta={(s) => s.nombre} valor={(s) => Math.max(0, s.utilidad_operativa)} formato={fmt} />
              {r.sucursales.some((s) => s.utilidad_operativa < 0) && <small className="fin-neg">Con pérdida: {r.sucursales.filter((s) => s.utilidad_operativa < 0).map((s) => `${s.nombre} (${fmt(s.utilidad_operativa)})`).join(', ')}</small>}
            </div>
            <div className="tarjeta"><h3>Gastos por tipo (sin ISV)</h3>
              {porGrupo.length ? <BarrasH datos={porGrupo} etiqueta={(g) => GRUPOS[g.grupo] ?? g.grupo} valor={(g) => g.monto} formato={fmt} /> : <small>Sin gastos en el periodo.</small>}
            </div>
          </div>
          {r.categorias.length > 0 && (
            <div className="tarjeta pad0"><div className="tabla-wrap libre"><table data-tarjetas>
              <thead><tr><th>Categoría de gasto</th><th>Tipo</th><th className="der">Registros</th><th className="der">Monto sin ISV</th></tr></thead>
              <tbody>{r.categorias.map((c) => <tr key={c.id ?? c.nombre}><td data-etq="">{c.nombre}</td><td data-etq="Tipo"><small>{GRUPOS[c.grupo] ?? c.grupo}</small></td><td className="der num" data-etq="Registros">{c.n}</td><td className="der num" data-etq="Monto">{fmt(c.monto)}</td></tr>)}</tbody>
            </table></div></div>
          )}
        </>
      );
    }}</Estado>
  );
}
