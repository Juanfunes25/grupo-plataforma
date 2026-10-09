import { useEffect, useState } from 'react';
import { lempiras, numero } from '@grupo/shared';
import { get, post, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, useAccion } from '../ui/kit.jsx';
import CotizacionEditor from '../diserco/CotizacionEditor.jsx';
import AvisoSinStock from '../diserco/AvisoSinStock.jsx';
import { abrirVentana, escribirDocumento } from '../diserco/documento.js';
import { aBase64, descargarArchivo } from '../diserco/archivos.js';
import { imprimirTicket, verPdf } from '../lib/documentos.js';
import EnviarCorreo from '../mensajeria/EnviarCorreo.jsx';
import '../diserco/diserco.css';

const ESTADOS = [['', 'Todas'], ['borrador,enviada', 'Por aprobar'], ['aprobada', 'Aprobadas (por cobrar)'], ['facturada', 'Cobradas y facturadas'], ['rechazada,anulada', 'Cerradas']];
const TONO = { borrador: '', enviada: '', aprobada: 'aviso', facturada: 'ok', rechazada: 'mal', anulada: 'mal', vencida: 'mal' };
const TIPOS = { proyecto: 'Proyecto', productos: 'Productos' };
const fechaCorta = (f) => (f ? new Date(`${String(f).slice(0, 10)}T12:00:00`).toLocaleDateString('es-HN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const Etq = ({ c }) => <span className={`chip ${TONO[c.vencida ? 'vencida' : c.estado]}`}>{c.vencida ? 'vencida' : c.estado}</span>;

// DISERCO: cotizar (Proyecto o Productos) → aprobar → cobrar y facturar (una factura por cada cobro).
export default function CotizacionesDis() {
  const { puede } = useSesion();
  const [lista, setLista] = useState([]);
  const [filtro, setFiltro] = useState('');
  const [tipoFiltro, setTipoFiltro] = useState('');
  const [busca, setBusca] = useState('');
  const [vista, setVista] = useState({ tipo: 'lista' });
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');
  const [importando, setImportando] = useState(false);
  const vende = puede('cotizaciones:ver');

  async function cargar() { setLista(await get(`/diserco/cotizaciones${qs({ estado: filtro, tipo: tipoFiltro, q: busca })}`)); }
  useEffect(() => { cargar().catch((e) => setError(e.message)); }, [filtro, tipoFiltro, busca]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sube uno o varios Excel: cada uno se lee y queda guardado como borrador (con el archivo original).
  async function importar(archivos) {
    setImportando(true); setError(''); setAviso('');
    const hechas = []; const fallas = []; let ultima = null;
    for (const archivo of archivos) {
      try {
        const r = await post('/diserco/cotizaciones/importar-excel', { nombre: archivo.name, contenido: await aBase64(archivo) });
        ultima = r.cotizacion;
        hechas.push(`${r.cotizacion.codigo} (${r.cotizacion.nombre_cliente})${r.avisos?.length ? ` ⚠ ${r.avisos.join(' · ')}` : ''}`);
      } catch (e) { fallas.push(`${archivo.name}: ${e.message}`); }
    }
    setImportando(false);
    if (fallas.length) setError(`No se pudo importar:\n${fallas.join('\n')}`);
    if (hechas.length) setAviso(`Importadas ${hechas.length}: ${hechas.join(' | ')}. Quedaron como borrador: revísalas antes de enviar.`);
    if (hechas.length === 1 && !fallas.length) setVista({ tipo: 'detalle', id: ultima.id }); else cargar().catch(() => {});
  }

  if (vista.tipo === 'editor') {
    return <CotizacionEditor inicial={vista.inicial} tipo={vista.nuevoTipo} onCancelar={() => setVista(vista.inicial ? { tipo: 'detalle', id: vista.inicial.id } : { tipo: 'lista' })}
      onGuardada={(c) => { setAviso(`Cotización ${c.codigo} guardada`); setVista({ tipo: 'detalle', id: c.id }); }} />;
  }
  if (vista.tipo === 'detalle') {
    return <Detalle id={vista.id} aviso={aviso} onAviso={setAviso} onVolver={() => { setVista({ tipo: 'lista' }); cargar().catch(() => {}); }} onEditar={(c) => setVista({ tipo: 'editor', inicial: c })} />;
  }
  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Cotizaciones DISERCO</h1></div>
      {error && <div className="aviso-caja mal" style={{ whiteSpace: 'pre-line' }} onClick={() => setError('')}>{error}</div>}
      {aviso && <div className="aviso-caja ok" onClick={() => setAviso('')}>{aviso}</div>}
      <div className="tarjeta rejilla">
        <div className="dis-barra">
          <input type="search" className="busca" placeholder="Buscar cliente, proyecto o número…" value={busca} onChange={(e) => setBusca(e.target.value)} />
          <select value={filtro} onChange={(e) => setFiltro(e.target.value)} style={{ width: 'auto' }}>{ESTADOS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>
          <select value={tipoFiltro} onChange={(e) => setTipoFiltro(e.target.value)} style={{ width: 'auto' }}><option value="">Proyectos y productos</option><option value="proyecto">Solo proyectos</option><option value="productos">Solo productos</option></select>
        </div>
        {vende && (
          <div className="dis-barra">
            <button className="btn primario" onClick={() => setVista({ tipo: 'editor', inicial: null, nuevoTipo: 'proyecto' })}>+ Cotización de PROYECTO</button>
            <button className="btn primario" onClick={() => setVista({ tipo: 'editor', inicial: null, nuevoTipo: 'productos' })}>+ Cotización de PRODUCTOS</button>
            <label className="btn" style={{ cursor: importando ? 'wait' : 'pointer', opacity: importando ? 0.6 : 1 }}>
              {importando ? 'Importando…' : 'Importar desde Excel'}
              <input type="file" accept=".xlsx" multiple hidden disabled={importando} onChange={(e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) importar(f); }} />
            </label>
          </div>
        )}
        <div className="tabla-wrap">
          <table className="dis-tabla-ancha">
            <thead><tr><th>No.</th><th>Cliente / proyecto</th><th>Tipo</th><th>Estado</th><th className="der">Total</th><th className="der">Cobrado</th><th>Vigencia</th><th /></tr></thead>
            <tbody>
              {lista.map((c) => (
                <tr key={c.id} className="clic" onClick={() => setVista({ tipo: 'detalle', id: c.id })}>
                  <td><strong>{c.codigo}</strong></td>
                  <td><strong>{c.nombre_cliente}</strong>{c.proyecto && <small style={{ display: 'block' }}>{c.proyecto}</small>}</td>
                  <td>{TIPOS[c.tipo]}</td><td><Etq c={c} /></td>
                  <td className="der num">{lempiras(c.total)}</td><td className="der num">{c.pagado > 0 ? lempiras(c.pagado) : '—'}</td>
                  <td>{['borrador', 'enviada'].includes(c.estado) ? `vence ${fechaCorta(c.fecha_vigencia)}` : '—'}</td>
                  <td><button className="btn chico">Abrir</button></td>
                </tr>
              ))}
              {lista.length === 0 && <tr><td colSpan={8} className="vacio">Sin cotizaciones</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Detalle({ id, aviso, onAviso, onVolver, onEditar }) {
  const { puede } = useSesion();
  const [ejecutar, ocupado] = useAccion();
  const [c, setC] = useState(null);
  const [formas, setFormas] = useState([]);
  const [pago, setPago] = useState({ forma_pago_id: '', monto: '', referencia: '', concepto: '' });
  const [error, setError] = useState('');
  const [avisoStock, setAvisoStock] = useState(null);
  const [salidas, setSalidas] = useState([]);
  const [correoAbierto, setCorreoAbierto] = useState(false);
  const gerencia = puede('pos:anular');
  const vende = puede('cotizaciones:ver');
  const cobra = puede('pos:vender');
  const admin = puede('admin:empresa');

  async function cargar() {
    const [d, f] = await Promise.all([get(`/diserco/cotizaciones/${id}`), get('/diserco/formas-pago')]);
    setC(d); setFormas(f);
    if (d.tipo === 'proyecto' && admin) get(`/diserco/salidas?cotizacion_id=${d.id}`).then(setSalidas).catch(() => {});
    setPago((p) => ({ ...p, forma_pago_id: p.forma_pago_id || f.find((x) => x.tipo === 'efectivo')?.id || f[0]?.id, monto: d.pendiente > 0 ? String(d.pendiente) : '', concepto: '' }));
  }
  useEffect(() => { cargar().catch((e) => setError(e.message)); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function hacer(fn, mensaje) {
    setError('');
    const r = await ejecutar(fn);
    if (r) { if (mensaje) onAviso(typeof mensaje === 'function' ? mensaje(r) : mensaje); await cargar(); }
    return r;
  }
  async function cobrar(confirmar) {
    setError('');
    try {
      const r = await post(`/diserco/cotizaciones/${c.id}/cobros`, { ...pago, monto: Number(pago.monto), confirmar_sin_stock: confirmar });
      onAviso(`Pago registrado y factura ${r.factura.numero_factura} emitida.${r.factura.aviso_rtn ? ` Aviso: ${r.factura.aviso_rtn}` : ''}`);
      await cargar();
      try { await imprimirTicket(r.factura.id); } catch { /* la impresión no bloquea */ }
    } catch (e) {
      if (e.codigo === 'SIN_STOCK') setAvisoStock(e.faltantes ?? []); else setError(e.message);
    }
  }
  async function verDocumento() {
    const w = abrirVentana();
    try { escribirDocumento(w ?? window.open('', '_blank'), await get(`/diserco/cotizaciones/${c.id}/documento`)); } catch (e) { w?.close(); setError(e.message); }
  }
  const correo = () => setCorreoAbierto(true);
  const bajar = (ruta, nombre) => descargarArchivo(ruta, nombre).catch((e) => setError(e.message));

  if (!c) return <div className="pagina"><div className="tarjeta">{error ? <div className="aviso-caja mal">{error}</div> : 'Cargando…'}</div></div>;
  const abierta = ['borrador', 'enviada'].includes(c.estado);
  const esProyecto = c.tipo === 'proyecto';
  const pagaTodo = Number(pago.monto) >= c.pendiente - 0.004;
  const anticipoSugerido = Math.round(Number(c.total) * 50) / 100;
  const accion = (ruta, cuerpo = {}) => post(`/diserco/cotizaciones/${c.id}/${ruta}`, cuerpo);

  return (
    <div className="pagina">
      {correoAbierto && <EnviarCorreo titulo="Enviar cotización por correo" documento={`Cotización ${c.codigo} · ${lempiras(c.total)}`} correo={c.email || c.cliente_email || ''} ruta={`/diserco/cotizaciones/${c.id}/correo`} onCerrar={() => setCorreoAbierto(false)} onListo={() => cargar()} />}
      {avisoStock && <AvisoSinStock faltantes={avisoStock} onCancelar={() => setAvisoStock(null)} onContinuar={() => { setAvisoStock(null); cobrar(true); }} />}
      {error && <div className="aviso-caja mal" onClick={() => setError('')}>{error}</div>}
      {aviso && <div className="aviso-caja ok" onClick={() => onAviso('')}>{aviso}</div>}
      <div className="tarjeta rejilla">
        <div className="fila espacio">
          <h2>Cotización {c.codigo} <Etq c={c} /> <span className="chip">{TIPOS[c.tipo]}</span></h2>
          <button className="btn chico" onClick={onVolver}>← Volver</button>
        </div>
        <p><strong>{c.nombre_cliente}</strong>{c.rtn_cliente && ` · RTN ${c.rtn_cliente}`}{c.telefono && ` · ${c.telefono}`}{c.email && ` · ${c.email}`}</p>
        {(c.proyecto || c.ubicacion) && <p>{c.proyecto && <strong>{c.proyecto}</strong>}{c.ubicacion && ` — ${c.ubicacion}`}</p>}
        <div className="dis-barra">
          <button className="btn" onClick={verDocumento}>Ver PDF</button>
          <button className="btn" onClick={() => bajar(`/diserco/cotizaciones/${c.id}/excel`, `cotizacion-${c.codigo}.xlsx`)}>Descargar Excel</button>
          {c.tiene_original && <button className="btn" onClick={() => bajar(`/diserco/cotizaciones/${c.id}/excel-original`, `cotizacion-${c.codigo}-original.xlsx`)}>Excel original</button>}
          {abierta && vende && <button className="btn" onClick={() => onEditar(c)}>Editar</button>}
          {vende && <button className="btn" onClick={correo}>Enviar por correo</button>}
          {abierta && vende && !c.vencida && <button className="btn primario" disabled={ocupado} onClick={() => hacer(() => accion('aprobar'), 'Cotización aprobada: ya se puede cobrar y facturar')}>✔ Aprobar</button>}
          {abierta && vende && <button className="btn peligro" onClick={() => { const motivo = window.prompt('Motivo del rechazo:'); if (motivo) hacer(() => accion('rechazar', { motivo }), 'Cotización rechazada'); }}>Rechazar</button>}
          {['aprobada', 'facturada'].includes(c.estado) && gerencia && <button className="btn peligro" onClick={() => { const motivo = window.prompt('Motivo de la anulación:'); if (motivo) hacer(() => accion('anular', { motivo }), 'Cotización anulada'); }}>Anular</button>}
          {['rechazada', 'anulada'].includes(c.estado) && gerencia && <button className="btn" onClick={() => hacer(() => accion('reabrir'), 'Cotización reabierta como borrador')}>Reabrir</button>}
        </div>
        {c.motivo_cierre && ['rechazada', 'anulada'].includes(c.estado) && <small>Motivo: {c.motivo_cierre}</small>}
      </div>

      <div className="tarjeta rejilla">
        <div className="tabla-wrap"><table className="dis-tabla-ancha">
          <thead><tr><th>Descripción</th><th className="der">{esProyecto ? 'Área' : 'Cant.'}</th><th>{esProyecto ? 'Unidad' : 'Presentación'}</th><th className="der">P. unitario</th><th className="der">Subtotal</th></tr></thead>
          <tbody>{c.lineas.map((l) => (
            <tr key={l.id}><td style={{ whiteSpace: 'pre-wrap' }}>{l.descripcion}</td><td className="der num">{numero(l.cantidad, 3)}</td><td>{esProyecto ? l.unidad : l.presentacion || l.unidad}</td>
              <td className="der num">{lempiras(l.precio_unitario)}</td><td className="der num">{lempiras(l.cantidad * l.precio_unitario)}</td></tr>
          ))}</tbody>
        </table></div>
        <div className="dis-totales">
          {Number(c.descuento_pct) > 0 && <div>Descuento {numero(c.descuento_pct, 2)}%</div>}
          <div>Sub total {lempiras(c.subtotal)}</div><div>ISV 15% {lempiras(c.isv)}</div><div className="gran">Total {lempiras(c.total)}</div>
        </div>
        {(c.secciones ?? []).filter((s) => s.titulo || s.texto).map((s, i) => <div key={i} className="dis-seccion"><b>{s.titulo}</b><div style={{ whiteSpace: 'pre-wrap' }}>{s.texto}</div></div>)}
      </div>

      {esProyecto && salidas.length > 0 && (
        <div className="tarjeta rejilla">
          <h2>Material enviado al proyecto</h2>
          <div className="tabla-wrap"><table><tbody>{salidas.map((s) => (
            <tr key={s.id}><td>Salida #{s.numero} · {fechaCorta(s.created_at)}</td><td>{s.items.map((i) => `${numero(i.pendiente, 0)} × ${i.productos?.nombre}`).join(', ')}</td>
              <td><span className={`chip ${s.estado === 'abierta' ? 'aviso' : ''}`}>{s.estado === 'abierta' ? 'en curso' : 'cerrada'}</span></td><td className="der num">{lempiras(s.costo_total)}</td></tr>
          ))}</tbody></table></div>
          {(() => { const costo = salidas.reduce((t, s) => t + (s.costo_total ?? 0), 0); const sub = Number(c.subtotal); return <p><strong>Costo del material: {lempiras(costo)}</strong>{gerencia && <> · margen sobre material: {lempiras(sub - costo)} ({numero(sub > 0 ? ((sub - costo) / sub) * 100 : 0, 1)}%) <small>sin mano de obra</small></>}</p>; })()}
        </div>
      )}

      {['aprobada', 'facturada'].includes(c.estado) && (
        <div className="tarjeta rejilla">
          <h2>Cobros y facturas</h2>
          <div className="tabla-wrap"><table className="dis-tabla-ancha"><tbody>
            {c.pagos.map((p) => (
              <tr key={p.id} style={p.anulado || p.venta_estado === 'anulada' ? { opacity: 0.5, textDecoration: 'line-through' } : undefined}>
                <td>{fechaCorta(p.created_at)}</td><td><strong>{p.concepto}</strong></td><td>{p.forma}{p.referencia && ` · ${p.referencia}`}</td>
                <td className="der num">{lempiras(p.monto)}</td><td>{p.numero_factura ?? '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{p.venta_id && !p.anulado && <>
                  <button className="btn chico" onClick={() => verPdf(p.venta_id).catch((e) => setError(e.message))}>Factura PDF</button>{' '}
                  <button className="btn chico" onClick={() => imprimirTicket(p.venta_id, { reimpresion: true, razon: 'El cliente la pidió de nuevo' }).catch((e) => setError(e.message))}>Ticket</button>
                </>}</td>
              </tr>
            ))}
            {c.pagos.length === 0 && <tr><td className="vacio">Sin cobros todavía</td></tr>}
          </tbody></table></div>
          <p><strong>Cobrado {lempiras(c.pagado)}</strong> de {lempiras(c.total)} · pendiente {lempiras(c.pendiente)}</p>
          {c.estado === 'aprobada' && cobra && c.pendiente > 0.004 && (
            <div className="rejilla">
              {esProyecto && c.pagado === 0 && (
                <div className="fila">
                  <button className="btn chico" onClick={() => setPago({ ...pago, monto: String(anticipoSugerido) })}>Anticipo 50% · {lempiras(anticipoSugerido)}</button>
                  <button className="btn chico" onClick={() => setPago({ ...pago, monto: String(c.pendiente) })}>Pago total · {lempiras(c.pendiente)}</button>
                </div>
              )}
              <div className="dis-grid">
                <Campo etiqueta="Forma de pago"><select value={pago.forma_pago_id} onChange={(e) => setPago({ ...pago, forma_pago_id: e.target.value })}>{formas.map((f) => <option key={f.id} value={f.id}>{f.nombre}</option>)}</select></Campo>
                <Campo etiqueta="Monto" ayuda={!esProyecto ? 'Productos: se cobra completo' : undefined}><input type="number" step="0.01" value={pago.monto} readOnly={!esProyecto} onChange={(e) => setPago({ ...pago, monto: e.target.value })} /></Campo>
                <Campo etiqueta="Referencia (voucher / transferencia)"><input value={pago.referencia} onChange={(e) => setPago({ ...pago, referencia: e.target.value })} /></Campo>
                {esProyecto && <Campo etiqueta="Concepto en la factura (opcional)"><input value={pago.concepto} placeholder={pagaTodo ? 'Saldo final / Pago total' : 'Anticipo 50%'} onChange={(e) => setPago({ ...pago, concepto: e.target.value })} /></Campo>}
              </div>
              <button className="btn primario dis-grande" disabled={ocupado || !(Number(pago.monto) > 0)} onClick={() => { setError(''); cobrar(false); }}>
                {`REGISTRAR PAGO Y GENERAR FACTURA · ${lempiras(Number(pago.monto) || 0)}${esProyecto && !pagaTodo ? ' (parcial)' : ''}`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
