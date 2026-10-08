import { useEffect, useMemo, useRef, useState } from 'react';
import Icono from './Icono.jsx';

const sinTildes = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Buscador de módulos y acciones (Ctrl/⌘+K). opciones: [{ id, grupo, nombre, detalle, icono, accion }] */
export default function Paleta({ opciones, onCerrar }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const lista = useRef(null);
  const previo = useRef(document.activeElement);
  const filtradas = useMemo(() => {
    const t = sinTildes(q).trim();
    if (!t) return opciones;
    return opciones.filter((o) => t.split(/\s+/).every((p) => sinTildes(`${o.nombre} ${o.detalle ?? ''} ${o.grupo ?? ''}`).includes(p)));
  }, [q, opciones]);
  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => () => { try { previo.current?.focus?.({ preventScroll: true }); } catch { /* */ } }, []);
  useEffect(() => { lista.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [sel, filtradas]);

  const elegir = (o) => { if (!o) return; onCerrar(); o.accion(); };
  const teclas = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onCerrar(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(filtradas.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); elegir(filtradas[sel]); }
  };
  let ultimoGrupo = null;
  return (
    <div className="paleta-velo" onMouseDown={(e) => e.target === e.currentTarget && onCerrar()}>
      <div className="paleta" role="dialog" aria-modal="true" aria-label="Buscar módulo" onKeyDown={teclas}>
        <div className="paleta-entrada">
          <Icono n="lupa" tam={20} />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar módulo o acción…" aria-label="Buscar módulo o acción" role="combobox" aria-expanded="true" aria-controls="paleta-lista" aria-activedescendant={filtradas[sel] ? `paleta-${filtradas[sel].id}` : undefined} autoComplete="off" />
          <kbd>Esc</kbd>
        </div>
        <div className="paleta-lista" id="paleta-lista" role="listbox" ref={lista}>
          {filtradas.length === 0 && <div className="vacio">Nada coincide con «{q}».</div>}
          {filtradas.map((o, i) => {
            const cab = o.grupo !== ultimoGrupo ? o.grupo : null; ultimoGrupo = o.grupo;
            return (
              <div key={o.id} style={{ display: 'contents' }}>
                {cab && <div className="paleta-grupo">{cab}</div>}
                <button id={`paleta-${o.id}`} role="option" aria-selected={i === sel} tabIndex={-1} className="paleta-op" onMouseMove={() => setSel(i)} onClick={() => elegir(o)}>
                  <Icono n={o.icono} tam={18} /><span>{o.nombre}</span>{o.detalle && <small>{o.detalle}</small>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="paleta-pie"><span><kbd>↑</kbd> <kbd>↓</kbd> moverse</span><span><kbd>Enter</kbd> abrir</span></div>
      </div>
    </div>
  );
}
