import { useState } from 'react';
import { lempiras } from '@grupo/shared';
import { get, post, put, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, Modal, Tabs, useAccion, useDatos } from '../ui/kit.jsx';

const VACIO = { nombre: '', rtn: '', telefono: '', correo: '', direccion: '', es_cliente: true, es_proveedor: false, exento_impuestos: false, activo: true };

export default function Terceros() {
  const { puede } = useSesion();
  const [tab, setTab] = useState('cliente');
  const [q, setQ] = useState('');
  const d = useDatos(() => get(`/terceros${qs({ q: q.trim().length >= 2 ? q.trim() : '', tipo: tab, limite: 100 })}`), [tab, q]);
  const [edit, setEdit] = useState(null);
  const [hist, setHist] = useState(null);

  return (
    <div className="pagina">
      <div className="encabezado-pagina"><div><h1>Clientes y proveedores</h1><small>Directorio común: una ficha sirve para todas las empresas del grupo.</small></div>
        {puede('clientes:editar') && <button className="btn primario" onClick={() => setEdit({ ...VACIO, es_cliente: tab === 'cliente', es_proveedor: tab === 'proveedor' })}>+ Nuevo</button>}
      </div>
      <Tabs tabs={[['cliente', 'Clientes'], ['proveedor', 'Proveedores']]} valor={tab} onCambio={setTab} />
      <input placeholder="Buscar por nombre, RTN o teléfono…" value={q} onChange={(e) => setQ(e.target.value)} />
      <Estado d={d}>{(l) => (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Nombre</th><th>RTN</th><th>Teléfono</th><th>Correo</th><th></th></tr></thead>
          <tbody>{l.map((t) => (
            <tr key={t.id}><td>{t.nombre} {t.exento_impuestos && <span className="chip aviso">exento</span>} {t.es_cliente && t.es_proveedor && <span className="chip">ambos</span>}</td><td className="num">{t.rtn}</td><td>{t.telefono}</td><td>{t.correo}</td>
              <td className="der">{!t.es_consumidor_final && <><button className="btn chico fantasma" onClick={async () => setHist({ t, filas: await get(`/terceros/${t.id}/historial`) })}>Compras</button>
                {puede('clientes:editar') && <button className="btn chico fantasma" onClick={() => setEdit({ ...VACIO, ...t })}>Editar</button>}</>}</td></tr>))}</tbody>
        </table>{l.length === 0 && <div className="vacio">Sin resultados.</div>}</div></div>
      )}</Estado>
      {edit && <Ficha t={edit} onCerrar={() => setEdit(null)} onGuardado={() => { setEdit(null); d.recargar(); }} />}
      {hist && (
        <Modal titulo={`Compras de ${hist.t.nombre}`} onCerrar={() => setHist(null)} tam="angosto">
          {hist.filas.length === 0 ? <div className="vacio">Aún no tiene compras.</div> : <table><tbody>{hist.filas.map((h) => <tr key={h.empresa}><td>{h.empresa_nombre}</td><td className="der num">{h.compras} compras</td><td className="der num">{lempiras(h.total)}</td></tr>)}</tbody></table>}
        </Modal>
      )}
    </div>
  );
}

function Ficha({ t, onCerrar, onGuardado }) {
  const [f, setF] = useState(t);
  const [ejecutar, ocupado] = useAccion();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const guardar = async () => {
    const cuerpo = { nombre: f.nombre, rtn: f.rtn || null, telefono: f.telefono || null, correo: f.correo || null, direccion: f.direccion || null, es_cliente: f.es_cliente, es_proveedor: f.es_proveedor, exento_impuestos: f.exento_impuestos, activo: f.activo };
    if (await ejecutar(() => (f.id ? put(`/terceros/${f.id}`, cuerpo) : post('/terceros', cuerpo)), 'Guardado')) onGuardado();
  };
  return (
    <Modal titulo={f.id ? 'Editar ficha' : 'Nueva ficha'} onCerrar={onCerrar} pie={<button className="btn primario" disabled={ocupado || f.nombre.trim().length < 2} onClick={guardar}>Guardar</button>}>
      <Campo etiqueta="Nombre o razón social"><input value={f.nombre} onChange={set('nombre')} autoFocus /></Campo>
      <div className="rejilla cols-2"><Campo etiqueta="RTN (14 dígitos)"><input inputMode="numeric" value={f.rtn ?? ''} onChange={set('rtn')} /></Campo><Campo etiqueta="Teléfono"><input value={f.telefono ?? ''} onChange={set('telefono')} /></Campo></div>
      <div className="rejilla cols-2"><Campo etiqueta="Correo"><input type="email" value={f.correo ?? ''} onChange={set('correo')} /></Campo><Campo etiqueta="Dirección"><input value={f.direccion ?? ''} onChange={set('direccion')} /></Campo></div>
      <div className="fila">
        <label className="fila"><input type="checkbox" checked={f.es_cliente} onChange={set('es_cliente')} /> Cliente</label>
        <label className="fila"><input type="checkbox" checked={f.es_proveedor} onChange={set('es_proveedor')} /> Proveedor</label>
        <label className="fila"><input type="checkbox" checked={f.exento_impuestos} onChange={set('exento_impuestos')} /> Exento de ISV</label>
        {f.id && <label className="fila"><input type="checkbox" checked={f.activo} onChange={set('activo')} /> Activo</label>}
      </div>
    </Modal>
  );
}
