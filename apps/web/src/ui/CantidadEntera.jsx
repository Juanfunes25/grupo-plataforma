import { useState } from 'react';

/** Redondea hacia arriba a entero (la piedra se vende en cajas completas). Devuelve null si el texto no es un número. */
export function aEnteroArriba(texto) {
  const t = String(texto ?? '').trim().replace(',', '.');
  if (t === '' || !/^-?\d*\.?\d*$/.test(t) || t === '.' || t === '-') return null;
  return Math.ceil(Number(t) - 1e-9);
}

/**
 * Campo de cantidad ENTERA (cajas de 1 m²): teclado numérico, sin punto decimal, botones −/+ de 1 en 1.
 * Si pegan un decimal se redondea hacia arriba y se avisa. `value` es número o ''. `onChange` recibe número o ''.
 */
export default function CantidadEntera({ value, onChange, min = 1, max = 99999, negativo = false, botones = true, placeholder, ariaLabel, className, style }) {
  const [aviso, setAviso] = useState('');
  const fijar = (n) => { onChange(Math.min(max, Math.max(negativo ? -max : min, n))); };
  const cambio = (e) => {
    const crudo = e.target.value;
    if (crudo === '' || (negativo && crudo === '-')) { setAviso(''); onChange(''); return; }
    if (/[.,]/.test(crudo)) {
      const n = aEnteroArriba(crudo);
      if (n == null) return;
      setAviso(`Se redondeó ${crudo} a ${n}: la piedra solo se vende en cajas completas de 1 m².`);
      fijar(n);
      return;
    }
    const limpio = crudo.replace(negativo ? /[^\d-]/g : /\D/g, '');
    if (limpio === '' || limpio === '-') { onChange(''); return; }
    setAviso('');
    fijar(Number(limpio));
  };
  const paso = (d) => { setAviso(''); const base = Number(value) || 0; fijar(Math.max(negativo ? -max : min, base + d)); };
  return (
    <span className={`fila cant-entera ${className ?? ''}`} style={{ gap: 4, alignItems: 'center', flexWrap: 'wrap', ...style }}>
      {botones && <button type="button" className="btn chico" aria-label="Menos 1" onClick={() => paso(-1)}>−</button>}
      <input type="text" inputMode="numeric" pattern="-?[0-9]*" autoComplete="off" value={value === '' || value == null ? '' : String(value)} placeholder={placeholder}
        aria-label={ariaLabel} onChange={cambio} onFocus={(e) => e.target.select()} style={{ minWidth: 60, flex: 1, textAlign: 'center' }}
        onKeyDown={(e) => { if (['.', ',', 'e', 'E', '+'].includes(e.key) || (!negativo && e.key === '-')) e.preventDefault(); }} />
      {botones && <button type="button" className="btn chico" aria-label="Más 1" onClick={() => paso(1)}>+</button>}
      {aviso && <small role="status" style={{ flexBasis: '100%', color: 'var(--aviso)' }}>{aviso}</small>}
    </span>
  );
}
