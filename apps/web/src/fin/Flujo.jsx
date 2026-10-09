import { useState } from 'react';
import { Estado, Kpi, useDatos } from '../ui/kit.jsx';
import { get, qs } from '../api.js';
import { BotonExcel, GraficaFlujo, fmt, neg } from './comun.jsx';

export default function Flujo({ desde, hasta }) {
  const [agrupar, setAgrupar] = useState('');
  const d = useDatos(() => get(`/fin/flujo-caja${qs({ desde, hasta, agrupar })}`), [desde, hasta, agrupar]);
  return (
    <Estado d={d}>{(f) => (
      <>
        <div className="fila espacio">
          <div className="fin-barra"><label>Agrupar por<select value={agrupar} onChange={(e) => setAgrupar(e.target.value)}><option value="">Automático</option><option value="dia">Día</option><option value="semana">Semana</option><option value="mes">Mes</option></select></label></div>
          <BotonExcel ruta={`/fin/exportar${qs({ reporte: 'flujo', desde, hasta, agrupar })}`} nombre={`flujo-de-caja-${desde}.xlsx`} />
        </div>
        <div className="rejilla cols-3">
          <Kpi etiqueta="Entradas" tono="ok" valor={fmt(f.totales.entradas)} />
          <Kpi etiqueta="Salidas" valor={fmt(f.totales.salidas)} />
          <Kpi etiqueta="Flujo neto" tono={f.totales.neto < 0 ? 'mal' : 'ok'} valor={fmt(f.totales.neto)} />
        </div>
        {f.serie.length > 0 ? <div className="tarjeta"><h3>Entradas y salidas</h3><GraficaFlujo serie={f.serie} agrupar={f.agrupar} /></div> : <div className="tarjeta vacio">Sin movimientos de dinero en este periodo.</div>}
        <div className="rejilla cols-2">
          <div className="tarjeta pad0"><table><thead><tr><th>Entradas</th><th className="der">Total</th></tr></thead>
            <tbody>{f.entradas.map((c) => <tr key={c.concepto}><td>{c.concepto}</td><td className="der num">{fmt(c.total)}</td></tr>)}
              <tr className="fin-total"><td>Total entradas</td><td className="der num">{fmt(f.totales.entradas)}</td></tr></tbody></table></div>
          <div className="tarjeta pad0"><table><thead><tr><th>Salidas</th><th className="der">Total</th></tr></thead>
            <tbody>{f.salidas.map((c) => <tr key={c.concepto}><td>{c.concepto}</td><td className="der num">{fmt(c.total)}</td></tr>)}
              <tr className="fin-total"><td>Total salidas</td><td className="der num">{fmt(f.totales.salidas)}</td></tr></tbody></table></div>
        </div>
        {f.serie.length > 1 && (
          <div className="tarjeta pad0"><div className="tabla-wrap libre"><table data-tarjetas>
            <thead><tr><th>Periodo</th><th className="der">Entradas</th><th className="der">Salidas</th><th className="der">Neto</th><th className="der">Acumulado</th></tr></thead>
            <tbody>{f.serie.map((s) => <tr key={s.periodo}><td data-etq="">{s.periodo}</td><td className="der num" data-etq="Entradas">{fmt(s.entradas)}</td><td className="der num" data-etq="Salidas">{fmt(s.salidas)}</td>
              <td className={`der num ${neg(s.neto) ?? ''}`} data-etq="Neto">{fmt(s.neto)}</td><td className={`der num ${neg(s.acumulado) ?? ''}`} data-etq="Acumulado">{fmt(s.acumulado)}</td></tr>)}</tbody>
          </table></div></div>
        )}
        <p className="fin-nota">El flujo cuenta el dinero cuando se mueve: las ventas a crédito entran al cobrarse, los gastos por pagar salen al pagarse y las compras a crédito al pagarlas al proveedor. De la caja chica solo cuentan las salidas de efectivo; si un mismo gasto lo anotas en caja chica y en Gastos se cuenta dos veces, así que anótalo en uno solo.</p>
      </>
    )}</Estado>
  );
}
