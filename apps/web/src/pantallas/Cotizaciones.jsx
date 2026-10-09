import { useMemo, useState } from 'react';
import { lempiras } from '@grupo/shared';
import { api, get, post, put } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Cargando, ErrorCaja, Modal, Tabs, useAccion, useAviso, useConfirmar, useDatos } from '../ui/kit.jsx';
import Calendario, { Estado, ModalAceptar, ModalEvento } from '../cotizaciones/Calendario.jsx';
import Formulario from '../cotizaciones/Formulario.jsx';
import { abrirDocumento } from '../cotizaciones/documento.js';
import { ETIQUETA_ESTADO, horaCorta, numCot } from '../cotizaciones/reglas.js';
import EnviarCorreo from '../mensajeria/EnviarCorreo.jsx';
import '../cotizaciones/cotizaciones.css';

const FORMAS = [['efectivo', 'Efectivo'], ['tarjeta', 'Tarjeta'], ['transferencia', 'Transferencia']];
const UMBRAL_RTN = 10000;
const rtnValido = (r) => /^\d{13,14}$/.test(String(r).replace(/[-\s]/g, ''));

function ModalFacturar({ c, sucursales, sucursalIdDefecto, onCerrar, onFacturada }) {
  const [forma, setForma] = useState('transferencia');
  const [rtn, setRtn] = useState(c.rtn_cliente ?? '');
  const [suc, setSuc] = useState(c.sucursal_id ?? sucursalIdDefecto ?? sucursales[0]?.id ?? '');
  const [ejecutar, ocupado] = useAccion();
  const requiere = c.total > UMBRAL_RTN;
  const rtnMal = rtn.trim() !== '' && !rtnValido(rtn);
  const facturar = async () => {
    const r = await ejecutar(() => post(`/cotizaciones/${c.id}/facturar`, { sucursal_id: suc, forma_pago: forma, rtn: rtn.trim() || null }));
    if (r && r !== true) onFacturada(r);
  };
  return (
    <Modal titulo={`Facturar cotización #${numCot(c)}`} onCerrar={onCerrar} tam="angosto"
      pie={<><button className="btn" onClick={onCerrar} disabled={ocupado}>Cancelar</button><button className="btn primario" disabled={ocupado || rtnMal || (requiere && !rtn.trim()) || !suc} onClick={facturar}>{ocupado ? 'Emitiendo…' : `Emitir factura ${lempiras(c.total)}`}</button></>}>
      <small>Se emite la factura con los mismos montos cotizados; no hay que volver a digitar nada.</small>
      <div className="cot-resumen">
        <div><span>Cliente</span><b>{c.nombre_cliente}</b></div><div><span>Evento</span><b>{c.nombre_evento}</b></div>
        {c.cantidad_copitas > 0 && <div><span>{Number(c.cantidad_copitas).toLocaleString('es-HN')} copitas × {lempiras(c.precio_copita)}</span><b>{lempiras(c.cantidad_copitas * c.precio_copita)}</b></div>}
        {c.costo_servicio > 0 && <div><span>Servicio de evento</span><b>{lempiras(c.costo_servicio)}</b></div>}
        {c.partidas.map((p) => <div key={p.id}><span>{p.descripcion}</span><b>{lempiras(p.cantidad * p.precio_unitario)}</b></div>)}
        {c.descuento > 0 && <div><span>Descuento</span><b>− {lempiras(c.descuento)}</b></div>}
        <div className="total"><span>Total a facturar</span><span>{lempiras(c.total)}</span></div>
      </div>
      {c.anticipo > 0 && <div className="aviso-caja ok">Ya hay un anticipo de <b>{lempiras(c.anticipo)}</b>: cobra ahora solo el saldo de <b>{lempiras(Math.max(0, c.total - c.anticipo))}</b>. La factura sale por el total del evento.</div>}
      <Campo etiqueta="Sucursal que emite la factura"><select value={suc} onChange={(e) => setSuc(e.target.value)}>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select></Campo>
      <Campo etiqueta={requiere ? `RTN del cliente (obligatorio: supera L${UMBRAL_RTN.toLocaleString('es-HN')})` : 'RTN del cliente (opcional)'}><input value={rtn} onChange={(e) => setRtn(e.target.value)} inputMode="numeric" /></Campo>
      {rtnMal && <div className="aviso-caja mal">El RTN hondureño tiene 13-14 dígitos.</div>}
      <div><small>Forma de pago</small><div className="cot-formas">{FORMAS.map(([id, n]) => <button key={id} className="btn" aria-pressed={forma === id} onClick={() => setForma(id)}>{n}</button>)}</div></div>
    </Modal>
  );
}

