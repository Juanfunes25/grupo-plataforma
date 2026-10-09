// Directorio, tarjetas de resumen y calendario de personal. Sirve a una empresa o a todo el grupo.
import { useState } from 'react';
import { get, qs } from '../api.js';
import { fechaHN, sumarDias } from '@grupo/shared';
import { Estado, Kpi, Tabs, useDatos } from '../ui/kit.jsx';
import Ficha from './Ficha.jsx';
import PlanillaGrupo from '../planilla/PlanillaGrupo.jsx';
import { useSesion } from '../sesion.jsx';
import { qInicial } from '../busqueda/qInicial.js';
import { DIAS, ESTADOS, TIPOS_AUSENCIA, claseEstado, claseVence, fechaCorta, iniciales, nombreDe, textoVence } from './util.js';

const RUTAS = {
  grupo: { dir: '/grupo/rrhh/directorio', res: '/grupo/rrhh/resumen', cal: '/grupo/rrhh/calendario' },
  empresa: { dir: '/rrhh/personal', res: '/rrhh/resumen', cal: '/rrhh/calendario' },
};

/** Panel completo: Resumen · Directorio · Calendario, con la ficha al tocar a alguien. `acciones` = botones extra junto al directorio. */
export default function PanelRrhh({ grupo = false, acciones = null, recargaExterna = 0 }) {
  const rutas = RUTAS[grupo ? 'grupo' : 'empresa'];
  const { usuario } = useSesion();
  const conPlanilla = grupo && usuario?.es_dueno_grupo;
  const [tab, setTab] = useState('resumen');
  const [ficha, setFicha] = useState(null);
  const [version, setVersion] = useState(0);
  const abrir = (x) => setFicha({ id: x.empleado_id ?? x.id, empresa: x.empresa });
  return (
    <>
      <Tabs tabs={[['resumen', 'Resumen'], ['directorio', 'Directorio'], ['calendario', 'Calendario'], ...(conPlanilla ? [['planilla', 'Planilla']] : [])]} valor={tab} onCambio={setTab} />
      {tab === 'resumen' && <Resumen ruta={rutas.res} grupo={grupo} abrir={abrir} clave={version + recargaExterna} />}
      {tab === 'directorio' && <Directorio ruta={rutas.dir} grupo={grupo} abrir={abrir} acciones={acciones} clave={version + recargaExterna} />}
      {tab === 'planilla' && conPlanilla && <PlanillaGrupo />}
      {tab === 'calendario' && <Calendario ruta={rutas.cal} abrir={abrir} clave={version + recargaExterna} />}
      {ficha && <Ficha id={ficha.id} empresa={ficha.empresa} desdeGrupo={grupo} onCerrar={() => setFicha(null)} onCambio={() => setVersion((v) => v + 1)} />}
    </>
  );
}

const Fila = ({ x, abrir, grupo, extra }) => (
  <button className="fila espacio" style={{ background: 'none', border: 0, textAlign: 'left', width: '100%', padding: '4px 0', color: 'inherit' }} onClick={() => abrir(x)}>
    <span>{x.nombre}{grupo && <small className="tenue"> · {x.empresa}</small>}</span><small className="num">{extra}</small>
  </button>
);

