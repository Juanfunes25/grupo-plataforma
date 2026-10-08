import { useMemo, useState } from 'react';
import { fechaHoraHN } from '@grupo/shared';
import { get, post, put } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, Modal, useAccion, useAviso, useConfirmar, useDatos } from '../ui/kit.jsx';
import { colorDe } from '../ui/sucursales.js';

const DIRECCION = ['dueno', 'admin', 'contador', 'solo_lectura'];            // entran con correo y contraseña
const PRINCIPALES = ['admin', 'gerente', 'cajero', 'ventas'];                  // Administrador · Manager · Cajero · Ventas (como en Italo Facturación)
const clave10 = () => { const c = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from(crypto.getRandomValues(new Uint32Array(10)), (n) => c[n % c.length]).join(''); };

function SelectorRol({ valor, onChange, roles, asignables }) {
  const lista = roles.filter((r) => asignables.includes(r.id));
  const principales = PRINCIPALES.map((id) => lista.find((r) => r.id === id)).filter(Boolean);
  const otros = lista.filter((r) => !PRINCIPALES.includes(r.id));
  return (
    <select value={valor} onChange={onChange}>
      {principales.map((r) => <option key={r.id} value={r.id}>{r.nombre}</option>)}
      {otros.length > 0 && <optgroup label="Otros roles">{otros.map((r) => <option key={r.id} value={r.id}>{r.nombre}</option>)}</optgroup>}
    </select>
  );
}

/** Sucursal fija (una), todas, o varias: lo que limita dónde puede trabajar y qué ve. */
function SelectorSucursal({ ids, onChange, sucursales }) {
  const [varias, setVarias] = useState(ids.length > 1);
  const modo = varias ? '__varias' : ids.length === 1 ? ids[0] : '';
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <select value={modo} onChange={(e) => { const v = e.target.value; setVarias(v === '__varias'); onChange(v === '' || v === '__varias' ? (v === '' ? [] : ids) : [v]); }}>
        <option value="">Todas las sucursales</option>
        {sucursales.map((s) => <option key={s.id} value={s.id}>Solo {s.nombre} (sucursal fija)</option>)}
        <option value="__varias">Varias sucursales…</option>
      </select>
      {varias && <div className="fila">{sucursales.map((s) => {
        const on = ids.includes(s.id);
        return <button key={s.id} type="button" className="btn chico" aria-pressed={on} onClick={() => onChange(on ? ids.filter((x) => x !== s.id) : [...ids, s.id])}
          style={on ? { background: colorDe(s), color: '#fff', borderColor: 'transparent' } : undefined}>{s.nombre}</button>;
      })}</div>}
    </div>
  );
}

function ModalClave({ u, onCerrar }) {
  const [clave, setClave] = useState('');
  const [hecho, setHecho] = useState(false);
  const [ejecutar, ocupado] = useAccion();
  return (
    <Modal titulo={`Restablecer clave · ${u.nombre}`} onCerrar={onCerrar} tam="angosto"
      pie={hecho ? <button className="btn primario" onClick={onCerrar}>Listo</button> : <button className="btn primario" disabled={clave.length < 8 || ocupado} onClick={async () => { if (await ejecutar(() => post(`/admin/usuarios/${u.id}/password`, { password: clave }))) setHecho(true); }}>Restablecer</button>}>
      {hecho ? <div className="aviso-caja ok">Clave restablecida y sesiones cerradas. Entrégasela a {u.nombre} en persona o por un canal seguro: <b className="num">{clave}</b></div> : <>
        <Campo etiqueta="Nueva contraseña (mínimo 8 caracteres)"><input type="text" autoComplete="off" value={clave} onChange={(e) => setClave(e.target.value)} autoFocus /></Campo>
        <div><button className="btn chico" onClick={() => setClave(clave10())}>Generar una</button></div>
        <small>Al restablecerla se cierran todas sus sesiones abiertas.</small></>}
    </Modal>
  );
}

