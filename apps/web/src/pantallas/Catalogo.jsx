import { useState } from 'react';
import { lempiras } from '@grupo/shared';
import { get, post, put } from '../api.js';
import { Campo, Estado, Modal, Tabs, useAccion, useDatos } from '../ui/kit.jsx';

export default function Catalogo() {
  const [tab, setTab] = useState('productos');
  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Catálogo</h1></div>
      <Tabs tabs={[['productos', 'Productos'], ['categorias', 'Categorías'], ['grupos', 'Opciones y extras'], ['pagos', 'Formas de pago']]} valor={tab} onCambio={setTab} />
      {tab === 'productos' && <Productos />}
      {tab === 'categorias' && <Categorias />}
      {tab === 'grupos' && <Grupos />}
      {tab === 'pagos' && <Pagos />}
    </div>
  );
}

function Productos() {
  const d = useDatos(() => get('/pos/catalogo/admin/productos'), []);
  const cats = useDatos(() => get('/pos/catalogo/admin/categorias'), []);
  const grupos = useDatos(() => get('/pos/catalogo/admin/grupos'), []);
  const [edit, setEdit] = useState(null);
  const nuevo = { nombre: '', precio: '', categoria_id: '', impuesto_tasa: 0.15, exento: false, unidad: 'unidad', grupo_ids: [], activo: true, disponible: true, tipo: 'simple', codigo: '', codigo_barras: '', descripcion: '', orden: 0 };
  return (
    <>
      <div><button className="btn primario" onClick={() => setEdit(nuevo)}>+ Producto</button></div>
      <Estado d={d}>{(l) => (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Producto</th><th>Categoría</th><th className="der">Precio</th><th>ISV</th><th className="der">Costo receta</th><th></th></tr></thead>
          <tbody>{l.map((p) => (
            <tr key={p.id} className="clic" onClick={() => setEdit({ ...p, precio: String(p.precio), categoria_id: p.categoria_id ?? '' })} style={{ opacity: p.activo ? 1 : 0.5 }}>
              <td>{p.nombre} {!p.disponible && <span className="chip mal">agotado</span>} {!p.activo && <span className="chip">inactivo</span>}</td><td>{p.categoria}</td><td className="der num">{lempiras(p.precio)}{p.unidad !== 'unidad' ? ` /${p.unidad}` : ''}</td>
              <td>{p.exento ? 'Exento' : `${p.impuesto_tasa * 100}%`}</td><td className="der num">{p.costo_receta == null ? <small>—</small> : lempiras(p.costo_receta)}</td><td className="der"><small>Editar</small></td></tr>))}</tbody>
        </table></div></div>
      )}</Estado>
      {edit && <FichaProducto p={edit} cats={cats.datos ?? []} grupos={grupos.datos ?? []} onCerrar={() => setEdit(null)} onGuardado={() => { setEdit(null); d.recargar(); }} />}
    </>
  );
}

