import { useState } from 'react';
import { fechaHN } from '@grupo/shared';
import { Campo, Estado, Modal, useAccion, useDatos, usePedirTexto } from '../ui/kit.jsx';
import { get, post } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { PagoOrden } from '../fin/Cartera.jsx';
import { EstadoOC, ORIGEN, Variacion, cant, dinero, lps } from './comun.jsx';
import OrdenDocumento from './OrdenDocumento.jsx';
import OrdenEditor from './OrdenEditor.jsx';

export default function OrdenDetalle({ id, onCerrar, onCambio }) {
  const { puede } = useSesion();
  const d = useDatos(() => get(`/compras/ordenes/${id}`), [id]);
  const [ejecutar, ocupado] = useAccion();
  const pedir = usePedirTexto();
  const [vista, setVista] = useState(null);   // 'recibir' | 'editar' | 'doc' | 'pago'
  const cambio = () => { d.recargar(); onCambio?.(); };
  const hacer = async (ruta, cuerpo, ok) => { if (await ejecutar(() => post(`/compras/ordenes/${id}/${ruta}`, cuerpo), ok)) cambio(); };
  return (
    <Estado d={d}>{(o) => (
      <Modal titulo={`Orden de compra N.° ${o.numero}`} tam="ancho" onCerrar={onCerrar}
        pie={<>
          <button className="btn" onClick={() => setVista('doc')}>Imprimir / correo</button>
          {puede('compras:editar') && o.estado === 'borrador' && <button className="btn" onClick={() => setVista('editar')}>Editar</button>}
          {puede('compras:editar') && o.estado === 'borrador' && <button className="btn primario" disabled={ocupado} onClick={() => hacer('enviar', {}, 'Orden enviada')}>Enviar</button>}
          {puede('compras:recibir') && ['enviada', 'recibida_parcial'].includes(o.estado) && <button className="btn primario" onClick={() => setVista('recibir')}>Recibir mercadería</button>}
          {puede('fin:gastos') && o.saldo_lps > 0 && <button className="btn" onClick={() => setVista('pago')}>Registrar pago</button>}
          {puede('compras:editar') && ['recibida', 'recibida_parcial'].includes(o.estado) && <button className="btn" disabled={ocupado} onClick={async () => { const m = o.estado === 'recibida_parcial' ? await pedir({ titulo: 'Cerrar con faltante', mensaje: 'Lo que no llegó se da por perdido. ¿Por qué cierras la orden?', etiqueta: 'Motivo', obligatorio: true, minimo: 3 }) : ''; if (m !== null) hacer('cerrar', { motivo: m || null }, 'Orden cerrada'); }}>Cerrar orden</button>}
          {puede('compras:editar') && ['borrador', 'enviada'].includes(o.estado) && <button className="btn peligro" disabled={ocupado} onClick={async () => { const m = await pedir({ titulo: 'Anular orden', etiqueta: 'Motivo', obligatorio: true, minimo: 3, textoOk: 'Anular' }); if (m) hacer('anular', { motivo: m }, 'Orden anulada'); }}>Anular</button>}
        </>}>
        <div className="fila espacio">
          <div><b style={{ fontSize: '1.15rem' }}>{o.proveedor}</b><div className="fin-nota">{o.fecha}{o.fecha_esperada && ` · entrega esperada ${o.fecha_esperada}`}{o.sucursal && ` · ${o.sucursal}`}</div></div>
          <div style={{ textAlign: 'right' }}><EstadoOC estado={o.estado} /><div className="num" style={{ fontSize: '1.4rem', fontWeight: 700 }}>{dinero(o.total, o.moneda)}</div>
            {o.moneda === 'USD' && <small>cambio de la orden L {o.tipo_cambio}</small>}</div>
        </div>
        <small className="fin-nota">{o.condicion === 'credito' ? `A crédito, ${o.dias_credito} días` : 'De contado'} · {o.isv_pct ? `ISV ${o.isv_pct} %` : 'sin ISV'}{o.motivo_cierre && ` · ${o.estado === 'anulada' ? 'Anulada' : 'Cierre'}: ${o.motivo_cierre}`}</small>
        <div className="tabla-wrap libre"><table data-tarjetas>
          <thead><tr><th>Ítem</th><th className="der">Pedido</th><th className="der">Recibido</th><th className="der">Precio</th><th className="der">Importe</th></tr></thead>
          <tbody>{o.lineas.map((l) => (
            <tr key={l.id}><td data-etq="">{l.descripcion} <small>{ORIGEN[l.origen]} · {l.unidad}</small></td><td className="der num" data-etq="Pedido">{cant(l.cantidad)}</td>
              <td className="der num" data-etq="Recibido">{cant(l.cantidad_recibida)} <div className="cmp-prog"><i style={{ width: `${Math.min(100, (l.cantidad_recibida / l.cantidad) * 100)}%` }} /></div></td>
              <td className="der num" data-etq="Precio">{dinero(l.precio_unitario, o.moneda)}</td><td className="der num" data-etq="Importe">{dinero(l.cantidad * l.precio_unitario, o.moneda)}</td></tr>))}</tbody>
        </table></div>
        {o.recepciones.length > 0 && (
          <>
            <h3>Recepciones</h3>
            {o.recepciones.map((r) => (
              <div key={r.id} className="tarjeta" style={{ padding: 12 }}>
                <div className="fila espacio"><span><b>{r.fecha}</b>{r.documento && ` · factura ${r.documento}`} <small>· {r.usuario}</small></span><b className="num">{dinero(r.total, r.moneda)}{r.moneda === 'USD' && <small> = {lps(r.total_lps)} al cambio {r.tipo_cambio}</small>}</b></div>
                {r.vence_pago && <small>Vence el pago: {r.vence_pago}</small>}
              </div>))}
          </>
        )}
        {o.condicion === 'credito' && o.recepciones.length > 0 && (
          <div className="tarjeta" style={{ padding: 12 }}>
            <div className="fila espacio"><span>Pagado al proveedor</span><b className="num">{lps(o.pagado_lps)}</b></div>
            <div className="fila espacio"><span>Saldo por pagar</span><b className={`num ${o.saldo_lps > 0 ? 'fin-neg' : 'fin-pos'}`}>{lps(o.saldo_lps)}</b></div>
            {o.pagos.map((p) => <small key={p.id} style={{ display: 'block' }}>{p.fecha} · {lps(p.monto_lps)}{p.forma && ` · ${p.forma}`}{p.referencia && ` · ${p.referencia}`}</small>)}
          </div>
        )}
        {o.notas && <p className="fin-nota"><b>Notas:</b> {o.notas}</p>}
        {vista === 'recibir' && <Recepcion orden={o} onCerrar={() => setVista(null)} onListo={() => { setVista(null); cambio(); }} />}
        {vista === 'editar' && <OrdenEditor orden={o} onCerrar={() => setVista(null)} onListo={() => { setVista(null); cambio(); }} />}
        {vista === 'doc' && <OrdenDocumento orden={o} onCerrar={() => setVista(null)} />}
        {vista === 'pago' && <PagoOrden item={{ id: o.id, ref: `OC-${o.numero}`, proveedor: o.proveedor, saldo: o.saldo_lps }} onCerrar={() => setVista(null)} onListo={() => { setVista(null); cambio(); }} />}
      </Modal>
    )}</Estado>
  );
}

