import { useMemo, useState } from 'react';
import { fechaHN, horaHN, lempiras, numero, sumarDias } from '@grupo/shared';
import { get, post, put, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, Kpi, Modal, Tabs, useAccion, useAviso, useDatos } from '../ui/kit.jsx';

export default function Inventario() {
  const { puede } = useSesion();
  const [tab, setTab] = useState('existencias');
  const tabs = [['existencias', 'Existencias'], ['vencimientos', 'Vencimientos'], ['recetas', 'Recetas y márgenes'], ['movimientos', 'Movimientos']];
  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Inventario</h1></div>
      <Tabs tabs={tabs} valor={tab} onCambio={setTab} />
      {tab === 'existencias' && <Existencias editar={puede('inv:mover')} />}
      {tab === 'vencimientos' && <Vencimientos />}
      {tab === 'recetas' && <Recetas editar={puede('inv:recetas')} />}
      {tab === 'movimientos' && <Movimientos />}
    </div>
  );
}

function Existencias({ editar }) {
  const { sucursalId, sucursales } = useSesion();
  const d = useDatos(() => get(`/inv/insumos${qs({ sucursal_id: sucursalId })}`), [sucursalId]);
  const resumen = useDatos(() => get('/inv/resumen'), []);
  const [modal, setModal] = useState(null);
  const [q, setQ] = useState('');
  const lista = (d.datos ?? []).filter((i) => i.activo && (!q || i.nombre.toLowerCase().includes(q.toLowerCase())));
  const valor = useMemo(() => lista.reduce((s, i) => s + Math.max(0, i.stock) * i.costo_actual, 0), [lista]);
  const recargar = () => { d.recargar(); resumen.recargar(); };

  return (
    <>
      <div className="rejilla cols-4">
        <Kpi acento etiqueta="Valor en bodega (esta sucursal)" valor={lempiras(valor)} />
        <Kpi etiqueta="Bajo mínimo" valor={lista.filter((i) => i.bajo_minimo && !i.negativo).length} />
        <Kpi etiqueta="Stock negativo" valor={lista.filter((i) => i.negativo).length} sub="Se vendió sin registrar la compra" />
        <Kpi etiqueta="Vencen en 5 días" valor={lista.filter((i) => i.proximo_vencimiento && i.proximo_vencimiento <= sumarDias(fechaHN(), 5)).length} />
      </div>
      <div className="fila">
        <input placeholder="Buscar insumo…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />
        {editar && <>
          <button className="btn primario" onClick={() => setModal('compra')}>+ Compra</button>
          <button className="btn" onClick={() => setModal('merma')}>Registrar merma</button>
          <button className="btn" onClick={() => setModal('conteo')}>Conteo físico</button>
          {sucursales.length > 1 && <button className="btn" onClick={() => setModal('traslado')}>Traslado</button>}
          <button className="btn" onClick={() => setModal('insumo')}>+ Insumo</button>
        </>}
      </div>
      <Estado d={d}>{() => (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Insumo</th><th>Categoría</th><th className="der">Existencia</th><th className="der">Mínimo</th><th className="der">Costo</th><th className="der">Valor</th><th>Vence</th></tr></thead>
          <tbody>{lista.map((i) => (
            <tr key={i.id}><td>{i.nombre}</td><td><small>{i.categoria}</small></td>
              <td className="der num"><span className={`chip ${i.negativo ? 'mal' : i.bajo_minimo ? 'aviso' : ''}`}>{numero(i.stock, 2)} {i.unidad}</span></td>
              <td className="der num">{numero(i.stock_minimo, 1)}</td><td className="der num">{lempiras(i.costo_actual)}</td><td className="der num">{lempiras(Math.max(0, i.stock) * i.costo_actual)}</td>
              <td className="num">{i.proximo_vencimiento ?? ''}</td></tr>))}</tbody>
        </table>{lista.length === 0 && <div className="vacio">No hay insumos. Agrega el primero con “+ Insumo”.</div>}</div></div>
      )}</Estado>
      {modal === 'compra' && <Compra insumos={d.datos ?? []} onCerrar={() => setModal(null)} onListo={() => { setModal(null); recargar(); }} />}
      {modal === 'merma' && <Merma insumos={d.datos ?? []} onCerrar={() => setModal(null)} onListo={() => { setModal(null); recargar(); }} />}
      {modal === 'conteo' && <Conteo insumos={lista} onCerrar={() => setModal(null)} onListo={() => { setModal(null); recargar(); }} />}
      {modal === 'traslado' && <Traslado insumos={d.datos ?? []} onCerrar={() => setModal(null)} onListo={() => { setModal(null); recargar(); }} />}
      {modal === 'insumo' && <NuevoInsumo onCerrar={() => setModal(null)} onListo={() => { setModal(null); recargar(); }} />}
    </>
  );
}