export default function Cotizaciones() {
  const { sucursales, sucursalId, contexto, puede } = useSesion();
  const avisar = useAviso();
  const [ejecutar] = useAccion();
  const d = useDatos(() => get('/cotizaciones'), []);
  const [pestana, setPestana] = useState('calendario');
  const [q, setQ] = useState('');
  const [estado, setEstado] = useState('');
  const [form, setForm] = useState(null);          // null | {} nueva | cotización a editar
  const [abierta, setAbierta] = useState(null);
  const [aceptando, setAceptando] = useState(null);
  const [facturando, setFacturando] = useState(null);
  const [abrirId, setAbrirId] = useState(null);
  const empresaNombre = contexto?.empresa?.nombre ?? '';
  const puedeFacturar = puede('pos:anular');
  const lista = d.datos ?? [];

  const visibles = useMemo(() => {
    const t = q.trim().toLowerCase();
    return lista.filter((c) => (!t || c.nombre_cliente.toLowerCase().includes(t) || c.nombre_evento.toLowerCase().includes(t) || numCot(c).includes(t)) && (!estado || c.estado === estado));
  }, [lista, q, estado]);
  const porAtender = lista.filter((c) => ['urgente', 'vencido'].includes(c.situacion?.tipo)).length;
  // La ficha abierta siempre muestra la versión más reciente de la lista.
  const abiertaFresca = abierta && (lista.find((c) => c.id === abierta.id) ?? abierta);

  const reemplazar = (c) => { d.recargar(); setAbierta((a) => (a && a.id === c.id ? c : a)); };
  const cambiarEstado = async (c, nuevo) => {
    if (nuevo === 'aceptada') return setAceptando(c);
    if (await ejecutar(() => put(`/cotizaciones/${c.id}`, { estado: nuevo }), 'Estado actualizado')) d.recargar();
  };
  const confirmar = useConfirmar();
  const eliminar = async (c) => {
    if (!(await confirmar({ titulo: 'Eliminar cotización', mensaje: `¿Eliminar la cotización #${numCot(c)}?`, textoOk: 'Eliminar', peligro: true }))) return;
    if (await ejecutar(() => api(`/cotizaciones/${c.id}`, { metodo: 'DELETE' }), 'Cotización eliminada')) d.recargar();
  };
  const documento = async (c) => {
    const datos = await ejecutar(() => get(`/cotizaciones/${c.id}/documento`));
    if (datos && datos !== true && !abrirDocumento(datos)) avisar('El navegador bloqueó la ventana. Permite las ventanas emergentes para imprimir.', 'mal');
  };
  const [correoDe, setCorreoDe] = useState(null);   // cotización que se está enviando por correo (Gmail, con PDF adjunto)
  const enviar = (c) => setCorreoDe(c);

  return (
    <div className="pagina">
      <div className="encabezado-pagina">
        <h1>Cotizaciones y eventos</h1>
        <button className="btn primario" onClick={() => setForm({})}>+ Nueva cotización</button>
      </div>
      <Tabs tabs={[['calendario', `Calendario de eventos${porAtender ? ` (${porAtender})` : ''}`], ['lista', 'Cotizaciones']]} valor={pestana} onCambio={setPestana} />
      <ErrorCaja error={d.error} />
      {d.cargando && !d.datos ? <Cargando /> : pestana === 'calendario' ? (
        <Calendario cotizaciones={lista} sucursales={sucursales} abrirId={abrirId} onAbierto={() => setAbrirId(null)} onAbrir={setAbierta} />
      ) : (
        <>
          <div className="fila">
            <input placeholder="Buscar por cliente, evento o número…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />
            <select value={estado} onChange={(e) => setEstado(e.target.value)} style={{ maxWidth: 200 }}>
              <option value="">Todos los estados</option>{Object.entries(ETIQUETA_ESTADO).map(([v, n]) => <option key={v} value={v}>{n}</option>)}
            </select>
            <small>{visibles.length} de {lista.length}</small>
          </div>
          <div className="tarjeta pad0"><div className="tabla-wrap"><table>
            <thead><tr><th>No.</th><th>Cliente</th><th>Evento</th><th>Fecha</th><th className="der">Total</th><th>Estado</th><th></th></tr></thead>
            <tbody>
              {visibles.map((c) => {
                const facturada = c.estado === 'facturada';
                return (
                  <tr key={c.id}>
                    <td className="num">{numCot(c)}</td>
                    <td>{c.nombre_cliente}{c.rtn_cliente && <small style={{ display: 'block' }}>RTN {c.rtn_cliente}</small>}</td>
                    <td>{c.nombre_evento}</td>
                    <td>{c.fecha_evento ? <button className="btn chico fantasma" title="Ver en el calendario" onClick={() => { setAbrirId(c.id); setPestana('calendario'); }}>{c.fecha_evento}{c.hora_evento && ` · ${horaCorta(c.hora_evento)}`}</button> : '—'}
                      {c.situacion && ['urgente', 'vencido'].includes(c.situacion.tipo) && <span className="chip aviso" style={{ marginLeft: 6 }}>{c.situacion.tipo === 'urgente' ? 'Evento próximo' : 'Por cerrar'}</span>}</td>
                    <td className="der num">{lempiras(c.total)}</td>
                    <td>{facturada ? <Estado estado="facturada" /> : (
                      <select value={c.estado} onChange={(e) => cambiarEstado(c, e.target.value)} style={{ minHeight: 34, padding: '4px 8px', width: 'auto' }}>
                        {['borrador', 'enviada', 'aceptada', 'rechazada'].map((v) => <option key={v} value={v}>{ETIQUETA_ESTADO[v]}</option>)}</select>)}</td>
                    <td><div className="cot-acciones">
                      <button className="btn chico" onClick={() => setAbierta(c)}>Abrir</button>
                      {!facturada && c.estado !== 'rechazada' && puedeFacturar && <button className="btn chico primario" onClick={() => setFacturando(c)}>Facturar</button>}
                      <button className="btn chico" onClick={() => documento(c)}>Ver PDF</button>
                      {!facturada && <button className="btn chico" onClick={() => enviar(c)}>Enviar por correo</button>}
                      {c.estado === 'borrador' && <button className="btn chico peligro" onClick={() => eliminar(c)}>Eliminar</button>}
                    </div></td>
                  </tr>
                );
              })}
              {!visibles.length && <tr><td colSpan={7} className="centro tenue" style={{ padding: 30 }}>{lista.length ? 'Sin cotizaciones con esos filtros.' : 'Aún no hay cotizaciones. Crea la primera con «+ Nueva cotización».'}</td></tr>}
            </tbody>
          </table></div></div>
          <small>Envío por correo: el envío automático del PDF está <b>pendiente de configurar</b> en el servidor; mientras tanto el botón abre tu correo con el mensaje listo (imprime la cotización como PDF y adjúntala).</small>
        </>
      )}

      {form && <Formulario cotizacion={form.id ? form : null} sucursales={sucursales} sucursalIdDefecto={sucursalId} onCerrar={() => setForm(null)} onGuardada={(c) => { setForm(null); d.recargar(); if (form.id) setAbierta(c); }} />}
      {abiertaFresca && !aceptando && !facturando && (
        <ModalEvento cotizacion={abiertaFresca} sucursales={sucursales} empresaNombre={empresaNombre} puedeFacturar={puedeFacturar}
          onCerrar={() => setAbierta(null)} onActualizada={reemplazar} onAceptar={setAceptando} onFacturar={(c) => setFacturando(c)} onDocumento={documento} onCorreo={enviar} onEditar={(c) => { setAbierta(null); setForm(c); }} />
      )}
      {aceptando && <ModalAceptar cotizacion={aceptando} sucursales={sucursales} sucursalIdDefecto={sucursalId} onCerrar={() => setAceptando(null)}
        onAceptada={(c) => { setAceptando(null); avisar(`Cotización #${numCot(c)} aceptada y agendada en el calendario`); reemplazar(c); }} />}
      {correoDe && <EnviarCorreo titulo="Enviar cotización por correo" documento={`Cotización #${numCot(correoDe)} · ${correoDe.nombre_evento} · ${lempiras(correoDe.total)}`} correo={correoDe.email_cliente ?? ''} ruta={`/cotizaciones/${correoDe.id}/enviar`}
        onCerrar={() => setCorreoDe(null)} onListo={() => d.recargar()} />}
      {facturando && <ModalFacturar c={facturando} sucursales={sucursales} sucursalIdDefecto={sucursalId} onCerrar={() => setFacturando(null)}
        onFacturada={(r) => { setFacturando(null); setAbierta(null); avisar(`Factura ${r.factura.numero_factura} emitida${r.factura.es_borrador ? ' (sin validez fiscal: CAI pendiente)' : ''}`); d.recargar(); }} />}
    </div>
  );
}
