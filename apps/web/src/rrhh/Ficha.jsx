// FICHA del empleado: la misma pantalla para Personal (cada empresa) y Dirección del grupo.
// Lee todo con una llamada y edita contra el API de la empresa del empleado (X-Empresa = su empresa).
import { useState } from 'react';
import { lempiras, numero } from '@grupo/shared';
import { get, put } from '../api.js';
import { Estado, Kpi, Modal, Tabs, useAccion, useDatos } from '../ui/kit.jsx';
import Adjuntos from '../documentos/Adjuntos.jsx';
import Form from './Form.jsx';
import { Vacaciones, Ausencias, Historial } from './FichaMas.jsx';
import {
  DIAS, DIAS_ORDEN, ESTADOS, SITUACION, TIPOS_BAJA, TIPOS_CONTRATO, TIPOS_PAGO, claseEstado, fechaCorta, hora, iniciales, nombreDe,
} from './util.js';

const TABS = [['datos', 'Datos'], ['empleo', 'Empleo'], ['vacaciones', 'Vacaciones'], ['ausencias', 'Ausencias y permisos'], ['asistencia', 'Asistencia'], ['documentos', 'Documentos'], ['historial', 'Historial']];

export default function Ficha({ id, empresa, desdeGrupo = false, onCerrar, onCambio }) {
  const [tab, setTab] = useState('datos');
  const d = useDatos(() => (desdeGrupo ? get(`/grupo/rrhh/empleados/${id}`) : get(`/rrhh/empleados/${id}/ficha`, { empresa })), [id, empresa, desdeGrupo]);
  const recargar = () => { d.recargar(); onCambio?.(); };
  return (
    <Modal titulo={d.datos ? nombreDe(d.datos.persona) : 'Ficha del empleado'} onCerrar={onCerrar} tam="ancho">
      <Estado d={d}>{(f) => {
        const emp = f.empleado, per = f.persona, ctx = { f, empresa: emp.empresa, id, recargar };
        return (
          <>
            <div className="fila" style={{ alignItems: 'center' }}>
              {per.foto_url ? <img src={per.foto_url} alt="" style={{ width: 64, height: 64, borderRadius: 14, objectFit: 'cover' }} />
                : <div style={{ width: 64, height: 64, borderRadius: 14, background: emp.empresa_color ?? 'var(--panel-3)', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: '1.3rem', color: '#fff' }}>{iniciales(per)}</div>}
              <div style={{ flex: 1, minWidth: 180 }}>
                <b style={{ fontSize: '1.1rem' }}>{nombreDe(per)}</b>
                <div className="tenue">{emp.puesto}{emp.departamento ? ` · ${emp.departamento}` : ''}</div>
                <div className="fila" style={{ gap: 6, marginTop: 4 }}>
                  <span className="chip" style={{ borderLeft: `4px solid ${emp.empresa_color ?? 'transparent'}` }}>{emp.empresa_nombre}</span>
                  {emp.sucursal && <span className="chip">{emp.sucursal}</span>}
                  <span className={`chip ${claseEstado(emp.estado)}`}>{ESTADOS[emp.estado]}</span>
                  {f.vacaciones.vigentes.length > 0 && <span className="chip aviso">de vacaciones hasta {fechaCorta(f.vacaciones.vigentes[0].hasta)}</span>}
                  {f.otros_contratos.map((c) => <span key={c.empleado_id} className="chip" title={c.puesto}>también en {c.empresa_nombre}</span>)}
                </div>
              </div>
            </div>
            <Tabs tabs={TABS} valor={tab} onCambio={setTab} />
            {tab === 'datos' && <Datos {...ctx} />}
            {tab === 'empleo' && <Empleo {...ctx} />}
            {tab === 'vacaciones' && <Vacaciones {...ctx} />}
            {tab === 'ausencias' && <Ausencias {...ctx} />}
            {tab === 'asistencia' && <Asistencia {...ctx} />}
            {tab === 'documentos' && <Adjuntos empleadoId={id} empresa={emp.empresa} />}
            {tab === 'historial' && <Historial {...ctx} />}
          </>
        );
      }}</Estado>
    </Modal>
  );
}

const Dato = ({ etiqueta, children }) => <div><small className="tenue">{etiqueta}</small><div>{children || children === 0 ? children : <span className="tenue">—</span>}</div></div>;
const Oculto = () => <span className="chip" title="Solo el dueño o el administrador ven este dato">oculto</span>;