function NuevoInsumo({ onCerrar, onListo }) {
  const [f, setF] = useState({ nombre: '', categoria: '', unidad: 'kg', costo_actual: '', stock_minimo: '', perecedero: true, vida_util_dias: '' });
  const [ejecutar, ocupado] = useAccion();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const guardar = async () => {
    if (await ejecutar(() => post('/inv/insumos', { nombre: f.nombre, categoria: f.categoria || null, unidad: f.unidad, costo_actual: parseFloat(f.costo_actual) || 0, stock_minimo: parseFloat(f.stock_minimo) || 0, perecedero: f.perecedero, vida_util_dias: f.vida_util_dias ? parseInt(f.vida_util_dias, 10) : null }), 'Insumo creado')) onListo();
  };
  return (
    <Modal titulo="Nuevo insumo" onCerrar={onCerrar} pie={<button className="btn primario" disabled={ocupado || f.nombre.trim().length < 2} onClick={guardar}>Guardar</button>}>
      <Campo etiqueta="Nombre"><input value={f.nombre} onChange={set('nombre')} autoFocus /></Campo>
      <div className="rejilla cols-2">
        <Campo etiqueta="Categoría"><input value={f.categoria} onChange={set('categoria')} placeholder="Fruta, Verdura, Empaque…" /></Campo>
        <Campo etiqueta="Unidad"><input value={f.unidad} onChange={set('unidad')} placeholder="kg, l, unidad" /></Campo>
        <Campo etiqueta="Costo actual por unidad (L)"><input inputMode="decimal" value={f.costo_actual} onChange={set('costo_actual')} /></Campo>
        <Campo etiqueta="Stock mínimo"><input inputMode="decimal" value={f.stock_minimo} onChange={set('stock_minimo')} /></Campo>
      </div>
      <label className="fila"><input type="checkbox" checked={f.perecedero} onChange={set('perecedero')} /> Perecedero (controlar vencimiento)</label>
      {f.perecedero && <Campo etiqueta="Vida útil (días)" ayuda="Se usa para estimar el vencimiento cuando no lo capturas en la compra"><input type="number" min="1" value={f.vida_util_dias} onChange={set('vida_util_dias')} /></Campo>}
    </Modal>
  );
}

