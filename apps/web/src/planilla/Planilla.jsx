// Planilla: la hoja quincenal/semanal de la empresa (Empleado · DIAS · SALARIO DIARIO · TOTAL QUINCENAL · POR HORA · HORAS EXTRAS ·
// TOTAL HX · deducciones · TOTAL · cuenta · OBSERVACIONES), pre-llenada desde RRHH y editable celda por celda antes de aprobar.
// Solo dueño / administrador con rrhh:sensible. Los parámetros de ley están «por confirmar con el contador».
import { useState } from 'react';
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
  const tabs = [['planillas', 'Planillas'], ['novedades', 'Horas extra y bonos'], ['config', 'Pago y deducciones fijas'], ['contable', 'Resumen contable'], ['parametros', 'Parámetros']];
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

function Nueva({ op, onCerrar, onListo }) {
  const cfg = useDatos(() => get('/planilla/config', op), [op?.empresa]);
  const hoy = fechaHN();
  const [f, setF] = useState({ tipo: '', anio: hoy.slice(0, 4), mes: String(Number(hoy.slice(5, 7))), quincena: Number(hoy.slice(8)) <= 15 ? '1' : '2', desde: '' });
  const [ejecutar, ocupado] = useAccion();
  const tipo = f.tipo || (cfg.datos?.periodicidad_empresa ?? 'quincena');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const crear = () => ejecutar(async () => {
    const cuerpo = { tipo };
    if (tipo === 'semanal') cuerpo.desde = f.desde;
    if (['quincena', 'mensual'].includes(tipo)) { cuerpo.anio = Number(f.anio); cuerpo.mes = Number(f.mes); if (tipo === 'quincena') cuerpo.quincena = Number(f.quincena); }
    if (['aguinaldo', 'catorceavo'].includes(tipo)) cuerpo.anio = Number(f.anio);
    onListo(await post('/planilla/planillas', cuerpo, op));
  }, 'Planilla armada desde RRHH');
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  return (
    <Modal titulo="Nueva planilla" tam="angosto" onCerrar={onCerrar} pie={<button className="btn primario" disabled={ocupado || (tipo === 'semanal' && !f.desde)} onClick={crear}>Armar planilla</button>}>
      <div style={{ display: 'grid', gap: 12 }}>
        <Campo etiqueta="Tipo" ayuda={cfg.datos ? `La empresa paga ${TIPOS[cfg.datos.periodicidad_empresa].toLowerCase()} por defecto. Solo entran los empleados con esa periodicidad.` : ''}>
          <select value={tipo} onChange={set('tipo')}>{Object.entries(TIPOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Campo>
        {tipo === 'semanal' && <Campo etiqueta="Primer día de la semana" ayuda="Debe ser el día en que empieza la semana de pago (por defecto lunes)."><input type="date" value={f.desde} onChange={set('desde')} /></Campo>}
        {['quincena', 'mensual'].includes(tipo) && <><Campo etiqueta="Mes"><select value={f.mes} onChange={set('mes')}>{MESES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></Campo>
          <Campo etiqueta="Año"><input type="number" value={f.anio} onChange={set('anio')} /></Campo></>}
        {tipo === 'quincena' && <Campo etiqueta="Quincena"><select value={f.quincena} onChange={set('quincena')}><option value="1">1 al 15</option><option value="2">16 al fin de mes</option></select></Campo>}
        {['aguinaldo', 'catorceavo'].includes(tipo) && <Campo etiqueta="Año"><input type="number" value={f.anio} onChange={set('anio')} /></Campo>}
      </div>
    </Modal>
  );
}

function Hoja({ id, op, onCerrar }) {
  const { usuario } = useSesion();
  const d = useDatos(() => get(`/planilla/planillas/${id}`, op), [id]);
  const [ejecutar, ocupado] = useAccion();
  const confirmar = useConfirmar(); const pedir = usePedirTexto(); const avisar = useAviso();
  const [dedDe, setDedDe] = useState(null);
  const run = (fn, ok) => ejecutar(async () => { await fn(); await d.recargar(); }, ok);
  return (
    <Modal titulo={d.datos ? d.datos.etiqueta : 'Planilla'} tam="ancho" onCerrar={onCerrar}>
      <Estado d={d}>{(p) => {
        const edita = p.estado === 'borrador';
        const decimo = p.tipo === 'aguinaldo' || p.tipo === 'catorceavo';
        const celda = (l, campo, extra = {}) => (
          <input type="number" inputMode="decimal" step="any" min="0" defaultValue={l[campo]} disabled={!edita || ocupado} aria-label={`${campo} de ${l.nombre}`} {...extra}
            onBlur={(e) => { if (String(e.target.value) === String(l[campo]) || e.target.value === '') return; run(() => patch(`/planilla/planillas/${p.id}/lineas/${l.id}`, { [campo]: Number(e.target.value) }, op)); }} />);
        const texto = (l, campo, cls) => (
          <input className={cls} defaultValue={l[campo] ?? ''} disabled={!edita || ocupado} aria-label={`${campo} de ${l.nombre}`}
            onBlur={(e) => { if (e.target.value === (l[campo] ?? '')) return; run(() => patch(`/planilla/planillas/${p.id}/lineas/${l.id}`, { [campo]: e.target.value }, op)); }} />);
        return (
          <div style={{ display: 'grid', gap: 10 }}>
            <div><span className={`iu-estado ${ESTADOS[p.estado][1]}`}>{ESTADOS[p.estado][0]}</span> <small>{TIPOS[p.tipo]} · {p.desde} al {p.hasta} · pago {p.fecha_pago ?? '—'}</small></div>
            {p.por_confirmar && <div className="pl-aviso-conf">Calculada con parámetros <b>por confirmar con el contador</b>.</div>}
            <div className="rejilla cols-4">
              <Kpi acento etiqueta="Total a pagar" valor={lempiras(p.totales.total)} /><Kpi etiqueta="Empleados" valor={p.totales.empleados} sub={p.control.sin_cuenta ? `${p.control.sin_cuenta} sin número de cuenta` : 'Todos con cuenta'} />
              <Kpi etiqueta={decimo ? 'Total días × diario' : 'Sueldos + horas extra'} valor={lempiras(p.totales.total_quincenal + p.totales.total_hx)} /><Kpi etiqueta="Deducciones" valor={lempiras(p.totales.total_deducciones)} /></div>
            {p.advertencias.filter((a) => a.nivel !== 'info' || true).length > 0 && (
              <details><summary><b>{p.advertencias.length}</b> aviso(s) para revisar</summary>
                <ul>{p.advertencias.map((a, i) => <li key={i}>{a.empleado ? <b>{a.empleado}: </b> : null}{a.mensaje}</li>)}</ul></details>)}
            <div className="pl-acciones">
              {edita && <button className="btn" disabled={ocupado} onClick={() => run(() => post(`/planilla/planillas/${p.id}/recalcular`, {}, op), 'Recalculada (lo corregido a mano se conserva)')}>Volver a llenar desde RRHH</button>}
              {edita && <button className="btn primario" disabled={ocupado} onClick={async () => { if (await confirmar({ titulo: 'Aprobar planilla', mensaje: 'Al aprobarla queda inalterable. Solo el dueño puede reabrirla, con motivo.', textoOk: 'Aprobar' })) run(() => post(`/planilla/planillas/${p.id}/aprobar`, {}, op), 'Planilla aprobada'); }}>Aprobar y cerrar</button>}
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
            {dedDe && <Deducciones linea={dedDe} edita={edita} onCerrar={() => setDedDe(null)} onGuardar={(deducciones) => { run(() => patch(`/planilla/planillas/${p.id}/lineas/${dedDe.id}`, { deducciones }, op), 'Deducciones guardadas'); setDedDe(null); }} />}
          </div>
        );
      }}</Estado>
    </Modal>
  );
}

function GrupoFilas({ g, decimo, p, celda, texto, abrirDed, op }) {
  const avisar = useAviso();
  return (
    <>
      <tr className="pl-suc"><td colSpan={decimo ? 6 : 12}>{g.sucursal}</td></tr>
      {g.lineas.map((l) => (
        <tr key={l.id} className={l.editado ? 'pl-editado' : ''}>
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
      <small>Lo que se anota aquí entra solo a la planilla del periodo. Las horas extra también se sugieren desde el reporte de horas.</small>
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