// ── Datos personales ────────────────────────────────────────────────────────
export function camposPersona(sensible) {
  return [
    { seccion: 'Datos personales' },
    { k: 'foto_url', tipo: 'foto' },
    { k: 'nombres', etiqueta: 'Nombres', req: true }, { k: 'apellidos', etiqueta: 'Apellidos' },
    ...(sensible ? [{ k: 'identidad', etiqueta: 'Identidad', placeholder: '0000-0000-00000', ayuda: 'Formato 0000-0000-00000 (13 dígitos)' }, { k: 'rtn', etiqueta: 'RTN', ayuda: '14 dígitos' }] : []),
    { k: 'fecha_nacimiento', etiqueta: 'Fecha de nacimiento', tipo: 'date' },
    { k: 'sexo', etiqueta: 'Sexo', tipo: 'select', opciones: [['F', 'Femenino'], ['M', 'Masculino'], ['O', 'Otro']] },
    { k: 'estado_civil', etiqueta: 'Estado civil', tipo: 'select', opciones: [['soltero', 'Soltero/a'], ['casado', 'Casado/a'], ['union_libre', 'Unión libre'], ['divorciado', 'Divorciado/a'], ['viudo', 'Viudo/a']] },
    { k: 'nacionalidad', etiqueta: 'Nacionalidad' },
    { seccion: 'Contacto' },
    { k: 'telefono', etiqueta: 'Teléfono' }, { k: 'telefono2', etiqueta: 'Otro teléfono' },
    { k: 'whatsapp', etiqueta: 'WhatsApp' }, { k: 'correo', etiqueta: 'Correo', tipo: 'email' },
    { k: 'direccion', etiqueta: 'Dirección', ancho: true }, { k: 'ciudad', etiqueta: 'Ciudad / colonia' },
    { seccion: 'Contacto de emergencia' },
    { k: 'emergencia_nombre', etiqueta: 'Nombre' }, { k: 'emergencia_parentesco', etiqueta: 'Parentesco' },
    { k: 'emergencia_telefono', etiqueta: 'Teléfono' }, { k: 'emergencia_telefono2', etiqueta: 'Otro teléfono' },
    { seccion: 'Seguridad social' },
    { k: 'ihss_numero', etiqueta: 'No. IHSS' }, { k: 'rap_numero', etiqueta: 'No. RAP' }, { k: 'infop_numero', etiqueta: 'No. INFOP' },
    ...(sensible ? [{ seccion: 'Datos bancarios (planilla)' }, { k: 'banco', etiqueta: 'Banco' }, { k: 'tipo_cuenta', etiqueta: 'Tipo de cuenta', tipo: 'select', opciones: [['ahorro', 'Ahorro'], ['cheque', 'Cheque']] }, { k: 'cuenta_bancaria', etiqueta: 'No. de cuenta' }] : []),
    { seccion: 'Uniforme' },
    { k: 'talla_camisa', etiqueta: 'Talla de camisa' }, { k: 'talla_pantalon', etiqueta: 'Talla de pantalón' }, { k: 'talla_calzado', etiqueta: 'Talla de calzado' },
  ];
}

