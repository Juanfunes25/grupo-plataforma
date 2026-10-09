import { useMemo, useState } from 'react';
import { get, post, put } from '../api.js';
import { Campo, Estado, Kpi, Modal, useAccion, useDatos } from '../ui/kit.jsx';
import { del, lps, nf } from './util.js';

function Detalle({ saborId, onVolver }) {
  const d = useDatos(() => get(`/prod/costeo/recetas/${saborId}`), [saborId]);
  const insumos = useDatos(() => get('/prod/costeo/insumos'), []);
  const [items, setItems] = useState(null);
  const [pv, setPv] = useState(null);
  const [nuevo, setNuevo] = useState({ insumo_id: '', gramos: '' });
  const [ejecutar, ocupado] = useAccion();
  return (
    <Estado d={d}>{(r) => {
      const lista = items ?? r.items.map((i) => ({ insumo_id: i.insumo_id, insumo_nombre: i.insumo_nombre, gramos: i.gramos, precio_vigente: i.precio_vigente, costo: i.costo }));
      const precioVenta = pv ?? r.precio_venta_kg ?? '';
      const peso = lista.reduce((a, i) => a + (Number(i.gramos) || 0), 0);
      const guardar = async () => {
        const limpios = lista.filter((i) => i.insumo_id && Number(i.gramos) > 0).map((i) => ({ insumo_id: i.insumo_id, gramos: Number(i.gramos) }));
        if (!limpios.length) { window.alert('Agrega al menos un ingrediente'); return; }
        if (await ejecutar(() => put(`/prod/costeo/recetas/${saborId}`, { items: limpios, precio_venta_kg: precioVenta === '' ? null : Number(precioVenta) }), 'Receta guardada')) onVolver();
      };
      const borrar = async () => { if (window.confirm(`¿Borrar la receta de ${r.sabor_nombre}? La producción ya costeada no se pierde, pero la nueva quedará sin costo hasta que cargues otra.`) && await ejecutar(() => del(`/prod/costeo/recetas/${saborId}`), 'Receta borrada')) onVolver(); };
      const set = (i, g) => setItems(lista.map((x, k) => (k === i ? { ...x, gramos: g } : x)));
      const agregar = () => {
        if (!nuevo.insumo_id || !(Number(nuevo.gramos) > 0)) return;
        const ins = (insumos.datos ?? []).find((x) => x.id === nuevo.insumo_id);
        setItems([...lista, { insumo_id: nuevo.insumo_id, insumo_nombre: ins?.nombre, gramos: Number(nuevo.gramos), precio_vigente: ins?.precio_actual ?? null, costo: null }]);
        setNuevo({ insumo_id: '', gramos: '' });
      };
      return (
        <>
          <button className="btn chico fantasma" onClick={onVolver}>← Recetas</button>
          <h2 style={{ margin: 0 }}>{r.sabor_nombre}</h2>
          <div className="tarjeta">
            {lista.length === 0 && <div className="vacio">Sin ingredientes todavía.</div>}
            {lista.map((it, i) => (
              <div className="pg-fila" key={i}>
                <div className="info"><b>{it.insumo_nombre}</b><span className="pg-sub">{it.precio_vigente === null ? 'sin precio vigente' : `${lps(it.precio_vigente)}/kg`}{it.costo != null && items === null ? ` · ${lps(it.costo)} en el lote` : ''}</span></div>
                <input type="number" inputMode="decimal" min="0" style={{ width: 110 }} value={it.gramos} onChange={(e) => set(i, e.target.value)} /><span className="tenue">g</span>
                <button className="btn chico peligro" onClick={() => setItems(lista.filter((_, k) => k !== i))}>Quitar</button>
              </div>))}
            <div className="pg-ctl" style={{ marginTop: 10 }}>
              <select value={nuevo.insumo_id} onChange={(e) => setNuevo({ ...nuevo, insumo_id: e.target.value })} style={{ flex: '3 1 200px' }}><option value="">Elige un insumo…</option>{(insumos.datos ?? []).map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}</select>
              <input type="number" inputMode="decimal" min="0" placeholder="gramos" value={nuevo.gramos} onChange={(e) => setNuevo({ ...nuevo, gramos: e.target.value })} />
              <button className="btn" onClick={agregar}>+ Agregar</button>
            </div>
          </div>
          <div className="rejilla" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))' }}>
            <Kpi etiqueta="Peso del lote" valor={`${nf(peso)} g`} />
            <Kpi acento etiqueta="Costo por kg" valor={items !== null ? 'Guarda para recalcular' : r.costo_kg_hoy === null ? 'Incompleto' : lps(r.costo_kg_hoy)} sub={r.costo_kg_hoy === null && items === null ? 'falta el precio de algún insumo' : r.costo_lote != null && items === null ? `lote completo: ${lps(r.costo_lote)}` : undefined} />
            {items === null && r.margen && <Kpi etiqueta="Margen" valor={`${r.margen.pct.toFixed(1)}%`} sub={`${lps(r.margen.por_kg)} por kg`} />}
          </div>
          <div className="tarjeta"><label>Precio de venta por kg (opcional, para calcular el margen)<input type="number" inputMode="decimal" min="0" step="0.01" value={precioVenta} onChange={(e) => setPv(e.target.value)} /></label></div>
          <div className="pg-ctl"><button className="btn primario grande" disabled={ocupado} onClick={guardar}>Guardar receta</button>{r.receta_id && <button className="btn peligro" disabled={ocupado} onClick={borrar}>Borrar</button>}</div>
        </>
      );
    }}</Estado>
  );
}

