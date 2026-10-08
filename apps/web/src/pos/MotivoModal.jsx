import { useState } from 'react';
import { Modal } from '../ui/kit.jsx';

/**
 * Pide un motivo (queda en la bitácora). Opciones rápidas para tocar con el dedo + "Otro" con texto libre.
 * Sirve para descartar una orden, reimprimir una factura o anularla.
 */
export default function MotivoModal({ titulo, texto, opciones, etiquetaBoton = 'Confirmar', peligro = false, ocupado = false, extra = null, bloqueado = false, onListo, onCerrar }) {
  const [elegido, setElegido] = useState(null);       // índice o 'otro'
  const [otro, setOtro] = useState('');
  const motivo = elegido === 'otro' ? otro.trim() : elegido != null ? opciones[elegido] : '';
  return (
    <Modal titulo={titulo} onCerrar={onCerrar} tam="angosto"
      pie={<>
        <button className="btn fantasma" onClick={onCerrar}>Cancelar</button>
        <button className={`btn grande ${peligro ? 'peligro' : 'primario'}`} disabled={motivo.length < 3 || ocupado || bloqueado} onClick={() => onListo(motivo.slice(0, 200))}>{ocupado ? 'Un momento…' : etiquetaBoton}</button>
      </>}>
      {texto && <p style={{ margin: 0 }}>{texto}</p>}
      <div style={{ display: 'grid', gap: 8 }} role="radiogroup" aria-label="Motivo">
        {opciones.map((o, i) => (
          <button key={o} role="radio" aria-checked={elegido === i} className="btn" onClick={() => setElegido(i)}
            style={{ justifyContent: 'flex-start', textAlign: 'left', minHeight: 50, ...(elegido === i ? { background: 'var(--acento)', borderColor: 'transparent', color: '#fff' } : {}) }}>{o}</button>
        ))}
        <button role="radio" aria-checked={elegido === 'otro'} className="btn" onClick={() => setElegido('otro')}
          style={{ justifyContent: 'flex-start', minHeight: 50, ...(elegido === 'otro' ? { background: 'var(--acento)', borderColor: 'transparent', color: '#fff' } : {}) }}>Otro motivo…</button>
        {elegido === 'otro' && <input autoFocus value={otro} maxLength={200} onChange={(e) => setOtro(e.target.value)} placeholder="Escribe el motivo" aria-label="Otro motivo" />}
      </div>
      {extra}
    </Modal>
  );
}
