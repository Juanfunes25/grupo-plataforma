import { useState } from 'react';
import { Buscador, Campo, Estado, Modal, useAccion, useDatos } from '../ui/kit.jsx';
import { get, post } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { lps } from './comun.jsx';

export function NuevoProveedor({ onCerrar, onListo }) {
  const [f, setF] = useState({ nombre: '', rtn: '', telefono: '', correo: '', direccion: '' });
  const [ejecutar, ocupado] = useAccion();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal titulo="Nuevo proveedor" tam="angosto" onCerrar={onCerrar} pie={<button className="btn primario" disabled={ocupado || f.nombre.trim().length < 2}
      onClick={async () => { const p = await ejecutar(() => post('/compras/proveedores', Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim() || null]))), 'Proveedor guardado'); if (p) onListo(p); }}>Guardar</button>}>
      <Campo etiqueta="Nombre" requerido><input value={f.nombre} onChange={set('nombre')} autoFocus /></Campo>
      <div className="rejilla cols-2">
        <Campo etiqueta="RTN" ayuda="14 dígitos. Si ya está en el directorio, se reutiliza esa ficha."><input inputMode="numeric" value={f.rtn} onChange={set('rtn')} /></Campo>
        <Campo etiqueta="Teléfono"><input inputMode="tel" value={f.telefono} onChange={set('telefono')} /></Campo>
      </div>
      <Campo etiqueta="Correo (para enviarle las órdenes)"><input type="email" value={f.correo} onChange={set('correo')} /></Campo>
      <Campo etiqueta="Dirección"><input value={f.direccion} onChange={set('direccion')} /></Campo>
    </Modal>
  );
}

export default function Proveedores() {
  const { puede } = useSesion();
  const d = useDatos(() => get('/compras/proveedores'), []);
  const [q, setQ] = useState('');
  const [nuevo, setNuevo] = useState(false);
  return (
    <>
      <div className="fila espacio"><Buscador valor={q} onCambio={setQ} placeholder="Buscar proveedor…" />{puede('compras:editar') && <button className="btn primario" onClick={() => setNuevo(true)}>+ Proveedor</button>}</div>
      <Estado d={d}>{(l) => {
        const t = q.trim().toLowerCase();
        const v = l.filter((p) => !t || p.nombre.toLowerCase().includes(t) || (p.rtn ?? '').includes(t));
        return (
          <div className="tarjeta pad0"><div className="tabla-wrap libre"><table data-tarjetas>
            <thead><tr><th>Proveedor</th><th>Contacto</th><th className="der">Órdenes</th><th className="der">Comprado</th><th className="der">Por pagar</th><th>Última compra</th></tr></thead>
            <tbody>{v.map((p) => (
              <tr key={p.id}><td data-etq="">{p.nombre}{p.rtn && <small> · RTN {p.rtn}</small>}</td><td data-etq="Contacto"><small>{[p.telefono, p.correo].filter(Boolean).join(' · ') || '—'}</small></td>
                <td className="der num" data-etq="Órdenes">{p.ordenes}</td><td className="der num" data-etq="Comprado">{lps(p.comprado_lps)}</td><td className="der num" data-etq="Por pagar">{p.por_pagar_lps > 0 ? <b>{lps(p.por_pagar_lps)}</b> : '—'}</td><td className="num" data-etq="Última compra">{p.ultima_compra ?? '—'}</td></tr>))}</tbody>
          </table>{v.length === 0 && <div className="vacio">{l.length ? 'Sin coincidencias.' : 'Todavía no hay proveedores. Agrega el primero.'}</div>}</div></div>
        );
      }}</Estado>
      <small className="fin-nota">Los proveedores son fichas comunes del grupo (las mismas de Clientes): un proveedor de Origen y de Italo es el mismo.</small>
      {nuevo && <NuevoProveedor onCerrar={() => setNuevo(false)} onListo={() => { setNuevo(false); d.recargar(); }} />}
    </>
  );
}
