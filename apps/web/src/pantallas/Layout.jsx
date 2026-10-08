import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import { GRUPOS_NAV } from '@grupo/shared';
import { useSesion } from '../sesion.jsx';
import Icono from '../ui/Icono.jsx';
import Logo from '../ui/Logo.jsx';
import Paleta from '../ui/Paleta.jsx';
import { aplicarAcento, guardarTema, leerTema } from '../lib/acento.js';
import { Campo, Cargando, Modal, useAccion, useAviso } from '../ui/kit.jsx';
import { post } from '../api.js';
import Vigilancia from '../antifraude/Vigilancia.jsx';
import ContadorAlertas from '../antifraude/ContadorAlertas.jsx';

// Cambio de contraseña propio (solo sesiones de correo; el PIN lo administra Administración).
function CambiarClave({ onCerrar, onListo }) {
  const [f, setF] = useState({ actual: '', nueva: '', repetir: '' });
  const [ejecutar, ocupado] = useAccion();
  const avisar = useAviso();
  const valido = f.actual && f.nueva.length >= 8 && f.nueva === f.repetir;
  const [ver, setVer] = useState(false);
  const guardar = async () => {
    if (await ejecutar(() => post('/auth/cambiar-password', { actual: f.actual, nueva: f.nueva }))) { avisar('Contraseña cambiada. Entra de nuevo.'); onListo(); }
  };
  return (
    <Modal titulo="Cambiar contraseña" onCerrar={onCerrar} tam="angosto" pie={<button className={`btn primario${ocupado ? ' cargando' : ''}`} disabled={!valido || ocupado} onClick={guardar}>Cambiar contraseña</button>}>
      <Campo etiqueta="Contraseña actual"><input type="password" autoComplete="current-password" value={f.actual} onChange={(e) => setF({ ...f, actual: e.target.value })} autoFocus /></Campo>
      <Campo etiqueta="Nueva contraseña" ayuda="Mínimo 8 caracteres." error={f.nueva && f.nueva.length < 8 ? `Faltan ${8 - f.nueva.length} caracteres.` : null}><input type={ver ? 'text' : 'password'} autoComplete="new-password" value={f.nueva} onChange={(e) => setF({ ...f, nueva: e.target.value })} aria-invalid={Boolean(f.nueva) && f.nueva.length < 8} /></Campo>
      <Campo etiqueta="Repite la nueva contraseña" error={f.repetir && f.nueva !== f.repetir ? 'Las contraseñas no coinciden.' : null}><input type={ver ? 'text' : 'password'} autoComplete="new-password" value={f.repetir} onChange={(e) => setF({ ...f, repetir: e.target.value })} aria-invalid={Boolean(f.repetir) && f.nueva !== f.repetir} /></Campo>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--texto)' }}><input type="checkbox" checked={ver} onChange={(e) => setVer(e.target.checked)} /> Mostrar contraseñas</label>
    </Modal>
  );
}

const CLAVE_PLEGADOS = 'grupo.nav.plegados';
const leerPlegados = () => { try { return JSON.parse(localStorage.getItem(CLAVE_PLEGADOS) || '[]'); } catch { return []; } };
const CLAVE_MODO = 'grupo.nav.modo'; // visible | compacto | oculto (por dispositivo); sin valor = automático
const leerModo = () => { try { const v = localStorage.getItem(CLAVE_MODO); return ['visible', 'compacto', 'oculto'].includes(v) ? v : null; } catch { return null; } };
// Tablet / laptop pequeña (menú fijo a la izquierda): ahí el POS arranca con el menú oculto para facturar con más espacio.
function useAnchoMenor(px) {
  const q = `(min-width: 901px) and (max-width: ${px}px)`;
  const [v, setV] = useState(() => window.matchMedia(q).matches);
  useEffect(() => { const m = window.matchMedia(q); const f = () => setV(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f); }, [q]);
  return v;
}

function BotonTema({ clase = 'btn chico fantasma', conTexto = false }) {
  const [tema, setTema] = useState(leerTema);
  const cambiar = () => { const n = tema === 'claro' ? 'oscuro' : 'claro'; guardarTema(n); setTema(n); };
  const txt = tema === 'claro' ? 'Tema oscuro' : 'Tema claro';
  return <button className={clase} onClick={cambiar} aria-label={txt} title={txt}><Icono n={tema === 'claro' ? 'luna' : 'sol'} tam={18} />{conTexto && <span>{txt}</span>}</button>;
}

