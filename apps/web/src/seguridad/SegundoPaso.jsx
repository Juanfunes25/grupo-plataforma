import { useState } from 'react';
import { post } from '../api.js';
import { Campo, useAccion } from '../ui/kit.jsx';
import ConfigurarDosPasos from './ConfigurarDosPasos.jsx';
import './seguridad.css';

/**
 * Segundo paso del login (después de correo y contraseña correctos).
 * `r` es la respuesta del servidor: { requiere_2fa, desafio } o { requiere_configurar_2fa, desafio }.
 * `onSesion(respuestaConToken)` guarda la sesión.
 */
export default function SegundoPaso({ r, onSesion, onCancelar }) {
  const [codigo, setCodigo] = useState('');
  const [recuperacion, setRecuperacion] = useState(false);
  const [error, setError] = useState('');
  const [ejecutar, ocupado] = useAccion();
  const [fin, setFin] = useState(null);

  if (r.requiere_configurar_2fa) {
    return (
      <div style={{ display: 'grid', gap: 12 }}>
        <div className="aviso-caja">Por seguridad, tu cargo exige la <b>verificación en dos pasos</b>. Actívala ahora (toma un minuto).</div>
        <ConfigurarDosPasos rutaIniciar="/auth/2fa/configurar" rutaConfirmar="/auth/2fa/configurar-confirmar" extra={{ desafio: r.desafio }} onActivada={(resp) => onSesion(resp)} />
        <button type="button" className="btn fantasma" onClick={onCancelar}>Cancelar</button>
      </div>
    );
  }
  const entrar = async (e) => {
    e.preventDefault(); setError('');
    try {
      const resp = await ejecutar(async () => {
        try { return await post('/auth/login-2fa', { desafio: r.desafio, codigo }, { sinSesion: true, empresa: null }); }
        catch (x) { setError(x.message); setCodigo(''); throw x; }
      });
      if (resp) { if (resp.aviso) setFin(resp); else onSesion(resp); }
    } catch { /* ya se mostró */ }
  };
  if (fin) return <div style={{ display: 'grid', gap: 12 }}><div className="aviso-caja">{fin.aviso}</div><button className="btn primario" onClick={() => onSesion(fin)}>Continuar</button></div>;
  return (
    <form onSubmit={entrar} style={{ display: 'grid', gap: 14 }}>
      <div className="aviso-caja">Escribe el código de {recuperacion ? 'recuperación' : '6 dígitos de tu aplicación de autenticación'}.</div>
      <Campo etiqueta={recuperacion ? 'Código de recuperación (XXXXX-XXXXX)' : 'Código de 6 dígitos'}>
        {recuperacion
          ? <input value={codigo} autoCapitalize="characters" autoComplete="off" onChange={(e) => setCodigo(e.target.value)} autoFocus />
          : <input className="codigo-6" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={codigo} onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ''))} autoFocus />}
      </Campo>
      {error && <div className="aviso-caja mal" role="alert">{error}</div>}
      <button className={`btn primario grande bloque${ocupado ? ' cargando' : ''}`} disabled={ocupado || codigo.length < (recuperacion ? 10 : 6)}>Entrar</button>
      <div className="fila" style={{ justifyContent: 'space-between' }}>
        <button type="button" className="btn fantasma" onClick={() => { setRecuperacion(!recuperacion); setCodigo(''); setError(''); }}>{recuperacion ? 'Usar mi aplicación' : 'Usar un código de recuperación'}</button>
        <button type="button" className="btn fantasma" onClick={onCancelar}>Cancelar</button>
      </div>
    </form>
  );
}
