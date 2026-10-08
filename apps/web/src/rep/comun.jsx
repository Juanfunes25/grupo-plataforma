// Piezas compartidas por las pantallas de Reposición.
import { useCallback, useEffect, useRef, useState } from 'react';
import { get, patch } from '../api.js';
import { useAviso, useDatos } from '../ui/kit.jsx';
import { ETIQUETA_ESTADO, TONO_ESTADO, guardarCache, leerCache, vibrar } from './lib.js';
import './rep.css';

export const Pill = ({ estado }) => <span className={`chip ${TONO_ESTADO[estado] ?? ''}`}>{ETIQUETA_ESTADO[estado] ?? estado}</span>;

/** Sucursales de reposición que ve el usuario + la elegida (se recuerda por dispositivo). */
export function useSucursalesRep() {
  const [lista, setLista] = useState(() => leerCache('sucursales')?.datos ?? []);
  const [cargando, setCargando] = useState(!lista.length);
  const [id, setIdEstado] = useState(() => { try { return localStorage.getItem('rep.sucursal') || ''; } catch { return ''; } });
  useEffect(() => {
    let vivo = true;
    get('/rep/sucursales').then((d) => { if (vivo) { setLista(d); guardarCache('sucursales', d); } }).catch(() => {}).finally(() => vivo && setCargando(false));
    return () => { vivo = false; };
  }, []);
  const actual = lista.find((s) => s.id === id) ?? (lista.length === 1 ? lista[0] : lista.find((s) => s.tipo === 'tienda') ?? lista[0] ?? null);
  const setId = (v) => { setIdEstado(v); try { localStorage.setItem('rep.sucursal', v); } catch { /* */ } };
  return { lista, cargando, sucursal: actual, setId };
}

export function SelectorSucursal({ lista, valor, onCambio }) {
  if (lista.length <= 1) return null;
  return (
    <div className="rep-tiendas">
      {lista.map((s) => <button key={s.id} className={`rep-ficha ${valor === s.id ? 'on' : ''}`} onClick={() => onCambio(s.id)}>{s.nombre}</button>)}
    </div>
  );
}

/** Botones ×1 ×2 ×3 ×4 para contar panas; el número que pidió el sistema va resaltado pero se puede elegir otro. */
export function BotonesPanas({ onSeleccionar, sugerido, desde = 1, hasta = 4, prefijo = '×' }) {
  const ops = []; for (let n = desde; n <= hasta; n++) ops.push(n);
  return (
    <div className="rep-panas">
      {ops.map((n) => (
        <button key={n} className={`rep-pana ${n === sugerido ? 'sugerido' : ''}`} onClick={() => { vibrar(); onSeleccionar(n); }} title={n === sugerido ? 'Lo que pidió el sistema' : `${n} pana${n === 1 ? '' : 's'}`}>
          {prefijo}{n}
        </button>
      ))}
    </div>
  );
}

