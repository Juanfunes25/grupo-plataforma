// Pestañas de la ficha: Vacaciones, Ausencias y permisos, Historial (sanciones, evaluaciones, capacitaciones, salarios, línea de tiempo).
import { useState } from 'react';
import { lempiras, numero } from '@grupo/shared';
import { post, put } from '../api.js';
import { Kpi, useAccion } from '../ui/kit.jsx';
import Form from './Form.jsx';
import { ESTADO_PERIODO, TIPOS_AUSENCIA, del, fechaCorta, txtDias } from './util.js';

const chipEstadoVac = { solicitada: 'aviso', aprobada: 'ok', tomada: 'ok', rechazada: 'mal', cancelada: '' };

export function Vacaciones({ f, id, empresa, recargar }) {
  const r = f.vacaciones.resumen, ed = f.permisos.editar;
  const [modal, setModal] = useState(false);
  const [ejecutar] = useAccion();
  const [rechazo, setRechazo] = useState(null);
  const cambiar = async (v, estado, extra = {}) => {
    try { await put(`/rrhh/vacaciones/${v.id}`, { estado, ...extra }, { empresa }); recargar(); }
    catch (e) {
      if (e.codigo === 'saldo_insuficiente' && window.confirm(`${e.message}`)) { await put(`/rrhh/vacaciones/${v.id}`, { estado, forzar: true }, { empresa }); recargar(); } else if (e.codigo !== 'saldo_insuficiente') throw e;
    }
  };
  const accion = (fn) => async () => { await ejecutar(fn); };
  return (
    <>
      {r.sin_fecha_ingreso && <div className="aviso-caja">Falta la fecha de ingreso: sin ella no se puede calcular el saldo de vacaciones. Complétala en la pestaña Empleo.</div>}
      {!r.sin_fecha_ingreso && (
        <div className="rejilla cols-4">
          <Kpi etiqueta="Antigüedad" valor={`${r.antiguedad.anios} a ${r.antiguedad.meses} m`} sub={`próximo derecho: ${r.proximo.dias_ley} días el ${fechaCorta(r.proximo.derecho)}`} />
          <Kpi acento etiqueta="Días pendientes" valor={r.pendientes} sub={`ganados ${r.ganados} · tomados ${r.tomados}${r.adelantados ? ` · adelanto ${r.adelantados}` : ''}`} />
          <Kpi etiqueta="Por vencer" valor={r.por_vencer} sub="en los próximos 60 días" />
          <Kpi etiqueta="Vencidos" valor={r.vencidas} sub={r.solicitados ? `${r.solicitados} días solicitados` : 'sin vencer a tiempo'} />
        </div>)}
      {!r.sin_fecha_ingreso && <small>Ley hondureña: 10 días al cumplir 1 año, 12 al 2.º, 15 al 3.º y 20 desde el 4.º. Se gastan primero los períodos más antiguos; cada período se debe gozar dentro de los 12 meses siguientes. Proporcional del año en curso: {r.proporcional_en_curso} días.</small>}
      {r.periodos?.length > 0 && (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Período</th><th>Ganado el</th><th className="der">Días</th><th className="der">Tomados</th><th className="der">Pendientes</th><th>Vence</th><th>Estado</th></tr></thead>
          <tbody>{[...r.periodos].reverse().map((p) => <tr key={p.numero}><td>Año {p.numero}</td><td className="num">{fechaCorta(p.derecho)}</td><td className="der num">{p.dias_ley}</td><td className="der num">{p.tomados}</td><td className="der num"><b>{p.pendientes}</b></td><td className="num">{fechaCorta(p.vence)}</td><td><span className={`chip ${ESTADO_PERIODO[p.estado][1]}`}>{ESTADO_PERIODO[p.estado][0]}</span></td></tr>)}</tbody>
        </table></div></div>)}
      <div className="fila espacio"><h3>Vacaciones registradas</h3>{ed && <button className="btn primario chico" onClick={() => setModal(true)}>+ Registrar vacaciones</button>}</div>
      <div className="tarjeta pad0"><div className="tabla-wrap"><table>
        <thead><tr><th>Desde</th><th>Hasta</th><th className="der">Días</th><th>Estado</th><th>Nota</th><th></th></tr></thead>
        <tbody>{f.vacaciones.lista.map((v) => (
          <tr key={v.id}><td className="num">{fechaCorta(v.desde)}</td><td className="num">{fechaCorta(v.hasta)}</td><td className="der num">{v.dias}</td>
            <td><span className={`chip ${chipEstadoVac[v.estado]}`}>{v.estado}</span>{v.motivo_rechazo && <small> {v.motivo_rechazo}</small>}</td><td><small>{v.nota}</small></td>
            <td className="der">{ed && <>
              {v.estado === 'solicitada' && <><button className="btn chico" onClick={accion(() => cambiar(v, 'aprobada'))}>Aprobar</button> <button className="btn chico fantasma" onClick={() => setRechazo(v)}>Rechazar</button> </>}
              {v.estado === 'aprobada' && <button className="btn chico fantasma" onClick={accion(() => cambiar(v, 'cancelada'))}>Cancelar</button>}
              {(v.estado === 'rechazada' || v.estado === 'cancelada') && <button className="btn chico fantasma" onClick={accion(async () => { if (window.confirm('¿Borrar este registro?')) { await del(`/rrhh/vacaciones/${v.id}`, { empresa }); recargar(); } })}>Borrar</button>}</>}</td></tr>))}</tbody>
      </table>{f.vacaciones.lista.length === 0 && <div className="vacio">Sin vacaciones registradas.</div>}</div></div>
      {modal && <Form titulo="Registrar vacaciones" onCerrar={() => setModal(false)} inicial={{ desde: f.hoy, hasta: f.hoy, estado: 'aprobada', contar: 'habiles' }}
        campos={[{ k: 'desde', etiqueta: 'Desde', tipo: 'date', req: true }, { k: 'hasta', etiqueta: 'Hasta', tipo: 'date', req: true },
          { k: 'estado', etiqueta: 'Estado', tipo: 'select', opciones: [['solicitada', 'Solicitada'], ['aprobada', 'Aprobada'], ['tomada', 'Ya tomada']] },
          { k: 'contar', etiqueta: 'Cómo contar los días', tipo: 'select', opciones: [['habiles', 'Hábiles (lunes a sábado)'], ['corridos', 'Corridos']] },
          { k: 'dias', etiqueta: 'Días (si quieres fijarlos tú)', tipo: 'number' }, { k: 'nota', etiqueta: 'Nota', ancho: true }]}
        onGuardar={async (d) => {
          const cuerpo = { empleado_id: id, ...d, dias: d.dias || undefined, nota: d.nota || null };
          try { await post('/rrhh/vacaciones', cuerpo, { empresa }); }
          catch (e) { if (e.codigo === 'saldo_insuficiente' && window.confirm(e.message)) await post('/rrhh/vacaciones', { ...cuerpo, forzar: true }, { empresa }); else throw e; }
          recargar(); return true;
        }} />}
      {rechazo && <Form titulo="Rechazar solicitud" onCerrar={() => setRechazo(null)} campos={[{ k: 'motivo_rechazo', etiqueta: 'Motivo', req: true, ancho: true }]} textoGuardar="Rechazar"
        onGuardar={async (d) => { await put(`/rrhh/vacaciones/${rechazo.id}`, { estado: 'rechazada', motivo_rechazo: d.motivo_rechazo }, { empresa }); recargar(); return true; }} />}
    </>
  );
}