export function Resumen({ ruta, grupo, abrir, clave = 0 }) {
  const d = useDatos(() => get(ruta), [ruta, clave]);
  return (
    <Estado d={d}>{(r) => (
      <>
        {r.sin_fecha_ingreso > 0 && <div className="aviso-caja">{r.sin_fecha_ingreso} empleado(s) activo(s) no tienen fecha de ingreso: sin ella no se calculan sus vacaciones ni su antigüedad.</div>}
        <div className="rejilla cols-4">
          <Kpi acento etiqueta="Personal activo" valor={r.total_activos} sub={grupo ? `${r.plantilla.length} empresas` : null} />
          <Kpi etiqueta="Altas del mes" valor={r.altas_mes.length} sub={r.altas_mes.slice(0, 2).map((x) => x.nombre).join(', ')} />
          <Kpi etiqueta="Bajas del mes" valor={r.bajas_mes.length} sub={r.bajas_mes.slice(0, 2).map((x) => x.nombre).join(', ')} />
          <Kpi etiqueta="Ausencias del mes" valor={r.ausencias_mes.eventos} sub={`${r.ausencias_mes.dias} días fuera`} />
        </div>
        {grupo && (
          <div className="rejilla cols-4">{r.plantilla.map((c) => (
            <div key={c.empresa} className="tarjeta" style={{ borderTop: `4px solid ${c.color}` }}><small className="tenue">{c.nombre}</small>
              <div className="num" style={{ fontSize: '1.8rem', fontWeight: 600 }}>{c.activos}</div><small>{c.suspendidos ? `${c.suspendidos} suspendido(s) · ` : ''}{c.bajas} baja(s) históricas</small></div>))}</div>)}
        <div className="rejilla cols-2">
          <div className="tarjeta"><h3>Contratos por vencer (60 días)</h3>{r.contratos_por_vencer.length === 0 ? <small>Ninguno.</small> : r.contratos_por_vencer.map((x) => <Fila key={x.empleado_id} x={x} abrir={abrir} grupo={grupo} extra={<span className={`chip ${claseVence(x.dias)}`}>{textoVence(x.dias)}</span>} />)}
            {r.pruebas_por_terminar.length > 0 && <><h3 style={{ marginTop: 10 }}>Períodos de prueba por terminar</h3>{r.pruebas_por_terminar.map((x) => <Fila key={x.empleado_id} x={x} abrir={abrir} grupo={grupo} extra={`en ${x.dias} d`} />)}</>}</div>
          <div className="tarjeta"><h3>Vacaciones</h3>
            {r.vacaciones_vigentes.length === 0 && r.vacaciones_proximas.length === 0 ? <small>Nadie de vacaciones ni próximas.</small> : <>
              {r.vacaciones_vigentes.map((x) => <Fila key={x.id} x={x} abrir={abrir} grupo={grupo} extra={<span className="chip aviso">hasta {fechaCorta(x.hasta)}</span>} />)}
              {r.vacaciones_proximas.map((x) => <Fila key={x.id} x={x} abrir={abrir} grupo={grupo} extra={`${fechaCorta(x.desde)} · ${x.dias} d${x.estado === 'solicitada' ? ' (solicitada)' : ''}`} />)}</>}</div>
          <div className="tarjeta"><h3>Cumpleaños (30 días)</h3>{r.cumpleanos.length === 0 ? <small>Ninguno.</small> : r.cumpleanos.map((x) => <Fila key={x.empleado_id} x={x} abrir={abrir} grupo={grupo} extra={`${fechaCorta(x.fecha).slice(0, -5)} · cumple ${x.anios}${x.en_dias === 0 ? ' · ¡hoy!' : ''}`} />)}</div>
          <div className="tarjeta"><h3>Aniversarios (30 días)</h3>{r.aniversarios.length === 0 ? <small>Ninguno.</small> : r.aniversarios.map((x) => <Fila key={x.empleado_id} x={x} abrir={abrir} grupo={grupo} extra={`${fechaCorta(x.fecha).slice(0, -5)} · ${x.anios} ${x.anios === 1 ? 'año' : 'años'}`} />)}</div>
        </div>
        {r.ausencias_mes.por_tipo.length > 0 && <div className="tarjeta"><h3>Ausencias del mes por tipo</h3><div className="fila">{r.ausencias_mes.por_tipo.map((t) => <span key={t.tipo} className="chip">{TIPOS_AUSENCIA[t.tipo]}: {t.eventos}{t.tipo === 'tardanza' ? ` (${t.minutos} min)` : ` (${t.dias} d)`}</span>)}</div></div>}
      </>
    )}</Estado>
  );
}

