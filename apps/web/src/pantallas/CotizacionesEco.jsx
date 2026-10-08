import { useState } from 'react';
import { lempiras } from '@grupo/shared';
import { get, post } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Cargando, ErrorCaja, useAccion, useAviso, useDatos } from '../ui/kit.jsx';
import CotizacionEditor from '../eco/CotizacionEditor.jsx';
import AvisoSinStock from '../eco/AvisoSinStock.jsx';
import { abrirDocumento, enlaceCorreo } from '../eco/documento.js';
import { fechaCorta, num } from '../eco/util.js';
import { imprimirTicket, verPdf } from '../lib/documentos.js';
import '../eco/eco.css';

const ESTADOS = [['', 'Todas'], ['borrador,enviada', 'Por aprobar'], ['aprobada', 'Aprobadas'], ['facturada', 'Facturadas'], ['rechazada,anulada', 'Cerradas']];
const CHIP = { aprobada: 'aviso', facturada: 'ok', rechazada: 'mal', anulada: 'mal', vencida: 'mal' };
const Estado = ({ c }) => <span className={`chip ${CHIP[c.vencida ? 'vencida' : c.estado] ?? ''}`}>{c.vencida ? 'vencida' : c.estado}</span>;

/** Cotización → aprobación → cobro → factura, todo enlazado en un solo flujo (EcoStone). */
export default function CotizacionesEco() {
  const { puede } = useSesion();
  const [filtro, setFiltro] = useState('');
  const [busca, setBusca] = useState('');
  const [vista, setVista] = useState({ tipo: 'lista' });   // lista | editor{inicial} | detalle{id}
  const [aviso, setAviso] = useState('');
  const d = useDatos(() => get(`/eco/cotizaciones?${new URLSearchParams({ ...(filtro ? { estado: filtro } : {}), ...(busca ? { q: busca } : {}) })}`), [filtro, busca]);
  const vende = puede('cotizaciones:ver');

  if (vista.tipo === 'editor') {
    return <CotizacionEditor inicial={vista.inicial} onCancelar={() => setVista(vista.inicial ? { tipo: 'detalle', id: vista.inicial.id } : { tipo: 'lista' })}
      onGuardada={(c) => { setAviso(`Cotización #${c.numero} guardada`); setVista({ tipo: 'detalle', id: c.id }); }} />;
  }
  if (vista.tipo === 'detalle') {
    return <Detalle id={vista.id} aviso={aviso} onAviso={setAviso} onVolver={() => { setVista({ tipo: 'lista' }); d.recargar(); }} onEditar={(c) => setVista({ tipo: 'editor', inicial: c })} />;
  }
  const lista = d.datos ?? [];
  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Cotizaciones y pedidos</h1></div>
      <p className="tenue">Primero se cotiza; al aprobarla se reserva la piedra (o se ordena producir lo que falte); al cobrarla se factura.</p>
      <div className="eco-barra">
        <input placeholder="Buscar cliente…" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <select value={filtro} onChange={(e) => setFiltro(e.target.value)}>{ESTADOS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>
        {vende && <button className="btn primario" onClick={() => setVista({ tipo: 'editor', inicial: null })}>+ Nueva cotización</button>}
      </div>
      <ErrorCaja error={d.error} />
      {d.cargando && !d.datos ? <Cargando /> : (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>#</th><th>Cliente / proyecto</th><th>Estado</th><th className="der">Total</th><th className="der">Cobrado</th><th>Vigencia / entrega</th><th></th></tr></thead>
          <tbody>
            {lista.map((c) => (
              <tr key={c.id}>
                <td className="num">{c.numero}</td>
                <td><b>{c.nombre_cliente}</b>{c.proyecto && <span className="eco-sub">{c.proyecto}</span>}</td>
                <td><Estado c={c} />{c.venta?.numero_factura && <span className="eco-sub num">{c.venta.numero_factura}</span>}</td>
                <td className="der num">{lempiras(c.total)}</td>
                <td className="der num">{c.pagado > 0 ? lempiras(c.pagado) : '—'}</td>
                <td>{['borrador', 'enviada'].includes(c.estado) ? `vence ${fechaCorta(c.fecha_vigencia)}` : c.fecha_entrega ? `entrega ${fechaCorta(c.fecha_entrega)}` : '—'}</td>
                <td><button className="btn chico" onClick={() => setVista({ tipo: 'detalle', id: c.id })}>Abrir</button></td>
              </tr>
            ))}
            {!lista.length && <tr><td colSpan={7} className="centro tenue" style={{ padding: 30 }}>Sin cotizaciones</td></tr>}
          </tbody>
        </table></div></div>
      )}
    </div>
  );
}