// ── Ausencias, permisos, días libres, incapacidades y llegadas tarde ───────
export function Ausencias({ f, id, empresa, recargar }) {
  const ed = f.permisos.editar, cont = f.ausencias.contadores;
  const [modal, setModal] = useState(null);   // { fila? }
  const [ejecutar] = useAccion();
  const anio = cont[0];
  const campos = [
    { k: 'tipo', etiqueta: 'Tipo', tipo: 'select', opciones: Object.entries(TIPOS_AUSENCIA), req: true },
    { k: 'subtipo', etiqueta: 'Detalle', placeholder: 'IHSS, enfermedad, duelo, trámite…' },
    { k: 'desde', etiqueta: 'Desde', tipo: 'date', req: true }, { k: 'hasta', etiqueta: 'Hasta', tipo: 'date', si: (x) => x.tipo !== 'tardanza' },
    { k: 'minutos', etiqueta: 'Minutos de retraso', tipo: 'number', si: (x) => x.tipo === 'tardanza', req: true },
    { k: 'dias', etiqueta: 'Días (medio día = 0.5)', tipo: 'number', si: (x) => x.tipo !== 'tardanza', ayuda: 'Vacío = se calcula solo' },
    { k: 'estado', etiqueta: 'Estado', tipo: 'select', opciones: [['aprobada', 'Aprobada'], ['pendiente', 'Pendiente'], ['rechazada', 'Rechazada']] },
    { k: 'pagado', etiqueta: 'Con goce de sueldo (pagado)', tipo: 'check' }, { k: 'motivo', etiqueta: 'Motivo', tipo: 'textarea', ancho: true },
  ];
  const guardar = (fila) => async (d) => {
    const cuerpo = { ...d, hasta: d.hasta || d.desde, dias: d.dias === null ? undefined : d.dias };
    if (fila) await put(`/rrhh/ausencias/${fila.id}`, cuerpo, { empresa }); else await post(`/rrhh/empleados/${id}/ausencias`, cuerpo, { empresa });
    recargar(); return true;
  };
  return (
    <>
      {anio && (
        <div className="rejilla cols-4">
          <Kpi acento etiqueta={`Días libres tomados ${anio.anio}`} valor={numero(anio.libres_tomados, anio.libres_tomados % 1 ? 1 : 0)} sub="días libres y permisos" />
          <Kpi etiqueta="Días fuera en el año" valor={numero(anio.dias_fuera, anio.dias_fuera % 1 ? 1 : 0)} sub={`${numero(anio.dias_pagados, 1)} con goce · ${numero(anio.dias_no_pagados, 1)} sin goce`} />
          <Kpi etiqueta="Llegadas tarde" valor={anio.tardanzas} sub={`${anio.minutos_tarde} minutos`} />
          <Kpi etiqueta="Vacaciones tomadas" valor={anio.vacaciones_tomadas} sub={anio.pendientes_de_aprobar ? `${anio.pendientes_de_aprobar} permiso(s) por aprobar` : null} />
        </div>)}
      <div className="tarjeta pad0"><div className="tabla-wrap"><table>
        <thead><tr><th>Año</th>{Object.values(TIPOS_AUSENCIA).map((n) => <th key={n} className="der">{n}</th>)}</tr></thead>
        <tbody>{cont.map((c) => <tr key={c.anio}><td><b>{c.anio}</b></td>{Object.keys(TIPOS_AUSENCIA).map((t) => <td key={t} className="der num">{c.por_tipo[t] ? (t === 'tardanza' ? `${c.por_tipo[t].eventos}` : `${c.por_tipo[t].dias} d (${c.por_tipo[t].eventos})`) : ''}</td>)}</tr>)}</tbody>
      </table></div></div>
      <div className="fila espacio"><h3>Registro</h3>{ed && <button className="btn primario chico" onClick={() => setModal({})}>+ Registrar</button>}</div>
      <div className="tarjeta pad0"><div className="tabla-wrap"><table>
        <thead><tr><th>Tipo</th><th>Fechas</th><th className="der">Días</th><th>Pago</th><th>Estado</th><th>Motivo</th><th></th></tr></thead>
        <tbody>{f.ausencias.lista.map((a) => (
          <tr key={a.id}><td>{TIPOS_AUSENCIA[a.tipo]}{a.subtipo ? <small> · {a.subtipo}</small> : ''}</td>
            <td className="num">{a.desde === a.hasta ? fechaCorta(a.desde) : `${fechaCorta(a.desde)} – ${fechaCorta(a.hasta)}`}</td>
            <td className="der num">{a.tipo === 'tardanza' ? `${a.minutos} min` : txtDias(a.dias)}</td><td>{a.tipo === 'tardanza' ? '' : a.pagado ? 'con goce' : 'sin goce'}</td>
            <td><span className={`chip ${a.estado === 'aprobada' ? 'ok' : a.estado === 'rechazada' ? 'mal' : 'aviso'}`}>{a.estado}</span>{a.aprobado_por_nombre && <small> {a.aprobado_por_nombre}</small>}</td><td><small>{a.motivo}</small></td>
            <td className="der">{ed && <><button className="btn chico fantasma" onClick={() => setModal({ fila: a })}>Editar</button> <button className="btn chico fantasma" onClick={() => ejecutar(async () => { if (window.confirm('¿Borrar este registro?')) { await del(`/rrhh/ausencias/${a.id}`, { empresa }); recargar(); } })}>Borrar</button></>}</td></tr>))}</tbody>
      </table>{f.ausencias.lista.length === 0 && <div className="vacio">Sin ausencias ni permisos registrados.</div>}</div></div>
      {modal && <Form titulo={modal.fila ? 'Editar registro' : 'Registrar ausencia o permiso'} campos={campos} onCerrar={() => setModal(null)}
        inicial={modal.fila ?? { tipo: 'dia_libre', desde: f.hoy, hasta: f.hoy, estado: 'aprobada', pagado: true }} onGuardar={guardar(modal.fila)} />}
    </>
  );
}

