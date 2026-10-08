import { useMemo, useState } from 'react';
import { lempiras, numero } from '@grupo/shared';
import { api, get, post, put } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, Modal, useAccion, useAviso, useConfirmar, useDatos } from '../ui/kit.jsx';
import '../diserco/diserco.css';

const UNIDADES = ['unidad', 'kit', 'galon', 'cubeta', 'saco', 'litro', 'm2', 'ml', 'pieza', 'caja'];
const VACIO = { nombre: '', codigo: '', marca: '', categoria_id: '', presentacion: 'Kit', unidad_venta: 'kit', precio: '', costo_estandar: '', rendimiento_texto: '', controla_inventario: true, consumible: true, stock_minimo: '0', activo: true };

const Seccion = ({ titulo, children }) => (
  <div><h3 className="dis-sub">{titulo}</h3><div className="dis-grid">{children}</div></div>
);

// Catálogo de productos de DISERCO. Los precios van SIN ISV (el ISV se suma en la cotización).
export default function ProductosDis() {
  const { puede } = useSesion();
  const avisar = useAviso();
  const confirmar = useConfirmar();
  const [ejecutar, ocupado] = useAccion();
  const d = useDatos(() => get('/diserco/productos?incluirInactivos=true'), []);
  const cats = useDatos(() => get('/diserco/categorias'), []);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [modal, setModal] = useState(null);
  const gerencia = puede('pos:catalogo');
  const verCosto = gerencia;

  const visibles = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (d.datos ?? []).filter((p) => (!cat || p.categoria_id === cat) && (!t || [p.nombre, p.codigo, p.presentacion, p.marca, p.categoria].some((v) => String(v ?? '').toLowerCase().includes(t))));
  }, [d.datos, q, cat]);
  const set = (k, v) => setModal((m) => ({ ...m, form: { ...m.form, [k]: v } }));

  const abrir = (p) => setModal(p
    ? { id: p.id, form: { ...VACIO, ...p, categoria_id: p.categoria_id ?? '', precio: String(p.precio), costo_estandar: p.costo_estandar ? String(p.costo_estandar) : '', stock_minimo: String(p.stock_minimo || 0), codigo: p.codigo ?? '', marca: p.marca ?? '', presentacion: p.presentacion ?? '', rendimiento_texto: p.rendimiento_texto ?? '' } }
    : { id: null, form: { ...VACIO } });

  async function guardar() {
    const f = modal.form;
    const cuerpo = { nombre: f.nombre, codigo: f.codigo, marca: f.marca, categoria_id: f.categoria_id || null, presentacion: f.presentacion, unidad_venta: f.unidad_venta, rendimiento_texto: f.rendimiento_texto,
      precio: Number(f.precio), costo_estandar: Number(f.costo_estandar) || 0, stock_minimo: Number(f.stock_minimo) || 0, controla_inventario: f.controla_inventario, consumible: f.consumible, activo: f.activo };
    const r = await ejecutar(() => (modal.id ? put(`/diserco/productos/${modal.id}`, cuerpo) : post('/diserco/productos', cuerpo)), modal.id ? 'Producto actualizado' : 'Producto creado');
    if (r) { setModal(null); d.recargar(); }
  }
  async function eliminar() {
    if (!(await confirmar({ titulo: 'Eliminar producto', mensaje: `¿Eliminar “${modal.form.nombre}” definitivamente? No se puede deshacer.`, textoOk: 'Eliminar', peligro: true }))) return;
    try {
      await api(`/diserco/productos/${modal.id}?definitivo=1`, { metodo: 'DELETE' });
      avisar('Producto eliminado'); setModal(null); d.recargar();
    } catch (e) {
      if (e.codigo === 'CON_HISTORIAL' && await confirmar({ titulo: 'Tiene historial', mensaje: `${e.message}\n\n¿Desactivarlo ahora?`, textoOk: 'Desactivar' })) {
        await ejecutar(() => api(`/diserco/productos/${modal.id}`, { metodo: 'DELETE' }), 'Producto desactivado');
        setModal(null); d.recargar();
      } else if (e.codigo !== 'CON_HISTORIAL') avisar(e.message, 'mal');
    }
  }

  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Productos DISERCO</h1></div>
      <div className="tarjeta">
        <div className="dis-barra" style={{ marginBottom: 12 }}>
          <input type="search" className="busca" placeholder="Buscar producto, código, marca…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={cat} onChange={(e) => setCat(e.target.value)} style={{ width: 'auto' }}><option value="">Todas las categorías</option>{(cats.datos ?? []).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select>
          {gerencia && <button className="btn primario" onClick={() => abrir(null)}>+ Nuevo producto</button>}
        </div>
        <Estado d={d}>{() => (
          <div className="tabla-wrap">
            <table className="dis-tabla-ancha">
              <thead><tr><th>Producto</th><th>Presentación</th><th className="der">Precio (sin ISV)</th>{verCosto && <th className="der">Costo</th>}<th className="der">Existencia</th><th /></tr></thead>
              <tbody>
                {visibles.map((p) => (
                  <tr key={p.id} style={p.activo ? undefined : { opacity: 0.5 }}>
                    <td><strong>{p.nombre}</strong><small style={{ display: 'block' }}>{[p.codigo, p.marca, p.categoria].filter(Boolean).join(' · ')}</small>{p.rendimiento_texto && <small style={{ display: 'block' }}>Rendimiento: {p.rendimiento_texto}</small>}</td>
                    <td>{p.presentacion ?? p.unidad_venta}</td>
                    <td className="der num">{lempiras(p.precio)}</td>
                    {verCosto && <td className="der num">{p.costo_estandar > 0 ? lempiras(p.costo_estandar) : '—'}</td>}
                    <td className="der num">{p.controla_inventario ? <>{numero(p.existencia, 0)} {p.bajo_minimo && <span className="chip mal">bajo mínimo</span>}</> : <small>sin control</small>}</td>
                    <td>{gerencia && <button className="btn chico" onClick={() => abrir(p)}>Editar</button>}</td>
                  </tr>
                ))}
                {visibles.length === 0 && <tr><td colSpan={6} className="vacio">Sin productos. Crea el primero con «+ Nuevo producto».</td></tr>}
              </tbody>
            </table>
          </div>
        )}</Estado>
      </div>
      {modal && (
        <Modal titulo={modal.id ? 'Editar producto' : 'Nuevo producto'} tam="ancho" onCerrar={() => setModal(null)}
          pie={<>{modal.id && <button className="btn peligro" onClick={eliminar}>Eliminar</button>}<button className="btn" onClick={() => setModal(null)}>Cancelar</button><button className="btn primario" disabled={ocupado || !modal.form.nombre.trim() || modal.form.precio === ''} onClick={guardar}>Guardar</button></>}>
          <Seccion titulo="1 · El producto">
            <div className="todo"><Campo etiqueta="Nombre"><input value={modal.form.nombre} onChange={(e) => set('nombre', e.target.value)} placeholder="Ej.: Epóxico Quarzo Autonivelante Top - Ivory" /></Campo></div>
            <Campo etiqueta="Categoría"><select value={modal.form.categoria_id} onChange={(e) => set('categoria_id', e.target.value)}><option value="">—</option>{(cats.datos ?? []).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select></Campo>
            <Campo etiqueta="Marca"><input value={modal.form.marca} onChange={(e) => set('marca', e.target.value)} placeholder="Ej.: KAIDA" /></Campo>
            <Campo etiqueta="Código"><input value={modal.form.codigo} onChange={(e) => set('codigo', e.target.value)} /></Campo>
            <Campo etiqueta="Presentación"><input value={modal.form.presentacion} onChange={(e) => set('presentacion', e.target.value)} placeholder="Kit, galón…" /></Campo>
            <Campo etiqueta="Unidad de venta"><select value={modal.form.unidad_venta} onChange={(e) => set('unidad_venta', e.target.value)}>{[...new Set([...UNIDADES, modal.form.unidad_venta])].map((u) => <option key={u}>{u}</option>)}</select></Campo>
            <div className="todo"><Campo etiqueta="Rendimiento aproximado (sale en la cotización)"><input value={modal.form.rendimiento_texto} onChange={(e) => set('rendimiento_texto', e.target.value)} placeholder="Ej.: 15 m2 aproximadamente" /></Campo></div>
          </Seccion>
          <Seccion titulo="2 · Precio y costo">
            <Campo etiqueta="Precio de venta (sin ISV)" ayuda={Number(modal.form.precio) > 0 ? `Con ISV 15 %: ${lempiras(Number(modal.form.precio) * 1.15)}` : undefined}><input type="number" step="any" min="0" value={modal.form.precio} onChange={(e) => set('precio', e.target.value)} /></Campo>
            <Campo etiqueta="Costo (sin ISV)" ayuda="El costo se actualiza solo con las compras."><input type="number" step="0.01" min="0" value={modal.form.costo_estandar} onChange={(e) => set('costo_estandar', e.target.value)} /></Campo>
          </Seccion>
          <Seccion titulo="3 · Inventario">
            <label className="dis-check todo"><input type="checkbox" checked={modal.form.controla_inventario} onChange={(e) => set('controla_inventario', e.target.checked)} /> Controlar inventario (descuenta al facturar)</label>
            <label className="dis-check todo"><input type="checkbox" checked={modal.form.consumible} onChange={(e) => set('consumible', e.target.checked)} /> Se consume al usarse (resinas, selladores…). Desmárcalo para moldes y herramientas, que deben regresar del proyecto.</label>
            {modal.form.controla_inventario && <Campo etiqueta="Mínimo en inventario"><input type="number" step="1" min="0" value={modal.form.stock_minimo} onChange={(e) => set('stock_minimo', e.target.value)} /></Campo>}
            {modal.id && <label className="dis-check todo"><input type="checkbox" checked={modal.form.activo} onChange={(e) => set('activo', e.target.checked)} /> Producto activo (aparece en ventas y cotizaciones)</label>}
          </Seccion>
        </Modal>
      )}
    </div>
  );
}
