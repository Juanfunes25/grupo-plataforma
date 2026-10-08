import { Fragment, useMemo, useState } from 'react';
import { lempiras } from '@grupo/shared';
import { get, post, put } from '../api.js';
import { Campo, Estado, Modal, descargarCsv, useAccion, useDatos } from '../ui/kit.jsx';
import { Chip, n } from '../fab/comun.jsx';

const norm = (t) => String(t ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const VACIA = { producto_id: '', nombre: '', merma_esperada_pct: 5, mano_obra_m2: 0, indirectos_m2: 0, notas: '', items: [{ insumo_id: '', cantidad_m2: '' }] };

/** Receta = consumo de insumos por m² terminado. De aquí salen el consumo teórico de cada colada, el costo por m² y el margen. */
export default function Recetas() {
  const d = useDatos(() => get('/fab/recetas'), []);
  const prods = useDatos(() => get('/fab/productos'), []);
  const insumos = useDatos(() => get('/fab/insumos'), []);
  const [q, setQ] = useState('');
  const [modelo, setModelo] = useState('');
  const [abierta, setAbierta] = useState(null);
  const [modal, setModal] = useState(null);
  const lista = d.datos ?? [];
  const modelos = [...new Set(lista.map((r) => r.modelo).filter(Boolean))].sort();
  const visibles = useMemo(() => lista
    .filter((r) => (!modelo || r.modelo === modelo) && (!q || norm(`${r.producto} ${r.items.map((i) => i.nombre).join(' ')}`).includes(norm(q))))
    .sort((a, b) => String(a.producto).localeCompare(String(b.producto))), [lista, q, modelo]);

  const exportar = () => descargarCsv(`recetas-${new Date().toISOString().slice(0, 10)}.csv`,
    visibles.flatMap((r) => r.items.map((i) => ({ producto: r.producto, insumo: i.nombre, unidad: i.unidad, cantidad: i.cantidad_m2, unit: i.costo_promedio.toFixed(4), total: (i.cantidad_m2 * i.costo_promedio).toFixed(4) }))),
    [['producto', 'Producto'], ['insumo', 'Ingrediente'], ['unidad', 'Unidad'], ['cantidad', 'Cantidad por m²'], ['unit', 'Costo unitario'], ['total', 'Total']]);

  const abrir = (r) => setModal(r
    ? { id: r.id, f: { producto_id: r.producto_id, nombre: r.nombre, merma_esperada_pct: r.merma_esperada_pct, mano_obra_m2: r.mano_obra_m2, indirectos_m2: r.indirectos_m2, notas: r.notas ?? '', items: r.items.map((i) => ({ insumo_id: i.insumo_id, cantidad_m2: i.cantidad_m2 })) } }
    : { f: { ...VACIA, items: [{ insumo_id: '', cantidad_m2: '' }] } });

  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Recetas y costos</h1></div>
      <p className="fab-sub" style={{ marginBottom: 12 }}>Cada receta indica cuánto de cada insumo lleva <b>1 m²</b> de producto terminado, la merma normal y la mano de obra. Los costos usan el costo promedio de cada insumo: se actualizan solos con cada compra y con el tipo de cambio.</p>
      <Estado d={d}>{() => (
        <div className="tarjeta pad0">
          <div className="fab-toolbar" style={{ padding: 12, marginBottom: 0 }}>
            <input className="crece" placeholder="Buscar producto o ingrediente…" value={q} onChange={(e) => setQ(e.target.value)} />
            <select value={modelo} onChange={(e) => setModelo(e.target.value)}><option value="">Todos los modelos</option>{modelos.map((m) => <option key={m}>{m}</option>)}</select>
            <button className="btn primario" onClick={() => abrir(null)}>+ Receta</button>
            <button className="btn" onClick={exportar}>Exportar (CSV)</button>
            <span className="fab-sub">{visibles.length} de {lista.length} recetas</span>
          </div>
          <div className="tabla-wrap"><table>
            <thead><tr><th>Producto</th><th className="der">Ingredientes</th><th className="der">Costo por m²</th><th className="der">Precio</th><th className="der">Margen</th><th></th></tr></thead>
            <tbody>
              {visibles.map((r) => {
                const abierto = abierta === r.id;
                return (
                  <Fragment key={r.id}>
                    <tr style={{ ...(r.activa ? {} : { opacity: 0.55 }), cursor: 'pointer' }} onClick={() => setAbierta(abierto ? null : r.id)}>
                      <td><b>{r.producto}</b> {!r.activa && <Chip>anterior</Chip>}<span className="fab-sub">{r.nombre}</span></td>
                      <td className="der num">{r.items.length}</td>
                      <td className="der num"><b>{lempiras(r.costo.total_m2)}</b></td>
                      <td className="der num">{lempiras(r.precio)}</td>
                      <td className="der num">{r.margen_pct_publico != null ? <Chip tono={r.margen_pct_publico < 0 ? 'mal' : r.margen_pct_publico < 25 ? 'aviso' : 'ok'}>{n(r.margen_pct_publico, 1)}%</Chip> : '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}><button className="btn chico" onClick={(e) => { e.stopPropagation(); setAbierta(abierto ? null : r.id); }}>{abierto ? 'Ocultar' : 'Ver receta'}</button> <button className="btn chico" onClick={(e) => { e.stopPropagation(); abrir(r); }}>Editar</button></td>
                    </tr>
                    {abierto && (
                      <tr><td colSpan={6} style={{ background: 'var(--panel-3)' }}>
                        <table>
                          <thead><tr><th>Ingrediente</th><th className="der">Cantidad por m²</th><th className="der">Costo unitario</th><th className="der">Total</th></tr></thead>
                          <tbody>
                            {r.items.map((i) => <tr key={i.insumo_id}><td>{i.nombre.replace('[EJEMPLO] ', '')}</td><td className="der num">{n(i.cantidad_m2, 3)} {i.unidad}</td><td className="der num">{lempiras(i.costo_promedio)}</td><td className="der num">{lempiras(i.cantidad_m2 * i.costo_promedio)}</td></tr>)}
                            {Number(r.merma_esperada_pct) > 0 && <tr><td colSpan={3} className="der fab-sub">Merma esperada {n(r.merma_esperada_pct, 1)}%</td><td className="der num">{lempiras(r.costo.insumos_con_merma - r.costo.insumos)}</td></tr>}
                            {(r.costo.mano_obra > 0 || r.costo.indirectos > 0) && <tr><td colSpan={3} className="der fab-sub">Mano de obra + indirectos</td><td className="der num">{lempiras(r.costo.mano_obra + r.costo.indirectos)}</td></tr>}
                            <tr><td colSpan={3} className="der"><b>Costo por m² (1 caja)</b></td><td className="der num"><b>{lempiras(r.costo.total_m2)}</b></td></tr>
                          </tbody>
                        </table>
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
              {visibles.length === 0 && <tr><td colSpan={6} className="vacio">{lista.length === 0 ? 'Aún no hay recetas.' : 'Sin resultados con estos filtros.'}</td></tr>}
            </tbody>
          </table></div>
        </div>
      )}</Estado>
      {modal && <FormReceta modal={modal} productos={prods.datos ?? []} insumos={(insumos.datos ?? []).filter((i) => i.activo)} onCerrar={() => setModal(null)} onListo={() => { setModal(null); d.recargar(); insumos.recargar(); }} />}
    </div>
  );
}

function FormReceta({ modal, productos, insumos, onCerrar, onListo }) {
  const [f, setF] = useState(modal.f);
  const [ejecutar, ocupado] = useAccion();
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setItem = (i, k, v) => set('items', f.items.map((it, j) => (j === i ? { ...it, [k]: v } : it)));
  // Costo en vivo mientras se edita
  const insumosCosto = f.items.reduce((s, i) => s + Number(i.cantidad_m2 || 0) * Number(insumos.find((m) => m.id === i.insumo_id)?.costo_promedio ?? 0), 0);
  const conMerma = insumosCosto * (1 + Number(f.merma_esperada_pct || 0) / 100);
  const total = conMerma + Number(f.mano_obra_m2 || 0) + Number(f.indirectos_m2 || 0);
  const guardar = async () => {
    const cuerpo = { ...f, items: f.items.filter((i) => i.insumo_id && Number(i.cantidad_m2) > 0) };
    if (await ejecutar(() => (modal.id ? put(`/fab/recetas/${modal.id}`, cuerpo) : post('/fab/recetas', cuerpo)), 'Receta guardada; costo actualizado')) onListo();
  };
  return (
    <Modal titulo={modal.id ? 'Editar receta' : 'Nueva receta'} tam="ancho" onCerrar={onCerrar} pie={<button className="btn primario" disabled={ocupado || !f.producto_id || !f.nombre} onClick={guardar}>Guardar y actualizar costo</button>}>
      <div className="rejilla cols-2">
        <Campo etiqueta="Producto"><select disabled={!!modal.id} value={f.producto_id} onChange={(e) => set('producto_id', e.target.value)}><option value="">Elige…</option>{productos.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</select></Campo>
        <Campo etiqueta="Nombre de la receta"><input value={f.nombre} onChange={(e) => set('nombre', e.target.value)} placeholder="Ej.: Mezcla estándar v1" /></Campo>
        <Campo etiqueta="Merma esperada %"><input type="number" step="0.1" value={f.merma_esperada_pct} onChange={(e) => set('merma_esperada_pct', e.target.value)} /></Campo>
        <Campo etiqueta="Mano de obra L/m²"><input type="number" step="0.01" value={f.mano_obra_m2} onChange={(e) => set('mano_obra_m2', e.target.value)} /></Campo>
        <Campo etiqueta="Indirectos L/m²" ayuda="Energía, agua, depreciación de moldes"><input type="number" step="0.01" value={f.indirectos_m2} onChange={(e) => set('indirectos_m2', e.target.value)} /></Campo>
      </div>
      <h3 style={{ margin: '14px 0 6px' }}>Insumos por m² terminado</h3>
      {f.items.map((it, i) => {
        const mp = insumos.find((m) => m.id === it.insumo_id);
        return (
          <div className="fila" key={i} style={{ flexWrap: 'nowrap' }}>
            <select value={it.insumo_id} onChange={(e) => setItem(i, 'insumo_id', e.target.value)} style={{ flex: 3 }}><option value="">Elige insumo…</option>{insumos.map((m) => <option key={m.id} value={m.id}>{m.nombre} ({m.unidad})</option>)}</select>
            <input type="number" step="0.0001" placeholder="Cantidad" value={it.cantidad_m2} onChange={(e) => setItem(i, 'cantidad_m2', e.target.value)} style={{ flex: 1 }} />
            <span className="num" style={{ minWidth: 90, textAlign: 'right' }}>{mp ? lempiras(Number(it.cantidad_m2 || 0) * Number(mp.costo_promedio)) : '—'}</span>
            <button className="btn chico" onClick={() => set('items', f.items.filter((_, j) => j !== i))} aria-label="Quitar">✕</button>
          </div>
        );
      })}
      <button className="btn chico" onClick={() => set('items', [...f.items, { insumo_id: '', cantidad_m2: '' }])}>+ Insumo</button>
      <div className="fab-nota">Insumos {lempiras(insumosCosto)} → con merma {lempiras(conMerma)} + mano de obra {lempiras(f.mano_obra_m2)} + indirectos {lempiras(f.indirectos_m2)} = <b>{lempiras(total)} por m²</b></div>
    </Modal>
  );
}