export function Directorio({ ruta, grupo, abrir, acciones, clave = 0 }) {
  const [f, setF] = useState(() => ({ q: qInicial(), empresa: '', sucursal_id: '', cargo: '', estado: '', vence: '' }));
  const [qDeb, setQDeb] = useState(qInicial);
  const d = useDatos(() => get(`${ruta}${qs({ ...f, q: qDeb })}`), [ruta, qDeb, f.empresa, f.sucursal_id, f.cargo, f.estado, f.vence, clave]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <>
      <div className="fila">
        <input placeholder="Buscar por nombre, cargo, teléfono, correo, código…" value={f.q} onChange={(e) => { set('q')(e); clearTimeout(window.__rhq); const v = e.target.value; window.__rhq = setTimeout(() => setQDeb(v), 300); }} style={{ flex: '1 1 240px' }} />
        {grupo && <select value={f.empresa} onChange={set('empresa')} aria-label="Empresa"><option value="">Todas las empresas</option>{(d.datos?.empresas ?? []).map((e) => <option key={e.codigo} value={e.codigo}>{e.nombre}</option>)}</select>}
        <select value={f.sucursal_id} onChange={set('sucursal_id')} aria-label="Sucursal"><option value="">Todas las sucursales</option>{(d.datos?.opciones.sucursales ?? []).filter((s) => !f.empresa || s.empresa === f.empresa).map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select>
        <select value={f.cargo} onChange={set('cargo')} aria-label="Cargo"><option value="">Todos los cargos</option>{(d.datos?.opciones.cargos ?? []).map((c) => <option key={c}>{c}</option>)}</select>
        <select value={f.estado} onChange={set('estado')} aria-label="Estado"><option value="">Todos los estados</option>{Object.entries(ESTADOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select value={f.vence} onChange={set('vence')} aria-label="Vencimiento"><option value="">Contratos: todos</option><option value="vencidos">Vencidos</option><option value="30">Vencen en 30 días</option><option value="60">En 60 días</option><option value="90">En 90 días</option></select>
        {acciones}
      </div>
      <Estado d={d}>{(r) => (
        <>
          <small>{r.total} {r.total === 1 ? 'persona' : 'personas'}</small>
          <div className="tarjeta pad0"><div className="tabla-wrap"><table>
            <thead><tr><th>Nombre</th>{grupo && <th>Empresa</th>}<th>Cargo</th><th>Sucursal</th><th>Teléfono</th><th>Ingreso</th><th>Contrato</th><th>Estado</th></tr></thead>
            <tbody>{r.empleados.map((e) => (
              <tr key={e.id} className="clic" onClick={() => abrir(e)} style={{ opacity: e.estado === 'baja' ? 0.55 : 1 }}>
                <td><div className="fila" style={{ gap: 8, flexWrap: 'nowrap' }}><span style={{ width: 30, height: 30, borderRadius: 8, background: e.empresa_color, display: 'grid', placeItems: 'center', fontSize: '.72rem', fontWeight: 700, color: '#fff', flex: 'none' }}>{iniciales(e)}</span><span>{nombreDe(e)}{e.contratos_activos > 1 && <small className="tenue"> · {e.contratos_activos} empresas</small>}</span></div></td>
                {grupo && <td><small>{e.empresa_nombre}</small></td>}
                <td>{e.puesto}</td><td>{e.sucursal}</td><td className="num">{e.telefono}</td><td className="num">{e.fecha_ingreso ? fechaCorta(e.fecha_ingreso) : <span className="chip aviso">falta</span>}</td>
                <td>{e.fecha_fin_contrato ? <span className={`chip ${claseVence(e.contrato_dias)}`}>{textoVence(e.contrato_dias)}</span> : <small className="tenue">{e.tipo_contrato === 'indefinido' ? 'indefinido' : e.tipo_contrato}</small>}</td>
                <td><span className={`chip ${claseEstado(e.estado)}`}>{e.en_vacaciones ? 'De vacaciones' : ESTADOS[e.estado]}</span></td></tr>))}</tbody>
          </table>{r.empleados.length === 0 && <div className="vacio">Nadie coincide con esos filtros.</div>}</div></div>
        </>
      )}</Estado>
    </>
  );
}

// Calendario mensual de vacaciones y ausencias: cada día muestra cuánta gente falta; al tocarlo se ve quién.
export function Calendario({ ruta, abrir, clave = 0 }) {
  const hoy = fechaHN();
  const [mes, setMes] = useState(hoy.slice(0, 7));
  const [dia, setDia] = useState(hoy);
  const [y, m] = mes.split('-').map(Number);
  const primero = `${mes}-01`, ultimo = sumarDias(`${y + (m === 12 ? 1 : 0)}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`, -1);
  const d = useDatos(() => get(`${ruta}${qs({ desde: primero, hasta: ultimo })}`), [ruta, mes, clave]);
  const mover = (n) => { const t = new Date(Date.UTC(y, m - 1 + n, 1)); setMes(t.toISOString().slice(0, 7)); };
  const offset = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;   // lunes primero
  const nDias = Number(ultimo.slice(8));
  return (
    <Estado d={d}>{(r) => {
      const en = (f) => r.eventos.filter((e) => e.desde <= f && e.hasta >= f);
      const delDia = en(dia);
      return (
        <>
          <div className="fila espacio"><button className="btn chico" onClick={() => mover(-1)}>‹</button><b style={{ textTransform: 'capitalize' }}>{new Intl.DateTimeFormat('es-HN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)))}</b><button className="btn chico" onClick={() => mover(1)}>›</button></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
            {[1, 2, 3, 4, 5, 6, 0].map((i) => <small key={i} className="tenue" style={{ textAlign: 'center' }}>{DIAS[i].slice(0, 3)}</small>)}
            {Array.from({ length: offset }, (_, i) => <div key={`v${i}`} />)}
            {Array.from({ length: nDias }, (_, i) => {
              const f = `${mes}-${String(i + 1).padStart(2, '0')}`, ev = en(f), vac = ev.filter((e) => e.clase === 'vacaciones').length, aus = ev.length - vac;
              return (
                <button key={f} onClick={() => setDia(f)} style={{ minHeight: 52, borderRadius: 8, border: `1px solid ${f === dia ? 'var(--acento)' : 'var(--borde)'}`, background: f === hoy ? 'var(--panel-3)' : 'var(--panel)', color: 'inherit', padding: 3, display: 'grid', alignContent: 'space-between', justifyItems: 'center' }}>
                  <span className="num" style={{ fontSize: '.8rem' }}>{i + 1}</span>
                  <span className="fila" style={{ gap: 2, flexWrap: 'nowrap' }}>{vac > 0 && <span className="chip ok" style={{ padding: '0 6px' }}>{vac}</span>}{aus > 0 && <span className="chip aviso" style={{ padding: '0 6px' }}>{aus}</span>}</span>
                </button>);
            })}
          </div>
          <small><span className="chip ok">n</span> vacaciones · <span className="chip aviso">n</span> ausencias, permisos e incapacidades</small>
          <div className="tarjeta"><h3>{fechaCorta(dia)}</h3>
            {delDia.length === 0 ? <small>Nadie ausente ese día.</small> : delDia.map((e) => (
              <button key={`${e.clase}${e.id}`} className="fila espacio" onClick={() => abrir(e)} style={{ background: 'none', border: 0, width: '100%', textAlign: 'left', color: 'inherit', padding: '4px 0' }}>
                <span><i style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 3, background: e.color, marginRight: 8 }} />{e.nombre} <small className="tenue">· {e.empresa}</small></span>
                <small>{e.clase === 'vacaciones' ? 'Vacaciones' : TIPOS_AUSENCIA[e.tipo]} · {fechaCorta(e.desde).slice(0, -5)}{e.hasta !== e.desde ? ` al ${fechaCorta(e.hasta).slice(0, -5)}` : ''}{e.estado === 'solicitada' || e.estado === 'pendiente' ? ' (pendiente)' : ''}</small>
              </button>))}</div>
        </>
      );
    }}</Estado>
  );
}
