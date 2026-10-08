import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { lempiras } from '@grupo/shared';
import { get, post, put } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, Kpi, Modal, Tabs, useAccion, useAviso, useDatos } from '../ui/kit.jsx';
import { Chip, ChipEstado, fechaCorta, hoyIso, n } from '../fab/comun.jsx';
import { imprimirEtiqueta } from '../fab/etiqueta.js';

const TIPO_AGENDA = { colada: ['Colada', 'aviso'], inventario: ['Lista para vender', 'ok'] };

/** Órdenes de producción, agenda, colada (descuenta insumos), secado, paso a «lista para vender», calidad, MRP, moldes y parámetros. */
export default function Fabricacion() {
  const { puede, contexto, empresa } = useSesion();
  const navegar = useNavigate();
  const avisar = useAviso();
  const [tab, setTab] = useState('agenda');
  const [filtro, setFiltro] = useState('planificada,curando');
  const [nueva, setNueva] = useState(null);
  const [moldeForm, setMoldeForm] = useState(null);
  const [detalleId, setDetalleId] = useState(null);
  const gerencia = puede('fab:editar');
  const produce = puede('fab:registrar');
  const termina = gerencia || contexto?.rol === 'bodega';
  const resumen = useDatos(() => get('/fab/resumen'), []);
  const agenda = useDatos(() => get('/fab/agenda'), []);
  const ordenes = useDatos(() => get(`/fab/ordenes?estado=${filtro}`), [filtro]);
  const mrp = useDatos(() => get('/fab/mrp'), []);
  const moldes = useDatos(() => get('/fab/moldes'), []);
  const params = useDatos(() => get('/fab/parametros'), []);
  const productos = useDatos(() => get('/fab/productos'), []);
  const [ejecutar] = useAccion();
  const recargar = () => { resumen.recargar(); agenda.recargar(); ordenes.recargar(); mrp.recargar(); moldes.recargar(); };

  async function pasarAListo(x) {
    const faltan = x.fecha_disponible && String(x.fecha_disponible).slice(0, 10) > hoyIso();
    const msg = `${x.lote}: ${n(x.m2_planificado, 2)} de ${x.producto}.\n${faltan ? `Todavía está en secado hasta el ${fechaCorta(x.fecha_disponible)}. ` : ''}¿Pasarla ahora a "Lista para vender" y sumarla al inventario?`;
    if (!window.confirm(msg)) return recargar();
    const r = await ejecutar(() => post(`/fab/ordenes/${x.id}/terminar`, {}), `Lista para vender: ${n(x.m2_planificado, 2)} de ${x.producto} ya están en el inventario de piedra.`);
    if (r) recargar();
  }
  const r = resumen.datos;

  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Órdenes y agenda</h1></div>
      {r && (
        <div className="rejilla cols-4">
          <Kpi etiqueta="Por colar" valor={r.planificadas} sub={r.atrasadas ? `${r.atrasadas} atrasadas` : 'al día'} />
          <Kpi etiqueta="En secado" valor={r.curando} sub={`${n(r.m2_curando, 1)} m² · ${r.listas_para_liberar} pasan hoy a lista para vender`} />
          <Kpi acento etiqueta="m² disponibles" valor={n(r.m2_disponible_primera, 1)} sub={`${n(r.m2_fisico_total, 1)} m² físicos en bodega`} />
          <Kpi etiqueta="Insumos bajo mínimo" valor={r.insumos_bajo_minimo} />
        </div>
      )}
      <Tabs valor={tab} onCambio={setTab} tabs={[['agenda', 'Agenda'], ['ordenes', `Órdenes de producción${r?.atrasadas ? ` (${r.atrasadas})` : ''}`], ['compras', 'Qué comprar'], ['moldes', 'Moldes'], ...(gerencia ? [['params', 'Parámetros']] : [])]} />

      {tab === 'agenda' && (
        <Estado d={agenda}>{(l) => (
          <div className="tarjeta pad0">
            <h2 style={{ padding: '12px 14px 0', margin: 0, fontSize: '1.05rem' }}>Próximos 45 días: producción</h2>
            <div className="tabla-wrap"><table>
              <thead><tr><th>Fecha</th><th>Qué</th><th>Detalle</th><th></th></tr></thead>
              <tbody>
                {l.map((e, i) => (
                  <tr key={i} className={e.atrasado ? 'fila-mal' : ''}>
                    <td>{fechaCorta(e.fecha)}{e.fecha === hoyIso() && <span className="fab-sub" style={{ color: 'var(--info)' }}>hoy</span>}</td>
                    <td><Chip tono={TIPO_AGENDA[e.tipo][1]}>{TIPO_AGENDA[e.tipo][0]}</Chip></td>
                    <td>{e.titulo}<span className="fab-sub">{e.detalle}</span></td>
                    <td>{e.atrasado && <Chip tono="mal">atrasado</Chip>} {e.orden_id && <button className="btn chico" onClick={() => setDetalleId(e.orden_id)}>Abrir</button>}</td>
                  </tr>
                ))}
                {l.length === 0 && <tr><td colSpan={4} className="vacio">Nada programado. Las órdenes se crean solas al aprobar cotizaciones sin existencia, o a mano en la pestaña Órdenes.</td></tr>}
              </tbody>
            </table></div>
          </div>
        )}</Estado>
      )}

      {tab === 'ordenes' && (
        <Estado d={ordenes}>{(l) => (
          <div className="tarjeta pad0">
            <div className="fab-toolbar" style={{ padding: 12, marginBottom: 0 }}>
              <select value={filtro} onChange={(e) => setFiltro(e.target.value)}>
                <option value="planificada,curando">Activas</option><option value="planificada">Por iniciar</option><option value="curando">En secado</option><option value="terminada">Listas para vender</option><option value="cancelada">Canceladas</option>
              </select>
              {produce && <button className="btn primario" onClick={() => setNueva({ producto_id: '', m2_planificado: '', fecha_programada: '', molde_id: '', notas: '' })}>+ Orden de producción</button>}
            </div>
            <div className="tabla-wrap"><table>
              <thead><tr><th>Lote</th><th>Producto</th><th className="der">m²</th><th>Estado</th><th>Programada</th><th>Disponible</th><th>Origen</th><th></th></tr></thead>
              <tbody>
                {l.map((x) => (
                  <tr key={x.id}>
                    <td><b>{x.lote}</b></td><td>{x.producto}</td>
                    <td className="der num">{n(x.estado === 'terminada' ? x.m2_bueno : x.m2_planificado, 2)}</td>
                    <td>
                      {x.estado === 'curando' && termina
                        ? <select value="curando" onChange={(e) => e.target.value === 'terminada' && pasarAListo(x)} style={{ width: 'auto' }}><option value="curando">En secado</option><option value="terminada">Lista para vender</option></select>
                        : <ChipEstado estado={x.estado} />}
                      {x.atrasada && <> <Chip tono="mal">atrasada</Chip></>}
                    </td>
                    <td>{fechaCorta(x.fecha_programada)}</td><td>{fechaCorta(x.fecha_disponible)}</td>
                    <td>{x.cotizacion_numero ? `Cot. #${x.cotizacion_numero}` : 'Stock'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn chico" onClick={() => setDetalleId(x.id)}>Abrir</button>{' '}
                      {x.fecha_colado && <button className="btn chico" onClick={() => ejecutar(() => imprimirEtiqueta(x.lote))}>Etiqueta</button>}{' '}
                      {x.fecha_colado && <button className="btn chico" onClick={() => navegar(`/${empresa}/trazabilidad?lote=${encodeURIComponent(x.lote)}`)}>Trazar</button>}
                    </td>
                  </tr>
                ))}
                {l.length === 0 && <tr><td colSpan={8} className="vacio">Sin órdenes</td></tr>}
              </tbody>
            </table></div>
          </div>
        )}</Estado>
      )}

      {tab === 'compras' && (
        <Estado d={mrp}>{(m) => (
          <div className="tarjeta pad0">
            <p className="fab-sub" style={{ padding: '12px 14px 0' }}><b>Planificación de compras (MRP).</b> {m.ordenes_planificadas} órdenes planificadas. Requerido = consumo teórico de esas órdenes; sugerido = requerido + stock mínimo − existencia.</p>
            <div className="tabla-wrap"><table>
              <thead><tr><th>Insumo</th><th className="der">Existencia</th><th className="der">Requerido</th><th className="der">Mínimo</th><th className="der">Faltante</th><th className="der">Sugerido comprar</th>{gerencia && <th className="der">Costo est.</th>}</tr></thead>
              <tbody>
                {m.insumos.map((i) => (
                  <tr key={i.id}><td><b>{i.nombre}</b><span className="fab-sub">{i.proveedor ?? ''}</span></td>
                    <td className="der num">{n(i.stock, 2)} {i.unidad}</td><td className="der num">{n(i.requerido, 2)}</td><td className="der num">{n(i.minimo, 2)}</td>
                    <td className="der num" style={{ color: i.faltante > 0 ? 'var(--peligro)' : undefined }}>{n(i.faltante, 2)}</td><td className="der num"><b>{n(i.sugerido_comprar, 2)} {i.unidad}</b></td>
                    {gerencia && <td className="der num">{lempiras(i.costo_estimado)}</td>}</tr>
                ))}
                {m.insumos.length === 0 && <tr><td colSpan={7} className="vacio">Todo cubierto por ahora.</td></tr>}
              </tbody>
            </table></div>
          </div>
        )}</Estado>
      )}

      {tab === 'moldes' && (
        <Estado d={moldes}>{(l) => (
          <div className="tarjeta pad0">
            <div className="fab-toolbar" style={{ padding: 12, marginBottom: 0 }}>{produce && <button className="btn primario" onClick={() => setMoldeForm({ codigo: '', nombre: '', producto_id: '', piezas_por_colada: 1, m2_por_colada: '', vida_util_usos: 300 })}>+ Molde</button>}</div>
            <div className="tabla-wrap"><table>
              <thead><tr><th>Molde</th><th>Producto</th><th className="der">m² por colada</th><th className="der">Usos</th><th>Estado</th></tr></thead>
              <tbody>
                {l.map((m) => (
                  <tr key={m.id}><td><b>{m.codigo}</b><span className="fab-sub">{m.nombre}</span></td><td>{m.producto ?? '—'}</td><td className="der num">{n(m.m2_por_colada, 3)}</td>
                    <td className="der num">{m.usos} / {m.vida_util_usos} {m.por_reemplazar && <Chip tono="mal">reemplazar</Chip>}</td>
                    <td>{produce ? <select value={m.estado} style={{ width: 'auto' }} onChange={async (e) => { if (await ejecutar(() => put(`/fab/moldes/${m.id}`, { estado: e.target.value }))) moldes.recargar(); }}><option>activo</option><option>mantenimiento</option><option>baja</option></select> : m.estado}</td></tr>
                ))}
                {l.length === 0 && <tr><td colSpan={5} className="vacio">Registra tus moldes para calcular coladas y controlar su vida útil.</td></tr>}
              </tbody>
            </table></div>
          </div>
        )}</Estado>
      )}

      {tab === 'params' && gerencia && (
        <Estado d={params}>{(l) => (
          <div className="tarjeta pad0">
            <h2 style={{ padding: '12px 14px 0', margin: 0, fontSize: '1.05rem' }}>Parámetros del negocio</h2>
            <div className="tabla-wrap"><table><tbody>
              {l.map((p) => (
                <tr key={p.clave}><td>{p.texto}</td>
                  <td style={{ width: 180 }}><input type="number" step="0.01" defaultValue={p.valor} onBlur={async (e) => { if (Number(e.target.value) !== Number(p.valor) && await ejecutar(() => put(`/fab/parametros/${p.clave}`, { valor: Number(e.target.value) }), 'Parámetro guardado')) params.recargar(); }} /></td></tr>
              ))}
            </tbody></table></div>
          </div>
        )}</Estado>
      )}

      {nueva && <FormOrden f={nueva} productos={productos.datos ?? []} moldes={(moldes.datos ?? []).filter((m) => m.estado === 'activo')} onCerrar={() => setNueva(null)} onListo={(o) => { setNueva(null); avisar(`Orden ${o.lote} creada`); recargar(); }} />}
      {moldeForm && <FormMolde f={moldeForm} productos={productos.datos ?? []} onCerrar={() => setMoldeForm(null)} onListo={() => { setMoldeForm(null); moldes.recargar(); }} />}
      {detalleId && <Detalle id={detalleId} produce={produce} termina={termina} gerencia={gerencia} onCerrar={() => setDetalleId(null)} onCambio={recargar} />}
    </div>
  );
}

