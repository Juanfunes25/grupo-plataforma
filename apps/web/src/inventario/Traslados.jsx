// Traslados con documento: salida en el origen, entrada confirmada en el destino, registro intercompañía entre empresas.
import { useState } from 'react';
import { lempiras, numero } from '@grupo/shared';
import { get, post } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, Modal, Vacio, useAccion, useAviso, useDatos, usePedirTexto } from '../ui/kit.jsx';

const ESTADO = { en_transito: ['En tránsito', 'bajo'], recibido: ['Recibido', 'ok'], anulado: ['Anulado', 'sin_cargar'] };
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Imprime el documento en una ventana aparte (funciona con la impresión silenciosa de Chrome en las tiendas). */
export function imprimirTraslado(t) {
  const filas = t.lineas.map((l) => `<tr><td>${esc(l.nombre)}</td><td class="d">${numero(l.cantidad, 2)} ${esc(l.unidad)}</td><td class="d">${l.cantidad_recibida == null ? '' : numero(l.cantidad_recibida, 2)}</td></tr>`).join('');
  const w = window.open('', '_blank', 'width=820,height=900');
  if (!w) return false;
  w.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Traslado ${esc(t.numero_doc)}</title><style>
    body{font:13px/1.4 system-ui,Arial,sans-serif;margin:24px;color:#000} h1{font-size:20px;margin:0} table{width:100%;border-collapse:collapse;margin-top:14px}
    th,td{border:1px solid #444;padding:6px 8px;text-align:left} th{background:#eee} .d{text-align:right} .firmas{display:flex;gap:40px;margin-top:70px} .firmas div{flex:1;border-top:1px solid #000;padding-top:4px;text-align:center}
    .meta{display:grid;grid-template-columns:1fr 1fr;gap:6px 24px;margin-top:12px}</style></head><body>
    <h1>DOCUMENTO DE TRASLADO ${esc(t.numero_doc)}</h1><div>${esc(t.origen.empresa)} → ${esc(t.destino.empresa)} · ${new Date(t.created_at).toLocaleString('es-HN', { timeZone: 'America/Tegucigalpa' })}</div>
    <div class="meta"><div><b>Sale de:</b> ${esc(t.origen.empresa)}${t.origen.sucursal ? ' · ' + esc(t.origen.sucursal) : ''}</div><div><b>Entra a:</b> ${esc(t.destino.empresa)}${t.destino.sucursal ? ' · ' + esc(t.destino.sucursal) : ''}</div>
    <div><b>Despachó:</b> ${esc(t.creado_por_nombre)}</div><div><b>Estado:</b> ${esc(ESTADO[t.estado][0])}${t.recibido_por_nombre ? ' · recibió ' + esc(t.recibido_por_nombre) : ''}</div></div>
    ${t.notas ? `<p><b>Notas:</b> ${esc(t.notas)}</p>` : ''}
    <table><thead><tr><th>Producto</th><th class="d">Enviado</th><th class="d">Recibido</th></tr></thead><tbody>${filas}</tbody></table>
    ${t.valor_total != null ? `<p><b>Valor al costo:</b> ${esc(lempiras(t.valor_total))}</p>` : ''}
    <div class="firmas"><div>Entregó</div><div>Transportó</div><div>Recibió</div></div></body></html>`);
  w.document.close(); w.focus(); setTimeout(() => w.print(), 250);
  return true;
}

export function Traslados() {
  const { puede, contexto } = useSesion();
  const [vista, setVista] = useState('todos');
  const d = useDatos(() => get(`/inv/u/traslados?vista=${vista}`), [vista]);
  const [nuevo, setNuevo] = useState(false);
  const [abierto, setAbierto] = useState(null);
  return (
    <>
      <div className="iu-filtros">
        <select value={vista} onChange={(e) => setVista(e.target.value)} aria-label="Ver"><option value="todos">Todos</option><option value="enviados">Que envié</option><option value="por_recibir">Por recibir</option></select>
        {puede('inv:mover') && <button className="btn primario" onClick={() => setNuevo(true)}>+ Nuevo traslado</button>}
      </div>
      <Estado d={d}>{(rows) => rows.length === 0 ? <Vacio titulo="Sin traslados">Mueve mercadería entre sucursales o a otra empresa del grupo, con documento.</Vacio> : (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Documento</th><th>De → A</th><th>Fecha</th><th className="der">Líneas</th><th>Estado</th></tr></thead>
          <tbody>{rows.map((t) => (
            <tr key={t.id} onClick={() => setAbierto(t.id)} style={{ cursor: 'pointer' }}>
              <td className="num"><b>{t.numero_doc}</b>{t.direccion === 'recibo' && t.estado === 'en_transito' && <span className="iu-estado bajo"> por recibir</span>}</td>
              <td>{t.origen.sucursal ?? t.origen.empresa} → {t.destino.sucursal ?? t.destino.empresa}{t.entre_empresas && <small> · entre empresas</small>}</td>
              <td className="num">{new Date(t.created_at).toLocaleDateString('es-HN', { timeZone: 'America/Tegucigalpa' })}</td><td className="der num">{t.lineas}</td>
              <td><span className={`iu-estado ${ESTADO[t.estado][1]}`}>{ESTADO[t.estado][0]}</span>{t.con_diferencia && <small> con diferencia</small>}</td></tr>))}</tbody>
        </table></div></div>
      )}</Estado>
      {nuevo && <Nuevo onCerrar={() => setNuevo(false)} onListo={(t) => { setNuevo(false); d.recargar(); setAbierto(t.id); }} actual={contexto?.empresa?.codigo} />}
      {abierto && <Detalle id={abierto} onCerrar={() => { setAbierto(null); d.recargar(); }} />}
    </>
  );
}

function Nuevo({ onCerrar, onListo, actual }) {
  const destinos = useDatos(() => get('/inv/u/destinos'), []);
  const ex = useDatos(() => get('/inv/u/existencias'), []);
  const [f, setF] = useState({ destino: actual, origen: '', dsuc: '', notas: '' });
  const [lineas, setLineas] = useState([]);
  const [q, setQ] = useState('');
  const [ejecutar, ocupado] = useAccion();
  const dest = destinos.datos?.find((x) => x.codigo === f.destino);
  const misma = f.destino === actual;
  const sucOrigen = ex.datos?.filtros.sucursales ?? [];
  const items = (ex.datos?.items ?? []).filter((i) => i.fuente !== 'fab_piedra' && i.existencia > 0 && (!i.sucursal_id || !f.origen || i.sucursal_id === f.origen)
    && !lineas.some((l) => l.clave === i.clave) && (!q || i.nombre.toLowerCase().includes(q.toLowerCase()))).slice(0, 12);
  const needSuc = sucOrigen.length > 0;
  const ok = lineas.length > 0 && lineas.every((l) => Number(l.cantidad) > 0 && Number(l.cantidad) <= l.max) && (!needSuc || f.origen) && (!misma || f.dsuc);
  const crear = () => ejecutar(async () => {
    const t = await post('/inv/u/traslados', { destino: f.destino, origen_sucursal_id: f.origen || null, destino_sucursal_id: f.dsuc || null, notas: f.notas || null, lineas: lineas.map((l) => ({ fuente: l.fuente, ref_id: l.ref_id, cantidad: Number(l.cantidad) })) });
    onListo(t);
  }, 'Traslado creado: la mercadería ya salió de tu inventario');
  return (
    <Modal titulo="Nuevo traslado" tam="ancho" onCerrar={onCerrar} pie={<button className="btn primario" disabled={!ok || ocupado} onClick={crear}>Crear y despachar</button>}>
      <Estado d={destinos}>{() => (
        <div style={{ display: 'grid', gap: 12 }}>
          <Campo etiqueta="Destino"><select value={f.destino} onChange={(e) => setF({ ...f, destino: e.target.value, dsuc: '' })}>{destinos.datos.map((e) => <option key={e.codigo} value={e.codigo}>{e.es_actual ? `${e.nombre} (otra sucursal)` : e.nombre}</option>)}</select></Campo>
          {sucOrigen.length > 0 && <Campo etiqueta="Sale de la sucursal"><select value={f.origen} onChange={(e) => { setF({ ...f, origen: e.target.value }); setLineas([]); }}><option value="">Elige…</option>{sucOrigen.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select></Campo>}
          {dest && dest.sucursales.length > 1 && dest.con_sucursales && <Campo etiqueta="Entra a la sucursal" ayuda={misma ? '' : 'Puede elegirla quien reciba.'}><select value={f.dsuc} onChange={(e) => setF({ ...f, dsuc: e.target.value })}><option value="">{misma ? 'Elige…' : 'La elige quien recibe'}</option>{dest.sucursales.filter((s) => !misma || s.id !== f.origen).map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select></Campo>}
          <Campo etiqueta="Agregar productos"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar producto con existencia…" /></Campo>
          {q && <div style={{ display: 'grid', gap: 4 }}>{items.map((i) => <button key={i.clave} className="btn" style={{ justifyContent: 'space-between' }} onClick={() => { setLineas([...lineas, { ...i, cantidad: '', max: i.existencia }]); setQ(''); }}><span>{i.nombre}{i.sucursal ? ` · ${i.sucursal}` : ''}</span><span>{numero(i.existencia, 2)} {i.unidad}</span></button>)}{items.length === 0 && <small>Nada con ese nombre{f.origen ? ' en esa sucursal' : ''}.</small>}</div>}
          {lineas.map((l, i) => (
            <div key={l.clave} className="iu-cap"><div><b>{l.nombre}</b><small>Hay {numero(l.max, 2)} {l.unidad}</small></div>
              <div className="iu-cantidad"><input type="number" inputMode="decimal" min="0" max={l.max} value={l.cantidad} onChange={(e) => setLineas(lineas.map((x, k) => (k === i ? { ...x, cantidad: e.target.value } : x)))} aria-label={`Cantidad de ${l.nombre}`} />
                <button className="btn fantasma" onClick={() => setLineas(lineas.filter((_, k) => k !== i))} aria-label="Quitar">×</button></div></div>))}
          <Campo etiqueta="Notas (opcional)"><input value={f.notas} onChange={(e) => setF({ ...f, notas: e.target.value })} /></Campo>
        </div>
      )}</Estado>
    </Modal>
  );
}

function Detalle({ id, onCerrar }) {
  const { puede } = useSesion();
  const d = useDatos(() => get(`/inv/u/traslados/${id}`), [id]);
  const [ejecutar, ocupado] = useAccion();
  const pedir = usePedirTexto(); const avisar = useAviso();
  const [rec, setRec] = useState({});
  const [suc, setSuc] = useState('');
  const sucs = useDatos(() => get('/inv/u/existencias?q=__'), []);
  return (
    <Modal titulo="Traslado" tam="ancho" onCerrar={onCerrar}>
      <Estado d={d}>{(t) => {
        const recibiendo = t.estado === 'en_transito' && t.soy_destino && puede('inv:mover');
        const necesitaSuc = recibiendo && (sucs.datos?.filtros.sucursales.length ?? 0) > 0 && !t.sucursal_destino_id;
        return (
          <div style={{ display: 'grid', gap: 12 }}>
            <div><b style={{ fontSize: '1.2rem' }}>{t.numero_doc}</b> <span className={`iu-estado ${ESTADO[t.estado][1]}`}>{ESTADO[t.estado][0]}</span></div>
            <div>De <b>{t.origen.sucursal ?? t.origen.empresa}</b> ({t.origen.empresa}) a <b>{t.destino.sucursal ?? t.destino.empresa}</b> ({t.destino.empresa}) · despachó {t.creado_por_nombre}</div>
            {t.notas && <div><small>{t.notas}</small></div>}
            <div className="tarjeta pad0"><div className="tabla-wrap"><table>
              <thead><tr><th>Producto</th><th className="der">Enviado</th><th className="der">{recibiendo ? 'Llegó' : 'Recibido'}</th>{recibiendo && t.entre_empresas && <th>Corresponde en tu inventario</th>}</tr></thead>
              <tbody>{t.lineas.map((l) => (
                <tr key={l.id}><td>{l.nombre}</td><td className="der num">{numero(l.cantidad, 2)} {l.unidad}</td>
                  <td className="der num">{recibiendo ? <input type="number" inputMode="decimal" min="0" max={l.cantidad} style={{ width: 96 }} value={rec[l.id]?.cantidad ?? l.cantidad} onChange={(e) => setRec({ ...rec, [l.id]: { ...rec[l.id], cantidad: e.target.value } })} aria-label={`Llegó de ${l.nombre}`} /> : l.cantidad_recibida == null ? '—' : numero(l.cantidad_recibida, 2)}</td>
                  {recibiendo && t.entre_empresas && <td><select value={rec[l.id]?.destino ?? (l.fuente_destino ? `${l.fuente_destino}|${l.ref_destino}` : '')} onChange={(e) => setRec({ ...rec, [l.id]: { ...rec[l.id], destino: e.target.value } })}>
                    <option value="">Elige…</option>{(t.catalogo_destino ?? []).map((i) => <option key={`${i.fuente}${i.ref_id}`} value={`${i.fuente}|${i.ref_id}`}>{i.nombre} ({i.unidad})</option>)}</select></td>}</tr>))}</tbody>
            </table></div></div>
            {t.valor_total != null && <small>Valor al costo: {lempiras(t.valor_total)}{t.intercompania_id ? ' · registro intercompañía creado para Finanzas' : ''}</small>}
            {t.nota_recepcion && <div className="aviso-caja">{t.nota_recepcion}</div>}
            {necesitaSuc && <Campo etiqueta="Sucursal que recibe"><select value={suc} onChange={(e) => setSuc(e.target.value)}><option value="">Elige…</option>{sucs.datos.filtros.sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select></Campo>}
            <div className="iu-barra">
              <button className="btn" onClick={() => imprimirTraslado(t) || avisar('Permite las ventanas emergentes para imprimir', 'mal')}>Imprimir documento</button>
              {recibiendo && <button className="btn primario" disabled={ocupado || (necesitaSuc && !suc)} onClick={() => ejecutar(async () => {
                const lineas = t.lineas.map((l) => { const x = rec[l.id] ?? {}; const [fd, rd] = (x.destino ?? '').split('|'); return { id: l.id, cantidad_recibida: Number(x.cantidad ?? l.cantidad), ...(fd ? { fuente_destino: fd, ref_destino: rd } : {}) }; });
                const r = await post(`/inv/u/traslados/${id}/recibir`, { lineas, sucursal_id: suc || null });
                if (r.con_diferencia) avisar('Recibido con diferencia: queda anotada en el documento');
                await d.recargar();
              }, 'Recibido: ya está en tu inventario')}>Confirmar recepción</button>}
              {t.estado === 'en_transito' && t.soy_origen && puede('inv:mover') && <button className="btn peligro" disabled={ocupado} onClick={async () => {
                const motivo = await pedir({ titulo: 'Anular traslado', mensaje: 'La mercadería regresa a tu inventario.', etiqueta: 'Motivo', obligatorio: true, minimo: 3, textoOk: 'Anular' });
                if (motivo) ejecutar(async () => { await post(`/inv/u/traslados/${id}/anular`, { motivo }); await d.recargar(); }, 'Traslado anulado');
              }}>Anular</button>}
            </div>
          </div>
        );
      }}</Estado>
    </Modal>
  );
}
