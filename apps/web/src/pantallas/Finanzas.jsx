import { useState } from 'react';
import { fechaHN, lempiras, sumarDias } from '@grupo/shared';
import { get, post, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { BarrasH, Campo, Estado, Kpi, Modal, Tabs, useAccion, useDatos } from '../ui/kit.jsx';

const GRUPOS = { costo_venta: 'Compras de mercadería', operativo: 'Operación', nomina: 'Planilla', alquiler: 'Alquiler', servicios: 'Servicios', marketing: 'Publicidad', impuestos: 'Impuestos y permisos', financiero: 'Financieros', otro: 'Otros' };

export default function Finanzas() {
  const { puede } = useSesion();
  const [tab, setTab] = useState('resultados');
  const hoy = fechaHN();
  const [desde, setDesde] = useState(`${hoy.slice(0, 8)}01`);
  const [hasta, setHasta] = useState(hoy);
  const res = useDatos(() => get(`/fin/resultados${qs({ desde, hasta })}`), [desde, hasta]);
  const gastos = useDatos(() => get(`/fin/gastos${qs({ desde, hasta })}`), [desde, hasta]);
  const [nuevo, setNuevo] = useState(false);
  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Finanzas</h1>
        <div className="fila"><input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} style={{ width: 160 }} /><input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} style={{ width: 160 }} />
          <button className="btn chico" onClick={() => { setDesde(`${hoy.slice(0, 8)}01`); setHasta(hoy); }}>Este mes</button>
          {puede('fin:gastos') && <button className="btn primario" onClick={() => setNuevo(true)}>+ Gasto</button>}</div></div>
      <Tabs tabs={[['resultados', 'Resultados'], ['gastos', 'Gastos'], ['interco', 'Entre empresas']]} valor={tab} onCambio={setTab} />
      {tab === 'resultados' && <Estado d={res}>{(r) => (
        <>
          <div className="rejilla cols-4">
            <Kpi acento etiqueta="Ventas netas (sin ISV)" valor={lempiras(r.ventas_netas)} sub={`${r.facturas} facturas`} />
            <Kpi etiqueta="Costo de ventas (recetas)" valor={lempiras(r.costo_ventas)} sub={r.margen_bruto_pct == null ? '' : `Margen bruto ${r.margen_bruto_pct}%`} />
            <Kpi etiqueta="Gastos operativos" valor={lempiras(r.gastos_operativos)} />
            <Kpi etiqueta="Utilidad operativa" valor={lempiras(r.utilidad_operativa)} sub={r.ventas_netas ? `${Math.round((r.utilidad_operativa / r.ventas_netas) * 1000) / 10}% de las ventas` : ''} />
          </div>
          {r.venta_sin_costo > 0 && <div className="aviso-caja">Hay {lempiras(r.venta_sin_costo)} vendidos de productos sin receta: su costo no está capturado y la utilidad se ve más alta de lo real. Completa las recetas en Inventario.</div>}
          <div className="tarjeta"><h3>Gastos por tipo (sin ISV)</h3><BarrasH datos={Object.entries(r.gastos_por_grupo).map(([k, v]) => ({ k: GRUPOS[k] ?? k, v }))} etiqueta={(d) => d.k} valor={(d) => d.v} formato={lempiras} /></div>
        </>
      )}</Estado>}
      {tab === 'gastos' && <Estado d={gastos}>{(l) => (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Fecha</th><th>Descripción</th><th>Categoría</th><th>Sucursal</th><th className="der">Monto</th><th></th></tr></thead>
          <tbody>{l.map((g) => <tr key={g.id} style={{ opacity: g.anulado ? 0.4 : 1 }}><td className="num">{g.fecha}</td><td>{g.descripcion} {g.documento && <small>· {g.documento}</small>}</td><td><small>{g.categoria}</small></td><td>{g.sucursal ?? 'General'}</td><td className="der num">{lempiras(g.monto)}</td>
            <td className="der">{g.anulado ? <span className="chip mal">anulado</span> : puede('fin:gastos') && <AnularGasto g={g} onListo={gastos.recargar} />}</td></tr>)}</tbody>
        </table>{l.length === 0 && <div className="vacio">Sin gastos en este periodo.</div>}</div></div>
      )}</Estado>}
      {tab === 'interco' && <Interco />}
      {nuevo && <NuevoGasto onCerrar={() => setNuevo(false)} onListo={() => { setNuevo(false); gastos.recargar(); res.recargar(); }} />}
    </div>
  );
}

function AnularGasto({ g, onListo }) {
  const [ejecutar] = useAccion();
  return <button className="btn chico fantasma" onClick={async () => { const m = window.prompt(`Motivo para anular “${g.descripcion}”:`); if (m && m.trim().length >= 3 && await ejecutar(() => post(`/fin/gastos/${g.id}/anular`, { motivo: m }), 'Gasto anulado')) onListo(); }}>Anular</button>;
}

