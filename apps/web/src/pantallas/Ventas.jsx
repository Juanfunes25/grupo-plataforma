import { useState } from 'react';
import { fechaHN, horaHN, lempiras, numero, sumarDias } from '@grupo/shared';
import { get, post, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { BarrasH, Columnas, Estado, Kpi, Modal, Tabs, descargarCsv, useAccion, useAviso, useDatos } from '../ui/kit.jsx';

const rangos = () => {
  const hoy = fechaHN();
  return { hoy: [hoy, hoy], ayer: [sumarDias(hoy, -1), sumarDias(hoy, -1)], '7 días': [sumarDias(hoy, -6), hoy], mes: [`${hoy.slice(0, 8)}01`, hoy], '30 días': [sumarDias(hoy, -29), hoy] };
};

// `inicial` y `solo` permiten usar esta pantalla como Facturas, Cierre de caja, Caja chica… mientras cada una se rehace.
export default function Ventas({ inicial = 'resumen', solo = false }) {
  const { sucursales, puede } = useSesion();
  const [tab, setTab] = useState(inicial);
  const [rango, setRango] = useState('7 días');
  const [suc, setSuc] = useState('');
  const [desde, hasta] = rangos()[rango];
  const f = { desde, hasta, sucursal_id: suc };
  const resumen = useDatos(() => get(`/pos/reportes/resumen${qs(f)}`), [desde, hasta, suc]);
  const facturas = useDatos(() => get(`/pos/ventas${qs({ ...f, limite: 200 })}`), [desde, hasta, suc]);
  const turnos = useDatos(() => (tab === 'turnos' ? get(`/pos/turno${qs({ sucursal_id: suc })}`) : Promise.resolve([])), [tab, suc]);
  const caja = useDatos(() => (tab === 'caja_chica' ? get(`/pos/antifraude/movimientos-caja${qs(f)}`) : Promise.resolve([])), [tab, desde, hasta, suc]);
  const alertas = useDatos(() => (tab === 'alertas' ? get(`/pos/antifraude${qs({ desde, hasta })}`) : Promise.resolve(null)), [tab, desde, hasta]);
  const [detalle, setDetalle] = useState(null);

  const libro = async () => {
    const filas = await get(`/pos/reportes/libro${qs(f)}`);
    descargarCsv(`libro-ventas-${desde}_${hasta}.csv`, filas, [['fecha', 'Fecha'], ['numero_factura', 'Factura'], ['estado', 'Estado'], ['sucursal', 'Sucursal'], ['cliente', 'Cliente'], ['rtn', 'RTN'],
      ['exento', 'Exento'], ['exonerado', 'Exonerado'], ['gravado_15', 'Gravado 15%'], ['gravado_18', 'Gravado 18%'], ['isv', 'ISV'], ['descuento', 'Descuento'], ['total', 'Total']]);
  };

  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Ventas</h1>
        <div className="fila">
          <select value={rango} onChange={(e) => setRango(e.target.value)} aria-label="Periodo">{Object.keys(rangos()).map((r) => <option key={r}>{r}</option>)}</select>
          {sucursales.length > 1 && <select value={suc} onChange={(e) => setSuc(e.target.value)} aria-label="Sucursal"><option value="">Todas las sucursales</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select>}
          {puede('pos:reportes') && <button className="btn chico" onClick={libro}>Libro de ventas (CSV)</button>}
        </div>
      </div>
      {!solo && <Tabs tabs={[['resumen', 'Resumen'], ['facturas', 'Facturas'], ['turnos', 'Cierres de caja'], ['caja_chica', 'Caja chica'], ['alertas', 'Alertas']]} valor={tab} onCambio={setTab} />}

      {tab === 'resumen' && <Estado d={resumen}>{(r) => (
        <>
          <div className="rejilla cols-4">
            <Kpi acento etiqueta="Ventas" valor={lempiras(r.total)} sub={`${r.facturas} facturas`} />
            <Kpi etiqueta="Ticket promedio" valor={lempiras(r.ticket_promedio)} />
            <Kpi etiqueta="ISV" valor={lempiras(r.isv)} sub={`Gravado: ${lempiras(r.gravado_15)}`} />
            <Kpi etiqueta="Margen s/ costo de receta" valor={r.margen_pct == null ? '—' : `${r.margen_pct}%`} sub={`Anuladas: ${r.anuladas.n} (${lempiras(r.anuladas.total)})`} />
          </div>
          <div className="rejilla cols-2">
            <div className="tarjeta"><h3>Ventas por día</h3><Columnas datos={r.por_dia} etiqueta={(d) => d.fecha.slice(5)} valor={(d) => d.total} formato={lempiras} /></div>
            <div className="tarjeta"><h3>Por hora</h3><Columnas datos={r.por_hora} etiqueta={(d) => `${d.hora}h`} valor={(d) => d.total} formato={lempiras} /></div>
            <div className="tarjeta"><h3>Formas de pago</h3><BarrasH datos={r.por_forma_pago} etiqueta={(d) => d.nombre} valor={(d) => d.monto} formato={lempiras} /></div>
            <div className="tarjeta"><h3>Por categoría</h3><BarrasH datos={r.por_categoria} etiqueta={(d) => d.categoria} valor={(d) => d.venta} formato={lempiras} /></div>
          </div>
          <div className="tarjeta pad0"><div className="tabla-wrap"><table>
            <thead><tr><th>Producto</th><th className="der">Unidades</th><th className="der">Venta</th><th className="der">Margen</th></tr></thead>
            <tbody>{r.top_productos.map((p) => <tr key={p.producto}><td>{p.producto}</td><td className="der num">{numero(p.unidades, 1)}</td><td className="der num">{lempiras(p.venta)}</td>
              <td className="der num">{p.margen_pct == null ? <small>sin receta</small> : <span className={`chip ${p.margen_pct >= 55 ? 'ok' : p.margen_pct >= 35 ? 'aviso' : 'mal'}`}>{p.margen_pct}%</span>}</td></tr>)}</tbody>
          </table></div></div>
        </>
      )}</Estado>}

      {tab === 'facturas' && <Estado d={facturas}>{(l) => (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Fecha</th><th>Factura</th><th>Sucursal</th><th>Cajero</th><th>Estado</th><th className="der">Total</th></tr></thead>
          <tbody>{l.map((v) => (
            <tr key={v.id} className="clic" onClick={() => setDetalle(v.id)}>
              <td>{horaHN(v.fecha_emision ?? v.created_at)}</td><td className="num">{v.numero_factura ?? `Orden #${v.ticket_dia}`}</td><td>{v.sucursal}</td><td>{v.cajero}</td>
              <td><span className={`chip ${v.estado === 'pagada' ? 'ok' : v.estado === 'anulada' ? 'mal' : 'aviso'}`}>{v.estado}</span></td><td className="der num">{lempiras(v.total)}</td>
            </tr>))}</tbody>
        </table>{l.length === 0 && <div className="vacio">Sin facturas en este periodo.</div>}</div></div>
      )}</Estado>}

      {tab === 'turnos' && <Estado d={turnos}>{(l) => (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Apertura</th><th>Sucursal</th><th>Cajero</th><th className="der">Ventas</th><th className="der">Esperado</th><th className="der">Contado</th><th className="der">Diferencia</th></tr></thead>
          <tbody>{l.map((t) => (
            <tr key={t.id}><td>{horaHN(t.abierto_at)}</td><td>{t.sucursal}</td><td>{t.cajero}</td><td className="der num">{t.total_ventas == null ? '—' : lempiras(t.total_ventas)}</td>
              <td className="der num">{t.efectivo_esperado == null ? '—' : lempiras(t.efectivo_esperado)}</td><td className="der num">{t.efectivo_contado == null ? <span className="chip aviso">abierto</span> : lempiras(t.efectivo_contado)}</td>
              <td className="der num">{t.diferencia == null ? '' : <span className={`chip ${t.diferencia === 0 ? 'ok' : t.diferencia < 0 ? 'mal' : 'aviso'}`}>{lempiras(t.diferencia)}</span>}</td></tr>))}</tbody>
        </table></div></div>
      )}</Estado>}

      {tab === 'caja_chica' && <Estado d={caja}>{(l) => (
        <>
          <div className="rejilla cols-3"><Kpi etiqueta="Salidas" valor={lempiras(l.filter((m) => m.tipo === 'salida').reduce((a, m) => a + m.monto, 0))} /><Kpi etiqueta="Ingresos" valor={lempiras(l.filter((m) => m.tipo === 'ingreso').reduce((a, m) => a + m.monto, 0))} /><Kpi etiqueta="Movimientos" valor={l.length} /></div>
          <div className="tarjeta pad0"><div className="tabla-wrap"><table>
            <thead><tr><th>Fecha</th><th>Sucursal</th><th>Usuario</th><th>Concepto</th><th>Tipo</th><th className="der">Monto</th></tr></thead>
            <tbody>{l.map((m) => <tr key={m.id}><td>{horaHN(m.created_at)}</td><td>{m.sucursal}</td><td>{m.usuario}</td><td>{m.concepto}</td><td><span className={`chip ${m.tipo === 'salida' ? 'aviso' : 'ok'}`}>{m.tipo}</span></td><td className="der num">{lempiras(m.monto)}</td></tr>)}</tbody>
          </table>{l.length === 0 && <div className="vacio">Sin movimientos de caja en este periodo.</div>}</div></div>
        </>
      )}</Estado>}

      {tab === 'alertas' && <Estado d={alertas}>{(a) => !a ? null : (
        <>
          {a.alertas.length === 0 ? <div className="aviso-caja ok">Sin alertas en este periodo: descuentos, anulaciones, reimpresiones, numeración y cuadres dentro de lo normal.</div> : (
            <div style={{ display: 'grid', gap: 8 }}>{a.alertas.map((x, i) => (
              <div key={i} className={`aviso-caja ${x.severidad === 'alta' ? 'mal' : ''}`}><b>{x.titulo}</b><br /><small>{x.detalle}</small></div>
            ))}</div>
          )}
          <small>Estas alertas solo señalan patrones para revisar; no acusan a nadie. Los umbrales se ajustan por empresa. Rangos: {a.desde} a {a.hasta}.</small>
        </>
      )}</Estado>}

      {detalle && <DetalleVenta id={detalle} onCerrar={() => { setDetalle(null); facturas.recargar(); resumen.recargar(); }} />}
    </div>
  );
}

