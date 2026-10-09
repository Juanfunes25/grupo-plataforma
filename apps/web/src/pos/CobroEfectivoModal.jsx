import { useState } from 'react';
import { DENOMINACIONES_EFECTIVO, lempiras } from '@grupo/shared';
import { Modal } from '../ui/kit.jsx';
import { Teclado, aplicarTecla, useTecladoFisico } from './Teclado.jsx';

const redondear = (n) => Math.round(n * 100) / 100;

/**
 * Cobro en efectivo con lo que entregó el cliente: teclado en pantalla (o físico), billetes rápidos y el CAMBIO en grande.
 * Enter sin escribir nada cobra el total exacto. `sinConexion` solo cambia el aviso: el cobro es igual de rápido.
 */
export default function CobroEfectivoModal({ total, ocupado, error, sinConexion = false, onCobrar, onCerrar }) {
  const [txt, setTxt] = useState('');
  const recibido = txt === '' ? total : parseFloat(txt) || 0;
  const cambio = redondear(Math.max(0, recibido - total));
  const falta = redondear(Math.max(0, total - recibido));
  const ok = recibido + 0.001 >= total && !ocupado;
  const tecla = (k) => setTxt((t) => aplicarTecla(t, k, { decimales: 2, max: 8 }));
  const cobrar = () => { if (ok) onCobrar(redondear(recibido)); };
  useTecladoFisico({ onTecla: tecla, onEnter: cobrar });
  const billetes = DENOMINACIONES_EFECTIVO.filter((d) => d >= total).slice(0, 3);
  return (
    <Modal titulo="Efectivo recibido" onCerrar={onCerrar} tam="ancho"
      pie={<><button className="btn fantasma" onClick={onCerrar}>Volver</button>
        <button className="btn primario grande" disabled={!ok} onClick={cobrar}>{ocupado ? 'Cobrando…' : sinConexion ? `Cobrar ${lempiras(total)} sin conexión (Enter)` : `Cobrar ${lempiras(total)} (Enter)`}</button></>}>
      {sinConexion && <div className="aviso-caja" role="note">Sin conexión: se entrega un comprobante provisional y la factura se emite sola al volver el internet.</div>}
      <div className="pos-efectivo">
        <div className="pos-efectivo-izq">
          <div className="kpi acento"><div className="etq">Total a cobrar</div><div className="val">{lempiras(total)}</div></div>
          <div className="kpi"><div className="etq">Recibido</div><div className="val pos-cant-grande">{txt === '' ? lempiras(total) : `L ${txt}`}</div><div className="sub">{txt === '' ? 'Enter o Cobrar = pago exacto' : 'Escribe el monto que dio el cliente'}</div></div>
          <div className={`kpi pos-cambio ${falta > 0 ? 'aviso' : cambio > 0 ? 'ok' : ''}`} aria-live="polite">
            <div className="etq">{falta > 0 ? 'Falta' : 'Cambio a entregar'}</div>
            <div className="val">{lempiras(falta > 0 ? falta : cambio)}</div>
          </div>
        </div>
        <div className="pos-efectivo-der">
          <div className="fila pos-billetes">
            <button className="btn grande" onClick={() => setTxt('')}>Exacto</button>
            {billetes.filter((b) => b !== total).map((b) => <button key={b} className="btn grande" onClick={() => setTxt(String(b))}>L {b}</button>)}
          </div>
          <Teclado onTecla={tecla} decimales={2} />
        </div>
      </div>
      {error && <div className="aviso-caja mal" role="alert">{error}</div>}
    </Modal>
  );
}