// ── Historial: línea de tiempo, amonestaciones, evaluaciones, capacitaciones, salario ──
const ICONO = { ingreso: '▶', baja: '■', suspension: '⏸', reactivacion: '▶', reingreso: '▶', cambio_puesto: '↗', cambio_salario: 'L', cambio_sucursal: '⇄', cambio_contrato: '✎', vacaciones: '☼', sancion: '!', evaluacion: '★', capacitacion: '✔' };

function Bloque({ titulo, ed, onNuevo, children }) {
  return <div className="tarjeta" style={{ display: 'grid', gap: 8 }}><div className="fila espacio"><h3>{titulo}</h3>{ed && <button className="btn chico" onClick={onNuevo}>+ Agregar</button>}</div>{children}</div>;
}

export function Historial({ f, id, empresa, recargar }) {
  const ed = f.permisos.editar;
  const [modal, setModal] = useState(null);   // { tipo, fila? }
  const [ejecutar] = useAccion();
  const borrar = (ruta, idf) => ejecutar(async () => { if (window.confirm('¿Borrar este registro?')) { await del(`/rrhh/${ruta}/${idf}`, { empresa }); recargar(); } });
  const defs = {
    sanciones: { titulo: 'Amonestación o sanción', campos: [
      { k: 'tipo', etiqueta: 'Tipo', tipo: 'select', req: true, opciones: [['verbal', 'Llamado verbal'], ['escrita', 'Amonestación escrita'], ['suspension', 'Suspensión'], ['otra', 'Otra']] },
      { k: 'fecha', etiqueta: 'Fecha', tipo: 'date' }, { k: 'motivo', etiqueta: 'Motivo', req: true, ancho: true }, { k: 'descripcion', etiqueta: 'Descripción', tipo: 'textarea', ancho: true },
      { k: 'dias_suspension', etiqueta: 'Días de suspensión', tipo: 'number', si: (x) => x.tipo === 'suspension' }, { k: 'con_goce', etiqueta: 'Con goce de sueldo', tipo: 'check', si: (x) => x.tipo === 'suspension' },
      { k: 'estado', etiqueta: 'Estado', tipo: 'select', opciones: [['vigente', 'Vigente'], ['anulada', 'Anulada']] }], ini: { tipo: 'verbal', fecha: f.hoy, estado: 'vigente' } },
    evaluaciones: { titulo: 'Evaluación de desempeño', campos: [
      { k: 'fecha', etiqueta: 'Fecha', tipo: 'date' }, { k: 'periodo', etiqueta: 'Período', placeholder: '2026 · 1er semestre' }, { k: 'puntaje', etiqueta: 'Puntaje (0 a 100)', tipo: 'number' },
      { k: 'fortalezas', etiqueta: 'Fortalezas', tipo: 'textarea', ancho: true }, { k: 'areas_mejora', etiqueta: 'Áreas de mejora', tipo: 'textarea', ancho: true }, { k: 'comentarios', etiqueta: 'Comentarios', tipo: 'textarea', ancho: true }], ini: { fecha: f.hoy } },
    capacitaciones: { titulo: 'Capacitación', campos: [
      { k: 'nombre', etiqueta: 'Nombre', req: true, ancho: true }, { k: 'institucion', etiqueta: 'Institución' }, { k: 'fecha', etiqueta: 'Fecha', tipo: 'date' }, { k: 'horas', etiqueta: 'Horas', tipo: 'number' },
      { k: 'estado', etiqueta: 'Estado', tipo: 'select', opciones: [['completada', 'Completada'], ['programada', 'Programada'], ['cancelada', 'Cancelada']] }, { k: 'vence', etiqueta: 'Vence el certificado', tipo: 'date' }, { k: 'resultado', etiqueta: 'Resultado' }], ini: { fecha: f.hoy, estado: 'completada' } },
  };
  const d = modal && defs[modal.tipo];
  return (
    <>
      <Bloque titulo="Línea de tiempo">
        {f.linea.length === 0 ? <small>Sin movimientos.</small> : f.linea.slice(0, 60).map((x, i) => (
          <div key={i} className="fila" style={{ alignItems: 'flex-start', gap: 10 }}>
            <span className="chip" style={{ minWidth: 28, justifyContent: 'center' }}>{ICONO[x.tipo] ?? '•'}</span>
            <div style={{ flex: 1 }}><b>{x.titulo}</b>{x.detalle && <div className="tenue">{x.detalle}</div>}</div><small className="num">{fechaCorta(x.fecha)}</small>
          </div>))}
      </Bloque>
      <Bloque titulo="Amonestaciones y sanciones" ed={ed} onNuevo={() => setModal({ tipo: 'sanciones' })}>
        {f.sanciones.length === 0 ? <small>Sin amonestaciones.</small> : f.sanciones.map((s) => (
          <div key={s.id} className="fila espacio" style={{ opacity: s.estado === 'anulada' ? 0.5 : 1 }}><div><b>{{ verbal: 'Llamado verbal', escrita: 'Amonestación escrita', suspension: 'Suspensión', otra: 'Otra' }[s.tipo]}</b> · {fechaCorta(s.fecha)}<div className="tenue">{s.motivo}{s.dias_suspension ? ` · ${s.dias_suspension} días${s.con_goce ? ' con goce' : ' sin goce'}` : ''}</div></div>
            {ed && <div><button className="btn chico fantasma" onClick={() => setModal({ tipo: 'sanciones', fila: s })}>Editar</button> <button className="btn chico fantasma" onClick={() => borrar('sanciones', s.id)}>Borrar</button></div>}</div>))}
      </Bloque>
      <Bloque titulo="Evaluaciones de desempeño" ed={ed} onNuevo={() => setModal({ tipo: 'evaluaciones' })}>
        {f.evaluaciones.length === 0 ? <small>Sin evaluaciones.</small> : f.evaluaciones.map((e) => (
          <div key={e.id} className="fila espacio"><div><b>{e.periodo || fechaCorta(e.fecha)}</b> {e.puntaje != null && <span className={`chip ${e.puntaje >= 80 ? 'ok' : e.puntaje >= 60 ? 'aviso' : 'mal'}`}>{numero(e.puntaje, 0)}/100</span>}<div className="tenue">{[e.fortalezas && `Fortalezas: ${e.fortalezas}`, e.areas_mejora && `Mejorar: ${e.areas_mejora}`].filter(Boolean).join(' · ')}</div></div>
            {ed && <div><button className="btn chico fantasma" onClick={() => setModal({ tipo: 'evaluaciones', fila: e })}>Editar</button> <button className="btn chico fantasma" onClick={() => borrar('evaluaciones', e.id)}>Borrar</button></div>}</div>))}
      </Bloque>
      <Bloque titulo="Capacitaciones" ed={ed} onNuevo={() => setModal({ tipo: 'capacitaciones' })}>
        {f.capacitaciones.length === 0 ? <small>Sin capacitaciones.</small> : f.capacitaciones.map((c) => (
          <div key={c.id} className="fila espacio"><div><b>{c.nombre}</b> <span className={`chip ${c.estado === 'completada' ? 'ok' : ''}`}>{c.estado}</span><div className="tenue">{[c.institucion, fechaCorta(c.fecha), c.horas && `${c.horas} h`, c.vence && `vence ${fechaCorta(c.vence)}`].filter(Boolean).join(' · ')}</div></div>
            {ed && <div><button className="btn chico fantasma" onClick={() => setModal({ tipo: 'capacitaciones', fila: c })}>Editar</button> <button className="btn chico fantasma" onClick={() => borrar('capacitaciones', c.id)}>Borrar</button></div>}</div>))}
      </Bloque>
      {f.salarios && (
        <Bloque titulo="Historial de salario (dato sensible)">
          {f.salarios.length === 0 ? <small>Sin registros.</small> : <div className="tabla-wrap"><table><thead><tr><th>Desde</th><th className="der">Anterior</th><th className="der">Nuevo</th><th>Motivo</th><th>Registró</th></tr></thead>
            <tbody>{f.salarios.map((s) => <tr key={s.id}><td className="num">{fechaCorta(s.vigente_desde)}</td><td className="der num">{s.salario_anterior == null ? '—' : lempiras(s.salario_anterior)}</td><td className="der num"><b>{lempiras(s.salario_nuevo)}</b></td><td>{s.motivo}</td><td><small>{s.usuario}</small></td></tr>)}</tbody></table></div>}
        </Bloque>)}
      {modal && <Form titulo={`${modal.fila ? 'Editar' : 'Agregar'}: ${d.titulo}`} campos={d.campos} inicial={modal.fila ?? d.ini} onCerrar={() => setModal(null)}
        onGuardar={async (v) => { if (modal.fila) await put(`/rrhh/${modal.tipo}/${modal.fila.id}`, v, { empresa }); else await post(`/rrhh/empleados/${id}/${modal.tipo}`, v, { empresa }); recargar(); return true; }} />}
    </>
  );
}
