import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import { GRUPOS_NAV, accesosApp } from '@grupo/shared';
import { useSesion } from '../sesion.jsx';
import Icono from '../ui/Icono.jsx';
import Logo from '../ui/Logo.jsx';
import { aplicarAcento } from '../lib/acento.js';
import { fijarAppEmpresa, fijarColorBarra, guardarPref, temaEfectivo, usePref } from '../lib/preferencias.js';
import { BarraInferior, HojaMas, MenuQuiosco } from '../ui/NavApp.jsx';
import { Campo, Cargando, Modal, useAccion, useAviso } from '../ui/kit.jsx';
import { post } from '../api.js';
import Vigilancia from '../antifraude/Vigilancia.jsx';
import AyudaGlobal from '../ayuda/AyudaGlobal.jsx';
import ContadorAlertas from '../antifraude/ContadorAlertas.jsx';
import LimiteError from '../ui/LimiteError.jsx';

// La búsqueda de módulos (Ctrl+K) se descarga al abrirla: no viaja en el JavaScript de entrada.
const Paleta = lazy(() => import('../ui/Paleta.jsx'));

// Cambio de contraseña propio (solo sesiones de correo; el PIN lo administra Administración).
function CambiarClave({ onCerrar, onListo }) {
  const empresaSes = useSesion().empresa;
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
      <Link to={`/${empresaSes || 'grupo'}/seguridad`} onClick={onCerrar}>Mi seguridad: verificación en dos pasos y sesiones abiertas</Link>
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
  const [pref] = usePref('tema');
  const efectivo = temaEfectivo(pref);
  const cambiar = () => guardarPref('tema', efectivo === 'claro' ? 'oscuro' : 'claro');
  const txt = efectivo === 'claro' ? 'Tema oscuro' : 'Tema claro';
  return <button className={clase} onClick={cambiar} aria-label={txt} title={txt}><Icono n={efectivo === 'claro' ? 'luna' : 'sol'} tam={18} />{conTexto && <span>{txt}</span>}</button>;
}

