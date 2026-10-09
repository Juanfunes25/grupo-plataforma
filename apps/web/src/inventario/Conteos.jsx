// Conteos cíclicos: programar → contar (táctil) → enviar → el gerente aprueba y se ajusta con bitácora.
import { useRef, useState } from 'react';
import { fechaHN, lempiras, numero } from '@grupo/shared';
import { get, post, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, Modal, Vacio, useAccion, useAviso, useConfirmar, useDatos, usePedirTexto } from '../ui/kit.jsx';

const ESTADO = { programado: 'Programado', en_conteo: 'Contando', por_aprobar: 'Por aprobar', aplicado: 'Aplicado', cancelado: 'Cancelado' };

export function Conteos() {
  const { puede } = useSesion();
  const [ver, setVer] = useState('abiertos');
  const d = useDatos(() => get(`/inv/u/conteos${qs({ estado: ver === 'todos' ? '' : 'abiertos' })}`), [ver]);
  const [nuevo, setNuevo] = useState(false);
  const [abierto, setAbierto] = useState(null);
  return (
    <>
      <div className="iu-filtros">
        <select value={ver} onChange={(e) => setVer(e.target.value)} aria-label="Ver"><option value="abiertos">Pendientes</option><option value="todos">Todos</option></select>
        {puede('inv:mover') && <button className="btn primario" onClick={() => setNuevo(true)}>+ Programar conteo</button>}
      </div>
      <Estado d={d}>{(rows) => rows.length === 0 ? <Vacio titulo="Sin conteos">Programa un conteo por sucursal, categoría o tipo de inventario.</Vacio> : (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>#</th><th>Conteo</th><th>Fecha</th><th>Avance</th><th>Estado</th></tr></thead>
          <tbody>{rows.map((c) => (
            <tr key={c.id} onClick={() => setAbierto(c.id)} style={{ cursor: 'pointer' }}>
              <td className="num">{c.numero}</td><td>{c.nombre}<br /><small>{[c.sucursal, c.categoria].filter(Boolean).join(' · ') || 'Todo el inventario'}</small></td>
              <td className="num">{c.fecha_programada}{c.vencido && <span className="iu-estado agotado"> atrasado</span>}</td>
              <td className="num">{c.lineas ? `${c.contadas}/${c.lineas}` : '—'}{c.con_diferencia ? <small> · {c.con_diferencia} con diferencia</small> : null}</td>
              <td><span className={`iu-estado ${c.estado === 'aplicado' ? 'ok' : c.estado === 'cancelado' ? 'sin_cargar' : 'bajo'}`}>{ESTADO[c.estado]}</span></td></tr>))}</tbody>
        </table></div></div>
      )}</Estado>
      {nuevo && <Programar onCerrar={() => setNuevo(false)} onListo={() => { setNuevo(false); d.recargar(); }} />}
      {abierto && <Detalle id={abierto} onCerrar={() => { setAbierto(null); d.recargar(); }} />}
    </>
  );
}

