// Piezas pequeñas del cierre de caja.
import { L } from './formato.js';
import { estadoDiferencia } from './cuadre.js';
import './cierres.css';

/** Chip con el estado de una diferencia: Cuadra / Faltante L x / Sobrante L x. */
export function ChipDif({ valor, grande = false }) {
  if (valor === null || valor === undefined) return <span className={`cierre-dif nd${grande ? ' grande' : ''}`}>—</span>;
  const e = estadoDiferencia(valor);
  return <span className={`cierre-dif ${e.clase}${grande ? ' grande' : ''}`}>{e.texto}{e.clase !== 'ok' && ` ${L(Math.abs(valor))}`}</span>;
}

export function CampoMonto({ etiqueta, valor, onChange, ayuda, obligatorio, autoFocus, disabled }) {
  return (
    <label className="cierre-monto">
      <span>{etiqueta}{obligatorio && <span className="obligatorio"> *</span>}</span>
      <span className="cierre-caja-input">
        <input type="text" inputMode="decimal" placeholder="0.00" value={valor} autoFocus={autoFocus} disabled={disabled}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ''))} />
        <i>L</i>
      </span>
      {ayuda && <small>{ayuda}</small>}
    </label>
  );
}

export const FilaSistema = ({ etiqueta, valor, fuerte }) => (
  <div className={`cierre-fila${fuerte ? ' fuerte' : ''}`}><span>{etiqueta}</span><span className="num">{L(valor)}</span></div>
);
