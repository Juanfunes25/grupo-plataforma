import { useState } from 'react';
import { get, post, put } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, Modal, Tabs, useAccion, useConfirmar, useDatos } from '../ui/kit.jsx';
import { PALETA_SUCURSALES, colorDe, colorLibre, nombreCorto } from '../ui/sucursales.js';

const TIPOS = { tienda: 'Tienda', fabrica: 'Fábrica / producción', bodega: 'Bodega', oficina: 'Oficina' };
const CAI = { borrador: ['aviso', 'Borrador'], activo: ['ok', 'CAI activo'], por_vencer: ['mal', 'Por vencer / agotarse'], vencido: ['mal', 'CAI vencido'], agotado: ['mal', 'Rango agotado'] };
const aAlias = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

// Muestras de la paleta: las que ya usa otra sucursal quedan bloqueadas, porque el color existe para no confundir una con otra.
function SelectorColor({ valor, onCambiar, sucursales, excepto }) {
  return (
    <div className="fila" role="radiogroup" aria-label="Color de la sucursal">
      {PALETA_SUCURSALES.map((p) => {
        const duena = sucursales.find((s) => s.activo && s.id !== excepto && s.color?.toLowerCase() === p.color);
        const elegido = valor?.toLowerCase() === p.color;
        return (
          <button key={p.color} type="button" role="radio" aria-checked={elegido} disabled={Boolean(duena)} onClick={() => onCambiar(p.color)}
            title={duena ? `${p.nombre} — ya lo usa ${nombreCorto(duena.nombre)}` : p.nombre}
            style={{ width: 34, height: 34, borderRadius: 10, background: p.color, border: elegido ? '3px solid #fff' : '2px solid transparent', opacity: duena ? 0.3 : 1, color: '#111', fontWeight: 800 }}>
            {elegido ? '✓' : duena ? '·' : ''}
          </button>
        );
      })}
    </div>
  );
}

