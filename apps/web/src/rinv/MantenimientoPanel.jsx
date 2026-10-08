import { useMemo, useState } from 'react';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, Tabs, useAccion, useAviso, useDatos } from '../ui/kit.jsx';
import { rdel, rget, rpatch, rpost } from './api.js';
import { Chip, fechaCorta, hoyIso } from './comun.jsx';

const Fila = ({ m, onToggle, onBorrar }) => (
  <div className="rv-fila" style={{ opacity: m.listo ? 0.55 : 1, alignItems: 'flex-start' }}>
    <input type="checkbox" checked={m.listo} onChange={() => onToggle(m)} aria-label={`Marcar ${m.equipo} como resuelto`} style={{ marginTop: 4 }} />
    <div className="info"><b style={{ textDecoration: m.listo ? 'line-through' : 'none' }}>{m.equipo}</b>
      {m.descripcion && <span className="tenue" style={{ fontStyle: 'italic' }}>{m.descripcion}</span>}
      <span className="tenue">{m.sucursal_nombre || 'Fábrica'} · {fechaCorta(m.fecha)}{m.listo ? ' · resuelto' : ''}</span></div>
    <button className="btn chico fantasma" onClick={() => onBorrar(m)} aria-label={`Borrar ${m.equipo}`}>✕</button>
  </div>
);

/**
 * Lista de equipos dañados: aire, congelador, lo que sea. Tres vistas porque son tres momentos: una tienda anotando algo que
 * acaba de ver, el técnico parado en una sucursal, y una mirada rápida a todo lo pendiente.
 */
export default function MantenimientoPanel() {
  const { sucursales, sucursalId } = useSesion();
  const avisar = useAviso();
  const [modo, setModo] = useState(() => { try { const g = localStorage.getItem('rinv.mant.modo'); return ['reportar', 'sucursal', 'pendientes'].includes(g) ? g : 'reportar'; } catch { return 'reportar'; } });
  const d = useDatos(() => rget('/mantenimiento?todos=1'), []);
  const lista = d.datos ?? [];
  const [ejecutar] = useAccion();
  const cambiarModo = (m) => { setModo(m); try { localStorage.setItem('rinv.mant.modo', m); } catch { /* */ } };
  const toggle = async (m) => { if (await ejecutar(() => rpatch(`/mantenimiento/${m.id}`, { listo: !m.listo }))) d.recargar(); };
  const borrar = async (m) => { if (!window.confirm(`¿Borrar "${m.equipo}"?`)) return; if (await ejecutar(() => rdel(`/mantenimiento/${m.id}`))) d.recargar(); };
  const pendientes = lista.filter((m) => !m.listo);
  return (
    <div className="rejilla">
      <Tabs valor={modo} onCambio={cambiarModo} tabs={[['reportar', '📝 Reportar'], ['sucursal', '🏬 Por sucursal'], ['pendientes', `✅ Pendientes${pendientes.length ? ` (${pendientes.length})` : ''}`]]} />
      {modo === 'reportar' && <Reportar sucursales={sucursales} inicial={sucursalId} onListo={d.recargar} />}
      {modo === 'sucursal' && <PorSucursal lista={lista} sucursales={sucursales} cargando={d.cargando && !d.datos} onToggle={toggle} onBorrar={borrar} />}
      {modo === 'pendientes' && <Estado d={d}>{() => (pendientes.length ? <div className="tarjeta pad0">{pendientes.map((m) => <Fila key={m.id} m={m} onToggle={toggle} onBorrar={borrar} />)}</div> : <div className="aviso-caja ok">✅ No hay nada pendiente de arreglar.</div>)}</Estado>}
    </div>
  );
}

