import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useSesion } from '../sesion.jsx';
import { get } from '../api.js';
import { Campo, Esqueleto, vibrar, useAccion, useDatos } from '../ui/kit.jsx';
import Logo from '../ui/Logo.jsx';
import Icono from '../ui/Icono.jsx';
import { aplicarAcento } from '../lib/acento.js';
import SegundoPaso from '../seguridad/SegundoPaso.jsx';

const PIN_MAX = 8;

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
  const [verClave, setVerClave] = useState(false);
  const [error, setError] = useState('');
  const [sacude, setSacude] = useState(false);
  const [ejecutar, ocupado] = useAccion();
  const [segundo, setSegundo] = useState(null);   // respuesta del login que pide el segundo paso (verificación en dos pasos)
  const pinRef = useRef(pin);
  pinRef.current = pin;

  useEffect(() => { aplicarAcento(emp?.color ?? '#c5603c'); }, [emp]);
  useEffect(() => { if (emp) document.title = `Entrar · ${emp.nombre}`; }, [emp]);

  const entrar = async (ruta, cuerpo) => {
    setError('');
    const r = await ejecutar(async () => {
      try { return await s.entrar(ruta, cuerpo); }
      catch (e) { setError(e.message); setPin(''); setSacude(true); vibrar([60, 40, 60]); setTimeout(() => setSacude(false), 450); throw e; }
    });
    if (r?.requiere_2fa || r?.requiere_configurar_2fa) { setSegundo(r); return; }
    if (r) nav(codigo === 'grupo' ? '/grupo' : `/${codigo}`, { replace: true });
  };
  const teclear = (n) => { vibrar(8); setError(''); setPin((p) => (p.length < PIN_MAX ? p + n : p)); };
  const enviarPin = () => { if (pinRef.current.length >= 4) entrar('/auth/pin', { empresa: codigo, pin: pinRef.current }); };

  // Teclado físico (tablet con teclado, PC): dígitos, Retroceso, Supr/Esc limpia y Enter entra.
  useEffect(() => {
    if (modo !== 'pin') return undefined;
    const f = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key)) teclear(e.key);
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
      else if (e.key === 'Delete' || e.key === 'Escape') setPin('');
      else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') enviarPin();
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  if (d.datos && !emp) return <main className="acceso"><div className="aviso-caja mal" role="alert">Empresa no encontrada.</div><button className="btn" onClick={() => nav('/')}>Volver al inicio</button></main>;
  if (!emp) return <main className="acceso" aria-busy="true"><div className="acceso-card"><Esqueleto alto={120} /><Esqueleto alto={300} /></div></main>;

  const cambiarModo = (m) => { setModo(m); setError(''); };
  return (
    <main className="acceso">
      <div className="acceso-card">
        <div className="acceso-marca">
          <div className="acceso-logo"><Logo codigo={emp.logo || emp.codigo} color={emp.color} /></div>
          <h1>{emp.nombre}</h1>
          <p>{modo === 'pin' ? 'Escribe tu PIN para entrar' : 'Entra con tu correo y contraseña'}</p>
        </div>
        {!esGrupo && (
          <div className="segmento" role="tablist" aria-label="Forma de entrar">
            <button role="tab" aria-selected={modo === 'pin'} onClick={() => cambiarModo('pin')}>Entrar con PIN</button>
            <button role="tab" aria-selected={modo === 'correo'} onClick={() => cambiarModo('correo')}>Correo</button>
          </div>
        )}
        <div className="tarjeta" style={{ display: 'grid', gap: 16 }}>
          {segundo ? (
            <SegundoPaso r={segundo} onCancelar={() => { setSegundo(null); setClave(''); }}
              onSesion={(resp) => { s.completar(resp); nav(codigo === 'grupo' ? '/grupo' : `/${codigo}`, { replace: true }); }} />
          ) : modo === 'pin' ? (
            <>
              <div className={`pin-puntos${sacude ? ' error' : ''}`} role="img" aria-label={`${pin.length} dígitos escritos`}>{Array.from({ length: Math.max(4, pin.length) }, (_, i) => <i key={i} className={i < pin.length ? 'on' : ''} />)}</div>
              <div className="teclado" role="group" aria-label="Teclado numérico">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => <button key={n} onClick={() => teclear(n)} aria-label={String(n)}>{n}</button>)}
                <button className="aux" onClick={() => setPin('')} aria-label="Borrar todo">Borrar</button>
                <button onClick={() => teclear(0)} aria-label="0">0</button>
                <button className="aux" onClick={() => { vibrar(8); setPin((p) => p.slice(0, -1)); }} aria-label="Borrar un dígito"><Icono n="retroceso" tam={28} /></button>
              </div>
              <button className={`btn primario grande bloque${ocupado ? ' cargando' : ''}`} disabled={pin.length < 4 || ocupado} onClick={enviarPin}>Entrar</button>
              {pin.length > 0 && pin.length < 4 && <small className="centro">El PIN tiene al menos 4 dígitos.</small>}
            </>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); entrar('/auth/login', { empresa: codigo, email: correo, password: clave }); }} style={{ display: 'grid', gap: 14 }}>
              <Campo etiqueta="Correo"><input type="email" inputMode="email" autoComplete="username" autoCapitalize="none" spellCheck="false" value={correo} onChange={(e) => { setCorreo(e.target.value); setError(''); }} required autoFocus aria-invalid={Boolean(error)} /></Campo>
              <Campo etiqueta="Contraseña">
                <div className="campo-clave">
                  <input type={verClave ? 'text' : 'password'} autoComplete="current-password" value={clave} onChange={(e) => { setClave(e.target.value); setError(''); }} required aria-invalid={Boolean(error)} />
                  <button type="button" className="ver" onClick={() => setVerClave((v) => !v)} aria-label={verClave ? 'Ocultar contraseña' : 'Mostrar contraseña'}><Icono n={verClave ? 'ojoNo' : 'ojo'} tam={20} /></button>
                </div>
              </Campo>
              <button className={`btn primario grande bloque${ocupado ? ' cargando' : ''}`} disabled={ocupado}>Entrar</button>
            </form>
          )}
          {error && <div className="aviso-caja mal alerta" role="alert"><Icono n="alerta" tam={20} /><div>{error}</div></div>}
        </div>
        <div className="centro"><button className="btn fantasma" onClick={() => nav('/')}><Icono n="atras" tam={16} /> Cambiar de empresa</button></div>
      </div>
    </main>
  );
}
