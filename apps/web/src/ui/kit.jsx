import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import Icono from './Icono.jsx';

// ── Retroalimentación háptica (solo donde el dispositivo la tiene) ──────────
export const vibrar = (patron = 12) => { try { navigator.vibrate?.(patron); } catch { /* sin vibración */ } };

// ── Avisos (toasts) y diálogos de confirmación ─────────────────────────────
const AvisoCtx = createContext(() => {});
const DialogoCtx = createContext({ confirmar: async () => true, pedirTexto: async () => null });
export const useAviso = () => useContext(AvisoCtx);
/** const confirmar = useConfirmar(); if (!(await confirmar({ titulo, mensaje, peligro: true, textoOk: 'Borrar' }))) return; */
export const useConfirmar = () => useContext(DialogoCtx).confirmar;
/** const pedir = usePedirTexto(); const motivo = await pedir({ titulo, etiqueta, obligatorio: true }); // null = canceló */
export const usePedirTexto = () => useContext(DialogoCtx).pedirTexto;

function DialogoTexto({ op, onFin }) {
  const [v, setV] = useState(op.valor ?? '');
  const ok = !op.obligatorio || v.trim().length >= (op.minimo ?? 1);
  const enviar = (e) => { e?.preventDefault(); if (ok) onFin(v.trim()); };
  return (
    <Modal titulo={op.titulo ?? 'Escribe un dato'} tam="angosto" onCerrar={() => onFin(null)}
      pie={<><button type="button" className="btn" onClick={() => onFin(null)}>Cancelar</button><button type="submit" form="dialogo-texto" className="btn primario" disabled={!ok}>{op.textoOk ?? 'Aceptar'}</button></>}>
      <form id="dialogo-texto" onSubmit={enviar} style={{ display: 'grid', gap: 12 }}>
        {op.mensaje && <p style={{ margin: 0 }}>{op.mensaje}</p>}
        <Campo etiqueta={op.etiqueta ?? ''} ayuda={op.obligatorio ? (op.ayuda ?? 'Es obligatorio.') : (op.ayuda ?? 'Es opcional.')}>
          {op.largo ? <textarea value={v} onChange={(e) => setV(e.target.value)} autoFocus /> : <input value={v} onChange={(e) => setV(e.target.value)} type={op.tipo ?? 'text'} inputMode={op.inputMode} autoFocus />}
        </Campo>
      </form>
    </Modal>
  );
}

export function ProveedorAvisos({ children }) {
  const [lista, setLista] = useState([]);
  const [dialogo, setDialogo] = useState(null);
  const avisar = useCallback((texto, tipo = 'ok') => {
    const id = Math.random();
    setLista((l) => [...l.slice(-3), { id, texto, tipo }]);
    vibrar(tipo === 'mal' ? [30, 40, 30] : 12);
    setTimeout(() => setLista((l) => l.filter((x) => x.id !== id)), tipo === 'mal' ? 7000 : 3500);
  }, []);
  const cerrarAviso = (id) => setLista((l) => l.filter((x) => x.id !== id));
  const dialogos = useRef(null);
  if (!dialogos.current) {
    dialogos.current = {
      confirmar: (op) => new Promise((res) => setDialogo({ tipo: 'confirmar', op: typeof op === 'string' ? { mensaje: op } : op, res })),
      pedirTexto: (op) => new Promise((res) => setDialogo({ tipo: 'texto', op: typeof op === 'string' ? { titulo: op } : op, res })),
    };
  }
  const fin = (valor) => { dialogo.res(valor); setDialogo(null); };
  return (
    <AvisoCtx.Provider value={avisar}>
      <DialogoCtx.Provider value={dialogos.current}>
        {children}
        <div className="toasts" role="status" aria-live="polite">
          {lista.map((t) => (
            <div key={t.id} className={`toast ${t.tipo}`} role={t.tipo === 'mal' ? 'alert' : undefined}>
              <Icono n={t.tipo === 'mal' ? 'alerta' : 'check'} tam={20} /><span>{t.texto}</span>
              <button className="toast-x" onClick={() => cerrarAviso(t.id)} aria-label="Cerrar aviso"><Icono n="x" tam={16} /></button>
            </div>
          ))}
        </div>
        {dialogo?.tipo === 'confirmar' && (
          <Modal titulo={dialogo.op.titulo ?? '¿Confirmas?'} tam="angosto" onCerrar={() => fin(false)}
            pie={<><button className="btn" onClick={() => fin(false)} autoFocus>{dialogo.op.textoNo ?? 'Cancelar'}</button><button className={`btn ${dialogo.op.peligro ? 'peligro' : 'primario'}`} onClick={() => fin(true)}>{dialogo.op.textoOk ?? 'Sí, continuar'}</button></>}>
            <div className="modal-confirmar"><p>{dialogo.op.mensaje}</p></div>
          </Modal>
        )}
        {dialogo?.tipo === 'texto' && <DialogoTexto op={dialogo.op} onFin={fin} />}
      </DialogoCtx.Provider>
    </AvisoCtx.Provider>
  );
}

