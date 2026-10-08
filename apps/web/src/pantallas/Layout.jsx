import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import { GRUPOS_NAV } from '@grupo/shared';
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
  const [menu, setMenu] = useState(false);
  const location = useLocation();
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

  const salir = () => { s.salir(); nav('/'); };
  const usuarioChip = (
    <div className="usuario-chip">
      <span>{s.usuario?.nombre?.split(' ')[0]} · <small>{s.usuario?.es_dueno_grupo ? 'administrador general' : ctx.rol}</small></span>
      {s.via !== 'pin' && <button className="btn chico fantasma" onClick={() => setCambiando(true)} aria-label="Cambiar contraseña" title="Cambiar contraseña"><Icono n="candado" tam={16} /></button>}
      <button className="btn chico fantasma" onClick={salir} aria-label="Cerrar sesión"><Icono n="salir" tam={16} /></button>
    </div>
  );
  const puedeCambiar = s.via !== 'pin' && (otras.length > 0 || s.usuario?.es_dueno_grupo);

  // Dirección del Grupo: barra superior (no es una empresa, no lleva menú lateral).
  if (esGrupo) {
    return (
      <>
        <header className="barra no-print">
          <Link to="/grupo" className="marca" aria-label="Inicio">
            <span style={{ width: 34, height: 34, display: 'grid', placeItems: 'center', transform: 'scale(.4)', transformOrigin: 'left center' }}><Logo codigo="grupo" color={color} /></span>
            <b className="titulo" style={{ fontSize: '1.25rem', letterSpacing: '.1em' }}>Dirección del Grupo</b>
          </Link>
          <span className="sep" />
          {puedeCambiar && <button className="btn chico fantasma" onClick={() => nav('/')}><Icono n="sucursales" tam={16} /> Empresas</button>}
          {usuarioChip}
        </header>
        <div key="grupo">{children}</div>
        {cambiando && <CambiarClave onCerrar={() => setCambiando(false)} onListo={() => { setCambiando(false); salir(); }} />}
      </>
    );
  }

  // Empresa: menú lateral por grupos (Operación · Negocio · Control · Ajustes), como Italo Facturación.
  const items = s.modulos.filter((m) => m.nav);
  const activo = items.find((m) => location.pathname.startsWith(`${base}/${m.ruta}`));
  return (
    <div className={`app-shell no-print-shell${menu ? ' menu-abierto' : ''}`}>
      <header className="barra-movil no-print">
        <button className="btn chico fantasma" onClick={() => setMenu(true)} aria-label="Abrir menú"><Icono n="menu" tam={20} /></button>
        <b className="titulo">{activo?.nombre ?? ctx.empresa.nombre}</b>
        {s.sucursales.length > 0 && <span className="chip">{(s.sucursal ?? s.sucursales[0]).nombre}</span>}
      </header>
      {menu && <div className="sidebar-velo" onClick={() => setMenu(false)} />}
      <aside className="sidebar no-print">
        <Link to={base} className="sidebar-marca" aria-label="Inicio">
          <span className="sidebar-logo"><Logo codigo={ctx.empresa.logo || ctx.empresa.codigo} color={color} /></span>
          <span className="sidebar-marca-texto"><b className="titulo">{ctx.empresa.nombre}</b><small>{ctx.empresa.razon_social}</small></span>
        </Link>
        {s.sucursales.length > 1 && (
          <div className="sidebar-sucursal">
            <span>Sucursal</span>
            <select value={s.sucursalId ?? ''} onChange={(e) => s.elegirSucursal(e.target.value)} aria-label="Sucursal">
              {s.sucursales.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
            </select>
          </div>
        )}
        {s.sucursales.length === 1 && <div className="sidebar-sucursal"><span>Sucursal</span><strong>{s.sucursales[0].nombre}</strong></div>}
        <nav className="sidebar-nav" aria-label="Módulos">
          {GRUPOS_NAV.map((g) => {
            const lista = items.filter((m) => m.nav === g);
            if (!lista.length) return null;
            return (
              <div key={g} className="sidebar-grupo">
                <span className="sidebar-grupo-titulo">{g}</span>
                {lista.map((m) => (
                  <NavLink key={m.id} to={`${base}/${m.ruta}`} className={({ isActive }) => `sidebar-item${isActive ? ' activo' : ''}`} onClick={() => setMenu(false)}>
                    <Icono n={m.icono} tam={18} /><span>{m.nombre}</span>
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-pie">
          {puedeCambiar && <button className="sidebar-item" onClick={() => nav('/')}><Icono n="sucursales" tam={18} /><span>Cambiar de empresa</span></button>}
          <div className="sidebar-usuario">
            <span className="sidebar-avatar">{(s.usuario?.nombre ?? '?').trim().slice(0, 1).toUpperCase()}</span>
            <span className="sidebar-usuario-texto"><strong>{s.usuario?.nombre}</strong><small>{s.usuario?.es_dueno_grupo ? 'Administrador general' : ctx.rol}</small></span>
            {s.via !== 'pin' && <button className="btn chico fantasma" onClick={() => setCambiando(true)} aria-label="Cambiar contraseña" title="Cambiar contraseña"><Icono n="candado" tam={16} /></button>}
            <button className="btn chico fantasma" onClick={salir} aria-label="Cerrar sesión" title="Cerrar sesión"><Icono n="salir" tam={16} /></button>
          </div>
        </div>
      </aside>
      <main className="principal" key={ctx.empresa.codigo}>{children}</main>
      {cambiando && <CambiarClave onCerrar={() => setCambiando(false)} onListo={() => { setCambiando(false); salir(); }} />}
    </div>
  );
}