function Datos({ f, empresa, id, recargar }) {
  const per = f.persona, sens = f.permisos.sensible;
  const [edit, setEdit] = useState(false);
  const inicial = { ...per, identidad: per.identidad_formato && sens ? per.identidad_formato : '' };
  return (
    <>
      {f.permisos.editar && <div><button className="btn primario chico" onClick={() => setEdit(true)}>Editar datos</button></div>}
      <div className="tarjeta rejilla cols-3">
        <Dato etiqueta="Identidad">{sens ? per.identidad_formato : <>{per.identidad_formato} <Oculto /></>}</Dato>
        <Dato etiqueta="RTN">{sens ? per.rtn : <Oculto />}</Dato>
        <Dato etiqueta="Fecha de nacimiento">{per.fecha_nacimiento ? `${fechaCorta(per.fecha_nacimiento)} (${f.empleado.edad} años)` : null}</Dato>
        <Dato etiqueta="Sexo">{{ F: 'Femenino', M: 'Masculino', O: 'Otro' }[per.sexo]}</Dato>
        <Dato etiqueta="Estado civil">{per.estado_civil?.replace('_', ' ')}</Dato>
        <Dato etiqueta="Nacionalidad">{per.nacionalidad}</Dato>
      </div>
      <div className="tarjeta rejilla cols-3">
        <Dato etiqueta="Teléfono">{per.telefono && <a href={`tel:${per.telefono}`}>{per.telefono}</a>}</Dato>
        <Dato etiqueta="Otro teléfono">{per.telefono2}</Dato>
        <Dato etiqueta="WhatsApp">{per.whatsapp && <a href={`https://wa.me/504${String(per.whatsapp).replace(/\D/g, '').slice(-8)}`} target="_blank" rel="noreferrer">{per.whatsapp}</a>}</Dato>
        <Dato etiqueta="Correo">{per.correo && <a href={`mailto:${per.correo}`}>{per.correo}</a>}</Dato>
        <Dato etiqueta="Dirección">{[per.direccion, per.ciudad].filter(Boolean).join(', ')}</Dato>
      </div>
      <div className="tarjeta rejilla cols-3">
        <Dato etiqueta="Contacto de emergencia">{per.emergencia_nombre}{per.emergencia_parentesco ? ` (${per.emergencia_parentesco})` : ''}</Dato>
        <Dato etiqueta="Teléfono de emergencia">{[per.emergencia_telefono, per.emergencia_telefono2].filter(Boolean).join(' / ')}</Dato>
      </div>
      <div className="tarjeta rejilla cols-3">
        <Dato etiqueta="IHSS">{per.ihss_numero}</Dato><Dato etiqueta="RAP">{per.rap_numero}</Dato><Dato etiqueta="INFOP">{per.infop_numero}</Dato>
        <Dato etiqueta="Banco">{sens ? per.banco : (per.tiene_cuenta ? <Oculto /> : null)}</Dato>
        <Dato etiqueta="Cuenta">{sens ? [per.tipo_cuenta, per.cuenta_bancaria].filter(Boolean).join(' · ') : (per.tiene_cuenta ? <>{per.cuenta_bancaria_mascara} <Oculto /></> : null)}</Dato>
        <Dato etiqueta="Tallas (camisa / pantalón / calzado)">{[per.talla_camisa, per.talla_pantalon, per.talla_calzado].some(Boolean) ? [per.talla_camisa, per.talla_pantalon, per.talla_calzado].map((x) => x || '—').join(' / ') : null}</Dato>
      </div>
      {edit && <Form titulo="Editar datos del empleado" campos={camposPersona(sens)} inicial={inicial} soloCambios onCerrar={() => setEdit(false)}
        onGuardar={async (datos) => { if (!Object.keys(datos).length) return true; await put(`/rrhh/empleados/${id}`, datos, { empresa }); recargar(); return true; }} />}
    </>
  );
}