function Recepcion({ orden: o, onCerrar, onListo }) {
  const pend = o.lineas.filter((l) => l.cantidad - l.cantidad_recibida > 1e-9);
  const [f, setF] = useState({ fecha: fechaHN(), documento: '', tipo_cambio: o.moneda === 'USD' ? String(o.tipo_cambio) : '', notas: '' });
  const [ls, setLs] = useState(Object.fromEntries(pend.map((l) => [l.id, { cantidad: String(Math.round((l.cantidad - l.cantidad_recibida) * 1000) / 1000), precio: String(l.precio_unitario), vence: '' }])));
  const [ejecutar, ocupado] = useAccion();
  const [res, setRes] = useState(null);
  const tc = parseFloat(f.tipo_cambio);
  const valido = (o.moneda === 'HNL' || tc > 0) && pend.some((l) => parseFloat(ls[l.id].cantidad) > 0);
  const recibir = async () => {
    const lineas = pend.filter((l) => parseFloat(ls[l.id].cantidad) > 0).map((l) => ({ linea_id: l.id, cantidad: parseFloat(ls[l.id].cantidad), precio_unitario: parseFloat(ls[l.id].precio), vence_at: ls[l.id].vence || null }));
    const r = await ejecutar(() => post(`/compras/ordenes/${o.id}/recibir`, { fecha: f.fecha, documento: f.documento || null, tipo_cambio: o.moneda === 'USD' ? tc : null, notas: f.notas || null, lineas }), 'Mercadería recibida');
    if (r) setRes(r);
  };
  if (res) {
    return (
      <Modal titulo="Mercadería recibida" onCerrar={onListo} pie={<button className="btn primario" onClick={onListo}>Listo</button>}>
        <p style={{ margin: 0 }}>La orden quedó <b>{res.estado === 'recibida' ? 'recibida completa' : 'recibida parcial'}</b>. Esto entró al inventario:</p>
        {res.lineas.map((l) => (
          <div key={l.linea_id} className="tarjeta" style={{ padding: 12, display: 'grid', gap: 4 }}>
            <b>{l.descripcion}</b>
            <span>Costo: <b className="num">{lps(l.costo_resultante)}</b> <small>{l.nota}</small></span>
            <span>Contra la compra anterior: <Variacion pct={l.variacion_pct} dolar={l.variacion_dolar} /></span>
          </div>))}
      </Modal>
    );
  }
  return (
    <Modal titulo={`Recibir · OC ${o.numero}`} tam="ancho" onCerrar={onCerrar} pie={<button className="btn primario" disabled={ocupado || !valido} onClick={recibir}>Recibir y dar entrada</button>}>
      <div className="rejilla cols-3">
        <Campo etiqueta="Fecha de recepción"><input type="date" max={fechaHN()} value={f.fecha} onChange={(e) => setF({ ...f, fecha: e.target.value })} /></Campo>
        <Campo etiqueta="# de factura del proveedor"><input value={f.documento} onChange={(e) => setF({ ...f, documento: e.target.value })} /></Campo>
        {o.moneda === 'USD' && <Campo etiqueta="Tipo de cambio del día (L por US$)" ayuda="El de la factura. El costo en lempiras se calcula con este."><input inputMode="decimal" value={f.tipo_cambio} onChange={(e) => setF({ ...f, tipo_cambio: e.target.value })} /></Campo>}
      </div>
      <div className="tabla-wrap libre"><table data-tarjetas>
        <thead><tr><th>Ítem</th><th className="der">Falta</th><th className="der">Llegó</th><th className="der">Precio facturado ({o.moneda === 'USD' ? 'US$' : 'L'})</th>{pend.some((l) => l.origen === 'inv') && <th>Vence</th>}</tr></thead>
        <tbody>{pend.map((l) => {
          const set = (k) => (e) => setLs({ ...ls, [l.id]: { ...ls[l.id], [k]: e.target.value } });
          return (
            <tr key={l.id}><td data-etq="">{l.descripcion} <small>{l.unidad}</small></td><td className="der num" data-etq="Falta">{cant(l.cantidad - l.cantidad_recibida)}</td>
              <td data-etq="Llegó"><input inputMode="decimal" aria-label={`Llegó de ${l.descripcion}`} value={ls[l.id].cantidad} onChange={set('cantidad')} style={{ maxWidth: 110, textAlign: 'right' }} /></td>
              <td data-etq="Precio facturado"><input inputMode="decimal" aria-label={`Precio de ${l.descripcion}`} value={ls[l.id].precio} onChange={set('precio')} style={{ maxWidth: 120, textAlign: 'right' }} />{parseFloat(ls[l.id].precio) !== l.precio_unitario && <small style={{ display: 'block' }}>ordenado {dinero(l.precio_unitario, o.moneda)}</small>}</td>
              {pend.some((x) => x.origen === 'inv') && <td data-etq="Vence">{l.origen === 'inv' ? <input type="date" aria-label={`Vencimiento de ${l.descripcion}`} value={ls[l.id].vence} onChange={set('vence')} style={{ maxWidth: 160 }} /> : null}</td>}</tr>);
        })}</tbody>
      </table></div>
      <small className="fin-nota">Pon 0 en lo que no llegó. Si el proveedor cobró otro precio, escríbelo: el costo del inventario y el historial de precios usan lo facturado.</small>
      <Campo etiqueta="Notas de la recepción"><input value={f.notas} onChange={(e) => setF({ ...f, notas: e.target.value })} /></Campo>
    </Modal>
  );
}