function Programar({ onCerrar, onListo }) {
  const ex = useDatos(() => get('/inv/u/existencias?q=__'), []);
  const [f, setF] = useState({ nombre: '', fecha_programada: fechaHN(), sucursal_id: '', fuente: '', categoria: '', ciego: true, notas: '' });
  const [ejecutar, ocupado] = useAccion();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const fl = ex.datos?.filtros;
  const crear = () => ejecutar(async () => { await post('/inv/u/conteos', { ...f, sucursal_id: f.sucursal_id || null, fuente: f.fuente || null, categoria: f.categoria || null, notas: f.notas || null }); onListo(); }, 'Conteo programado');
  return (
    <Modal titulo="Programar conteo" onCerrar={onCerrar} pie={<button className="btn primario" disabled={ocupado || f.nombre.trim().length < 2} onClick={crear}>Programar</button>}>
      <div style={{ display: 'grid', gap: 12 }}>
        <Campo etiqueta="Nombre"><input value={f.nombre} onChange={set('nombre')} placeholder="Ej. Conteo de vasos de Mackey" autoFocus /></Campo>
        <Campo etiqueta="Fecha"><input type="date" value={f.fecha_programada} onChange={set('fecha_programada')} /></Campo>
        {fl?.sucursales.length > 1 && <Campo etiqueta="Ubicación (sucursal)"><select value={f.sucursal_id} onChange={set('sucursal_id')}><option value="">Todas</option>{fl.sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select></Campo>}
        {fl?.fuentes.length > 1 && <Campo etiqueta="Tipo de inventario"><select value={f.fuente} onChange={set('fuente')}><option value="">Todo</option>{fl.fuentes.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select></Campo>}
        <Campo etiqueta="Categoría"><select value={f.categoria} onChange={set('categoria')}><option value="">Todas</option>{(fl?.categorias ?? []).map((c) => <option key={c}>{c}</option>)}</select></Campo>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={f.ciego} onChange={set('ciego')} /> Conteo a ciegas (quien cuenta no ve lo que dice el sistema)</label>
        <Campo etiqueta="Notas (opcional)"><input value={f.notas} onChange={set('notas')} /></Campo>
      </div>
    </Modal>
  );
}

function Detalle({ id, onCerrar }) {
  const { puede } = useSesion();
  const d = useDatos(() => get(`/inv/u/conteos/${id}`), [id]);
  const [ejecutar, ocupado] = useAccion();
  const confirmar = useConfirmar(); const pedir = usePedirTexto(); const avisar = useAviso();
  const pend = useRef({});            // lo contado todavía sin guardar: { lineaId: valor }
  const [, forzar] = useState(0);
  const [decide, setDecide] = useState({});
  const c = d.datos;
  const guardar = async () => {
    const lineas = Object.entries(pend.current).map(([lid, contado]) => ({ id: lid, contado }));
    if (!lineas.length) return true;
    try { await post(`/inv/u/conteos/${id}/captura`, { lineas }); pend.current = {}; return true; } catch (e) { avisar(e.message, 'mal'); return false; }
  };
  const poner = (l, v) => { pend.current[l.id] = v === '' ? null : Number(v); l.contado = v === '' ? null : Number(v); forzar((x) => x + 1); };
  const accion = (ruta, cuerpo, ok) => ejecutar(async () => { if (!(await guardar())) throw new Error('No se pudo guardar lo contado'); await post(`/inv/u/conteos/${id}/${ruta}`, cuerpo); await d.recargar(); }, ok);

  return (
    <Modal titulo={c ? `Conteo #${c.numero} · ${c.nombre}` : 'Conteo'} tam="ancho" onCerrar={async () => { await guardar(); onCerrar(); }}>
      <Estado d={d}>{(c) => {
        const contables = c.estado === 'en_conteo';
        return (
          <div style={{ display: 'grid', gap: 12 }}>
            <small>{[c.sucursal, c.categoria, c.ciego ? 'A ciegas' : null, `Fecha ${c.fecha_programada}`].filter(Boolean).join(' · ')}</small>
            {c.estado === 'programado' && puede('inv:mover') && <button className="btn primario" disabled={ocupado} onClick={() => accion('iniciar', {}, 'Conteo iniciado: se congeló lo que dice el sistema')}>Iniciar conteo</button>}
            {c.lineas.length > 0 && <div><b>{c.resumen.contadas}/{c.resumen.total}</b> contados{c.resumen.con_diferencia ? <> · <b>{c.resumen.con_diferencia}</b> con diferencia</> : null}
              {c.resumen.valor_faltante != null && (c.resumen.valor_faltante !== 0 || c.resumen.valor_sobrante !== 0) && <> · faltante {lempiras(c.resumen.valor_faltante)} · sobrante {lempiras(c.resumen.valor_sobrante)}</>}</div>}
            {contables && <div className="iu-tarjetas">{c.lineas.map((l) => (
              <div key={l.id} className={`iu-cap ${l.contado != null ? 'hecho' : ''}`}>
                <div><b>{l.nombre}</b><small>{[l.sucursal, l.categoria].filter(Boolean).join(' · ')}{!c.oculto && l.esperado != null ? ` · sistema ${numero(l.esperado, 2)}` : ''}</small></div>
                <div className="iu-cantidad">
                  <button className="btn" aria-label="Restar" onClick={() => poner(l, Math.max(0, (l.contado ?? 0) - 1))}>−</button>
                  <input type="number" inputMode="decimal" min="0" value={l.contado ?? ''} placeholder={l.unidad} onChange={(e) => poner(l, e.target.value)} onBlur={guardar} aria-label={`Contado de ${l.nombre}`} />
                  <button className="btn" aria-label="Sumar" onClick={() => poner(l, (l.contado ?? 0) + 1)}>+</button>
                </div>
              </div>))}</div>}
            {contables && <div className="iu-barra"><button className="btn" disabled={ocupado} onClick={() => ejecutar(async () => { if (!(await guardar())) throw new Error('No se pudo guardar'); }, 'Avance guardado')}>Guardar avance</button>
              <button className="btn primario" disabled={ocupado} onClick={async () => { if (c.resumen.contadas < c.resumen.total && !(await confirmar({ mensaje: `Faltan ${c.resumen.total - c.resumen.contadas} sin contar; no se tocarán. ¿Enviar a aprobación?`, textoOk: 'Enviar' }))) return; accion('enviar', {}, 'Enviado al gerente para aprobar'); }}>Enviar a aprobación</button></div>}
            {(c.estado === 'por_aprobar' || c.estado === 'aplicado') && (
              <div className="tarjeta pad0"><div className="tabla-wrap"><table>
                <thead><tr><th>Ítem</th><th className="der">Sistema</th><th className="der">Contado</th><th className="der">Diferencia</th>{c.lineas.some((l) => l.valor_diferencia != null) && <th className="der">Valor</th>}<th>{c.estado === 'aplicado' ? 'Decisión' : 'Ajustar'}</th></tr></thead>
                <tbody>{c.lineas.map((l) => {
                  const dif = l.diferencia; const hay = dif != null && dif !== 0;
                  const dec = decide[l.id] ?? 'ajustar';
                  return (<tr key={l.id}><td>{l.nombre}<small>{l.sucursal ? ` · ${l.sucursal}` : ''}</small></td><td className="der num">{numero(l.esperado, 2)}</td><td className="der num">{l.contado == null ? '—' : numero(l.contado, 2)}</td>
                    <td className={`der num iu-dif ${dif < 0 ? 'falta' : dif > 0 ? 'sobra' : ''}`}>{dif == null ? '' : (dif > 0 ? '+' : '') + numero(dif, 2)}</td>
                    {c.lineas.some((x) => x.valor_diferencia != null) && <td className="der num">{l.valor_diferencia != null && hay ? lempiras(l.valor_diferencia) : ''}</td>}
                    <td>{c.estado === 'aplicado' ? (l.decision === 'ajustar' ? 'Ajustado' : hay ? 'Ignorado' : '') : hay && puede('inv:aprobar') ? (
                      <select value={dec} onChange={(e) => setDecide({ ...decide, [l.id]: e.target.value })} aria-label={`Decisión de ${l.nombre}`}><option value="ajustar">Ajustar</option><option value="ignorar">Ignorar</option></select>) : ''}</td></tr>);
                })}</tbody>
              </table></div></div>)}
            {c.estado === 'por_aprobar' && (puede('inv:aprobar') ? <button className="btn primario" disabled={ocupado} onClick={async () => {
              const nota = await pedir({ titulo: 'Aprobar conteo', mensaje: 'Se ajustará el inventario con las diferencias elegidas y quedará en la bitácora.', etiqueta: 'Motivo de la aprobación', obligatorio: true, minimo: 3, textoOk: 'Aprobar y ajustar' });
              if (nota) ejecutar(async () => { const r = await post(`/inv/u/conteos/${id}/aprobar`, { nota, decisiones: Object.entries(decide).map(([i, decision]) => ({ id: i, decision })) }); avisar(`${r.ajustadas} ajuste(s) aplicados`); await d.recargar(); });
            }}>Aprobar y ajustar</button> : <div className="aviso-caja">Esperando que un gerente apruebe las diferencias.</div>)}
            {c.estado === 'aplicado' && <div className="aviso-caja">Aprobado. {c.nota_aprobacion}</div>}
            {['programado', 'en_conteo', 'por_aprobar'].includes(c.estado) && puede('inv:mover') && <button className="btn peligro" disabled={ocupado} onClick={async () => { if (await confirmar({ mensaje: '¿Cancelar este conteo? No se ajustará nada.', peligro: true, textoOk: 'Cancelar conteo' })) ejecutar(async () => { await post(`/inv/u/conteos/${id}/cancelar`, {}); await d.recargar(); }); }}>Cancelar conteo</button>}
          </div>
        );
      }}</Estado>
    </Modal>
  );
}
