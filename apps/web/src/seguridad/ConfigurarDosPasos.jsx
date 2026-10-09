import { useEffect, useState } from 'react';
import { post } from '../api.js';
import { Campo, useAccion, useAviso } from '../ui/kit.jsx';
import Qr from './Qr.jsx';
import './seguridad.css';

/** Muestra los códigos de recuperación UNA vez y exige confirmar que se guardaron. */
export function CodigosRecuperacion({ codigos, onListo, textoListo = 'Ya los guardé' }) {
  const aviso = useAviso();
  const [ok, setOk] = useState(false);
  const copiar = async () => { try { await navigator.clipboard.writeText(codigos.join('\n')); aviso('Códigos copiados'); } catch { aviso('No se pudo copiar; anótalos a mano'); } };
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="aviso-caja">Guarda estos <b>10 códigos de recuperación</b> en un lugar seguro (no en este mismo teléfono). Cada uno sirve <b>una sola vez</b> si pierdes el acceso a tu aplicación. No se vuelven a mostrar.</div>
      <div className="rejilla-codigos">{codigos.map((c) => <span key={c}>{c}</span>)}</div>
      <div className="fila">
        <button type="button" className="btn" onClick={copiar}>Copiar</button>
        <button type="button" className="btn" onClick={() => window.print()}>Imprimir</button>
      </div>
      <label className="casilla"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> Confirmo que los guardé</label>
      <button type="button" className="btn primario" disabled={!ok} onClick={onListo}>{textoListo}</button>
    </div>
  );
}

/**
 * Pasos para activar la verificación en dos pasos: escanear el QR, escribir el primer código y guardar los códigos de recuperación.
 * `rutas` cambia entre la activación con sesión y la obligatoria del login (que lleva el desafío).
 */
export default function ConfigurarDosPasos({ rutaIniciar, rutaConfirmar, extra = {}, onActivada }) {
  const [datos, setDatos] = useState(null);
  const [codigo, setCodigo] = useState('');
  const [respuesta, setRespuesta] = useState(null);
  const [ejecutar, ocupado] = useAccion();

  useEffect(() => { ejecutar(async () => setDatos(await post(rutaIniciar, extra))); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (respuesta) return <CodigosRecuperacion codigos={respuesta.codigos_recuperacion} onListo={() => onActivada(respuesta)} />;
  if (!datos) return <small>Preparando…</small>;
  const confirmar = async (e) => {
    e.preventDefault();
    const r = await ejecutar(() => post(rutaConfirmar, { ...extra, codigo }));
    if (r) setRespuesta(r);
  };
  return (
    <form onSubmit={confirmar} style={{ display: 'grid', gap: 14 }}>
      <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 6 }}>
        <li>Instala <b>Google Authenticator</b> (o Microsoft Authenticator, Authy…) en tu teléfono.</li>
        <li>Escanea este código QR. Si no puedes, escribe la clave a mano.</li>
        <li>Escribe aquí el código de 6 dígitos que muestra la aplicación.</li>
      </ol>
      <Qr texto={datos.uri} />
      <div className="codigo-secreto" aria-label="Clave para escribir a mano">{datos.secreto.match(/.{1,4}/g).join(' ')}</div>
      <Campo etiqueta="Código de 6 dígitos"><input className="codigo-6" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={codigo} onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ''))} autoFocus /></Campo>
      <button className="btn primario" disabled={codigo.length !== 6 || ocupado}>Activar verificación</button>
    </form>
  );
}