export default function Layout({ children, esGrupo = false }) {
  const s = useSesion();
  const nav = useNavigate();
  const [cambiando, setCambiando] = useState(false);
  const [menu, setMenu] = useState(false);
  const [paleta, setPaleta] = useState(false);
  const [plegados, setPlegados] = useState(leerPlegados);
  const [modoPref, setModoPref] = useState(leerModo);
  const enTablet = useAnchoMenor(1279);
  const location = useLocation();
  const { empresa: param } = useParams();

  // La URL manda: si cambia /:empresa, la sesión cambia de empresa (si el usuario puede).
  useEffect(() => {
    if (esGrupo || !param || !s.yo || s.empresa === param) return;
    if (s.empresas.some((e) => e.codigo === param)) s.cambiarEmpresa(param); else nav('/', { replace: true });
  }, [param, esGrupo, s.empresa, s.yo, s.empresas]); // eslint-disable-line react-hooks/exhaustive-deps

  const ctx = s.contexto;
  const color = esGrupo ? '#c9a227' : ctx?.empresa?.color;
  useEffect(() => { if (color) aplicarAcento(color); }, [color]);
  useEffect(() => { document.title = esGrupo ? 'Dirección · Grupo' : ctx ? `${ctx.empresa.nombre} · Grupo` : 'Grupo · Plataforma'; }, [esGrupo, ctx]);

  // El menú móvil se cierra al navegar o con Escape, y bloquea el scroll del fondo mientras está abierto.
  useEffect(() => { setMenu(false); }, [location.pathname]);
  useEffect(() => {
    if (!menu) return undefined;
    const f = (e) => e.key === 'Escape' && setMenu(false);
    window.addEventListener('keydown', f);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', f); document.body.style.overflow = ''; };
  }, [menu]);
  // Atajo global: Ctrl/⌘+K (o «/» fuera de un campo) abre el buscador de módulos.
  useEffect(() => {
    const f = (e) => {
      const enCampo = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
      if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); setPaleta(true); }
      else if (e.key === '/' && !enCampo && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setPaleta(true); }
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, []);
  // Ctrl/⌘+B alterna mostrar/ocultar el menú; Esc lo oculta si el foco está dentro de él (solo pantallas anchas).
  useEffect(() => {
    const f = (e) => {
      if (window.innerWidth <= 900) return;
      if ((e.key === 'b' || e.key === 'B') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); setModoPref((m) => { const act = m ?? 'visible'; const n = act === 'oculto' ? 'visible' : 'oculto'; try { localStorage.setItem(CLAVE_MODO, n); } catch { /* */ } return n; }); }
      else if (e.key === 'Escape' && document.activeElement?.closest?.('.sidebar') && !document.querySelector('.velo, .paleta-velo')) { setModoPref('oculto'); try { localStorage.setItem(CLAVE_MODO, 'oculto'); } catch { /* */ } }
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, []);
  const alternar = useCallback((g) => setPlegados((p) => {
    const n = p.includes(g) ? p.filter((x) => x !== g) : [...p, g];
    try { localStorage.setItem(CLAVE_PLEGADOS, JSON.stringify(n)); } catch { /* sin almacenamiento */ }
    return n;
  }), []);

  const base = ctx ? (esGrupo ? '/grupo' : `/${ctx.empresa.codigo}`) : '';
  const items = useMemo(() => s.modulos.filter((m) => m.nav), [s.modulos]);
  const otras = ctx ? s.empresas.filter((e) => e.codigo !== ctx.empresa.codigo) : [];
  const puedeCambiar = s.via !== 'pin' && (otras.length > 0 || s.usuario?.es_dueno_grupo);
  const salir = () => { s.salir(); nav('/'); };

  const opcionesPaleta = useMemo(() => {
    if (!ctx || esGrupo) return [];
    const mods = items.map((m) => ({ id: `m-${m.id}`, grupo: m.nav, nombre: m.nombre, detalle: m.descripcion, icono: m.icono, accion: () => nav(`${base}/${m.ruta}`) }));
    const acc = [];
    if (puedeCambiar) acc.push({ id: 'a-empresa', grupo: 'Acciones', nombre: 'Cambiar de empresa', icono: 'sucursales', accion: () => nav('/') });
    if (s.sucursales.length > 1) s.sucursales.forEach((x) => acc.push({ id: `a-suc-${x.id}`, grupo: 'Sucursal', nombre: x.nombre, detalle: x.id === s.sucursalId ? 'actual' : undefined, icono: 'sucursales', accion: () => s.elegirSucursal(x.id) }));
    acc.push({ id: 'a-salir', grupo: 'Acciones', nombre: 'Cerrar sesión', icono: 'salir', accion: salir });
    return [...mods, ...acc];
  }, [ctx, esGrupo, items, base, puedeCambiar, s.sucursales, s.sucursalId]); // eslint-disable-line react-hooks/exhaustive-deps

  // No se muestra (ni se piden datos) hasta que la empresa activa coincide con la de la dirección: evita ver datos de otra empresa.
  if (!ctx || (!esGrupo && param && ctx.empresa.codigo !== param)) return <div className="pagina"><Cargando texto="Cargando…" /></div>;

  const usuarioChip = (
    <div className="usuario-chip">
      <span>{s.usuario?.nombre?.split(' ')[0]} · <small>{s.usuario?.es_dueno_grupo ? 'administrador general' : ctx.rol}</small></span>
      {s.via !== 'pin' && <button className="btn chico fantasma" onClick={() => setCambiando(true)} aria-label="Cambiar contraseña" title="Cambiar contraseña"><Icono n="candado" tam={16} /></button>}
      <button className="btn chico fantasma" onClick={salir} aria-label="Cerrar sesión" title="Cerrar sesión"><Icono n="salir" tam={16} /></button>
    </div>
  );

  // Dirección del Grupo: barra superior (no es una empresa, no lleva menú lateral).
  if (esGrupo) {
    return (
      <>
        <a className="saltar no-print" href="#contenido">Saltar al contenido</a>
        <header className="barra no-print">
          <Link to="/grupo" className="marca" aria-label="Inicio de la Dirección del Grupo">
            <span className="marca-logo"><Logo codigo="grupo" color={color} /></span>
            <b className="titulo" style={{ fontSize: '1.3rem', letterSpacing: '.1em' }}>Dirección del Grupo</b>
          </Link>
          <span className="sep" />
          {puedeCambiar && <button className="btn chico fantasma" onClick={() => nav('/')}><Icono n="sucursales" tam={16} /> Empresas</button>}
          <BotonTema />
          {usuarioChip}
        </header>
        <div key="grupo" id="contenido" tabIndex={-1}>{children}</div>
        {cambiando && <CambiarClave onCerrar={() => setCambiando(false)} onListo={() => { setCambiando(false); salir(); }} />}
      </>
    );
  }

  // Empresa: menú lateral por grupos plegables (Operación · Negocio · Control · Ajustes).
  const activo = items.find((m) => location.pathname.startsWith(`${base}/${m.ruta}`));
  const sinCabecera = activo?.id === 'pos'; // el POS usa toda la altura
  const modo = modoPref ?? (activo?.id === 'pos' && enTablet ? 'oculto' : 'visible');
  const compacto = modo === 'compacto';
  const oculto = modo === 'oculto';
  const fijarModo = useCallback((m) => { setModoPref(m); try { localStorage.setItem(CLAVE_MODO, m); } catch { /* sin almacenamiento */ } }, []);
  const sucActual = s.sucursales.find((x) => x.id === s.sucursalId) ?? s.sucursales[0];
  return (
    <div className={`app-shell no-print-shell${menu ? ' menu-abierto' : ''}${compacto ? ' compacto' : ''}${oculto ? ' oculto' : ''}`}>
      <a className="saltar no-print" href="#contenido">Saltar al contenido</a>
      <header className="barra-movil no-print">
        <button className="btn fantasma" onClick={() => setMenu(true)} aria-label="Abrir menú" aria-expanded={menu} aria-controls="menu-lateral"><Icono n="menu" tam={22} /></button>
        <b className="titulo">{activo?.nombre ?? ctx.empresa.nombre}</b>
        {s.sucursales.length > 1
          ? <select value={s.sucursalId ?? ''} onChange={(e) => s.elegirSucursal(e.target.value)} aria-label="Sucursal activa">{s.sucursales.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}</select>
          : sucActual && <span className="chip">{sucActual.nombre}</span>}
      </header>
      {menu && <div className="sidebar-velo" onClick={() => setMenu(false)} aria-hidden="true" />}
      <aside id="menu-lateral" className="sidebar no-print" aria-label="Menú principal">
        <div className="sidebar-cab">
          <Link to={base} className="sidebar-marca" aria-label={`Inicio de ${ctx.empresa.nombre}`}>
            <span className="sidebar-logo"><Logo codigo={ctx.empresa.logo || ctx.empresa.codigo} color={color} /></span>
            <span className="sidebar-marca-texto"><b className="titulo">{ctx.empresa.nombre}</b><small>{ctx.empresa.razon_social}</small></span>
          </Link>
          <button className="btn fantasma sidebar-cerrar" onClick={() => setMenu(false)} aria-label="Cerrar menú"><Icono n="x" /></button>
          <button className="btn fantasma sidebar-compactar" onClick={() => fijarModo(compacto ? 'visible' : 'compacto')} aria-label={compacto ? 'Expandir menú' : 'Solo íconos'} aria-pressed={compacto} title={compacto ? 'Expandir menú' : 'Solo íconos'}><Icono n={compacto ? 'derecha' : 'atras'} tam={18} /></button>
          <button className="btn fantasma sidebar-ocultar" onClick={() => fijarModo('oculto')} aria-label="Ocultar menú (Ctrl B)" title="Ocultar menú (Ctrl B)"><Icono n="menu" tam={20} /></button>
        </div>
        {s.sucursales.length > 1 && (
          <div className="sidebar-sucursal">
            <span id="lbl-sucursal">Sucursal</span>
            <select value={s.sucursalId ?? ''} onChange={(e) => s.elegirSucursal(e.target.value)} aria-labelledby="lbl-sucursal">
              {s.sucursales.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
            </select>
          </div>
        )}
        {s.sucursales.length === 1 && <div className="sidebar-sucursal"><span>Sucursal</span><strong>{s.sucursales[0].nombre}</strong></div>}
        <button className="sidebar-buscar" onClick={() => { setMenu(false); setPaleta(true); }} aria-label="Buscar módulo (Control K)">
          <Icono n="lupa" tam={18} /><span>Buscar módulo…</span><kbd>Ctrl K</kbd>
        </button>
        <nav className="sidebar-nav" aria-label="Módulos">
          {GRUPOS_NAV.map((g) => {
            const lista = items.filter((m) => m.nav === g);
            if (!lista.length) return null;
            const tieneActivo = lista.some((m) => m.id === activo?.id);
            const plegado = plegados.includes(g) && !tieneActivo;
            return (
              <div key={g} className={`sidebar-grupo${plegado ? ' plegado' : ''}`}>
                <button className="sidebar-grupo-titulo" onClick={() => alternar(g)} aria-expanded={!plegado} aria-controls={`grupo-${g}`}>
                  <span>{g}</span><Icono n="abajo" tam={14} />
                </button>
                <div className="sidebar-grupo-lista" id={`grupo-${g}`}>
                  {lista.map((m) => (
                    <NavLink key={m.id} to={`${base}/${m.ruta}`} title={m.nombre} className={({ isActive }) => `sidebar-item${isActive ? ' activo' : ''}`} onClick={() => setMenu(false)}>
                      <Icono n={m.icono} tam={20} /><span>{m.nombre}</span>{m.id === 'antifraude' && <ContadorAlertas />}
                    </NavLink>
                  ))}
                </div>
              </div>
            );
          })}
        </nav>
        <div className="sidebar-pie">
          {puedeCambiar && <button className="sidebar-item" title="Cambiar de empresa" onClick={() => nav('/')}><Icono n="sucursales" tam={20} /><span>Cambiar de empresa</span></button>}
          <div className="sidebar-usuario">
            <span className="sidebar-avatar" aria-hidden="true">{(s.usuario?.nombre ?? '?').trim().slice(0, 1).toUpperCase()}</span>
            <span className="sidebar-usuario-texto"><strong>{s.usuario?.nombre}</strong><small>{s.usuario?.es_dueno_grupo ? 'Administrador general' : ctx.rol}</small></span>
            <BotonTema clase="btn chico fantasma" />
            {s.via !== 'pin' && <button className="btn chico fantasma" onClick={() => setCambiando(true)} aria-label="Cambiar contraseña" title="Cambiar contraseña"><Icono n="candado" tam={18} /></button>}
            <button className="btn chico fantasma" onClick={salir} aria-label="Cerrar sesión" title="Cerrar sesión"><Icono n="salir" tam={18} /></button>
          </div>
        </div>
      </aside>
      {oculto && <button className="menu-flotante no-print" onClick={() => fijarModo('visible')} aria-label="Mostrar menú (Ctrl B)" title="Mostrar menú (Ctrl B)"><Icono n="menu" tam={22} /></button>}
      <div className="principal" key={ctx.empresa.codigo}>
        {!sinCabecera && (
          <div className="cabecera-app no-print">
            <nav className="migas" aria-label="Ubicación">
              <Link to={base}>{ctx.empresa.nombre}</Link>
              {activo && <><Icono n="derecha" tam={14} /><span>{activo.nav}</span><Icono n="derecha" tam={14} /><b aria-current="page">{activo.nombre}</b></>}
              {activo?.descripcion && <small className="migas-desc">{activo.descripcion}</small>}
            </nav>
            <button className="btn chico fantasma" onClick={() => setPaleta(true)} aria-label="Buscar módulo (Control K)"><Icono n="lupa" tam={18} /> Buscar</button>
          </div>
        )}
        <main className="contenido" id="contenido" tabIndex={-1}>{children}</main>
      </div>
      <Vigilancia base={base} />
      {paleta && <Paleta opciones={opcionesPaleta} onCerrar={() => setPaleta(false)} />}
      {cambiando && <CambiarClave onCerrar={() => setCambiando(false)} onListo={() => { setCambiando(false); salir(); }} />}
    </div>
  );
}