function NuevoGasto({ onCerrar, onListo }) {
  const { sucursales } = useSesion();
  const cats = useDatos(() => get('/fin/categorias'), []);
  const [f, setF] = useState({ fecha: fechaHN(), descripcion: '', monto: '', isv: '', categoria_id: '', sucursal_id: '', documento: '' });
  const [ejecutar, ocupado] = useAccion();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const guardar = async () => {
    const c = { fecha: f.fecha, descripcion: f.descripcion, monto: parseFloat(f.monto), isv: parseFloat(f.isv) || 0, categoria_id: f.categoria_id, sucursal_id: f.sucursal_id || null, documento: f.documento || null };
    if (await ejecutar(() => post('/fin/gastos', c), 'Gasto registrado')) onListo();
  };
  return (
    <Modal titulo="Registrar gasto" onCerrar={onCerrar} pie={<button className="btn primario" disabled={ocupado || f.descripcion.trim().length < 3 || !(parseFloat(f.monto) > 0) || !f.categoria_id} onClick={guardar}>Guardar</button>}>
      <Campo etiqueta="Descripción"><input value={f.descripcion} onChange={set('descripcion')} autoFocus /></Campo>
      <div className="rejilla cols-2">
        <Campo etiqueta="Total pagado (ISV incluido, L)"><input inputMode="decimal" value={f.monto} onChange={set('monto')} /></Campo>
        <Campo etiqueta="De ese total, ISV (L)"><input inputMode="decimal" value={f.isv} onChange={set('isv')} /></Campo>
        <Campo etiqueta="Categoría"><select value={f.categoria_id} onChange={set('categoria_id')}><option value="">Elegir…</option>{(cats.datos ?? []).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select></Campo>
        <Campo etiqueta="Sucursal"><select value={f.sucursal_id} onChange={set('sucursal_id')}><option value="">General (toda la empresa)</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select></Campo>
        <Campo etiqueta="Fecha"><input type="date" value={f.fecha} onChange={set('fecha')} /></Campo>
        <Campo etiqueta="# de factura / recibo"><input value={f.documento} onChange={set('documento')} /></Campo>
      </div>
    </Modal>
  );
}

function Interco() {
  const { empresas, contexto } = useSesion();
  const d = useDatos(() => get('/fin/intercompania'), []);
  const [ejecutar, ocupado] = useAccion();
  const [f, setF] = useState({ destino: '', concepto: '', monto: '' });
  const otras = empresas.filter((e) => e.codigo !== contexto.empresa.codigo);
  return (
    <>
      <small>Lo que {contexto.empresa.nombre} le vende o le cobra a otra empresa del grupo. Se resta en el consolidado para no contar la misma venta dos veces.</small>
      {contexto.permisos.includes('fin:gastos') && (
        <div className="tarjeta fila">
          <select value={f.destino} onChange={(e) => setF({ ...f, destino: e.target.value })} style={{ maxWidth: 200 }}><option value="">Contraparte…</option>{otras.map((e) => <option key={e.codigo} value={e.codigo}>{e.nombre}</option>)}</select>
          <input placeholder="Concepto" value={f.concepto} onChange={(e) => setF({ ...f, concepto: e.target.value })} style={{ flex: 1, minWidth: 180 }} />
          <input placeholder="Monto" inputMode="decimal" value={f.monto} onChange={(e) => setF({ ...f, monto: e.target.value })} style={{ maxWidth: 130 }} />
          <button className="btn primario" disabled={ocupado || !f.destino || f.concepto.trim().length < 3 || !(parseFloat(f.monto) > 0)} onClick={async () => { if (await ejecutar(() => post('/fin/intercompania', { destino: f.destino, concepto: f.concepto, monto: parseFloat(f.monto) }), 'Registrado')) { setF({ destino: '', concepto: '', monto: '' }); d.recargar(); } }}>Registrar</button>
        </div>
      )}
      <Estado d={d}>{(l) => <div className="tarjeta pad0"><table><thead><tr><th>Fecha</th><th>De</th><th>A</th><th>Concepto</th><th className="der">Monto</th></tr></thead>
        <tbody>{l.map((i) => <tr key={i.id}><td className="num">{i.fecha}</td><td>{i.origen}</td><td>{i.destino}</td><td>{i.concepto}</td><td className="der num">{lempiras(i.monto)}</td></tr>)}</tbody></table>{l.length === 0 && <div className="vacio">Sin operaciones entre empresas.</div>}</div>}</Estado>
    </>
  );
}