// ── Empleo: contrato, pago, horario, jefe, estado ──────────────────────────
function Empleo({ f, empresa, id, recargar }) {
  const emp = f.empleado, sens = f.permisos.sensible, ed = f.permisos.editar;
  const [modal, setModal] = useState(null);
  const sucs = useDatos(() => (ed ? get('/rrhh/sucursales-geo', { empresa }) : Promise.resolve([])), [empresa, ed]);
  const jefes = useDatos(() => (ed ? get('/rrhh/empleados', { empresa }) : Promise.resolve([])), [empresa, ed]);
  const campos = [
    { seccion: 'Puesto' },
    { k: 'puesto', etiqueta: 'Cargo / puesto', req: true }, { k: 'departamento', etiqueta: 'Departamento' },
    { k: 'codigo', etiqueta: 'No. de empleado' },
    { k: 'sucursal_id', etiqueta: 'Sucursal principal', tipo: 'select', opciones: (sucs.datos ?? []).map((s) => [s.id, s.nombre]) },
    { k: 'jefe_id', etiqueta: 'Jefe directo', tipo: 'select', opciones: (jefes.datos ?? []).filter((j) => j.id !== id && j.estado !== 'baja').map((j) => [j.id, `${j.nombres} ${j.apellidos}`.trim()]) },
    { seccion: 'Contrato' },
    { k: 'fecha_ingreso', etiqueta: 'Fecha de ingreso', tipo: 'date' }, { k: 'fecha_fin_prueba', etiqueta: 'Fin del período de prueba', tipo: 'date' },
    { k: 'tipo_contrato', etiqueta: 'Tipo de contrato', tipo: 'select', opciones: Object.entries(TIPOS_CONTRATO) },
    { k: 'fecha_inicio_contrato', etiqueta: 'Inicio del contrato', tipo: 'date' }, { k: 'fecha_fin_contrato', etiqueta: 'Vencimiento del contrato', tipo: 'date', ayuda: 'Déjalo vacío si es indefinido' },
    { k: 'jornada', etiqueta: 'Jornada', tipo: 'select', opciones: [['diurna', 'Diurna'], ['mixta', 'Mixta'], ['nocturna', 'Nocturna']] }, { k: 'horas_semana', etiqueta: 'Horas por semana', tipo: 'number' },
    ...(sens ? [
      { seccion: 'Pago' },
      { k: 'tipo_pago', etiqueta: 'Tipo de pago', tipo: 'select', opciones: Object.entries(TIPOS_PAGO) },
      { k: 'salario_mensual', etiqueta: 'Salario mensual (L)', tipo: 'number' }, { k: 'salario_hora', etiqueta: 'Salario por hora (L)', tipo: 'number' },
      { k: 'motivo_salario', etiqueta: 'Motivo del cambio de salario', ayuda: 'Se guarda en el historial salarial' },
    ] : []),
    { seccion: 'Notas' }, { k: 'notas', etiqueta: 'Notas internas', tipo: 'textarea', ancho: true },
  ];
  const nombreJefe = emp.jefe_nombre?.trim();
  return (
    <>
      {ed && <div className="fila"><button className="btn primario chico" onClick={() => setModal('editar')}>Editar empleo</button>
        {emp.estado === 'activo' && <><button className="btn chico" onClick={() => setModal('suspender')}>Suspender</button><button className="btn chico peligro" onClick={() => setModal('baja')}>Dar de baja</button></>}
        {(emp.estado === 'suspendido' || emp.estado === 'baja') && <button className="btn chico" onClick={() => setModal('reactivar')}>{emp.estado === 'baja' ? 'Reingresar' : 'Reactivar'}</button>}</div>}
      {emp.estado !== 'activo' && emp.estado !== 'vacaciones' && <div className={`aviso-caja ${emp.estado === 'baja' ? 'mal' : ''}`}><b>{ESTADOS[emp.estado]}</b> desde {fechaCorta(emp.estado_desde)}{emp.tipo_baja ? ` (${TIPOS_BAJA[emp.tipo_baja]})` : ''}: {emp.motivo_estado}</div>}
      <div className="rejilla cols-4">
        <Kpi etiqueta="Antigüedad" valor={emp.antiguedad_meses == null ? '—' : `${Math.floor(emp.antiguedad_meses / 12)} a ${emp.antiguedad_meses % 12} m`} sub={emp.fecha_ingreso ? `desde ${fechaCorta(emp.fecha_ingreso)}` : 'falta la fecha de ingreso'} />
        <Kpi etiqueta="Contrato" valor={TIPOS_CONTRATO[emp.tipo_contrato]} sub={emp.fecha_fin_contrato ? `vence ${fechaCorta(emp.fecha_fin_contrato)}` : 'sin vencimiento'} />
        <Kpi etiqueta="Salario" valor={emp.salario_oculto ? 'oculto' : emp.salario_mensual != null ? lempiras(emp.salario_mensual) : emp.salario_hora != null ? `${lempiras(emp.salario_hora)}/h` : '—'} sub={TIPOS_PAGO[emp.tipo_pago]} />
        <Kpi etiqueta="Prueba" valor={emp.fecha_fin_prueba ? fechaCorta(emp.fecha_fin_prueba) : '—'} sub="fin del período de prueba" />
      </div>
      <div className="tarjeta rejilla cols-3">
        <Dato etiqueta="Empresa">{emp.empresa_nombre}</Dato><Dato etiqueta="Sucursal principal">{emp.sucursal}</Dato>
        <Dato etiqueta="También en sucursales">{emp.sucursales_extra.map((s) => s.nombre).join(', ')}</Dato>
        <Dato etiqueta="Cargo">{emp.puesto}</Dato><Dato etiqueta="Departamento">{emp.departamento}</Dato><Dato etiqueta="No. de empleado">{emp.codigo}</Dato>
        <Dato etiqueta="Jefe directo">{nombreJefe}</Dato><Dato etiqueta="Jornada">{emp.jornada}{emp.horas_semana ? ` · ${numero(emp.horas_semana, 0)} h/sem` : ''}</Dato>
        <Dato etiqueta="Notas">{emp.notas}</Dato>
      </div>
      {f.otros_contratos.length > 0 && <div className="tarjeta"><h3>También trabaja en</h3>{f.otros_contratos.map((c) => <div key={c.empleado_id}>{c.empresa_nombre} · {c.puesto}{c.sucursal ? ` · ${c.sucursal}` : ''} <span className={`chip ${claseEstado(c.estado)}`}>{ESTADOS[c.estado]}</span></div>)}</div>}
      <Horario f={f} id={id} empresa={empresa} recargar={recargar} sucs={sucs.datos ?? []} />
      {modal === 'editar' && <Form titulo="Editar empleo y contrato" campos={campos} soloCambios inicial={{ ...emp, motivo_salario: '' }} onCerrar={() => setModal(null)}
        onGuardar={async (datos) => { if (!Object.keys(datos).length) return true; await put(`/rrhh/empleados/${id}`, datos, { empresa }); recargar(); return true; }} />}
      {(modal === 'suspender' || modal === 'baja') && <Form titulo={modal === 'baja' ? 'Dar de baja' : 'Suspender'} onCerrar={() => setModal(null)} textoGuardar="Confirmar"
        inicial={{ estado_desde: f.hoy, tipo_baja: 'renuncia' }}
        campos={[{ k: 'motivo_estado', etiqueta: 'Motivo', tipo: 'textarea', req: true, ancho: true }, { k: 'estado_desde', etiqueta: modal === 'baja' ? 'Fecha de la baja' : 'Suspendido desde', tipo: 'date', req: true },
          ...(modal === 'baja' ? [{ k: 'tipo_baja', etiqueta: 'Tipo de baja', tipo: 'select', opciones: Object.entries(TIPOS_BAJA), req: true }] : [])]}
        onGuardar={async (d) => { await put(`/rrhh/empleados/${id}`, { ...d, estado: modal === 'baja' ? 'baja' : 'suspendido' }, { empresa }); recargar(); return true; }} />}
      {modal === 'reactivar' && <Form titulo={emp.estado === 'baja' ? 'Reingreso' : 'Reactivar'} onCerrar={() => setModal(null)} textoGuardar="Confirmar" inicial={{ estado_desde: f.hoy }}
        campos={[{ k: 'estado_desde', etiqueta: 'Fecha', tipo: 'date', req: true }]} onGuardar={async (d) => { await put(`/rrhh/empleados/${id}`, { estado: 'activo', estado_desde: d.estado_desde }, { empresa }); recargar(); return true; }} />}
    </>
  );
}

