// Piezas de la experiencia «app» en celular y tablet: barra inferior, hoja «Más» y menú del modo quiosco.
import { useEffect } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { GRUPOS_NAV } from '@grupo/shared';
import Icono from './Icono.jsx';
import { Modal, vibrar } from './kit.jsx';
import ContadorAlertas from '../antifraude/ContadorAlertas.jsx';
import { guardarPref } from '../lib/preferencias.js';
import './app.css';

/** Barra inferior: hasta 4 accesos por rol + «Más». Se ve solo en pantallas angostas (ver app.css). */
export function BarraInferior({ base, accesos, activoRuta, onMas, masAbierto }) {
  // Avisa al resto de la página (avisos, toasts) que hay barra abajo para que no la tapen.
  useEffect(() => { document.documentElement.dataset.navInf = 'si'; return () => { document.documentElement.dataset.navInf = 'no'; }; }, []);
  return (
    <nav className="nav-inferior no-print" aria-label="Navegación principal">
      {accesos.map((a) => {
        const contenido = <><span className="nav-ico"><Icono n={a.icono} tam={22} />{a.alertas && <ContadorAlertas />}</span><span className="nav-txt">{a.nombre}</span></>;
        if (a.onClick) return <button key={a.id} className="nav-item" onClick={() => { vibrar(8); a.onClick(); }}>{contenido}</button>;
        return (
          <NavLink key={a.id} to={a.ruta ? `${base}/${a.ruta}` : base} end={!a.ruta} onClick={() => vibrar(8)}
            className={({ isActive }) => `nav-item${isActive || (a.ruta && activoRuta === a.ruta) ? ' activo' : ''}`}>{contenido}</NavLink>
        );
      })}
      <button className={`nav-item${masAbierto ? ' activo' : ''}`} onClick={() => { vibrar(8); onMas(); }} aria-haspopup="dialog" aria-expanded={masAbierto}>
        <span className="nav-ico"><Icono n="mas" tam={22} /></span><span className="nav-txt">Más</span>
      </button>
    </nav>
  );
}

/** Hoja «Más»: todos los módulos del usuario por grupo, la sucursal, la búsqueda y las opciones de la persona. */
export function HojaMas({ ctx, base, items, usuario, sucursales, sucursalId, onSucursal, onBuscar, onCerrar, onCambiarEmpresa, onClave, onSalir, puedeCambiar, esPin, esGrupo }) {
  return (
    <Modal titulo="Más" onCerrar={onCerrar} tam="hoja-mas">
      <div className="mas-usuario">
        <span className="sidebar-avatar" aria-hidden="true">{(usuario?.nombre ?? '?').trim().slice(0, 1).toUpperCase()}</span>
        <span><strong>{usuario?.nombre}</strong><small>{esGrupo ? 'Dirección del Grupo' : ctx.empresa.nombre} · {usuario?.es_dueno_grupo ? 'administrador general' : ctx.rol}</small></span>
      </div>
      {!esGrupo && sucursales.length > 1 && (
        <label className="mas-sucursal"><span>Sucursal activa</span>
          <select value={sucursalId ?? ''} onChange={(e) => { onSucursal(e.target.value); onCerrar(); }}>{sucursales.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}</select>
        </label>
      )}
      {!esGrupo && <button className="mas-buscar" onClick={() => { onCerrar(); onBuscar(); }}><Icono n="lupa" tam={18} /><span>Buscar un módulo…</span></button>}
      {!esGrupo && GRUPOS_NAV.map((g) => {
        const lista = items.filter((m) => m.nav === g);
        if (!lista.length) return null;
        return (
          <section key={g} className="mas-grupo" aria-label={g}>
            <h3>{g}</h3>
            <div className="mas-rejilla">
              {lista.map((m) => (
                <NavLink key={m.id} to={`${base}/${m.ruta}`} className={({ isActive }) => `mas-modulo${isActive ? ' activo' : ''}`} onClick={() => { vibrar(8); onCerrar(); }}>
                  <span className="mas-ico"><Icono n={m.icono} tam={22} />{m.id === 'antifraude' && <ContadorAlertas />}</span>
                  <span>{m.nombre}</span>
                </NavLink>
              ))}
            </div>
          </section>
        );
      })}
      <section className="mas-lista" aria-label="Opciones">
        {puedeCambiar && <button onClick={() => { onCerrar(); onCambiarEmpresa(); }}><Icono n="sucursales" tam={20} /><span>{esGrupo ? 'Empresas' : 'Cambiar de empresa'}</span></button>}
        <Link to="/app" onClick={onCerrar}><Icono n="sol" tam={20} /><span>Apariencia e instalar la app</span></Link>
        {!esPin && <button onClick={() => { onCerrar(); onClave(); }}><Icono n="candado" tam={20} /><span>Cambiar contraseña</span></button>}
        <button className="peligro" onClick={() => { onCerrar(); onSalir(); }}><Icono n="salir" tam={20} /><span>Cerrar sesión</span></button>
      </section>
    </Modal>
  );
}

/** Modo quiosco: sin menús; un botón discreto abre esta hoja para volver al inicio o salir del modo. */
export function MenuQuiosco({ base, onCerrar, onSalirQuiosco }) {
  const pantallaCompleta = () => {
    try { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.(); } catch { /* sin pantalla completa */ }
  };
  return (
    <Modal titulo="Modo quiosco" onCerrar={onCerrar} tam="angosto">
      <div className="mas-lista">
        <Link to={base || '/'} onClick={onCerrar}><Icono n="casa" tam={20} /><span>Ir al inicio</span></Link>
        <button onClick={() => { pantallaCompleta(); onCerrar(); }}><Icono n="pos" tam={20} /><span>Pantalla completa (activar o quitar)</span></button>
        <button onClick={() => { guardarPref('quiosco', 'no'); try { if (document.fullscreenElement) document.exitFullscreen(); } catch { /* */ } onSalirQuiosco?.(); onCerrar(); }}><Icono n="atras" tam={20} /><span>Salir del modo quiosco</span></button>
      </div>
    </Modal>
  );
}
