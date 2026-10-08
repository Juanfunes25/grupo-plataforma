import { useState } from 'react';
import { horaHN, numero } from '@grupo/shared';
import { get, post, put } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, Modal, Tabs, useAccion, useAviso, useDatos } from '../ui/kit.jsx';

export default function Admin({ inicial }) {
  const { puede } = useSesion();
  const tabs = [
    ...(puede('admin:usuarios') ? [['usuarios', 'Usuarios y accesos']] : []),
    ...(puede('admin:empresa') ? [['sucursales', 'Sucursales'], ['empresa', 'Datos de la empresa']] : []),
    ...(puede('pos:fiscal') ? [['fiscal', 'Facturación (CAI)']] : []),
    ...(puede('auditoria:ver') ? [['auditoria', 'Auditoría']] : []),
  ];
  const [tab, setTab] = useState(tabs.some((t) => t[0] === inicial) ? inicial : tabs[0]?.[0]);
  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Administración</h1></div>
      <Tabs tabs={tabs} valor={tab} onCambio={setTab} />
      {tab === 'usuarios' && <Usuarios />}
      {tab === 'sucursales' && <Sucursales />}
      {tab === 'empresa' && <Empresa />}
      {tab === 'fiscal' && <Fiscal />}
      {tab === 'auditoria' && <Auditoria />}
    </div>
  );
}

function Usuarios() {
  const { usuario, sucursales, contexto } = useSesion();
  const d = useDatos(() => get('/admin/usuarios'), []);
  const roles = useDatos(() => get('/admin/roles'), []);
  const [edit, setEdit] = useState(null);
  const rolNombre = (id) => roles.datos?.roles.find((r) => r.id === id)?.nombre ?? id;
  return (
    <>
      <div><button className="btn primario" onClick={() => setEdit({ nuevo: true, nombre: '', email: '', password: '', rol: 'cajero', pin: '', sucursal_ids: [] })}>+ Usuario</button></div>
      <Estado d={d}>{(l) => (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Nombre</th><th>Acceso</th><th>Rol</th><th>Sucursales</th><th>Otras empresas</th><th></th></tr></thead>
          <tbody>{l.map((u) => (
            <tr key={u.id} className="clic" style={{ opacity: u.activo ? 1 : 0.45 }} onClick={() => setEdit({ ...u, sucursal_ids: u.sucursal_ids })}>
              <td>{u.nombre} {u.es_dueno_grupo && <span className="chip aviso">dueño del grupo</span>} {u.id === usuario.id && <span className="chip">tú</span>}</td>
              <td><small>{u.email ?? ''}</small> {u.tiene_pin && <span className="chip">PIN</span>}</td><td>{rolNombre(u.rol)}</td>
              <td><small>{u.sucursal_ids.length ? u.sucursal_ids.map((id) => sucursales.find((s) => s.id === id)?.nombre).join(', ') : 'Todas'}</small></td>
              <td><small>{u.otras_empresas.join(', ')}</small></td><td className="der"><small>{u.activo ? 'Editar' : 'inactivo'}</small></td></tr>))}</tbody>
        </table></div></div>
      )}</Estado>
      {edit && roles.datos && <FichaUsuario u={edit} roles={roles.datos} sucursales={sucursales} soyDueno={contexto.rol === 'dueno'} yo={usuario.id} onCerrar={() => setEdit(null)} onGuardado={() => { setEdit(null); d.recargar(); }} />}
    </>
  );
}

