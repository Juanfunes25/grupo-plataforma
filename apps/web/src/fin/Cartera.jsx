import { useState } from 'react';
import { fechaHN } from '@grupo/shared';
import { Campo, Estado, Kpi, Modal, useAccion, useConfirmar, useDatos } from '../ui/kit.jsx';
import { get, post, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { BarraApilada, BotonExcel, fmt } from './comun.jsx';

const SEG_COBRAR = [['0-30', '0-30 días', 'fin-c1'], ['31-60', '31-60 días', 'fin-c2'], ['61-90', '61-90 días', 'fin-c3'], ['+90', 'Más de 90', 'fin-c4']];
const SEG_PAGAR = [['vencido', 'Vencido', 'fin-c4'], ['0-7', 'Vence en 7 días', 'fin-c3'], ['8-30', '8 a 30 días', 'fin-c2'], ['+30', 'Más de 30', 'fin-c1']];

// ── Por cobrar ──────────────────────────────────────────────────────────────
export function PorCobrar() {
  const { puede } = useSesion();
  const d = useDatos(() => get('/fin/por-cobrar'), []);
  const [abono, setAbono] = useState(null);
  return (
    <Estado d={d}>{(c) => (
      <>
        <div className="fila espacio"><span className="fin-nota">Facturas a crédito con saldo y cotizaciones aprobadas sin cobrar completas. La antigüedad cuenta los días desde la factura o la aprobación.</span><BotonExcel ruta={`/fin/exportar${qs({ reporte: 'cobrar' })}`} nombre="por-cobrar.xlsx" /></div>
        <div className="rejilla cols-3">
          <Kpi acento etiqueta="Total por cobrar" valor={fmt(c.total)} sub={`${c.items.length} documentos`} />
          <Kpi etiqueta="Con más de 60 días" tono={c.buckets['61-90'] + c.buckets['+90'] > 0 ? 'aviso' : undefined} valor={fmt(c.buckets['61-90'] + c.buckets['+90'])} />
          <Kpi etiqueta="Vencido por plazo de crédito" tono={c.vencido > 0 ? 'mal' : undefined} valor={fmt(c.vencido)} sub="Clientes con días de crédito pactados" />
        </div>
        <div className="tarjeta"><h3>Antigüedad de saldos</h3><BarraApilada segmentos={SEG_COBRAR.map(([k, etq, clase]) => ({ etq, valor: c.buckets[k], clase }))} /></div>
        {c.por_cliente.length > 0 && (
          <div className="tarjeta pad0"><div className="tabla-wrap libre"><table data-tarjetas>
            <thead><tr><th>Cliente</th>{SEG_COBRAR.map(([k, etq]) => <th key={k} className="der">{etq}</th>)}<th className="der">Saldo</th></tr></thead>
            <tbody>{c.por_cliente.map((x) => <tr key={x.cliente_id ?? x.cliente}><td data-etq="">{x.cliente}</td>{SEG_COBRAR.map(([k, etq]) => <td key={k} className="der num" data-etq={etq}>{x[k] ? fmt(x[k]) : '—'}</td>)}<td className="der num" data-etq="Saldo"><b>{fmt(x.saldo)}</b></td></tr>)}</tbody>
          </table></div></div>
        )}
        <h2>Detalle</h2>
        <div className="tarjeta pad0"><div className="tabla-wrap"><table data-tarjetas>
          <thead><tr><th>Documento</th><th>Cliente</th><th>Fecha</th><th className="der">Días</th><th className="der">Total</th><th className="der">Saldo</th><th></th></tr></thead>
          <tbody>{c.items.map((i) => (
            <tr key={`${i.tipo}${i.id}`}>
              <td data-etq="">{i.ref} <span className="chip">{i.tipo === 'factura' ? 'crédito' : 'cotización'}</span></td><td data-etq="Cliente">{i.cliente}</td>
              <td className="num" data-etq="Fecha">{i.fecha}{i.vence && <small> · vence {i.vence}</small>}</td>
              <td className="der num" data-etq="Días"><span className={`chip ${i.dias > 90 ? 'mal' : i.dias > 60 ? 'aviso' : ''}`}>{i.dias}</span></td>
              <td className="der num" data-etq="Total">{fmt(i.total)}</td><td className="der num" data-etq="Saldo"><b>{fmt(i.saldo)}</b></td>
              <td className="der" data-etq="">{i.tipo === 'factura' && puede('fin:gastos') ? <button className="btn chico" onClick={() => setAbono(i)}>Registrar abono</button> : null}</td>
            </tr>))}</tbody>
        </table>{c.items.length === 0 && <div className="vacio">Nada por cobrar. </div>}</div></div>
        {abono && <AbonoModal item={abono} onCerrar={() => setAbono(null)} onListo={() => { setAbono(null); d.recargar(); }} />}
      </>
    )}</Estado>
  );
}

function AbonoModal({ item, onCerrar, onListo }) {
  const [f, setF] = useState({ monto: String(item.saldo), fecha: fechaHN(), forma: 'Transferencia', referencia: '' });
  const [ejecutar, ocupado] = useAccion();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal titulo={`Abono a ${item.ref}`} tam="angosto" onCerrar={onCerrar} pie={<button className="btn primario" disabled={ocupado || !(parseFloat(f.monto) > 0)}
      onClick={async () => { if (await ejecutar(() => post('/fin/abonos', { venta_id: item.id, monto: parseFloat(f.monto), fecha: f.fecha, forma: f.forma, referencia: f.referencia || null }), 'Abono registrado')) onListo(); }}>Guardar abono</button>}>
      <p style={{ margin: 0 }}>{item.cliente} · saldo {fmt(item.saldo)}</p>
      <Campo etiqueta="Monto recibido (L)"><input inputMode="decimal" value={f.monto} onChange={set('monto')} autoFocus /></Campo>
      <div className="rejilla cols-2">
        <Campo etiqueta="Fecha"><input type="date" max={fechaHN()} value={f.fecha} onChange={set('fecha')} /></Campo>
        <Campo etiqueta="Forma"><select value={f.forma} onChange={set('forma')}><option>Efectivo</option><option>Transferencia</option><option>Cheque</option><option>Tarjeta</option></select></Campo>
      </div>
      <Campo etiqueta="Referencia (opcional)"><input value={f.referencia} onChange={set('referencia')} /></Campo>
    </Modal>
  );
}