function FichaUsuario({ u, roles, sucursales, soyDueno, yo, onCerrar, onGuardado }) {
  const [f, setF] = useState(u);
  const [pin, setPin] = useState('');
  const [ejecutar, ocupado] = useAccion();
  const rol = roles.roles.find((r) => r.id === f.rol);
  const direccion = DIRECCION.includes(f.rol);
  const asignables = roles.roles.filter((r) => soyDueno || !['dueno', 'admin'].includes(r.id)).map((r) => r.id);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const extra = f.permisos_extra ?? [], quit = f.permisos_quitados ?? [];
  const efectivo = (p) => (rol.permisos.includes(p) || extra.includes(p)) && !quit.includes(p);
  const alternar = (p) => {
    const base = rol.permisos.includes(p);
    if (efectivo(p)) setF({ ...f, permisos_extra: extra.filter((x) => x !== p), permisos_quitados: base ? [...quit, p] : quit });
    else setF({ ...f, permisos_quitados: quit.filter((x) => x !== p), permisos_extra: base ? extra : [...extra, p] });
  };
  const ajustes = extra.length + quit.length;
  const guardar = async () => {
    const r = f.nuevo
      ? await ejecutar(() => post('/admin/usuarios', { nombre: f.nombre, email: f.email || undefined, password: f.password || undefined, rol: f.rol, pin: f.pin || undefined, sucursal_ids: f.sucursal_ids, permisos_extra: extra, permisos_quitados: quit }), 'Usuario creado')
      : await ejecutar(() => put(`/admin/usuarios/${f.id}`, { nombre: f.nombre, rol: f.rol, sucursal_ids: f.sucursal_ids, permisos_extra: extra, permisos_quitados: quit, activo: f.activo }), 'Guardado');
    if (r) onGuardado();
  };
  const faltaAcceso = f.nuevo && !f.email && !f.pin;
  return (
    <Modal titulo={f.nuevo ? 'Nuevo usuario' : f.nombre} onCerrar={onCerrar} tam="ancho" pie={<button className="btn primario" disabled={ocupado || f.nombre.trim().length < 2 || faltaAcceso} onClick={guardar}>Guardar</button>}>
      <div className="rejilla cols-2">
        <Campo etiqueta="Nombre completo"><input value={f.nombre} onChange={set('nombre')} autoFocus /></Campo>
        <Campo etiqueta="Rol en esta empresa"><SelectorRol valor={f.rol} onChange={set('rol')} roles={roles.roles} asignables={asignables} /></Campo>
      </div>
      {rol && <small>{direccion ? 'Este rol entra con correo y contraseña.' : 'Puede entrar con PIN de 4 a 8 dígitos en la caja (y con correo si se lo das).'}</small>}
      {f.nuevo && (
        <div className="rejilla cols-2">
          <Campo etiqueta={direccion ? 'Correo (obligatorio para este rol)' : 'Correo (opcional si usa PIN)'} ayuda="Si el correo ya existe en el grupo, se le da acceso a esta empresa con la misma cuenta."><input type="email" value={f.email} onChange={set('email')} /></Campo>
          {(direccion || f.email) && <Campo etiqueta="Contraseña inicial (mín. 8)"><input type="text" value={f.password} onChange={set('password')} autoComplete="off" /></Campo>}
          {rol?.con_pin && <Campo etiqueta="PIN (4 a 8 dígitos)" ayuda="Único dentro de la empresa"><input inputMode="numeric" value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '') })} maxLength={8} /></Campo>}
        </div>
      )}
      {faltaAcceso && <div className="aviso-caja">Indica un correo o un PIN para que pueda entrar.</div>}
      {!f.nuevo && rol?.con_pin && (
        <div className="fila"><input inputMode="numeric" placeholder={f.tiene_pin ? 'Cambiar PIN…' : 'Asignar PIN…'} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} maxLength={8} style={{ maxWidth: 200 }} />
          <button className="btn" disabled={pin.length < 4 || ocupado} onClick={async () => { if (await ejecutar(() => post(`/admin/usuarios/${f.id}/pin`, { pin }), 'PIN guardado')) { setPin(''); setF({ ...f, tiene_pin: true }); } }}>Guardar PIN</button>
          {f.tiene_pin && <button className="btn fantasma" onClick={async () => { if (await ejecutar(() => post(`/admin/usuarios/${f.id}/pin`, { pin: null }), 'PIN quitado')) setF({ ...f, tiene_pin: false }); }}>Quitar PIN</button>}</div>
      )}
      <Campo etiqueta="Sucursal" ayuda="Con una sucursal fija solo ve y cobra en esa; sin marcar, en todas."><SelectorSucursal ids={f.sucursal_ids} onChange={(ids) => setF({ ...f, sucursal_ids: ids })} sucursales={sucursales} /></Campo>
      {rol && (
        <details>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Permisos finos sobre el rol {ajustes > 0 && <span className="chip aviso">{ajustes} ajuste(s)</span>}</summary>
          <div className="rejilla cols-3" style={{ marginTop: 10 }}>{roles.permisos.map((p) => <label key={p.id} className="fila" style={{ flexWrap: 'nowrap', color: 'var(--texto)', fontSize: '.88rem', flexDirection: 'row' }}><input type="checkbox" checked={efectivo(p.id)} onChange={() => alternar(p.id)} />{p.nombre}</label>)}</div>
        </details>
      )}
      {!f.nuevo && f.id !== yo && <label className="fila" style={{ flexDirection: 'row', color: 'var(--texto)' }}><input type="checkbox" checked={f.activo} onChange={(e) => setF({ ...f, activo: e.target.checked })} /> Acceso activo a esta empresa</label>}
    </Modal>
  );
}