function FichaUsuario({ u, roles, sucursales, soyDueno, yo, onCerrar, onGuardado }) {
  const [f, setF] = useState(u);
  const [clave, setClave] = useState('');
  const [pin, setPin] = useState('');
  const [ejecutar, ocupado] = useAccion();
  const avisar = useAviso();
  const rol = roles.roles.find((r) => r.id === f.rol);
  const direccion = ['dueno', 'admin', 'contador', 'solo_lectura'].includes(f.rol);
  const asignables = roles.roles.filter((r) => soyDueno || !['dueno', 'admin'].includes(r.id));
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const toggleSuc = (id) => setF({ ...f, sucursal_ids: f.sucursal_ids.includes(id) ? f.sucursal_ids.filter((x) => x !== id) : [...f.sucursal_ids, id] });
  const extra = f.permisos_extra ?? [], quit = f.permisos_quitados ?? [];
  const efectivo = (p) => (rol.permisos.includes(p) || extra.includes(p)) && !quit.includes(p);
  const alternar = (p) => {
    const base = rol.permisos.includes(p);
    const on = efectivo(p);
    if (on) setF({ ...f, permisos_extra: extra.filter((x) => x !== p), permisos_quitados: base ? [...quit, p] : quit });
    else setF({ ...f, permisos_quitados: quit.filter((x) => x !== p), permisos_extra: base ? extra : [...extra, p] });
  };
  const guardar = async () => {
    if (f.nuevo) {
      const r = await ejecutar(() => post('/admin/usuarios', { nombre: f.nombre, email: f.email || undefined, password: f.password || undefined, rol: f.rol, pin: f.pin || undefined, sucursal_ids: f.sucursal_ids, permisos_extra: extra, permisos_quitados: quit }), 'Usuario creado');
      if (r) onGuardado();
    } else {
      const r = await ejecutar(() => put(`/admin/usuarios/${f.id}`, { nombre: f.nombre, rol: f.rol, sucursal_ids: f.sucursal_ids, permisos_extra: extra, permisos_quitados: quit, activo: f.activo }), 'Guardado');
      if (r) onGuardado();
    }
  };
  return (
    <Modal titulo={f.nuevo ? 'Nuevo usuario' : f.nombre} onCerrar={onCerrar} tam="ancho" pie={<button className="btn primario" disabled={ocupado || f.nombre.trim().length < 2} onClick={guardar}>Guardar</button>}>
      <div className="rejilla cols-2">
        <Campo etiqueta="Nombre"><input value={f.nombre} onChange={set('nombre')} autoFocus /></Campo>
        <Campo etiqueta="Rol en esta empresa"><select value={f.rol} onChange={set('rol')}>{asignables.map((r) => <option key={r.id} value={r.id}>{r.nombre}</option>)}</select></Campo>
      </div>
      {f.nuevo && (
        <div className="rejilla cols-2">
          <Campo etiqueta={direccion ? 'Correo (obligatorio para este rol)' : 'Correo (opcional si usa PIN)'} ayuda="Si el correo ya existe en el grupo, se le da acceso a esta empresa con la misma cuenta."><input type="email" value={f.email} onChange={set('email')} /></Campo>
          {(direccion || f.email) && <Campo etiqueta="Contraseña inicial (mín. 8)"><input type="text" value={f.password} onChange={set('password')} autoComplete="off" /></Campo>}
          {rol?.con_pin && <Campo etiqueta="PIN (4 a 8 dígitos)" ayuda="Único dentro de la empresa"><input inputMode="numeric" value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '') })} maxLength={8} /></Campo>}
        </div>
      )}
      {!f.nuevo && rol?.con_pin && (
        <div className="fila"><input inputMode="numeric" placeholder={f.tiene_pin ? 'Cambiar PIN…' : 'Asignar PIN…'} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} maxLength={8} style={{ maxWidth: 200 }} />
          <button className="btn" disabled={pin.length < 4 || ocupado} onClick={async () => { if (await ejecutar(() => post(`/admin/usuarios/${f.id}/pin`, { pin }), 'PIN guardado')) { setPin(''); setF({ ...f, tiene_pin: true }); } }}>Guardar PIN</button>
          {f.tiene_pin && <button className="btn fantasma" onClick={async () => { if (await ejecutar(() => post(`/admin/usuarios/${f.id}/pin`, { pin: null }), 'PIN quitado')) setF({ ...f, tiene_pin: false }); }}>Quitar PIN</button>}</div>
      )}
      {!f.nuevo && f.email && (
        <div className="fila"><input type="text" placeholder="Nueva contraseña (mín. 8)" value={clave} onChange={(e) => setClave(e.target.value)} autoComplete="off" style={{ maxWidth: 260 }} />
          <button className="btn" disabled={clave.length < 8 || ocupado} onClick={async () => { if (await ejecutar(() => post(`/admin/usuarios/${f.id}/password`, { password: clave }), 'Contraseña restablecida; sus sesiones se cerraron')) { setClave(''); avisar('Entrégasela en persona o por un canal seguro.'); } }}>Restablecer contraseña</button></div>
      )}
      <div><h3 style={{ marginBottom: 8 }}>Sucursales</h3><div className="fila"><small>Sin marcar = todas.</small>
        {sucursales.map((s) => <button key={s.id} className="btn chico" aria-pressed={f.sucursal_ids.includes(s.id)} onClick={() => toggleSuc(s.id)} style={f.sucursal_ids.includes(s.id) ? { background: 'var(--acento)', color: '#fff', borderColor: 'transparent' } : undefined}>{s.nombre}</button>)}</div></div>
      {rol && (
        <div><h3 style={{ marginBottom: 8 }}>Permisos (ajustes finos sobre el rol)</h3>
          <div className="rejilla cols-3">{roles.permisos.map((p) => <label key={p.id} className="fila" style={{ flexWrap: 'nowrap', color: 'var(--texto)', fontSize: '.88rem' }}><input type="checkbox" checked={efectivo(p.id)} onChange={() => alternar(p.id)} />{p.nombre}</label>)}</div></div>
      )}
      {!f.nuevo && f.id !== yo && <label className="fila"><input type="checkbox" checked={f.activo} onChange={(e) => setF({ ...f, activo: e.target.checked })} /> Acceso activo a esta empresa</label>}
    </Modal>
  );
}

