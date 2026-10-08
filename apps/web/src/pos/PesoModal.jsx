import { useState } from 'react';
import { lempiras } from '@grupo/shared';
import { Modal } from '../ui/kit.jsx';

/** Cantidad por peso (kg, lb) con teclado numérico grande. */
export default function PesoModal({ producto, onListo, onCerrar }) {
  const [txt, setTxt] = useState('');
  const n = parseFloat(txt || '0');
  const tecla = (k) => setTxt((t) => {
    if (k === '.') return t.includes('.') ? t : (t || '0') + '.';
    if (t.includes('.') && t.split('.')[1].length >= 3) return t;
    return t.length < 7 ? t + k : t;
  });
  return (
    <Modal titulo={`${producto.nombre}`} onCerrar={onCerrar} tam="angosto"
      pie={<button className="btn primario grande bloque" disabled={!(n > 0)} onClick={() => onListo(n)}>Agregar {n > 0 ? `· ${lempiras(n * Number(producto.precio))}` : ''}</button>}>
      <div className="centro"><div className="kpi"><div className="etq">Cantidad ({producto.unidad})</div><div className="val">{txt || '0'}</div><div className="sub">{lempiras(producto.precio)} por {producto.unidad}</div></div></div>
      <div className="teclado">
        {['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0'].map((k) => <button key={k} onClick={() => tecla(k)}>{k}</button>)}
        <button onClick={() => setTxt((t) => t.slice(0, -1))} aria-label="Borrar">⌫</button>
      </div>
    </Modal>
  );
}
