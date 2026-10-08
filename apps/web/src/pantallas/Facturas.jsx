import { useEffect, useMemo, useRef, useState } from 'react';
import { MOTIVOS_ANULACION, MOTIVOS_REIMPRESION, fechaHN, fechaHoraHN, lempiras, sumarDias } from '@grupo/shared';
import { get, post, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Modal, Vacio, descargarCsv, useAccion, useAviso } from '../ui/kit.jsx';
import Icono from '../ui/Icono.jsx';
import MotivoModal from '../pos/MotivoModal.jsx';
import { colorSucursal } from '../lib/coloresSucursal.js';
import { descargarPdf, imprimirTicket, verPdf } from '../lib/documentos.js';
import { registrarEvento } from '../lib/eventos.js';
import { useCambiosVentas } from '../lib/enVivo.js';
import '../pos/pos.css';

const claseForma = (tipo) => (['efectivo', 'tarjeta', 'transferencia'].includes(tipo) ? tipo : '');

function ChipsPago({ pagos }) {
  if (!pagos?.length) return <span className="tenue">—</span>;
  // Una forma puede aparecer dos veces (ej. dos pagos en efectivo): se juntan.
  const juntos = [...pagos.reduce((m, p) => m.set(p.forma, { ...p, monto: (m.get(p.forma)?.monto ?? 0) + Number(p.monto) }), new Map()).values()];
  return (
    <span>
      {juntos.map((p) => <span key={p.forma} className={`chip-pago ${claseForma(p.tipo)}`} title={lempiras(p.monto)}>{p.forma}{juntos.length > 1 && ` ${lempiras(p.monto).replace('.00', '')}`}</span>)}
    </span>
  );
}

const PRESETS = () => {
  const hoy = fechaHN();
  return [['Hoy', hoy, hoy], ['Ayer', sumarDias(hoy, -1), sumarDias(hoy, -1)], ['7 días', sumarDias(hoy, -6), hoy], ['Este mes', `${hoy.slice(0, 8)}01`, hoy]];
};

