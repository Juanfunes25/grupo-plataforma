import { useEffect, useRef } from 'react';

/** Aplica una tecla del teclado en pantalla a un texto numérico. `decimales` = cuántos dígitos después del punto (0 = solo enteros). */
export function aplicarTecla(texto, tecla, { decimales = 2, max = 9 } = {}) {
  if (tecla === 'borrar') return texto.slice(0, -1);
  if (tecla === 'limpiar') return '';
  if (tecla === '.') {
    if (!decimales || texto.includes('.')) return texto;
    return (texto || '0') + '.';
  }
  if (!/^\d$/.test(tecla)) return texto;
  if (texto.includes('.') && texto.split('.')[1].length >= decimales) return texto;
  if (texto === '0') return tecla;
  return texto.replace('.', '').length < max ? texto + tecla : texto;
}

/** Teclado numérico grande para pantalla táctil. */
export function Teclado({ onTecla, decimales = 2 }) {
  return (
    <div className="teclado pos-teclado">
      {['7', '8', '9', '4', '5', '6', '1', '2', '3'].map((k) => <button type="button" key={k} onClick={() => onTecla(k)}>{k}</button>)}
      {decimales > 0 ? <button type="button" onClick={() => onTecla('.')} aria-label="Punto decimal">.</button> : <button type="button" onClick={() => onTecla('limpiar')} aria-label="Borrar todo" className="tk-aux">C</button>}
      <button type="button" onClick={() => onTecla('0')}>0</button>
      <button type="button" onClick={() => onTecla('borrar')} aria-label="Borrar un dígito" className="tk-aux">⌫</button>
    </div>
  );
}

/**
 * También escucha el teclado físico mientras la ventana está abierta: dígitos, punto, Backspace y Enter.
 * Así la misma ventana sirve con pantalla táctil y con teclado de computadora.
 */
export function useTecladoFisico({ onTecla, onEnter, activo = true }) {
  const f = useRef({ onTecla, onEnter }); f.current = { onTecla, onEnter };
  useEffect(() => {
    if (!activo) return undefined;
    const h = (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !['button', 'checkbox'].includes(t.type)))) return;
      if (/^\d$/.test(e.key)) { e.preventDefault(); f.current.onTecla(e.key); }
      else if (e.key === '.' || e.key === ',') { e.preventDefault(); f.current.onTecla('.'); }
      else if (e.key === 'Backspace') { e.preventDefault(); f.current.onTecla('borrar'); }
      else if (e.key === 'Delete') { e.preventDefault(); f.current.onTecla('limpiar'); }
      else if (e.key === 'Enter' && t?.tagName !== 'BUTTON') { e.preventDefault(); f.current.onEnter?.(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [activo]);
}
