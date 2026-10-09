import { useEffect, useRef, useState } from 'react';
import { almacen, post } from '../api.js';
import { useSesion } from '../sesion.jsx';
import Icono from '../ui/Icono.jsx';
import { registrarEvento } from './eventos.js';
import './antifraude.css';

// Pantalla bloqueada tras X minutos sin uso: evita que otra persona use la sesión abierta de un
// compañero (y que las ventas queden a su nombre). Para seguir hay que volver a poner la contraseña
// (o el PIN); lo que estaba en pantalla, por ejemplo una orden en curso, no se pierde.
export default function BloqueoInactividad({ minutos }) {
  const s = useSesion();
  const [bloqueada, setBloqueada] = useState(false);
  const [secreto, setSecreto] = useState('');
  const [error, setError] = useState('');
  const [intentos, setIntentos] = useState(0);
  const [ocupado, setOcupado] = useState(false);
  const ultima = useRef(Date.now());
  const porPin = s.via === 'pin';

  useEffect(() => {
    if (!minutos) return undefined;
    const marcar = () => { ultima.current = Date.now(); };
    const evs = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
    evs.forEach((e) => window.addEventListener(e, marcar, { passive: true }));
    const t = setInterval(() => {
      if (!bloqueada && Date.now() - ultima.current > minutos * 60_000) { setBloqueada(true); registrarEvento('sesion.bloqueo', { minutos_inactivo: minutos }); }
    }, 15_000);
    return () => { evs.forEach((e) => window.removeEventListener(e, marcar)); clearInterval(t); };
  }, [minutos, bloqueada]);

  async function desbloquear(e) {
    e.preventDefault();
    setError(''); setOcupado(true);
    try {
      // Se vuelve a comprobar la credencial contra el servidor, sin cambiar la sesión actual.
      const cuerpo = porPin ? { empresa: s.empresa, usuario_id: s.usuario.id, pin: secreto } : { empresa: s.empresa, usuario: s.usuario.usuario || s.usuario.email, password: secreto };
      const r = await post(porPin ? '/auth/pin' : '/auth/login', cuerpo, { sinSesion: true, empresa: null });
      if (r.usuario?.id !== s.usuario.id) throw new Error('Ese PIN es de otra persona');
      registrarEvento('sesion.desbloqueo', {});
      setSecreto(''); setIntentos(0); ultima.current = Date.now(); setBloqueada(false);
    } catch (err) {
      const n = intentos + 1;
      setIntentos(n);
      registrarEvento('sesion.desbloqueo_fallido', { intento: n });
      setError(err.status === 429 ? err.message : porPin ? 'PIN incorrecto' : 'Contraseña incorrecta');
      if (n >= 5) { almacen.guardar(null); window.dispatchEvent(new Event('grupo:sesion-vencida')); }
    } finally { setOcupado(false); }
  }

  if (!bloqueada) return null;
  return (
    <div className="velo af-bloqueo" role="dialog" aria-modal="true" aria-label="Pantalla bloqueada">
      <form className="tarjeta af-bloqueo-tarjeta" onSubmit={desbloquear}>
        <Icono n="candado" tam={34} />
        <h2>Pantalla bloqueada</h2>
        <p className="tenue">Sesión de <strong>{s.usuario?.nombre}</strong>. Se bloqueó tras {minutos} minutos sin uso.</p>
        {error && <div className="aviso-caja mal">{error}</div>}
        <input type="password" autoFocus inputMode={porPin ? 'numeric' : undefined} autoComplete="current-password" placeholder={porPin ? 'PIN' : 'Contraseña'} value={secreto} onChange={(e) => setSecreto(e.target.value)} />
        <button type="submit" className="btn primario bloque" disabled={!secreto || ocupado}>Desbloquear</button>
        <button type="button" className="btn fantasma bloque" onClick={() => s.salir()}>Cambiar de usuario</button>
      </form>
    </div>
  );
}
