import { useMemo, useState } from 'react';
import { lempiras } from '@grupo/shared';
import { get, post, put } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, Kpi, Modal, Tabs, descargarCsv, useAccion, useDatos } from '../ui/kit.jsx';
import { Chip, cuando, n } from '../fab/comun.jsx';

const CATEGORIAS = ['cemento', 'arena', 'agregado', 'aditivo', 'pigmento', 'desmoldante', 'sellador', 'fibra', 'empaque', 'molde', 'otro'];
const MP_VACIO = { codigo: '', nombre: '', categoria: 'cemento', unidad: 'kg', moneda: 'HNL', stock_minimo: '', proveedor_id: '', notas: '' };
const PROV_VACIO = { nombre: '', rtn: '', contacto: '', telefono: '', email: '', dias_credito: 0, notas: '' };
const ETIQUETA_MOV = { compra: 'Compra', consumo: 'Consumo producción', ajuste: 'Ajuste', merma: 'Merma', devolucion: 'Devolución', inicial: 'Existencia inicial' };

/** Insumos de fábrica: existencias, costo promedio ponderado, compras en L o US$, proveedores, mínimos y kardex. */
export default function Insumos() {
  const { puede, contexto } = useSesion();
  const compra = contexto?.rol !== 'produccion';
  const [tab, setTab] = useState('insumos');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [modal, setModal] = useState(null);       // { tipo: 'mp'|'prov'|'mov'|'kardex', ... }
  const insumos = useDatos(() => get('/fab/insumos'), []);
  const provs = useDatos(() => get('/fab/proveedores'), []);
  const params = useDatos(() => get('/fab/parametros'), []);
  const escribe = puede('inv:mover');
  const costos = puede('fab:editar');
  const tc = params.datos?.find((p) => p.clave === 'tipo_cambio_usd')?.valor;
  const lista = insumos.datos ?? [];
  const visibles = useMemo(() => lista.filter((m) => (!cat || m.categoria === cat) && (!q || `${m.nombre} ${m.codigo ?? ''}`.toLowerCase().includes(q.toLowerCase()))), [lista, q, cat]);
  const valor = lista.reduce((s, m) => s + (m.valor_inventario ?? 0), 0);
  const bajos = lista.filter((m) => m.activo && m.bajo_minimo);
  const recargar = () => { insumos.recargar(); provs.recargar(); };

  const exportar = () => descargarCsv(`insumos-${new Date().toISOString().slice(0, 10)}.csv`, lista, [
    ['codigo', 'Código'], ['nombre', 'Insumo'], ['categoria', 'Categoría'], ['unidad', 'Unidad'], ['stock', 'Stock'], ['stock_minimo', 'Mínimo'],
    ...(costos ? [['costo_promedio', 'Costo promedio L'], ['valor_inventario', 'Valor L']] : [])]);

  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Insumos</h1></div>
      <div className="rejilla cols-4">
        <Kpi etiqueta="Insumos activos" valor={lista.filter((m) => m.activo).length} />
        <Kpi acento etiqueta="Valor del inventario" valor={costos ? lempiras(valor) : '—'} />
        <Kpi etiqueta="Bajo el mínimo" valor={bajos.length} sub={bajos.slice(0, 2).map((b) => b.nombre.replace('[EJEMPLO] ', '')).join(', ')} />
        <Kpi etiqueta="Tipo de cambio US$" valor={tc ? `L ${n(tc, 2)}` : '—'} sub="Se edita en Órdenes y agenda → Parámetros" />
      </div>
      <Tabs tabs={[['insumos', 'Insumos'], ['proveedores', 'Proveedores']]} valor={tab} onCambio={setTab} />

      {tab === 'insumos' && (
        <Estado d={insumos}>{() => (
          <div className="tarjeta pad0">
            <div className="fab-toolbar" style={{ padding: 12, marginBottom: 0 }}>
              <input className="crece" placeholder="Buscar insumo o código…" value={q} onChange={(e) => setQ(e.target.value)} />
              <select value={cat} onChange={(e) => setCat(e.target.value)}><option value="">Todas las categorías</option>{CATEGORIAS.map((c) => <option key={c}>{c}</option>)}</select>
              {escribe && <button className="btn primario" onClick={() => setModal({ tipo: 'mp', f: { ...MP_VACIO } })}>+ Insumo</button>}
              <button className="btn" onClick={exportar}>Exportar CSV</button>
            </div>
            <div className="tabla-wrap"><table>
              <thead><tr><th>Insumo</th><th>Categoría</th><th className="der">Stock</th><th className="der">Mínimo</th>{costos && <th className="der">Costo prom.</th>}{costos && <th className="der">Valor</th>}<th></th></tr></thead>
              <tbody>
                {visibles.map((m) => (
                  <tr key={m.id} style={m.activo ? undefined : { opacity: 0.5 }}>
                    <td><b>{m.nombre}</b><span className="fab-sub">{m.codigo} · {m.proveedor ?? 'sin proveedor'}</span></td>
                    <td>{m.categoria}</td>
                    <td className="der num">{n(m.stock, 3)} {m.unidad} {m.negativo ? <Chip tono="mal">negativo</Chip> : m.bajo_minimo && <Chip tono="mal">bajo mínimo</Chip>}</td>
                    <td className="der num">{n(m.stock_minimo, 3)}</td>
                    {costos && <td className="der num">{lempiras(m.costo_promedio)}{m.moneda === 'USD' && m.costo_usd != null && <span className="fab-sub">US$ {n(m.costo_usd, 4)}</span>}</td>}
                    {costos && <td className="der num">{lempiras(m.valor_inventario)}</td>}
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {escribe && compra && <button className="btn chico primario" onClick={() => setModal({ tipo: 'mov', mp: m, f: { tipo: 'compra', cantidad: '', costo_unitario: '', moneda: m.moneda, proveedor_id: m.proveedor_id ?? '', documento: '', motivo: '' } })}>Compra</button>}{' '}
                      {escribe && <button className="btn chico" onClick={() => setModal({ tipo: 'mov', mp: m, f: { tipo: 'merma', cantidad: '', motivo: '' } })}>Merma</button>}{' '}
                      {escribe && compra && <button className="btn chico" onClick={() => setModal({ tipo: 'mov', mp: m, f: { tipo: 'ajuste', cantidad: '', motivo: '' } })}>Ajuste</button>}{' '}
                      <button className="btn chico" onClick={() => setModal({ tipo: 'kardex', mp: m })}>Kardex</button>{' '}
                      {escribe && <button className="btn chico" onClick={() => setModal({ tipo: 'mp', f: { ...MP_VACIO, ...Object.fromEntries(Object.keys(MP_VACIO).map((k) => [k, m[k] ?? ''])), id: m.id, activo: m.activo } })}>Editar</button>}
                    </td>
                  </tr>
                ))}
                {visibles.length === 0 && <tr><td colSpan={7} className="vacio">Sin insumos</td></tr>}
              </tbody>
            </table></div>
          </div>
        )}</Estado>
      )}

      {tab === 'proveedores' && (
        <Estado d={provs}>{(l) => (
          <div className="tarjeta pad0">
            <div className="fab-toolbar" style={{ padding: 12, marginBottom: 0 }}>{escribe && <button className="btn primario" onClick={() => setModal({ tipo: 'prov', f: { ...PROV_VACIO } })}>+ Proveedor</button>}</div>
            <div className="tabla-wrap"><table>
              <thead><tr><th>Proveedor</th><th>RTN</th><th>Contacto</th><th>Crédito</th><th></th></tr></thead>
              <tbody>
                {l.map((p) => (
                  <tr key={p.id}><td><b>{p.nombre}</b></td><td>{p.rtn ?? '—'}</td><td>{[p.contacto, p.telefono, p.email].filter(Boolean).join(' · ') || '—'}</td><td>{p.dias_credito ? `${p.dias_credito} días` : 'Contado'}</td>
                    <td>{escribe && <button className="btn chico" onClick={() => setModal({ tipo: 'prov', f: { ...PROV_VACIO, ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v ?? ''])) } })}>Editar</button>}</td></tr>
                ))}
                {l.length === 0 && <tr><td colSpan={5} className="vacio">Aún no hay proveedores</td></tr>}
              </tbody>
            </table></div>
          </div>
        )}</Estado>
      )}

      {modal?.tipo === 'mp' && <FormInsumo modal={modal} provs={provs.datos ?? []} onCerrar={() => setModal(null)} onListo={() => { setModal(null); recargar(); }} />}
      {modal?.tipo === 'prov' && <FormProveedor modal={modal} onCerrar={() => setModal(null)} onListo={() => { setModal(null); recargar(); }} />}
      {modal?.tipo === 'mov' && <FormMovimiento modal={modal} provs={provs.datos ?? []} tc={tc} onCerrar={() => setModal(null)} onListo={() => { setModal(null); recargar(); }} />}
      {modal?.tipo === 'kardex' && <Kardex mp={modal.mp} costos={costos} onCerrar={() => setModal(null)} />}
    </div>
  );
}