function Detalle({ id, aviso, onAviso, onVolver, onEditar }) {
  const { puede, contexto } = useSesion();
  const avisar = useAviso();
  const [ejecutar, ocupado] = useAccion();
  const [plan, setPlan] = useState(null);
  const [pago, setPago] = useState({ forma_pago_id: '', monto: '', referencia: '' });
  const [sinStock, setSinStock] = useState(null);   // faltantes pendientes de confirmar
  const d = useDatos(async () => {
    const [c, formas] = await Promise.all([get(`/eco/cotizaciones/${id}`), get('/eco/formas-pago')]);
    setPago((p) => ({ ...p, forma_pago_id: p.forma_pago_id || formas.find((f) => f.tipo === 'efectivo')?.id || formas[0]?.id, monto: c.pendiente > 0 ? c.pendiente : '' }));
    return { c, formas };
  }, [id]);
  const vende = puede('cotizaciones:ver'), cobra = puede('pos:vender') || vende, gerencia = puede('pos:anular');
  if (!d.datos) return d.error ? <div className="pagina"><ErrorCaja error={d.error} /></div> : <Cargando />;
  const { c, formas } = d.datos;
  const abierta = ['borrador', 'enviada'].includes(c.estado);

  const hacer = async (fn, mensaje) => {
    const r = await ejecutar(fn);
    if (r && r !== true) onAviso(typeof mensaje === 'function' ? mensaje(r) : mensaje);
    else if (r === true && mensaje && typeof mensaje === 'string') onAviso(mensaje);
    if (r) d.recargar();
    return r;
  };
  const imprimirFactura = (r) => imprimirTicket(r.factura.id).catch(() => { /* la impresión no bloquea */ });
  const textoFactura = (x) => `Factura ${x.factura.numero_factura} emitida.${x.factura.aviso_rtn ? ` ⚠ ${x.factura.aviso_rtn}` : ''}${x.factura.faltantes_inventario?.length ? ' ⚠ Se facturó sin existencia suficiente.' : ''}`;

  // Factura; si falta piedra pide confirmación (SIN_STOCK) y reintenta confirmada.
  const facturar = async (confirmar = false) => {
    try {
      const x = await post(`/eco/cotizaciones/${c.id}/facturar`, confirmar ? { confirmar_sin_stock: true } : {});
      onAviso(textoFactura(x)); d.recargar(); imprimirFactura(x);
      return x;
    } catch (e) {
      if (e.codigo === 'SIN_STOCK') { setSinStock({ faltantes: e.faltantes ?? [] }); return null; }
      avisar(e.message, 'mal'); d.recargar(); return null;
    }
  };
  const registrarPago = async () => {
    const pagaTodo = Number(pago.monto) >= c.pendiente - 0.004;
    const r = await ejecutar(() => post(`/eco/cotizaciones/${c.id}/pagos`, { ...pago, monto: Number(pago.monto) }));
    if (!r) return;
    d.recargar();
    if (pagaTodo) await facturar(); else onAviso('Pago parcial registrado');
  };
  const verDocumento = async () => {
    const datos = await ejecutar(() => get(`/eco/cotizaciones/${c.id}/documento`));
    if (datos && datos !== true && !abrirDocumento(datos)) avisar('El navegador bloqueó la ventana. Permite las ventanas emergentes para imprimir.', 'mal');
  };
  const enviar = async () => {
    const r = await ejecutar(() => post(`/eco/cotizaciones/${c.id}/enviar`, {}));
    if (!r || r === true) return;
    if (r.enviado) { onAviso('Enviada por correo'); d.recargar(); return; }
    // El servidor aún no envía correo: se abre el del usuario con el mensaje listo y la cotización queda «enviada».
    avisar(`No se pudo enviar automáticamente: ${r.motivo}. Abrí tu correo: adjunta el PDF (Imprimir → Guardar como PDF).`, 'mal');
    if (c.email) { await post(`/eco/cotizaciones/${c.id}/enviar`, { solo_marcar: true }).catch(() => {}); window.location.href = enlaceCorreo(c, contexto?.empresa?.nombre ?? 'EcoStone'); d.recargar(); }
  };
  const motivo = (texto, ruta, ok) => { const m = window.prompt(texto); if (m) hacer(() => post(`/eco/cotizaciones/${c.id}/${ruta}`, { motivo: m }), ok); };

  return (
    <div className="pagina">
      {aviso && <div className="aviso-caja ok" onClick={() => onAviso('')}>{aviso}</div>}
      <div className="encabezado-pagina">
        <h1>Cotización #{c.numero} <Estado c={c} /></h1>
        <button className="btn" onClick={onVolver}>← Volver</button>
      </div>
      <div className="tarjeta">
        <p style={{ margin: '0 0 6px' }}><b>{c.nombre_cliente}</b>{c.rtn_cliente && ` · RTN ${c.rtn_cliente}`}{c.telefono && ` · ${c.telefono}`}{c.email && ` · ${c.email}`}</p>
        <p style={{ margin: '0 0 8px' }}>{c.proyecto && <><b>{c.proyecto}</b>{c.direccion_obra && ` — ${c.direccion_obra}`} · </>}{c.isv_incluido ? 'Precios con ISV incluido' : 'Precios + ISV'}{c.lista_nombre && ` · lista ${c.lista_nombre}`}{c.fecha_entrega && ` · entrega ${fechaCorta(c.fecha_entrega)}`} · vigencia {fechaCorta(c.fecha_vigencia)}</p>
        <div className="eco-barra">
          <button className="btn" onClick={verDocumento}>Ver PDF</button>
          {abierta && vende && <button className="btn" onClick={() => onEditar(c)}>Editar</button>}
          {abierta && vende && <button className="btn" disabled={ocupado} onClick={enviar}>Enviar por correo</button>}
          {abierta && vende && !c.vencida && <button className="btn primario" disabled={ocupado} onClick={async () => { const r = await hacer(() => post(`/eco/cotizaciones/${c.id}/aprobar`, {}), 'Cotización aprobada'); if (r && r !== true) setPlan(r.plan); }}>✔ Aprobar</button>}
          {abierta && vende && <button className="btn peligro" onClick={() => motivo('Motivo del rechazo (ej.: precio, eligió a otro proveedor):', 'rechazar', 'Cotización rechazada')}>Rechazar</button>}
          {c.estado === 'aprobada' && gerencia && <button className="btn peligro" onClick={() => motivo('Motivo de la anulación:', 'anular', 'Cotización anulada; reservas liberadas')}>Anular</button>}
        </div>
        {c.vencida && <div className="aviso-caja mal">Está vencida. Entra a Editar y guarda para renovar la vigencia y los precios.</div>}
      </div>

      {plan && (
        <div className="tarjeta">
          <h2>Qué pasó al aprobar</h2>
          {plan.reservado.length > 0 && <p>📦 Reservado de bodega: {plan.reservado.map((r) => `${num(r.m2, 2)} m² de ${r.producto} (lote ${r.lote})`).join('; ')}.</p>}
          {plan.ordenes.length > 0 && <p>🏭 Órdenes de producción creadas: {plan.ordenes.map((o) => `${o.lote} — ${num(o.m2, 2)} m² de ${o.producto}, colada el ${fechaCorta(o.fecha_programada)}`).join('; ')}.</p>}
          {plan.pendientes.length > 0 && <div className="aviso-caja mal">Falta producir pero no se pudo crear la orden: {plan.pendientes.map((p) => `${p.producto} (${num(p.m2, 2)} m²): ${p.motivo}`).join('; ')}</div>}
          {!plan.reservado.length && !plan.ordenes.length && !plan.pendientes.length && <p>Sin piedra que reservar en esta cotización.</p>}
        </div>
      )}

      <div className="tarjeta pad0"><div className="tabla-wrap"><table>
        <thead><tr><th>Concepto</th><th className="der">Cantidad</th><th className="der">Precio</th><th className="der">Importe</th></tr></thead>
        <tbody>{c.lineas.map((l) => (
          <tr key={l.id}>
            <td>{l.descripcion}{l.m2_neto != null && l.cajas != null && <span className="eco-sub">{num(l.m2_neto, 2)} m² → {num(l.cajas, 0)} cajas completas</span>}</td>
            <td className="der num">{num(l.cantidad, 3)} {l.unidad}</td><td className="der num">{lempiras(l.precio_unitario)}</td><td className="der num">{lempiras(l.monto)}</td>
          </tr>))}</tbody>
      </table></div></div>
      <div className="eco-totales" style={{ margin: '10px 4px' }}>
        {Number(c.descuento) > 0 && <div>Descuento {Number(c.descuento_pct) > 0 ? `${num(c.descuento_pct, 2)}%` : ''}: −{lempiras(c.descuento)}</div>}
        <div>Subtotal {lempiras(c.subtotal)} · ISV {lempiras(c.isv)}</div>
        <div className="gran">Total {lempiras(c.total)}</div>
        {c.margen_pct != null && <small>Costo {lempiras(c.costo)} · margen {num(c.margen_pct, 1)}%</small>}
      </div>

      {(c.reservas?.length > 0 || c.ordenes?.length > 0) && (
        <div className="tarjeta">
          <h2>Producción y existencias de este pedido</h2>
          {c.reservas.map((r, i) => <p key={i} style={{ margin: '4px 0' }}>📦 Reservado: {num(r.m2, 2)} m² de {r.producto} (lote {r.lote})</p>)}
          {c.ordenes.map((o) => <p key={o.id} style={{ margin: '4px 0' }}>🏭 {o.lote}: {num(o.m2_planificado, 2)} m² de {o.producto} — <span className={`chip ${o.estado === 'terminada' ? 'ok' : o.estado === 'curando' ? 'aviso' : ''}`}>{{ planificada: 'por iniciar', curando: 'en secado', terminada: 'lista para vender' }[o.estado] ?? o.estado}</span> {o.estado === 'planificada' ? `colada ${fechaCorta(o.fecha_programada)}` : o.estado === 'curando' && o.fecha_disponible ? `lista para vender el ${fechaCorta(o.fecha_disponible)}` : ''}</p>)}
        </div>
      )}

      {['aprobada', 'facturada'].includes(c.estado) && (
        <div className="tarjeta">
          <h2>Cobro {c.estado === 'aprobada' && Number(c.anticipo_pct) > 0 && <small>· anticipo pactado {num(c.anticipo_pct, 0)}% = {lempiras(c.anticipo_monto)}</small>}</h2>
          <div className="tabla-wrap"><table><tbody>
            {c.pagos.map((p) => <tr key={p.id}><td>{fechaCorta(p.created_at)}</td><td>{p.tipo}</td><td>{p.forma}{p.referencia && ` · ${p.referencia}`}</td><td className="der num">{lempiras(p.monto)}</td><td>{p.usuario}</td></tr>)}
            {!c.pagos.length && <tr><td className="tenue">Sin pagos todavía</td></tr>}
          </tbody></table></div>
          <p><b>Cobrado {lempiras(c.pagado)}</b> de {lempiras(c.total)} · pendiente {lempiras(c.pendiente)}</p>
          {c.estado === 'aprobada' && cobra && c.pendiente > 0 && (
            <div className="eco-form">
              <Campo etiqueta="Forma de pago"><select value={pago.forma_pago_id} onChange={(e) => setPago({ ...pago, forma_pago_id: e.target.value })}>{formas.map((f) => <option key={f.id} value={f.id}>{f.nombre}</option>)}</select></Campo>
              <Campo etiqueta="Monto"><input type="number" step="0.01" value={pago.monto} onChange={(e) => setPago({ ...pago, monto: e.target.value })} /></Campo>
              <Campo etiqueta="Referencia (voucher / transferencia)"><input value={pago.referencia} onChange={(e) => setPago({ ...pago, referencia: e.target.value })} /></Campo>
              <button className="btn primario eco-cobrar ancho" disabled={ocupado || !(Number(pago.monto) > 0)} onClick={registrarPago}>
                {ocupado ? 'Procesando…' : Number(pago.monto) >= c.pendiente - 0.004 ? `🧾 REGISTRAR PAGO Y GENERAR FACTURA · ${lempiras(Number(pago.monto))}` : `Registrar pago parcial · ${lempiras(Number(pago.monto) || 0)}`}
              </button>
            </div>
          )}
          {c.estado === 'aprobada' && cobra && c.pendiente <= 0.004 && c.pagos.length > 0 && <button className="btn primario eco-cobrar" disabled={ocupado} onClick={() => facturar()}>🧾 GENERAR FACTURA</button>}
          {c.estado === 'facturada' && c.venta_id && (
            <div className="eco-barra">
              <span className="chip ok">Factura {c.venta?.numero_factura}</span>
              <button className="btn chico" onClick={() => imprimirTicket(c.venta_id, { reimpresion: true, razon: 'Reimpresión desde la cotización' }).catch((e) => avisar(e.message, 'mal'))}>Reimprimir ticket</button>
              <button className="btn chico" onClick={() => verPdf(c.venta_id).catch((e) => avisar(e.message, 'mal'))}>Factura PDF</button>
            </div>
          )}
        </div>
      )}
      {sinStock && <AvisoSinStock faltantes={sinStock.faltantes} onCancelar={() => setSinStock(null)} onContinuar={() => { setSinStock(null); facturar(true); }} />}
    </div>
  );
}
