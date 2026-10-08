import { useMemo, useState } from 'react';
import { numero } from '@grupo/shared';

const sinTildes = (t) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Busca por palabras en cualquier orden y sin tildes: «epox ivory» encuentra «Epóxico Quarzo … Ivory».
function coincide(p, texto) {
  const palabras = sinTildes(texto).split(/\s+/).filter(Boolean);
  const pajar = sinTildes(`${p.nombre} ${p.codigo ?? ''} ${p.presentacion ?? ''} ${p.categoria ?? ''}`);
  return palabras.every((w) => pajar.includes(w));
}

// Fila compacta: nombre, existencia y casilla de cantidad (0 o vacío la quita).
function Fila({ p, n, onCambiar, quitar = false }) {
  const falta = n !== '' && n > p.existencia;
  return (
    <div className={`dis-fila-prod ${n !== '' ? 'sel' : ''}`}>
      <div className="nom">
        <span style={{ fontWeight: n !== '' ? 700 : 500 }}>{p.nombre}</span>
        <small style={{ display: 'block', color: falta || p.existencia <= 0 ? 'var(--peligro)' : undefined }}>Hay {numero(p.existencia, 0)}{falta ? ' · no alcanza' : ''}</small>
      </div>
      <input className="dis-cant" type="number" inputMode="numeric" min="0" step="1" placeholder="0" value={n} onChange={(e) => onCambiar(e.target.value)} aria-label={`Cantidad de ${p.nombre}`} />
      {quitar && <button className="btn chico" aria-label="Quitar" onClick={() => onCambiar(0)}>✕</button>}
    </div>
  );
}

// Elegir productos de la bodega: buscador, categorías y una lista compacta con una casilla de cantidad.
export default function SelectorProductos({ productos, items, onCambiar }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const categorias = useMemo(() => [...new Set(productos.map((p) => p.categoria).filter(Boolean))], [productos]);
  const resultados = useMemo(() => productos.filter((p) => (!cat || p.categoria === cat) && (!q.trim() || coincide(p, q))), [productos, q, cat]);
  const buscando = Boolean(q.trim() || cat);
  const cantidadDe = (id) => items.find((i) => i.producto_id === id)?.cantidad ?? '';
  const poner = (id, texto) => {
    const c = Math.max(0, Math.round(Number(texto)) || 0);
    if (c === 0) return onCambiar(items.filter((i) => i.producto_id !== id));
    onCambiar(items.some((i) => i.producto_id === id) ? items.map((i) => (i.producto_id === id ? { ...i, cantidad: c } : i)) : [...items, { producto_id: id, cantidad: c }]);
  };
  return (
    <div>
      <input type="search" placeholder="Buscar producto (escribe parte del nombre)…" value={q} onChange={(e) => setQ(e.target.value)} style={{ fontSize: '1.05rem', padding: 12 }} />
      {categorias.length > 1 && (
        <div style={{ margin: '8px 0 4px' }}>
          <small>Categorías:</small>
          <div className="fila" style={{ gap: 6, marginTop: 4 }}>
            <button className={`btn chico ${cat ? '' : 'primario'}`} onClick={() => setCat('')}>Todas</button>
            {categorias.map((c) => <button key={c} className={`btn chico ${cat === c ? 'primario' : ''}`} onClick={() => setCat(cat === c ? '' : c)}>{c}</button>)}
          </div>
        </div>
      )}
      {buscando ? (
        <div style={{ maxHeight: 300, overflowY: 'auto', borderTop: '1px solid var(--borde)', marginTop: 8 }}>
          {resultados.map((p) => <Fila key={p.id} p={p} n={cantidadDe(p.id)} onCambiar={(t) => poner(p.id, t)} />)}
          {resultados.length === 0 && <p className="vacio">No encontré ese producto. Prueba con otra palabra.</p>}
        </div>
      ) : <p className="tenue">{productos.length === 0 ? 'No hay productos con control de inventario.' : 'Escribe el nombre o elige una categoría para encontrar el producto.'}</p>}
      <div style={{ marginTop: 12 }}>
        <small>Material seleccionado ({items.reduce((s, i) => s + i.cantidad, 0)})</small>
        <div style={{ borderTop: '2px solid var(--acento)' }}>
          {items.map((i) => { const p = productos.find((x) => x.id === i.producto_id); return p ? <Fila key={i.producto_id} p={p} n={i.cantidad} onCambiar={(t) => poner(p.id, t)} quitar /> : null; })}
          {items.length === 0 && <p className="vacio" style={{ padding: 10 }}>Todavía no has agregado productos.</p>}
        </div>
      </div>
    </div>
  );
}