function FormOrden({ f: inicial, productos, moldes, onCerrar, onListo }) {
  const [f, setF] = useState(inicial);
  const [ejecutar, ocupado] = useAccion();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const crear = async () => {
    const r = await ejecutar(() => post('/fab/ordenes', { ...f, m2_planificado: Number(f.m2_planificado), fecha_programada: f.fecha_programada || null, molde_id: f.molde_id || null }));
    if (r && r !== true) onListo(r);
  };
  return (
    <Modal titulo="Nueva orden de producción" onCerrar={onCerrar} pie={<button className="btn primario" disabled={ocupado || !f.producto_id || !f.m2_planificado} onClick={crear}>Crear</button>}>
      <Campo etiqueta="Producto"><select value={f.producto_id} onChange={set('producto_id')}><option value="">Elige…</option>{productos.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</select></Campo>
      <div className="rejilla cols-2">
        <Campo etiqueta="m² a producir (buenos)"><input type="number" inputMode="numeric" step="1" min="1" value={f.m2_planificado} onChange={set('m2_planificado')} /></Campo>
        <Campo etiqueta="Fecha programada"><input type="date" value={f.fecha_programada} onChange={set('fecha_programada')} /></Campo>
      </div>
      <Campo etiqueta="Molde" ayuda="Calcula cuántas coladas hacen falta"><select value={f.molde_id} onChange={set('molde_id')}><option value="">—</option>{moldes.map((m) => <option key={m.id} value={m.id}>{m.codigo} · {n(m.m2_por_colada, 2)} m²/colada</option>)}</select></Campo>
      <Campo etiqueta="Notas"><input value={f.notas} onChange={set('notas')} /></Campo>
      <p className="fab-sub">El consumo de insumos se calcula solo con la receta activa del producto (incluye la merma esperada).</p>
    </Modal>
  );
}

function FormMolde({ f: inicial, productos, onCerrar, onListo }) {
  const [f, setF] = useState(inicial);
  const [ejecutar, ocupado] = useAccion();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const guardar = async () => { if (await ejecutar(() => post('/fab/moldes', { ...f, producto_id: f.producto_id || null, piezas_por_colada: Number(f.piezas_por_colada) || 1, m2_por_colada: Number(f.m2_por_colada) || 0, vida_util_usos: Number(f.vida_util_usos) || 300 }), 'Molde creado')) onListo(); };
  return (
    <Modal titulo="Nuevo molde" onCerrar={onCerrar} pie={<button className="btn primario" disabled={ocupado || !f.codigo || !f.nombre} onClick={guardar}>Guardar</button>}>
      <div className="rejilla cols-2">
        <Campo etiqueta="Código"><input value={f.codigo} onChange={set('codigo')} /></Campo>
        <Campo etiqueta="Nombre"><input value={f.nombre} onChange={set('nombre')} /></Campo>
        <Campo etiqueta="Producto"><select value={f.producto_id} onChange={set('producto_id')}><option value="">—</option>{productos.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</select></Campo>
        <Campo etiqueta="Piezas por colada"><input type="number" value={f.piezas_por_colada} onChange={set('piezas_por_colada')} /></Campo>
        <Campo etiqueta="m² por colada"><input type="number" step="0.01" value={f.m2_por_colada} onChange={set('m2_por_colada')} /></Campo>
        <Campo etiqueta="Vida útil (usos)"><input type="number" value={f.vida_util_usos} onChange={set('vida_util_usos')} /></Campo>
      </div>
    </Modal>
  );
}

function Detalle({ id, produce, termina, gerencia, onCerrar, onCambio }) {
  const d = useDatos(() => get(`/fab/ordenes/${id}`), [id]);
  const pruebas = useDatos(() => get('/fab/calidad/pruebas'), []);
  const [reales, setReales] = useState(null);
  const [cierre, setCierre] = useState({ m2_bueno: '', m2_segunda: 0, m2_merma: 0 });
  const [cal, setCal] = useState({ prueba: '', resultado: 'aprobado', valor: '', unidad: '', notas: '' });
  const [ejecutar, ocupado] = useAccion();
  const avisar = useAviso();
  const o = d.datos;
  if (!o) return <Modal titulo="Orden" onCerrar={onCerrar}><Estado d={d}>{() => null}</Estado></Modal>;
  const real = (c) => reales?.[c.insumo_id] ?? c.teorico;
  const refrescar = () => { d.recargar(); onCambio(); };
  const lleno = cierre.m2_bueno === '' ? o.m2_planificado : cierre.m2_bueno;

  return (
    <Modal titulo={`Orden ${o.lote} — ${o.producto}`} tam="ancho" onCerrar={onCerrar}>
      <div className="fab-toolbar">
        <ChipEstado estado={o.estado} />
        <span>{n(o.m2_planificado, 2)} m² planificados</span>
        <span>Programada: {fechaCorta(o.fecha_programada)}</span>
        {o.fecha_disponible && <span>Disponible: {fechaCorta(o.fecha_disponible)}</span>}
        {o.cotizacion_numero && <span>Cot. #{o.cotizacion_numero}</span>}
        {o.coladas && <span>{o.coladas} coladas (molde {o.molde})</span>}
      </div>
      <h3 style={{ margin: '12px 0 6px' }}>Insumos: receta vs. realidad</h3>
      <div className="tabla-wrap"><table>
        <thead><tr><th>Insumo</th><th className="der">Según receta</th><th className="der">En bodega</th><th>{o.estado === 'planificada' ? 'Consumo real' : 'Consumido'}</th></tr></thead>
        <tbody>
          {o.consumos.map((c) => (
            <tr key={c.id}><td>{c.nombre}</td><td className="der num">{n(c.teorico, 3)} {c.unidad}</td>
              <td className="der num" style={{ color: o.estado === 'planificada' && !c.alcanza ? 'var(--peligro)' : undefined }}>{n(c.stock, 2)}{o.estado === 'planificada' && !c.alcanza && ' ⚠'}</td>
              <td>{o.estado === 'planificada' ? <input type="number" step="0.001" value={real(c)} onChange={(e) => setReales({ ...(reales ?? {}), [c.insumo_id]: e.target.value })} style={{ maxWidth: 150 }} /> : c.real != null ? `${n(c.real, 3)} ${c.unidad}` : '—'}</td></tr>
          ))}
          {o.consumos.length === 0 && <tr><td colSpan={4} className="vacio">Esta producción no tiene receta: no descuenta insumos.</td></tr>}
        </tbody>
      </table></div>

      {o.estado === 'planificada' && produce && (
        <div className="fab-toolbar" style={{ marginTop: 10 }}>
          <button className="btn primario" disabled={ocupado} onClick={async () => {
            const r = await ejecutar(() => post(`/fab/ordenes/${o.id}/colar`, { consumos: o.consumos.map((c) => ({ insumo_id: c.insumo_id, real: Number(real(c)) })) }));
            if (r) { avisar(r.desvios?.length ? 'Colada registrada con desvíos: se generó una alerta.' : 'Colada registrada: insumos descontados, empieza el secado.'); refrescar(); }
          }}>Registrar colada (descuenta insumos)</button>
          {gerencia && <button className="btn" onClick={async () => { const motivo = window.prompt('Motivo de la cancelación:'); if (motivo && await ejecutar(() => post(`/fab/ordenes/${o.id}/cancelar`, { motivo }), 'Orden cancelada')) { onCambio(); onCerrar(); } }}>Cancelar orden</button>}
        </div>
      )}

      {o.estado === 'curando' && termina && (
        <div style={{ marginTop: 12 }}>
          <h3 style={{ margin: '0 0 6px' }}>Pasar a lista para vender (entra al inventario)</h3>
          <div className="rejilla cols-3">
            <Campo etiqueta="Buenos (1ª calidad)"><input type="number" step="1" min="0" value={lleno} onChange={(e) => setCierre({ ...cierre, m2_bueno: e.target.value })} /></Campo>
            <Campo etiqueta="De segunda"><input type="number" step="1" min="0" value={cierre.m2_segunda} onChange={(e) => setCierre({ ...cierre, m2_segunda: e.target.value })} /></Campo>
            <Campo etiqueta="Merma"><input type="number" step="1" min="0" value={cierre.m2_merma} onChange={(e) => setCierre({ ...cierre, m2_merma: e.target.value })} /></Campo>
          </div>
          <button className="btn primario" disabled={ocupado || (!Number(lleno) && !Number(cierre.m2_segunda))} onClick={async () => {
            const r = await ejecutar(() => post(`/fab/ordenes/${o.id}/terminar`, { m2_bueno: Number(lleno), m2_segunda: Number(cierre.m2_segunda) || 0, m2_merma: Number(cierre.m2_merma) || 0 }));
            if (r && r !== true) { avisar(`Lista para vender: merma ${r.merma_pct}%${gerencia ? `, costo ${lempiras(r.costo_m2)}/m²` : ''}. ${r.sin_control_calidad ? 'Ojo: sin control de calidad registrado. ' : ''}Ya está en inventario.`); refrescar(); }
          }}>Terminar y pasar a inventario</button>
          {String(o.fecha_disponible).slice(0, 10) > hoyIso() && <span className="fab-sub">Pasa sola a lista para vender el {fechaCorta(o.fecha_disponible)}; si lo haces ahora, se adelanta.</span>}
        </div>
      )}

      {o.estado === 'terminada' && (
        <div className="fab-nota">Bueno {n(o.m2_bueno, 2)} · Segunda {n(o.m2_segunda, 2)} · Merma {n(o.m2_merma, 2)}{gerencia && o.costo_m2 != null && <> · Costo real <b>{lempiras(o.costo_m2)}/m²</b> (insumos {lempiras(o.costo_mp)}, mano de obra {lempiras(o.costo_mano_obra)}, indirectos {lempiras(o.costo_indirectos)})</>}</div>
      )}

      <h3 style={{ margin: '14px 0 6px' }}>Control de calidad (ASTM C1670)</h3>
      <div className="tabla-wrap"><table>
        <thead><tr><th>Prueba</th><th>Resultado</th><th>Valor</th><th>Notas</th><th>Por</th></tr></thead>
        <tbody>
          {o.calidad.map((c) => (<tr key={c.id}><td>{c.prueba}</td><td><Chip tono={c.resultado === 'aprobado' ? 'ok' : c.resultado === 'observado' ? 'aviso' : 'mal'}>{c.resultado}</Chip></td><td>{c.valor != null ? `${n(c.valor, 3)} ${c.unidad ?? ''}` : '—'}</td><td>{c.notas}</td><td>{c.usuario}</td></tr>))}
          {o.calidad.length === 0 && <tr><td colSpan={5} className="vacio">Sin controles todavía</td></tr>}
        </tbody>
      </table></div>
      {produce && o.estado !== 'cancelada' && (
        <div style={{ marginTop: 8 }}>
          <div className="rejilla cols-4">
            <Campo etiqueta="Prueba"><input list="fab-pruebas" value={cal.prueba} onChange={(e) => setCal({ ...cal, prueba: e.target.value })} placeholder="Elige o escribe" /><datalist id="fab-pruebas">{(pruebas.datos ?? []).map((p) => <option key={p} value={p} />)}</datalist></Campo>
            <Campo etiqueta="Resultado"><select value={cal.resultado} onChange={(e) => setCal({ ...cal, resultado: e.target.value })}><option>aprobado</option><option>observado</option><option>rechazado</option></select></Campo>
            <Campo etiqueta="Valor"><input type="number" step="0.001" value={cal.valor} onChange={(e) => setCal({ ...cal, valor: e.target.value })} /></Campo>
            <Campo etiqueta="Unidad"><input value={cal.unidad} onChange={(e) => setCal({ ...cal, unidad: e.target.value })} /></Campo>
          </div>
          <Campo etiqueta="Notas"><input value={cal.notas} onChange={(e) => setCal({ ...cal, notas: e.target.value })} /></Campo>
          <button className="btn" disabled={ocupado || !cal.prueba} onClick={async () => { if (await ejecutar(() => post(`/fab/ordenes/${o.id}/calidad`, { ...cal, valor: cal.valor === '' ? null : Number(cal.valor) }), 'Control registrado')) { setCal({ prueba: '', resultado: 'aprobado', valor: '', unidad: '', notas: '' }); refrescar(); } }}>Registrar control</button>
        </div>
      )}
    </Modal>
  );
}
