import { useMemo, useState } from 'react';
import { lempiras } from '@grupo/shared';
import { api, get, post, put } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, Modal, useAccion, useAviso, useDatos } from '../ui/kit.jsx';
import { num } from '../eco/util.js';
import '../eco/eco.css';

const UNIDADES = [['m2', 'm²'], ['caja', 'Caja'], ['pieza', 'Pieza'], ['ml', 'Metro lineal'], ['saco', 'Saco'], ['galon', 'Galón'], ['unidad', 'Unidad'], ['viaje', 'Viaje'], ['global', 'Global']];
const VACIO = { tipo: 'piedra', nombre: '', codigo: '', modelo: '', color: '', unidad_venta: 'm2', m2_por_caja: '', piezas_por_m2: '', peso_kg_m2: '', rendimiento_m2: '', stock_minimo_m2: '', descripcion: '', precio: '', impuesto_tasa: 0.15 };

/** Catálogo de piedra: producto = modelo + color; unidad de venta; listas de precio Público / Contratista / Distribuidor; accesorios con rendimiento. */
export default function Piedra() {
  const { puede } = useSesion();
  const gerencia = puede('pos:catalogo');
  const [ejecutar, ocupado] = useAccion();
  const avisar = useAviso();
  const d = useDatos(async () => {
    const [productos, listas, precios] = await Promise.all([get('/eco/productos?incluirInactivos=true'), get('/eco/listas-precio'), get('/eco/listas-precio/precios')]);
    return { productos, listas, precios: Object.fromEntries(precios.map((x) => [`${x.producto_id}|${x.lista_id}`, Number(x.precio)])) };
  }, []);
  const [filtro, setFiltro] = useState('');
  const [tipo, setTipo] = useState('');
  const [ed, setEd] = useState(null);   // { id?, form, preciosForm, activo, precioOriginal }

  const { productos = [], listas = [], precios = {} } = d.datos ?? {};
  const visibles = useMemo(() => productos.filter((p) => (!tipo || p.tipo === tipo)
    && (!filtro || `${p.nombre} ${p.modelo ?? ''} ${p.color ?? ''} ${p.codigo ?? ''}`.toLowerCase().includes(filtro.toLowerCase()))), [productos, filtro, tipo]);

  const nuevo = (t) => setEd({ form: { ...VACIO, tipo: t, unidad_venta: t === 'piedra' ? 'm2' : t === 'accesorio' ? 'saco' : 'viaje' }, preciosForm: {}, activo: true });
  const editar = (p) => setEd({
    id: p.id, activo: p.activo, precioOriginal: Number(p.precio),
    form: Object.fromEntries(Object.keys(VACIO).map((k) => [k, p[k] ?? ''])),
    preciosForm: Object.fromEntries(listas.map((l) => [l.id, precios[`${p.id}|${l.id}`] ?? (l.orden === 1 ? Number(p.precio) : '')])),
  });
  const f = ed?.form;
  const set = (k, v) => setEd({ ...ed, form: { ...ed.form, [k]: v } });
  const esPiedra = f?.tipo === 'piedra', esAcc = f?.tipo === 'accesorio';

  const guardar = async () => {
    const publico = listas.find((l) => l.orden === 1);
    const precioPublico = ed.id ? Number(ed.preciosForm[publico?.id]) || ed.precioOriginal : Number(f.precio || 0);
    const cuerpo = { ...f, nombre: f.nombre.trim(), precio: precioPublico, impuesto_tasa: Number(f.impuesto_tasa), activo: ed.id ? ed.activo : true };
    const r = await ejecutar(async () => {
      const g = ed.id ? await put(`/eco/productos/${ed.id}`, cuerpo) : await post('/eco/productos', cuerpo);
      for (const l of listas.filter((x) => x.orden !== 1)) {
        const v = ed.preciosForm[l.id];
        if (v !== '' && v !== undefined && Number(v) !== precios[`${g.id}|${l.id}`]) await put('/eco/listas-precio/precios', { producto_id: g.id, lista_id: l.id, precio: Number(v) });
      }
      return g;
    }, 'Producto guardado');
    if (r) { setEd(null); d.recargar(); }
  };

  const eliminar = async () => {
    if (!window.confirm(`¿Eliminar “${f.nombre}” definitivamente? No se puede deshacer.`)) return;
    try { await api(`/eco/productos/${ed.id}?definitivo=1`, { metodo: 'DELETE' }); setEd(null); d.recargar(); }
    catch (e) {
      if (e.codigo === 'CON_HISTORIAL' && window.confirm(`${e.message}\n\n¿Desactivarlo ahora?`)) {
        if (await ejecutar(() => api(`/eco/productos/${ed.id}`, { metodo: 'DELETE' }), 'Producto desactivado')) { setEd(null); d.recargar(); }
      } else if (e.codigo !== 'CON_HISTORIAL') avisar(e.message, 'mal');
    }
  };

  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Catálogo de piedra y accesorios</h1></div>
      <p className="tenue">Producto = modelo + color. Los precios se cargan por lista (Público con ISV incluido; Contratista y Distribuidor + ISV aparte). Los productos marcados [EJEMPLO] son de muestra: edítalos o desactívalos.</p>
      <div className="eco-barra">
        <input placeholder="Buscar modelo, color o código…" value={filtro} onChange={(e) => setFiltro(e.target.value)} />
        <select value={tipo} onChange={(e) => setTipo(e.target.value)}><option value="">Todos</option><option value="piedra">Piedra</option><option value="accesorio">Accesorios</option><option value="servicio">Servicios</option></select>
        {gerencia && <><button className="btn primario" onClick={() => nuevo('piedra')}>+ Piedra</button><button className="btn" onClick={() => nuevo('accesorio')}>+ Accesorio</button><button className="btn" onClick={() => nuevo('servicio')}>+ Servicio</button></>}
      </div>
      <Estado d={d}>{() => (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Producto</th><th>Tipo</th><th>Unidad</th><th>Caja</th>{listas.map((l) => <th key={l.id} className="der">{l.nombre}</th>)}{gerencia && <th className="der">Costo/m²</th>}<th></th></tr></thead>
          <tbody>
            {visibles.map((p) => (
              <tr key={p.id} style={p.activo ? undefined : { opacity: 0.5 }}>
                <td><b>{p.nombre}</b>{(p.color || p.modelo) && <span className="eco-sub">{[p.modelo, p.color].filter(Boolean).join(' · ')}</span>}</td>
                <td>{p.tipo}</td><td>{p.unidad_venta}</td>
                <td>{p.m2_por_caja ? `${num(p.m2_por_caja, 3)} m²` : p.rendimiento_m2 ? `rinde ${num(p.rendimiento_m2)} m²` : '—'}</td>
                {listas.map((l) => { const v = precios[`${p.id}|${l.id}`] ?? (l.orden === 1 ? Number(p.precio) : null); return <td key={l.id} className="der num">{v ? lempiras(v) : '—'}</td>; })}
                {gerencia && <td className="der num">{Number(p.costo_estandar) > 0 ? lempiras(p.costo_estandar) : '—'}</td>}
                <td>{gerencia && <button className="btn chico" onClick={() => editar(p)}>Editar</button>}{!p.activo && <span className="chip" style={{ marginLeft: 6 }}>inactivo</span>}</td>
              </tr>
            ))}
            {!visibles.length && <tr><td colSpan={8} className="centro tenue" style={{ padding: 30 }}>Sin productos</td></tr>}
          </tbody>
        </table></div></div>
      )}</Estado>

      {ed && (
        <Modal titulo={ed.id ? 'Editar producto' : `Nuevo ${f.tipo}`} onCerrar={() => setEd(null)} tam="ancho"
          pie={<>
            {ed.id && <label style={{ flexDirection: 'row', display: 'flex', gap: 6, alignItems: 'center', marginRight: 'auto' }}><input type="checkbox" checked={ed.activo} onChange={(e) => setEd({ ...ed, activo: e.target.checked })} /> Activo</label>}
            {ed.id && <button className="btn peligro" disabled={ocupado} onClick={eliminar}>Eliminar</button>}
            <button className="btn" onClick={() => setEd(null)}>Cancelar</button>
            <button className="btn primario" disabled={ocupado || !f.nombre.trim()} onClick={guardar}>{ocupado ? 'Guardando…' : 'Guardar'}</button>
          </>}>
          <div className="eco-form">
            <Campo etiqueta="Nombre comercial"><input value={f.nombre} onChange={(e) => set('nombre', e.target.value)} placeholder="Ej.: Piedra Río Ocre" autoFocus /></Campo>
            <Campo etiqueta="Código"><input value={f.codigo} onChange={(e) => set('codigo', e.target.value)} /></Campo>
            {esPiedra && <Campo etiqueta="Modelo"><input value={f.modelo} onChange={(e) => set('modelo', e.target.value)} /></Campo>}
            {esPiedra && <Campo etiqueta="Color"><input value={f.color} onChange={(e) => set('color', e.target.value)} /></Campo>}
            <Campo etiqueta="Se vende por"><select value={f.unidad_venta} onChange={(e) => set('unidad_venta', e.target.value)}>{UNIDADES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></Campo>
            {esPiedra && <Campo etiqueta="m² por caja"><input type="number" step="0.001" value={f.m2_por_caja} onChange={(e) => set('m2_por_caja', e.target.value)} /></Campo>}
            {esPiedra && <Campo etiqueta="Piezas por m²"><input type="number" step="0.01" value={f.piezas_por_m2} onChange={(e) => set('piezas_por_m2', e.target.value)} /></Campo>}
            {esPiedra && <Campo etiqueta="Peso kg/m²" ayuda="Para el flete"><input type="number" step="0.1" value={f.peso_kg_m2} onChange={(e) => set('peso_kg_m2', e.target.value)} /></Campo>}
            {esPiedra && <Campo etiqueta="Stock mínimo m²"><input type="number" step="1" value={f.stock_minimo_m2} onChange={(e) => set('stock_minimo_m2', e.target.value)} /></Campo>}
            {esAcc && <Campo etiqueta="Rendimiento (m² por unidad)" ayuda="Ej.: un saco de pegamento cubre X m²"><input type="number" step="0.1" value={f.rendimiento_m2} onChange={(e) => set('rendimiento_m2', e.target.value)} /></Campo>}
            <Campo etiqueta="ISV"><select value={f.impuesto_tasa} onChange={(e) => set('impuesto_tasa', e.target.value)}><option value={0.15}>15%</option><option value={0}>0%</option></select></Campo>
            <Campo etiqueta="Descripción"><input value={f.descripcion} onChange={(e) => set('descripcion', e.target.value)} /></Campo>
          </div>
          <h3 style={{ margin: '14px 0 6px' }}>Precios por lista</h3>
          <div className="eco-form">
            {!ed.id && <Campo etiqueta="Precio Público (con ISV)"><input type="number" step="0.01" value={f.precio} onChange={(e) => set('precio', e.target.value)} /></Campo>}
            {ed.id && listas.map((l) => (
              <Campo key={l.id} etiqueta={`${l.nombre} ${l.isv_incluido ? '(con ISV)' : '(sin ISV)'}`}>
                <input type="number" step="0.01" value={ed.preciosForm[l.id] ?? ''} onChange={(e) => setEd({ ...ed, preciosForm: { ...ed.preciosForm, [l.id]: e.target.value } })} />
              </Campo>
            ))}
            {!ed.id && <small className="ancho">Guarda primero; después podrás cargar Contratista y Distribuidor.</small>}
          </div>
        </Modal>
      )}
    </div>
  );
}