function DetalleVenta({ id, onCerrar }) {
  const { puede } = useSesion();
  const avisar = useAviso();
  const d = useDatos(() => get(`/pos/ventas/${id}`), [id]);
  const [motivo, setMotivo] = useState('');
  const [ejecutar, ocupado] = useAccion();
  const [ticket, setTicket] = useState(null);
  const v = d.datos;
  const imprimir = async () => {
    const r = await ejecutar(() => get(`/pos/ventas/${id}/ticket${qs({ reimpresion: 'true' })}`));
    if (r && r !== true) { setTicket(r.lineas); setTimeout(() => { window.print(); setTicket(null); }, 150); }
  };
  const [nc, setNc] = useState({ motivo: '', monto: '' });
  const emitirNc = async () => { if (await ejecutar(() => post(`/pos/ventas/${id}/nota-credito`, { motivo: nc.motivo, ...(nc.monto ? { monto: parseFloat(nc.monto) } : {}) }), 'Nota de crédito emitida')) { setNc({ motivo: '', monto: '' }); d.recargar(); } };
  const anular = async () => { if (await ejecutar(() => post(`/pos/ventas/${id}/anular`, { motivo }), 'Venta anulada')) { avisar('Inventario revertido'); onCerrar(); } };
  return (
    <Modal titulo={v ? (v.numero_factura ?? `Orden #${v.ticket_dia}`) : 'Venta'} onCerrar={onCerrar} tam="ancho">
      <Estado d={d}>{(x) => (
        <>
          <div className="fila"><span className={`chip ${x.estado === 'pagada' ? 'ok' : x.estado === 'anulada' ? 'mal' : 'aviso'}`}>{x.estado}</span><small>{x.sucursal.nombre} · {x.cajero?.nombre} · {x.cliente?.nombre}</small>{x.es_borrador_fiscal && <span className="chip aviso">Sin validez fiscal</span>}</div>
          <div className="tabla-wrap"><table><tbody>
            {x.lineas.map((l) => <tr key={l.id}><td>{Number(l.cantidad)}× {l.nombre_producto}{l.opciones.map((o) => <small key={o.id} className="tenue" style={{ display: 'block' }}>+ {o.nombre}</small>)}</td><td className="der num">{lempiras(l.monto)}</td></tr>)}
            <tr><td className="der">ISV</td><td className="der num">{lempiras(x.isv_total)}</td></tr>
            <tr><td className="der"><b>Total</b></td><td className="der num"><b>{lempiras(x.total)}</b></td></tr>
            {x.pagos.map((p, i) => <tr key={i}><td className="der tenue">{p.forma}{p.referencia ? ` (${p.referencia})` : ''}</td><td className="der num tenue">{lempiras(p.monto)}</td></tr>)}
          </tbody></table></div>
          {x.tercera_edad_nombre && <div className="aviso-caja">Descuento de tercera edad: {x.tercera_edad_nombre} · {x.tercera_edad_identidad}</div>}
          {x.notas_credito?.length > 0 && <div className="tarjeta pad0"><table><tbody>{x.notas_credito.map((n) => <tr key={n.id}><td>{n.numero_nota}</td><td>{n.motivo}</td><td className="der num">−{lempiras(n.monto)}</td></tr>)}</tbody></table></div>}
          {x.estado === 'pagada' && puede('pos:anular') && (
            <div className="fila"><input placeholder="Nota de crédito: motivo" value={nc.motivo} onChange={(e) => setNc({ ...nc, motivo: e.target.value })} style={{ flex: 1, minWidth: 180 }} />
              <input placeholder="Monto (vacío = todo lo pendiente)" inputMode="decimal" value={nc.monto} onChange={(e) => setNc({ ...nc, monto: e.target.value.replace(/[^\d.]/g, '') })} style={{ maxWidth: 210 }} />
              <button className="btn" disabled={nc.motivo.trim().length < 3 || ocupado} onClick={emitirNc}>Emitir nota de crédito</button></div>
          )}
          {x.estado === 'anulada' && <div className="aviso-caja mal">Anulada: {x.motivo_anulacion}</div>}
          <div className="fila">
            {x.estado !== 'abierta' && puede('pos:reimprimir') && <button className="btn" onClick={imprimir} disabled={ocupado}>Reimprimir (copia)</button>}
          </div>
          {x.estado !== 'anulada' && puede('pos:anular') && (
            <div className="fila"><input placeholder="Motivo de la anulación (obligatorio)" value={motivo} onChange={(e) => setMotivo(e.target.value)} style={{ flex: 1 }} />
              <button className="btn peligro" disabled={motivo.trim().length < 3 || ocupado} onClick={anular}>Anular</button></div>
          )}
        </>
      )}</Estado>
      {ticket && <pre className="ticket-print">{ticket.join('\n')}</pre>}
    </Modal>
  );
}