// ── Por pagar ───────────────────────────────────────────────────────────────
export function PorPagar() {
  const { puede } = useSesion();
  const d = useDatos(() => get('/fin/por-pagar'), []);
  const [pago, setPago] = useState(null);
  const [ejecutar] = useAccion();
  const confirmar = useConfirmar();
  return (
    <Estado d={d}>{(c) => (
      <>
        <div className="fila espacio"><span className="fin-nota">Compras a crédito recibidas y gastos registrados como «por pagar», con su fecha límite.</span><BotonExcel ruta={`/fin/exportar${qs({ reporte: 'pagar' })}`} nombre="por-pagar.xlsx" /></div>
        <div className="rejilla cols-3">
          <Kpi acento etiqueta="Total por pagar" valor={fmt(c.total)} sub={`${c.items.length} documentos`} />
          <Kpi etiqueta="Vencido" tono={c.vencido > 0 ? 'mal' : 'ok'} valor={fmt(c.vencido)} />
          <Kpi etiqueta="Vence en 7 días" tono={c.buckets['0-7'] > 0 ? 'aviso' : undefined} valor={fmt(c.buckets['0-7'])} />
        </div>
        <div className="tarjeta"><h3>Vencimientos</h3><BarraApilada segmentos={SEG_PAGAR.map(([k, etq, clase]) => ({ etq, valor: c.buckets[k], clase }))} /></div>
        <div className="tarjeta pad0"><div className="tabla-wrap"><table data-tarjetas>
          <thead><tr><th>Documento</th><th>Proveedor</th><th>Vence</th><th className="der">Saldo</th><th></th></tr></thead>
          <tbody>{c.items.map((i) => (
            <tr key={`${i.tipo}${i.id}${i.vence}`}>
              <td data-etq="">{i.ref}{i.documento && <small> · factura {i.documento}</small>} <span className="chip">{i.tipo === 'orden' ? 'compra' : 'gasto'}</span></td><td data-etq="Proveedor">{i.proveedor}</td>
              <td className="num" data-etq="Vence">{i.vence} <span className={`chip ${i.dias_para_vencer < 0 ? 'mal' : i.dias_para_vencer <= 7 ? 'aviso' : ''}`}>{i.dias_para_vencer < 0 ? `vencido hace ${-i.dias_para_vencer} d` : i.dias_para_vencer === 0 ? 'vence hoy' : `en ${i.dias_para_vencer} d`}</span></td>
              <td className="der num" data-etq="Saldo"><b>{fmt(i.saldo)}</b></td>
              <td className="der" data-etq="">{puede('fin:gastos') && <button className="btn chico" onClick={async () => {
                if (i.tipo === 'orden') return setPago(i);
                if (await confirmar({ titulo: 'Marcar como pagado', mensaje: `¿Pagaste «${i.ref}» por ${fmt(i.saldo)}?`, textoOk: 'Sí, pagado' }) && await ejecutar(() => post(`/fin/gastos/${i.id}/pagar`, {}), 'Marcado como pagado')) d.recargar();
              }}>Pagar</button>}</td>
            </tr>))}</tbody>
        </table>{c.items.length === 0 && <div className="vacio">No debes nada a proveedores.</div>}</div></div>
        {c.por_proveedor.length > 1 && (
          <div className="tarjeta pad0"><table data-tarjetas><thead><tr><th>Proveedor</th><th className="der">Vencido</th><th className="der">Saldo</th></tr></thead>
            <tbody>{c.por_proveedor.map((p) => <tr key={p.proveedor_id ?? p.proveedor}><td data-etq="">{p.proveedor}</td><td className={`der num ${p.vencido > 0 ? 'fin-neg' : ''}`} data-etq="Vencido">{p.vencido ? fmt(p.vencido) : '—'}</td><td className="der num" data-etq="Saldo"><b>{fmt(p.saldo)}</b></td></tr>)}</tbody></table></div>
        )}
        {pago && <PagoOrden item={pago} onCerrar={() => setPago(null)} onListo={() => { setPago(null); d.recargar(); }} />}
      </>
    )}</Estado>
  );
}

