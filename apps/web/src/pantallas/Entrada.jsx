import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSesion } from '../sesion.jsx';
import { get } from '../api.js';
import { ErrorCaja, Esqueleto, useDatos } from '../ui/kit.jsx';
import Logo from '../ui/Logo.jsx';
import Icono from '../ui/Icono.jsx';
import { aplicarAcento, guardarTema, leerTema } from '../lib/acento.js';

// Primera pantalla: cada empresa con su logo. Sin sesión → pide acceso; con sesión de correo → entra directo.
export default function Entrada() {
  const nav = useNavigate();
  const s = useSesion();
  const d = useDatos(() => get('/publico/empresas', { sinSesion: true, empresa: null }), []);
  const [tema, setTema] = useState(leerTema);
  useEffect(() => { aplicarAcento('#c9a227'); document.title = 'Grupo · Plataforma'; }, []);

  const elegir = (e) => {
    const puedeDirecto = s.autenticado && s.via !== 'pin' && (e.codigo === 'grupo' || s.empresas.some((x) => x.codigo === e.codigo));
    if (puedeDirecto) { s.cambiarEmpresa(e.codigo); nav(e.codigo === 'grupo' ? '/grupo' : `/${e.codigo}`); }
    else nav(`/acceso/${e.codigo}`);
  };
  const empresas = (d.datos ?? []).filter((e) => e.codigo !== 'grupo');
  const grupo = (d.datos ?? []).find((e) => e.codigo === 'grupo');
  const dim = (e) => s.autenticado && !(e.codigo === 'grupo' ? s.via !== 'pin' : s.empresas.some((x) => x.codigo === e.codigo));
  const cambiarTema = () => { const n = tema === 'claro' ? 'oscuro' : 'claro'; guardarTema(n); setTema(n); };

  return (
    <main className="entrada">
      <button className="btn fantasma entrada-tema" onClick={cambiarTema} aria-label={tema === 'claro' ? 'Cambiar a tema oscuro' : 'Cambiar a tema claro'}><Icono n={tema === 'claro' ? 'luna' : 'sol'} tam={20} /></button>
      <div className="saludo">
        <span className="sello">Plataforma del Grupo</span>
        <h1>{s.usuario ? `Hola, ${s.usuario.nombre.split(' ')[0]}` : 'Bienvenido'}</h1>
        <p>{s.autenticado ? 'Elige la empresa en la que vas a trabajar.' : '¿A qué empresa vas a entrar?'}</p>
      </div>
      {d.cargando && !d.datos && <div className="empresas" aria-busy="true">{[0, 1, 2, 3].map((i) => <Esqueleto key={i} alto={150} />)}</div>}
      <ErrorCaja error={d.error} onReintentar={d.recargar} />
      <div className="empresas">
        {empresas.map((e) => (
          <button key={e.codigo} className={`empresa-card${dim(e) ? ' atenuada' : ''}`} style={{ '--c': e.color }} onClick={() => elegir(e)} aria-label={`Entrar a ${e.nombre}`}>
            <div className="logo-caja"><Logo codigo={e.logo || e.codigo} color={e.color} /></div>
            <div className="nombre">{e.nombre}</div>
            <small>{e.lema}</small>
          </button>
        ))}
        {grupo && (
          <button className={`empresa-card grupo${dim(grupo) ? ' atenuada' : ''}`} style={{ '--c': grupo.color }} onClick={() => elegir(grupo)} aria-label={`Entrar a ${grupo.nombre}`}>
            <div className="logo-caja"><Logo codigo="grupo" color={grupo.color} /></div>
            <div><div className="nombre" style={{ fontSize: '1.35rem' }}>{grupo.nombre}</div><small>{grupo.lema}</small></div>
          </button>
        )}
      </div>
      {s.autenticado && <div className="centro"><button className="btn fantasma chico" onClick={s.salir}><Icono n="salir" tam={16} /> Cerrar sesión</button></div>}
      <div className="centro"><Link to="/app" className="btn fantasma chico"><Icono n="descargar" tam={16} /> Instalar la app y apariencia</Link></div>
      <div className="pie-version">v{__VERSION__}</div>
    </main>
  );
}
