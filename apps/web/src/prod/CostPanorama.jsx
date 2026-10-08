import { useState } from 'react';
import { get, post, qs } from '../api.js';
import { Columnas, BarrasH, Estado, Kpi, descargarCsv, useAccion, useDatos } from '../ui/kit.jsx';
import { hoyIso, kg, lps, nf } from './util.js';

export default function CostPanorama() {
  const fecha = hoyIso();
  const d = useDatos(() => get(`/prod/costeo/dashboard${qs({ fecha })}`), [fecha]);
  const [desde, setDesde] = useState(`${fecha.slice(0, 8)}01`);
  const [hasta, setHasta] = useState(fecha);
  const [rango, setRango] = useState(null);
  const [ejecutar, ocupado] = useAccion();
  return (
    <Estado d={d}>{(x) => {
      const sinReceta = x.costo_teorico_hoy_por_sabor.filter((s) => !s.tiene_receta);
      const v = x.variacion_mes_pct;
      return (
        <>
          <div className="rejilla" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))' }}>
            <Kpi etiqueta="Costo hoy" valor={lps(x.hoy.costo_total)} sub={kg(x.hoy.kg_total)} />
            <Kpi etiqueta="Últimos 7 días" valor={lps(x.semana.costo_total)} sub={kg(x.semana.kg_total)} />
            <Kpi acento etiqueta="Este mes" valor={lps(x.mes.costo_total)} sub={`${kg(x.mes.kg_total)} · ${lps(x.mes.costo_promedio_kg)}/kg`} />
            <Kpi etiqueta="vs. mes anterior" valor={v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`} sub={lps(x.mes_anterior.costo_total)} />
          </div>
          {sinReceta.length > 0 && (
            <div className="aviso-caja"><b>{sinReceta.length} sabor{sinReceta.length === 1 ? '' : 'es'} sin receta cargada.</b> No se pueden costear hasta cargarles una en «Recetas»: {sinReceta.map((s) => s.sabor_nombre).join(', ')}.
              <div><button className="btn chico" disabled={ocupado} style={{ marginTop: 8 }} onClick={async () => { const r = await ejecutar(() => post('/prod/costeo/recalcular-pendientes'), null); if (r) { window.alert(`Revisadas ${r.revisadas}, actualizadas ${r.actualizadas}`); d.recargar(); } }}>Recalcular producción pendiente</button></div></div>)}
          <div className="tarjeta"><b>Producción — últimos 30 días (costo diario)</b>
            {x.produccion_diaria_30_dias.length === 0 ? <div className="vacio">Sin datos todavía.</div> : <Columnas datos={x.produccion_diaria_30_dias} etiqueta={(f) => f.fecha.slice(8)} valor={(f) => f.costo_total} formato={lps} />}</div>
          <div className="tarjeta"><b>Sabores más costosos — este mes</b>{x.top_sabores_mes.length === 0 ? <div className="vacio">Sin producción costeada este mes.</div> : <BarrasH datos={x.top_sabores_mes} etiqueta={(s) => s.sabor_nombre} valor={(s) => s.costo_total} formato={lps} />}</div>
          <div className="tarjeta"><b>Insumos que más cuestan — este mes</b>{x.top_insumos_mes.length === 0 ? <div className="vacio">Sin consumo calculado este mes.</div> : x.top_insumos_mes.map((i) => (
            <div className="pg-fila" key={i.insumo_id}><div className="info"><b>{i.nombre}</b><span className="pg-sub">{kg(i.kg_consumido, 2)}{i.kg_sin_precio > 0 ? ' · parcial (falta precio)' : ''}</span></div><span className="chip">{lps(i.costo_total)}</span></div>))}</div>
          <details className="tarjeta"><summary style={{ cursor: 'pointer', fontWeight: 600 }}>Costo teórico de hoy, por sabor</summary>
            {x.costo_teorico_hoy_por_sabor.map((s) => <div className="pg-fila" key={s.sabor_id}><b>{s.sabor_nombre}</b>{s.tiene_receta ? <span className="chip">{s.costo_kg_hoy === null ? 'incompleto' : `${lps(s.costo_kg_hoy)}/kg`}</span> : <span className="chip mal">sin receta</span>}</div>)}</details>
          <div className="tarjeta"><b>Buscar costo por rango de fechas</b>
            <div className="pg-ctl" style={{ marginTop: 8 }}><label>Desde<input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} /></label><label>Hasta<input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} /></label>
              <button className="btn primario" disabled={ocupado || !desde || !hasta} onClick={async () => setRango(await ejecutar(() => get(`/prod/costeo/dashboard/rango${qs({ desde, hasta })}`), null))}>Buscar</button></div>
            {rango && (
              <div style={{ marginTop: 12 }}>
                <small className="pg-sub">{kg(rango.kg_total)} · promedio {lps(rango.costo_promedio_kg)}/kg</small>
                <div style={{ fontSize: '1.6rem', fontWeight: 700 }}>{lps(rango.costo_total)}</div>
                {rango.por_sabor.map((s) => <div className="pg-fila" key={s.sabor_id}><b>{s.sabor_nombre}</b><span className="chip">{lps(s.costo_total)}</span></div>)}
                <button className="btn chico" style={{ marginTop: 8 }} onClick={() => descargarCsv(`costeo_${desde}_a_${hasta}.csv`, rango.por_sabor, [['sabor_nombre', 'Sabor'], ['kg_total', 'Kg producidos'], ['costo_total', 'Costo total (Lps)']])}>Descargar CSV</button>
              </div>)}</div>
          <small className="pg-sub">{nf(x.mes.kg_total, 1)} kg costeados este mes. El costo de cada tanda queda congelado con el precio de su día.</small>
        </>
      );
    }}</Estado>
  );
}
