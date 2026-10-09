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