/** «Enviar los N de una», pudiendo sacar del lote el sabor excepcional tocando su chip. */
export function LotePanasConExcepciones({ pendientes, onEnviar }) {
  const [fuera, setFuera] = useState(() => new Set());
  if (pendientes.length <= 1) return null;
  const alternar = (id) => setFuera((a) => { const n = new Set(a); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const elegidos = pendientes.filter((p) => !fuera.has(p.id));
  return (
    <div className="rep-lote">
      <div className="fila espacio">
        <small>Enviar {elegidos.length === pendientes.length ? `los ${pendientes.length}` : `${elegidos.length} de ${pendientes.length}`} de una:</small>
        {fuera.size > 0 && <button className="btn chico fantasma" onClick={() => setFuera(new Set())}>Deshacer exclusiones</button>}
      </div>
      {pendientes.length > 2 && (
        <div className="rep-chips">
          {pendientes.map((p) => (
            <button key={p.id} className={`rep-chip ${fuera.has(p.id) ? 'fuera' : 'dentro'}`} onClick={() => alternar(p.id)} title={fuera.has(p.id) ? 'Toca para incluirlo de nuevo' : 'Toca para sacarlo del lote'}>
              {fuera.has(p.id) ? '✕' : '✓'} {p.etiqueta}
            </button>
          ))}
        </div>
      )}
      <BotonesPanas onSeleccionar={(n) => onEnviar(elegidos.map((p) => p.id), n)} />
    </div>
  );
}

/** Aviso inferior con «Deshacer» (el original lo usaba en cada acción del despachador). */
export function useAvisoDeshacer() {
  const [aviso, setAviso] = useState(null);
  const t = useRef(null);
  const cerrar = useCallback(() => { clearTimeout(t.current); setAviso(null); }, []);
  const mostrar = useCallback((texto, { onDeshacer, tipo = 'ok' } = {}) => {
    clearTimeout(t.current);
    setAviso({ texto, onDeshacer, tipo });
    t.current = setTimeout(() => setAviso(null), onDeshacer ? 7000 : 3500);
  }, []);
  const vista = aviso && (
    <div className={`rep-deshacer ${aviso.tipo}`} role="status">
      <span>{aviso.texto}</span>
      {aviso.onDeshacer && <button className="btn chico" onClick={() => { const f = aviso.onDeshacer; cerrar(); f(); }}>Deshacer</button>}
      <button className="btn chico fantasma" onClick={cerrar} aria-label="Cerrar">✕</button>
    </div>
  );
  return { mostrar, cerrar, vista };
}

/** Faja con el estado de la conexión y lo guardado sin señal. */
export function FajaConexion({ pendientes }) {
  const [enLinea, setEnLinea] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const a = () => setEnLinea(true); const b = () => setEnLinea(false);
    window.addEventListener('online', a); window.addEventListener('offline', b);
    return () => { window.removeEventListener('online', a); window.removeEventListener('offline', b); };
  }, []);
  if (enLinea && !pendientes) return null;
  return (
    <div className="aviso-caja">
      {!enLinea && <b>Sin señal. </b>}
      {pendientes > 0
        ? `${pendientes} cosa${pendientes === 1 ? '' : 's'} guardada${pendientes === 1 ? '' : 's'} en este equipo (pesajes o pedidos): se envían solas cuando vuelva el internet.`
        : 'Puedes seguir pesando: lo que escribas se guarda y se envía cuando vuelva la señal.'}
    </div>
  );
}

/** Qué sabores de TODO el catálogo pesa esta sucursal. La tienda sabe qué vende; la administración lo arma la primera vez. */
export function CatalogoSabores({ sucursalId, onCambio }) {
  const avisar = useAviso();
  const d = useDatos(() => get(`/rep/sucursales/${sucursalId}/catalogo`), [sucursalId]);
  const [q, setQ] = useState('');
  const [inactivos, setInactivos] = useState(false);
  const [lista, setLista] = useState(null);
  useEffect(() => { setLista(d.datos); }, [d.datos]);
  if (!lista) return <div className="vacio">Cargando catálogo…</div>;
  async function alternar(s) {
    const nuevo = s.activo ? 0 : 1;
    setLista((l) => l.map((x) => (x.id === s.id ? { ...x, activo: nuevo } : x)));
    try { await patch(`/rep/sucursales/${sucursalId}/sabores/${s.id}`, { activo: Boolean(nuevo) }); onCambio?.(); }
    catch (e) { setLista((l) => l.map((x) => (x.id === s.id ? { ...x, activo: s.activo } : x))); avisar(e.message || 'No se pudo guardar el cambio', 'mal'); }
  }
  const visibles = lista.filter((s) => (inactivos ? !s.activo : s.activo)).filter((s) => s.nombre.includes(q.trim().toUpperCase()));
  const activos = lista.filter((s) => s.activo).length;
  return (
    <div className="rejilla">
      <small>Todo lo que produce fábrica. Activa lo que de verdad se vende aquí: lo demás queda apagado y no llena el pesaje de todas las noches.</small>
      <div className="fila">
        <input placeholder="Buscar sabor…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
        {lista.length - activos > 0 && <button className={`btn chico ${inactivos ? 'primario' : 'fantasma'}`} onClick={() => setInactivos((v) => !v)}>{inactivos ? '✓ ' : ''}{lista.length - activos} inactivo{lista.length - activos === 1 ? '' : 's'}</button>}
      </div>
      <div className="tarjeta">
        {visibles.length === 0 ? <div className="vacio">Sin resultados</div> : visibles.map((s) => (
          <div className="rep-fila" key={s.id} style={{ opacity: s.activo ? 1 : 0.6 }}>
            <div className="rep-fila-info"><b>{s.nombre}</b><small>pana de {s.gramos_pana} g</small></div>
            <button className={`btn chico ${s.activo ? 'primario' : 'fantasma'}`} onClick={() => alternar(s)}>{s.activo ? 'Activo' : 'Inactivo'}</button>
          </div>
        ))}
      </div>
      <small className="centro">{activos} de {lista.length} sabores activos aquí</small>
    </div>
  );
}

