import { useMemo, useState } from 'react';
import { BUCKETS_ANTIGUEDAD, fechaHN, lempiras, sumarDias } from '@grupo/shared';
import { get, post, put } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, EncabezadoPagina, Estado, Kpi, Modal, Tabs, useAccion, useAviso, useDatos, Vacio } from '../ui/kit.jsx';
import './crm.css';

const SITUACION = { sin_cobro: 'Sin cobro', anticipo_pendiente: 'Falta anticipo', parcial: 'Pago parcial' };
const fmt = (f) => (f ? String(f).slice(0, 10).split('-').reverse().join('/') : '');

export default function Cobranza() {
  const { puede } = useSesion();
  const [tab, setTab] = useState('tablero');
  const tablero = useDatos(() => get('/crm/cobranza/tablero'), []);
  const [bucket, setBucket] = useState('');
  const [q, setQ] = useState('');
  const [sit, setSit] = useState('');
  const [doc, setDoc] = useState(null);
  const [estado, setEstado] = useState(null);

  return (
    <div className="pagina">
      <EncabezadoPagina titulo="Cobranza" descripcion="Lo aprobado y aún no cobrado, con su antigüedad, promesas de pago y seguimiento." />
      <Tabs tabs={[['tablero', 'Por cobrar'], ['clientes', 'Clientes'], ['promesas', 'Promesas'], ['recordatorios', 'Recordatorios']]} valor={tab} onCambio={setTab} />
      <Estado d={tablero}>{(t) => {
        const r = t.resumen;
        const docs = t.documentos.filter((d) => (!bucket || d.bucket === bucket) && (!sit || d.situacion === sit) && (!q.trim() || `${d.nombre_cliente} ${d.proyecto} ${d.documento}`.toLowerCase().includes(q.trim().toLowerCase())));
        return (
          <>
            <div className="rejilla cols-4">
              <Kpi etiqueta="Por cobrar" valor={lempiras(r.total)} sub={`${r.documentos} documentos · ${r.clientes} clientes`} acento />
              <Kpi etiqueta="Con más de 30 días" valor={lempiras(r.vencido)} tono={r.vencido > 0 ? 'mal' : 'ok'} />
              <Kpi etiqueta="Aprobadas sin cobrar" valor={lempiras(r.sin_cobro.monto)} sub={`${r.sin_cobro.n} cotizaciones`} />
              <Kpi etiqueta="Anticipos pendientes" valor={lempiras(r.anticipos_pendientes.monto)} sub={`${r.anticipos_pendientes.n} cotizaciones`} tono={r.anticipos_pendientes.n ? 'aviso' : undefined} />
            </div>
            {tab === 'tablero' && (
              <>
                <div className="cob-edades" role="group" aria-label="Antigüedad del saldo">
                  {BUCKETS_ANTIGUEDAD.map((b) => (
                    <button key={b} className={`cob-edad ${bucket === b ? 'activa' : ''} ${b === '+90' && r.buckets[b] > 0 ? 'mal' : ''}`} onClick={() => setBucket(bucket === b ? '' : b)} aria-pressed={bucket === b}>
                      <small>{b} días</small><b>{lempiras(r.buckets[b])}</b>
                    </button>))}
                </div>
                <div className="cob-barra">
                  <input type="search" placeholder="Buscar cliente, proyecto o documento…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar" />
                  <select value={sit} onChange={(e) => setSit(e.target.value)} aria-label="Situación"><option value="">Toda situación</option>{Object.entries(SITUACION).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                </div>
                {docs.length === 0 ? <Vacio titulo="Nada por cobrar con ese filtro">Las cotizaciones aprobadas con saldo aparecen aquí.</Vacio> : (
                  <div className="tarjeta pad0"><div className="tabla-wrap"><table>
                    <thead><tr><th>Cliente / proyecto</th><th>Documento</th><th>Situación</th><th className="der">Días</th><th className="der">Total</th><th className="der">Saldo</th></tr></thead>
                    <tbody>{docs.map((d) => (
                      <tr key={d.documento_id} onClick={() => setDoc(d)} style={{ cursor: 'pointer' }}>
                        <td>{d.nombre_cliente}<small className="eco-sub" style={{ display: 'block', color: 'var(--tenue)' }}>{d.proyecto}</small></td>
                        <td>{d.documento}<small style={{ display: 'block', color: 'var(--tenue)' }}>{fmt(d.fecha_documento)}</small></td>
                        <td><span className={`chip ${d.vencido ? 'mal' : ''}`}>{SITUACION[d.situacion]}</span></td>
                        <td className={`der num ${d.vencido ? 'cob-mal' : ''}`}>{d.dias_atraso}</td>
                        <td className="der num">{lempiras(d.total)}</td><td className="der num"><b>{lempiras(d.saldo)}</b></td>
                      </tr>))}</tbody>
                  </table></div></div>)}
              </>)}
            {tab === 'clientes' && (
              t.clientes.length === 0 ? <Vacio titulo="Sin saldos por cobrar" /> : (
                <div className="tarjeta pad0"><div className="tabla-wrap"><table>
                  <thead><tr><th>Cliente</th>{BUCKETS_ANTIGUEDAD.map((b) => <th key={b} className="der">{b}</th>)}<th className="der">Saldo</th><th></th></tr></thead>
                  <tbody>{t.clientes.map((c) => (
                    <tr key={c.tercero_id ?? c.nombre}><td>{c.nombre}<small style={{ display: 'block', color: 'var(--tenue)' }}>{c.documentos} documentos · {c.peor_atraso} días el más antiguo</small></td>
                      {BUCKETS_ANTIGUEDAD.map((b) => <td key={b} className="der num">{c.buckets[b] ? lempiras(c.buckets[b]) : '—'}</td>)}
                      <td className="der num"><b>{lempiras(c.total)}</b></td>
                      <td className="der">{c.tercero_id && <button className="btn chico" onClick={() => setEstado(c)}>Estado de cuenta</button>}</td></tr>))}</tbody>
                </table></div></div>))}
            {tab === 'promesas' && <Promesas puedeGestionar={puede('cobranza:gestionar')} />}
            {tab === 'recordatorios' && <Recordatorios puedeGestionar={puede('cobranza:gestionar')} onCambio={tablero.recargar} />}
          </>);
      }}</Estado>
      {doc && <Detalle doc={doc} puedeGestionar={puede('cobranza:gestionar')} onCerrar={() => setDoc(null)} onCambio={tablero.recargar} />}
      {estado && <EstadoCuenta cliente={estado} onCerrar={() => setEstado(null)} />}
    </div>
  );
}

function Detalle({ doc, puedeGestionar, onCerrar, onCambio }) {
  const d = useDatos(() => get(`/crm/cobranza/documento/${doc.origen}/${doc.documento_id}`), [doc.documento_id]);
  const [ejecutar, ocupado] = useAccion();
  const hoy = fechaHN();
  const [g, setG] = useState({ tipo: 'llamada', resultado: '', nota: '', proxima_fecha: '' });
  const [p, setP] = useState({ monto: doc.saldo, fecha_promesa: sumarDias(hoy, 3), nota: '' });
  const guardarG = async () => {
    if (await ejecutar(() => post('/crm/cobranza/gestiones', { origen: doc.origen, documento_id: doc.documento_id, ...g, resultado: g.resultado || null, nota: g.nota || null, proxima_fecha: g.proxima_fecha || null }), 'Gestión registrada')) { setG({ tipo: 'llamada', resultado: '', nota: '', proxima_fecha: '' }); d.recargar(); onCambio(); }
  };
  const guardarP = async () => {
    if (await ejecutar(() => post('/crm/cobranza/promesas', { origen: doc.origen, documento_id: doc.documento_id, monto: Number(p.monto), fecha_promesa: p.fecha_promesa, nota: p.nota || null }), 'Promesa registrada')) { d.recargar(); onCambio(); }
  };
  return (
    <Modal titulo={`${doc.nombre_cliente} · ${doc.documento}`} onCerrar={onCerrar}>
      <p><b>{lempiras(doc.saldo)}</b> por cobrar de {lempiras(doc.total)} · {doc.dias_atraso} días desde la aprobación{doc.proyecto ? ` · ${doc.proyecto}` : ''}</p>
      <Estado d={d}>{(x) => (
        <>
          <h3>Pagos</h3>
          {x.pagos.length === 0 ? <small>Todavía no ha pagado nada.</small> : <div className="cob-lista">{x.pagos.map((pg, i) => <div key={i}><span>{fmt(pg.created_at)} · {pg.concepto} · {pg.forma}</span><b>{lempiras(pg.monto)}</b></div>)}</div>}
          <h3>Promesas de pago</h3>
          {x.promesas.length === 0 ? <small>Sin promesas.</small> : <div className="cob-lista">{x.promesas.map((pr) => <div key={pr.id}><span>{fmt(pr.fecha_promesa)} · {lempiras(pr.monto)}<small>{pr.responsable_nombre}{pr.nota ? ` · ${pr.nota}` : ''}</small></span><span className="chip">{pr.estado}</span></div>)}</div>}
          <h3>Gestiones</h3>
          {x.gestiones.length === 0 ? <small>Sin gestiones registradas.</small> : <div className="cob-lista">{x.gestiones.map((ge) => <div key={ge.id}><span>{fmt(ge.created_at)} · {ge.tipo}: {ge.resultado || ge.nota}<small>{ge.usuario_nombre}{ge.proxima_fecha ? ` · seguimiento ${fmt(ge.proxima_fecha)}` : ''}</small></span></div>)}</div>}
        </>)}</Estado>
      {puedeGestionar && (
        <>
          <div className="cob-form">
            <h3>Registrar gestión</h3>
            <div className="rejilla cols-2">
              <Campo etiqueta="Tipo"><select value={g.tipo} onChange={(e) => setG({ ...g, tipo: e.target.value })}><option value="llamada">Llamada</option><option value="visita">Visita</option><option value="correo">Correo</option><option value="mensaje">Mensaje</option><option value="nota">Nota</option></select></Campo>
              <Campo etiqueta="Dar seguimiento el (opcional)"><input type="date" min={hoy} value={g.proxima_fecha} onChange={(e) => setG({ ...g, proxima_fecha: e.target.value })} /></Campo>
            </div>
            <Campo etiqueta="Qué pasó"><input value={g.resultado} onChange={(e) => setG({ ...g, resultado: e.target.value })} placeholder="Ej. Dice que paga el viernes" /></Campo>
            <button className="btn primario" disabled={ocupado || (!g.resultado.trim() && !g.nota.trim())} onClick={guardarG}>Guardar gestión</button>
          </div>
          <div className="cob-form">
            <h3>Promesa de pago</h3>
            <div className="rejilla cols-2">
              <Campo etiqueta="Monto prometido"><input type="number" inputMode="decimal" min="0" step="0.01" value={p.monto} onChange={(e) => setP({ ...p, monto: e.target.value })} /></Campo>
              <Campo etiqueta="Fecha prometida"><input type="date" min={hoy} value={p.fecha_promesa} onChange={(e) => setP({ ...p, fecha_promesa: e.target.value })} /></Campo>
            </div>
            <Campo etiqueta="Nota (opcional)"><input value={p.nota} onChange={(e) => setP({ ...p, nota: e.target.value })} /></Campo>
            <button className="btn" disabled={ocupado || !(Number(p.monto) > 0)} onClick={guardarP}>Registrar promesa (queda a tu nombre)</button>
          </div>
        </>)}
    </Modal>
  );
}

function Promesas({ puedeGestionar }) {
  const d = useDatos(() => get('/crm/cobranza/promesas'), []);
  const [ejecutar] = useAccion();
  const cerrar = async (id, estado) => { if (await ejecutar(() => put(`/crm/cobranza/promesas/${id}/estado`, { estado }), 'Listo')) d.recargar(); };
  return (
    <Estado d={d}>{(l) => l.length === 0 ? <Vacio titulo="Sin promesas de pago">Se registran desde el detalle de cada documento.</Vacio> : (
      <div className="tarjeta pad0"><div className="tabla-wrap"><table>
        <thead><tr><th>Cliente</th><th>Documento</th><th>Fecha</th><th className="der">Monto</th><th>Responsable</th><th>Estado</th><th></th></tr></thead>
        <tbody>{l.map((p) => (
          <tr key={p.id}><td>{p.nombre_cliente}</td><td>{p.documento}</td><td>{fmt(p.fecha_promesa)}</td><td className="der num">{lempiras(p.monto)}</td><td>{p.responsable_nombre}</td>
            <td><span className={`chip ${p.estado === 'incumplida' ? 'mal' : p.estado === 'cumplida' ? 'ok' : ''}`}>{p.estado}</span></td>
            <td className="der">{puedeGestionar && ['pendiente', 'incumplida'].includes(p.estado) && <button className="btn chico fantasma" onClick={() => cerrar(p.id, 'cancelada')}>Cancelar</button>}</td></tr>))}</tbody>
      </table></div></div>)}</Estado>
  );
}

function Recordatorios({ puedeGestionar, onCambio }) {
  const [mios, setMios] = useState(false);
  const d = useDatos(() => get(`/crm/cobranza/recordatorios?mios=${mios ? 1 : 0}`), [mios]);
  const [ejecutar, ocupado] = useAccion();
  const hoy = fechaHN();
  const [n, setN] = useState({ fecha: sumarDias(hoy, 1), titulo: '' });
  const marcar = async (id, ruta) => { if (await ejecutar(() => post(`/crm/cobranza/recordatorios/${id}/${ruta}`), 'Listo')) { d.recargar(); onCambio?.(); } };
  const crear = async () => { if (await ejecutar(() => post('/crm/cobranza/recordatorios', n), 'Recordatorio creado')) { setN({ ...n, titulo: '' }); d.recargar(); onCambio?.(); } };
  return (
    <>
      <div className="cob-barra"><label className="fila"><input type="checkbox" checked={mios} onChange={(e) => setMios(e.target.checked)} /> Solo los míos</label></div>
      <Estado d={d}>{(l) => l.length === 0 ? <Vacio titulo="Sin recordatorios pendientes" /> : (
        <div className="cob-lista">{l.map((r) => (
          <div key={r.id}><span><b className={r.fecha <= hoy ? 'cob-mal' : ''}>{fmt(r.fecha)}</b> · {r.titulo}<small>{r.detalle}{r.responsable ? ` · ${r.responsable}` : ''}</small></span>
            {puedeGestionar && <span><button className="btn chico" onClick={() => marcar(r.id, 'hecho')}>Hecho</button> <button className="btn chico fantasma" onClick={() => marcar(r.id, 'descartar')}>Descartar</button></span>}</div>))}</div>)}</Estado>
      {puedeGestionar && (
        <div className="cob-form">
          <h3>Nuevo recordatorio</h3>
          <div className="rejilla cols-2"><Campo etiqueta="Fecha"><input type="date" min={hoy} value={n.fecha} onChange={(e) => setN({ ...n, fecha: e.target.value })} /></Campo><Campo etiqueta="Qué recordar"><input value={n.titulo} onChange={(e) => setN({ ...n, titulo: e.target.value })} /></Campo></div>
          <button className="btn" disabled={ocupado || n.titulo.trim().length < 3} onClick={crear}>Agregar</button>
        </div>)}
    </>
  );
}

function EstadoCuenta({ cliente, onCerrar }) {
  const d = useDatos(() => get(`/crm/cobranza/estado-cuenta/${cliente.tercero_id}`), [cliente.tercero_id]);
  const aviso = useAviso();
  const imprimir = () => {
    const f = document.getElementById('cob-visor');
    try { f.contentWindow.focus(); f.contentWindow.print(); } catch { aviso('No se pudo abrir la impresión', 'mal'); }
  };
  return (
    <Modal titulo={`Estado de cuenta · ${cliente.nombre}`} onCerrar={onCerrar} tam="ancho" pie={<button className="btn primario" onClick={imprimir} disabled={!d.datos}>Imprimir / guardar PDF</button>}>
      <Estado d={d}>{(x) => <iframe id="cob-visor" className="cob-visor" title="Estado de cuenta" srcDoc={x.html} />}</Estado>
    </Modal>
  );
}