// ── Modal ──────────────────────────────────────────────────────────────────
// Foco atrapado y devuelto al cerrar, Escape cierra solo el de arriba, fondo sin scroll.
const pilaModales = [];
let bloqueos = 0;
const ENFOCABLES = 'a[href], button:not(:disabled), input:not(:disabled):not([type=hidden]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
export function Modal({ titulo, onCerrar, children, pie, tam = '' }) {
  const ref = useRef(null);
  const cerrar = useRef(onCerrar);
  cerrar.current = onCerrar;
  useEffect(() => {
    const yo = Symbol('modal'); pilaModales.push(yo);
    const previo = document.activeElement;
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    if (bloqueos++ === 0) document.body.style.overflow = 'hidden';
    const f = (e) => { if (e.key === 'Escape' && pilaModales[pilaModales.length - 1] === yo) { e.stopPropagation(); cerrar.current?.(); } };
    window.addEventListener('keydown', f);
    return () => {
      window.removeEventListener('keydown', f);
      pilaModales.splice(pilaModales.indexOf(yo), 1);
      if (--bloqueos === 0) document.body.style.overflow = '';
      if (previo && document.contains(previo)) try { previo.focus({ preventScroll: true }); } catch { /* */ }
    };
  }, []);
  const teclas = (e) => {
    if (e.key !== 'Tab') return;
    const nodos = [...ref.current.querySelectorAll(ENFOCABLES)].filter((n) => n.offsetParent !== null);
    if (!nodos.length) { e.preventDefault(); return; }
    const [a, z] = [nodos[0], nodos[nodos.length - 1]];
    if (e.shiftKey && (document.activeElement === a || document.activeElement === ref.current)) { e.preventDefault(); z.focus(); }
    else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
  };
  // En celular el modal es una hoja desde abajo: se cierra arrastrando el asa o el encabezado hacia abajo.
  const arrastre = useRef(null);
  const esHoja = () => window.matchMedia('(max-width: 700px)').matches;
  const empezar = (e) => {
    if (!esHoja() || e.pointerType === 'mouse' || e.target.closest('button')) return;
    arrastre.current = { y0: e.clientY, t0: e.timeStamp, dy: 0 };
    ref.current.style.transition = 'none';
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* */ }
  };
  const mover = (e) => {
    const a = arrastre.current; if (!a) return;
    a.dy = Math.max(0, e.clientY - a.y0);
    ref.current.style.transform = `translateY(${a.dy}px)`;
    const v = ref.current.parentElement; if (v) v.style.background = `rgba(4,7,14,${Math.max(0.1, 0.72 - a.dy / 600)})`;
  };
  const soltar = (e) => {
    const a = arrastre.current; if (!a) return;
    arrastre.current = null;
    const el = ref.current; const v = el.parentElement;
    const rapido = a.dy / Math.max(1, e.timeStamp - a.t0) > 0.6;
    el.style.transition = 'transform .2s var(--ritmo)';
    if (a.dy > 110 || (rapido && a.dy > 30)) { el.style.transform = 'translateY(105%)'; if (v) v.style.opacity = '0'; vibrar(8); setTimeout(() => cerrar.current?.(), 180); }
    else { el.style.transform = ''; if (v) v.style.background = ''; }
  };
  return (
    <div className="velo" onMouseDown={(e) => e.target === e.currentTarget && onCerrar?.()}>
      <div ref={ref} tabIndex={-1} onKeyDown={teclas} className={`modal ${tam}`} role="dialog" aria-modal="true" aria-label={titulo}>
        <div className="modal-cab" onPointerDown={empezar} onPointerMove={mover} onPointerUp={soltar} onPointerCancel={soltar}><span className="modal-asa" aria-hidden="true" /><h2>{titulo}</h2><button className="btn fantasma" onClick={onCerrar} aria-label="Cerrar"><Icono n="x" /></button></div>
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

export const Esqueleto = ({ alto = 80, ancho }) => <div className="esqueleto" style={{ height: alto, ...(ancho ? { width: ancho } : {}) }} aria-hidden="true" />;
/** Esqueleto de carga (mejor percepción de velocidad que un texto suelto). */
export const Cargando = ({ texto = 'Cargando…', filas = 3 }) => (
  <div className="cargando-caja" role="status" aria-live="polite" aria-busy="true">
    {Array.from({ length: filas }, (_, i) => <Esqueleto key={i} alto={i === 0 ? 64 : 92 - i * 12} />)}
    <small className="centro">{texto}</small>
  </div>
);
export const ErrorCaja = ({ error, onReintentar }) => error ? (
  <div className="aviso-caja mal alerta" role="alert"><Icono n="alerta" tam={20} /><div>{error}</div>{onReintentar && <button className="btn chico" onClick={onReintentar}>Reintentar</button>}</div>
) : null;
/** Estado vacío con icono; si el texto es «Cargando…» muestra el esqueleto. */
export function Vacio({ children, icono = 'bandeja', titulo, accion }) {
  if (typeof children === 'string' && /^Cargando/i.test(children)) return <Cargando texto={children} filas={2} />;
  return (
    <div className="vacio-estado">
      <span className="vacio-ico"><Icono n={icono} tam={26} /></span>
      {titulo && <b>{titulo}</b>}
      {children && <p>{children}</p>}
      {accion}
    </div>
  );
}
/** Aviso en línea con icono (tipo: aviso | mal | ok | info). */
export const Alerta = ({ tipo = 'aviso', titulo, children, accion }) => (
  <div className={`aviso-caja ${tipo === 'aviso' ? '' : tipo} alerta`} role={tipo === 'mal' ? 'alert' : 'status'}>
    <Icono n={tipo === 'ok' ? 'check' : tipo === 'info' ? 'info' : 'alerta'} tam={20} />
    <div>{titulo && <b>{titulo}</b>}{children}</div>{accion}
  </div>
);
/** Encabezado de página: título, descripción corta y acciones primarias a la derecha. */
export const EncabezadoPagina = ({ titulo, descripcion, acciones }) => (
  <div className="encabezado-pagina">
    <div><h1>{titulo}</h1>{descripcion && <small className="desc">{descripcion}</small>}</div>
    {acciones && <div className="acciones">{acciones}</div>}
  </div>
);
/** Buscador con lupa y botón para limpiar. */
export function Buscador({ valor, onCambio, placeholder = 'Buscar…', etiqueta = 'Buscar', ancho = 280 }) {
  return (
    <div style={{ position: 'relative', width: '100%', maxWidth: ancho }}>
      <span aria-hidden="true" style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--tenue)', display: 'grid' }}><Icono n="lupa" tam={18} /></span>
      <input type="search" inputMode="search" value={valor} onChange={(e) => onCambio(e.target.value)} placeholder={placeholder} aria-label={etiqueta} style={{ paddingLeft: 38, paddingRight: valor ? 40 : 12 }} />
      {valor && <button type="button" className="btn fantasma chico" onClick={() => onCambio('')} aria-label="Limpiar búsqueda" style={{ position: 'absolute', right: 2, top: '50%', transform: 'translateY(-50%)', width: 36, minHeight: 36, padding: 0 }}><Icono n="x" tam={16} /></button>}
    </div>
  );
}