function Compra({ insumos, onCerrar, onListo }) {
  const { sucursalId } = useSesion();
  const proveedores = useDatos(() => get('/terceros?tipo=proveedor&limite=100'), []);
  const [lineas, setLineas] = useState([{ insumo_id: '', cantidad: '', costo_unitario: '', vence_at: '' }]);
  const [doc, setDoc] = useState('');
  const [prov, setProv] = useState('');
  const [ejecutar, ocupado] = useAccion();
  const setL = (i, k, v) => setLineas((l) => l.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const valido = lineas.some((l) => l.insumo_id && parseFloat(l.cantidad) > 0);
  const total = lineas.reduce((s, l) => s + (parseFloat(l.cantidad) || 0) * (parseFloat(l.costo_unitario) || 0), 0);
  const guardar = async () => {
    const items = lineas.filter((l) => l.insumo_id && parseFloat(l.cantidad) > 0).map((l) => ({ insumo_id: l.insumo_id, cantidad: parseFloat(l.cantidad), costo_unitario: parseFloat(l.costo_unitario) || 0, vence_at: l.vence_at || null }));
    if (await ejecutar(() => post('/inv/compras', { sucursal_id: sucursalId, numero_documento: doc || null, proveedor_id: prov || null, items }), 'Compra registrada')) onListo();
  };
  return (
    <Modal titulo="Registrar compra" onCerrar={onCerrar} tam="ancho" pie={<><b className="num" style={{ marginRight: 'auto' }}>Total {lempiras(total)}</b><button className="btn primario" disabled={!valido || ocupado} onClick={guardar}>Guardar compra</button></>}>
      <div className="rejilla cols-2">
        <Campo etiqueta="Proveedor"><select value={prov} onChange={(e) => setProv(e.target.value)}><option value="">Sin proveedor</option>{(proveedores.datos ?? []).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</select></Campo>
        <Campo etiqueta="# de factura del proveedor"><input value={doc} onChange={(e) => setDoc(e.target.value)} /></Campo>
      </div>
      {lineas.map((l, i) => (
        <div className="fila" key={i} style={{ flexWrap: 'nowrap' }}>
          <select value={l.insumo_id} onChange={(e) => { setL(i, 'insumo_id', e.target.value); const ins = insumos.find((x) => x.id === e.target.value); if (ins && !l.costo_unitario) setL(i, 'costo_unitario', String(ins.costo_actual)); }} style={{ flex: 2 }}>
            <option value="">Insumo…</option>{insumos.filter((x) => x.activo).map((x) => <option key={x.id} value={x.id}>{x.nombre} ({x.unidad})</option>)}
          </select>
          <input placeholder="Cantidad" inputMode="decimal" value={l.cantidad} onChange={(e) => setL(i, 'cantidad', e.target.value)} style={{ flex: 1 }} />
          <input placeholder="Costo unit." inputMode="decimal" value={l.costo_unitario} onChange={(e) => setL(i, 'costo_unitario', e.target.value)} style={{ flex: 1 }} />
          <input type="date" value={l.vence_at} onChange={(e) => setL(i, 'vence_at', e.target.value)} style={{ flex: 1 }} title="Vencimiento (opcional)" />
        </div>
      ))}
      <button className="btn chico" onClick={() => setLineas([...lineas, { insumo_id: '', cantidad: '', costo_unitario: '', vence_at: '' }])}>+ Línea</button>
    </Modal>
  );
}

const MOTIVOS = [['maduracion', 'Maduración / pasó de punto'], ['dano', 'Daño o golpe'], ['vencido', 'Vencido'], ['derrame', 'Derrame / accidente'], ['sobreproduccion', 'Sobreproducción'], ['degustacion', 'Degustación'], ['otro', 'Otro']];
function Merma({ insumos, onCerrar, onListo }) {
  const { sucursalId } = useSesion();
  const [f, setF] = useState({ insumo_id: '', cantidad: '', motivo: 'maduracion', nota: '' });
  const [ejecutar, ocupado] = useAccion();
  const avisar = useAviso();
  const guardar = async () => {
    const r = await ejecutar(() => post('/inv/mermas', { sucursal_id: sucursalId, insumo_id: f.insumo_id, cantidad: parseFloat(f.cantidad), motivo: f.motivo, nota: f.nota || null }));
    if (r) { avisar(`Merma registrada${r.costo ? ` · pérdida ${lempiras(r.costo)}` : ''}`); onListo(); }
  };
  return (
    <Modal titulo="Registrar merma" onCerrar={onCerrar} tam="angosto" pie={<button className="btn primario" disabled={ocupado || !f.insumo_id || !(parseFloat(f.cantidad) > 0)} onClick={guardar}>Registrar</button>}>
      <Campo etiqueta="Insumo"><select value={f.insumo_id} onChange={(e) => setF({ ...f, insumo_id: e.target.value })}><option value="">Elegir…</option>{insumos.filter((x) => x.activo).map((x) => <option key={x.id} value={x.id}>{x.nombre} ({x.unidad})</option>)}</select></Campo>
      <Campo etiqueta="Cantidad"><input inputMode="decimal" value={f.cantidad} onChange={(e) => setF({ ...f, cantidad: e.target.value })} /></Campo>
      <Campo etiqueta="Motivo"><select value={f.motivo} onChange={(e) => setF({ ...f, motivo: e.target.value })}>{MOTIVOS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select></Campo>
      <Campo etiqueta="Nota (opcional)"><input value={f.nota} onChange={(e) => setF({ ...f, nota: e.target.value })} /></Campo>
    </Modal>
  );
}

function Conteo({ insumos, onCerrar, onListo }) {
  const { sucursalId } = useSesion();
  const [reales, setReales] = useState({});
  const [res, setRes] = useState(null);
  const [ejecutar, ocupado] = useAccion();
  const conteos = Object.entries(reales).filter(([, v]) => v !== '' && !Number.isNaN(parseFloat(v))).map(([id, v]) => ({ insumo_id: id, cantidad_real: parseFloat(v) }));
  const guardar = async () => { const r = await ejecutar(() => post('/inv/ajustes', { sucursal_id: sucursalId, motivo: 'Conteo físico', conteos })); if (r && r !== true) setRes(r); };
  if (res) {
    const dif = res.filter((x) => x.diferencia !== 0);
    return (
      <Modal titulo="Conteo aplicado" onCerrar={onListo}>
        {dif.length === 0 ? <div className="aviso-caja ok">Todo coincide con el sistema.</div> : (
          <table><thead><tr><th>Insumo</th><th className="der">Sistema</th><th className="der">Contado</th><th className="der">Dif.</th><th className="der">Valor</th></tr></thead>
            <tbody>{dif.map((x) => <tr key={x.insumo_id}><td>{x.nombre}</td><td className="der num">{numero(x.sistema, 2)}</td><td className="der num">{numero(x.contado, 2)}</td><td className="der num">{numero(x.diferencia, 2)}</td><td className="der num"><span className={`chip ${x.valor < 0 ? 'mal' : 'ok'}`}>{lempiras(x.valor)}</span></td></tr>)}</tbody></table>
        )}
        <button className="btn primario" onClick={onListo}>Listo</button>
      </Modal>
    );
  }
  return (
    <Modal titulo="Conteo físico" onCerrar={onCerrar} tam="ancho" pie={<button className="btn primario" disabled={ocupado || conteos.length === 0} onClick={guardar}>Aplicar {conteos.length} conteo(s)</button>}>
      <small>Escribe solo lo que contaste; lo demás no se toca. El sistema ajusta la diferencia y la valora.</small>
      <table><thead><tr><th>Insumo</th><th className="der">En sistema</th><th className="der">Contado</th></tr></thead>
        <tbody>{insumos.map((i) => <tr key={i.id}><td>{i.nombre}</td><td className="der num">{numero(i.stock, 2)} {i.unidad}</td><td className="der"><input inputMode="decimal" value={reales[i.id] ?? ''} onChange={(e) => setReales({ ...reales, [i.id]: e.target.value })} style={{ maxWidth: 110, textAlign: 'right' }} /></td></tr>)}</tbody></table>
    </Modal>
  );
}

function Traslado({ insumos, onCerrar, onListo }) {
  const { sucursales, sucursalId } = useSesion();
  const [f, setF] = useState({ destino_id: sucursales.find((s) => s.id !== sucursalId)?.id ?? '', insumo_id: '', cantidad: '' });
  const [ejecutar, ocupado] = useAccion();
  const guardar = async () => { if (await ejecutar(() => post('/inv/traslados', { origen_id: sucursalId, destino_id: f.destino_id, insumo_id: f.insumo_id, cantidad: parseFloat(f.cantidad) }), 'Traslado hecho')) onListo(); };
  return (
    <Modal titulo="Traslado entre sucursales" onCerrar={onCerrar} tam="angosto" pie={<button className="btn primario" disabled={ocupado || !f.insumo_id || !f.destino_id || !(parseFloat(f.cantidad) > 0)} onClick={guardar}>Trasladar</button>}>
      <Campo etiqueta="Hacia"><select value={f.destino_id} onChange={(e) => setF({ ...f, destino_id: e.target.value })}>{sucursales.filter((s) => s.id !== sucursalId).map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select></Campo>
      <Campo etiqueta="Insumo"><select value={f.insumo_id} onChange={(e) => setF({ ...f, insumo_id: e.target.value })}><option value="">Elegir…</option>{insumos.filter((x) => x.activo).map((x) => <option key={x.id} value={x.id}>{x.nombre} ({numero(x.stock, 1)} {x.unidad})</option>)}</select></Campo>
      <Campo etiqueta="Cantidad"><input inputMode="decimal" value={f.cantidad} onChange={(e) => setF({ ...f, cantidad: e.target.value })} /></Campo>
    </Modal>
  );
}

function Vencimientos() {
  const [dias, setDias] = useState(5);
  const d = useDatos(() => get(`/inv/vencimientos${qs({ dias })}`), [dias]);
  return (
    <>
      <div className="fila"><label className="fila" style={{ display: 'flex' }}>Mostrar lo que vence en los próximos <select value={dias} onChange={(e) => setDias(e.target.value)} style={{ width: 'auto' }}>{[2, 5, 10, 30].map((n) => <option key={n} value={n}>{n} días</option>)}</select></label></div>
      <Estado d={d}>{(l) => (
        <div className="tarjeta pad0"><table>
          <thead><tr><th>Insumo</th><th>Sucursal</th><th className="der">Cantidad</th><th>Vence</th><th></th></tr></thead>
          <tbody>{l.map((x) => <tr key={x.id}><td>{x.insumo}</td><td>{x.sucursal}</td><td className="der num">{numero(x.cantidad_actual, 2)} {x.unidad}</td><td className="num">{x.vence_at}</td>
            <td><span className={`chip ${x.dias_restantes < 0 ? 'mal' : x.dias_restantes <= 2 ? 'aviso' : ''}`}>{x.dias_restantes < 0 ? 'vencido' : x.dias_restantes === 0 ? 'vence hoy' : `${x.dias_restantes} d`}</span></td></tr>)}</tbody>
        </table>{l.length === 0 && <div className="vacio">Nada por vencer en ese plazo.</div>}</div>
      )}</Estado>
    </>
  );
}

function Recetas({ editar }) {
  const d = useDatos(() => get('/inv/recetas'), []);
  const [sel, setSel] = useState(null);
  return (
    <>
      <Estado d={d}>{(l) => (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Producto</th><th>Categoría</th><th className="der">Precio</th><th className="der">Precio sin ISV</th><th className="der">Costo</th><th className="der">Margen</th><th className="der">Ingredientes</th></tr></thead>
          <tbody>{l.map((p) => (
            <tr key={p.id} className="clic" onClick={() => setSel(p)}><td>{p.nombre}</td><td><small>{p.categoria}</small></td><td className="der num">{lempiras(p.precio)}</td><td className="der num">{lempiras(p.precio_neto)}</td>
              <td className="der num">{p.costo == null ? '—' : lempiras(p.costo)}</td>
              <td className="der num">{p.margen_pct == null ? <small>sin receta</small> : <span className={`chip ${p.margen_pct >= 55 ? 'ok' : p.margen_pct >= 35 ? 'aviso' : 'mal'}`}>{p.margen_pct}%</span>}</td><td className="der num">{p.ingredientes}</td></tr>))}</tbody>
        </table></div></div>
      )}</Estado>
      {sel && <EditorReceta producto={sel} editar={editar} onCerrar={() => setSel(null)} onGuardado={() => { setSel(null); d.recargar(); }} />}
    </>
  );
}

function EditorReceta({ producto, editar, onCerrar, onGuardado }) {
  const insumos = useDatos(() => get('/inv/insumos'), []);
  const rec = useDatos(() => get(`/inv/recetas/${producto.id}`), [producto.id]);
  const [items, setItems] = useState(null);
  const [ejecutar, ocupado] = useAccion();
  const actual = items ?? (rec.datos ?? []).map((i) => ({ insumo_id: i.insumo_id, cantidad: String(i.cantidad), merma_pct: String(i.merma_pct) }));
  const lista = insumos.datos ?? [];
  const costo = actual.reduce((s, i) => s + (parseFloat(i.cantidad) || 0) * (1 + (parseFloat(i.merma_pct) || 0) / 100) * (lista.find((x) => x.id === i.insumo_id)?.costo_actual ?? 0), 0);
  const neto = producto.precio_neto;
  const set = (idx, k, v) => setItems(actual.map((x, j) => (j === idx ? { ...x, [k]: v } : x)));
  const guardar = async () => {
    const body = { items: actual.filter((i) => i.insumo_id && parseFloat(i.cantidad) > 0).map((i) => ({ insumo_id: i.insumo_id, cantidad: parseFloat(i.cantidad), merma_pct: parseFloat(i.merma_pct) || 0 })) };
    if (await ejecutar(() => put(`/inv/recetas/${producto.id}`, body), 'Receta guardada')) onGuardado();
  };
  return (
    <Modal titulo={`Receta · ${producto.nombre}`} onCerrar={onCerrar} tam="ancho" pie={editar && <><span style={{ marginRight: 'auto' }}>Costo <b className="num">{lempiras(costo)}</b> · margen <b className="num">{neto > 0 ? Math.round(((neto - costo) / neto) * 1000) / 10 : 0}%</b></span><button className="btn primario" disabled={ocupado} onClick={guardar}>Guardar receta</button></>}>
      <Estado d={rec}>{() => (
        <>
          <small>Cantidad de cada insumo que consume UNA unidad vendida. La merma % cubre cáscara, semillas y desperdicio de preparación.</small>
          {actual.map((i, idx) => (
            <div className="fila" key={idx} style={{ flexWrap: 'nowrap' }}>
              <select value={i.insumo_id} disabled={!editar} onChange={(e) => set(idx, 'insumo_id', e.target.value)} style={{ flex: 2 }}>{lista.filter((x) => x.activo || x.id === i.insumo_id).map((x) => <option key={x.id} value={x.id}>{x.nombre} ({x.unidad})</option>)}</select>
              <input inputMode="decimal" disabled={!editar} value={i.cantidad} onChange={(e) => set(idx, 'cantidad', e.target.value)} style={{ flex: 1 }} placeholder="Cantidad" />
              <input inputMode="decimal" disabled={!editar} value={i.merma_pct} onChange={(e) => set(idx, 'merma_pct', e.target.value)} style={{ flex: 1 }} placeholder="Merma %" />
              {editar && <button className="btn chico fantasma" onClick={() => setItems(actual.filter((_, j) => j !== idx))} aria-label="Quitar">✕</button>}
            </div>
          ))}
          {editar && <button className="btn chico" onClick={() => setItems([...actual, { insumo_id: lista[0]?.id ?? '', cantidad: '', merma_pct: '0' }])}>+ Ingrediente</button>}
        </>
      )}</Estado>
    </Modal>
  );
}

function Movimientos() {
  const d = useDatos(() => get('/inv/movimientos?limite=150'), []);
  return (
    <Estado d={d}>{(l) => (
      <div className="tarjeta pad0"><div className="tabla-wrap"><table>
        <thead><tr><th>Fecha</th><th>Insumo</th><th>Sucursal</th><th>Tipo</th><th className="der">Cantidad</th><th className="der">Costo</th><th>Motivo / usuario</th></tr></thead>
        <tbody>{l.map((m) => <tr key={m.id}><td>{horaHN(m.created_at)}</td><td>{m.insumo}</td><td>{m.sucursal}</td><td><span className={`chip ${m.cantidad < 0 ? 'aviso' : 'ok'}`}>{m.tipo}</span></td>
          <td className="der num">{numero(m.cantidad, 3)} {m.unidad}</td><td className="der num">{m.costo_total == null ? '' : lempiras(m.costo_total)}</td><td><small>{m.motivo ?? m.referencia_tipo ?? ''} {m.usuario ? `· ${m.usuario}` : ''}</small></td></tr>)}</tbody>
      </table></div></div>
    )}</Estado>
  );
}
