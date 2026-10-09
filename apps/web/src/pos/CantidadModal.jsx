import { useState } from 'react';
import { lempiras } from '@grupo/shared';
import { Modal } from '../ui/kit.jsx';
import { Teclado, aplicarTecla, useTecladoFisico } from './Teclado.jsx';

/** Cantidad de una línea con teclado numérico. `decimal` = productos por peso (hasta 3 decimales); si no, solo enteros (unidades, cajas de piedra). */
export default function CantidadModal({ producto, inicial, decimal = false, onListo, onCerrar }) {
  const [txt, setTxt] = useState('');
  const [fresco, setFresco] = useState(true);   // la primera tecla reemplaza lo que había, como una calculadora
  const n = txt === '' ? Number(inicial) : parseFloat(txt);
  const valido = n > 0 && n <= 999;
  const tecla = (k) => {
    setTxt((t) => aplicarTecla(fresco && k !== 'borrar' ? '' : t, k, { decimales: decimal ? 3 : 0, max: 6 }));
    setFresco(false);
  };
  const listo = () => { if (valido) onListo(decimal ? Math.round(n * 1000) / 1000 : Math.floor(n)); };
  useTecladoFisico({ onTecla: tecla, onEnter: listo });
  return (
    <Modal titulo={producto.nombre} onCerrar={onCerrar} tam="angosto"
      pie={<button className="btn primario grande bloque" disabled={!valido} onClick={listo}>Listo{valido ? ` · ${decimal ? n : Math.floor(n)} ${decimal ? producto.unidad : ''}` : ''} (Enter)</button>}>
      <div className="centro"><div className="kpi"><div className="etq">Cantidad{decimal ? ` (${producto.unidad})` : ''}</div>
        <div className="val pos-cant-grande">{txt === '' ? inicial : txt}</div>
        <div className="sub">{valido ? lempiras((decimal ? n : Math.floor(n)) * Number(producto.precio)) : 'Escribe una cantidad mayor a 0'} · {lempiras(producto.precio)} c/u</div></div></div>
      <Teclado onTecla={tecla} decimales={decimal ? 3 : 0} />
      {n > 999 && <div className="aviso-caja mal">El máximo por línea es 999.</div>}
    </Modal>
  );
}
