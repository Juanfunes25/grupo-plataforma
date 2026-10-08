import { useMemo, useState } from 'react';
import { lempiras, numero } from '@grupo/shared';
import { get, post } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, Kpi, Modal, Tabs, useAccion, useAviso, useDatos } from '../ui/kit.jsx';
import Icono from '../ui/Icono.jsx';
import AvisoSinStock from '../diserco/AvisoSinStock.jsx';
import '../diserco/diserco.css';

const TIPOS = { compra: 'Compra', inicial: 'Existencia inicial', ajuste: 'Ajuste', venta: 'Venta (factura)', devolucion: 'Devolución (anulación)', salida_proyecto: 'Salida a proyecto', retorno_proyecto: 'Regresa de proyecto', proyecto: 'Sacar a proyecto' };

// Inventario de productos DISERCO: existencias, compras y ajustes. Cada factura descuenta sola.
export default function InventarioDis() {
  const { puede } = useSesion();
  const avisar = useAviso();
  const [ejecutar, ocupado] = useAccion();
  const inv = useDatos(() => get('/diserco/inventario'), []);
  const kardex = useDatos(() => get('/diserco/inventario/kardex'), []);
  const [pestana, setPestana] = useState('stock');
  const [q, setQ] = useState('');
  const [soloBajo, setSoloBajo] = useState(false);
  const [menu, setMenu] = useState(null);
  const [modal, setModal] = useState(null);
  const [abiertas, setAbiertas] = useState([]);
  const [faltantes, setFaltantes] = useState(null);
  const mueve = puede('inv:mover');
  const saca = puede('dis:salidas');
  const admin = puede('admin:empresa');
  const gerencia = puede('pos:catalogo');
  const filas = inv.datos ?? [];

  const visibles = useMemo(() => {
    const t = q.trim().toLowerCase();
    return filas.filter((p) => (!t || [p.nombre, p.codigo].some((v) => String(v ?? '').toLowerCase().includes(t))) && (!soloBajo || p.bajo_minimo));
  }, [filas, q, soloBajo]);
  const valor = filas.reduce((s, p) => s + p.existencia * Number(p.costo_estandar || 0), 0);
  const recargar = () => { inv.recargar(); kardex.recargar(); };

  function abrir(tipo, p) {
    setMenu(null);
    if (tipo === 'proyecto') get('/diserco/salidas/proyectos').then((r) => setAbiertas(r.en_curso)).catch(() => {});
    setModal({ tipo, producto: p, form: { salida_id: '', proyecto: '', cantidad: '', costo: tipo === 'compra' ? String(Number(p.costo_estandar) || '') : '', proveedor: '', referencia: '', motivo: '' } });
  }
  const set = (k, v) => setModal((m) => ({ ...m, form: { ...m.form, [k]: v } }));

  async function guardarProyecto(confirmar = false) {
    const f = modal.form;
    try {
      await post('/diserco/salidas', { proyecto: (f.salida_id || f.proyecto).trim(), items: [{ producto_id: modal.producto.id, cantidad: Number(f.cantidad) }], confirmar_sin_stock: confirmar });
      avisar(`Salida registrada: ${f.cantidad} × ${modal.producto.nombre}`); setModal(null); recargar();
    } catch (e) {
      if (e.codigo === 'SIN_STOCK') setFaltantes(e.faltantes ?? []); else avisar(e.message, 'mal');
    }
  }
  async function guardar() {
    if (modal.tipo === 'proyecto') return guardarProyecto();
    const f = modal.form;
    const r = await ejecutar(() => post('/diserco/inventario/movimiento', { producto_id: modal.producto.id, tipo: modal.tipo, cantidad: Number(f.cantidad), costo: Number(f.costo) || 0, proveedor: f.proveedor, referencia: f.referencia, motivo: f.motivo }), `${TIPOS[modal.tipo]} registrada: ${modal.producto.nombre}`);
    if (r) { setModal(null); recargar(); }
  }
  const f = modal?.form;
  const invalido = !modal || !f.cantidad || (modal.tipo === 'proyecto' ? !f.salida_id && f.proyecto.trim().length < 3 : modal.tipo !== 'ajuste' && !f.costo) || (modal.tipo === 'ajuste' && !f.motivo.trim());

  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Inventario DISERCO</h1></div>
      <div className="rejilla cols-3">
        <Kpi etiqueta="Productos con control" valor={filas.length} />
        <Kpi etiqueta="Bajo el mínimo" valor={filas.filter((p) => p.bajo_minimo).length} acento={filas.some((p) => p.bajo_minimo)} />
        <Kpi etiqueta="En negativo" valor={filas.filter((p) => p.existencia < 0).length} sub="se facturó sin existencia" />
        {gerencia && <Kpi etiqueta="Valor del inventario (costo)" valor={lempiras(valor)} />}
      </div>
      <Tabs tabs={[['stock', 'Existencias'], ['kardex', 'Movimientos']]} valor={pestana} onCambio={setPestana} />
      {pestana === 'stock' && (
        <div className="tarjeta">
          <div className="dis-barra" style={{ marginBottom: 12 }}>
            <input type="search" className="busca" placeholder="Buscar producto…" value={q} onChange={(e) => setQ(e.target.value)} />
            <label className="dis-check"><input type="checkbox" checked={soloBajo} onChange={(e) => setSoloBajo(e.target.checked)} /> Bajo el mínimo</label>
          </div>
          <Estado d={inv}>{() => (
            <div className="tabla-wrap">
              <table className="dis-tabla-ancha">
                <thead><tr><th>Producto</th><th className="der" style={{ color: 'var(--ok)' }}>EN BODEGA<small style={{ display: 'block', fontWeight: 400 }}>para vender</small></th>{admin && <th className="der" style={{ color: 'var(--aviso)' }}>EN PROYECTOS</th>}<th className="der">Mínimo</th>{gerencia && <th className="der">Costo prom.</th>}<th /></tr></thead>
                <tbody>
                  {visibles.map((p) => (
                    <tr key={p.id}>
                      <td><strong>{p.nombre}</strong> {p.bajo_minimo && <span className="chip mal">bajo mínimo</span>}<small style={{ display: 'block' }}>{p.presentacion ?? p.unidad_venta}</small></td>
                      <td className="der" style={{ background: 'var(--ok-fondo)' }}><span className="dis-existencia" style={{ color: p.existencia > 0 ? 'var(--ok)' : 'var(--peligro)' }}>{numero(p.existencia, 0)}</span></td>
                      {admin && <td className="der">{p.en_proyectos > 0 ? <><strong style={{ color: 'var(--aviso)', fontSize: '1.2rem' }}>{numero(p.en_proyectos, 0)}</strong>{p.proyectos.map((x) => <small key={x.salida_id} style={{ display: 'block' }}>{x.proyecto}: {numero(x.cantidad, 0)}</small>)}</> : <span className="tenue">—</span>}</td>}
                      <td className="der num">{numero(p.stock_minimo, 0)}</td>
                      {gerencia && <td className="der num">{Number(p.costo_estandar) > 0 ? lempiras(p.costo_estandar) : '—'}</td>}
                      <td>
                        {(mueve || saca) && (
                          <div style={{ position: 'relative', display: 'inline-block' }}>
                            <button className="btn chico fantasma" aria-label="Acciones de inventario" title="Sacar a proyecto, compra, existencia inicial y ajuste" onClick={() => setMenu(menu === p.id ? null : p.id)}><Icono n="mas" /></button>
                            {menu === p.id && (<>
                              <div style={{ position: 'fixed', inset: 0, zIndex: 30 }} onClick={() => setMenu(null)} />
                              <div className="dis-menu">
                                {saca && <button className="btn chico primario" onClick={() => abrir('proyecto', p)}>Sacar a proyecto</button>}
                                {mueve && <><button className="btn chico" onClick={() => abrir('compra', p)}>Registrar compra</button><button className="btn chico" onClick={() => abrir('inicial', p)}>Existencia inicial</button><button className="btn chico" onClick={() => abrir('ajuste', p)}>Ajuste</button></>}
                              </div>
                            </>)}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                  {visibles.length === 0 && <tr><td colSpan={6} className="vacio">{filas.length === 0 ? 'Aún no hay productos con control de inventario. Créalos en Productos.' : 'Sin resultados.'}</td></tr>}
                </tbody>
              </table>
            </div>
          )}</Estado>
        </div>
      )}
      {pestana === 'kardex' && (
        <div className="tarjeta">
          <Estado d={kardex}>{(k) => (
            <div className="tabla-wrap">
              <table className="dis-tabla-ancha">
                <thead><tr><th>Fecha</th><th>Producto</th><th>Movimiento</th><th className="der">Cantidad</th><th>Detalle</th><th>Usuario</th></tr></thead>
                <tbody>
                  {k.map((m) => (
                    <tr key={m.id}>
                      <td>{new Date(m.created_at).toLocaleString('es-HN', { timeZone: 'America/Tegucigalpa', dateStyle: 'short', timeStyle: 'short' })}</td>
                      <td>{m.producto}</td><td>{TIPOS[m.tipo] ?? m.tipo}</td>
                      <td className="der num" style={{ color: m.cantidad < 0 ? 'var(--peligro)' : 'var(--ok)' }}>{m.cantidad > 0 ? '+' : ''}{numero(m.cantidad, 0)}</td>
                      <td>{[m.motivo, m.proveedor, m.referencia, m.costo_unitario > 0 && gerencia ? lempiras(m.costo_unitario) : null].filter(Boolean).join(' · ')}</td>
                      <td>{m.usuario ?? '—'}</td>
                    </tr>
                  ))}
                  {k.length === 0 && <tr><td colSpan={6} className="vacio">Sin movimientos</td></tr>}
                </tbody>
              </table>
            </div>
          )}</Estado>
        </div>
      )}
      {faltantes && <AvisoSinStock faltantes={faltantes} accion="sacar el material" onCancelar={() => setFaltantes(null)} onContinuar={() => { setFaltantes(null); guardarProyecto(true); }} />}
      {modal && (
        <Modal titulo={`${TIPOS[modal.tipo]} — ${modal.producto.nombre}`} onCerrar={() => setModal(null)}
          pie={<><button className="btn" onClick={() => setModal(null)}>Cancelar</button><button className="btn primario" disabled={ocupado || invalido} onClick={guardar}>Guardar</button></>}>
          {modal.tipo === 'proyecto' && (<>
            <Campo etiqueta="Proyecto"><select value={f.salida_id} onChange={(e) => set('salida_id', e.target.value)}><option value="">Proyecto nuevo…</option>{abiertas.map((s) => <option key={s.nombre} value={s.nombre}>{s.nombre}</option>)}</select></Campo>
            {!f.salida_id && <Campo etiqueta="Nombre del proyecto"><input value={f.proyecto} onChange={(e) => set('proyecto', e.target.value)} /></Campo>}
          </>)}
          <Campo etiqueta="Cantidad (entero)" ayuda={modal.tipo === 'ajuste' ? 'Negativo para restar' : undefined}><input type="number" step="1" inputMode="numeric" value={f.cantidad} onChange={(e) => set('cantidad', e.target.value)} autoFocus /></Campo>
          {['compra', 'inicial'].includes(modal.tipo) && <Campo etiqueta="Costo unitario (sin ISV)"><input type="number" step="0.01" min="0" value={f.costo} onChange={(e) => set('costo', e.target.value)} /></Campo>}
          {modal.tipo === 'compra' && <Campo etiqueta="Proveedor"><input value={f.proveedor} onChange={(e) => set('proveedor', e.target.value)} /></Campo>}
          {modal.tipo === 'compra' && <Campo etiqueta="No. de factura del proveedor"><input value={f.referencia} onChange={(e) => set('referencia', e.target.value)} /></Campo>}
          {modal.tipo === 'ajuste' && <Campo etiqueta="Motivo (obligatorio)"><input value={f.motivo} onChange={(e) => set('motivo', e.target.value)} placeholder="Ej.: producto dañado, conteo físico" /></Campo>}
        </Modal>
      )}
    </div>
  );
}
