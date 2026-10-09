import { Fragment, useMemo, useState } from 'react';
import { fechaHoraHN } from '@grupo/shared';
import { get, put } from '../api.js';
import { Estado, Tabs, useAccion, useAviso, useDatos } from '../ui/kit.jsx';
import './seguridad.css';

const GRUPOS = { pos: 'Punto de venta', kds: 'Cocina', inv: 'Inventario', rrhh: 'Personal', fin: 'Finanzas', grupo: 'Dirección', gerente: 'Dirección', antifraude: 'Dirección',
  rep: 'Gelato y reposición', doc: 'Documentos', fab: 'Fabricación', dis: 'DISERCO', cotizaciones: 'Cotizaciones', admin: 'Administración', auditoria: 'Administración', sistema: 'Administración', clientes: 'Clientes' };
const grupoDe = (id) => GRUPOS[id.split(':')[0]] ?? 'Otros';

/** Política: 2FA obligatoria para dirección y largo del PIN. Solo el dueño del grupo cambia; los demás la ven. */
function Politica({ d, onCambio }) {
  const [ejecutar, ocupado] = useAccion();
  const p = d.politica;
  const cambiar = async (cuerpo, ok) => { if (await ejecutar(() => put('/admin/seguridad', cuerpo), ok)) onCambio(); };
  return (
    <div className="tarjeta" style={{ display: 'grid', gap: 14 }}>
      <h2>Reglas de acceso</h2>
      <label className="fila" style={{ alignItems: 'flex-start', gap: 10 }}>
        <input type="checkbox" checked={p.mfa_obligatoria_direccion} disabled={!d.puede_cambiar || ocupado}
          onChange={(e) => cambiar({ mfa_obligatoria_direccion: e.target.checked }, e.target.checked ? 'Ahora es obligatoria para dueños y administradores' : 'Ya no es obligatoria')} />
        <span><b>Verificación en dos pasos obligatoria para dueños y administradores</b><br />
          <small>Quien aún no la tenga la configurará la próxima vez que entre. Las demás personas pueden activarla si quieren (Mi seguridad).{!d.yo_tengo_mfa && d.puede_cambiar && ' Antes de exigirla activa la tuya en «Mi seguridad».'}</small></span>
      </label>
      <div className="rejilla cols-2">
        <label><span>PIN: mínimo de dígitos</span>
          <select value={p.pin_largo_min} disabled={!d.puede_cambiar || ocupado} onChange={(e) => cambiar({ pin_largo_min: Number(e.target.value) }, 'Política de PIN guardada')}>
            {[4, 5, 6].filter((n) => n <= p.pin_largo_max).map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        <label><span>PIN: máximo de dígitos</span>
          <select value={p.pin_largo_max} disabled={!d.puede_cambiar || ocupado} onChange={(e) => cambiar({ pin_largo_max: Number(e.target.value) }, 'Política de PIN guardada')}>
            {[4, 5, 6].filter((n) => n >= p.pin_largo_min).map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
      </div>
      <small>Aplica a los PIN nuevos o cambiados; los que ya existen siguen funcionando. Las contraseñas llevan mínimo 8 caracteres y no pueden ser comunes ni de secuencia (12345678, password…).</small>
      {!d.puede_cambiar && <small className="tenue">Solo el dueño del grupo cambia estas reglas.</small>}
    </div>
  );
}

function Adopcion({ d }) {
  return (
    <div className="tarjeta">
      <h2>Dirección y verificación en dos pasos</h2>
      <div className="tabla-wrap"><table>
        <thead><tr><th>Persona</th><th>Cargo</th><th>Dos pasos</th><th>Último acceso</th></tr></thead>
        <tbody>{d.direccion.map((u) => (
          <tr key={u.id}><td>{u.nombre}<br /><small>{u.email}</small></td><td>{u.es_dueno_grupo ? 'Dueño del grupo' : u.roles || '—'}</td>
            <td>{u.mfa_activo ? <span className="chip ok">Activa</span> : <span className="chip aviso">Sin activar</span>}</td>
            <td>{u.ultimo_acceso ? fechaHoraHN(u.ultimo_acceso) : '—'}</td></tr>))}</tbody>
      </table></div>
    </div>
  );
}

/** Matriz clara: qué puede hacer cada rol. Los permisos sueltos por persona se revisan en la pestaña siguiente. */
function Matriz() {
  const roles = useDatos(() => get('/admin/roles'), []);
  return (
    <Estado d={roles}>{(r) => {
      const grupos = {};
      for (const p of r.permisos) (grupos[grupoDe(p.id)] ??= []).push(p);
      return (
        <div className="tarjeta" style={{ display: 'grid', gap: 10 }}>
          <h2>Qué puede hacer cada rol</h2>
          <small>Una marca significa que el rol trae ese permiso. A una persona se le puede sumar o quitar un permiso suelto (ver «Ajustes por persona»).</small>
          <div className="matriz-wrap"><table className="matriz">
            <thead><tr><th>Permiso</th>{r.roles.map((x) => <th key={x.id}>{x.nombre}</th>)}</tr></thead>
            <tbody>{Object.entries(grupos).map(([g, ps]) => (
              <Fragment key={g}>
                <tr className="grupo"><td colSpan={r.roles.length + 1}>{g}</td></tr>
                {ps.map((p) => <tr key={p.id}><td>{p.nombre}<br /><small className="tenue">{p.id}</small></td>
                  {r.roles.map((x) => <td key={x.id} aria-label={x.permisos.includes(p.id) ? 'sí' : 'no'}>{x.permisos.includes(p.id) ? '✓' : ''}</td>)}</tr>)}
              </Fragment>))}</tbody>
          </table></div>
        </div>
      );
    }}</Estado>
  );
}

/** Personas con permisos distintos a los de su rol (sumados o quitados): la lista que conviene revisar de vez en cuando. */
function Ajustes() {
  const [roles, usuarios] = [useDatos(() => get('/admin/roles'), []), useDatos(() => get('/admin/usuarios'), [])];
  const nombre = useMemo(() => Object.fromEntries((roles.datos?.permisos ?? []).map((p) => [p.id, p.nombre])), [roles.datos]);
  return (
    <Estado d={usuarios}>{(l) => {
      const con = l.filter((u) => u.activo && (u.permisos_extra?.length || u.permisos_quitados?.length));
      return (
        <div className="tarjeta" style={{ display: 'grid', gap: 10 }}>
          <h2>Ajustes por persona</h2>
          <small>Permisos sumados o quitados fuera de lo que trae el rol. Se cambian en Usuarios y accesos.</small>
          {con.length === 0 ? <div className="aviso-caja ok">Nadie tiene permisos fuera de su rol.</div> : con.map((u) => (
            <div key={u.id} className="sesion-fila"><div className="quien"><b>{u.nombre}</b><small>{u.rol}</small></div>
              <div style={{ display: 'grid', gap: 4, flex: 1, minWidth: 220 }}>
                {u.permisos_extra?.length > 0 && <small><b>Suma:</b> {u.permisos_extra.map((p) => nombre[p] ?? p).join(' · ')}</small>}
                {u.permisos_quitados?.length > 0 && <small><b>Quita:</b> {u.permisos_quitados.map((p) => nombre[p] ?? p).join(' · ')}</small>}</div></div>))}
        </div>
      );
    }}</Estado>
  );
}

export default function PanelSeguridad() {
  const d = useDatos(() => get('/admin/seguridad'), []);
  const [tab, setTab] = useState('reglas');
  useAviso();
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Tabs estilo="pildora" tabs={[['reglas', 'Reglas y dos pasos'], ['matriz', 'Permisos por rol'], ['ajustes', 'Ajustes por persona']]} valor={tab} onCambio={setTab} />
      {tab === 'reglas' && <Estado d={d}>{(x) => <><Politica d={x} onCambio={d.recargar} /><Adopcion d={x} /></>}</Estado>}
      {tab === 'matriz' && <Matriz />}
      {tab === 'ajustes' && <Ajustes />}
    </div>
  );
}
