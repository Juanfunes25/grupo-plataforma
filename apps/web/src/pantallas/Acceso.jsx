import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useSesion } from '../sesion.jsx';
import { get } from '../api.js';
import { Campo, useAccion, useDatos } from '../ui/kit.jsx';
import Logo from '../ui/Logo.jsx';
import Icono from '../ui/Icono.jsx';

export default function Acceso() {
  const { codigo } = useParams();
  const nav = useNavigate();
  const s = useSesion();
  const d = useDatos(() => get('/publico/empresas', { sinSesion: true, empresa: null }), []);
  const emp = d.datos?.find((e) => e.codigo === codigo);
  const esGrupo = codigo === 'grupo';
  const [modo, setModo] = useState(esGrupo ? 'correo' : 'pin');
  const [pin, setPin] = useState('');
  const [correo, setCorreo] = useState('');
  const [clave, setClave] = useState('');
  const [error, setError] = useState('');
  const [ejecutar, ocupado] = useAccion();

  useEffect(() => { document.documentElement.style.setProperty('--acento', emp?.color ?? '#c5603c'); }, [emp]);

  const entrar = async (ruta, cuerpo) => {
    setError('');
    const r = await ejecutar(async () => { try { return await s.entrar(ruta, cuerpo); } catch (e) { setError(e.message); setPin(''); throw e; } });
    if (r) nav(codigo === 'grupo' ? '/grupo' : `/${codigo}`, { replace: true });
  };
  const teclear = (n) => setPin((p) => (p.length < 8 ? p + n : p));

  if (d.datos && !emp) return <div className="acceso"><div className="aviso-caja mal">Empresa no encontrada.</div></div>;
  if (!emp) return null;

  return (
    <div className="acceso">
      <div className="acceso-card">
        <div className="centro" style={{ display: 'grid', justifyItems: 'center', gap: 8 }}>
          <div style={{ height: 88, display: 'grid', placeItems: 'center' }}><Logo codigo={emp.logo || emp.codigo} color={emp.color} /></div>
          <h1 style={{ letterSpacing: '.14em' }}>{emp.nombre}</h1>
        </div>
        {!esGrupo && (
          <div className="tabs" style={{ justifyContent: 'center' }}>
            <button className={modo === 'pin' ? 'activa' : ''} onClick={() => { setModo('pin'); setError(''); }}>Entrar con PIN</button>
            <button className={modo === 'correo' ? 'activa' : ''} onClick={() => { setModo('correo'); setError(''); }}>Correo</button>
          </div>
        )}
        <div className="tarjeta" style={{ display: 'grid', gap: 14 }}>
          {modo === 'pin' ? (
            <>
              <div className="pin-puntos" aria-label={`${pin.length} dígitos`}>{Array.from({ length: Math.max(4, pin.length) }, (_, i) => <i key={i} className={i < pin.length ? 'on' : ''} />)}</div>
              <div className="teclado">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => <button key={n} onClick={() => teclear(n)}>{n}</button>)}
                <button onClick={() => setPin('')} aria-label="Borrar todo"><Icono n="x" /></button>
                <button onClick={() => teclear(0)}>0</button>
                <button onClick={() => setPin((p) => p.slice(0, -1))} aria-label="Borrar">⌫</button>
              </div>
              <button className="btn primario grande bloque" disabled={pin.length < 4 || ocupado} onClick={() => entrar('/auth/pin', { empresa: codigo, pin })}>Entrar</button>
            </>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); entrar('/auth/login', { empresa: codigo, email: correo, password: clave }); }} style={{ display: 'grid', gap: 12 }}>
              <Campo etiqueta="Correo"><input type="email" autoComplete="username" value={correo} onChange={(e) => setCorreo(e.target.value)} required autoFocus /></Campo>
              <Campo etiqueta="Contraseña"><input type="password" autoComplete="current-password" value={clave} onChange={(e) => setClave(e.target.value)} required /></Campo>
              <button className="btn primario grande bloque" disabled={ocupado}>Entrar</button>
            </form>
          )}
          {error && <div className="aviso-caja mal" role="alert">{error}</div>}
        </div>
        <div className="centro"><button className="btn fantasma chico" onClick={() => nav('/')}><Icono n="atras" tam={16} /> Cambiar de empresa</button></div>
      </div>
    </div>
  );
}
