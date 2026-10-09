// Planilla: la hoja quincenal/semanal de la empresa (Empleado · DIAS · SALARIO DIARIO · TOTAL QUINCENAL · POR HORA · HORAS EXTRAS ·
// TOTAL HX · deducciones · TOTAL · cuenta · OBSERVACIONES), pre-llenada desde RRHH y editable celda por celda antes de aprobar.
// Solo dueño / administrador con rrhh:sensible. Los parámetros de ley están «por confirmar con el contador».
import { useCallback, useEffect, useRef, useState } from 'react';
import { fechaHN, lempiras, numero } from '@grupo/shared';
import { almacen, api, empresaActual, get, patch, post, put, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, Kpi, Modal, Tabs, Vacio, useAccion, useAviso, useConfirmar, useDatos, usePedirTexto } from '../ui/kit.jsx';
import './planilla.css';

const TIPOS = { semanal: 'Semanal', quincena: 'Quincenal', mensual: 'Mensual', aguinaldo: 'Aguinaldo', catorceavo: 'Catorceavo' };
const ESTADOS = { borrador: ['Borrador', 'bajo'], aprobada: ['Aprobada', 'ok'], pagada: ['Pagada', 'ok'], anulada: ['Anulada', 'sin_cargar'] };
const L = (n) => numero(n, 2);

