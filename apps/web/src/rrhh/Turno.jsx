// Control de turno en la tienda: marcar entrada/salida (con ubicación).
import { useState } from 'react';
import { get, post, put, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Estado, Modal, useAccion, useAviso, useDatos } from '../ui/kit.jsx';
import Form from './Form.jsx';
import { hora, nombreDe } from './util.js';

/** Pide la ubicación al navegador sin bloquear: si no la da, la marca se guarda "sin ubicación". */
export function ubicacion() {
  return new Promise((ok) => {
    if (!navigator.geolocation) return ok({});
    navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lon: p.coords.longitude }), () => ok({}), { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 });
  });
}
const hh = (iso) => new Intl.DateTimeFormat('es-HN', { timeZone: 'America/Tegucigalpa', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
const VER = { dentro: ['en la tienda', 'ok'], lejos: ['lejos de la tienda', 'mal'], sin_ubicacion: ['sin ubicación', 'aviso'], sin_configurar: ['tienda sin ubicación', ''] };

export function SelectorSucursal({ valor, onCambio }) {
  const { sucursales } = useSesion();
  if (sucursales.length <= 1) return null;
  return <select value={valor} onChange={(e) => onCambio(e.target.value)} aria-label="Sucursal">{sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select>;
}

export function Turno() {
  const { sucursales, puede } = useSesion();
  const [suc, setSuc] = useState(sucursales[0]?.id ?? '');
  const d = useDatos(() => get(`/rrhh/turno/hoy${qs({ sucursal_id: suc })}`), [suc]);
  const avisar = useAviso();
  const [ejecutar, ocupado] = useAccion();
  const [geo, setGeo] = useState(false);
  const marcar = async (e) => {
    const pos = await ubicacion();
    const r = await ejecutar(() => post('/rrhh/turno/marcar', { empleado_id: e.id, sucursal_id: suc || undefined, ...pos }));
    if (r && r !== true) {
      const [txt] = VER[r.verificacion];
      avisar(`${e.nombres}: ${r.tipo === 'entrada' ? 'entrada' : 'salida'} registrada (${txt})`, r.verificacion === 'lejos' ? 'mal' : 'ok');
      d.recargar();
    }
  };
  return (
    <>
      <div className="fila espacio"><SelectorSucursal valor={suc} onCambio={setSuc} />
        {puede('rrhh:editar') && <button className="btn chico" onClick={() => setGeo(true)}>Ubicación de la tienda</button>}</div>
      <Estado d={d}>{(r) => (
        <>
          {!r.geo_configurada && <div className="aviso-caja">Esta tienda aún no tiene su ubicación configurada: las marcaciones se guardan pero no se pueden verificar.</div>}
          <div className="rejilla cols-3">
            {r.empleados.map((e) => {
              const h = e.horario_hoy;
              return (
                <div key={e.id} className="tarjeta" style={{ display: 'grid', gap: 8, borderLeft: `4px solid ${e.adentro ? 'var(--ok)' : 'var(--borde)'}` }}>
                  <div><b>{nombreDe(e)}</b>{e.de_otra_tienda && <span className="chip" style={{ marginLeft: 6 }}>cubre aquí</span>}<div className="tenue">{e.puesto}</div>
                    <small>{e.en_vacaciones ? 'De vacaciones' : h?.estado === 'turno' ? `Hoy ${hora(h.entrada)} – ${hora(h.salida)}` : h ? { libre: 'Libre hoy', otra_tienda: 'Cubre otra tienda hoy', vacaciones: 'Vacaciones' }[h.estado] : 'Sin horario'}</small></div>
                  <div className="fila" style={{ gap: 6 }}>{e.marcas.map((m, i) => <span key={i} className={`chip ${VER[m.verificacion][1]}`} title={VER[m.verificacion][0]}>{m.tipo === 'entrada' ? '→' : '←'} {hh(m.marcada_at)}</span>)}</div>
                  <button className={`btn grande ${e.adentro ? '' : 'primario'}`} disabled={ocupado || e.estado === 'suspendido'} onClick={() => marcar(e)}>{e.adentro ? 'Marcar salida' : 'Marcar entrada'}</button>
                </div>);
            })}
          </div>
          {r.empleados.length === 0 && <div className="vacio">No hay personal asignado a esta sucursal.</div>}
        </>
      )}</Estado>
      {geo && <GeoModal sucursalId={suc} onCerrar={() => { setGeo(false); d.recargar(); }} />}
    </>
  );
}

function GeoModal({ sucursalId, onCerrar }) {
  const g = useDatos(() => get('/rrhh/sucursales-geo'), []);
  const s = g.datos?.find((x) => x.id === sucursalId);
  const [f, setF] = useState(null);
  const [ejecutar, ocupado] = useAccion();
  const usar = f ?? { lat: s?.lat ?? '', lon: s?.lon ?? '', radio_metros: s?.radio_metros ?? 150 };
  return (
    <Modal titulo={`Ubicación de ${s?.nombre ?? 'la tienda'}`} onCerrar={onCerrar} tam="angosto" pie={<button className="btn primario" disabled={ocupado || usar.lat === '' || usar.lon === ''} onClick={async () => { if (await ejecutar(() => put(`/rrhh/sucursales/${sucursalId}/geo`, { lat: Number(usar.lat), lon: Number(usar.lon), radio_metros: Number(usar.radio_metros) }), 'Ubicación guardada')) onCerrar(); }}>Guardar</button>}>
      <small>Párate dentro de la tienda y toca «Usar mi ubicación». Las marcaciones hechas fuera del radio se guardan igual pero quedan señaladas.</small>
      <button className="btn" onClick={async () => { const p = await ubicacion(); if (p.lat) setF({ ...usar, lat: p.lat.toFixed(6), lon: p.lon.toFixed(6) }); }}>Usar mi ubicación</button>
      <div className="rejilla cols-2"><label>Latitud<input value={usar.lat} onChange={(e) => setF({ ...usar, lat: e.target.value })} inputMode="decimal" /></label><label>Longitud<input value={usar.lon} onChange={(e) => setF({ ...usar, lon: e.target.value })} inputMode="decimal" /></label></div>
      <label>Radio permitido (metros)<input value={usar.radio_metros} onChange={(e) => setF({ ...usar, radio_metros: e.target.value })} inputMode="numeric" /></label>
    </Modal>
  );
}

export function Checklist({ sucursalId, compacto = false }) {
  const { sucursales, puede } = useSesion();
  const [suc, setSuc] = useState(sucursalId || sucursales[0]?.id || '');
  const sid = compacto ? sucursalId : suc;
  const d = useDatos(() => get(`/rrhh/checklist${qs({ sucursal_id: sid })}`), [sid]);
  const [ejecutar] = useAccion();
  const [cat, setCat] = useState(false);
  const alternar = (momento, it) => ejecutar(async () => { await post('/rrhh/checklist', { sucursal_id: sid || undefined, momento, item_id: it.id, ok: !it.ok }); d.recargar(); });
  return (
    <>
      {!compacto && <div className="fila espacio"><SelectorSucursal valor={suc} onCambio={setSuc} />{puede('rrhh:editar') && <button className="btn chico" onClick={() => setCat(true)}>Editar lista</button>}</div>}
      <Estado d={d}>{(r) => (
        <div className="rejilla cols-2">
          {['apertura', 'cierre'].map((m) => (
            <div key={m} className="tarjeta" style={{ display: 'grid', gap: 6 }}>
              <div className="fila espacio"><h3>{m === 'apertura' ? 'Apertura' : 'Cierre'} · {r.sucursal.nombre}</h3><span className={`chip ${r[m].hechos === r[m].total && r[m].total > 0 ? 'ok' : 'aviso'}`}>{r[m].hechos}/{r[m].total}</span></div>
              {r[m].items.map((it) => (
                <label key={it.id} className="fila" style={{ gap: 10, minHeight: 40 }}>
                  <input type="checkbox" checked={it.ok} disabled={!puede('rrhh:asistencia')} onChange={() => alternar(m, it)} style={{ width: 22, height: 22 }} />
                  <span style={{ flex: 1, textDecoration: it.ok ? 'line-through' : 'none', opacity: it.ok ? 0.6 : 1 }}>{it.texto}</span>{it.ok && it.at && <small className="tenue">{hh(it.at)}</small>}
                </label>))}
              {r[m].total === 0 && <small>Sin puntos configurados.</small>}
            </div>))}
        </div>
      )}</Estado>
      {cat && <CatalogoModal sid={sid} onCerrar={() => { setCat(false); d.recargar(); }} />}
      {!compacto && <Resumen14 />}
    </>
  );
}

function Resumen14() {
  const d = useDatos(() => get('/rrhh/checklist/resumen'), []);
  return (
    <Estado d={d}>{(l) => l.length === 0 ? null : (
      <div className="tarjeta pad0"><div className="tabla-wrap"><table>
        <thead><tr><th>Fecha</th><th>Sucursal</th><th>Momento</th><th className="der">Cumplimiento</th></tr></thead>
        <tbody>{l.slice(0, 40).map((x, i) => <tr key={i}><td className="num">{x.fecha}</td><td>{x.sucursal}</td><td>{x.momento}</td><td className="der"><span className={`chip ${x.hechos === x.total ? 'ok' : 'aviso'}`}>{x.hechos}/{x.total}</span></td></tr>)}</tbody>
      </table></div></div>)}</Estado>
  );
}

function CatalogoModal({ sid, onCerrar }) {
  const todos = useDatos(() => get(`/rrhh/checklist${qs({ sucursal_id: sid })}`), [sid]);
  const [nuevo, setNuevo] = useState(null);
  const [ejecutar] = useAccion();
  return (
    <Modal titulo="Puntos del checklist" onCerrar={onCerrar}>
      <Estado d={todos}>{(r) => ['apertura', 'cierre'].map((m) => (
        <div key={m} style={{ display: 'grid', gap: 6 }}>
          <div className="fila espacio"><h3>{m === 'apertura' ? 'Apertura' : 'Cierre'}</h3><button className="btn chico" onClick={() => setNuevo({ momento: m })}>+ Punto</button></div>
          {r[m].items.map((it) => <div key={it.id} className="fila espacio"><span>{it.texto}</span><button className="btn chico fantasma" onClick={() => ejecutar(async () => { await put(`/rrhh/checklist/catalogo/${it.id}`, { activo: false }); todos.recargar(); })}>Quitar</button></div>)}
        </div>))}</Estado>
      {nuevo && <Form titulo="Nuevo punto" campos={[{ k: 'texto', etiqueta: 'Qué se revisa', req: true, ancho: true }]} onCerrar={() => setNuevo(null)} onGuardar={async (v) => { await post('/rrhh/checklist/catalogo', { momento: nuevo.momento, texto: v.texto }); todos.recargar(); return true; }} />}
    </Modal>
  );
}
