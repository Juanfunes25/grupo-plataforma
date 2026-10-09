import { useEffect, useState } from 'react';
import { get, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { EncabezadoPagina, Estado, Kpi, descargarCsv, useDatos } from '../ui/kit.jsx';
import { BarraH, BarrasV, COLOR_FORMA, Leyenda, Variacion, colorSerie } from '../cierres/graficas.jsx';
import { L, entero, fechaCorta, hora12, hoyHn, primerDiaMes, ATAJOS } from '../cierres/formato.js';
import TableroEmpresa from '../tablero/TableroEmpresa.jsx';
import AlertasCai from '../fiscal/AlertasCai.jsx';
import '../cierres/cierres.css';

const ATAJOS_DASH = ATAJOS.filter((a) => ['Hoy', 'Esta semana', 'Este mes'].includes(a.etiqueta));

export default function Dashboard() {
  const { sucursales } = useSesion();
  const [f, setF] = useState({ sucursal_id: '', desde: primerDiaMes(), hasta: hoyHn() });
  const [aplicado, setAplicado] = useState(f);
  const d = useDatos(() => get(`/pos/dashboard${qs(aplicado)}`), [aplicado.sucursal_id, aplicado.desde, aplicado.hasta]);
  const consultar = (nuevo = f) => { setF(nuevo); setAplicado(nuevo); };
  // Se refresca solo cada minuto para que la caja del día se vea casi en vivo (sin parpadear).
  useEffect(() => { const t = setInterval(() => d.recargar(), 60000); return () => clearInterval(t); }, [d.recargar]); // eslint-disable-line react-hooks/exhaustive-deps
  const colorFormaDe = (p, i) => COLOR_FORMA[p.tipo] ?? colorSerie(i + 3);

  return (
    <div className="pagina">
      <AlertasCai />
      <TableroEmpresa />
      <EncabezadoPagina titulo="Análisis por periodo" descripcion={`Ventas y números · ${aplicado.desde} al ${aplicado.hasta}`}
        acciones={<button className="btn chico" onClick={() => d.recargar()} disabled={d.cargando} aria-label="Actualizar datos">{d.cargando ? 'Actualizando…' : 'Actualizar'}</button>} />
      <div className="tarjeta" style={{ display: 'grid', gap: 12 }}>
        <div className="atajos" role="group" aria-label="Periodos rápidos">{ATAJOS_DASH.map((a) => { const r = a.calcular(); const on = r.desde === aplicado.desde && r.hasta === aplicado.hasta; return <button key={a.etiqueta} className={`btn chico${on ? ' primario' : ''}`} aria-pressed={on} onClick={() => consultar({ ...f, ...r })}>{a.etiqueta}</button>; })}</div>
        <div className="filtros">
          {sucursales.length > 1 && <label>Sucursal<select value={f.sucursal_id} onChange={(e) => setF({ ...f, sucursal_id: e.target.value })}><option value="">Todas las sucursales</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select></label>}
          <label>Desde<input type="date" value={f.desde} max={f.hasta} onChange={(e) => setF({ ...f, desde: e.target.value })} /></label>
          <label>Hasta<input type="date" value={f.hasta} min={f.desde} max={hoyHn()} onChange={(e) => setF({ ...f, hasta: e.target.value })} /></label>
          <button className={`btn primario${d.cargando ? ' cargando' : ''}`} disabled={d.cargando} onClick={() => consultar()}>Consultar</button>
        </div>
      </div>

      <Estado d={d}>{(x) => (
        <>
          <div className="rejilla cols-5">
            <Kpi acento icono="dinero" etiqueta="Total ventas" valor={L(x.total)} sub={<span className="fila" style={{ gap: 6 }}><Variacion actual={x.total} anterior={x.anterior.ventas} /><span>vs. periodo anterior</span></span>} />
            <Kpi icono="reloj" etiqueta={`Hoy · ${fechaCorta(x.hoy.fecha)}`} valor={L(x.hoy.total)} sub={`${x.hoy.facturas} facturas`} />
            <Kpi icono="reportes" etiqueta="Facturas" valor={entero(x.cantidad_facturas)} sub={<span className="fila" style={{ gap: 6 }}><Variacion actual={x.cantidad_facturas} anterior={x.anterior.facturas} />{x.anuladas.n > 0 && <span className="chip mal">{x.anuladas.n} anulada(s)</span>}</span>} />
            <Kpi icono="pos" etiqueta="Ticket promedio" valor={L(x.ticket_promedio)} sub={<Variacion actual={x.ticket_promedio} anterior={x.anterior.ticket_promedio} />} />
            <Kpi etiqueta="ISV" valor={L(x.isv_total)} sub={x.descuentos > 0 ? `Descuentos: ${L(x.descuentos)}` : `${x.dias} día(s) en el periodo`} />
          </div>

          <div className="tarjeta">
            <h3>Formas de pago</h3>
            <Leyenda items={x.formas_pago.map((p, i) => ({ nombre: `${p.nombre} · ${p.porcentaje}%`, color: colorFormaDe(p, i) }))} />
            <BarraH datos={x.formas_pago.map((p, i) => ({ nombre: p.nombre, valor: p.monto, color: colorFormaDe(p, i) }))} formato={L} />
          </div>

          <div className="tarjeta">
            <div className="fila espacio"><h3>Por sucursal</h3>
              <button className="btn chico" disabled={!x.por_sucursal.length} onClick={() => descargarCsv(`ventas-por-sucursal-${x.desde}_a_${x.hasta}.csv`, x.por_sucursal.map((s) => ({ ...s, total: s.total.toFixed(2), ticket_promedio: s.ticket_promedio.toFixed(2) })),
                [['nombre', 'Sucursal'], ['facturas', 'Facturas'], ['total', 'Total'], ['ticket_promedio', 'Ticket promedio']])}>Exportar CSV</button></div>
            <Leyenda items={x.por_sucursal.map((s) => ({ nombre: s.nombre, color: s.color || 'var(--acento)' }))} />
            <BarraH datos={x.por_sucursal.map((s) => ({ nombre: s.nombre, valor: s.total, color: s.color || 'var(--acento)' }))} formato={L} />
            {x.por_sucursal.length > 0 && (() => {
              const mejor = Math.max(...x.por_sucursal.map((s) => s.ticket_promedio));
              return (
                <div className="tabla-wrap" style={{ marginTop: 10 }}><table>
                  <thead><tr><th>Sucursal</th><th className="der">Facturas</th><th className="der">Ticket promedio</th></tr></thead>
                  <tbody>{x.por_sucursal.map((s) => (
                    <tr key={s.sucursal_id}><td>{s.nombre}</td><td className="der num">{s.facturas}</td>
                      <td className="der num">{L(s.ticket_promedio)} {x.por_sucursal.length > 1 && s.ticket_promedio === mejor && mejor > 0 && <span className="chip ok" style={{ marginLeft: 6 }}>Mejor ticket</span>}</td></tr>))}</tbody>
                </table></div>
              );
            })()}
          </div>

          <div className="tarjeta">
            <h3>Tendencia de ventas</h3>
            <BarrasV datos={x.tendencia_diaria.map((t) => ({ etiqueta: t.fecha.slice(5), valor: t.total, titulo: `${t.fecha}: ${L(t.total)} · ${t.facturas} facturas` }))} formato={L} />
          </div>

          <div className="rejilla cols-2">
            <div className="tarjeta"><h3>Top 10 productos</h3><BarraH datos={x.top_productos.map((p) => ({ nombre: p.nombre, valor: p.cantidad }))} formato={entero} /></div>
            <div className="tarjeta"><h3>Por categoría</h3><BarraH datos={x.por_categoria.map((c, i) => ({ nombre: c.nombre, valor: c.total, color: colorSerie(i + 1) }))} formato={L} /></div>
          </div>

          <div className="tarjeta"><h3>Ventas por hora</h3>
            <BarrasV datos={x.por_hora.map((h) => ({ etiqueta: hora12(h.hora).replace(' a. m.', 'a').replace(' p. m.', 'p'), valor: h.total, titulo: `${hora12(h.hora)}: ${L(h.total)} · ${h.facturas} facturas` }))} formato={L} color="var(--serie-2)" alto={110} />
          </div>
        </>
      )}</Estado>
    </div>
  );
}
