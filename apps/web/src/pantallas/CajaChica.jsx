import { useState } from 'react';
import { get, post, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, Kpi, descargarCsv, useAccion, useDatos } from '../ui/kit.jsx';
import { BarraH } from '../cierres/graficas.jsx';
import { ATAJOS, L, fechaHora, hoyHn, primerDiaMes } from '../cierres/formato.js';
import '../cierres/cierres.css';

/** Caja chica: entradas y salidas de efectivo de la sucursal, con categoría. No necesita turno abierto. */
export default function CajaChica() {
  const { sucursales, sucursalId, puede } = useSesion();
  const [suc, setSuc] = useState(sucursalId ?? '');
  const [rango, setRango] = useState({ desde: primerDiaMes(), hasta: hoyHn() });
  const datos = useDatos(() => get(`/pos/caja-chica${qs({ sucursal_id: suc, ...rango })}`), [suc, rango.desde, rango.hasta]);
  const [ejecutar, ocupado] = useAccion();
  const vacio = { tipo: 'salida', categoria: 'Otros gastos', monto: '', concepto: '', fecha: '' };
  const [f, setF] = useState(vacio);
  const puedeRegistrar = puede('pos:caja');
  const verHistorico = puede('pos:reportes');

  const registrar = async () => {
    const r = await ejecutar(() => post('/pos/caja-chica', {
      sucursal_id: suc || sucursalId, tipo: f.tipo, ...(f.tipo === 'salida' ? { categoria: f.categoria } : {}), monto: parseFloat(f.monto), concepto: f.concepto, ...(f.fecha ? { fecha: f.fecha } : {}),
    }), 'Movimiento registrado');
    if (r) { setF({ ...vacio, tipo: f.tipo, categoria: f.categoria }); datos.recargar(); }
  };

  const exportar = (items) => descargarCsv(`caja-chica-${rango.desde}_a_${rango.hasta}.csv`,
    items.map((m) => ({ ...m, tipo: m.tipo === 'salida' ? 'Salida' : 'Ingreso', usuario: m.usuario ?? '', categoria: m.categoria ?? '' })),
    [['fecha', 'Fecha'], ['sucursal', 'Sucursal'], ['tipo', 'Tipo'], ['categoria', 'Categoría'], ['concepto', 'Concepto'], ['monto', 'Monto'], ['usuario', 'Usuario']]);

  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Caja chica</h1></div>

      {puedeRegistrar && (
        <div className="tarjeta" style={{ display: 'grid', gap: 12 }}>
          <h3>Registrar movimiento</h3>
          <div className="filtros">
            <div className="fila">
              <button className="btn" onClick={() => setF({ ...f, tipo: 'salida' })} style={f.tipo === 'salida' ? { background: 'var(--peligro-fondo)' } : undefined}>Salida</button>
              <button className="btn" onClick={() => setF({ ...f, tipo: 'ingreso' })} style={f.tipo === 'ingreso' ? { background: 'var(--ok-fondo)' } : undefined}>Ingreso</button>
            </div>
            {sucursales.length > 1 && (
              <Campo etiqueta="Sucursal"><select value={suc} onChange={(e) => setSuc(e.target.value)}>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select></Campo>
            )}
            {f.tipo === 'salida' && (
              <Campo etiqueta="Categoría"><select value={f.categoria} onChange={(e) => setF({ ...f, categoria: e.target.value })}>{(datos.datos?.categorias ?? ['Otros gastos']).map((c) => <option key={c}>{c}</option>)}</select></Campo>
            )}
            <Campo etiqueta="Monto (L)"><input inputMode="decimal" value={f.monto} onChange={(e) => setF({ ...f, monto: e.target.value.replace(/[^\d.]/g, '') })} placeholder="0.00" /></Campo>
            <Campo etiqueta="Concepto"><input value={f.concepto} onChange={(e) => setF({ ...f, concepto: e.target.value })} placeholder="Compra de hielo, cambio, taxi…" style={{ minWidth: 220 }} /></Campo>
            {verHistorico && <Campo etiqueta="Fecha (vacío = hoy)"><input type="date" max={hoyHn()} value={f.fecha} onChange={(e) => setF({ ...f, fecha: e.target.value })} /></Campo>}
            <button className="btn primario" disabled={ocupado || !(parseFloat(f.monto) > 0) || (f.concepto.trim().length < 3 && f.tipo === 'ingreso')} onClick={registrar}>Registrar</button>
          </div>
          <small>La salida queda en el efectivo esperado del cierre de caja de ese día. Si no escribes concepto, se usa la categoría.</small>
        </div>
      )}

      {verHistorico && (
        <div className="tarjeta" style={{ display: 'grid', gap: 10 }}>
          <div className="filtros">
            {sucursales.length > 1 && <Campo etiqueta="Sucursal"><select value={suc} onChange={(e) => setSuc(e.target.value)}><option value="">Todas</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select></Campo>}
            <Campo etiqueta="Desde"><input type="date" value={rango.desde} max={rango.hasta} onChange={(e) => setRango({ ...rango, desde: e.target.value })} /></Campo>
            <Campo etiqueta="Hasta"><input type="date" value={rango.hasta} min={rango.desde} max={hoyHn()} onChange={(e) => setRango({ ...rango, hasta: e.target.value })} /></Campo>
            <button className="btn" disabled={!datos.datos?.items.length} onClick={() => exportar(datos.datos.items)}>Exportar CSV</button>
          </div>
          <div className="atajos">{ATAJOS.slice(0, 7).map((a) => <button key={a.etiqueta} className="btn chico" onClick={() => setRango(a.calcular())}>{a.etiqueta}</button>)}</div>
        </div>
      )}

      <Estado d={datos}>{(d) => (
        <>
          <div className="rejilla cols-4">
            <Kpi acento etiqueta="Salidas" valor={L(d.totales.salidas)} />
            <Kpi etiqueta="Ingresos" valor={L(d.totales.ingresos)} />
            <Kpi etiqueta="Neto" valor={L(d.totales.neto)} sub="ingresos − salidas" />
            <Kpi etiqueta="Movimientos" valor={d.totales.movimientos} />
          </div>
          {d.por_categoria.length > 0 && (
            <div className="tarjeta"><h3>Salidas por categoría</h3><BarraH datos={d.por_categoria.map((c) => ({ nombre: c.categoria, valor: c.monto }))} formato={L} /></div>
          )}
          <div className="tarjeta pad0"><div className="tabla-wrap"><table>
            <thead><tr><th>Fecha</th><th>Sucursal</th><th>Tipo</th><th>Categoría</th><th>Concepto</th><th>Usuario</th><th className="der">Monto</th></tr></thead>
            <tbody>{d.items.map((m) => (
              <tr key={m.id}>
                <td title={fechaHora(m.created_at)}>{m.fecha}</td><td>{m.sucursal}</td>
                <td><span className={`chip ${m.tipo === 'salida' ? 'aviso' : 'ok'}`}>{m.tipo === 'salida' ? 'Salida' : 'Ingreso'}</span></td>
                <td>{m.categoria ?? '—'}</td><td>{m.concepto}</td><td>{m.usuario ?? '—'}</td><td className="der num">{L(m.monto)}</td>
              </tr>))}</tbody>
          </table>{d.items.length === 0 && <div className="vacio">Sin movimientos de caja chica en este periodo.</div>}</div></div>
        </>
      )}</Estado>
    </div>
  );
}
