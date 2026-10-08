import { useMemo, useState } from 'react';
import { get, patch, post } from '../api.js';
import { Campo, Estado, Modal, useAccion, useDatos } from '../ui/kit.jsx';
import { del, hoyIso, lps, nf } from './util.js';

const vacio = { nombre: '', tipo: 'local', categoria: '', precio_inicial: '' };

/** Precio nuevo de un insumo: en Lempiras, o en dólares con su tipo de cambio. Muestra el efecto en las recetas antes de guardar. */
function PrecioModal({ insumo, onCerrar, onListo }) {
  const [modo, setModo] = useState(insumo.usd_kg ? 'usd' : 'lps');
  const [lpsV, setLpsV] = useState(insumo.precio_actual ?? '');
  const [usd, setUsd] = useState(insumo.usd_kg ?? '');
  const [tc, setTc] = useState(insumo.tipo_cambio_usado ?? '');
  const [fecha, setFecha] = useState(hoyIso());
  const [ref, setRef] = useState('');
  const [ejecutar, ocupado] = useAccion();
  const hist = useDatos(() => get(`/prod/costeo/insumos/${insumo.id}/precios`), [insumo.id]);
  const nuevo = modo === 'usd' ? Math.round(Number(usd) * Number(tc) * 10000) / 10000 : Number(lpsV);
  const valido = Number.isFinite(nuevo) && nuevo >= 0 && (modo === 'lps' ? lpsV !== '' : usd !== '' && tc !== '');
  const impacto = useDatos(() => (valido ? get(`/prod/costeo/insumos/${insumo.id}/impacto?lps_kg=${nuevo}&fecha=${fecha}`) : Promise.resolve([])), [nuevo, fecha, valido]);
  const guardar = async () => {
    const cuerpo = modo === 'usd' ? { usd_kg: Number(usd), tipo_cambio_usado: Number(tc), fecha_vigencia: fecha, factura_ref: ref } : { lps_kg: Number(lpsV), fecha_vigencia: fecha, factura_ref: ref };
    if (await ejecutar(() => post(`/prod/costeo/insumos/${insumo.id}/precios`, cuerpo), 'Precio actualizado')) onListo();
  };
  return (
    <Modal titulo={insumo.nombre} onCerrar={onCerrar} pie={<button className="btn primario" disabled={!valido || ocupado} onClick={guardar}>Guardar precio</button>}>
      <div className="pg-chips" style={{ marginBottom: 10 }}>
        <button className={`btn chico ${modo === 'lps' ? 'primario' : ''}`} onClick={() => setModo('lps')}>En Lempiras</button>
        <button className={`btn chico ${modo === 'usd' ? 'primario' : ''}`} onClick={() => setModo('usd')}>En dólares</button>
      </div>
      {modo === 'lps' ? <Campo etiqueta="Precio (Lps por kg)"><input type="number" inputMode="decimal" min="0" step="0.01" value={lpsV} onChange={(e) => setLpsV(e.target.value)} autoFocus /></Campo> : (
        <div className="pg-ctl"><Campo etiqueta="US$ por kg"><input type="number" inputMode="decimal" min="0" step="0.0001" value={usd} onChange={(e) => setUsd(e.target.value)} /></Campo><Campo etiqueta="Tipo de cambio (L por US$)"><input type="number" inputMode="decimal" min="0" step="0.0001" value={tc} onChange={(e) => setTc(e.target.value)} /></Campo></div>)}
      {modo === 'usd' && valido && <small className="pg-sub">= {lps(nuevo)} por kg</small>}
      <div className="pg-ctl" style={{ marginTop: 8 }}><Campo etiqueta="Vigente desde"><input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} /></Campo><Campo etiqueta="Referencia (factura, lista…)"><input value={ref} onChange={(e) => setRef(e.target.value)} /></Campo></div>
      {valido && (impacto.datos ?? []).length > 0 && (
        <div style={{ marginTop: 12 }}><b>Efecto en las recetas (costo por kg)</b>
          {impacto.datos.slice(0, 8).map((r) => <div className="pg-fila" key={r.receta_id}><span>{r.nombre}</span><span className="pg-num">{lps(r.antes)} → <b>{lps(r.despues)}</b>{r.variacion_pct !== null && <span className="pg-sub">{r.variacion_pct > 0 ? '+' : ''}{r.variacion_pct.toFixed(1)}%</span>}</span></div>)}</div>)}
      <div style={{ marginTop: 12 }}><b>Historial de precios</b>
        <Estado d={hist}>{({ precios }) => precios.length === 0 ? <div className="vacio">Sin precios.</div> : precios.map((p) => (
          <div className="pg-fila" key={p.id}><div className="info"><b>{lps(p.lps_kg)}</b><span className="pg-sub">desde {p.fecha_vigencia}{p.usd_kg ? ` · US$ ${nf(p.usd_kg, 4)}${p.tipo_cambio_usado ? ` × ${nf(p.tipo_cambio_usado, 4)}` : ''}` : ''}{p.factura_ref ? ` · ${p.factura_ref}` : ''}</span></div>
            {p.variacion_pct !== null && <span className={`chip ${p.variacion_pct > 0 ? 'mal' : 'ok'}`}>{p.variacion_pct > 0 ? '+' : ''}{p.variacion_pct.toFixed(1)}%</span>}</div>))}</Estado></div>
    </Modal>
  );
}