function Reportar({ sucursales, inicial, onListo }) {
  const avisar = useAviso();
  const [equipo, setEquipo] = useState(''); const [desc, setDesc] = useState(''); const [suc, setSuc] = useState(inicial || ''); const [fecha, setFecha] = useState(hoyIso());
  const [ejecutar, ocupado] = useAccion();
  async function agregar() {
    if (equipo.trim().length < 2) return avisar('Di qué equipo se dañó', 'mal');
    if (!suc) return avisar('Elige la sucursal', 'mal');
    if (await ejecutar(() => rpost('/mantenimiento', { equipo: equipo.trim(), descripcion: desc.trim(), sucursal_id: suc, fecha }), '✓ Anotado')) { setEquipo(''); setDesc(''); onListo?.(); }
  }
  return (
    <div className="tarjeta rejilla">
      <h2>Anotar algo dañado</h2>
      <Campo etiqueta="Qué se dañó"><input value={equipo} onChange={(e) => setEquipo(e.target.value)} placeholder="Aire acondicionado, congelador, vitrina…" /></Campo>
      <Campo etiqueta="Qué está pasando (opcional)" ayuda="«Máquina de café» no dice si es el filtro, la caldera o algo más: cuenta un poco."><textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Ej: no enfría, hace un ruido raro, se apagó sola…" /></Campo>
      <Campo etiqueta="Dónde"><select value={suc} onChange={(e) => setSuc(e.target.value)}><option value="" disabled>Elige tu sucursal…</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select></Campo>
      <Campo etiqueta="Fecha"><input type="date" value={fecha} max={hoyIso()} onChange={(e) => setFecha(e.target.value)} /></Campo>
      <button className="btn primario grande" disabled={ocupado} onClick={agregar}>+ Anotar</button>
    </div>
  );
}

function PorSucursal({ lista, sucursales, cargando, onToggle, onBorrar }) {
  const [suc, setSuc] = useState(''); const [desde, setDesde] = useState(''); const [hasta, setHasta] = useState(''); const [resueltos, setResueltos] = useState(false);
  const f = useMemo(() => lista.filter((m) => (!suc || m.sucursal_id === suc) && (!desde || m.fecha >= desde) && (!hasta || m.fecha <= hasta)), [lista, suc, desde, hasta]);
  const pend = f.filter((m) => !m.listo); const res = f.filter((m) => m.listo);
  return (
    <div className="rejilla">
      <div className="tabs"><button className={!suc ? 'activa' : ''} onClick={() => setSuc('')}>Todas</button>{sucursales.map((s) => <button key={s.id} className={suc === s.id ? 'activa' : ''} onClick={() => setSuc(s.id)}>{s.nombre}</button>)}</div>
      <div className="fila"><input type="date" aria-label="Desde" value={desde} max={hasta || undefined} onChange={(e) => setDesde(e.target.value)} style={{ flex: 1 }} /><span className="tenue">a</span><input type="date" aria-label="Hasta" value={hasta} min={desde || undefined} onChange={(e) => setHasta(e.target.value)} style={{ flex: 1 }} />{(desde || hasta) && <button className="btn chico" onClick={() => { setDesde(''); setHasta(''); }} aria-label="Quitar filtro de fecha">✕</button>}</div>
      <h3>{resueltos ? 'Todo' : 'Pendiente'} {pend.length > 0 && !resueltos && <Chip>{pend.length}</Chip>}</h3>
      {cargando && <div className="vacio">Cargando…</div>}
      {!cargando && !pend.length && !resueltos && <div className="aviso-caja ok">✅ Nada pendiente con este filtro.</div>}
      {(resueltos ? f : pend).length > 0 && <div className="tarjeta pad0">{(resueltos ? [...pend, ...res] : pend).map((m) => <Fila key={m.id} m={m} onToggle={onToggle} onBorrar={onBorrar} />)}</div>}
      {res.length > 0 && <button className="btn chico" onClick={() => setResueltos((v) => !v)}>{resueltos ? 'Ocultar lo ya resuelto' : `Ver lo ya resuelto (${res.length})`}</button>}
    </div>
  );
}