function Horario({ f, id, empresa, recargar, sucs }) {
  const ed = f.permisos.editar;
  const [edit, setEdit] = useState(false);
  const por = Object.fromEntries(f.horarios.map((h) => [h.dia_semana, h]));
  return (
    <div className="tarjeta" style={{ display: 'grid', gap: 8 }}>
      <div className="fila espacio"><h3>Horario semanal</h3>{ed && <button className="btn chico" onClick={() => setEdit(true)}>Editar horario</button>}</div>
      {f.horarios.length === 0 ? <small>Sin horario cargado.</small> : (
        <div className="tabla-wrap"><table><tbody>{DIAS_ORDEN.map((d) => { const h = por[d]; return (
          <tr key={d}><td>{DIAS[d]}</td><td>{!h ? <span className="tenue">—</span> : h.estado === 'turno' ? <b className="num">{hora(h.entrada)} – {hora(h.salida)}{h.sucursal ? ` · en ${h.sucursal}` : ''}</b> : <span className="chip">{{ libre: 'Libre', otra_tienda: 'Cubre otra tienda', vacaciones: 'Vacaciones' }[h.estado]}</span>}</td></tr>); })}</tbody></table></div>)}
      {edit && <HorarioForm por={por} sucs={sucs} onCerrar={() => setEdit(false)} onGuardar={async (horarios) => { await put(`/rrhh/empleados/${id}/horarios`, { horarios }, { empresa }); recargar(); }} />}
    </div>
  );
}