export function Estado({ d, children }) {
  if (d.cargando && !d.datos) return <Cargando />;
  if (d.error && !d.datos) return <ErrorCaja error={d.error} onReintentar={d.recargar} />;
  return children(d.datos);
}

// ── Formularios ────────────────────────────────────────────────────────────
export const Campo = ({ etiqueta, children, ayuda, error, requerido }) => (
  <label>
    <span>{etiqueta}{requerido && <span className="obligatorio" aria-hidden="true"> *</span>}</span>
    {children}
    {error ? <small role="alert" style={{ color: 'var(--peligro-texto)', fontWeight: 600 }}>{error}</small> : ayuda && <small>{ayuda}</small>}
  </label>
);

/** Pestañas accesibles: flechas ← → mueven entre ellas. estilo="pildora" para filtros tipo botón. */
export function Tabs({ tabs, valor, onCambio, estilo = '' }) {
  const mover = (e, i) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const sig = tabs[(i + d + tabs.length) % tabs.length];
    onCambio(sig[0]);
    requestAnimationFrame(() => e.currentTarget.parentElement?.querySelector(`[data-tab="${CSS.escape(String(sig[0]))}"]`)?.focus());
  };
  return (
    <div className={`tabs ${estilo === 'pildora' ? 'tabs-pildora' : ''}`} role="tablist">
      {tabs.map(([id, nombre], i) => (
        <button key={id} role="tab" data-tab={id} aria-selected={valor === id} tabIndex={valor === id ? 0 : -1} className={valor === id ? 'activa' : ''} onClick={() => onCambio(id)} onKeyDown={(e) => mover(e, i)}>{nombre}</button>
      ))}
    </div>
  );
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
    <div className="columnas" role="img" aria-label={datos.map((d) => `${etiqueta(d)}: ${formato(valor(d))}`).join('; ')}>
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

/** KPI legible de un vistazo. tono: ok | mal | aviso pinta el valor con significado (verde/rojo/ámbar). */
export const Kpi = ({ etiqueta, valor, sub, acento, tono, icono }) => (
  <div className={`kpi ${acento ? 'acento' : ''} ${tono ?? ''}`}><div className="etq">{icono && <Icono n={icono} tam={14} />}{etiqueta}</div><div className="val">{valor}</div>{sub && <div className="sub">{sub}</div>}</div>
);

export function descargarCsv(nombre, filas, columnas) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [columnas.map((c) => esc(c[1])).join(','), ...filas.map((f) => columnas.map((c) => esc(f[c[0]])).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: nombre });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