/** Baja (o abre) un archivo protegido con la sesión. */
export async function bajar(ruta, { empresa, nombre, abrir = false }) {
  const s = almacen.leer(); const emp = empresa ?? empresaActual();
  const r = await fetch(`/api${ruta}`, { headers: { authorization: `Bearer ${s?.token}`, ...(emp && emp !== 'grupo' ? { 'x-empresa': emp } : {}) } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Error ${r.status}`);
  const url = URL.createObjectURL(await r.blob());
  if (abrir) window.open(url, '_blank');
  else { const a = Object.assign(document.createElement('a'), { href: url, download: nombre }); document.body.appendChild(a); a.click(); a.remove(); }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export default function Planilla() { return <div className="pagina"><div className="encabezado-pagina"><div><h1>Planilla</h1><small>Sueldos, deducciones y boletas. Solo dueño y administrador.</small></div></div><PlanillaPanel /></div>; }

/** Todo el módulo para UNA empresa. `empresa` = código (en Dirección se elige); sin él, la empresa activa. */
export function PlanillaPanel({ empresa }) {
  const [tab, setTab] = useState('planillas');
  const op = empresa ? { empresa } : undefined;
  const tabs = [['planillas', 'Planillas'], ['novedades', 'Bonos y novedades'], ['config', 'Pago y deducciones fijas'], ['contable', 'Resumen contable'], ['parametros', 'Parámetros']];
  return (
    <>
      <Tabs tabs={tabs} valor={tab} onCambio={setTab} />
      {tab === 'planillas' && <Planillas key={empresa} op={op} />}
      {tab === 'novedades' && <Novedades key={empresa} op={op} />}
      {tab === 'config' && <Config key={empresa} op={op} />}
      {tab === 'contable' && <Contable key={empresa} op={op} />}
      {tab === 'parametros' && <Parametros op={op} />}
    </>
  );
}

function AvisoConfirmar({ op }) {
  const d = useDatos(() => get('/planilla/parametros', op), [op?.empresa]);
  if (!d.datos?.por_confirmar) return null;
  return <div className="pl-aviso-conf" role="note"><b>Por confirmar con el contador.</b> Los porcentajes, recargos y días base son valores de arranque; hasta que se confirmen en «Parámetros», las planillas salen marcadas.</div>;
}

function Planillas({ op }) {
  const d = useDatos(() => get('/planilla/planillas', op), [op?.empresa]);
  const [nueva, setNueva] = useState(false);
  const [abierta, setAbierta] = useState(null);
  return (
    <>
      <AvisoConfirmar op={op} />
      <div className="pl-acciones"><button className="btn primario" onClick={() => setNueva(true)}>+ Nueva planilla</button></div>
      {(d.datos ?? []).filter((p) => p.estado === 'borrador').slice(0, 3).map((p) => (
        <button key={p.id} className="pl-seguir" onClick={() => setAbierta(p.id)}>
          <span><b>{p.etiqueta}</b><small>En borrador · {p.empleados} empleados · {lempiras(p.total)}</small></span>
          <span className="pl-seguir-ir">{PERIODICAS.includes(p.tipo) ? 'Poner horas y aprobar →' : 'Revisar y aprobar →'}</span>
        </button>))}
      <Estado d={d}>{(rows) => rows.length === 0 ? <Vacio titulo="Todavía no hay planillas">Crea la primera: se llena sola con los empleados de RRHH.</Vacio> : (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Planilla</th><th>Periodo</th><th className="der">Empleados</th><th className="der">Total</th><th>Estado</th></tr></thead>
          <tbody>{rows.map((p) => (
            <tr key={p.id} onClick={() => setAbierta(p.id)} style={{ cursor: 'pointer', opacity: p.estado === 'anulada' ? 0.55 : 1 }}>
              <td><b>{p.etiqueta}</b><br /><small>{TIPOS[p.tipo]}{p.reaperturas?.length ? ` · reabierta ${p.reaperturas.length} vez` : ''}</small></td><td className="num">{p.desde} → {p.hasta}</td>
              <td className="der num">{p.empleados}</td><td className="der num">{lempiras(p.total)}</td>
              <td><span className={`iu-estado ${ESTADOS[p.estado][1]}`}>{ESTADOS[p.estado][0]}</span>{p.por_confirmar && p.estado !== 'anulada' && <small> · sin confirmar</small>}{p.gasto_id && <small> · en Finanzas</small>}</td></tr>))}</tbody>
        </table></div></div>
      )}</Estado>
      {nueva && <Nueva op={op} onCerrar={() => setNueva(false)} onListo={(p) => { setNueva(false); d.recargar(); setAbierta(p.id); }} />}
      {abierta && <Hoja id={abierta} op={op} onCerrar={() => { setAbierta(null); d.recargar(); }} />}
    </>
  );
}

/** Primer día de la semana de pago que contiene `iso` (inicio: 1 = lunes … 7 = domingo). Fechas de Honduras, sin UTC del navegador. */
function inicioSemana(iso, inicio = 1) {
  const ms = Date.parse(`${iso}T12:00:00Z`);
  const dia = ((new Date(ms).getUTCDay() + 6) % 7) + 1;
  const atras = (dia - Math.round(Number(inicio) || 1) + 7) % 7;
  return new Date(ms - atras * 86400000).toISOString().slice(0, 10);
}

function Nueva({ op, onCerrar, onListo }) {
  const cfg = useDatos(() => get('/planilla/config', op), [op?.empresa]);
  const hoy = fechaHN();
  const [f, setF] = useState({ tipo: '', anio: hoy.slice(0, 4), mes: String(Number(hoy.slice(5, 7))), quincena: Number(hoy.slice(8)) <= 15 ? '1' : '2', desde: '' });
  const [ejecutar, ocupado] = useAccion();
  const tipo = f.tipo || (cfg.datos?.periodicidad_empresa ?? 'quincena');
  const desde = f.desde || (cfg.datos ? inicioSemana(hoy, cfg.datos.semana.inicio_dia) : '');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const crear = () => ejecutar(async () => {
    const cuerpo = { tipo };
    if (tipo === 'semanal') cuerpo.desde = desde;
    if (['quincena', 'mensual'].includes(tipo)) { cuerpo.anio = Number(f.anio); cuerpo.mes = Number(f.mes); if (tipo === 'quincena') cuerpo.quincena = Number(f.quincena); }
    if (['aguinaldo', 'catorceavo'].includes(tipo)) cuerpo.anio = Number(f.anio);
    onListo(await post('/planilla/planillas', cuerpo, op));
  }, 'Planilla armada desde RRHH');
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  return (
    <Modal titulo="Nueva planilla" tam="angosto" onCerrar={onCerrar} pie={<button className="btn primario" disabled={ocupado || (tipo === 'semanal' && !desde)} onClick={crear}>Armar planilla</button>}>
      <div style={{ display: 'grid', gap: 12 }}>
        <Campo etiqueta="Tipo" ayuda={cfg.datos ? `La empresa paga ${TIPOS[cfg.datos.periodicidad_empresa].toLowerCase()} por defecto. Solo entran los empleados con esa periodicidad.` : ''}>
          <select value={tipo} onChange={set('tipo')}>{Object.entries(TIPOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Campo>
        {tipo === 'semanal' && <Campo etiqueta="Primer día de la semana" ayuda="Ya viene la semana actual. Debe empezar el día en que empieza la semana de pago (por defecto lunes)."><input type="date" value={desde} onChange={set('desde')} /></Campo>}
        {['quincena', 'mensual'].includes(tipo) && <><Campo etiqueta="Mes"><select value={f.mes} onChange={set('mes')}>{MESES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></Campo>
          <Campo etiqueta="Año"><input type="number" value={f.anio} onChange={set('anio')} /></Campo></>}
        {tipo === 'quincena' && <Campo etiqueta="Quincena"><select value={f.quincena} onChange={set('quincena')}><option value="1">1 al 15</option><option value="2">16 al fin de mes</option></select></Campo>}
        {['aguinaldo', 'catorceavo'].includes(tipo) && <Campo etiqueta="Año"><input type="number" value={f.anio} onChange={set('anio')} /></Campo>}
      </div>
    </Modal>
  );
}

const PERIODICAS = ['semanal', 'quincena', 'mensual'];
const ANTERIOR = { semanal: 'semana anterior', quincena: 'quincena anterior', mensual: 'mes anterior' };
const PERIODO = { semanal: 'semana', quincena: 'quincena', mensual: 'mes' };
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const horaHN = () => new Date().toLocaleTimeString('es-HN', { timeZone: 'America/Tegucigalpa', hour: '2-digit', minute: '2-digit' });
/** Lo que se escribe en el campo de horas → número (coma o punto decimal; vacío = 0). null si no sirve. */
const leerHoras = (txt) => {
  const s = String(txt ?? '').trim().replace(',', '.');
  if (s === '') return 0;
  if (!/^\d*\.?\d*$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 300 ? Math.round(n * 100) / 100 : null;
};
const sinHx = (l) => !!l.detalle?.sin_horas_extra || /gerencia/i.test(l.sucursal ?? '') || /^gerencia$/i.test((l.puesto ?? '').trim());

/**
 * Las horas que se están escribiendo (aún sin guardar) y su guardado automático. Clave = empleado.
 * Se guardan solas un momento después de dejar de escribir, en un solo envío; también al pasar a revisar, aprobar o cerrar.
 */
function useHorasPendientes({ planillaId, op, onGuardado }) {
  const [sucias, setSucias] = useState({});              // { empleado_id: texto }
  const [estado, setEstado] = useState({ fase: 'quieto' });  // quieto | guardando | guardado | error
  const ref = useRef({ sucias, enCurso: null });
  ref.current.sucias = sucias;
  const guardar = useCallback(async () => {
    if (ref.current.enCurso) { await ref.current.enCurso; }
    const envio = Object.entries(ref.current.sucias).map(([empleado_id, txt]) => ({ empleado_id, txt, horas: leerHoras(txt) })).filter((x) => x.horas !== null);
    if (!envio.length) return true;
    setEstado({ fase: 'guardando' });
    const tarea = (async () => {
      try {
        const r = await put(`/planilla/planillas/${planillaId}/horas`, { horas: envio.map(({ empleado_id, horas }) => ({ empleado_id, horas })) }, op);
        onGuardado(r.planilla);
        // solo se limpian los campos que no se volvieron a tocar mientras se guardaba
        setSucias((s) => { const n = { ...s }; for (const x of envio) if (n[x.empleado_id] === x.txt) delete n[x.empleado_id]; return n; });
        setEstado({ fase: 'guardado', n: r.guardadas, hora: horaHN() });
        return true;
      } catch (e) { setEstado({ fase: 'error', mensaje: e.message }); return false; }
    })();
    ref.current.enCurso = tarea;
    const ok = await tarea;
    ref.current.enCurso = null;
    return ok;
  }, [planillaId, op, onGuardado]);
  // guardado automático: 900 ms después de la última tecla
  useEffect(() => {
    if (!Object.keys(sucias).length || estado.fase === 'guardando' || estado.fase === 'error') return undefined;
    const t = setTimeout(guardar, 900);
    return () => clearTimeout(t);
  }, [sucias, estado.fase, guardar]);
  const poner = useCallback((empleado_id, txt) => { setSucias((s) => ({ ...s, [empleado_id]: txt })); setEstado((e) => (e.fase === 'error' ? { fase: 'quieto' } : e)); }, []);
  const ponerVarias = useCallback((mapa) => setSucias((s) => ({ ...s, ...mapa })), []);
  const malas = Object.values(sucias).filter((t) => leerHoras(t) === null).length;
  return { sucias, poner, ponerVarias, guardar, estado, malas, pendientes: Object.keys(sucias).length };
}

/** Horas, TOTAL HX y TOTAL de un renglón con lo que se está escribiendo (el servidor confirma al guardar). */
function estimar(l, txt, recargo) {
  if (txt === undefined) return { horas: Number(l.horas_extra), total_hx: Number(l.total_hx), total: Number(l.total), cambia: false };
  const h = leerHoras(txt);
  if (h === null || sinHx(l)) return { horas: Number(l.horas_extra), total_hx: Number(l.total_hx), total: Number(l.total), cambia: false, mala: h === null };
  const hx = r2(h * Number(l.por_hora) * (1 + recargo / 100));
  return { horas: h, total_hx: hx, total: r2(Number(l.total) - Number(l.total_hx) + hx), cambia: h !== Number(l.horas_extra) };
}

function Hoja({ id, op, onCerrar }) {
  const { usuario } = useSesion();
  const d = useDatos(() => get(`/planilla/planillas/${id}`, op), [id]);
  const [fresca, setFresca] = useState(null);             // la planilla que devolvió el último guardado de horas
  useEffect(() => { setFresca(null); }, [d.datos]);
  const p0 = fresca ?? d.datos;
  const [ejecutar, ocupado] = useAccion();
  const confirmar = useConfirmar(); const pedir = usePedirTexto(); const avisar = useAviso();
  const [dedDe, setDedDe] = useState(null);
  const [vista, setVista] = useState(null);
  const hx = useHorasPendientes({ planillaId: id, op, onGuardado: setFresca });
  const run = (fn, ok) => ejecutar(async () => { await fn(); await d.recargar(); }, ok);
  const conHoras = p0 && p0.estado === 'borrador' && PERIODICAS.includes(p0.tipo);
  const v = vista ?? (conHoras ? 'horas' : 'hoja');
  const recargo = Number(p0?.parametros?.valores?.he_diurna_pct ?? 0);
  // lo que se ve: con las horas que se están escribiendo
  const vivo = p0 ? p0.lineas.reduce((t, l) => { const e = estimar(l, hx.sucias[l.empleado_id], recargo); t.horas += e.horas; t.total_hx += e.total_hx; t.total += e.total; return t; }, { horas: 0, total_hx: 0, total: 0 }) : null;
  /** Antes de revisar, aprobar o cerrar: que no quede nada sin guardar. */
  const asegurar = async () => {
    if (hx.malas) { avisar(`Hay ${hx.malas} número(s) de horas que no se entienden: corrígelos (ejemplo: 4 o 2.5)`, 'mal'); return false; }
    return hx.guardar();
  };
  const cerrar = async () => { if (!hx.pendientes || (await asegurar())) onCerrar(); else if (await confirmar({ titulo: 'Hay horas sin guardar', mensaje: 'Si cierras ahora se pierden las horas que no se guardaron.', textoOk: 'Cerrar sin guardar', peligro: true })) onCerrar(); };
  const aprobar = async () => {
    if (!(await asegurar())) return;
    if (await confirmar({ titulo: 'Aprobar planilla', mensaje: `Total a pagar ${lempiras(vivo.total)} a ${p0.lineas.length} empleado(s).\nAl aprobarla queda inalterable. Solo el dueño puede reabrirla, con motivo.`, textoOk: 'Aprobar' })) run(() => post(`/planilla/planillas/${p0.id}/aprobar`, {}, op), 'Planilla aprobada');
  };
  const irA = async (sig) => { if (sig === 'hoja' && hx.pendientes && !(await asegurar())) return; setVista(sig); };
  const pie = !p0 ? null : (
    <div className="pl-pie">
      <div className="pl-pie-tot" aria-live="polite">
        {!['aguinaldo', 'catorceavo'].includes(p0.tipo) && <span>{numero(vivo.horas, 2)} h extra · HX {lempiras(vivo.total_hx)}</span>}
        <b>Total a pagar {lempiras(vivo.total)}</b>
        {conHoras && <EstadoGuardado hx={hx} />}
      </div>
      {conHoras && v === 'horas' && <button className="btn primario" disabled={ocupado} onClick={() => irA('hoja')}>Revisar totales →</button>}
      {conHoras && v === 'hoja' && <button className="btn" onClick={() => irA('horas')}>← Horas extra</button>}
      {p0.estado === 'borrador' && v === 'hoja' && <button className="btn primario" disabled={ocupado} onClick={aprobar}>Aprobar planilla</button>}
    </div>
  );
  return (
    <Modal titulo={p0 ? p0.etiqueta : 'Planilla'} tam="ancho" onCerrar={cerrar} pie={pie}>
      <Estado d={d}>{() => {
        const p = p0;
        const edita = p.estado === 'borrador';
        const decimo = p.tipo === 'aguinaldo' || p.tipo === 'catorceavo';
        const celda = (l, campo, extra = {}) => (
          <input key={`${l.id}-${l[campo]}`} type="number" inputMode="decimal" step="any" min="0" defaultValue={l[campo]} disabled={!edita || ocupado || (campo === 'horas_extra' && sinHx(l))} aria-label={`${campo} de ${l.nombre}`} {...extra}
            onBlur={(e) => {
              if (String(e.target.value) === String(l[campo]) || e.target.value === '') return;
              if (campo === 'horas_extra') { hx.poner(l.empleado_id, e.target.value); return; }   // las horas van por la captura: el renglón no se «congela»
              run(() => patch(`/planilla/planillas/${p.id}/lineas/${l.id}`, { [campo]: Number(e.target.value) }, op));
            }} />);
        const texto = (l, campo, cls) => (
          <input key={`${l.id}-${l[campo] ?? ''}`} className={cls} defaultValue={l[campo] ?? ''} disabled={!edita || ocupado} aria-label={`${campo} de ${l.nombre}`}
            onBlur={(e) => { if (e.target.value === (l[campo] ?? '')) return; run(() => patch(`/planilla/planillas/${p.id}/lineas/${l.id}`, { [campo]: e.target.value }, op)); }} />);
        return (
          <div style={{ display: 'grid', gap: 10 }}>
            <div><span className={`iu-estado ${ESTADOS[p.estado][1]}`}>{ESTADOS[p.estado][0]}</span> <small>{TIPOS[p.tipo]} · {p.desde} al {p.hasta} · pago {p.fecha_pago ?? '—'}</small></div>
            {p.por_confirmar && <div className="pl-aviso-conf">Calculada con parámetros <b>por confirmar con el contador</b>.</div>}
            {conHoras && <Tabs estilo="pildora" tabs={[['horas', '1 · Horas extra'], ['hoja', '2 · Revisar y aprobar']]} valor={v} onCambio={irA} />}
            {v === 'horas' ? <HorasRapidas p={p} hx={hx} recargo={recargo} op={op} /> : (<>
            <div className="rejilla cols-4">
              <Kpi acento etiqueta="Total a pagar" valor={lempiras(p.totales.total)} /><Kpi etiqueta="Empleados" valor={p.totales.empleados} sub={p.control.sin_cuenta ? `${p.control.sin_cuenta} sin número de cuenta` : 'Todos con cuenta'} />
              <Kpi etiqueta={decimo ? 'Total días × diario' : 'Sueldos + horas extra'} valor={lempiras(p.totales.total_quincenal + p.totales.total_hx)} /><Kpi etiqueta="Deducciones" valor={lempiras(p.totales.total_deducciones)} /></div>
            {p.advertencias.length > 0 && (
              <details><summary><b>{p.advertencias.length}</b> aviso(s) para revisar</summary>
                <ul>{p.advertencias.map((a, i) => <li key={i}>{a.empleado ? <b>{a.empleado}: </b> : null}{a.mensaje}</li>)}</ul></details>)}
            <div className="pl-acciones">
              {edita && <button className="btn" disabled={ocupado} onClick={() => run(() => post(`/planilla/planillas/${p.id}/recalcular`, {}, op), 'Recalculada (lo corregido a mano y las horas extra escritas se conservan)')}>Volver a llenar desde RRHH</button>}
              {p.estado === 'aprobada' && <button className="btn primario" disabled={ocupado} onClick={() => run(() => post(`/planilla/planillas/${p.id}/pagar`, {}, op), 'Marcada como pagada')}>Marcar pagada</button>}
              {p.estado === 'aprobada' && usuario?.es_dueno_grupo && <button className="btn" disabled={ocupado} onClick={async () => { const motivo = await pedir({ titulo: 'Reabrir planilla', etiqueta: 'Motivo', obligatorio: true, minimo: 5, textoOk: 'Reabrir' }); if (motivo) run(() => post(`/planilla/planillas/${p.id}/reabrir`, { motivo }, op), 'Planilla reabierta'); }}>Reabrir</button>}
              {['aprobada', 'pagada'].includes(p.estado) && !p.gasto_id && <button className="btn" disabled={ocupado} onClick={() => run(() => post(`/planilla/planillas/${p.id}/finanzas`, {}, op), 'Enviada a Finanzas')}>Enviar a Finanzas</button>}
              <button className="btn" onClick={() => bajar(`/planilla/planillas/${p.id}/excel`, { empresa: op?.empresa, nombre: `planilla-${p.desde}.xlsx` }).catch((e) => avisar(e.message, 'mal'))}>Descargar Excel</button>
              {['aprobada', 'pagada'].includes(p.estado) && <button className="btn" onClick={() => bajar(`/planilla/planillas/${p.id}/boletas.pdf`, { empresa: op?.empresa, abrir: true }).catch((e) => avisar(e.message, 'mal'))}>Boletas (PDF)</button>}
              {['borrador', 'aprobada'].includes(p.estado) && <button className="btn peligro" disabled={ocupado} onClick={async () => { const motivo = await pedir({ titulo: 'Anular planilla', etiqueta: 'Motivo', obligatorio: true, minimo: 3, textoOk: 'Anular' }); if (motivo) run(() => post(`/planilla/planillas/${p.id}/anular`, { motivo }, op), 'Planilla anulada'); }}>Anular</button>}
            </div>
            {edita && <small>Toca cualquier número para corregirlo; el total se recalcula. Los renglones corregidos se marcan con una raya naranja.</small>}
            <div className="tarjeta pad0"><div className="tabla-wrap"><table className="pl-hoja">
              <thead><tr><th>Empleado</th><th>DIAS</th><th>SALARIO DIARIO</th><th className="der">{decimo ? 'TOTAL' : 'TOTAL QUINCENAL'}</th>
                {!decimo && <><th>POR HORA</th><th>HORAS EXTRAS</th><th>TOTAL HX</th><th>deducciones</th><th className="der">TOTAL</th></>}<th>Número de cuenta</th><th>OBSERVACIONES</th>{!decimo && p.estado !== 'anulada' && <th>Boleta</th>}</tr></thead>
              <tbody>{p.grupos.map((g) => (
                <GrupoFilas key={g.sucursal} g={g} decimo={decimo} p={p} celda={celda} texto={texto} abrirDed={setDedDe} op={op} />))}
                <tr className="pl-tot"><td>Total {p.empresa}</td><td /><td /><td className="der num">{L(p.totales.total_quincenal)}</td>{!decimo && <><td /><td className="num">{L(p.totales.horas_extra)}</td><td className="num">{L(p.totales.total_hx)}</td><td className="num">{L(p.totales.total_deducciones)}</td><td className="der num">{L(p.totales.total)}</td></>}<td /><td /><td /></tr>
              </tbody></table></div></div>
            <small>Control: suma de renglones {lempiras(p.control.suma_de_renglones)} {p.control.cuadra ? '= total de la planilla ✓' : '≠ total (revisar)'} · costo total de la empresa {lempiras(p.totales.costo_empresa)}</small>
            {p.reaperturas?.length > 0 && <details><summary>Historial de reaperturas ({p.reaperturas.length})</summary><ul>{p.reaperturas.map((r, i) => <li key={i}>{new Date(r.cuando).toLocaleString('es-HN', { timeZone: 'America/Tegucigalpa' })} · {r.por}: {r.motivo}</li>)}</ul></details>}
            </>)}
            {dedDe && <Deducciones linea={dedDe} edita={edita} onCerrar={() => setDedDe(null)} onGuardar={(deducciones) => { run(() => patch(`/planilla/planillas/${p.id}/lineas/${dedDe.id}`, { deducciones }, op), 'Deducciones guardadas'); setDedDe(null); }} />}
          </div>
        );
      }}</Estado>
    </Modal>
  );
}

function EstadoGuardado({ hx }) {
  const { estado: e, pendientes, malas, guardar } = hx;
  if (malas) return <small className="pl-guardado mal">{malas} número(s) por corregir</small>;
  if (e.fase === 'error') return <small className="pl-guardado mal">No se guardó: {e.mensaje} <button className="btn fantasma chico" onClick={guardar}>Reintentar</button></small>;
  if (e.fase === 'guardando') return <small className="pl-guardado">Guardando…</small>;
  if (pendientes) return <small className="pl-guardado">{pendientes} cambio(s) por guardar…</small>;
  if (e.fase === 'guardado') return <small className="pl-guardado ok">✓ Guardado a las {e.hora}{e.n ? ` · ${e.n} empleado(s)` : ''}</small>;
  return <small className="pl-guardado">Se guarda solo al escribir</small>;
}

/**
 * Captura rápida de HORAS EXTRAS, como la columna de la hoja: todos los empleados de la planilla por sucursal,
 * un campo grande por empleado (teclado numérico en el teléfono) con el valor de su hora al lado; TOTAL HX y TOTAL
 * se recalculan al instante; Enter baja al siguiente; se guarda solo.
 */
function HorasRapidas({ p, hx, recargo, op }) {
  const caja = useRef(null);
  const avisar = useAviso(); const confirmar = useConfirmar();
  const [ejecutar, ocupado] = useAccion();
  const siguiente = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const campos = [...caja.current.querySelectorAll('input[data-hx]:not(:disabled)')];
    const sig = campos[campos.indexOf(e.currentTarget) + 1];
    if (sig) { sig.focus(); sig.select(); } else { e.currentTarget.blur(); hx.guardar(); }
  };
  const copiar = () => ejecutar(async () => {
    const r = await get(`/planilla/planillas/${p.id}/horas-anteriores`, op);
    if (!r.planilla) { avisar(`No hay ${ANTERIOR[p.tipo]} para copiar`, 'mal'); return; }
    const aqui = new Map(p.lineas.filter((l) => !sinHx(l)).map((l) => [l.empleado_id, l]));
    const usar = r.horas.filter((h) => aqui.has(h.empleado_id));
    if (!usar.length) { avisar(`«${r.planilla.etiqueta}» no tiene horas extra de estos empleados`, 'mal'); return; }
    const reemplaza = usar.filter((h) => Number(aqui.get(h.empleado_id).horas_extra) > 0 && Number(aqui.get(h.empleado_id).horas_extra) !== h.horas).length;
    if (!(await confirmar({ titulo: `Copiar horas de la ${ANTERIOR[p.tipo]}`, textoOk: 'Copiar',
      mensaje: `Se pondrán las horas extra de «${r.planilla.etiqueta}» en ${usar.length} empleado(s).${reemplaza ? `\n${reemplaza} ya tenían horas distintas: se reemplazan.` : ''}\nLos demás no cambian. Puedes corregir cualquier número después.` }))) return;
    hx.ponerVarias(Object.fromEntries(usar.map((h) => [h.empleado_id, String(h.horas)])));
    avisar(`Horas copiadas en ${usar.length} empleado(s): se están guardando`);
  });
  let i = 0;
  return (
    <div ref={caja} className="pl-hx">
      <div className="pl-hx-ayuda">
        <small>Escribe las <b>horas extra</b> de cada empleado de esta {PERIODO[p.tipo]}. Valor de la hora = salario diario ÷ 8{recargo ? ` + ${recargo} %` : ' (tarifa normal)'}. <b>Enter</b> pasa al siguiente. Se guarda solo.</small>
        <button className="btn chico" disabled={ocupado} onClick={copiar}>Copiar horas de la {ANTERIOR[p.tipo]}</button>
      </div>
      <div className="pl-hx-cab" aria-hidden="true"><span>Empleado · valor de la hora</span><span>Horas extra</span><span>Total HX</span><span>Total a pagar</span></div>
      {p.grupos.map((g) => {
        const sub = g.lineas.reduce((t, l) => { const e = estimar(l, hx.sucias[l.empleado_id], recargo); t.h += e.horas; t.hx += e.total_hx; return t; }, { h: 0, hx: 0 });
        return (
          <section key={g.sucursal} className="pl-hx-grupo" aria-label={g.sucursal}>
            <h4><span>{g.sucursal}</span><small>{numero(sub.h, 2)} h · {lempiras(sub.hx)}</small></h4>
            {g.lineas.map((l) => {
              const txt = hx.sucias[l.empleado_id];
              const e = estimar(l, txt, recargo);
              const bloqueada = sinHx(l);
              const capturada = l.detalle?.horas_captura !== undefined;
              const auto = Number(l.detalle?.horas_auto ?? 0);
              const n = i++;
              return (
                <div key={l.empleado_id} className={`pl-hx-fila${e.mala ? ' mala' : ''}${txt !== undefined ? ' sucia' : ''}`}>
                  <label className="pl-hx-emp" htmlFor={`hx-${l.empleado_id}`}><b>{l.nombre}</b>
                    <small>{l.puesto ? `${l.puesto} · ` : ''}{bloqueada ? 'Gerencia: no cobra horas extra' : `${lempiras(l.por_hora)} la hora`}
                      {!bloqueada && capturada && auto > 0 && auto !== e.horas ? ` · reloj y anotadas: ${numero(auto, 2)} h` : ''}</small></label>
                  <input id={`hx-${l.empleado_id}`} data-hx={n} className="pl-hx-in" type="text" inputMode="decimal" enterKeyHint="next" autoComplete="off"
                    value={bloqueada ? '0' : (txt ?? String(Number(l.horas_extra)))} disabled={bloqueada} aria-invalid={e.mala || undefined}
                    aria-label={`Horas extra de ${l.nombre}`} onFocus={(ev) => ev.target.select()} onKeyDown={siguiente}
                    onChange={(ev) => hx.poner(l.empleado_id, ev.target.value)} />
                  <div className="pl-hx-num pl-hx-thx"><small>Total HX</small>{L(e.total_hx)}</div>
                  <div className="pl-hx-num pl-hx-tot"><small>A pagar</small><b>{L(e.total)}</b></div>
                </div>
              );
            })}
          </section>
        );
      })}
      {p.lineas.length === 0 && <Vacio titulo="Esta planilla no tiene empleados">Revisa en RRHH que tengan salario y la periodicidad de pago de esta planilla.</Vacio>}
    </div>
  );
}

function GrupoFilas({ g, decimo, p, celda, texto, abrirDed, op }) {
  const avisar = useAviso();
  return (
    <>
      <tr className="pl-suc"><td colSpan={decimo ? 6 : 12}>{g.sucursal}</td></tr>
      {g.lineas.map((l) => (
        <tr key={l.empleado_id} className={l.editado ? 'pl-editado' : ''}>
          <td>{l.nombre}<br /><small>{l.puesto}</small></td><td>{celda(l, 'dias')}</td><td>{celda(l, 'salario_diario')}</td><td className="der num">{L(l.total_quincenal)}</td>
          {!decimo && <><td>{celda(l, 'por_hora')}</td><td>{celda(l, 'horas_extra')}</td><td>{celda(l, 'total_hx')}</td>
            <td><button className="btn fantasma" onClick={() => abrirDed(l)} title="Ver o editar las deducciones">{L(l.total_deducciones)}{l.deducciones.length ? ` (${l.deducciones.length})` : ''}</button></td><td className="der num"><b>{L(l.total)}</b></td></>}
          <td>{texto(l, 'cuenta', 'pl-cuenta')}</td><td>{texto(l, 'observaciones', 'pl-txt')}</td>
          {!decimo && p.estado !== 'anulada' && <td>{['aprobada', 'pagada'].includes(p.estado) && <button className="btn fantasma" onClick={() => bajar(`/planilla/planillas/${p.id}/boleta/${l.empleado_id}`, { empresa: op?.empresa, abrir: true }).catch((e) => avisar(e.message, 'mal'))}>PDF</button>}</td>}
        </tr>))}
      <tr className="pl-tot"><td>Total {g.sucursal}</td><td /><td /><td className="der num">{L(g.totales.total_quincenal)}</td>{!decimo && <><td /><td className="num">{L(g.totales.horas_extra)}</td><td className="num">{L(g.totales.total_hx)}</td><td className="num">{L(g.totales.total_deducciones)}</td><td className="der num">{L(g.totales.total)}</td></>}<td /><td /><td /></tr>
    </>
  );
}

function Deducciones({ linea, edita, onCerrar, onGuardar }) {
  const [ded, setDed] = useState(linea.deducciones.map((d) => ({ ...d })));
  const mal = ded.some((d) => !d.concepto.trim() || !(Number(d.monto) >= 0));
  return (
    <Modal titulo={`Deducciones · ${linea.nombre}`} tam="angosto" onCerrar={onCerrar} pie={edita ? <button className="btn primario" disabled={mal} onClick={() => onGuardar(ded.filter((d) => Number(d.monto) > 0).map((d) => ({ concepto: d.concepto.trim(), monto: Number(d.monto) })))}>Guardar</button> : null}>
      <div>
        {ded.length === 0 && <p>Sin deducciones.</p>}
        {ded.map((d, i) => (
          <div className="pl-ded" key={i}>
            <input value={d.concepto} disabled={!edita} placeholder="Concepto (anticipo, IHSS, préstamo…)" onChange={(e) => setDed(ded.map((x, k) => (k === i ? { ...x, concepto: e.target.value } : x)))} aria-label="Concepto" />
            <input type="number" inputMode="decimal" min="0" value={d.monto} disabled={!edita} onChange={(e) => setDed(ded.map((x, k) => (k === i ? { ...x, monto: e.target.value } : x)))} aria-label="Monto" />
            {edita && <button className="btn fantasma" onClick={() => setDed(ded.filter((_, k) => k !== i))} aria-label="Quitar">×</button>}
          </div>))}
        {edita && <button className="btn" onClick={() => setDed([...ded, { concepto: '', monto: '', tipo: 'manual' }])}>+ Agregar deducción</button>}
      </div>
    </Modal>
  );
}

function Novedades({ op }) {
  const d = useDatos(() => get('/planilla/novedades', op), [op?.empresa]);
  const emps = useDatos(() => get('/planilla/empleados', op), [op?.empresa]);
  const [f, setF] = useState({ empleado_id: '', fecha: fechaHN(), tipo: 'he_diurna', horas: '', monto: '', concepto: '' });
  const [ejecutar, ocupado] = useAccion();
  const horas = f.tipo.startsWith('he_');
  const NOMBRES = { he_diurna: 'Hora extra diurna', he_nocturna: 'Hora extra nocturna', he_feriada: 'Hora extra feriado', bono: 'Bono', descuento: 'Descuento' };
  const agregar = () => ejecutar(async () => { await post('/planilla/novedades', { empleado_id: f.empleado_id, fecha: f.fecha, tipo: f.tipo, concepto: f.concepto || null, ...(horas ? { horas: Number(f.horas) } : { monto: Number(f.monto) }) }, op); setF({ ...f, horas: '', monto: '', concepto: '' }); d.recargar(); }, 'Anotado');
  return (
    <>
      <small>Bonos, descuentos y horas extra de un día puntual: entran solos a la planilla del periodo. <b>Para las horas extra de toda la quincena es más rápido</b> abrir la planilla en borrador y escribirlas en «1 · Horas extra».</small>
      <div className="tarjeta" style={{ display: 'grid', gap: 10, marginTop: 8 }}>
        <Campo etiqueta="Empleado"><select value={f.empleado_id} onChange={(e) => setF({ ...f, empleado_id: e.target.value })}><option value="">Elige…</option>{(emps.datos ?? []).map((e) => <option key={e.id} value={e.id}>{e.nombre}</option>)}</select></Campo>
        <Campo etiqueta="Tipo"><select value={f.tipo} onChange={(e) => setF({ ...f, tipo: e.target.value })}>{Object.entries(NOMBRES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Campo>
        <Campo etiqueta="Fecha"><input type="date" value={f.fecha} onChange={(e) => setF({ ...f, fecha: e.target.value })} /></Campo>
        {horas ? <Campo etiqueta="Horas"><input type="number" inputMode="decimal" min="0" value={f.horas} onChange={(e) => setF({ ...f, horas: e.target.value })} /></Campo>
          : <Campo etiqueta="Monto (L)"><input type="number" inputMode="decimal" min="0" value={f.monto} onChange={(e) => setF({ ...f, monto: e.target.value })} /></Campo>}
        <Campo etiqueta="Concepto (opcional)"><input value={f.concepto} onChange={(e) => setF({ ...f, concepto: e.target.value })} /></Campo>
        <button className="btn primario" disabled={ocupado || !f.empleado_id || !(Number(horas ? f.horas : f.monto) > 0)} onClick={agregar}>Anotar</button>
      </div>
      <Estado d={d}>{(rows) => rows.length === 0 ? null : (
        <div className="tarjeta pad0" style={{ marginTop: 10 }}><div className="tabla-wrap"><table>
          <thead><tr><th>Fecha</th><th>Empleado</th><th>Tipo</th><th className="der">Cantidad</th><th>Estado</th><th /></tr></thead>
          <tbody>{rows.map((n) => <tr key={n.id} style={{ opacity: n.estado === 'anulada' ? 0.5 : 1 }}><td className="num">{n.fecha}</td><td>{n.empleado}</td><td>{NOMBRES[n.tipo]}{n.concepto ? <small> · {n.concepto}</small> : null}</td>
            <td className="der num">{n.horas != null ? `${n.horas} h` : lempiras(n.monto)}</td><td>{n.estado}</td>
            <td>{n.estado === 'pendiente' && <button className="btn fantasma" onClick={() => ejecutar(async () => { await api(`/planilla/novedades/${n.id}`, { metodo: 'DELETE', ...op }); d.recargar(); }, 'Anulada')}>Anular</button>}</td></tr>)}</tbody>
        </table></div></div>)}</Estado>
    </>
  );
}

function Config({ op }) {
  const cfg = useDatos(() => get('/planilla/config', op), [op?.empresa]);
  const fijas = useDatos(() => get('/planilla/fijas', op), [op?.empresa]);
  const par = useDatos(() => get('/planilla/parametros', op), []);
  const [ejecutar, ocupado] = useAccion();
  const [nf, setNf] = useState({ empleado_id: '', concepto: 'IHSS', monto_mensual: '' });
  const ihssSug = par.datos?.parametros.find((x) => x.clave === 'ihss_fijo_mensual')?.valor;
  return (
    <Estado d={cfg}>{(c) => (
      <div style={{ display: 'grid', gap: 14 }}>
        <div className="tarjeta"><h3>¿Cada cuánto se paga?</h3>
          <Campo etiqueta="Por defecto en esta empresa" ayuda="Cada empleado puede ser una excepción (por ejemplo, unos semanales y otros quincenales). Una planilla solo incluye a los de su periodicidad.">
            <select value={c.periodicidad_empresa} disabled={ocupado} onChange={(e) => ejecutar(async () => { await put('/planilla/config', { periodicidad: e.target.value }, op); cfg.recargar(); }, 'Guardado')}>{c.periodicidades.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</select></Campo>
          <small>Semana: {c.semana.dias_pago} días pagados, empieza el día {c.semana.inicio_dia} (1 = lunes) y se paga el día {c.semana.dia_pago}. Se cambia en «Parámetros». <b>Por confirmar.</b></small></div>
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Empleado</th><th>Sucursal</th><th>Se le paga</th></tr></thead>
          <tbody>{c.empleados.map((e) => <tr key={e.id}><td>{e.nombre}{!e.con_salario && <small> · sin salario</small>}</td><td>{e.sucursal ?? '—'}</td>
            <td><select value={e.excepcion ?? ''} disabled={ocupado} aria-label={`Periodicidad de ${e.nombre}`} onChange={(ev) => ejecutar(async () => { await put(`/planilla/empleados/${e.id}/periodicidad`, { periodicidad: ev.target.value || null }, op); cfg.recargar(); })}>
              <option value="">Como la empresa ({c.periodicidades.find((p) => p.id === c.periodicidad_empresa).nombre})</option>{c.periodicidades.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</select></td></tr>)}</tbody></table></div></div>
        <div className="tarjeta"><h3>Deducciones fijas</h3><small>Se descuentan solas en cada planilla (el monto es mensual: quincena = mitad). Para algo de una sola vez, corrige la celda en la planilla.</small>
          <div style={{ display: 'grid', gap: 8, margin: '10px 0' }}>
            <select value={nf.empleado_id} onChange={(e) => setNf({ ...nf, empleado_id: e.target.value })} aria-label="Empleado"><option value="">Empleado…</option>{c.empleados.map((e) => <option key={e.id} value={e.id}>{e.nombre}</option>)}</select>
            <input value={nf.concepto} onChange={(e) => setNf({ ...nf, concepto: e.target.value })} placeholder="Concepto" aria-label="Concepto" />
            <input type="number" inputMode="decimal" value={nf.monto_mensual} onChange={(e) => setNf({ ...nf, monto_mensual: e.target.value })} placeholder={`Monto mensual${ihssSug ? ` (IHSS sugerido ${ihssSug})` : ''}`} aria-label="Monto mensual" />
            <button className="btn primario" disabled={ocupado || !nf.empleado_id || !nf.concepto || !(Number(nf.monto_mensual) > 0)} onClick={() => ejecutar(async () => { await post('/planilla/fijas', { ...nf, monto_mensual: Number(nf.monto_mensual) }, op); setNf({ ...nf, monto_mensual: '' }); fijas.recargar(); }, 'Agregada')}>Agregar</button></div>
          <Estado d={fijas}>{(rows) => rows.length === 0 ? <small>Ninguna todavía.</small> : <table><tbody>{rows.map((f) => <tr key={f.id}><td>{f.empleado}</td><td>{f.concepto}</td><td className="der num">{lempiras(Number(f.monto_mensual) / 2)} / quincena <small>({lempiras(f.monto_mensual)} al mes)</small></td>
            <td><button className="btn fantasma" onClick={() => ejecutar(async () => { await api(`/planilla/fijas/${f.id}`, { metodo: 'DELETE', ...op }); fijas.recargar(); }, 'Quitada')}>Quitar</button></td></tr>)}</tbody></table>}</Estado></div>
      </div>
    )}</Estado>
  );
}

function Contable({ op }) {
  const hoy = fechaHN();
  const [anio, setAnio] = useState(hoy.slice(0, 4)); const [mes, setMes] = useState(String(Number(hoy.slice(5, 7))));
  const d = useDatos(() => get(`/planilla/resumen-contable${qs({ anio, mes })}`, op), [anio, mes, op?.empresa]);
  return (
    <>
      <div className="iu-filtros"><input type="number" value={anio} onChange={(e) => setAnio(e.target.value)} aria-label="Año" style={{ width: 100 }} />
        <select value={mes} onChange={(e) => setMes(e.target.value)} aria-label="Mes">{['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'].map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></div>
      <Estado d={d}>{(r) => r.planillas.length === 0 ? <Vacio titulo="Sin planillas aprobadas en ese mes">Aquí suman las planillas aprobadas o pagadas.</Vacio> : (
        <div style={{ display: 'grid', gap: 12 }}>
          {r.sin_confirmar && <div className="pl-aviso-conf">Incluye planillas calculadas con parámetros por confirmar.</div>}
          <small>{r.planillas.map((p) => p.etiqueta).join(' · ')}</small>
          <div className="iu-tarjetas">
            <div className="tarjeta"><h3>Gasto del mes</h3><table><tbody>{r.contable.gastos.map((g) => <tr key={g.cuenta}><td>{g.cuenta}</td><td className="der num">{lempiras(g.monto)}</td></tr>)}<tr className="pl-tot"><td><b>Total</b></td><td className="der num"><b>{lempiras(r.contable.total_gasto)}</b></td></tr></tbody></table></div>
            <div className="tarjeta"><h3>Por pagar</h3><table><tbody>{r.contable.por_pagar.map((g) => <tr key={g.cuenta}><td>{g.cuenta}</td><td className="der num">{lempiras(g.monto)}</td></tr>)}<tr className="pl-tot"><td><b>Total</b></td><td className="der num"><b>{lempiras(r.contable.total_por_pagar)}</b></td></tr></tbody></table></div>
          </div>
        </div>
      )}</Estado>
    </>
  );
}

function Parametros({ op }) {
  const { usuario } = useSesion();
  const d = useDatos(() => get('/planilla/parametros', op), []);
  const [cambios, setCambios] = useState({});
  const [ejecutar, ocupado] = useAccion();
  const pedir = usePedirTexto();
  const GRUPOS = { general: 'Días y horas', horas: 'Horas extra', ihss: 'IHSS fijo', decimos: 'Aguinaldo y catorceavo', ley: 'Porcentajes de ley (apagados)' };
  return (
    <Estado d={d}>{(p) => (
      <div style={{ display: 'grid', gap: 12 }}>
        <div className="pl-aviso-conf"><b>Valores de arranque, por confirmar con el contador.</b> {p.aviso} {p.puede_editar ? 'Al cambiar uno vuelve a quedar «por confirmar».' : 'Solo el dueño del grupo puede cambiarlos.'}</div>
        {Object.entries(GRUPOS).map(([g, nombre]) => (
          <div className="tarjeta" key={g}><h3>{nombre}</h3>
            {p.parametros.filter((x) => x.grupo === g || (g === 'general' && x.grupo === 'vacaciones')).map((x) => (
              <div className="pl-param" key={x.clave}>
                <div>{x.nombre}{x.nota && <small>{x.nota}</small>}</div>
                <div><input type="number" step="any" defaultValue={x.valor} disabled={!p.puede_editar} aria-label={x.nombre} onChange={(e) => setCambios({ ...cambios, [x.clave]: e.target.value })} /> <small>{x.unidad}</small></div>
                <div>{x.por_confirmar ? <span className="iu-estado bajo">por confirmar</span> : <span className="iu-estado ok">confirmado</span>}</div>
              </div>))}
          </div>))}
        <div className="tarjeta"><h3>Tabla del ISR (renta anual)</h3><small>Solo se usa si activas los porcentajes de ley.</small>
          <table><thead><tr><th>Desde (L)</th><th className="der">Tasa</th></tr></thead><tbody>{p.tramos.map((t) => <tr key={t.id}><td className="num">{lempiras(t.desde)}</td><td className="der num">{t.tasa} %</td></tr>)}</tbody></table></div>
        {p.puede_editar && <div className="pl-acciones">
          <button className="btn primario" disabled={ocupado || !Object.keys(cambios).length} onClick={() => ejecutar(async () => { await put('/planilla/parametros', { valores: cambios }, op); setCambios({}); d.recargar(); }, 'Parámetros guardados (quedan por confirmar)')}>Guardar cambios</button>
          <button className="btn" disabled={ocupado || !p.por_confirmar} onClick={async () => { const contador = await pedir({ titulo: 'Confirmar con el contador', etiqueta: 'Nombre del contador que lo validó', obligatorio: true, minimo: 3, textoOk: 'Marcar confirmados' }); if (contador) ejecutar(async () => { await post('/planilla/parametros/confirmar', { contador }, op); d.recargar(); }, 'Parámetros confirmados'); }}>Marcar todos como confirmados</button></div>}
        {!usuario?.es_dueno_grupo && <small>Eres administrador de esta empresa: puedes ver los parámetros.</small>}
      </div>
    )}</Estado>
  );
}