export default function CostInsumos() {
  const d = useDatos(() => get('/prod/costeo/insumos'), []);
  const [busca, setBusca] = useState('');
  const [cat, setCat] = useState('');
  const [nuevo, setNuevo] = useState(null);
  const [editando, setEditando] = useState(null);
  const [precio, setPrecio] = useState(null);
  const [ejecutar, ocupado] = useAccion();
  const lista = d.datos ?? [];
  const cats = useMemo(() => [...new Set(lista.map((i) => i.categoria).filter(Boolean))].sort(), [lista]);
  const filtrados = useMemo(() => { const q = busca.trim().toUpperCase(); return lista.filter((i) => (!q || i.nombre.includes(q)) && (!cat || i.categoria === cat)); }, [lista, busca, cat]);
  const crear = async () => { if (await ejecutar(() => post('/prod/costeo/insumos', { ...nuevo, precio_inicial: nuevo.precio_inicial === '' ? undefined : Number(nuevo.precio_inicial) }), 'Insumo agregado')) { setNuevo(null); d.recargar(); } };
  const guardarEd = async () => { if (await ejecutar(() => patch(`/prod/costeo/insumos/${editando.id}`, { nombre: editando.nombre, tipo: editando.tipo, part_number: editando.part_number, unidad: editando.unidad }), 'Insumo actualizado')) { setEditando(null); d.recargar(); } };
  const desactivar = async (i) => { if (window.confirm(`¿Desactivar «${i.nombre}»? Deja de aparecer en la lista y en el selector de recetas, pero las recetas que ya lo usan lo siguen costeando igual.`) && await ejecutar(() => del(`/prod/costeo/insumos/${i.id}`), 'Insumo desactivado')) d.recargar(); };
  return (
    <>
      <div className="tarjeta pg-ctl">
        <input type="search" placeholder="Buscar insumo…" value={busca} onChange={(e) => setBusca(e.target.value)} />
        {cats.length > 0 && <select value={cat} onChange={(e) => setCat(e.target.value)}><option value="">Todas las categorías</option>{cats.map((c) => <option key={c}>{c}</option>)}</select>}
        <button className="btn primario" onClick={() => setNuevo(vacio)}>+ Agregar insumo</button>
      </div>
      <Estado d={d}>{() => (
        <div className="tarjeta">
          {filtrados.length === 0 && <div className="vacio">Sin resultados</div>}
          {filtrados.map((i) => (
            <div className="pg-fila" key={i.id}>
              <div className="info"><b>{i.nombre}</b>
                <span className="pg-sub"><span className={`chip ${i.tipo === 'mec3' ? '' : 'ok'}`}>{i.tipo}</span>{i.categoria ? ` ${i.categoria}` : ''}{i.precio_fecha ? ` · vigente desde ${i.precio_fecha}` : ''}{i.usd_kg ? ` · US$ ${nf(i.usd_kg, 4)}` : ''}{i.tipo_cambio_usado ? ` × ${nf(i.tipo_cambio_usado, 2)}` : ''}</span></div>
              <button className="btn chico" onClick={() => setPrecio(i)} title="Cambiar el precio">{i.precio_actual !== null ? lps(i.precio_actual) : 'sin precio'}</button>
              <button className="btn chico fantasma" onClick={() => setEditando({ ...i })}>Editar</button>
              <button className="btn chico peligro" onClick={() => desactivar(i)}>Desactivar</button>
            </div>))}
        </div>)}</Estado>
      {nuevo && (
        <Modal titulo="Insumo nuevo" onCerrar={() => setNuevo(null)} pie={<button className="btn primario" disabled={!nuevo.nombre.trim() || ocupado} onClick={crear}>Guardar</button>}>
          <Campo etiqueta="Nombre"><input value={nuevo.nombre} onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })} placeholder="Ej.: LECHE DESCREMADA" autoFocus /></Campo>
          <Campo etiqueta="Tipo"><select value={nuevo.tipo} onChange={(e) => setNuevo({ ...nuevo, tipo: e.target.value })}><option value="local">Local</option><option value="mec3">MEC3 (importado)</option></select></Campo>
          <Campo etiqueta="Categoría (opcional)"><input value={nuevo.categoria} onChange={(e) => setNuevo({ ...nuevo, categoria: e.target.value })} /></Campo>
          <Campo etiqueta="Precio inicial (Lps por kg, opcional)"><input type="number" inputMode="decimal" min="0" step="0.01" value={nuevo.precio_inicial} onChange={(e) => setNuevo({ ...nuevo, precio_inicial: e.target.value })} /></Campo>
        </Modal>)}
      {editando && (
        <Modal titulo="Editar insumo" onCerrar={() => setEditando(null)} pie={<button className="btn primario" disabled={!editando.nombre.trim() || ocupado} onClick={guardarEd}>Guardar</button>}>
          <Campo etiqueta="Nombre"><input value={editando.nombre} onChange={(e) => setEditando({ ...editando, nombre: e.target.value })} /></Campo>
          <Campo etiqueta="Tipo"><select value={editando.tipo} onChange={(e) => setEditando({ ...editando, tipo: e.target.value })}><option value="local">Local</option><option value="mec3">MEC3 (importado)</option></select></Campo>
          <Campo etiqueta="Código de producto (part number)"><input value={editando.part_number ?? ''} onChange={(e) => setEditando({ ...editando, part_number: e.target.value })} /></Campo>
          <Campo etiqueta="Unidad"><input value={editando.unidad} onChange={(e) => setEditando({ ...editando, unidad: e.target.value })} /></Campo>
          <small className="pg-sub">El precio no se edita aquí: se agrega uno nuevo y queda el historial.</small>
        </Modal>)}
      {precio && <PrecioModal insumo={precio} onCerrar={() => setPrecio(null)} onListo={() => { setPrecio(null); d.recargar(); }} />}
    </>
  );
}
