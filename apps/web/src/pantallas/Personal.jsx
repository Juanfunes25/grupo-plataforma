import { useState } from 'react';
import { fechaHN, lempiras, numero } from '@grupo/shared';
import { get, post, put } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, Modal, Tabs, useAccion, useAviso, useDatos } from '../ui/kit.jsx';

export default function Personal() {
  const { puede, usuario } = useSesion();
  const [tab, setTab] = useState('empleados');
  const tabs = [['empleados', 'Empleados'], ['asistencia', 'Asistencia'], ['vacaciones', 'Vacaciones'], ...(usuario?.es_dueno_grupo ? [['directorio', 'Directorio del grupo']] : [])];
  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Personal</h1>{puede('rrhh:asistencia') && <Marcar />}</div>
      <Tabs tabs={tabs} valor={tab} onCambio={setTab} />
      {tab === 'empleados' && <Empleados editar={puede('rrhh:editar')} />}
      {tab === 'asistencia' && <Asistencia />}
      {tab === 'vacaciones' && <Vacaciones editar={puede('rrhh:editar')} />}
      {tab === 'directorio' && <Directorio />}
    </div>
  );
}

function Marcar() {
  const avisar = useAviso();
  const [ejecutar, ocupado] = useAccion();
  return <button className="btn oro" disabled={ocupado} onClick={async () => { const r = await ejecutar(() => post('/rrhh/marcar')); if (r && r !== true) avisar(`${r.nombre}: ${r.tipo === 'entrada' ? 'entrada' : 'salida'} registrada`); }}>Marcar entrada / salida</button>;
}

function Empleados({ editar }) {
  const { sucursales } = useSesion();
  const d = useDatos(() => get('/rrhh/empleados'), []);
  const [edit, setEdit] = useState(null);
  const nuevo = { nombres: '', apellidos: '', identidad: '', telefono: '', puesto: '', sucursal_id: sucursales[0]?.id ?? '', salario_mensual: '' };
  return (
    <>
      {editar && <div><button className="btn primario" onClick={() => setEdit(nuevo)}>+ Empleado</button></div>}
      <Estado d={d}>{(l) => (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Nombre</th><th>Puesto</th><th>Sucursal</th><th>Ingreso</th><th>Estado</th>{editar && <th className="der">Salario</th>}<th></th></tr></thead>
          <tbody>{l.map((e) => (
            <tr key={e.id} className={editar ? 'clic' : ''} onClick={() => editar && setEdit({ ...e, salario_mensual: e.salario_mensual ?? '' })}>
              <td>{e.nombres} {e.apellidos} {e.otros_contratos.length > 0 && <span className="chip" title={e.otros_contratos.map((c) => `${c.empresa}: ${c.puesto}`).join(', ')}>también en {e.otros_contratos.map((c) => c.empresa).join(', ')}</span>}</td>
              <td>{e.puesto}</td><td>{e.sucursal}</td><td className="num">{e.fecha_ingreso}</td><td><span className={`chip ${e.estado === 'activo' ? 'ok' : e.estado === 'baja' ? 'mal' : 'aviso'}`}>{e.estado}</span></td>
              {editar && <td className="der num">{e.salario_mensual == null ? '' : lempiras(e.salario_mensual)}</td>}<td className="der"><small>{editar ? 'Editar' : ''}</small></td></tr>))}</tbody>
        </table>{l.length === 0 && <div className="vacio">Sin empleados registrados.</div>}</div></div>
      )}</Estado>
      {edit && <FichaEmpleado e={edit} sucursales={sucursales} onCerrar={() => setEdit(null)} onGuardado={() => { setEdit(null); d.recargar(); }} />}
    </>
  );
}

function FichaEmpleado({ e, sucursales, onCerrar, onGuardado }) {
  const [f, setF] = useState(e);
  const [ejecutar, ocupado] = useAccion();
  const set = (k) => (ev) => setF({ ...f, [k]: ev.target.value });
  const guardar = async () => {
    const cuerpo = { nombres: f.nombres, apellidos: f.apellidos, telefono: f.telefono || null, puesto: f.puesto, sucursal_id: f.sucursal_id || null, salario_mensual: f.salario_mensual === '' ? null : parseFloat(f.salario_mensual) };
    const r = await ejecutar(() => (f.id ? put(`/rrhh/empleados/${f.id}`, { ...cuerpo, estado: f.estado }) : post('/rrhh/empleados', { ...cuerpo, identidad: f.identidad || null })), 'Guardado');
    if (r) onGuardado();
  };
  return (
    <Modal titulo={f.id ? `${f.nombres} ${f.apellidos}` : 'Nuevo empleado'} onCerrar={onCerrar} pie={<button className="btn primario" disabled={ocupado || f.nombres.trim().length < 2 || f.puesto.trim().length < 2} onClick={guardar}>Guardar</button>}>
      <div className="rejilla cols-2"><Campo etiqueta="Nombres"><input value={f.nombres} onChange={set('nombres')} autoFocus /></Campo><Campo etiqueta="Apellidos"><input value={f.apellidos} onChange={set('apellidos')} /></Campo></div>
      {!f.id && <Campo etiqueta="Identidad (DNI)" ayuda="Si la persona ya trabaja en otra empresa del grupo, se reutiliza su ficha: una persona, un solo registro."><input value={f.identidad ?? ''} onChange={set('identidad')} /></Campo>}
      <div className="rejilla cols-2"><Campo etiqueta="Puesto"><input value={f.puesto} onChange={set('puesto')} /></Campo><Campo etiqueta="Teléfono"><input value={f.telefono ?? ''} onChange={set('telefono')} /></Campo></div>
      <div className="rejilla cols-2">
        <Campo etiqueta="Sucursal"><select value={f.sucursal_id ?? ''} onChange={set('sucursal_id')}><option value="">—</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select></Campo>
        <Campo etiqueta="Salario mensual (L)"><input inputMode="decimal" value={f.salario_mensual} onChange={set('salario_mensual')} /></Campo>
      </div>
      {f.id && <Campo etiqueta="Estado"><select value={f.estado} onChange={set('estado')}><option value="activo">Activo</option><option value="vacaciones">En vacaciones</option><option value="suspendido">Suspendido</option><option value="baja">Baja</option></select></Campo>}
    </Modal>
  );
}

