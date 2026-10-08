// Pantallas operativas de Personal: horarios, asistencia y horas, vacaciones, ausencias e importación de fechas de ingreso.
import { useState } from 'react';
import { numero } from '@grupo/shared';
import { get, post, put, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Estado, Kpi, descargarCsv, useAccion, useAviso, useDatos } from '../ui/kit.jsx';
import { HorarioForm } from './Ficha.jsx';
import { DIAS, DIAS_ORDEN, TIPOS_AUSENCIA, fechaCorta, hora, nombreDe } from './util.js';

const hh = (iso) => (iso ? new Intl.DateTimeFormat('es-HN', { timeZone: 'America/Tegucigalpa', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) : '');

// ── Horarios de toda la empresa ─────────────────────────────────────────────
export function Horarios() {
  const { puede } = useSesion();
  const d = useDatos(() => get('/rrhh/horarios'), []);
  const sucs = useDatos(() => get('/rrhh/sucursales-geo'), []);
  const [edit, setEdit] = useState(null);
  const ed = puede('rrhh:editar');
  const celda = (h) => !h ? '' : h.estado === 'turno' ? `${hora(h.entrada)}–${hora(h.salida)}` : { libre: 'Libre', otra_tienda: 'Otra tienda', vacaciones: 'Vacac.' }[h.estado];
  return (
    <Estado d={d}>{(l) => (
      <>
        <small>{ed ? 'Toca a una persona para cambiar su horario.' : 'Horario semanal de cada persona.'}</small>
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Persona</th>{DIAS_ORDEN.map((i) => <th key={i}>{DIAS[i].slice(0, 3)}</th>)}</tr></thead>
          <tbody>{l.map((e) => { const por = Object.fromEntries(e.horarios.map((h) => [h.dia_semana, h])); return (
            <tr key={e.empleado_id} className={ed ? 'clic' : ''} onClick={() => ed && setEdit({ e, por })}>
              <td>{nombreDe(e)}<br /><small className="tenue">{e.sucursal}</small></td>
              {DIAS_ORDEN.map((i) => <td key={i} className="num" style={{ fontSize: '.82rem', whiteSpace: 'nowrap', color: por[i]?.estado === 'turno' ? undefined : 'var(--tenue)' }}>{celda(por[i])}{por[i]?.sucursal_id && por[i].estado === 'turno' ? ' *' : ''}</td>)}</tr>); })}</tbody>
        </table>{l.length === 0 && <div className="vacio">Sin personal.</div>}</div></div>
        <small>* trabaja ese día en otra sucursal.</small>
        {edit && <HorarioForm por={edit.por} sucs={sucs.datos ?? []} onCerrar={() => { setEdit(null); d.recargar(); }} onGuardar={async (horarios) => { await put(`/rrhh/empleados/${edit.e.empleado_id}/horarios`, { horarios }); }} />}
      </>
    )}</Estado>
  );
}

// ── Asistencia: tiendas abiertas + horas de la quincena ─────────────────────
export function Asistencia() {
  const q = useDatos(() => get('/rrhh/quincena-actual'), []);
  const [rango, setRango] = useState(null);
  const r = rango ?? q.datos;
  const panel = useDatos(() => get('/rrhh/panel'), []);
  const rep = useDatos(() => (r ? get(`/rrhh/reporte-horas${qs({ desde: r.desde, hasta: r.hasta })}`) : Promise.resolve(null)), [r?.desde, r?.hasta]);
  const [abierto, setAbierto] = useState(null);
  return (
    <>
      <Estado d={panel}>{(p) => (
        <>
          {p.sin_abrir.map((s) => <div key={s.sucursal_id} className="aviso-caja mal">{s.nombre}: nadie ha marcado entrada y ya van {s.minutos_de_atraso} min de atraso.</div>)}
          <div className="rejilla cols-4">{p.sucursales.map((s) => (
            <div key={s.sucursal_id} className="tarjeta"><small className="tenue">{s.nombre}</small>
              <div><span className={`chip ${s.abrio ? 'ok' : 'aviso'}`}>{s.abrio ? 'abrió' : 'sin abrir'}</span>{s.sospechosas > 0 && <span className="chip mal" style={{ marginLeft: 6 }}>{s.sospechosas} lejos</span>}</div>
              <small>{s.marcaciones.map((m) => `${m.nombres} ${m.tipo === 'entrada' ? '→' : '←'} ${hh(m.marcada_at)}`).join(' · ')}</small></div>))}</div>
        </>)}</Estado>
      <h2>Horas trabajadas</h2>
      {r && <div className="fila"><input type="date" value={r.desde} onChange={(e) => setRango({ ...r, desde: e.target.value })} style={{ width: 160 }} /><input type="date" value={r.hasta} onChange={(e) => setRango({ ...r, hasta: e.target.value })} style={{ width: 160 }} />
        <button className="btn chico" onClick={() => setRango(q.datos)}>Quincena actual</button>
        {rep.datos && <button className="btn chico" onClick={() => descargarCsv(`horas-${r.desde}-${r.hasta}.csv`, rep.datos.empleados.map((e) => ({ n: nombreDe(e), s: e.sucursal ?? '', d: e.dias_trabajados, h: e.total_horas, i: e.turnos_incompletos })), [['n', 'Empleado'], ['s', 'Sucursal'], ['d', 'Días'], ['h', 'Horas'], ['i', 'Turnos sin salida']])}>Descargar CSV</button>}</div>}
      <Estado d={rep}>{(x) => !x ? null : (
        <>
          <div className="rejilla cols-3"><Kpi etiqueta="Horas totales" valor={numero(x.total_horas, 1)} /><Kpi etiqueta="Turnos incompletos" valor={x.total_incompletos} sub="entrada sin salida: no suman horas" /></div>
          <div className="tarjeta pad0"><div className="tabla-wrap"><table>
            <thead><tr><th>Empleado</th><th>Sucursal</th><th className="der">Días</th><th className="der">Horas</th><th className="der">Sin salida</th><th className="der">Lejos</th></tr></thead>
            <tbody>{x.empleados.map((e) => (
              <tr key={e.id} className="clic" onClick={() => setAbierto(abierto === e.id ? null : e.id)}>
                <td>{nombreDe(e)}{abierto === e.id && <div style={{ marginTop: 6 }}>{e.turnos.map((t, i) => <div key={i}><small>{fechaCorta(t.fecha)}: {t.entrada ? hh(t.entrada) : '??'} – {t.salida ? hh(t.salida) : '??'} {t.horas != null ? `(${numero(t.horas, 2)} h)` : <b style={{ color: 'var(--aviso)' }}>incompleto</b>}{t.lejos ? ' · lejos' : ''}</small></div>)}</div>}</td>
                <td>{e.sucursal}</td><td className="der num">{e.dias_trabajados}</td><td className="der num"><b>{numero(e.total_horas, 2)}</b></td>
                <td className="der">{e.turnos_incompletos > 0 && <span className="chip aviso">{e.turnos_incompletos}</span>}</td><td className="der">{e.marcaciones_lejos > 0 && <span className="chip mal">{e.marcaciones_lejos}</span>}</td></tr>))}</tbody>
          </table></div></div>
        </>)}</Estado>
    </>
  );
}

// ── Vacaciones y ausencias de la empresa (para aprobar) ────────────────────
export function VacacionesLista({ onFicha }) {
  const { puede } = useSesion();
  const d = useDatos(() => get('/rrhh/vacaciones'), []);
  const [ejecutar] = useAccion();
  const ed = puede('rrhh:editar');
  const resolver = async (v, estado) => {
    let motivo_rechazo; if (estado === 'rechazada') { motivo_rechazo = window.prompt('Motivo del rechazo'); if (!motivo_rechazo) return; }
    try { await ejecutar(() => put(`/rrhh/vacaciones/${v.id}`, { estado, motivo_rechazo })); }
    finally { d.recargar(); }
  };
  return (
    <Estado d={d}>{(l) => (
      <div className="tarjeta pad0"><div className="tabla-wrap"><table>
        <thead><tr><th>Empleado</th><th>Desde</th><th>Hasta</th><th className="der">Días</th><th>Estado</th><th></th></tr></thead>
        <tbody>{l.map((v) => <tr key={v.id}><td><button className="btn chico fantasma" onClick={() => onFicha(v.empleado_id)}>{nombreDe(v)}</button></td><td className="num">{fechaCorta(v.desde)}</td><td className="num">{fechaCorta(v.hasta)}</td><td className="der num">{v.dias}</td>
          <td><span className={`chip ${v.estado === 'aprobada' || v.estado === 'tomada' ? 'ok' : v.estado === 'rechazada' ? 'mal' : 'aviso'}`}>{v.estado}</span></td>
          <td className="der">{ed && v.estado === 'solicitada' && <><button className="btn chico" onClick={() => resolver(v, 'aprobada')}>Aprobar</button> <button className="btn chico fantasma" onClick={() => resolver(v, 'rechazada')}>Rechazar</button></>}</td></tr>)}</tbody>
      </table>{l.length === 0 && <div className="vacio">Sin vacaciones registradas. Se registran desde la ficha de cada persona.</div>}</div></div>
    )}</Estado>
  );
}

export function AusenciasLista({ onFicha }) {
  const { puede } = useSesion();
  const [tipo, setTipo] = useState('');
  const d = useDatos(() => get(`/rrhh/ausencias${qs({ tipo })}`), [tipo]);
  const [ejecutar] = useAccion();
  const ed = puede('rrhh:editar');
  return (
    <>
      <div className="fila"><select value={tipo} onChange={(e) => setTipo(e.target.value)} aria-label="Tipo"><option value="">Todos los tipos</option>{Object.entries(TIPOS_AUSENCIA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select><small>Últimos y próximos 60 días. Se registran desde la ficha de cada persona.</small></div>
      <Estado d={d}>{(l) => (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Empleado</th><th>Tipo</th><th>Fechas</th><th className="der">Días</th><th>Pago</th><th>Estado</th><th></th></tr></thead>
          <tbody>{l.map((a) => <tr key={a.id}><td><button className="btn chico fantasma" onClick={() => onFicha(a.empleado_id)}>{nombreDe(a)}</button></td><td>{TIPOS_AUSENCIA[a.tipo]}</td>
            <td className="num">{fechaCorta(a.desde)}{a.hasta !== a.desde ? ` – ${fechaCorta(a.hasta)}` : ''}</td><td className="der num">{a.tipo === 'tardanza' ? `${a.minutos} min` : Number(a.dias)}</td><td>{a.tipo !== 'tardanza' && (a.pagado ? 'con goce' : 'sin goce')}</td>
            <td><span className={`chip ${a.estado === 'aprobada' ? 'ok' : a.estado === 'rechazada' ? 'mal' : 'aviso'}`}>{a.estado}</span></td>
            <td className="der">{ed && a.estado === 'pendiente' && <><button className="btn chico" onClick={async () => { await ejecutar(() => put(`/rrhh/ausencias/${a.id}`, { estado: 'aprobada' }), 'Aprobada'); d.recargar(); }}>Aprobar</button> <button className="btn chico fantasma" onClick={async () => { await ejecutar(() => put(`/rrhh/ausencias/${a.id}`, { estado: 'rechazada' }), 'Rechazada'); d.recargar(); }}>Rechazar</button></>}</td></tr>)}</tbody>
        </table>{l.length === 0 && <div className="vacio">Sin registros en el período.</div>}</div></div>
      )}</Estado>
    </>
  );
}

// ── Importar fechas de ingreso desde la planilla de contratos (Italo) ──────
export function ImportarFechas() {
  const avisar = useAviso();
  const d = useDatos(() => get('/rrhh/fechas-ingreso/propuesta'), []);
  const [sel, setSel] = useState({});   // empleado_id → opción elegida (fecha_ingreso|nombre|cargo)
  const [legal, setLegal] = useState(false), [cargo, setCargo] = useState(true);
  const [ejecutar, ocupado] = useAccion();
  return (
    <Estado d={d}>{(p) => {
      const elegida = (c) => sel[c.empleado_id] !== undefined ? sel[c.empleado_id] : (c.sugerencia && (c.estado === 'segura' || c.estado === 'parecida') ? c.sugerencia : null);
      const lista = p.cruces.map((c) => ({ c, o: elegida(c) })).filter((x) => x.o?.fecha_ingreso);
      const guardar = async () => {
        const r = await ejecutar(() => post('/rrhh/fechas-ingreso', { usar_nombre_legal: legal, usar_cargo: cargo, cambios: lista.map(({ c, o }) => ({ empleado_id: c.empleado_id, fecha_ingreso: o.fecha_ingreso, nombre_completo: o.nombre_completo, cargo: o.cargo })) }));
        if (r && r !== true) { avisar(`${r.guardados} fechas guardadas`); d.recargar(); setSel({}); }
      };
      return (
        <>
          <div className="aviso-caja">Cruza el nombre corto de cada empleado con la planilla de contratos. Las coincidencias seguras vienen marcadas; las dudosas las eliges tú. Nada se guarda hasta que confirmes.</div>
          <div className="tarjeta pad0"><div className="tabla-wrap"><table>
            <thead><tr><th>Empleado</th><th>Hoy</th><th>Planilla</th><th>Estado</th></tr></thead>
            <tbody>{p.cruces.map((c) => { const o = elegida(c); return (
              <tr key={c.empleado_id}><td>{c.nombre_app}<br /><small className="tenue">{c.sucursal_nombre}</small></td><td className="num">{c.fecha_actual ? fechaCorta(c.fecha_actual) : <span className="chip aviso">falta</span>}</td>
                <td><select value={o ? o.nombre_completo : ''} onChange={(e) => setSel({ ...sel, [c.empleado_id]: p.planilla.find((x) => x.nombre_completo === e.target.value) ?? null })} style={{ maxWidth: 300 }}>
                  <option value="">— no cambiar —</option>{(c.opciones.length ? c.opciones : p.planilla).map((x) => <option key={x.nombre_completo} value={x.nombre_completo}>{x.nombre_completo} · {x.fecha_ingreso ?? 'sin fecha'}</option>)}</select></td>
                <td><span className={`chip ${c.estado === 'segura' ? 'ok' : c.estado === 'sin_match' ? 'mal' : 'aviso'}`}>{c.estado.replace('_', ' ')}</span>{c.motivoDuda && <small> {c.motivoDuda}</small>}</td></tr>); })}</tbody>
          </table></div></div>
          <label className="fila"><input type="checkbox" checked={cargo} onChange={(e) => setCargo(e.target.checked)} /> También poner el cargo de la planilla</label>
          <label className="fila"><input type="checkbox" checked={legal} onChange={(e) => setLegal(e.target.checked)} /> También reemplazar el nombre corto por el nombre legal completo</label>
          <div><button className="btn primario" disabled={ocupado || lista.length === 0} onClick={guardar}>Guardar {lista.length} fecha(s)</button></div>
          {p.sinEmpleado.length > 0 && <div className="tarjeta"><h3>En la planilla pero sin cruzar</h3><small>{p.sinEmpleado.map((x) => x.nombre_completo).join(' · ')}</small></div>}
        </>
      );
    }}</Estado>
  );
}

