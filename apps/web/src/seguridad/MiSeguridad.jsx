import { useState } from 'react';
import { fechaHoraHN } from '@grupo/shared';
import { del, get, post } from '../api.js';
import { Campo, Estado, Modal, useAccion, useAviso, useConfirmar, useDatos } from '../ui/kit.jsx';
import ConfigurarDosPasos, { CodigosRecuperacion } from './ConfigurarDosPasos.jsx';
import './seguridad.css';

function PedirCodigo({ titulo, conClave, onCerrar, onEnviar, textoOk }) {
  const [codigo, setCodigo] = useState('');
  const [password, setPassword] = useState('');
  const [ejecutar, ocupado] = useAccion();
  return (
    <Modal titulo={titulo} tam="angosto" onCerrar={onCerrar}
      pie={<button className="btn primario" disabled={ocupado || codigo.length < 6 || (conClave && !password)} onClick={async () => { if (await ejecutar(() => onEnviar({ codigo, password }))) onCerrar(); }}>{textoOk}</button>}>
      {conClave && <Campo etiqueta="Tu contraseña"><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus /></Campo>}
      <Campo etiqueta="Código de 6 dígitos de tu aplicación"><input className="codigo-6" inputMode="numeric" maxLength={6} value={codigo} onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ''))} autoFocus={!conClave} /></Campo>
    </Modal>
  );
}

function DosPasos() {
  const d = useDatos(() => get('/auth/2fa/estado'), []);
  const [modal, setModal] = useState(null);   // activar | codigos | desactivar | nuevos
  const [nuevos, setNuevos] = useState(null);
  const aviso = useAviso();
  return (
    <Estado d={d}>{(e) => (
      <div className="tarjeta" style={{ display: 'grid', gap: 12 }}>
        <div className="fila espacio"><h2>Verificación en dos pasos</h2>
          {e.activo ? <span className="chip ok">Activa</span> : <span className="chip aviso">No activada</span>}</div>
        {!e.disponible
          ? <div className="aviso-caja">Entraste con PIN de mostrador: la verificación en dos pasos es para quienes entran con correo y contraseña.</div>
          : <>
            <p style={{ margin: 0 }}>{e.activo
              ? 'Además de tu contraseña, para entrar se pide un código de 6 dígitos que genera tu teléfono. Aunque alguien robe tu contraseña, no podrá entrar.'
              : 'Protege tu cuenta: además de la contraseña, se pedirá un código de 6 dígitos de tu teléfono (Google Authenticator u otra aplicación).'}
              {e.obligatoria && !e.activo && <b> Tu cargo la exige.</b>}</p>
            {e.activo && <small>Códigos de recuperación disponibles: <b>{e.codigos_restantes}</b> de 10.{e.codigos_restantes <= 3 && ' Genera nuevos pronto.'}</small>}
            <div className="fila">
              {!e.activo && <button className="btn primario" onClick={() => setModal('activar')}>Activar verificación en dos pasos</button>}
              {e.activo && <button className="btn" onClick={() => setModal('nuevos')}>Generar códigos de recuperación nuevos</button>}
              {e.activo && !e.obligatoria && <button className="btn fantasma" onClick={() => setModal('desactivar')}>Desactivar</button>}
              {e.activo && e.obligatoria && <small className="tenue">Es obligatoria para tu cargo: no se puede desactivar.</small>}
            </div>
          </>}
        {modal === 'activar' && <Modal titulo="Activar verificación en dos pasos" onCerrar={() => setModal(null)}>
          <ConfigurarDosPasos rutaIniciar="/auth/2fa/iniciar" rutaConfirmar="/auth/2fa/activar" onActivada={() => { setModal(null); aviso('Verificación en dos pasos activada'); d.recargar(); }} /></Modal>}
        {modal === 'desactivar' && <PedirCodigo titulo="Desactivar la verificación" conClave textoOk="Desactivar" onCerrar={() => setModal(null)}
          onEnviar={async ({ codigo, password }) => { await post('/auth/2fa/desactivar', { codigo, password }); aviso('Verificación desactivada'); d.recargar(); return true; }} />}
        {modal === 'nuevos' && <PedirCodigo titulo="Códigos de recuperación nuevos" textoOk="Generar" onCerrar={() => setModal(null)}
          onEnviar={async ({ codigo }) => { const r = await post('/auth/2fa/codigos-nuevos', { codigo }); setNuevos(r.codigos_recuperacion); d.recargar(); return true; }} />}
        {nuevos && <Modal titulo="Tus códigos nuevos" onCerrar={() => setNuevos(null)}><CodigosRecuperacion codigos={nuevos} onListo={() => setNuevos(null)} /></Modal>}
      </div>
    )}</Estado>
  );
}

function Sesiones({ alSalir }) {
  const d = useDatos(() => get('/auth/sesiones'), []);
  const [ejecutar] = useAccion();
  const confirmar = useConfirmar();
  const cerrar = async (s) => {
    if (!(await confirmar({ titulo: 'Cerrar esa sesión', mensaje: `${s.navegador}${s.actual ? ' (es este equipo: tendrás que entrar de nuevo)' : ''}. Quien la use tendrá que entrar de nuevo.`, textoOk: 'Cerrar sesión' }))) return;
    const r = await ejecutar(() => del(`/auth/sesiones/${s.id}`), 'Sesión cerrada');
    if (r?.cerrada_la_actual) alSalir(); else d.recargar();
  };
  const otras = async () => {
    if (!(await confirmar({ titulo: 'Cerrar las demás sesiones', mensaje: 'Se cierran todas menos la de este equipo.', textoOk: 'Cerrar las demás' }))) return;
    if (await ejecutar(() => post('/auth/sesiones/cerrar-otras'), 'Sesiones cerradas')) d.recargar();
  };
  return (
    <div className="tarjeta">
      <div className="fila espacio"><h2>Mis sesiones</h2>{d.datos?.length > 1 && <button className="btn chico" onClick={otras}>Cerrar las demás</button>}</div>
      <small className="tenue">Equipos donde tu cuenta está abierta. Si ves uno que no reconoces, ciérralo y cambia tu contraseña.</small>
      <Estado d={d}>{(l) => l.length ? l.map((s) => (
        <div key={s.id} className="sesion-fila">
          <div className="quien"><b>{s.navegador}{s.actual && <span className="chip ok" style={{ marginLeft: 8 }}>Este equipo</span>}</b>
            <small>{s.via === 'pin' ? 'Entró con PIN' : 'Entró con correo'}{s.empresa_codigo ? ` · ${s.empresa_codigo}` : ''} · IP {s.ip ?? '—'}</small>
            <small>Entró {fechaHoraHN(s.creada_at)} · última actividad {fechaHoraHN(s.ultimo_uso)}</small></div>
          <button className="btn chico" onClick={() => cerrar(s)}>Cerrar sesión</button>
        </div>)) : <small>No hay sesiones abiertas.</small>}</Estado>
    </div>
  );
}

export default function MiSeguridad({ alSalir }) {
  return (
    <div className="pagina" style={{ maxWidth: 820 }}>
      <div className="encabezado-pagina"><h1>Mi seguridad</h1></div>
      <div style={{ display: 'grid', gap: 16 }}><DosPasos /><Sesiones alSalir={alSalir} /></div>
    </div>
  );
}