export default function Facturas() {
  const { sucursales, sucursal, puede, contexto } = useSesion();
  const avisar = useAviso();
  const [filtros, setFiltros] = useState({ sucursal_id: '', desde: '', hasta: '', q: '' });
  const [cajero, setCajero] = useState('');
  const [forma, setForma] = useState('');
  const [soloAnuladas, setSoloAnuladas] = useState(false);
  const [lista, setLista] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [detalleId, setDetalleId] = useState(null);
  const filtrosRef = useRef(filtros); filtrosRef.current = filtros;

  const buscar = async ({ silencioso = false, evento = false } = {}) => {
    const f = filtrosRef.current;
    if (!silencioso) setCargando(true);
    try {
      if (evento && (f.q || f.desde)) registrarEvento('factura.buscar', { q: f.q, desde: f.desde, hasta: f.hasta });
      setLista(await get(`/pos/ventas${qs({ estado: 'facturadas', desde: f.desde, hasta: f.hasta, sucursal_id: f.sucursal_id, q: f.q, limite: 200 })}`));
      setError('');
    } catch (e) { setError(e.message); } finally { setCargando(false); }
  };
  useEffect(() => { buscar(); }, [filtros.sucursal_id, filtros.desde, filtros.hasta]); // eslint-disable-line react-hooks/exhaustive-deps
  // Una factura emitida o anulada en cualquier caja aparece sola, con los mismos filtros puestos.
  useCambiosVentas(filtros.sucursal_id || undefined, () => buscar({ silencioso: true }), { cada: 8000 });

  const cajeros = useMemo(() => [...new Set(lista.map((f) => f.cajero).filter(Boolean))].sort(), [lista]);
  const formas = useMemo(() => [...new Set(lista.flatMap((f) => f.pagos.map((p) => p.forma)))].sort(), [lista]);
  const visibles = useMemo(() => lista.filter((f) => (!cajero || f.cajero === cajero) && (!soloAnuladas || f.estado === 'anulada') && (!forma || f.pagos.some((p) => p.forma === forma))), [lista, cajero, soloAnuladas, forma]);
  const vigentes = visibles.filter((f) => f.estado !== 'anulada');
  const totalVisible = vigentes.reduce((s, f) => s + Number(f.total), 0);
  const porForma = useMemo(() => {
    const t = new Map();
    for (const f of vigentes) for (const p of f.pagos) t.set(p.forma, { tipo: p.tipo, monto: (t.get(p.forma)?.monto ?? 0) + Number(p.monto) });
    return [...t.entries()];
  }, [vigentes]);

  const csv = () => descargarCsv(`facturas-${fechaHN()}.csv`, visibles.map((f) => ({
    orden: f.ticket_dia, fecha: f.fecha_emision ? fechaHoraHN(f.fecha_emision) : '', factura: f.numero_factura, sucursal: f.sucursal, cliente: f.es_consumidor_final ? 'Consumidor Final' : f.cliente, rtn: f.cliente_rtn ?? '',
    isv: Number(f.isv_total).toFixed(2), total: Number(f.total).toFixed(2), pago: f.pagos.map((p) => `${p.forma} ${Number(p.monto).toFixed(2)}`).join(' + '), cajero: f.cajero ?? '', estado: f.estado === 'anulada' ? 'Anulada' : 'Vigente',
  })), [['orden', 'No. Orden'], ['fecha', 'Fecha'], ['factura', 'No. Factura'], ['sucursal', 'Sucursal'], ['cliente', 'Cliente'], ['rtn', 'RTN'], ['isv', 'Impuesto'], ['total', 'Total'], ['pago', 'Forma de pago'], ['cajero', 'Cajero'], ['estado', 'Estado']]);

  const poner = (cambios) => setFiltros((f) => ({ ...f, ...cambios }));

  return (
    <div className="pagina">
      <div className="encabezado-pagina">
        <h1>Facturas</h1>
        <button className="btn chico" onClick={csv} disabled={visibles.length === 0}><Icono n="descargar" tam={15} /> Exportar CSV</button>
      </div>

      <div className="tarjeta" style={{ display: 'grid', gap: 10 }}>
        <div className="fac-filtros">
          {sucursales.length > 1 && (
            <Campo etiqueta="Sucursal"><select value={filtros.sucursal_id} onChange={(e) => poner({ sucursal_id: e.target.value })}><option value="">Todas las sucursales</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select></Campo>
          )}
          <Campo etiqueta="Desde"><input type="date" value={filtros.desde} onChange={(e) => poner({ desde: e.target.value })} /></Campo>
          <Campo etiqueta="Hasta"><input type="date" value={filtros.hasta} onChange={(e) => poner({ hasta: e.target.value })} /></Campo>
          <Campo etiqueta="Buscar"><input placeholder="No. de factura, cliente o RTN" value={filtros.q} onChange={(e) => poner({ q: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && buscar({ evento: true })} /></Campo>
          {cajeros.length > 1 && <Campo etiqueta="Cajero"><select value={cajero} onChange={(e) => setCajero(e.target.value)}><option value="">Todos los cajeros</option>{cajeros.map((c) => <option key={c}>{c}</option>)}</select></Campo>}
          <Campo etiqueta="Forma de pago"><select value={forma} onChange={(e) => setForma(e.target.value)}><option value="">Todas</option>{formas.map((c) => <option key={c}>{c}</option>)}</select></Campo>
        </div>
        <div className="fila">
          <button className="btn primario" onClick={() => buscar({ evento: true })}>Buscar</button>
          {PRESETS().map(([n, d, h]) => <button key={n} className="btn chico" onClick={() => poner({ desde: d, hasta: h })}>{n}</button>)}
          <button className="btn chico fantasma" onClick={() => { setFiltros({ sucursal_id: '', desde: '', hasta: '', q: '' }); setCajero(''); setForma(''); setSoloAnuladas(false); setTimeout(buscar, 0); }}>Limpiar</button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexDirection: 'row' }}><input type="checkbox" checked={soloAnuladas} onChange={(e) => setSoloAnuladas(e.target.checked)} /> Solo anuladas</label>
        </div>
      </div>

      {error && <div className="aviso-caja mal">{error}</div>}
      {lista.length >= 200 && <div className="aviso-caja">Se muestran las últimas 200 facturas: acota las fechas o la sucursal para ver el resto.</div>}

      <div className="fila" style={{ gap: 8 }}>
        <b>{visibles.length} factura{visibles.length === 1 ? '' : 's'}</b>
        <span className="tenue">· Total <b className="num" style={{ color: 'var(--texto)' }}>{lempiras(totalVisible)}</b></span>
        {porForma.map(([nombre, v]) => <span key={nombre} className={`chip-pago ${claseForma(v.tipo)}`}>{nombre} {lempiras(v.monto)}</span>)}
      </div>

      <div className="tarjeta pad0"><div className="tabla-wrap"><table>
        <thead><tr><th></th><th>Orden</th><th>Fecha</th><th>Factura</th><th>Cliente</th><th>RTN</th><th className="der">Impuesto</th><th className="der">Total</th><th>Pago</th><th>Cajero</th></tr></thead>
        <tbody>{visibles.map((f) => (
          <tr key={f.id} className={`clic${f.estado === 'anulada' ? ' fac-anulada' : ''}`} onClick={() => { setDetalleId(f.id); registrarEvento('factura.ver', { factura: f.numero_factura, total: Number(f.total) }, f.sucursal_id); }}>
            <td><span className="fac-punto" style={{ background: colorSucursal(sucursales, f.sucursal_id) }} title={f.sucursal} /></td>
            <td className="num">#{f.ticket_dia}</td>
            <td>{f.fecha_emision ? fechaHoraHN(f.fecha_emision) : '—'}</td>
            <td className="num">{f.numero_factura}{f.es_borrador_fiscal && <span className="chip aviso" style={{ marginLeft: 6 }}>Borrador</span>}</td>
            <td>{f.es_consumidor_final ? 'Consumidor Final' : f.cliente}</td>
            <td className="num">{f.cliente_rtn ?? '—'}</td>
            <td className="der num">{lempiras(f.isv_total)}</td>
            <td className="der num"><b>{lempiras(f.total)}</b>{f.estado !== 'anulada' && Number(f.acreditado) > 0 && <div><span className="chip aviso">Acreditado {lempiras(f.acreditado)}</span></div>}</td>
            <td>{f.estado === 'anulada' ? <span className="chip mal" style={{ textDecoration: 'none' }}>Anulada</span> : <ChipsPago pagos={f.pagos} />}</td>
            <td>{f.cajero ?? '—'}</td>
          </tr>))}</tbody>
      </table>{!cargando && visibles.length === 0 && <Vacio>No hay facturas con estos filtros.</Vacio>}{cargando && lista.length === 0 && <Vacio>Cargando…</Vacio>}</div></div>

      {detalleId && <DetalleFactura id={detalleId} sucursales={sucursales} puede={puede} empresa={contexto.empresa} sucursalActual={sucursal} avisar={avisar} onCerrar={() => setDetalleId(null)} onCambio={() => buscar({ silencioso: true })} />}
    </div>
  );
}

