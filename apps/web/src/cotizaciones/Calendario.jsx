import { useEffect, useMemo, useState } from 'react';
import { lempiras, numero } from '@grupo/shared';
import { put } from '../api.js';
import { Campo, Kpi, Modal, useAccion } from '../ui/kit.jsx';
import { colorDe } from '../ui/sucursales.js';
import './cotizaciones.css';
import {
  CLASE_ESTADO, CONFIRMADOS, DIAS, ETIQUETA_ESTADO, ITEMS_CHECKLIST, MESES, claveFecha, enlaceGoogleCalendar, enlaceWhatsApp,
  fechaLarga, hoyClave, horaCorta, numCot,
} from './reglas.js';

export const Estado = ({ estado }) => <span className={`cot-estado ${CLASE_ESTADO[estado] ?? ''}`}>{ETIQUETA_ESTADO[estado] ?? estado}</span>;

// ── Aceptar y agendar: la fecha es obligatoria porque el evento entra al calendario ─────────
export function ModalAceptar({ cotizacion: c, sucursales, sucursalIdDefecto, onCerrar, onAceptada }) {
  const [f, setF] = useState({ fecha: c.fecha_evento ?? '', hora: c.hora_evento?.slice(0, 5) ?? '', sucursal: c.sucursal_id ?? sucursalIdDefecto ?? '', anticipo: c.anticipo > 0 ? String(c.anticipo) : '' });
  const [ejecutar, ocupado] = useAccion();
  const anticipo = Number(f.anticipo || 0);
  const invalido = anticipo < 0 || anticipo > c.total + 0.001;
  const aceptar = async () => {
    const r = await ejecutar(() => put(`/cotizaciones/${c.id}`, { estado: 'aceptada', fecha_evento: f.fecha, hora_evento: f.hora || null, sucursal_id: f.sucursal || null, anticipo }));
    if (r && r !== true) onAceptada(r);
  };
  return (
    <Modal titulo="Aceptar y agendar evento" onCerrar={onCerrar} tam="angosto"
      pie={<><button className="btn" onClick={onCerrar}>Cancelar</button><button className="btn primario" disabled={ocupado || !f.fecha || invalido} onClick={aceptar}>{ocupado ? 'Agendando…' : 'Aceptar y agendar'}</button></>}>
      <small>#{numCot(c)} · {c.nombre_evento} · {c.nombre_cliente} · <b>{lempiras(c.total)}</b></small>
      <Campo etiqueta="Fecha del evento *"><input type="date" value={f.fecha} onChange={(e) => setF({ ...f, fecha: e.target.value })} /></Campo>
      <Campo etiqueta="Hora"><input type="time" value={f.hora} onChange={(e) => setF({ ...f, hora: e.target.value })} /></Campo>
      <Campo etiqueta="Sucursal que atiende el evento">
        <select value={f.sucursal} onChange={(e) => setF({ ...f, sucursal: e.target.value })}><option value="">Sin asignar</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select>
      </Campo>
      <Campo etiqueta="Anticipo recibido (L)"><input type="number" step="0.01" min="0" placeholder="0.00" value={f.anticipo} onChange={(e) => setF({ ...f, anticipo: e.target.value })} /></Campo>
      {invalido && <div className="aviso-caja mal">El anticipo no puede superar el total.</div>}
      {anticipo > 0 && !invalido && <small>Saldo pendiente: <b>{lempiras(c.total - anticipo)}</b></small>}
    </Modal>
  );
}