export default function CostRecetas() {
  const lista = useDatos(() => get('/prod/costeo/recetas'), []);
  const sin = useDatos(() => get('/prod/costeo/recetas-sin-sabor'), []);
  const sabores = useDatos(() => get('/prod/sabores'), []);
  const [busca, setBusca] = useState('');
  const [sel, setSel] = useState(null);
  const [ejecutar] = useAccion();
  const [nueva, setNueva] = useState(null);   // { nombre, gramos } mientras se crea una receta de un sabor nuevo
  const [creando, setCreando] = useState(false);
  const crearNueva = async (forzar = false) => {
    const nombre = nueva.nombre.trim();
    if (!nombre || creando) return;
    setCreando(true);
    try {
      const r = await post('/rep/sabores', { nombre, ...(Number(nueva.gramos) > 0 ? { gramos_pana: Number(nueva.gramos) } : {}), ...(forzar ? { forzar: true } : {}) });
      if (r?.sabor_id) { setNueva(null); lista.recargar(); sabores.recargar(); setSel(r.sabor_id); }
    } catch (e) {
      if (e?.status === 409 && !forzar) { setCreando(false); if (window.confirm(`${e.message}\n\n¿Crear "${nombre}" de todos modos?`)) await crearNueva(true); return; }
      window.alert(e.message);
    }
    setCreando(false);
  };
  const filtradas = useMemo(() => { const q = busca.trim().toUpperCase(); return (lista.datos ?? []).filter((r) => !q || r.sabor_nombre.includes(q)); }, [lista.datos, busca]);
  if (sel) return <Detalle saborId={sel} onVolver={() => { setSel(null); lista.recargar(); sin.recargar(); }} />;
  const recargar = () => { lista.recargar(); sin.recargar(); };
  const libres = (sabores.datos ?? []).filter((s) => (lista.datos ?? []).some((r) => r.sabor_id === s.id && !r.tiene_receta));
  return (
    <>
      {(sin.datos ?? []).length > 0 && (
        <div className="aviso-caja"><b>{sin.datos.length} receta{sin.datos.length === 1 ? '' : 's'} sin sabor del catálogo</b> (el nombre no calza con ningún sabor). Elige a qué sabor corresponde, o crea el sabor desde Producción y vuelve a enlazar.
          {sin.datos.map((r) => (
            <div className="pg-fila" key={r.receta_id}><div className="info"><b>{r.nombre}</b><span className="pg-sub">{r.cantidad_ingredientes} ingredientes{r.costo_kg_hoy !== null ? ` · ${lps(r.costo_kg_hoy)}/kg` : ''}</span></div>
              <select defaultValue="" onChange={async (e) => { if (e.target.value && await ejecutar(() => post(`/prod/costeo/recetas/${r.receta_id}/enganchar`, { sabor_id: e.target.value }), 'Receta enlazada')) recargar(); }}><option value="">Enlazar con…</option>{libres.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select></div>))}
          <button className="btn chico" style={{ marginTop: 8 }} onClick={async () => { const r = await ejecutar(() => post('/prod/costeo/enganchar'), null); if (r) { window.alert(`${r.enganchadas} receta(s) enlazada(s).${r.sin_sabor.length ? `\nSin sabor: ${r.sin_sabor.join(', ')}` : ''}`); recargar(); } }}>Volver a enlazar por nombre</button></div>)}
      <div className="tarjeta pg-ctl"><input type="search" placeholder="Buscar sabor…" value={busca} onChange={(e) => setBusca(e.target.value)} /><button className="btn primario" onClick={() => setNueva({ nombre: '', gramos: '' })}>+ Nueva receta de gelato</button></div>
      {nueva && (
        <Modal titulo="Nueva receta de gelato" onCerrar={() => setNueva(null)} tam="angosto"
          pie={<><button className="btn" onClick={() => setNueva(null)}>Cancelar</button><button className="btn primario" disabled={creando || !nueva.nombre.trim()} onClick={() => crearNueva()}>Crear y poner ingredientes</button></>}>
          <Campo etiqueta="Nombre del sabor"><input autoFocus value={nueva.nombre} onChange={(e) => setNueva({ ...nueva, nombre: e.target.value })} placeholder="Ej. PISTACHO" /></Campo>
          <Campo etiqueta="Gramos por pana (opcional)" ayuda="Si lo dejas vacío se usan 3,000 g."><input type="number" inputMode="numeric" min="1" value={nueva.gramos} onChange={(e) => setNueva({ ...nueva, gramos: e.target.value })} /></Campo>
          <small>Se crea el sabor y enseguida eliges los ingredientes con sus gramos. El costo por kg se calcula solo con los precios vigentes.</small>
        </Modal>
      )}
      <Estado d={lista}>{() => (
        <div className="tarjeta">{filtradas.map((r) => (
          <div className="pg-fila" key={r.sabor_id}><div className="info"><b>{r.sabor_nombre}</b><span className="pg-sub">{r.tiene_receta ? `${r.cantidad_ingredientes} ingrediente${r.cantidad_ingredientes === 1 ? '' : 's'}${r.margen_pct !== null ? ` · margen ${r.margen_pct.toFixed(0)}%` : ''}` : 'sin receta'}</span></div>
            {r.tiene_receta ? <span className="chip">{r.costo_kg_hoy === null ? 'incompleto' : `${lps(r.costo_kg_hoy)}/kg`}</span> : <span className="chip mal">crear</span>}
            <button className="btn chico" onClick={() => setSel(r.sabor_id)}>{r.tiene_receta ? 'Abrir' : 'Crear'}</button></div>))}</div>
      )}</Estado>
    </>
  );
}
