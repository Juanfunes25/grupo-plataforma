import { useState } from 'react';
import { fechaHN } from '@grupo/shared';
import { Campo, Estado, Modal, useAccion, useConfirmar, useDatos, usePedirTexto } from '../ui/kit.jsx';
import { get, post } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { fmt } from './comun.jsx';

export default function Gastos({ desde, hasta, recargarTodo }) {
  const { puede } = useSesion();
  const d = useDatos(() => get(`/fin/gastos?desde=${desde}&hasta=${hasta}`), [desde, hasta]);
  const [ejecutar] = useAccion();
  const pedir = usePedirTexto();
  const confirmar = useConfirmar();
  return (
    <Estado d={d}>{(l) => (
      <div className="tarjeta pad0"><div className="tabla-wrap"><table data-tarjetas>
        <thead><tr><th>Fecha</th><th>Descripción</th><th>Categoría</th><th>Sucursal</th><th className="der">Monto</th><th></th></tr></thead>
        <tbody>{l.map((g) => (
          <tr key={g.id} style={{ opacity: g.anulado ? 0.4 : 1 }}>
            <td className="num" data-etq="">{String(g.fecha).slice(0, 10)}</td>
            <td data-etq="Descripción">{g.descripcion} {g.documento && <small>· {g.documento}</small>} {!g.pagado && !g.anulado && <span className="chip aviso">por pagar{g.vence ? ` · vence ${String(g.vence).slice(0, 10)}` : ''}</span>}</td>
            <td data-etq="Categoría"><small>{g.categoria}</small></td><td data-etq="Sucursal">{g.sucursal ?? 'General'}</td><td className="der num" data-etq="Monto">{fmt(g.monto)}</td>
            <td className="der" data-etq="">{g.anulado ? <span className="chip mal">anulado</span> : puede('fin:gastos') && (
              <div className="fila" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                {!g.pagado && <button className="btn chico" onClick={async () => { if (await confirmar({ titulo: 'Marcar como pagado', mensaje: `¿Pagaste «${g.descripcion}» por ${fmt(g.monto)}?`, textoOk: 'Sí, pagado' }) && await ejecutar(() => post(`/fin/gastos/${g.id}/pagar`, {}), 'Marcado como pagado')) { d.recargar(); recargarTodo?.(); } }}>Pagar</button>}
                <button className="btn chico fantasma" onClick={async () => { const m = await pedir({ titulo: 'Anular gasto', mensaje: `«${g.descripcion}»`, etiqueta: 'Motivo', obligatorio: true, minimo: 3, textoOk: 'Anular' }); if (m && await ejecutar(() => post(`/fin/gastos/${g.id}/anular`, { motivo: m }), 'Gasto anulado')) { d.recargar(); recargarTodo?.(); } }}>Anular</button>
              </div>)}</td>
          </tr>))}</tbody>
      </table>{l.length === 0 && <div className="vacio">Sin gastos en este periodo.</div>}</div></div>
    )}</Estado>
  );
}

export function NuevoGasto({ onCerrar, onListo }) {
  const { sucursales } = useSesion();
  const cats = useDatos(() => get('/fin/categorias'), []);
  const [f, setF] = useState({ fecha: fechaHN(), descripcion: '', monto: '', isv: '', categoria_id: '', sucursal_id: '', documento: '', pagado: true, vence: '' });
  const [ejecutar, ocupado] = useAccion();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const guardar = async () => {
    const c = { fecha: f.fecha, descripcion: f.descripcion, monto: parseFloat(f.monto), isv: parseFloat(f.isv) || 0, categoria_id: f.categoria_id, sucursal_id: f.sucursal_id || null, documento: f.documento || null, pagado: f.pagado, vence: !f.pagado && f.vence ? f.vence : null };
    if (await ejecutar(() => post('/fin/gastos', c), 'Gasto registrado')) onListo();
  };
  return (
    <Modal titulo="Registrar gasto" onCerrar={onCerrar} pie={<button className="btn primario" disabled={ocupado || f.descripcion.trim().length < 3 || !(parseFloat(f.monto) > 0) || !f.categoria_id} onClick={guardar}>Guardar</button>}>
      <Campo etiqueta="Descripción"><input value={f.descripcion} onChange={set('descripcion')} autoFocus /></Campo>
      <div className="rejilla cols-2">
        <Campo etiqueta="Total (ISV incluido, L)"><input inputMode="decimal" value={f.monto} onChange={set('monto')} /></Campo>
        <Campo etiqueta="De ese total, ISV (L)"><input inputMode="decimal" value={f.isv} onChange={set('isv')} /></Campo>
        <Campo etiqueta="Categoría"><select value={f.categoria_id} onChange={set('categoria_id')}><option value="">Elegir…</option>{(cats.datos ?? []).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select></Campo>
        <Campo etiqueta="Sucursal"><select value={f.sucursal_id} onChange={set('sucursal_id')}><option value="">General (toda la empresa)</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select></Campo>
        <Campo etiqueta="Fecha"><input type="date" value={f.fecha} onChange={set('fecha')} /></Campo>
        <Campo etiqueta="# de factura / recibo"><input value={f.documento} onChange={set('documento')} /></Campo>
        <Campo etiqueta="¿Ya se pagó?"><select value={f.pagado ? 'si' : 'no'} onChange={(e) => setF({ ...f, pagado: e.target.value === 'si' })}><option value="si">Sí, pagado</option><option value="no">No, queda por pagar</option></select></Campo>
        {!f.pagado && <Campo etiqueta="Fecha límite de pago"><input type="date" value={f.vence} onChange={set('vence')} /></Campo>}
      </div>
    </Modal>
  );
}