export function HorarioForm({ por, sucs, onCerrar, onGuardar }) {
  const [h, setH] = useState(() => Object.fromEntries(DIAS_ORDEN.map((d) => [d, por[d] ? { ...por[d], entrada: hora(por[d].entrada), salida: hora(por[d].salida) } : { estado: 'libre', entrada: '', salida: '' }])));
  const [ejecutar, ocupado] = useAccion();
  const set = (d, k, v) => setH((x) => ({ ...x, [d]: { ...x[d], [k]: v } }));
  const malos = DIAS_ORDEN.some((d) => h[d].estado === 'turno' && (!h[d].entrada || !h[d].salida));
  const guardar = async () => {
    const r = await ejecutar(() => onGuardar(DIAS_ORDEN.map((d) => ({ dia_semana: d, estado: h[d].estado, entrada: h[d].estado === 'turno' ? h[d].entrada : null, salida: h[d].estado === 'turno' ? h[d].salida : null, sucursal_id: h[d].estado === 'turno' ? h[d].sucursal_id || null : null }))), 'Horario guardado');
    if (r) onCerrar();
  };
  return (
    <Modal titulo="Horario semanal" onCerrar={onCerrar} pie={<button className="btn primario" disabled={ocupado || malos} onClick={guardar}>Guardar</button>}>
      {DIAS_ORDEN.map((d) => (
        <div key={d} className="fila" style={{ gap: 8 }}>
          <b style={{ width: 86 }}>{DIAS[d]}</b>
          <select value={h[d].estado} onChange={(e) => set(d, 'estado', e.target.value)} style={{ width: 150 }}><option value="turno">Trabaja</option><option value="libre">Libre</option><option value="otra_tienda">Cubre otra tienda</option><option value="vacaciones">Vacaciones</option></select>
          {h[d].estado === 'turno' && <>
            <input type="time" value={h[d].entrada} onChange={(e) => set(d, 'entrada', e.target.value)} style={{ width: 110 }} /> <input type="time" value={h[d].salida} onChange={(e) => set(d, 'salida', e.target.value)} style={{ width: 110 }} />
            {sucs.length > 1 && <select value={h[d].sucursal_id ?? ''} onChange={(e) => set(d, 'sucursal_id', e.target.value)} style={{ width: 150 }}><option value="">Su sucursal</option>{sucs.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select>}</>}
        </div>))}
    </Modal>
  );
}

// ── Asistencia (últimos 31 días) ────────────────────────────────────────────
function Asistencia({ f }) {
  const a = f.asistencia, t = a.totales;
  const hh = (iso) => (iso ? new Intl.DateTimeFormat('es-HN', { timeZone: 'America/Tegucigalpa', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) : '');
  return (
    <>
      <div className="rejilla cols-4">
        <Kpi etiqueta="Horas trabajadas" valor={numero(t.horas, 1)} sub={`${fechaCorta(a.desde)} al ${fechaCorta(a.hasta)}`} />
        <Kpi etiqueta="Días con marcación" valor={t.dias_trabajados} />
        <Kpi etiqueta="Llegadas tarde" valor={t.tardanzas} sub={`${t.minutos_tarde} min en total`} />
        <Kpi etiqueta="Días sin marcar" valor={t.sin_marcar} sub={t.incompletos ? `${t.incompletos} sin salida` : null} />
      </div>
      <div className="tarjeta pad0"><div className="tabla-wrap"><table>
        <thead><tr><th>Día</th><th>Horario</th><th>Entrada</th><th>Salida</th><th className="der">Horas</th><th>Situación</th></tr></thead>
        <tbody>{[...a.dias].reverse().map((x) => { const [txt, cl] = SITUACION[x.situacion] ?? [x.situacion, '']; return (
          <tr key={x.fecha}><td>{DIAS[x.dia_semana].slice(0, 3)} {fechaCorta(x.fecha).slice(0, -5)}</td><td className="num">{x.horario && (x.horario.includes('–') ? x.horario : SITUACION[x.horario]?.[0] ?? x.horario)}</td>
            <td className="num">{hh(x.entrada)}{x.tarde_min > 0 && <small style={{ color: 'var(--aviso)' }}> +{x.tarde_min}m</small>}</td><td className="num">{hh(x.salida)}</td><td className="der num">{x.horas ? numero(x.horas, 1) : ''}</td><td><span className={`chip ${cl}`}>{txt}</span></td></tr>); })}</tbody>
      </table></div></div>
      <small>Las horas salen de emparejar cada entrada con su salida; la tolerancia de llegada es de 10 minutos.</small>
    </>
  );
}