function FormInsumo({ modal, provs, onCerrar, onListo }) {
  const [f, setF] = useState(modal.f);
  const [ejecutar, ocupado] = useAccion();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const guardar = async () => {
    const cuerpo = { ...f, stock_minimo: parseFloat(f.stock_minimo) || 0, proveedor_id: f.proveedor_id || null, notas: f.notas || null, codigo: f.codigo || null };
    if (await ejecutar(() => (f.id ? put(`/fab/insumos/${f.id}`, cuerpo) : post('/fab/insumos', cuerpo)), 'Insumo guardado')) onListo();
  };
  return (
    <Modal titulo={f.id ? 'Editar insumo' : 'Nuevo insumo'} onCerrar={onCerrar} pie={<button className="btn primario" disabled={ocupado || !f.nombre.trim()} onClick={guardar}>Guardar</button>}>
      <Campo etiqueta="Nombre"><input value={f.nombre} onChange={set('nombre')} autoFocus /></Campo>
      <div className="rejilla cols-2">
        <Campo etiqueta="Código"><input value={f.codigo} onChange={set('codigo')} /></Campo>
        <Campo etiqueta="Categoría"><select value={f.categoria} onChange={set('categoria')}>{CATEGORIAS.map((c) => <option key={c}>{c}</option>)}</select></Campo>
        <Campo etiqueta="Unidad"><input value={f.unidad} onChange={set('unidad')} placeholder="kg, saco, gal…" /></Campo>
        <Campo etiqueta="Moneda de compra" ayuda="US$ para pigmentos importados"><select value={f.moneda} onChange={set('moneda')}><option value="HNL">Lempiras</option><option value="USD">Dólares</option></select></Campo>
        <Campo etiqueta="Stock mínimo"><input type="number" step="0.001" value={f.stock_minimo} onChange={set('stock_minimo')} /></Campo>
        <Campo etiqueta="Proveedor habitual"><select value={f.proveedor_id ?? ''} onChange={set('proveedor_id')}><option value="">—</option>{provs.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</select></Campo>
      </div>
      {f.id && <label className="fila"><input type="checkbox" checked={f.activo} onChange={set('activo')} /> Activo</label>}
    </Modal>
  );
}

function FormProveedor({ modal, onCerrar, onListo }) {
  const [f, setF] = useState(modal.f);
  const [ejecutar, ocupado] = useAccion();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const guardar = async () => {
    const cuerpo = { ...f, dias_credito: parseInt(f.dias_credito, 10) || 0 };
    if (await ejecutar(() => (f.id ? put(`/fab/proveedores/${f.id}`, cuerpo) : post('/fab/proveedores', cuerpo)), 'Proveedor guardado')) onListo();
  };
  return (
    <Modal titulo={f.id ? 'Editar proveedor' : 'Nuevo proveedor'} onCerrar={onCerrar} pie={<button className="btn primario" disabled={ocupado || !f.nombre.trim()} onClick={guardar}>Guardar</button>}>
      <Campo etiqueta="Nombre"><input value={f.nombre} onChange={set('nombre')} autoFocus /></Campo>
      <div className="rejilla cols-2">
        <Campo etiqueta="RTN"><input value={f.rtn} onChange={set('rtn')} /></Campo>
        <Campo etiqueta="Contacto"><input value={f.contacto} onChange={set('contacto')} /></Campo>
        <Campo etiqueta="Teléfono"><input value={f.telefono} onChange={set('telefono')} /></Campo>
        <Campo etiqueta="Correo"><input value={f.email} onChange={set('email')} /></Campo>
        <Campo etiqueta="Días de crédito"><input type="number" min="0" value={f.dias_credito} onChange={set('dias_credito')} /></Campo>
      </div>
    </Modal>
  );
}

function FormMovimiento({ modal, provs, tc, onCerrar, onListo }) {
  const { mp } = modal;
  const [f, setF] = useState(modal.f);
  const [ejecutar, ocupado] = useAccion();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const guardar = async () => {
    const cuerpo = { tipo: f.tipo, cantidad: parseFloat(f.cantidad), costo_unitario: f.tipo === 'compra' ? parseFloat(f.costo_unitario) : undefined, moneda: f.moneda, proveedor_id: f.proveedor_id || null, documento: f.documento || null, motivo: f.motivo || null };
    if (await ejecutar(() => post(`/fab/insumos/${mp.id}/movimiento`, cuerpo), `${ETIQUETA_MOV[f.tipo]} registrada`)) onListo();
  };
  return (
    <Modal titulo={`${ETIQUETA_MOV[f.tipo]} — ${mp.nombre}`} onCerrar={onCerrar} pie={<button className="btn primario" disabled={ocupado || !f.cantidad} onClick={guardar}>Registrar</button>}>
      <Campo etiqueta={`Cantidad (${mp.unidad})`} ayuda={f.tipo === 'ajuste' ? 'Usa negativo para restar' : 'Número entero'}><input type="number" inputMode="numeric" step="1" value={f.cantidad} onChange={set('cantidad')} autoFocus /></Campo>
      {f.tipo === 'compra' && (
        <>
          <div className="rejilla cols-2">
            <Campo etiqueta={`Costo unitario (${f.moneda === 'USD' ? 'US$' : 'L'})`} ayuda={f.moneda === 'USD' && tc ? `Se convierte a L ${n(tc, 2)} por dólar` : undefined}><input type="number" step="0.0001" value={f.costo_unitario} onChange={set('costo_unitario')} /></Campo>
            <Campo etiqueta="Moneda"><select value={f.moneda} onChange={set('moneda')}><option value="HNL">L</option><option value="USD">US$</option></select></Campo>
          </div>
          <Campo etiqueta="Proveedor"><select value={f.proveedor_id} onChange={set('proveedor_id')}><option value="">—</option>{provs.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</select></Campo>
          <Campo etiqueta="No. factura del proveedor"><input value={f.documento} onChange={set('documento')} /></Campo>
        </>
      )}
      {f.tipo !== 'compra' && <Campo etiqueta="Motivo (obligatorio)"><input value={f.motivo} onChange={set('motivo')} placeholder="Ej.: saco roto, conteo físico, derrame…" /></Campo>}
    </Modal>
  );
}

function Kardex({ mp, costos, onCerrar }) {
  const d = useDatos(() => get(`/fab/insumos/${mp.id}/kardex`), [mp.id]);
  return (
    <Modal titulo={`Kardex — ${mp.nombre}`} onCerrar={onCerrar} tam="ancho">
      <Estado d={d}>{(l) => (
        <div className="tabla-wrap"><table>
          <thead><tr><th>Fecha</th><th>Movimiento</th><th className="der">Cantidad</th>{costos && <th className="der">Costo</th>}<th>Detalle</th><th>Por</th></tr></thead>
          <tbody>
            {l.map((k) => (
              <tr key={k.id}><td>{cuando(k.created_at)}</td><td>{ETIQUETA_MOV[k.tipo] ?? k.tipo}</td>
                <td className="der num" style={{ color: k.cantidad < 0 ? 'var(--peligro)' : 'var(--ok)' }}>{k.cantidad > 0 ? '+' : ''}{n(k.cantidad, 3)}</td>
                {costos && <td className="der num">{lempiras(k.costo_unitario)}{k.moneda === 'USD' && <span className="fab-sub">US$ al {n(k.tipo_cambio, 2)}</span>}</td>}
                <td>{[k.proveedor, k.documento, k.motivo].filter(Boolean).join(' · ')}</td><td>{k.usuario ?? '—'}</td></tr>
            ))}
            {l.length === 0 && <tr><td colSpan={6} className="vacio">Sin movimientos</td></tr>}
          </tbody>
        </table></div>
      )}</Estado>
    </Modal>
  );
}