function FichaProducto({ p, cats, grupos, onCerrar, onGuardado }) {
  const [f, setF] = useState(p);
  const [ejecutar, ocupado] = useAccion();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const toggleGrupo = (id) => setF({ ...f, grupo_ids: f.grupo_ids.includes(id) ? f.grupo_ids.filter((x) => x !== id) : [...f.grupo_ids, id] });
  const guardar = async () => {
    const cuerpo = {
      codigo: f.codigo || null, codigo_barras: f.codigo_barras || null, nombre: f.nombre, descripcion: f.descripcion || null, categoria_id: f.categoria_id || null, precio: parseFloat(f.precio),
      impuesto_tasa: Number(f.impuesto_tasa), exento: f.exento, tipo: f.tipo, unidad: f.unidad || 'unidad', orden: Number(f.orden) || 0, activo: f.activo, disponible: f.disponible, grupo_ids: f.grupo_ids,
    };
    if (await ejecutar(() => (f.id ? put(`/pos/catalogo/admin/productos/${f.id}`, cuerpo) : post('/pos/catalogo/admin/productos', cuerpo)), 'Producto guardado')) onGuardado();
  };
  return (
    <Modal titulo={f.id ? f.nombre : 'Nuevo producto'} onCerrar={onCerrar} tam="ancho" pie={<button className="btn primario" disabled={ocupado || f.nombre.trim().length < 2 || !(parseFloat(f.precio) >= 0)} onClick={guardar}>Guardar</button>}>
      <div className="rejilla cols-2">
        <Campo etiqueta="Nombre"><input value={f.nombre} onChange={set('nombre')} autoFocus /></Campo>
        <Campo etiqueta="Categoría"><select value={f.categoria_id} onChange={set('categoria_id')}><option value="">Sin categoría</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select></Campo>
        <Campo etiqueta="Precio de venta (ISV incluido, L)"><input inputMode="decimal" value={f.precio} onChange={set('precio')} /></Campo>
        <Campo etiqueta="Unidad de venta" ayuda="“unidad”, o kg / lb si se vende por peso"><input value={f.unidad} onChange={set('unidad')} /></Campo>
        <Campo etiqueta="Impuesto"><select value={f.impuesto_tasa} onChange={set('impuesto_tasa')}><option value={0.15}>ISV 15 %</option><option value={0.18}>ISV 18 % (alcohol, tabaco)</option><option value={0}>0 % (exento / exonerado)</option></select></Campo>
        <Campo etiqueta="Código de barras"><input value={f.codigo_barras ?? ''} onChange={set('codigo_barras')} /></Campo>
      </div>
      <div className="fila">
        <label className="fila"><input type="checkbox" checked={f.exento} onChange={set('exento')} /> Exento por ley (fruta/verdura fresca sin procesar)</label>
        <label className="fila"><input type="checkbox" checked={f.disponible} onChange={set('disponible')} /> Disponible hoy</label>
        <label className="fila"><input type="checkbox" checked={f.activo} onChange={set('activo')} /> Activo en la caja</label>
      </div>
      {f.exento && Number(f.impuesto_tasa) > 0 && <div className="aviso-caja">Un producto exento debe llevar impuesto 0 %.</div>}
      <div><h3 style={{ marginBottom: 8 }}>Opciones que se le ofrecen</h3>
        <div className="fila">{grupos.map((g) => <button key={g.id} className="btn chico" aria-pressed={f.grupo_ids.includes(g.id)} onClick={() => toggleGrupo(g.id)} style={f.grupo_ids.includes(g.id) ? { background: 'var(--acento)', color: '#fff', borderColor: 'transparent' } : undefined}>{g.nombre}</button>)}
          {grupos.length === 0 && <small>Primero crea grupos en “Opciones y extras”.</small>}</div></div>
    </Modal>
  );
}

function Categorias() {
  const d = useDatos(() => get('/pos/catalogo/admin/categorias'), []);
  const [ejecutar, ocupado] = useAccion();
  const [nombre, setNombre] = useState('');
  const [color, setColor] = useState('#5c9a3a');
  const agregar = async () => { if (await ejecutar(() => post('/pos/catalogo/admin/categorias', { nombre, color, orden: (d.datos?.length ?? 0) + 1 }), 'Categoría creada')) { setNombre(''); d.recargar(); } };
  return (
    <>
      <div className="fila"><input placeholder="Nueva categoría" value={nombre} onChange={(e) => setNombre(e.target.value)} style={{ maxWidth: 280 }} /><input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 54, padding: 2 }} /><button className="btn primario" disabled={ocupado || nombre.trim().length < 2} onClick={agregar}>Agregar</button></div>
      <Estado d={d}>{(l) => <div className="tarjeta pad0"><table><tbody>{l.map((c) => <tr key={c.id}><td><i style={{ display: 'inline-block', width: 14, height: 14, borderRadius: 4, background: c.color || 'var(--acento)', marginRight: 8 }} />{c.nombre}</td><td className="der">{c.activo ? '' : <span className="chip">inactiva</span>}</td></tr>)}</tbody></table></div>}</Estado>
    </>
  );
}

function Grupos() {
  const d = useDatos(() => get('/pos/catalogo/admin/grupos'), []);
  const [edit, setEdit] = useState(null);
  return (
    <>
      <div><button className="btn primario" onClick={() => setEdit({ nombre: '', min_sel: 0, max_sel: 1, activo: true, orden: 0, modificadores: [{ nombre: '', precio_extra: 0, activo: true }] })}>+ Grupo de opciones</button></div>
      <Estado d={d}>{(l) => (
        <div className="rejilla cols-3">{l.map((g) => (
          <button key={g.id} className="tarjeta" style={{ textAlign: 'left' }} onClick={() => setEdit(g)}>
            <h3>{g.nombre}</h3><small>{g.min_sel > 0 ? 'Obligatorio' : 'Opcional'} · hasta {g.max_sel}</small>
            <div className="fila" style={{ marginTop: 8 }}>{g.modificadores.filter((m) => m.activo).map((m) => <span key={m.id} className="chip">{m.nombre}{Number(m.precio_extra) > 0 ? ` +${m.precio_extra}` : ''}</span>)}</div>
          </button>))}</div>
      )}</Estado>
      {edit && <FichaGrupo g={edit} onCerrar={() => setEdit(null)} onGuardado={() => { setEdit(null); d.recargar(); }} />}
    </>
  );
}

