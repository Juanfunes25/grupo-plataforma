import { useState } from 'react';
import { Campo, Modal } from '../ui/kit.jsx';

/** Descuento de tercera edad: se registra quién es (la factura debe poder justificarlo ante el SAR). */
export default function TerceraEdadModal({ inicial, onListo, onCerrar }) {
  const [f, setF] = useState(inicial ?? { nombre: '', identidad: '' });
  const valido = f.nombre.trim().length >= 3 && f.identidad.trim().length >= 8;
  return (
    <Modal titulo="Descuento de tercera edad" onCerrar={onCerrar} tam="angosto" pie={<button className="btn primario" disabled={!valido} onClick={() => onListo({ nombre: f.nombre.trim(), identidad: f.identidad.trim() })}>Aplicar 25 %</button>}>
      <small>Anota los datos de la persona beneficiada. Quedan en la factura y en la bitácora.</small>
      <Campo etiqueta="Nombre completo"><input value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} autoFocus /></Campo>
      <Campo etiqueta="Número de identidad / carné"><input value={f.identidad} onChange={(e) => setF({ ...f, identidad: e.target.value })} placeholder="0801-1950-00000" /></Campo>
    </Modal>
  );
}