/** Un solo PIN por tienda, compartido por todo el personal de esa sucursal (pesaje, recepción y caja). */
function ModalAccesoTienda({ sucursales, onCerrar, onCreado }) {
  const [suc, setSuc] = useState('');
  const [pin, setPin] = useState('');
  const [ejecutar, ocupado] = useAccion();
  const s = sucursales.find((x) => x.id === suc);
  const guardar = async () => { if (await ejecutar(() => post('/admin/usuarios', { nombre: `Tienda ${s.nombre}`, rol: 'cajero', pin, sucursal_ids: [s.id], permisos_extra: [], permisos_quitados: [] }), `Acceso de ${s.nombre} creado`)) onCreado(); };
  return (
    <Modal titulo="Crear acceso de tienda" onCerrar={onCerrar} tam="angosto" pie={<button className="btn primario" disabled={ocupado || !s || pin.length < 4} onClick={guardar}>Crear acceso</button>}>
      <Campo etiqueta="Sucursal"><select value={suc} onChange={(e) => setSuc(e.target.value)}><option value="">Elige la sucursal…</option>{sucursales.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}</select></Campo>
      <Campo etiqueta="PIN de la tienda (4 a 8 dígitos)" ayuda="No puede repetirse con el de otra persona o tienda."><input inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} maxLength={8} /></Campo>
      <div className="aviso-caja">Todo el personal de la tienda entra con este mismo PIN y solo ve su sucursal. Por eso lo que se haga (pesaje, recepción, caja) queda registrado a nombre de la tienda y no de una persona. Se crea como «{s ? `Tienda ${s.nombre}` : 'Tienda …'}» con rol Cajero.</div>
    </Modal>
  );
}

