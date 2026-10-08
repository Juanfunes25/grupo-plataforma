import { useNavigate } from 'react-router-dom';
import { useSesion } from '../sesion.jsx';
import { get } from '../api.js';
import { Cargando, ErrorCaja, useDatos } from '../ui/kit.jsx';
import Logo from '../ui/Logo.jsx';

// Primera pantalla: cada empresa con su logo. Sin sesión → pide acceso; con sesión de correo → entra directo.
export default function Entrada() {
  const nav = useNavigate();
  const s = useSesion();
  const d = useDatos(() => get('/publico/empresas', { sinSesion: true, empresa: null }), []);

  const elegir = (e) => {
    const puedeDirecto = s.autenticado && s.via !== 'pin' && (e.codigo === 'grupo' || s.empresas.some((x) => x.codigo === e.codigo));
    if (puedeDirecto) { s.cambiarEmpresa(e.codigo); nav(e.codigo === 'grupo' ? '/grupo' : `/${e.codigo}`); }
    else nav(`/acceso/${e.codigo}`);
  };
  const empresas = (d.datos ?? []).filter((e) => e.codigo !== 'grupo');
  const grupo = (d.datos ?? []).find((e) => e.codigo === 'grupo');
  const dim = (e) => s.autenticado && !(e.codigo === 'grupo' ? s.via !== 'pin' : s.empresas.some((x) => x.codigo === e.codigo));

  return (
    <div className="entrada">
      <div className="saludo">
        <h1>{s.usuario ? `Hola, ${s.usuario.nombre.split(' ')[0]}` : 'Bienvenido'}</h1>
        <p>¿A qué empresa vas a entrar?</p>
      </div>
      {d.cargando && !d.datos && <Cargando />}
      <ErrorCaja error={d.error} />
      <div className="empresas">
        {empresas.map((e) => (
          <button key={e.codigo} className="empresa-card" style={{ '--c': e.color, opacity: dim(e) ? 0.4 : 1 }} onClick={() => elegir(e)} aria-label={`Entrar a ${e.nombre}`}>
            <div className="logo-caja"><Logo codigo={e.logo || e.codigo} color={e.color} /></div>
            <div className="nombre">{e.nombre}</div>
            <small>{e.lema}</small>
          </button>
        ))}
        {grupo && (
          <button className="empresa-card grupo" style={{ '--c': grupo.color, opacity: dim(grupo) ? 0.4 : 1 }} onClick={() => elegir(grupo)}>
            <div className="logo-caja" style={{ height: 56 }}><Logo codigo="grupo" color={grupo.color} /></div>
            <div><div className="nombre" style={{ fontSize: '1.3rem' }}>{grupo.nombre}</div><small>{grupo.lema}</small></div>
          </button>
        )}
      </div>
      {s.autenticado && <div className="centro"><button className="btn fantasma chico" onClick={s.salir}>Cerrar sesión</button></div>}
      <div className="pie-version">v{__VERSION__}</div>
    </div>
  );
}
