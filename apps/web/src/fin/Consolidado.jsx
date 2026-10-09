// Finanzas consolidadas del grupo (pestaña «Finanzas del grupo» de Dirección).
import { useState } from 'react';
import { fechaHN } from '@grupo/shared';
import { Estado, Kpi, useAccion, useDatos } from '../ui/kit.jsx';
import { get, put, qs } from '../api.js';
import { BarraApilada, BotonExcel, SelectorPeriodo, fmt, neg } from './comun.jsx';

const SEG_COBRAR = [['0-30', '0-30 días', 'fin-c1'], ['31-60', '31-60 días', 'fin-c2'], ['61-90', '61-90 días', 'fin-c3'], ['+90', 'Más de 90', 'fin-c4']];
const SEG_PAGAR = [['vencido', 'Vencido', 'fin-c4'], ['0-7', 'Vence en 7 días', 'fin-c3'], ['8-30', '8 a 30 días', 'fin-c2'], ['+30', 'Más de 30', 'fin-c1']];
const Punto = ({ color }) => <i className="fin-punto" style={{ background: color, marginRight: 8 }} />;

export default function Consolidado() {
  const hoy = fechaHN();
  const [rango, setRango] = useState([`${hoy.slice(0, 8)}01`, hoy]);
  const [desde, hasta] = rango;
  const d = useDatos(() => get(`/grupo/finanzas/consolidado${qs({ desde, hasta })}`), [desde, hasta]);
  const [ejecutar] = useAccion();
  return (
    <Estado d={d}>{(c) => {
      const t = c.total;
      const hayPres = c.empresas.some((e) => e.presupuesto.hay_presupuesto);
      return (
        <>
          <div className="fila espacio">
            <SelectorPeriodo desde={desde} hasta={hasta} onCambio={(a, b) => setRango([a, b])} />
            <BotonExcel ruta={`/grupo/finanzas/exportar${qs({ desde, hasta })}`} nombre={`consolidado-${desde}.xlsx`} etiqueta="Excel del consolidado" />
          </div>
          <div className="rejilla cols-4">
            <Kpi acento etiqueta="Ventas netas consolidadas" valor={fmt(t.ventas_consolidadas)} sub={t.eliminacion > 0 ? `Sin contar ${fmt(t.eliminacion)} entre empresas` : `${t.resultados.facturas} facturas`} />
            <Kpi etiqueta="Utilidad operativa" tono={t.utilidad_consolidada < 0 ? 'mal' : undefined} valor={fmt(t.utilidad_consolidada)} sub={t.resultados.ventas_netas ? `${Math.round((t.utilidad_consolidada / t.ventas_consolidadas) * 1000) / 10} % de las ventas` : ''} />
            <Kpi etiqueta="Flujo neto de caja" tono={t.flujo.neto < 0 ? 'mal' : 'ok'} valor={fmt(t.flujo.neto)} sub={`Entró ${fmt(t.flujo.entradas)} · salió ${fmt(t.flujo.salidas)}`} />
            <Kpi etiqueta="Por cobrar / por pagar" valor={fmt(t.cobrar.total)} sub={`Por pagar ${fmt(t.pagar.total)}${t.pagar.vencido > 0 ? ` · vencido ${fmt(t.pagar.vencido)}` : ''}`} />
          </div>

          <h2>Estado de resultados del grupo</h2>
          <div className="tarjeta pad0"><div className="tabla-wrap libre"><table data-tarjetas>
            <thead><tr><th>Empresa</th><th className="der">Ventas netas</th><th className="der">Costo de ventas</th><th className="der">Utilidad bruta</th><th className="der">Gastos</th><th className="der">Utilidad operativa</th></tr></thead>
            <tbody>
              {c.empresas.map((e) => (
                <tr key={e.codigo}><td data-etq=""><Punto color={e.color} />{e.nombre}</td><td className="der num" data-etq="Ventas netas">{fmt(e.resultados.ventas_netas)}</td><td className="der num" data-etq="Costo">{fmt(e.resultados.costo_ventas)}</td>
                  <td className="der num" data-etq="Utilidad bruta">{fmt(e.resultados.utilidad_bruta)}</td><td className="der num" data-etq="Gastos">{fmt(e.resultados.gastos_operativos)}</td>
                  <td className={`der num ${neg(e.resultados.utilidad_operativa) ?? ''}`} data-etq="Utilidad op."><b>{fmt(e.resultados.utilidad_operativa)}</b></td></tr>))}
              <tr className="fin-sub"><td data-etq="">Suma de las empresas</td><td className="der num" data-etq="Ventas netas">{fmt(t.resultados.ventas_netas)}</td><td className="der num" data-etq="Costo">{fmt(t.resultados.costo_ventas)}</td><td className="der num" data-etq="Utilidad bruta">{fmt(t.resultados.utilidad_bruta)}</td><td className="der num" data-etq="Gastos">{fmt(t.resultados.gastos_operativos)}</td><td className="der num" data-etq="Utilidad op.">{fmt(t.resultados.utilidad_operativa)}</td></tr>
              <tr className="fin-sub"><td data-etq="">Menos: operaciones entre empresas</td><td className="der num" data-etq="Ventas netas">−{fmt(t.eliminacion)}</td><td className="der num" data-etq="Costo y gastos" colSpan={3}>−{fmt(t.eliminacion)} en compras y gastos de la empresa que las recibe</td><td className="der num" data-etq="Utilidad op.">{fmt(0)}</td></tr>
              <tr className="fin-total"><td data-etq="">Grupo consolidado</td><td className="der num" data-etq="Ventas netas">{fmt(t.ventas_consolidadas)}</td><td className="der num" data-etq="Costos y gastos" colSpan={3}>{fmt(t.costos_y_gastos_consolidados)}</td><td className={`der num ${neg(t.utilidad_consolidada) ?? ''}`} data-etq="Utilidad op.">{fmt(t.utilidad_consolidada)}</td></tr>
            </tbody>
          </table></div></div>
          <p className="fin-nota">Eliminar una venta interna la quita de las ventas de una empresa y del costo o gasto de la otra, por eso la utilidad del grupo no cambia: solo deja de inflarse la venta.</p>

          <div className="rejilla cols-2">
            <div className="tarjeta pad0"><table data-tarjetas><thead><tr><th>Flujo de caja</th><th className="der">Entradas</th><th className="der">Salidas</th><th className="der">Neto</th></tr></thead>
              <tbody>{c.empresas.map((e) => <tr key={e.codigo}><td data-etq=""><Punto color={e.color} />{e.nombre}</td><td className="der num" data-etq="Entradas">{fmt(e.flujo.entradas)}</td><td className="der num" data-etq="Salidas">{fmt(e.flujo.salidas)}</td><td className={`der num ${neg(e.flujo.neto) ?? ''}`} data-etq="Neto">{fmt(e.flujo.neto)}</td></tr>)}
                <tr className="fin-total"><td data-etq="">Grupo</td><td className="der num" data-etq="Entradas">{fmt(t.flujo.entradas)}</td><td className="der num" data-etq="Salidas">{fmt(t.flujo.salidas)}</td><td className={`der num ${neg(t.flujo.neto) ?? ''}`} data-etq="Neto">{fmt(t.flujo.neto)}</td></tr></tbody></table></div>
            <div className="tarjeta" style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
              <div><h3>Por cobrar</h3><BarraApilada segmentos={SEG_COBRAR.map(([k, etq, clase]) => ({ etq, valor: t.cobrar.buckets[k], clase }))} /></div>
              <div><h3>Por pagar</h3><BarraApilada segmentos={SEG_PAGAR.map(([k, etq, clase]) => ({ etq, valor: t.pagar.buckets[k], clase }))} /></div>
            </div>
          </div>

          <div className="rejilla cols-2">
            {c.empresas.map((e) => (
              <section key={e.codigo} className="tarjeta fin-empresa" style={{ '--c': e.color, display: 'grid', gap: 12 }}>
                <div className="fila espacio"><h3>{e.nombre}</h3>{e.pagar.vencido > 0 && <span className="chip mal">pagos vencidos {fmt(e.pagar.vencido)}</span>}</div>
                <div className="rejilla cols-2" style={{ gap: 10 }}>
                  <div className="fin-mini"><small>Por cobrar</small><b>{fmt(e.cobrar.total)}</b>{e.cobrar.buckets['+90'] > 0 && <small className="fin-neg">{fmt(e.cobrar.buckets['+90'])} con más de 90 días</small>}</div>
                  <div className="fin-mini"><small>Por pagar</small><b>{fmt(e.pagar.total)}</b></div>
                </div>
                {e.presupuesto.hay_presupuesto ? (
                  <div className="fin-mini"><small>Presupuesto de {e.presupuesto.mes.slice(0, 7)}: ventas {fmt(e.presupuesto.ventas_real)} de {fmt(e.presupuesto.ventas_presupuesto)}</small>
                    <div className="fin-pres-barra"><i className={e.presupuesto.ventas_proyeccion >= e.presupuesto.ventas_presupuesto ? '' : 'riesgo'} style={{ width: `${Math.min(100, e.presupuesto.ventas_presupuesto ? (e.presupuesto.ventas_real / e.presupuesto.ventas_presupuesto) * 100 : 0)}%` }} /></div>
                    <small>Gastos {fmt(e.presupuesto.gastos_real)} de {fmt(e.presupuesto.gastos_presupuesto)}</small>
                    <div className="fin-pres-barra"><i className={e.presupuesto.gastos_real > e.presupuesto.gastos_presupuesto ? 'excedido' : ''} style={{ width: `${Math.min(100, e.presupuesto.gastos_presupuesto ? (e.presupuesto.gastos_real / e.presupuesto.gastos_presupuesto) * 100 : 0)}%` }} /></div></div>
                ) : <small className="fin-nota">Sin presupuesto este mes.</small>}
              </section>
            ))}
          </div>
          {!hayPres && <small className="fin-nota">Para ver el avance del presupuesto, define el presupuesto del mes en Finanzas de cada empresa.</small>}

          <h2>Entre empresas</h2>
          {c.interco.saldos.length === 0 && c.interco.pendientes_conciliar.length === 0 ? <div className="tarjeta vacio">Sin saldos ni operaciones por conciliar.</div> : (
            <>
              {c.interco.saldos.length > 0 && <div className="tarjeta">{c.interco.saldos.map((s) => <div key={s.deudor + s.acreedor} className="fila espacio"><span><b>{s.deudor_nombre}</b> le debe a <b>{s.acreedor_nombre}</b> <small>({s.operaciones} operaciones{s.sin_conciliar ? `, ${s.sin_conciliar} sin conciliar` : ''})</small></span><b className="num">{fmt(s.saldo)}</b></div>)}</div>}
              {c.interco.pendientes_conciliar.length > 0 && (
                <div className="tarjeta pad0"><div className="tabla-wrap libre"><table data-tarjetas>
                  <thead><tr><th>Fecha</th><th>Cobra</th><th>Debe</th><th>Concepto</th><th className="der">Pendiente</th><th></th></tr></thead>
                  <tbody>{c.interco.pendientes_conciliar.map((o) => (
                    <tr key={o.id}><td className="num" data-etq="">{o.fecha}</td><td data-etq="Cobra">{o.origen}</td><td data-etq="Debe">{o.destino}</td><td data-etq="Concepto">{o.concepto}</td><td className="der num" data-etq="Pendiente">{fmt(o.pendiente)}</td>
                      <td className="der" data-etq=""><button className="btn chico" onClick={async () => { if (await ejecutar(() => put(`/grupo/intercompania/${o.id}/conciliar`), 'Conciliada')) d.recargar(); }}>Conciliar</button></td></tr>))}</tbody>
                </table></div></div>
              )}
            </>
          )}
        </>
      );
    }}</Estado>
  );
}