export function ContenidoUsuarios() {
  const { usuario, sucursales, contexto } = useSesion();
  const avisar = useAviso();
  const [ejecutar] = useAccion();
  const d = useDatos(() => get('/admin/usuarios'), []);
  const roles = useDatos(() => get('/admin/roles'), []);
  const [edit, setEdit] = useState(null);
  const [clave, setClave] = useState(null);
  const [tienda, setTienda] = useState(false);
  const [q, setQ] = useState('');
  const [rolF, setRolF] = useState('');
  const [verInactivos, setVerInactivos] = useState(true);
  const nombreRol = (id) => roles.datos?.roles.find((r) => r.id === id)?.nombre ?? id;
  const nuevo = () => setEdit({ nuevo: true, nombre: '', email: '', password: '', rol: 'cajero', pin: '', sucursal_ids: [], permisos_extra: [], permisos_quitados: [], activo: true });

  const lista = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (d.datos ?? []).filter((u) => (verInactivos || u.activo) && (!rolF || u.rol === rolF) && (!t || u.nombre.toLowerCase().includes(t) || (u.email ?? '').toLowerCase().includes(t)));
  }, [d.datos, q, rolF, verInactivos]);

  const confirmar = useConfirmar();
  const alternarActivo = async (u) => {
    if (u.activo && !(await confirmar({ titulo: 'Desactivar usuario', mensaje: `¿Desactivar a ${u.nombre}? No podrá entrar a esta empresa hasta que lo vuelvas a activar.`, textoOk: 'Desactivar', peligro: true }))) return;
    if (await ejecutar(() => put(`/admin/usuarios/${u.id}`, { activo: !u.activo }), u.activo ? 'Usuario desactivado' : 'Usuario activado')) d.recargar();
  };

  return (
    <>
      <div className="fila">
        <button className="btn primario" onClick={nuevo}>+ Nuevo usuario</button>
        {contexto.modulos.some((m) => m.id === 'rep_pesaje') && <button className="btn" onClick={() => setTienda(true)}>Crear acceso de tienda</button>}
        <input placeholder="Buscar por nombre o correo…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} />
        <select value={rolF} onChange={(e) => setRolF(e.target.value)} style={{ maxWidth: 200 }}><option value="">Todos los roles</option>{roles.datos?.roles.map((r) => <option key={r.id} value={r.id}>{r.nombre}</option>)}</select>
        <label className="fila" style={{ flexDirection: 'row' }}><input type="checkbox" checked={verInactivos} onChange={(e) => setVerInactivos(e.target.checked)} /> Ver inactivos</label>
      </div>
      <Estado d={d}>{() => (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Nombre</th><th>Acceso</th><th>Rol</th><th>Sucursal</th><th>Otras empresas</th><th>Último acceso</th><th>Activo</th><th></th></tr></thead>
          <tbody>
            {lista.map((u) => (
              <tr key={u.id} style={{ opacity: u.activo ? 1 : 0.5 }}>
                <td><b>{u.nombre}</b> {u.es_dueno_grupo && <span className="chip aviso">admin general</span>} {u.id === usuario.id && <span className="chip">tú</span>}</td>
                <td><small>{u.email ?? ''}</small> {u.tiene_pin && <span className="chip">PIN</span>}</td>
                <td>{nombreRol(u.rol)}</td>
                <td><small>{u.sucursal_ids.length ? u.sucursal_ids.map((id) => { const s = sucursales.find((x) => x.id === id); return s && <span key={id} style={{ marginRight: 8 }}><i style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: colorDe(s), marginRight: 4 }} />{s.nombre}</span>; }) : 'Todas'}</small></td>
                <td><small>{u.otras_empresas.join(', ')}</small></td>
                <td><small>{u.ultimo_acceso ? fechaHoraHN(u.ultimo_acceso) : 'nunca'}</small></td>
                <td>{u.activo ? 'Sí' : 'No'}</td>
                <td><div className="fila" style={{ flexWrap: 'nowrap' }}>
                  <button className="btn chico" onClick={() => setEdit({ ...u })}>Editar</button>
                  {u.id !== usuario.id && <button className="btn chico" onClick={() => alternarActivo(u)}>{u.activo ? 'Desactivar' : 'Activar'}</button>}
                  {u.email && <button className="btn chico" onClick={() => setClave(u)}>Clave</button>}
                </div></td>
              </tr>
            ))}
            {!lista.length && <tr><td colSpan={8} className="centro tenue" style={{ padding: 30 }}>Sin usuarios con esos filtros.</td></tr>}
          </tbody>
        </table></div></div>
      )}</Estado>
      {edit && roles.datos && <FichaUsuario u={edit} roles={roles.datos} sucursales={sucursales} soyDueno={contexto.rol === 'dueno'} yo={usuario.id} onCerrar={() => setEdit(null)} onGuardado={() => { setEdit(null); d.recargar(); }} />}
      {tienda && <ModalAccesoTienda sucursales={sucursales} onCerrar={() => setTienda(false)} onCreado={() => { setTienda(false); d.recargar(); }} />}
      {clave && <ModalClave u={clave} onCerrar={() => { setClave(null); avisar('Queda registrado en la bitácora'); }} />}
    </>
  );
}

export default function Usuarios() {
  return <div className="pagina"><div className="encabezado-pagina"><h1>Usuarios</h1></div><ContenidoUsuarios /></div>;
}