/** Qué insumos del catálogo le aparecen a esta tienda para PEDIR. Sin fila = activo. */
export function CatalogoInsumos({ sucursalId, onCambio }) {
  const avisar = useAviso();
  const d = useDatos(() => get(`/rep/insumos/catalogo/${sucursalId}`), [sucursalId]);
  const [q, setQ] = useState('');
  const [inactivos, setInactivos] = useState(false);
  const [lista, setLista] = useState(null);
  useEffect(() => { setLista(d.datos); }, [d.datos]);
  if (!lista) return <div className="vacio">Cargando catálogo…</div>;
  async function alternar(i) {
    const nuevo = i.activo ? 0 : 1;
    setLista((l) => l.map((x) => (x.id === i.id ? { ...x, activo: nuevo } : x)));
    try { await patch(`/rep/insumos/catalogo/${sucursalId}/${i.id}`, { activo: Boolean(nuevo) }); onCambio?.(); }
    catch (e) { setLista((l) => l.map((x) => (x.id === i.id ? { ...x, activo: i.activo } : x))); avisar(e.message || 'No se pudo guardar el cambio', 'mal'); }
  }
  const visibles = lista.filter((i) => (inactivos ? !i.activo : i.activo)).filter((i) => i.nombre.toUpperCase().includes(q.trim().toUpperCase()));
  const activos = lista.filter((i) => i.activo).length;
  return (
    <div className="rejilla">
      <small>No todas las tiendas manejan los mismos insumos. Apaga los que no pides aquí: solo cambia lo que ves en «Toca para agregar rápido».</small>
      <div className="fila">
        <input placeholder="Buscar insumo…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
        {lista.length - activos > 0 && <button className={`btn chico ${inactivos ? 'primario' : 'fantasma'}`} onClick={() => setInactivos((v) => !v)}>{inactivos ? '✓ ' : ''}{lista.length - activos} inactivo{lista.length - activos === 1 ? '' : 's'}</button>}
      </div>
      <div className="tarjeta">
        {visibles.length === 0 ? <div className="vacio">Sin resultados</div> : visibles.map((i) => (
          <div className="rep-fila" key={i.id} style={{ opacity: i.activo ? 1 : 0.6 }}>
            <div className="rep-fila-info"><b>{i.nombre}</b><small>{i.categoria || 'Sin categoría'}</small></div>
            <button className={`btn chico ${i.activo ? 'primario' : 'fantasma'}`} onClick={() => alternar(i)}>{i.activo ? 'Activo' : 'Inactivo'}</button>
          </div>
        ))}
      </div>
      <small className="centro">{activos} de {lista.length} insumos activos aquí</small>
    </div>
  );
}

export function Barra({ nombre, valor, total, texto, color }) {
  return (
    <div className="rep-barra">
      <span title={nombre}>{nombre}</span>
      <div className="pista"><i style={{ width: `${total > 0 ? Math.min(100, (valor / total) * 100) : 0}%`, ...(color ? { background: color } : {}) }} /></div>
      <b className="num">{texto}</b>
    </div>
  );
}

export function Esqueleto({ alto = 120 }) { return <div className="rep-esqueleto" style={{ height: alto }} />; }