function FichaSucursal({ s, todas, onCerrar, onGuardado }) {
  const nueva = !s.id;
  const [f, setF] = useState({ ...s, color: s.color ?? colorLibre(todas, s.id) });
  const [aliasManual, setAliasManual] = useState(!nueva);
  const [ejecutar, ocupado] = useAccion();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const guardar = async () => {
    const c = { nombre: f.nombre.trim(), alias: f.alias, tipo: f.tipo, direccion: f.direccion || null, telefono: f.telefono || null, color: f.color };
    if (await ejecutar(() => (nueva ? post('/admin/sucursales', c) : put(`/admin/sucursales/${s.id}`, { ...c, activo: f.activo })), nueva ? 'Sucursal creada' : 'Guardado')) onGuardado();
  };
  return (
    <Modal titulo={nueva ? 'Nueva sucursal' : f.nombre} onCerrar={onCerrar} pie={<button className="btn primario" disabled={ocupado || f.nombre.trim().length < 2 || !/^[a-z0-9_]+$/.test(f.alias)} onClick={guardar}>Guardar</button>}>
      <Campo etiqueta="Nombre completo"><input value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value, ...(aliasManual ? {} : { alias: aAlias(e.target.value) }) })} autoFocus /></Campo>
      <div className="rejilla cols-2">
        <Campo etiqueta="Alias corto (minúsculas, sin espacios)"><input value={f.alias} onChange={(e) => { setAliasManual(true); setF({ ...f, alias: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') }); }} placeholder="bulevar" /></Campo>
        <Campo etiqueta="Tipo"><select value={f.tipo} onChange={set('tipo')}>{Object.entries(TIPOS).map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select></Campo>
      </div>
      <div className="rejilla cols-2">
        <Campo etiqueta="Dirección"><input value={f.direccion ?? ''} onChange={set('direccion')} /></Campo>
        <Campo etiqueta="Teléfono"><input value={f.telefono ?? ''} onChange={set('telefono')} inputMode="tel" /></Campo>
      </div>
      <div><small>Color de la sucursal (no se repite en la empresa)</small><SelectorColor valor={f.color} onCambiar={(color) => setF({ ...f, color })} sucursales={todas} excepto={s.id} /></div>
      {nueva && <div className="aviso-caja">Nace con su punto de emisión en <b>modo borrador</b> (sin validez fiscal); actívalo en «CAI / Emisión» cuando tengas el rango real del SAR.</div>}
      {!nueva && <label className="fila" style={{ flexDirection: 'row', color: 'var(--texto)' }}><input type="checkbox" checked={f.activo} onChange={(e) => setF({ ...f, activo: e.target.checked })} /> Sucursal activa</label>}
      {!nueva && !f.activo && <div className="aviso-caja">Al desactivarla deja de aparecer para facturar y en los selectores. No borra sus facturas ni su historial.</div>}
    </Modal>
  );
}

export function ContenidoSucursales() {
  const { recargar } = useSesion();
  const d = useDatos(() => get('/admin/sucursales'), []);
  const [edit, setEdit] = useState(null);
  const [ejecutar] = useAccion();
  const todas = d.datos ?? [];
  const confirmar = useConfirmar();
  const desactivar = async (s) => {
    if (!(await confirmar({ titulo: 'Desactivar sucursal', mensaje: `¿Desactivar «${s.nombre}»? Deja de aparecer para facturar y en los selectores del sistema. No borra sus facturas ni su historial.`, textoOk: 'Desactivar', peligro: true }))) return;
    if (await ejecutar(() => put(`/admin/sucursales/${s.id}`, { activo: false }), 'Sucursal desactivada')) { d.recargar(); recargar(); }
  };
  return (
    <>
      <div className="fila espacio">
        <small style={{ maxWidth: 620 }}>Cada sucursal tiene su propio color: marca a quien trabaja en ella dónde está. Dos sucursales de la misma empresa nunca pueden tener el mismo.</small>
        <button className="btn primario" onClick={() => setEdit({ nombre: '', alias: '', tipo: 'tienda', direccion: '', telefono: '', activo: true })}>+ Nueva sucursal</button>
      </div>
      <Estado d={d}>{(l) => (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Sucursal</th><th>Alias</th><th>Tipo</th><th>Dirección / teléfono</th><th>CAI</th><th></th></tr></thead>
          <tbody>{l.map((s) => {
            const cai = CAI[s.cai_estado];
            return (
              <tr key={s.id} style={{ opacity: s.activo ? 1 : 0.5 }}>
                <td><i style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 4, background: colorDe(s), marginRight: 8 }} /><b>{nombreCorto(s.nombre)}</b>{nombreCorto(s.nombre) !== s.nombre && <small style={{ display: 'block', marginLeft: 20 }}>{s.nombre}</small>}</td>
                <td className="num">{s.alias}</td><td>{TIPOS[s.tipo]}</td>
                <td><small>{[s.direccion, s.telefono].filter(Boolean).join(' · ')}</small></td>
                <td>{cai && <span className={`chip ${cai[0]}`}>{cai[1]}</span>}</td>
                <td><div className="fila" style={{ flexWrap: 'nowrap' }}>
                  <button className="btn chico" onClick={() => setEdit(s)}>Editar / color</button>
                  {s.activo ? <button className="btn chico" onClick={() => desactivar(s)}>Desactivar</button> : <span className="chip">inactiva</span>}
                </div></td>
              </tr>);
          })}</tbody>
        </table></div></div>
      )}</Estado>
      {edit && <FichaSucursal s={edit} todas={todas} onCerrar={() => setEdit(null)} onGuardado={() => { setEdit(null); d.recargar(); recargar(); }} />}
    </>
  );
}

export function ContenidoEmpresa() {
  const { contexto, recargar } = useSesion();
  const d = useDatos(() => get('/admin/empresa'), []);
  const [f, setF] = useState(null);
  const [ejecutar, ocupado] = useAccion();
  const e = f ?? d.datos;
  const set = (k) => (ev) => setF({ ...e, [k]: ev.target.value });
  return (
    <Estado d={d}>{() => (
      <div className="tarjeta" style={{ display: 'grid', gap: 12, maxWidth: 720 }}>
        <div className="aviso-caja">Estos datos salen impresos en cada factura y cotización de {contexto.empresa.nombre}. El RTN debe coincidir con el del SAR.</div>
        <Campo etiqueta="Razón social"><input value={e.razon_social ?? ''} onChange={set('razon_social')} /></Campo>
        <div className="rejilla cols-2"><Campo etiqueta="RTN"><input value={e.rtn ?? ''} onChange={set('rtn')} /></Campo><Campo etiqueta="Teléfono"><input value={e.telefono ?? ''} onChange={set('telefono')} /></Campo></div>
        <Campo etiqueta="Dirección fiscal"><input value={e.direccion ?? ''} onChange={set('direccion')} /></Campo>
        <div className="rejilla cols-2"><Campo etiqueta="Correo"><input value={e.correo ?? ''} onChange={set('correo')} /></Campo><Campo etiqueta="Ciudad"><input value={e.ciudad ?? ''} onChange={set('ciudad')} /></Campo></div>
        <div><button className="btn primario" disabled={ocupado || !f} onClick={async () => { if (await ejecutar(() => put('/admin/empresa', { razon_social: e.razon_social, rtn: e.rtn || null, direccion: e.direccion || null, ciudad: e.ciudad || null, telefono: e.telefono || null, correo: e.correo || null }), 'Datos guardados')) { setF(null); d.recargar(); recargar(); } }}>Guardar</button></div>
      </div>
    )}</Estado>
  );
}

export default function Sucursales() {
  const { puede } = useSesion();
  const [tab, setTab] = useState('sucursales');
  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Sucursales</h1></div>
      {puede('admin:empresa') && <Tabs tabs={[['sucursales', 'Sucursales'], ['empresa', 'Datos de la empresa']]} valor={tab} onCambio={setTab} />}
      {tab === 'sucursales' ? <ContenidoSucursales /> : <ContenidoEmpresa />}
    </div>
  );
}
