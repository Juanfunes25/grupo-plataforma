import { useMemo, useState } from 'react';
import { lempiras } from '@grupo/shared';
import { get, post } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, Kpi, Modal, Tabs, descargarCsv, useAccion, useAviso, useDatos } from '../ui/kit.jsx';
import { fechaCorta, num } from '../eco/util.js';
import CantidadEntera from '../ui/CantidadEntera.jsx';
import '../eco/eco.css';

const TIPO = { inicial: 'Existencia inicial', produccion: 'Lista para vender', reserva: 'Reserva', liberacion: 'Liberación', despacho: 'Despacho', venta: 'Venta', merma: 'Merma', ajuste: 'Ajuste' };
const norm = (t) => String(t ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const F0 = { q: '', modelo: '', color: '', pieza: '', soloExistencia: true, soloBajo: false, soloSecado: false };

/** Producto terminado por modelo + color + lote: disponible = físico − reservado. Lo que sigue en secado se muestra aparte. */
export default function InventarioPiedra() {
  const { puede } = useSesion();
  const avisar = useAviso();
  const [ejecutar, ocupado] = useAccion();
  const d = useDatos(async () => { const [filas, kardex] = await Promise.all([get('/eco/inventario/pt'), get('/eco/inventario/pt/kardex')]); return { filas, kardex }; }, []);
  const [pestana, setPestana] = useState('stock');
  const [f, setF] = useState(F0);
  const [fk, setFk] = useState({ q: '', tipo: '' });
  const [modal, setModal] = useState(null);
  const gerencia = puede('pos:catalogo'), escribe = puede('inv:mover');
  const { filas = [], kardex = [] } = d.datos ?? {};

  const modelos = useMemo(() => [...new Set(filas.map((p) => p.modelo).filter(Boolean))].sort(), [filas]);
  const colores = useMemo(() => [...new Set(filas.filter((p) => !f.modelo || p.modelo === f.modelo).map((p) => p.color).filter(Boolean))].sort(), [filas, f.modelo]);
  const tieneAlgo = (p) => p.fisico_primera !== 0 || p.fisico_segunda !== 0 || p.disponible_primera !== 0 || p.en_secado > 0;
  const visibles = useMemo(() => {
    const q = norm(f.q);
    return filas.filter((p) => (!f.modelo || p.modelo === f.modelo) && (!f.color || p.color === f.color) && (!f.pieza || (f.pieza === 'esquina') === p.esquina)
      && (!q || norm(`${p.nombre} ${p.modelo} ${p.color} ${p.lotes.map((l) => l.lote).join(' ')} ${p.lotes_secado.map((l) => l.lote).join(' ')}`).includes(q))
      && (!f.soloExistencia || tieneAlgo(p)) && (!f.soloBajo || p.bajo_minimo) && (!f.soloSecado || p.en_secado > 0))
      .sort((a, b) => b.disponible_primera - a.disponible_primera || b.en_secado - a.en_secado || a.nombre.localeCompare(b.nombre));
  }, [filas, f]);
  const hayFiltro = f.q || f.modelo || f.color || f.pieza || f.soloBajo || f.soloSecado || !f.soloExistencia;

  const m2 = filas.filter((p) => !p.esquina);
  const totalDisp = m2.reduce((s, p) => s + p.disponible_primera, 0), totalRes = m2.reduce((s, p) => s + p.reservado, 0), totalSecado = m2.reduce((s, p) => s + p.en_secado, 0);
  const cajasEsq = filas.filter((p) => p.esquina).reduce((s, p) => s + p.disponible_primera, 0);
  const valor = filas.reduce((s, p) => s + p.fisico_primera * Number(p.costo_estandar ?? 0), 0);
  const kardexVisible = useMemo(() => {
    const q = norm(fk.q);
    return kardex.filter((k) => (!fk.tipo || k.tipo === fk.tipo) && (!q || norm(`${k.producto} ${k.lote} ${k.motivo ?? ''}`).includes(q)));
  }, [kardex, fk]);

  const abrir = (tipo, p, lote) => setModal({ tipo, producto: p, form: { producto_id: p.id, lote: lote?.lote ?? '', calidad: lote?.calidad ?? 'primera', m2: '', contado: '', motivo: '', costo_m2: '' } });
  const dm = modal?.form;
  const set = (k, v) => setModal({ ...modal, form: { ...modal.form, [k]: v } });
  const enviar = async () => {
    const r = await ejecutar(async () => {
      if (modal.tipo === 'conteo') return post('/eco/inventario/pt/conteo', { producto_id: dm.producto_id, lote: dm.lote, calidad: dm.calidad, contado: Number(dm.contado) });
      await post('/eco/inventario/pt/ajuste', { ...dm, m2: Number(dm.m2), costo_m2: Number(dm.costo_m2) || 0, tipo: modal.tipo === 'inicial' ? 'inicial' : 'ajuste' });
      return { ok: true };
    });
    if (!r) return;
    avisar(modal.tipo !== 'conteo' ? 'Movimiento registrado' : r.diferencia === 0 ? 'Conteo correcto: coincide con el sistema.' : `Conteo con diferencia de ${num(r.diferencia, 3)} (sistema ${num(r.sistema, 3)}, contado ${num(r.contado, 3)}). Se ajustó y quedó alerta.`);
    setModal(null); d.recargar();
  };

  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Inventario de piedra</h1></div>
      <Estado d={d}>{() => (<>
        <div className="rejilla cols-4">
          <Kpi acento etiqueta="Disponible para vender" valor={`${num(totalDisp, 1)} m²`} sub={cajasEsq ? `+ ${num(cajasEsq, 0)} cajas de esquina` : undefined} />
          <Kpi etiqueta="Reservado" valor={`${num(totalRes, 1)} m²`} sub="Apartado para cotizaciones aprobadas" />
          <Kpi etiqueta="En secado" valor={`${num(totalSecado, 1)} m²`} sub="Aún no entra al inventario" />
          <Kpi etiqueta="Valor a costo" valor={gerencia ? lempiras(valor) : '—'} sub={`${filas.filter((p) => p.bajo_minimo).length} bajo el mínimo`} />
        </div>
        <Tabs tabs={[['stock', 'Existencias'], ['kardex', 'Movimientos']]} valor={pestana} onCambio={setPestana} />

        {pestana === 'stock' && (<>
          <div className="eco-barra">
            <input placeholder="Buscar modelo, color o lote…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
            <select value={f.modelo} onChange={(e) => setF({ ...f, modelo: e.target.value, color: '' })}><option value="">Todos los modelos</option>{modelos.map((m) => <option key={m}>{m}</option>)}</select>
            <select value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })}><option value="">Todos los colores</option>{colores.map((c) => <option key={c}>{c}</option>)}</select>
            <select value={f.pieza} onChange={(e) => setF({ ...f, pieza: e.target.value })}><option value="">Plana y esquina</option><option value="plana">Piedra plana</option><option value="esquina">Caja de esquina</option></select>
          </div>
          <div className="eco-barra">
            <label className="fila" style={{ flexDirection: 'row' }}><input type="checkbox" checked={f.soloExistencia} onChange={(e) => setF({ ...f, soloExistencia: e.target.checked })} /> Solo con existencia</label>
            <label className="fila" style={{ flexDirection: 'row' }}><input type="checkbox" checked={f.soloSecado} onChange={(e) => setF({ ...f, soloSecado: e.target.checked })} /> En secado</label>
            <label className="fila" style={{ flexDirection: 'row' }}><input type="checkbox" checked={f.soloBajo} onChange={(e) => setF({ ...f, soloBajo: e.target.checked })} /> Bajo el mínimo</label>
            {hayFiltro && <button className="btn chico" onClick={() => setF(F0)}>Limpiar filtros</button>}
            <small style={{ marginLeft: 'auto' }}>Mostrando {visibles.length} de {filas.length}</small>
            <button className="btn chico" onClick={() => descargarCsv(`inventario-piedra-${new Date().toISOString().slice(0, 10)}.csv`, visibles, [['nombre', 'Producto'], ['unidad', 'Unidad'], ['en_secado', 'En secado'], ['fisico_primera', 'Físico 1ª'], ['reservado', 'Reservado'], ['disponible_primera', 'Disponible']])}>Exportar CSV</button>
          </div>
          <div className="tarjeta pad0"><div className="tabla-wrap"><table>
            <thead><tr><th>Producto / lotes</th><th className="der">En secado</th><th className="der">Físico 1ª</th><th className="der">Reservado</th><th className="der">DISPONIBLE</th><th></th></tr></thead>
            <tbody>
              {visibles.map((p) => (
                <tr key={p.id}>
                  <td><b>{p.nombre}</b> {p.bajo_minimo && <span className="chip mal">bajo mínimo</span>}
                    <span className="eco-sub">{p.lotes.length ? p.lotes.map((l) => `${l.lote}${l.calidad === 'segunda' ? ' (2ª)' : ''}: ${num(l.fisico, 1)} ${p.unidad}`).join(' · ') : 'sin existencias'}
                      {p.lotes_secado.length > 0 && <span style={{ color: 'var(--aviso)' }}> · secando: {p.lotes_secado.map((l) => `${l.lote} (lista el ${fechaCorta(l.lista_el)})`).join(', ')}</span>}</span></td>
                  <td className="der num" style={{ color: p.en_secado ? 'var(--aviso)' : undefined }}>{p.en_secado ? `${num(p.en_secado, 2)} ${p.unidad}` : '—'}</td>
                  <td className="der num">{num(p.fisico_primera, 2)}</td>
                  <td className="der num">{num(p.reservado, 2)}</td>
                  <td className="der num"><b style={{ fontSize: '1.5rem', color: p.disponible_primera > 0 ? 'var(--ok)' : 'var(--tenue)' }}>{num(p.disponible_primera, 2)}</b><span className="eco-sub">{p.unidad}</span></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{escribe && <>
                    <button className="btn chico" onClick={() => abrir('inicial', p)}>Inicial</button>{' '}
                    <button className="btn chico" onClick={() => abrir('conteo', p, p.lotes[0])}>Conteo</button>{' '}
                    <button className="btn chico" onClick={() => abrir('ajuste', p, p.lotes[0])}>Ajuste</button></>}</td>
                </tr>
              ))}
              {!visibles.length && <tr><td colSpan={6} className="centro tenue" style={{ padding: 30 }}>{filas.length ? 'No hay resultados con estos filtros.' : 'Sin productos de piedra. Créalos en Catálogo de piedra.'}</td></tr>}
            </tbody>
          </table></div></div>
        </>)}

        {pestana === 'kardex' && (<>
          <div className="eco-barra">
            <input placeholder="Buscar producto, lote o motivo…" value={fk.q} onChange={(e) => setFk({ ...fk, q: e.target.value })} />
            <select value={fk.tipo} onChange={(e) => setFk({ ...fk, tipo: e.target.value })}><option value="">Todos los movimientos</option>{Object.entries(TIPO).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>
            <small>{kardexVisible.length} de {kardex.length}</small>
          </div>
          <div className="tarjeta pad0"><div className="tabla-wrap"><table>
            <thead><tr><th>Fecha</th><th>Producto</th><th>Lote</th><th>Movimiento</th><th className="der">Cantidad</th><th>Detalle</th><th>Por</th></tr></thead>
            <tbody>
              {kardexVisible.map((k) => (
                <tr key={k.id}><td>{fechaCorta(k.created_at)}</td><td>{k.producto}</td><td>{k.lote}{k.calidad === 'segunda' ? ' (2ª)' : ''}</td><td>{TIPO[k.tipo] ?? k.tipo}</td>
                  <td className="der num" style={{ color: Number(k.cantidad) < 0 ? 'var(--peligro)' : 'var(--ok)' }}>{Number(k.cantidad) > 0 ? '+' : ''}{num(k.cantidad, 3)}</td>
                  <td>{[k.ref_numero && `Cot. #${k.ref_numero}`, k.venta_numero && `Fact. ${k.venta_numero}`, k.motivo].filter(Boolean).join(' · ')}</td><td>{k.usuario ?? '—'}</td></tr>
              ))}
              {!kardexVisible.length && <tr><td colSpan={7} className="centro tenue" style={{ padding: 30 }}>Sin movimientos</td></tr>}
            </tbody>
          </table></div></div>
        </>)}
      </>)}</Estado>

      {modal && (
        <Modal titulo={`${modal.tipo === 'conteo' ? 'Conteo físico' : modal.tipo === 'inicial' ? 'Existencia inicial' : 'Ajuste'} — ${modal.producto.nombre}`} onCerrar={() => setModal(null)}
          pie={<><button className="btn" onClick={() => setModal(null)}>Cancelar</button>
            <button className="btn primario" disabled={ocupado || !dm.lote || (modal.tipo === 'conteo' ? dm.contado === '' : !dm.m2 || !dm.motivo)} onClick={enviar}>Registrar</button></>}>
          <div className="eco-form">
            <Campo etiqueta="Lote"><input value={dm.lote} onChange={(e) => set('lote', e.target.value)} placeholder={modal.tipo === 'inicial' ? 'Ej.: INICIAL-01' : 'Lote'} list="lotes-piedra" /><datalist id="lotes-piedra">{modal.producto.lotes.map((l) => <option key={l.lote + l.calidad} value={l.lote} />)}</datalist></Campo>
            {modal.tipo === 'conteo'
              ? <Campo etiqueta={`Contado (${modal.producto.esquina ? 'cajas' : 'cajas de 1 m²'})`} ayuda="Cuenta lo que hay físicamente; el sistema calcula la diferencia"><CantidadEntera value={dm.contado} min={0} ariaLabel="Contado" onChange={(v) => set('contado', v)} /></Campo>
              : <Campo etiqueta="Cantidad (cajas de 1 m²)" ayuda={modal.tipo === 'ajuste' ? 'Solo cajas completas. Negativo para restar' : 'Solo cajas completas'}><CantidadEntera value={dm.m2} min={modal.tipo === 'ajuste' ? -99999 : 1} negativo={modal.tipo === 'ajuste'} ariaLabel="Cantidad" onChange={(v) => set('m2', v)} /></Campo>}
            {modal.tipo === 'inicial' && gerencia && <Campo etiqueta="Costo L/m²"><input type="number" step="0.01" value={dm.costo_m2} onChange={(e) => set('costo_m2', e.target.value)} /></Campo>}
            {modal.tipo !== 'conteo' && <Campo etiqueta="Motivo (obligatorio)"><input value={dm.motivo} onChange={(e) => set('motivo', e.target.value)} placeholder={modal.tipo === 'inicial' ? 'Ej.: existencia al arrancar el sistema' : 'Ej.: piezas rotas al manipular'} /></Campo>}
          </div>
        </Modal>
      )}
    </div>
  );
}