function FichaGrupo({ g, onCerrar, onGuardado }) {
  const [f, setF] = useState({ ...g, modificadores: g.modificadores.map((m) => ({ ...m, precio_extra: String(m.precio_extra) })) });
  const [ejecutar, ocupado] = useAccion();
  const setM = (i, k, v) => setF({ ...f, modificadores: f.modificadores.map((m, j) => (j === i ? { ...m, [k]: v } : m)) });
  const guardar = async () => {
    const cuerpo = { nombre: f.nombre, min_sel: Number(f.min_sel), max_sel: Number(f.max_sel), orden: Number(f.orden) || 0, activo: f.activo,
      modificadores: f.modificadores.filter((m) => m.nombre.trim()).map((m) => ({ id: m.id, nombre: m.nombre, precio_extra: parseFloat(m.precio_extra) || 0, activo: m.activo !== false })) };
    if (await ejecutar(() => (f.id ? put(`/pos/catalogo/admin/grupos/${f.id}`, cuerpo) : post('/pos/catalogo/admin/grupos', cuerpo)), 'Grupo guardado')) onGuardado();
  };
  return (
    <Modal titulo={f.id ? f.nombre : 'Nuevo grupo'} onCerrar={onCerrar} pie={<button className="btn primario" disabled={ocupado || f.nombre.trim().length < 2} onClick={guardar}>Guardar</button>}>
      <Campo etiqueta="Nombre del grupo"><input value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} placeholder="Tamaño, Boosters, Leche…" /></Campo>
      <div className="rejilla cols-2"><Campo etiqueta="Mínimo a elegir (0 = opcional)"><input type="number" min="0" value={f.min_sel} onChange={(e) => setF({ ...f, min_sel: e.target.value })} /></Campo><Campo etiqueta="Máximo a elegir"><input type="number" min="1" value={f.max_sel} onChange={(e) => setF({ ...f, max_sel: e.target.value })} /></Campo></div>
      <h3>Opciones</h3>
      {f.modificadores.map((m, i) => (
        <div className="fila" key={m.id ?? i} style={{ flexWrap: 'nowrap' }}>
          <input placeholder="Nombre" value={m.nombre} onChange={(e) => setM(i, 'nombre', e.target.value)} />
          <input placeholder="+ L" inputMode="decimal" value={m.precio_extra} onChange={(e) => setM(i, 'precio_extra', e.target.value)} style={{ maxWidth: 110 }} />
          <button className="btn chico fantasma" onClick={() => setF({ ...f, modificadores: f.modificadores.filter((_, j) => j !== i) })} aria-label="Quitar">✕</button>
        </div>
      ))}
      <button className="btn chico" onClick={() => setF({ ...f, modificadores: [...f.modificadores, { nombre: '', precio_extra: '0', activo: true }] })}>+ Opción</button>
      <small>El consumo de insumos de cada extra (ej. “Chía” descuenta 10 g) se define en Inventario → Recetas.</small>
    </Modal>
  );
}

function Pagos() {
  const d = useDatos(() => get('/pos/catalogo/admin/formas-pago'), []);
  const [ejecutar] = useAccion();
  const [nombre, setNombre] = useState('');
  const [tipo, setTipo] = useState('tarjeta');
  return (
    <>
      <div className="fila"><input placeholder="Ej. Tarjeta BAC, Link de pago" value={nombre} onChange={(e) => setNombre(e.target.value)} style={{ maxWidth: 280 }} />
        <select value={tipo} onChange={(e) => setTipo(e.target.value)} style={{ width: 'auto' }}><option value="efectivo">Efectivo</option><option value="tarjeta">Tarjeta</option><option value="transferencia">Transferencia</option><option value="otro">Otro</option></select>
        <button className="btn primario" disabled={nombre.trim().length < 2} onClick={async () => { if (await ejecutar(() => post('/pos/catalogo/admin/formas-pago', { nombre, tipo }), 'Agregada')) { setNombre(''); d.recargar(); } }}>Agregar</button></div>
      <Estado d={d}>{(l) => <div className="tarjeta pad0"><table><tbody>{l.map((f) => <tr key={f.id}><td>{f.nombre}</td><td><span className="chip">{f.tipo}</span></td><td className="der"><button className="btn chico fantasma" onClick={async () => { await ejecutar(() => put(`/pos/catalogo/admin/formas-pago/${f.id}`, { nombre: f.nombre, orden: f.orden, activo: !f.activo })); d.recargar(); }}>{f.activo ? 'Desactivar' : 'Activar'}</button></td></tr>)}</tbody></table></div>}</Estado>
    </>
  );
}