// ── Ficha de control del evento: lista de control, reprogramación, anticipo y notas ─────────
export function ModalEvento({ cotizacion, sucursales, empresaNombre, onCerrar, onActualizada, onAceptar, onFacturar, onDocumento, onCorreo, onEditar, puedeFacturar }) {
  const c = cotizacion;
  const [f, setF] = useState({ fecha: c.fecha_evento ?? '', hora: c.hora_evento?.slice(0, 5) ?? '', lugar: c.lugar ?? '', anticipo: String(c.anticipo || 0), notas: c.notas_seguimiento ?? '' });
  const [ejecutar, ocupado] = useAccion();
  useEffect(() => setF({ fecha: c.fecha_evento ?? '', hora: c.hora_evento?.slice(0, 5) ?? '', lugar: c.lugar ?? '', anticipo: String(c.anticipo || 0), notas: c.notas_seguimiento ?? '' }), [c]);
  const confirmado = CONFIRMADOS.includes(c.estado);
  const facturada = c.estado === 'facturada';
  const suc = sucursales.find((s) => s.id === c.sucursal_id);
  const wa = enlaceWhatsApp(c.telefono_cliente);
  const agendaCambiada = f.fecha !== (c.fecha_evento ?? '') || f.hora !== (c.hora_evento?.slice(0, 5) ?? '') || f.lugar !== (c.lugar ?? '') || Number(f.anticipo || 0) !== Number(c.anticipo || 0);
  const guardar = async (cambios) => {
    const r = await ejecutar(() => put(`/cotizaciones/${c.id}/seguimiento`, cambios));
    if (r && r !== true) onActualizada(r);
  };
  const guardarAgenda = () => {
    if (f.fecha !== c.fecha_evento && !window.confirm(`¿Reprogramar el evento para el ${fechaLarga(f.fecha)}?`)) return;
    guardar({ fecha_evento: f.fecha, hora_evento: f.hora || null, lugar: f.lugar, ...(facturada ? {} : { anticipo: Number(f.anticipo || 0) }) });
  };
  return (
    <Modal titulo={`Cotización #${numCot(c)}`} onCerrar={onCerrar} tam="ancho"
      pie={<>
        <button className="btn" onClick={() => onDocumento(c)}>Ver / imprimir</button>
        {c.fecha_evento && <a className="btn" href={enlaceGoogleCalendar(c, empresaNombre)} target="_blank" rel="noreferrer">+ Google Calendar</a>}
        {!facturada && <button className="btn" onClick={() => onEditar(c)}>Editar</button>}
        {c.estado === 'aceptada' && puedeFacturar && <button className="btn primario" onClick={() => onFacturar(c)}>Facturar</button>}
      </>}>
      <div className="cal-ficha-cab" style={{ '--c-evento': suc ? colorDe(suc) : 'var(--acento)' }}>
        <div className="fila"><Estado estado={c.estado} />{suc && <small><i className="punto-color" style={{ background: colorDe(suc) }} />{suc.nombre}</small>}</div>
        <h2>{c.nombre_evento}</h2>
        <small>{fechaLarga(c.fecha_evento)}{c.hora_evento && ` · ${horaCorta(c.hora_evento)}`}{c.lugar && ` · ${c.lugar}`}</small>
      </div>
      {c.situacion && <div className={`cal-banner ${c.situacion.tipo}`}>{c.situacion.texto}</div>}

      <div className="cal-datos">
        <div className="cal-dato"><span>Cliente</span><b>{c.nombre_cliente}</b>
          {c.telefono_cliente && <div className="cal-contacto"><a href={`tel:${c.telefono_cliente}`}>{c.telefono_cliente}</a>{wa && <a href={wa} target="_blank" rel="noreferrer">WhatsApp</a>}</div>}
          {c.email_cliente && <small>{c.email_cliente}</small>}{c.rtn_cliente && <small>RTN {c.rtn_cliente}</small>}</div>
        <div className="cal-dato"><span>Pedido</span><b>{numero(c.cantidad_copitas)} copitas</b>
          <small>Total {lempiras(c.total)}{c.costo_servicio > 0 && ` · incluye servicio ${lempiras(c.costo_servicio)}`}{c.partidas.length > 0 && ` · ${c.partidas.length} partida(s) extra`}</small></div>
        <div className="cal-dato"><span>Cobro</span><b>{c.saldo > 0 ? `Saldo ${lempiras(c.saldo)}` : 'Cobrado completo'}</b><small>Anticipo {lempiras(c.anticipo)}{facturada && ' · facturada'}</small></div>
      </div>
      {c.notas && <div className="cal-notas"><span>Notas de la cotización</span>{c.notas}</div>}

      {!confirmado ? (
        <div className="aviso-caja">Esta cotización está <b>{ETIQUETA_ESTADO[c.estado].toLowerCase()}</b>: en el calendario aparece como tentativa. Al aceptarla queda confirmada y se habilita la lista de control.
          {c.estado !== 'rechazada' && <div style={{ marginTop: 8 }}><button className="btn primario chico" onClick={() => onAceptar(c)}>Aceptar y agendar</button></div>}</div>
      ) : (
        <>
          <div className="fila espacio"><h3>Lista de control</h3><small>{c.pasos_hechos}/{c.pasos_total}</small></div>
          <div className="cal-progreso"><div style={{ width: `${(c.pasos_hechos / c.pasos_total) * 100}%` }} /></div>
          <div className="cal-checklist">
            {ITEMS_CHECKLIST.map(([clave, etiqueta]) => {
              const e = c.checklist?.[clave]; const hecho = Boolean(e?.hecho);
              return (
                <button key={clave} className={`cal-paso ${hecho ? 'hecho' : ''}`} disabled={ocupado} onClick={() => guardar({ item: clave, hecho: !hecho })}>
                  <span className="cal-paso-check">{hecho ? '✓' : ''}</span>
                  <span>{etiqueta}{hecho && e.por && <small>{e.por} · {new Date(e.fecha).toLocaleString('es-HN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</small>}</span>
                </button>
              );
            })}
          </div>

          <h3>Agenda</h3>
          <div className="rejilla cols-3">
            <Campo etiqueta="Fecha"><input type="date" value={f.fecha} onChange={(e) => setF({ ...f, fecha: e.target.value })} /></Campo>
            <Campo etiqueta="Hora"><input type="time" value={f.hora} onChange={(e) => setF({ ...f, hora: e.target.value })} /></Campo>
            <Campo etiqueta="Anticipo (L)"><input type="number" step="0.01" min="0" value={f.anticipo} disabled={facturada} onChange={(e) => setF({ ...f, anticipo: e.target.value })} /></Campo>
          </div>
          <Campo etiqueta="Lugar"><input value={f.lugar} onChange={(e) => setF({ ...f, lugar: e.target.value })} /></Campo>
          {agendaCambiada && <div><button className="btn chico primario" disabled={!f.fecha || ocupado} onClick={guardarAgenda}>Guardar cambios de agenda</button></div>}
          <Campo etiqueta="Sucursal que atiende">
            <select value={c.sucursal_id ?? ''} disabled={ocupado} onChange={(e) => guardar({ sucursal_id: e.target.value || null })}><option value="">Sin asignar</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select>
          </Campo>
          <Campo etiqueta="Notas de seguimiento (internas)"><textarea rows={3} value={f.notas} onChange={(e) => setF({ ...f, notas: e.target.value })} placeholder="Ej. el salón abre a las 2 p. m., llevar 2 carritos, contacto del planner…" /></Campo>
          {f.notas !== (c.notas_seguimiento ?? '') && <div><button className="btn chico" disabled={ocupado} onClick={() => guardar({ notas_seguimiento: f.notas })}>Guardar notas</button></div>}
          <label className="fila" style={{ flexDirection: 'row', color: 'var(--texto)' }}><input type="checkbox" checked={Boolean(c.realizado)} disabled={ocupado} onChange={(e) => guardar({ realizado: e.target.checked })} /> El evento ya se realizó</label>
        </>
      )}
      {!facturada && onCorreo && <div><button className="btn chico" onClick={() => onCorreo(c)}>Enviar por correo</button></div>}
    </Modal>
  );
}

function TarjetaEvento({ c, sucursales, conFecha, onAbrir }) {
  const suc = sucursales.find((s) => s.id === c.sucursal_id);
  const confirmado = CONFIRMADOS.includes(c.estado);
  return (
    <button className={`cal-tarjeta ${confirmado ? '' : 'tentativo'}`} style={{ '--c-evento': suc ? colorDe(suc) : 'var(--acento)' }} onClick={onAbrir}>
      <div className="cal-tarjeta-fila"><b>{c.nombre_evento}</b><Estado estado={c.estado} /></div>
      <div className="cal-sub">{conFecha && `${fechaLarga(c.fecha_evento).split(',').slice(0, 2).join(',')} · `}{c.hora_evento ? horaCorta(c.hora_evento) : 'Sin hora'} · {numero(c.cantidad_copitas)} copitas · {lempiras(c.total)}</div>
      {confirmado && <><div className="cal-progreso mini"><div style={{ width: `${(c.pasos_hechos / c.pasos_total) * 100}%` }} /></div>{c.situacion && <div className={`cal-sit ${c.situacion.tipo}`}>{c.situacion.texto}</div>}</>}
    </button>
  );
}

// ── Calendario mensual ──────────────────────────────────────────────────────────────────────
export default function Calendario({ cotizaciones, sucursales, abrirId, onAbierto, onAbrir }) {
  const hoy = hoyClave();
  const [mes, setMes] = useState(() => { const d = new Date(); return { anio: d.getFullYear(), mes: d.getMonth() }; });
  const [tentativos, setTentativos] = useState(true);
  const [filtroSuc, setFiltroSuc] = useState('');
  const [dia, setDia] = useState(hoy);

  useEffect(() => {
    if (!abrirId) return;
    const c = cotizaciones.find((x) => x.id === abrirId);
    if (c?.fecha_evento) { const [a, m] = c.fecha_evento.split('-').map(Number); setMes({ anio: a, mes: m - 1 }); setDia(c.fecha_evento); onAbrir(c); }
    onAbierto?.();
  }, [abrirId]); // eslint-disable-line react-hooks/exhaustive-deps

  const visibles = useMemo(() => cotizaciones.filter((c) => c.fecha_evento && c.estado !== 'rechazada' && (tentativos || CONFIRMADOS.includes(c.estado)) && (!filtroSuc || c.sucursal_id === filtroSuc)), [cotizaciones, tentativos, filtroSuc]);
  const porDia = useMemo(() => {
    const m = new Map();
    for (const c of visibles) { if (!m.has(c.fecha_evento)) m.set(c.fecha_evento, []); m.get(c.fecha_evento).push(c); }
    for (const l of m.values()) l.sort((a, b) => (CONFIRMADOS.includes(b.estado) - CONFIRMADOS.includes(a.estado)) || String(a.hora_evento ?? '99').localeCompare(String(b.hora_evento ?? '99')));
    return m;
  }, [visibles]);
  const celdas = useMemo(() => {
    const offset = (new Date(mes.anio, mes.mes, 1).getDay() + 6) % 7;
    const n = Math.ceil((offset + new Date(mes.anio, mes.mes + 1, 0).getDate()) / 7) * 7;
    return Array.from({ length: n }, (_, i) => { const d = new Date(mes.anio, mes.mes, i - offset + 1); return { clave: claveFecha(d.getFullYear(), d.getMonth(), d.getDate()), dia: d.getDate(), delMes: d.getMonth() === mes.mes }; });
  }, [mes]);
  const prefijo = `${mes.anio}-${String(mes.mes + 1).padStart(2, '0')}`;
  const k = useMemo(() => {
    const delMes = visibles.filter((c) => c.fecha_evento.startsWith(prefijo));
    const conf = delMes.filter((c) => CONFIRMADOS.includes(c.estado)), tent = delMes.filter((c) => !CONFIRMADOS.includes(c.estado));
    const suma = (l, f) => l.reduce((s, c) => s + Number(f(c)), 0);
    return { conf: conf.length, tent: tent.length, montoTent: suma(tent, (c) => c.total), copitas: suma(conf, (c) => c.cantidad_copitas), monto: suma(conf, (c) => c.total), anticipos: suma(conf, (c) => c.anticipo), saldo: suma(conf, (c) => c.saldo) };
  }, [visibles, prefijo]);
  // Lo que hay que atender: próximos 14 días + eventos vencidos sin cerrar.
  const agenda = useMemo(() => cotizaciones
    .filter((c) => CONFIRMADOS.includes(c.estado) && c.fecha_evento && (!filtroSuc || c.sucursal_id === filtroSuc))
    .filter((c) => c.situacion && ((c.situacion.dias >= 0 && c.situacion.dias <= 14) || (c.situacion.dias < 0 && c.situacion.tipo === 'vencido')))
    .sort((a, b) => a.fecha_evento.localeCompare(b.fecha_evento) || String(a.hora_evento ?? '').localeCompare(String(b.hora_evento ?? ''))), [cotizaciones, filtroSuc]);
  const mover = (d) => setMes(({ anio, mes: m }) => { const x = new Date(anio, m + d, 1); return { anio: x.getFullYear(), mes: x.getMonth() }; });
  const delDia = porDia.get(dia) ?? [];

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="rejilla cols-4">
        <Kpi etiqueta={`Eventos confirmados · ${MESES[mes.mes]}`} valor={k.conf} sub={k.tent > 0 ? `${k.tent} tentativos por ${lempiras(k.montoTent)}` : 'Sin tentativos pendientes'} acento />
        <Kpi etiqueta="Copitas a producir" valor={numero(k.copitas)} sub="Solo eventos confirmados" />
        <Kpi etiqueta="Monto confirmado" valor={lempiras(k.monto)} sub={`Anticipos ${lempiras(k.anticipos)}`} />
        <Kpi etiqueta="Saldo por cobrar" valor={lempiras(k.saldo)} sub="Confirmados del mes aún sin cobrar" />
      </div>
      <div className="cal-layout">
        <div className="tarjeta">
          <div className="cal-barra">
            <div className="cal-nav">
              <button className="btn chico" onClick={() => mover(-1)} aria-label="Mes anterior">‹</button>
              <h2>{MESES[mes.mes]} {mes.anio}</h2>
              <button className="btn chico" onClick={() => mover(1)} aria-label="Mes siguiente">›</button>
              <button className="btn chico" onClick={() => { const d = new Date(); setMes({ anio: d.getFullYear(), mes: d.getMonth() }); setDia(hoy); }}>Hoy</button>
            </div>
            <div className="cal-filtros">
              <select value={filtroSuc} onChange={(e) => setFiltroSuc(e.target.value)}><option value="">Todas las sucursales</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select>
              <label className="cal-toggle"><input type="checkbox" checked={tentativos} onChange={(e) => setTentativos(e.target.checked)} /> Ver tentativos</label>
            </div>
          </div>
          <div className="cal-grid">{DIAS.map((d) => <div key={d} className="cal-cab">{d}</div>)}</div>
          <div className="cal-grid">
            {celdas.map((ce) => {
              const ev = porDia.get(ce.clave) ?? [];
              const conf = ev.filter((c) => CONFIRMADOS.includes(c.estado));
              const copitas = conf.reduce((s, c) => s + Number(c.cantidad_copitas), 0);
              return (
                <div key={ce.clave} className={['cal-celda', !ce.delMes && 'fuera', ce.clave === hoy && 'hoy', ce.clave === dia && 'seleccionada', ce.clave < hoy && 'pasada'].filter(Boolean).join(' ')} onClick={() => setDia(ce.clave)}>
                  <div className="cal-celda-cab"><span className="cal-dia">{ce.dia}</span>{conf.length > 1 && <span className="cal-multiple" title="Varios eventos el mismo día">{conf.length}</span>}</div>
                  {ev.slice(0, 3).map((c) => {
                    const suc = sucursales.find((s) => s.id === c.sucursal_id);
                    return (
                      <button key={c.id} className={`cal-pill ${CONFIRMADOS.includes(c.estado) ? '' : 'tentativo'} ${c.situacion ? `cal-sit-${c.situacion.tipo}` : ''}`} style={{ '--c-evento': suc ? colorDe(suc) : 'var(--acento)' }}
                        title={`${c.nombre_evento} · ${c.nombre_cliente} · ${numero(c.cantidad_copitas)} copitas${c.situacion ? ` · ${c.situacion.texto}` : ''}`}
                        onClick={(e) => { e.stopPropagation(); setDia(ce.clave); onAbrir(c); }}>
                        {c.hora_evento && <b>{horaCorta(c.hora_evento).replace(' ', '').replace('. m.', '')} </b>}{c.nombre_evento}
                      </button>
                    );
                  })}
                  {ev.length > 3 && <span className="cal-mas">+{ev.length - 3} más</span>}
                  {copitas > 0 && <span className="cal-copitas">{numero(copitas)} copitas</span>}
                </div>
              );
            })}
          </div>
          <div className="cal-leyenda">
            <span><i className="cal-l-confirmado" />Confirmado</span><span><i className="cal-l-tentativo" />Tentativo (borrador / enviada)</span>
            <span><i className="cal-l-urgente" />Faltan pasos a ≤3 días</span><span><i className="cal-l-listo" />Todo listo</span>
          </div>
        </div>
        <div className="cal-lateral">
          <div className="tarjeta"><h3>{fechaLarga(dia)}</h3>
            {delDia.length === 0 ? <p className="cal-vacio">Sin eventos este día.</p> : delDia.map((c) => <TarjetaEvento key={c.id} c={c} sucursales={sucursales} onAbrir={() => onAbrir(c)} />)}</div>
          <div className="tarjeta"><h3>Por atender · próximos 14 días</h3>
            {agenda.length === 0 ? <p className="cal-vacio">No hay eventos confirmados en los próximos 14 días.</p> : agenda.map((c) => <TarjetaEvento key={c.id} c={c} sucursales={sucursales} conFecha onAbrir={() => onAbrir(c)} />)}</div>
        </div>
      </div>
    </div>
  );
}