export default function Layout({ children, esGrupo = false }) {
  const s = useSesion();
  const nav = useNavigate();
  const [cambiando, setCambiando] = useState(false);
  const [mas, setMas] = useState(false);
  const [menuQuiosco, setMenuQuiosco] = useState(false);
  const [quiosco] = usePref('quiosco');
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
  useEffect(() => { if (color) { aplicarAcento(color); fijarColorBarra(color); } return () => fijarColorBarra(null); }, [color]);
  const codigoApp = esGrupo ? 'grupo' : ctx?.empresa?.codigo;
  useEffect(() => { if (codigoApp) fijarAppEmpresa(codigoApp); return () => fijarAppEmpresa(null); }, [codigoApp]);
  useEffect(() => { document.title = esGrupo ? 'Dirección · Grupo' : ctx ? `${ctx.empresa.nombre} · Grupo` : 'Grupo · Plataforma'; }, [esGrupo, ctx]);

  // La hoja «Más» se cierra al navegar.
  useEffect(() => { setMas(false); setMenuQuiosco(false); }, [location.pathname]);
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
  const accesos = useMemo(() => (esGrupo
    ? [{ id: 'grupo', nombre: 'Dirección', ruta: '', icono: 'dashboard' }, ...(puedeCambiar ? [{ id: 'empresas', nombre: 'Empresas', ruta: null, icono: 'sucursales' }] : [])]
    : accesosApp(items, s.permisos)), [esGrupo, items, s.permisos, puedeCambiar]);

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
  const fijarModo = useCallback((m) => { setModoPref(m); try { localStorage.setItem(CLAVE_MODO, m); } catch { /* sin almacenamiento */ } }, []);

  if (!ctx || (!esGrupo && param && ctx.empresa.codigo !== param)) return <div className="pagina"><Cargando texto="Cargando…" /></div>;

  const usuarioChip = (
    <div className="usuario-chip">
      <span>{s.usuario?.nombre?.split(' ')[0]} · <small>{s.usuario?.es_dueno_grupo ? 'administrador general' : ctx.rol}</small></span>
      {s.via !== 'pin' && <button className="btn chico fantasma" onClick={() => setCambiando(true)} aria-label="Cambiar contraseña" title="Cambiar contraseña"><Icono n="candado" tam={16} /></button>}
      <button className="btn chico fantasma" onClick={salir} aria-label="Cerrar sesión" title="Cerrar sesión"><Icono n="salir" tam={16} /></button>
    </div>
  );

  // Dirección del Grupo: barra superior en pantalla ancha; en celular, barra inferior (Dirección · Empresas · Más).
  if (esGrupo) {
    const accesosG = accesos.map((a) => (a.id === 'empresas' ? { ...a, onClick: () => nav('/') } : a));
    return (
      <div className="grupo-shell con-nav-inf">
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
        <div key="grupo" id="contenido" tabIndex={-1}><LimiteError reinicio={location.pathname}><div className="vista" key={location.pathname}>{children}</div></LimiteError></div>
        <BarraInferior base="/grupo" accesos={accesosG} onMas={() => setMas(true)} masAbierto={mas} />
        {mas && <HojaMas esGrupo ctx={ctx} base="/grupo" items={[]} usuario={s.usuario} sucursales={[]} puedeCambiar={puedeCambiar} esPin={s.via === 'pin'}
          onCerrar={() => setMas(false)} onCambiarEmpresa={() => nav('/')} onClave={() => setCambiando(true)} onSalir={salir} />}
        {quiosco === 'si' && <button className="quiosco-boton no-print" onClick={() => setMenuQuiosco(true)} aria-label="Opciones del modo quiosco"><Icono n="mas" tam={20} /></button>}
        {menuQuiosco && <MenuQuiosco base="/grupo" onCerrar={() => setMenuQuiosco(false)} />}
        <AyudaGlobal base="/grupo" />
        {cambiando && <CambiarClave onCerrar={() => setCambiando(false)} onListo={() => { setCambiando(false); salir(); }} />}
      </div>
    );
  }

  // Empresa: menú lateral por grupos plegables (Operación · Negocio · Control · Ajustes).
  const activo = items.find((m) => location.pathname.startsWith(`${base}/${m.ruta}`));
  const sinCabecera = activo?.id === 'pos'; // el POS usa toda la altura
  const modo = modoPref ?? (activo?.id === 'pos' && enTablet ? 'oculto' : 'visible');
  const compacto = modo === 'compacto';
  const oculto = modo === 'oculto';
  const sucActual = s.sucursales.find((x) => x.id === s.sucursalId) ?? s.sucursales[0];
  const conNavInf = !sinCabecera && quiosco !== 'si';
  return (
    <div className={`app-shell no-print-shell${conNavInf ? ' con-nav-inf' : ''}${compacto ? ' compacto' : ''}${oculto ? ' oculto' : ''}`}>
      <a className="saltar no-print" href="#contenido">Saltar al contenido</a>
      <header className="barra-movil no-print">
        <Link to={base} className="marca-mini" aria-label={`Inicio de ${ctx.empresa.nombre}`}><Logo codigo={ctx.empresa.logo || ctx.empresa.codigo} color={color} /></Link>
        <div className="titulo-movil"><b className="t-modulo">{activo?.nombre ?? ctx.empresa.nombre}</b><small className="t-empresa">{s.sucursales.length === 1 && sucActual ? (sucActual.nombre.toLowerCase().includes(ctx.empresa.nombre.toLowerCase()) ? sucActual.nombre : `${ctx.empresa.nombre} · ${sucActual.nombre}`) : ctx.empresa.nombre}</small></div>
        {s.sucursales.length > 1 && <select value={s.sucursalId ?? ''} onChange={(e) => s.elegirSucursal(e.target.value)} aria-label="Sucursal activa">{s.sucursales.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}</select>}
        <button className="btn fantasma icono" onClick={() => setPaleta(true)} aria-label="Buscar módulo"><Icono n="lupa" tam={22} /></button>
        {!conNavInf && <button className="btn fantasma icono solo-angosto" onClick={() => setMas(true)} aria-label="Más opciones y módulos"><Icono n="menu" tam={22} /></button>}
      </header>
      <aside id="menu-lateral" className="sidebar no-print" aria-label="Menú principal">
        <div className="sidebar-cab">
          <Link to={base} className="sidebar-marca" aria-label={`Inicio de ${ctx.empresa.nombre}`}>
            <span className="sidebar-logo"><Logo codigo={ctx.empresa.logo || ctx.empresa.codigo} color={color} /></span>
            <span className="sidebar-marca-texto"><b className="titulo">{ctx.empresa.nombre}</b><small>{ctx.empresa.razon_social}</small></span>
          </Link>
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
        <button className="sidebar-buscar" onClick={() => setPaleta(true)} aria-label="Buscar módulo (Control K)">
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
                    <NavLink key={m.id} to={`${base}/${m.ruta}`} title={m.nombre} className={({ isActive }) => `sidebar-item${isActive ? ' activo' : ''}`}>
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
        <main className="contenido" id="contenido" tabIndex={-1}><LimiteError reinicio={location.pathname}><div className="vista" key={location.pathname}>{children}</div></LimiteError></main>
      </div>
      {conNavInf && <BarraInferior base={base} accesos={accesos} activoRuta={activo?.ruta} onMas={() => setMas(true)} masAbierto={mas} />}
      {mas && <HojaMas ctx={ctx} base={base} items={items} usuario={s.usuario} sucursales={s.sucursales} sucursalId={s.sucursalId} onSucursal={s.elegirSucursal} onBuscar={() => setPaleta(true)}
        puedeCambiar={puedeCambiar} esPin={s.via === 'pin'} onCerrar={() => setMas(false)} onCambiarEmpresa={() => nav('/')} onClave={() => setCambiando(true)} onSalir={salir} />}
      {quiosco === 'si' && <button className="quiosco-boton no-print" onClick={() => setMenuQuiosco(true)} aria-label="Opciones del modo quiosco"><Icono n="mas" tam={20} /></button>}
      {menuQuiosco && <MenuQuiosco base={base} onCerrar={() => setMenuQuiosco(false)} />}
      <Vigilancia base={base} />
      <AyudaGlobal base={base} />
      {paleta && <Suspense fallback={null}><Paleta opciones={opcionesPaleta} onCerrar={() => setPaleta(false)} /></Suspense>}
      {cambiando && <CambiarClave onCerrar={() => setCambiando(false)} onListo={() => { setCambiando(false); salir(); }} />}
    </div>
  );
}