function DetalleFactura({ id, sucursales, puede, avisar, onCerrar, onCambio }) {
  const [v, setV] = useState(null);
  const [error, setError] = useState('');
  const [motivo, setMotivo] = useState(null);          // 'reimprimir' | 'anular'
  const { modulos } = useSesion();
  const fabrica = modulos.some((m) => m.id === 'prod_inventario');   // EcoStone: una factura emitida solo se reimprime o se anula completa (sin notas de crédito parciales)
  const [nc, setNc] = useState(null);                  // {motivo, monto}
  const [ejecutar, ocupado] = useAccion();

  const cargar = async () => { try { setV(await get(`/pos/ventas/${id}`)); } catch (e) { setError(e.message); } };
  useEffect(() => { cargar(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <Modal titulo="Factura" onCerrar={onCerrar}><div className="aviso-caja mal">{error}</div></Modal>;
  if (!v) return <Modal titulo="Factura" onCerrar={onCerrar}><Vacio>Cargando…</Vacio></Modal>;

  const acreditado = v.notas_credito.reduce((s, n) => s + Number(n.monto), 0);
  const restante = Math.round((Number(v.total) - acreditado) * 100) / 100;
  const vigente = v.estado === 'pagada';
  const reimprimir = (razon) => ejecutar(async () => { await imprimirTicket(v.id, { reimpresion: true, razon }); setMotivo(null); await cargar(); }, 'Ticket enviado a la impresora');
  const imprimirOriginal = () => ejecutar(async () => { const copia = await imprimirTicket(v.id); await cargar(); return copia; });
  const anular = (razon) => ejecutar(async () => { await post(`/pos/ventas/${v.id}/anular`, { motivo: razon }); setMotivo(null); await cargar(); onCambio(); }, 'Factura anulada');
  const emitirNc = async () => {
    const r = await ejecutar(() => post(`/pos/ventas/${v.id}/nota-credito`, { motivo: nc.motivo, monto: Number(nc.monto) }), 'Nota de crédito emitida');
    if (r) { setNc(null); await cargar(); onCambio(); }
  };

  return (
    <>
      <Modal titulo={v.numero_factura ?? `Orden #${v.ticket_dia}`} onCerrar={onCerrar} tam="ancho">
        {v.es_borrador_fiscal && <div className="aviso-caja">Sin validez fiscal: el CAI estaba pendiente cuando se emitió.</div>}
        {v.estado === 'anulada' && <div className="aviso-caja mal">Factura anulada{v.motivo_anulacion ? `: ${v.motivo_anulacion}` : ''}{v.anulada_at ? ` · ${fechaHoraHN(v.anulada_at)}` : ''}</div>}
        <div className="fila espacio">
          <div>
            <b>{v.cliente?.es_consumidor_final ? 'Consumidor Final' : v.cliente?.nombre}</b>{v.cliente?.rtn && <span className="tenue"> · RTN {v.cliente.rtn}</span>}
            <div className="tenue">{v.sucursal?.nombre} · <span className="fac-punto" style={{ background: colorSucursal(sucursales, v.sucursal_id) }} /> · Atendió {v.cajero?.nombre ?? '—'} · {v.fecha_emision ? fechaHoraHN(v.fecha_emision) : ''}</div>
          </div>
          <div className="tenue">Impresiones: {v.impresiones}{v.reimpresiones > 0 && ` (${v.reimpresiones} copia${v.reimpresiones === 1 ? '' : 's'})`}</div>
        </div>

        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Producto</th><th className="der">Cant.</th><th className="der">Precio</th><th className="der">Monto</th></tr></thead>
          <tbody>{v.lineas.map((l) => (
            <tr key={l.id}>
              <td>{l.nombre_producto}{(l.opciones ?? []).map((o) => <small key={o.id} className="tenue" style={{ display: 'block' }}>+ {o.nombre}</small>)}
                {l.notas && <small style={{ display: 'block', color: 'var(--aviso)' }}>“{l.notas}”</small>}
                {Number(l.descuento) > 0 && <small style={{ display: 'block', color: 'var(--ok)' }}>Descuento {Number(l.descuento_porcentaje) || ''}%{Number(l.descuento_porcentaje) === 25 ? ' 3ª edad' : ''}: −{lempiras(l.descuento)}</small>}</td>
              <td className="der num">{Number(l.cantidad)}</td><td className="der num">{lempiras(l.precio_unitario)}</td><td className="der num">{lempiras(Number(l.cantidad) * Number(l.precio_unitario))}</td>
            </tr>))}</tbody>
        </table></div></div>

        <div style={{ display: 'grid', gap: 3, justifyItems: 'end' }}>
          {Number(v.descuento) > 0 && <div className="fila"><span className="tenue">Descuentos (por producto)</span><b className="num">−{lempiras(v.descuento)}</b></div>}
          {Number(v.subtotal_exento) > 0 && <div className="fila"><span className="tenue">Importe exento</span><span className="num">{lempiras(v.subtotal_exento)}</span></div>}
          {Number(v.subtotal_exonerado) > 0 && <div className="fila"><span className="tenue">Importe exonerado</span><span className="num">{lempiras(v.subtotal_exonerado)}</span></div>}
          <div className="fila"><span className="tenue">Gravado</span><span className="num">{lempiras(Number(v.subtotal_gravado_15) + Number(v.subtotal_gravado_18))}</span></div>
          <div className="fila"><span className="tenue">ISV</span><span className="num">{lempiras(v.isv_total)}</span></div>
          <div className="fila"><b className="titulo">Total</b><b className="num" style={{ fontSize: '1.4rem' }}>{lempiras(v.total)}</b></div>
          <div className="fila"><span className="tenue">Pagado con</span><ChipsPago pagos={v.pagos} /></div>
          {v.cambio > 0 && <div className="fila"><span className="tenue">Cambio entregado</span><span className="num">{lempiras(v.cambio)}</span></div>}
          {v.tercera_edad_identidad && <small className="tenue">Descuento 3ª edad: {v.tercera_edad_nombre} · ID {v.tercera_edad_identidad}</small>}
        </div>

        <div className="fila">
          {puede('pos:reimprimir') || v.impresiones === 0
            ? <button className="btn" disabled={ocupado} onClick={() => (v.impresiones > 0 ? setMotivo('reimprimir') : imprimirOriginal())}><Icono n="impresora" tam={16} /> {v.impresiones > 0 ? 'Reimprimir ticket' : 'Imprimir ticket'}</button> : null}
          <button className="btn" onClick={() => verPdf(v.id).catch((e) => avisar(e.message, 'mal'))}>Ver PDF</button>
          <button className="btn" onClick={() => descargarPdf(v.id, `factura-${v.numero_factura}.pdf`).catch((e) => avisar(e.message, 'mal'))}>Descargar PDF</button>
        </div>

        {v.notas_credito.length > 0 && (
          <div style={{ borderTop: '1px solid var(--borde)', paddingTop: 10, display: 'grid', gap: 4 }}>
            <b className="tenue" style={{ fontSize: '.85rem' }}>Notas de crédito emitidas</b>
            {v.notas_credito.map((n) => <div key={n.id} className="fila espacio"><span><span className="num">{n.numero_nota}</span> · {n.motivo} <small className="tenue">{fechaHoraHN(n.created_at)}</small></span><b className="num">{lempiras(n.monto)}</b></div>)}
          </div>
        )}

        {vigente && puede('pos:anular') && (
          <div style={{ borderTop: '1px solid var(--borde)', paddingTop: 10, display: 'grid', gap: 10 }}>
            {!nc ? (
              <div className="fila">
                {!fabrica && <button className="btn" disabled={restante <= 0} onClick={() => setNc({ motivo: '', monto: String(restante) })}>Nota de crédito{restante <= 0 ? ' (ya acreditada)' : ''}</button>}
                <button className="btn peligro" onClick={() => setMotivo('anular')}>Anular factura</button>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                <Campo etiqueta="Motivo de la nota de crédito"><input autoFocus value={nc.motivo} onChange={(e) => setNc({ ...nc, motivo: e.target.value })} placeholder="Ej.: devolución de un jugo en mal estado" /></Campo>
                <Campo etiqueta={`Monto a acreditar (máximo ${lempiras(restante)})`} ayuda="Parcial o total. La factura queda como está; la nota de crédito es un documento aparte que la referencia."><input inputMode="decimal" value={nc.monto} onChange={(e) => setNc({ ...nc, monto: e.target.value.replace(/[^\d.]/g, '') })} /></Campo>
                <div className="fila"><button className="btn peligro" disabled={ocupado || nc.motivo.trim().length < 3 || !(Number(nc.monto) > 0) || Number(nc.monto) > restante + 0.001} onClick={emitirNc}>Emitir nota de crédito</button><button className="btn fantasma" onClick={() => setNc(null)}>Cancelar</button></div>
              </div>
            )}
            <small className="tenue">{fabrica ? 'Una factura emitida no se modifica: solo se puede reimprimir o anular. Al anular conserva su número y la piedra regresa al inventario.' : 'Anular deja la factura marcada como anulada (con motivo y usuario), no reutiliza el correlativo y devuelve el inventario. La nota de crédito acredita dinero sin anular.'}</small>
          </div>
        )}
      </Modal>
      {motivo === 'reimprimir' && <MotivoModal titulo="Reimprimir ticket" texto="Saldrá marcado como COPIA. Indica el motivo (queda en la bitácora)." opciones={MOTIVOS_REIMPRESION} etiquetaBoton="Reimprimir" ocupado={ocupado} onCerrar={() => setMotivo(null)} onListo={reimprimir} />}
      {motivo === 'anular' && <MotivoModal titulo="Anular factura" texto={`Se anulará ${v.numero_factura} por ${lempiras(v.total)}. Esto no se puede deshacer.`} opciones={MOTIVOS_ANULACION} etiquetaBoton="Anular factura" peligro ocupado={ocupado} onCerrar={() => setMotivo(null)} onListo={anular} />}
    </>
  );
}