export function PagoOrden({ item, onCerrar, onListo }) {
  const [f, setF] = useState({ monto: String(item.saldo), fecha: fechaHN(), forma: 'Transferencia', referencia: '' });
  const [ejecutar, ocupado] = useAccion();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal titulo={`Pago a ${item.proveedor}`} tam="angosto" onCerrar={onCerrar} pie={<button className="btn primario" disabled={ocupado || !(parseFloat(f.monto) > 0)}
      onClick={async () => { if (await ejecutar(() => post(`/compras/ordenes/${item.id}/pagos`, { monto_lps: parseFloat(f.monto), fecha: f.fecha, forma: f.forma, referencia: f.referencia || null }), 'Pago registrado')) onListo(); }}>Registrar pago</button>}>
      <p style={{ margin: 0 }}>{item.ref} · saldo {fmt(item.saldo)}</p>
      <Campo etiqueta="Monto pagado (L)"><input inputMode="decimal" value={f.monto} onChange={set('monto')} autoFocus /></Campo>
      <div className="rejilla cols-2">
        <Campo etiqueta="Fecha"><input type="date" max={fechaHN()} value={f.fecha} onChange={set('fecha')} /></Campo>
        <Campo etiqueta="Forma"><select value={f.forma} onChange={set('forma')}><option>Transferencia</option><option>Efectivo</option><option>Cheque</option><option>Tarjeta</option></select></Campo>
      </div>
      <Campo etiqueta="Referencia (opcional)"><input value={f.referencia} onChange={set('referencia')} /></Campo>
    </Modal>
  );
}