function Sucursales() {
  const d = useDatos(() => get('/admin/sucursales'), []);
  const { recargar } = useSesion();
  const [edit, setEdit] = useState(null);
  return (
    <>
      <div><button className="btn primario" onClick={() => setEdit({ nombre: '', alias: '', tipo: 'tienda', direccion: '', activo: true })}>+ Sucursal</button></div>
      <Estado d={d}>{(l) => (
        <div className="tarjeta pad0"><table><thead><tr><th>Nombre</th><th>Alias</th><th>Tipo</th><th>Dirección</th><th></th></tr></thead>
          <tbody>{l.map((s) => <tr key={s.id} className="clic" style={{ opacity: s.activo ? 1 : 0.45 }} onClick={() => setEdit(s)}><td>{s.nombre}</td><td className="num">{s.alias}</td><td>{s.tipo}</td><td><small>{s.direccion}</small></td><td className="der"><small>{s.activo ? 'Editar' : 'inactiva'}</small></td></tr>)}</tbody></table></div>
      )}</Estado>
      {edit && <FichaSucursal s={edit} onCerrar={() => setEdit(null)} onGuardado={() => { setEdit(null); d.recargar(); recargar(); }} />}
    </>
  );
}
function FichaSucursal({ s, onCerrar, onGuardado }) {
  const [f, setF] = useState(s);
  const [ejecutar, ocupado] = useAccion();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const guardar = async () => {
    const c = { nombre: f.nombre, alias: f.alias, tipo: f.tipo, direccion: f.direccion || null, telefono: f.telefono || null };
    if (await ejecutar(() => (f.id ? put(`/admin/sucursales/${f.id}`, { ...c, activo: f.activo }) : post('/admin/sucursales', c)), 'Guardado')) onGuardado();
  };
  return (
    <Modal titulo={f.id ? f.nombre : 'Nueva sucursal'} onCerrar={onCerrar} pie={<button className="btn primario" disabled={ocupado || f.nombre.trim().length < 2 || !/^[a-z0-9_]+$/.test(f.alias)} onClick={guardar}>Guardar</button>}>
      <Campo etiqueta="Nombre"><input value={f.nombre} onChange={set('nombre')} autoFocus /></Campo>
      <div className="rejilla cols-2">
        <Campo etiqueta="Alias (minúsculas, sin espacios)"><input value={f.alias} onChange={(e) => setF({ ...f, alias: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} /></Campo>
        <Campo etiqueta="Tipo"><select value={f.tipo} onChange={set('tipo')}><option value="tienda">Tienda</option><option value="fabrica">Fábrica / producción</option><option value="bodega">Bodega</option><option value="oficina">Oficina</option></select></Campo>
      </div>
      <Campo etiqueta="Dirección"><input value={f.direccion ?? ''} onChange={set('direccion')} /></Campo>
      {!f.id && <div className="aviso-caja">Nace con facturación en modo borrador; activa el CAI real en “Facturación (CAI)”.</div>}
      {f.id && <label className="fila"><input type="checkbox" checked={f.activo} onChange={(e) => setF({ ...f, activo: e.target.checked })} /> Sucursal activa</label>}
    </Modal>
  );
}

function Empresa() {
  const { contexto, recargar } = useSesion();
  const d = useDatos(() => get('/admin/empresa'), []);
  const [f, setF] = useState(null);
  const [ejecutar, ocupado] = useAccion();
  const e = f ?? d.datos;
  const set = (k) => (ev) => setF({ ...e, [k]: ev.target.value });
  return (
    <Estado d={d}>{() => (
      <div className="tarjeta" style={{ display: 'grid', gap: 12, maxWidth: 720 }}>
        <div className="aviso-caja">Estos datos salen impresos en cada factura de {contexto.empresa.nombre}. El RTN debe coincidir con el del SAR.</div>
        <Campo etiqueta="Razón social"><input value={e.razon_social ?? ''} onChange={set('razon_social')} /></Campo>
        <div className="rejilla cols-2"><Campo etiqueta="RTN"><input value={e.rtn ?? ''} onChange={set('rtn')} /></Campo><Campo etiqueta="Teléfono"><input value={e.telefono ?? ''} onChange={set('telefono')} /></Campo></div>
        <Campo etiqueta="Dirección fiscal"><input value={e.direccion ?? ''} onChange={set('direccion')} /></Campo>
        <div className="rejilla cols-2"><Campo etiqueta="Correo"><input value={e.correo ?? ''} onChange={set('correo')} /></Campo><Campo etiqueta="Ciudad"><input value={e.ciudad ?? ''} onChange={set('ciudad')} /></Campo></div>
        <div><button className="btn primario" disabled={ocupado || !f} onClick={async () => { if (await ejecutar(() => put('/admin/empresa', { razon_social: e.razon_social, rtn: e.rtn || null, direccion: e.direccion || null, ciudad: e.ciudad || null, telefono: e.telefono || null, correo: e.correo || null }), 'Datos guardados')) { setF(null); d.recargar(); recargar(); } }}>Guardar</button></div>
      </div>
    )}</Estado>
  );
}

function Fiscal() {
  const d = useDatos(() => get('/pos/puntos-emision'), []);
  const [edit, setEdit] = useState(null);
  return (
    <>
      <div className="aviso-caja">Mientras una sucursal esté en <b>modo borrador</b>, sus facturas salen como “BORRADOR” sin validez fiscal. Para facturar de verdad carga el CAI y el rango que autorizó el SAR (los datos están en la resolución). Con facturas ya emitidas el correlativo no puede retroceder.</div>
      <Estado d={d}>{(l) => (
        <div className="rejilla cols-2">{l.map((p) => (
          <div key={p.id} className="tarjeta" style={{ display: 'grid', gap: 8 }}>
            <div className="fila espacio"><h3>{p.sucursal}</h3>{p.es_borrador ? <span className="chip aviso">Borrador</span> : <span className="chip ok">CAI activo</span>}</div>
            {!p.es_borrador && <>
              <small className="num">CAI {p.cai}</small>
              <small>Rango {p.correlativo_desde}–{p.correlativo_hasta} · próxima {p.correlativo_actual} · {p.porcentaje_usado}% usado · vence {p.fecha_limite_emision} ({p.dias_restantes} días)</small>
              {p.alerta && <div className="aviso-caja mal">Atención: {p.agotado ? 'rango agotado' : p.vencido ? 'CAI vencido' : 'el CAI está por agotarse o vencer'}. Solicita uno nuevo al SAR.</div>}
            </>}
            <div><button className="btn" onClick={() => setEdit(p)}>{p.es_borrador ? 'Activar CAI real' : 'Actualizar CAI'}</button></div>
          </div>))}</div>
      )}</Estado>
      {edit && <FichaCai p={edit} onCerrar={() => setEdit(null)} onGuardado={() => { setEdit(null); d.recargar(); }} />}
    </>
  );
}
function FichaCai({ p, onCerrar, onGuardado }) {
  const [f, setF] = useState({ cai: p.cai ?? '', punto_emision_codigo: p.punto_emision_codigo, punto_venta_codigo: p.punto_venta_codigo, tipo_documento_codigo: p.tipo_documento_codigo, correlativo_desde: p.es_borrador ? '' : p.correlativo_desde, correlativo_hasta: p.es_borrador ? '' : p.correlativo_hasta, fecha_limite_emision: p.fecha_limite_emision ?? '' });
  const [ejecutar, ocupado] = useAccion();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const guardar = async () => {
    const c = { ...f, correlativo_desde: Number(f.correlativo_desde), correlativo_hasta: Number(f.correlativo_hasta), es_borrador: false };
    if (p.es_borrador) c.correlativo_actual = Number(f.correlativo_desde);
    if (await ejecutar(() => put(`/pos/puntos-emision/${p.id}`, c), 'CAI guardado')) onGuardado();
  };
  return (
    <Modal titulo={`CAI · ${p.sucursal}`} onCerrar={onCerrar} pie={<button className="btn primario" disabled={ocupado} onClick={guardar}>Guardar y activar</button>}>
      <Campo etiqueta="CAI (32 caracteres; puedes pegarlo con o sin guiones)"><input value={f.cai} onChange={set('cai')} placeholder="2F4851-96A881-B76670-CE6CCE-48D250-32" autoFocus /></Campo>
      <div className="rejilla cols-3">
        <Campo etiqueta="Establecimiento"><input value={f.punto_emision_codigo} onChange={set('punto_emision_codigo')} maxLength={3} /></Campo>
        <Campo etiqueta="Punto de emisión"><input value={f.punto_venta_codigo} onChange={set('punto_venta_codigo')} maxLength={3} /></Campo>
        <Campo etiqueta="Tipo doc."><input value={f.tipo_documento_codigo} onChange={set('tipo_documento_codigo')} maxLength={2} /></Campo>
      </div>
      <div className="rejilla cols-3">
        <Campo etiqueta="Rango desde"><input inputMode="numeric" value={f.correlativo_desde} onChange={set('correlativo_desde')} /></Campo>
        <Campo etiqueta="Rango hasta"><input inputMode="numeric" value={f.correlativo_hasta} onChange={set('correlativo_hasta')} /></Campo>
        <Campo etiqueta="Fecha límite de emisión"><input type="date" value={f.fecha_limite_emision} onChange={set('fecha_limite_emision')} /></Campo>
      </div>
    </Modal>
  );
}

function Auditoria() {
  const d = useDatos(() => get('/admin/auditoria?limite=200'), []);
  const [ver, setVer] = useState(null);
  return (
    <>
      <div className="fila"><button className="btn" onClick={async () => setVer(await get('/admin/auditoria/verificar'))}>Verificar integridad de la bitácora</button>
        {ver && (ver.integra ? <span className="chip ok">Íntegra · {numero(ver.total)} registros encadenados</span> : <span className="chip mal">¡Alterada! Primer registro dañado: #{ver.primer_id_alterado}</span>)}</div>
      <Estado d={d}>{(l) => (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Fecha</th><th>Usuario</th><th>Acción</th><th>Detalle</th></tr></thead>
          <tbody>{l.map((a) => <tr key={a.id}><td>{horaHN(a.created_at)}</td><td>{a.usuario_nombre ?? '—'}</td><td><span className="chip">{a.accion}</span></td><td><small>{Object.entries(a.detalle ?? {}).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}</small></td></tr>)}</tbody>
        </table></div></div>
      )}</Estado>
    </>
  );
}