function Asistencia() {
  const d = useDatos(() => get('/rrhh/asistencia'), []);
  return (
    <Estado d={d}>{(r) => (
      <>
        <small>Del {r.desde} al {r.hasta}. Las horas salen de emparejar cada entrada con su salida; una jornada sin salida no suma y se marca.</small>
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Empleado</th><th>Puesto</th><th>Sucursal</th><th className="der">Jornadas</th><th className="der">Horas</th><th className="der">Sin salida</th></tr></thead>
          <tbody>{r.empleados.map((e) => <tr key={e.id}><td>{e.nombres} {e.apellidos}</td><td>{e.puesto}</td><td>{e.sucursal}</td><td className="der num">{e.jornadas}</td><td className="der num">{numero(e.horas, 1)}</td><td className="der num">{e.sin_salida > 0 ? <span className="chip aviso">{e.sin_salida}</span> : ''}</td></tr>)}</tbody>
        </table></div></div>
      </>
    )}</Estado>
  );
}

function Vacaciones({ editar }) {
  const emp = useDatos(() => get('/rrhh/empleados'), []);
  const d = useDatos(() => get('/rrhh/vacaciones'), []);
  const [ejecutar] = useAccion();
  const [f, setF] = useState({ empleado_id: '', desde: fechaHN(), hasta: fechaHN() });
  const resolver = async (id, estado) => { await ejecutar(() => put(`/rrhh/vacaciones/${id}`, { estado }), 'Actualizado'); d.recargar(); };
  return (
    <>
      {editar && (
        <div className="tarjeta fila">
          <select value={f.empleado_id} onChange={(e) => setF({ ...f, empleado_id: e.target.value })} style={{ maxWidth: 260 }}><option value="">Empleado…</option>{(emp.datos ?? []).filter((e) => e.estado !== 'baja').map((e) => <option key={e.id} value={e.id}>{e.nombres} {e.apellidos}</option>)}</select>
          <input type="date" value={f.desde} onChange={(e) => setF({ ...f, desde: e.target.value })} style={{ maxWidth: 170 }} /><input type="date" value={f.hasta} onChange={(e) => setF({ ...f, hasta: e.target.value })} style={{ maxWidth: 170 }} />
          <button className="btn primario" disabled={!f.empleado_id} onClick={async () => { if (await ejecutar(() => post('/rrhh/vacaciones', f), 'Solicitud registrada')) d.recargar(); }}>Registrar</button>
        </div>
      )}
      <Estado d={d}>{(l) => (
        <div className="tarjeta pad0"><table>
          <thead><tr><th>Empleado</th><th>Desde</th><th>Hasta</th><th className="der">Días</th><th>Estado</th><th></th></tr></thead>
          <tbody>{l.map((v) => <tr key={v.id}><td>{v.nombres} {v.apellidos}</td><td className="num">{v.desde}</td><td className="num">{v.hasta}</td><td className="der num">{v.dias}</td><td><span className={`chip ${v.estado === 'aprobada' ? 'ok' : v.estado === 'rechazada' ? 'mal' : 'aviso'}`}>{v.estado}</span></td>
            <td className="der">{editar && v.estado === 'solicitada' && <><button className="btn chico" onClick={() => resolver(v.id, 'aprobada')}>Aprobar</button> <button className="btn chico fantasma" onClick={() => resolver(v.id, 'rechazada')}>Rechazar</button></>}</td></tr>)}</tbody>
        </table>{l.length === 0 && <div className="vacio">Sin solicitudes.</div>}</div>
      )}</Estado>
    </>
  );
}

function Directorio() {
  const d = useDatos(() => get('/rrhh/directorio'), []);
  return (
    <Estado d={d}>{(l) => (
      <>
        <small>Cada persona aparece una sola vez, con todos sus contratos en el grupo.</small>
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Persona</th><th>Identidad</th><th>Contratos</th></tr></thead>
          <tbody>{l.map((p) => <tr key={p.id}><td>{p.nombres} {p.apellidos}</td><td className="num">{p.identidad}</td><td>{p.contratos.map((c, i) => <span key={i} className="chip" style={{ marginRight: 6 }}>{c.empresa_nombre} · {c.puesto}{c.sucursal ? ` · ${c.sucursal}` : ''}</span>)}</td></tr>)}</tbody>
        </table></div></div>
      </>
    )}</Estado>
  );
}
