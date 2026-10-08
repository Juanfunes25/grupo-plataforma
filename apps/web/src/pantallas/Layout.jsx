import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useSesion } from '../sesion.jsx';
import Icono from '../ui/Icono.jsx';
import Logo from '../ui/Logo.jsx';
import { Campo, Modal, useAccion, useAviso } from '../ui/kit.jsx';
import { post } from '../api.js';

// Cambio de contraseña propio (solo sesiones de correo; el PIN lo administra Administración).
function CambiarClave({ onCerrar, onListo }) {
  const [f, setF] = useState({ actual: '', nueva: '', repetir: '' });
  const [ejecutar, ocupado] = useAccion();
  const avisar = useAviso();
  const valido = f.actual && f.nueva.length >= 8 && f.nueva === f.repetir;
  const guardar = async () => {
    if (await ejecutar(() => post('/auth/cambiar-password', { actual: f.actual, nueva: f.nueva }))) { avisar('Contraseña cambiada. Entra de nuevo.'); onListo(); }
  };
  return (
    <Modal titulo="Cambiar contraseña" onCerrar={onCerrar} tam="angosto" pie={<button className="btn primario" disabled={!valido || ocupado} onClick={guardar}>Cambiar</button>}>
      <Campo etiqueta="Contraseña actual"><input type="password" autoComplete="current-password" value={f.actual} onChange={(e) => setF({ ...f, actual: e.target.value })} autoFocus /></Campo>
      <Campo etiqueta="Nueva contraseña (mínimo 8 caracteres)"><input type="password" autoComplete="new-password" value={f.nueva} onChange={(e) => setF({ ...f, nueva: e.target.value })} /></Campo>
      <Campo etiqueta="Repite la nueva"><input type="password" autoComplete="new-password" value={f.repetir} onChange={(e) => setF({ ...f, repetir: e.target.value })} /></Campo>
      {f.repetir && f.nueva !== f.repetir && <div className="aviso-caja mal">No coinciden.</div>}
    </Modal>
  );
}

export default function Layout({ children, esGrupo = false }) {
  const s = useSesion();
  const nav = useNavigate();
  const [cambiando, setCambiando] = useState(false);
  const { empresa: param } = useParams();

  // La URL manda: si cambia /:empresa, la sesión cambia de empresa (si el usuario puede).
  useEffect(() => {
    if (esGrupo || !param || !s.yo || s.empresa === param) return;
    if (s.empresas.some((e) => e.codigo === param)) s.cambiarEmpresa(param); else nav('/', { replace: true });
  }, [param, esGrupo, s.empresa, s.yo, s.empresas]); // eslint-disable-line react-hooks/exhaustive-deps

  const ctx = s.contexto;
  const color = esGrupo ? '#c9a227' : ctx?.empresa?.color;
  useEffect(() => { if (color) document.documentElement.style.setProperty('--acento', color); }, [color]);
  useEffect(() => { document.title = esGrupo ? 'Dirección · Grupo' : ctx ? `${ctx.empresa.nombre} · Grupo` : 'Grupo · Plataforma'; }, [esGrupo, ctx]);

  // No se muestra (ni se piden datos) hasta que la empresa activa coincide con la de la dirección: evita ver datos de otra empresa.
  if (!ctx || (!esGrupo && param && ctx.empresa.codigo !== param)) return <div className="vacio">Cargando…</div>;
  const base = esGrupo ? '/grupo' : `/${ctx.empresa.codigo}`;
  const otras = s.empresas.filter((e) => e.codigo !== ctx.empresa.codigo);

  return (
    <>
      <header className="barra no-print">
        <Link to={esGrupo ? '/grupo' : base} className="marca" aria-label="Inicio">
          <span style={{ width: 34, height: 34, display: 'grid', placeItems: 'center', transform: 'scale(.4)', transformOrigin: 'left center' }}>
            <Logo codigo={esGrupo ? 'grupo' : ctx.empresa.logo || ctx.empresa.codigo} color={color} />
          </span>
          <b className="titulo" style={{ fontSize: '1.25rem', letterSpacing: '.1em' }}>{esGrupo ? 'Dirección del Grupo' : ctx.empresa.nombre}</b>
        </Link>
        <span className="sep" />
        {!esGrupo && s.sucursales.length > 1 && (
          <select value={s.sucursalId ?? ''} onChange={(e) => s.elegirSucursal(e.target.value)} aria-label="Sucursal">
            {s.sucursales.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
          </select>
        )}
        {!esGrupo && s.sucursales.length === 1 && <span className="chip">{s.sucursales[0].nombre}</span>}
        {s.via !== 'pin' && (otras.length > 0 || s.usuario?.es_dueno_grupo) && <button className="btn chico fantasma" onClick={() => nav('/')} title="Cambiar de empresa"><Icono n="sucursales" tam={16} /> Empresas</button>}
        <div className="usuario-chip">
          <span>{s.usuario?.nombre?.split(' ')[0]} · <small>{s.usuario?.es_dueno_grupo ? 'administrador general' : ctx.rol}</small></span>
          {s.via !== 'pin' && <button className="btn chico fantasma" onClick={() => setCambiando(true)} aria-label="Cambiar contraseña" title="Cambiar contraseña"><Icono n="candado" tam={16} /></button>}
          <button className="btn chico fantasma" onClick={() => { s.salir(); nav('/'); }} aria-label="Cerrar sesión"><Icono n="salir" tam={16} /></button>
        </div>
      </header>
      <div key={esGrupo ? 'grupo' : ctx.empresa.codigo}>{children}</div>
      {cambiando && <CambiarClave onCerrar={() => setCambiando(false)} onListo={() => { setCambiando(false); s.salir(); nav('/'); }} />}
    </>
  );
}
