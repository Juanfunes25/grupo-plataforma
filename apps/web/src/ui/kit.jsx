import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import Icono from './Icono.jsx';

// ── Avisos (toasts) ────────────────────────────────────────────────────────
const AvisoCtx = createContext(() => {});
export const useAviso = () => useContext(AvisoCtx);
export function ProveedorAvisos({ children }) {
  const [lista, setLista] = useState([]);
  const avisar = useCallback((texto, tipo = 'ok') => {
    const id = Math.random();
    setLista((l) => [...l, { id, texto, tipo }]);
    setTimeout(() => setLista((l) => l.filter((x) => x.id !== id)), tipo === 'mal' ? 6000 : 3200);
  }, []);
  return (
    <AvisoCtx.Provider value={avisar}>
      {children}
      <div className="toasts" role="status">{lista.map((t) => <div key={t.id} className={`toast ${t.tipo}`}>{t.texto}</div>)}</div>
    </AvisoCtx.Provider>
  );
}

// ── Modal ──────────────────────────────────────────────────────────────────
export function Modal({ titulo, onCerrar, children, pie, tam = '' }) {
  useEffect(() => {
    const f = (e) => e.key === 'Escape' && onCerrar?.();
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [onCerrar]);
  return (
    <div className="velo" onMouseDown={(e) => e.target === e.currentTarget && onCerrar?.()}>
      <div className={`modal ${tam}`} role="dialog" aria-modal="true" aria-label={titulo}>
        <div className="modal-cab"><h2>{titulo}</h2><button className="btn fantasma chico" onClick={onCerrar} aria-label="Cerrar"><Icono n="x" /></button></div>
        <div className="modal-cuerpo">{children}</div>
        {pie && <div className="modal-pie">{pie}</div>}
      </div>
    </div>
  );
}

// ── Datos ──────────────────────────────────────────────────────────────────
/** Carga datos con recarga manual y estados de carga/error. */
export function useDatos(fn, deps = []) {
  const [estado, setEstado] = useState({ datos: null, cargando: true, error: null });
  const n = useRef(0);
  const cargar = useCallback(async () => {
    const mi = ++n.current;
    setEstado((e) => ({ ...e, cargando: true, error: null }));
    try { const d = await fn(); if (mi === n.current) setEstado({ datos: d, cargando: false, error: null }); }
    catch (e) { if (mi === n.current) setEstado((s) => ({ ...s, cargando: false, error: e.message })); }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { cargar(); }, [cargar]);
  return { ...estado, recargar: cargar };
}

export const Cargando = ({ texto = 'Cargando…' }) => <div className="vacio">{texto}</div>;
export const ErrorCaja = ({ error }) => error ? <div className="aviso-caja mal">{error}</div> : null;
export const Vacio = ({ children }) => <div className="vacio">{children}</div>;

export function Estado({ d, children }) {
  if (d.cargando && !d.datos) return <Cargando />;
  if (d.error && !d.datos) return <ErrorCaja error={d.error} />;
  return children(d.datos);
}

// ── Formularios ────────────────────────────────────────────────────────────
export const Campo = ({ etiqueta, children, ayuda }) => (
  <label>{etiqueta}{children}{ayuda && <small>{ayuda}</small>}</label>
);

export function Tabs({ tabs, valor, onCambio }) {
  return <div className="tabs" role="tablist">{tabs.map(([id, nombre]) => <button key={id} role="tab" className={valor === id ? 'activa' : ''} onClick={() => onCambio(id)}>{nombre}</button>)}</div>;
}

/** Ejecuta una acción async con aviso de error y bloqueo de doble clic. */
export function useAccion() {
  const avisar = useAviso();
  const [ocupado, setOcupado] = useState(false);
  const ejecutar = useCallback(async (fn, okMsg) => {
    if (ocupado) return null;
    setOcupado(true);
    try { const r = await fn(); if (okMsg) avisar(okMsg); return r ?? true; }
    catch (e) { avisar(e.message, 'mal'); return null; }
    finally { setOcupado(false); }
  }, [ocupado, avisar]);
  return [ejecutar, ocupado];
}

// ── Gráficas mínimas ───────────────────────────────────────────────────────
export function Columnas({ datos, etiqueta, valor, formato = (v) => v, max }) {
  const m = max ?? Math.max(1, ...datos.map(valor));
  return (
    <div className="columnas">
      {datos.map((d, i) => (
        <div className="col" key={i} title={`${etiqueta(d)}: ${formato(valor(d))}`}>
          <i style={{ height: Math.max(3, Math.round((valor(d) / m) * 112)) }} />
          <span>{etiqueta(d)}</span>
        </div>
      ))}
    </div>
  );
}
export function BarrasH({ datos, etiqueta, valor, formato = (v) => v, color }) {
  const m = Math.max(1, ...datos.map(valor));
  return (
    <div className="barras">
      {datos.map((d, i) => (
        <div className="barra-fila" key={i}>
          <span title={etiqueta(d)} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{etiqueta(d)}</span>
          <div className="pista"><i style={{ width: `${(valor(d) / m) * 100}%`, ...(color ? { background: color(d, i) } : {}) }} /></div>
          <b className="num">{formato(valor(d))}</b>
        </div>
      ))}
    </div>
  );
}

export const Kpi = ({ etiqueta, valor, sub, acento }) => (
  <div className={`kpi ${acento ? 'acento' : ''}`}><div className="etq">{etiqueta}</div><div className="val">{valor}</div>{sub && <div className="sub">{sub}</div>}</div>
);

export function descargarCsv(nombre, filas, columnas) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [columnas.map((c) => esc(c[1])).join(','), ...filas.map((f) => columnas.map((c) => esc(f[c[0]])).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: nombre });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
