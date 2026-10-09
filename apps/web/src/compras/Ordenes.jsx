import { useState } from 'react';
import { Buscador, Estado, useDatos } from '../ui/kit.jsx';
import { get } from '../api.js';
import { EstadoOC, dinero, lps } from './comun.jsx';
import OrdenDetalle from './OrdenDetalle.jsx';

const FILTROS = [['', 'Todas'], ['borrador', 'Borrador'], ['enviada,recibida_parcial', 'Por recibir'], ['recibida', 'Recibidas'], ['cerrada', 'Cerradas'], ['anulada', 'Anuladas']];

export default function Ordenes({ abrirId, onAbierto, version }) {
  const [estado, setEstado] = useState('');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(abrirId ?? null);
  const d = useDatos(() => get(`/compras/ordenes${estado || q ? `?${new URLSearchParams({ ...(estado && { estado }), ...(q && { q }) })}` : ''}`), [estado, q, version]);
  return (
    <>
      <div className="fila espacio">
        <div className="tabs tabs-pildora" role="group" aria-label="Filtrar por estado">{FILTROS.map(([k, n]) => <button key={k} className={estado === k ? 'activa' : ''} onClick={() => setEstado(k)}>{n}</button>)}</div>
        <Buscador valor={q} onCambio={setQ} placeholder="Proveedor o número…" />
      </div>
      <Estado d={d}>{(l) => (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table data-tarjetas>
          <thead><tr><th>N.°</th><th>Proveedor</th><th>Fecha</th><th>Estado</th><th className="der">Total</th><th>Recibido</th><th className="der">Por pagar</th></tr></thead>
          <tbody>{l.map((o) => (
            <tr key={o.id} className="clic" tabIndex={0} onClick={() => setSel(o.id)} onKeyDown={(e) => e.key === 'Enter' && setSel(o.id)}>
              <td className="num" data-etq=""><b>OC-{o.numero}</b></td><td data-etq="Proveedor">{o.proveedor}<small style={{ display: 'block' }}>{o.lineas} líneas{o.sucursal ? ` · ${o.sucursal}` : ''}</small></td>
              <td className="num" data-etq="Fecha">{o.fecha}{o.atrasada && <span className="chip mal" style={{ marginLeft: 6 }}>atrasada</span>}</td>
              <td data-etq="Estado"><EstadoOC estado={o.estado} /></td><td className="der num" data-etq="Total">{dinero(o.total, o.moneda)}</td>
              <td data-etq="Recibido">{['enviada', 'recibida_parcial', 'recibida', 'cerrada'].includes(o.estado) ? <div className="cmp-prog" title={`${Math.round(o.avance * 100)} %`}><i style={{ width: `${Math.min(100, o.avance * 100)}%` }} /></div> : null}</td>
              <td className="der num" data-etq="Por pagar">{o.saldo_lps > 0 ? <b>{lps(o.saldo_lps)}</b> : '—'}</td>
            </tr>))}</tbody>
        </table>{l.length === 0 && <div className="vacio">No hay órdenes {estado || q ? 'con ese filtro' : 'todavía. Crea la primera con «Nueva orden» o desde Reorden'}.</div>}</div></div>
      )}</Estado>
      {sel && <OrdenDetalle id={sel} onCerrar={() => { setSel(null); onAbierto?.(); }} onCambio={d.recargar} />}
    </>
  );
}
