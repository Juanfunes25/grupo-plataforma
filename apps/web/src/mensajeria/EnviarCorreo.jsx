import { useState } from 'react';
import { post } from '../api.js';
import { Campo, Modal, useAviso } from '../ui/kit.jsx';
import './mensajeria.css';

const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Enviar un documento por correo (factura o cotización) con el PDF adjunto.
 * El correo viene del cliente pero se puede cambiar. El servidor deja constancia en la bitácora.
 *   ruta        POST que envía (p. ej. /pos/ventas/:id/correo)
 *   borrador    true = muestra la leyenda «BORRADOR – SIN VALOR FISCAL»
 *   onListo     se llama cuando el correo salió o quedó en cola
 */
export default function EnviarCorreo({ titulo = 'Enviar por correo', documento, correo = '', ruta, borrador = false, onCerrar, onListo }) {
  const avisar = useAviso();
  const [email, setEmail] = useState(correo ?? '');
  const [mensaje, setMensaje] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [resultado, setResultado] = useState(null);
  const valido = CORREO.test(email.trim());

  async function enviar() {
    setOcupado(true);
    try {
      const r = await post(ruta, { email: email.trim(), ...(mensaje.trim() ? { mensaje: mensaje.trim() } : {}) });
      if (r.ok) { avisar(r.mensaje || 'Correo enviado'); onListo?.(r); onCerrar(); return; }
      setResultado(r); onListo?.(r);
    } catch (e) { setResultado({ ok: false, pendiente: false, mensaje: e.message }); }
    finally { setOcupado(false); }
  }

  return (
    <Modal titulo={titulo} onCerrar={onCerrar} tam="angosto"
      pie={resultado
        ? <button className="btn primario" onClick={onCerrar}>Entendido</button>
        : <><button className="btn" onClick={onCerrar}>Cancelar</button><button className="btn primario" disabled={ocupado || !valido} onClick={enviar}>{ocupado ? 'Enviando…' : 'Enviar correo'}</button></>}>
      {documento && <p className="tenue" style={{ margin: 0 }}>{documento}. Se envía el PDF adjunto.</p>}
      {borrador && <div className="msg-borrador" role="note"><b>BORRADOR – SIN VALOR FISCAL</b><span>Etapa de pruebas: todavía no hay CAI autorizado. El correo y el PDF lo dicen.</span></div>}
      {resultado ? (
        <div className={`aviso-caja ${resultado.pendiente ? '' : 'mal'}`} role="status">
          {resultado.pendiente ? 'Quedó pendiente de envío. ' : 'No se pudo enviar. '}{resultado.error || resultado.mensaje}
          {resultado.pendiente && <small style={{ display: 'block' }}>Se reintenta solo; puedes verlo en Administración, Correo y avisos.</small>}
        </div>
      ) : (
        <>
          <Campo etiqueta="Correo del cliente" requerido ayuda="Puedes cambiarlo; no modifica la ficha del cliente.">
            <input type="email" inputMode="email" autoComplete="off" autoFocus={!email} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="cliente@correo.com" />
          </Campo>
          <Campo etiqueta="Mensaje (opcional)"><textarea rows={3} maxLength={500} value={mensaje} onChange={(e) => setMensaje(e.target.value)} placeholder="Un saludo o una indicación para el cliente" /></Campo>
        </>
      )}
    </Modal>
  );
}
