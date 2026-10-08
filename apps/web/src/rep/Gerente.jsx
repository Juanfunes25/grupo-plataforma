// Gerente digital de reposición: auditoría, simulador «¿y si…?» y cobertura de personal.
// Calco de PanelGerenteDigital + GerenteAuditoria + GerenteSimulador + GerenteCobertura del original.
import { useEffect, useState } from 'react';
import { api, get, post, put } from '../api.js';
import { Tabs, useAviso } from '../ui/kit.jsx';

export function Gerente() {
  const [sub, setSub] = useState('auditoria');
  const avisar = useAviso();
  const toast = (m) => avisar(m);
  return (
    <div className="gd-stack">
      <Tabs tabs={[['auditoria', 'Auditoría'], ['simulador', 'Simulador'], ['cobertura', 'Cobertura']]} valor={sub} onCambio={setSub} />
      {sub === 'auditoria' && <Auditoria toast={toast} />}
      {sub === 'simulador' && <Simulador />}
      {sub === 'cobertura' && <Cobertura toast={toast} />}
    </div>
  );
}
const delD = (huella) => api(`/rep/gerente/descartes?huella=${encodeURIComponent(huella)}`, { metodo: 'DELETE' });

// ── Auditoría ──
const AREAS = [{ id: 'tiendas', nombre: 'Tiendas' }, { id: 'fabrica', nombre: 'Fábrica' }, { id: 'inventario', nombre: 'Inventario' }, { id: 'personal', nombre: 'Personal' }, { id: 'sistema', nombre: 'Sistema' }];
const NOMBRE_AREA = Object.fromEntries(AREAS.map((a) => [a.id, a.nombre]));
const NIVEL = {
  confirmado: { texto: 'Seguro', clase: 'mal', ayuda: 'Se comprobó con los datos: no depende de una interpretación.' },
  probable: { texto: 'Probable', clase: 'aviso', ayuda: 'Los datos lo apuntan con fuerza, pero hay una explicación inocente que no se puede descartar del todo.' },
  observar: { texto: 'Para observar', clase: '', ayuda: 'Todavía no alcanza para afirmarlo. Se muestra para que lo tengas presente.' },
};
const GRUPOS = [{ id: 'alta', titulo: 'Atender primero', ayuda: 'lo más grave' }, { id: 'media', titulo: 'Revisar esta semana', ayuda: 'importante, sin urgencia' }, { id: 'baja', titulo: 'Menor', ayuda: 'cuando haya tiempo' }];

function Hallazgo({ h, onDescartar, onReabrir, ocupado }) {
  const n = NIVEL[h.nivel] || NIVEL.observar; const descartado = Boolean(h.descarte);
  return (
    <div className={`gd-card ${descartado ? 'neutra' : h.gravedad === 'baja' || h.nivel === 'observar' ? 'baja' : h.gravedad}`}>
      <div className="gd-fila"><span className="chip">{NOMBRE_AREA[h.area] || h.area}</span><span className={`chip ${n.clase}`}>{n.texto}</span>{h.sucursal_nombre && <span className="chip">{h.sucursal_nombre}</span>}</div>
      <h4>{h.titulo}</h4><p>{h.detalle}</p>
      {h.impacto && <p className="gd-nota"><b>Por qué importa:</b> {h.impacto}</p>}
      <div className="gd-accion"><b>Qué hacer:</b> {h.accion}</div>
      <details className="gd-plegable"><summary>Ver cómo lo comprobé</summary>
        <p className="gd-nota"><b>Qué vi</b></p><ul className="gd-lista">{h.evidencia.map((e, i) => <li key={i}>{e}</li>)}</ul>
        <p className="gd-nota"><b>Verificaciones</b></p>
        <ul className="gd-lista" style={{ listStyle: 'none', marginLeft: 0 }}>{h.compuertas.map((c, i) => <li key={i} className={c.ok ? 'gd-pasa' : 'gd-falla'}>{c.ok ? '✓' : '✗'} <span style={{ color: 'var(--texto)' }}>{c.texto}{!c.requerida && !c.ok ? ' (bajó la certeza)' : ''}</span></li>)}</ul>
        {h.descartado?.length > 0 && <><p className="gd-nota"><b>Explicaciones que descarté</b></p><ul className="gd-lista">{h.descartado.map((d, i) => <li key={i}>{d}</li>)}</ul></>}
        <p className="gd-nota">{n.ayuda}</p></details>
      {descartado ? (
        <div><p className="gd-nota">Lo marcaste como «{h.descarte.estado === 'visto' ? 'ya lo vi' : 'no es un problema'}»{h.descarte.nota ? `: ${h.descarte.nota}` : ''}. Vuelve a aparecer el {h.descarte.hasta} si sigue pasando.</p><button className="btn chico fantasma" disabled={ocupado} onClick={() => onReabrir(h)}>Volver a mostrarlo</button></div>
      ) : (
        <div className="gd-botones"><button className="btn chico fantasma" disabled={ocupado} onClick={() => onDescartar(h, 'visto')}>Ya lo vi (7 días)</button><button className="btn chico fantasma" disabled={ocupado} onClick={() => onDescartar(h, 'no_es_problema')}>No es un problema</button></div>
      )}
    </div>
  );
}

function Auditoria({ toast }) {
  const [informe, setInforme] = useState(null); const [error, setError] = useState(''); const [cargando, setCargando] = useState(true); const [ocupado, setOcupado] = useState(false);
  async function cargar() { setCargando(true); try { setInforme(await get('/rep/gerente/auditoria')); setError(''); } catch (e) { setError(e.message); } finally { setCargando(false); } }
  useEffect(() => { cargar(); }, []);
  async function descartar(h, estado) {
    let nota = null;
    if (estado === 'no_es_problema') { nota = window.prompt('¿Por qué no es un problema? (queda anotado, es opcional)', ''); if (nota === null) return; }
    setOcupado(true);
    try { await post('/rep/gerente/descartes', { huella: h.huella, estado, nota }); toast(estado === 'visto' ? 'Anotado: no te lo muestro por 7 días' : 'Anotado: no te lo muestro por 60 días'); await cargar(); } catch (e) { toast(e.message); } finally { setOcupado(false); }
  }
  async function reabrir(h) { setOcupado(true); try { await delD(h.huella); await cargar(); } catch (e) { toast(e.message); } finally { setOcupado(false); } }
  if (cargando && !informe) return <p className="gd-nota">Revisando el negocio…</p>;
  if (error && !informe) return <div className="aviso-caja mal"><p>{error}</p><button className="btn chico" onClick={cargar}>Reintentar</button></div>;
  const r = informe.resumen; const firmes = informe.hallazgos; const graves = firmes.filter((h) => h.gravedad === 'alta').length; const hay = firmes.length > 0;
  const comun = { onDescartar: descartar, onReabrir: reabrir, ocupado };
  return (
    <div className="gd-stack">
      <div className={`gd-hero ${hay ? 'atender' : 'bien'}`}>
        <h3>{hay ? `${firmes.length} ${firmes.length === 1 ? 'cosa para atender' : 'cosas para atender'}${graves ? ` (${graves} ${graves === 1 ? 'grave' : 'graves'})` : ''}` : 'Todo en orden en lo que pude revisar'}</h3>
        <p>Revisé {r.verificaciones} puntos: {r.enOrden} en orden{r.sinDatos + r.conError > 0 ? `, ${r.sinDatos + r.conError} sin datos suficientes para opinar` : ''}. Actualizado a las {new Date(informe.generadoEn).toLocaleTimeString('es-HN', { hour: '2-digit', minute: '2-digit' })}</p>
        <div className="gd-botones"><button className="btn chico" onClick={cargar} disabled={cargando}>{cargando ? 'Revisando…' : 'Volver a revisar'}</button></div>
      </div>
      {informe.errores.length > 0 && <div className="aviso-caja mal"><b>Algo se rompió en mi revisión:</b><ul className="gd-lista">{informe.errores.map((e) => <li key={e.id}>{e.nombre}: {e.mensaje}</li>)}</ul><p className="gd-nota">Eso NO quiere decir que esté todo bien en esas áreas: no pude mirarlas.</p></div>}
      <div className="gd-areas">
        {AREAS.map((a) => { const n = firmes.filter((h) => h.area === a.id).length; const ok = informe.enOrden.filter((x) => x.area === a.id).length; const sd = informe.sinDatos.filter((x) => x.area === a.id).length;
          return <div key={a.id} className={`gd-area ${n ? 'alerta' : ok ? 'bien' : 'sin'}`}><b>{a.nombre}</b><span>{n ? `${n} para atender` : ok ? (sd ? `en orden · ${sd} sin datos` : 'en orden') : 'sin datos aún'}</span></div>; })}
      </div>
      {informe.patrones.length > 0 && <><div className="gd-grupo"><h3>Lo que se repite</h3><small>mismo problema, varias tiendas</small></div>
        {informe.patrones.map((p) => { const tiendas = [...new Set(p.huellas.map((hu) => firmes.find((h) => h.huella === hu)?.sucursal_nombre).filter(Boolean))];
          return <div key={p.id} className="gd-card media"><h4 style={{ marginTop: 0 }}>{p.titulo}</h4>{tiendas.length > 0 && <div className="gd-fila">{tiendas.map((t) => <span key={t} className="chip">{t}</span>)}</div>}<p>{p.detalle}</p></div>; })}</>}
      {GRUPOS.map((g) => { const l = firmes.filter((h) => h.gravedad === g.id); if (!l.length) return null;
        return <div key={g.id} className="gd-stack"><div className="gd-grupo"><h3>{g.titulo}</h3><small>{l.length} · {g.ayuda}</small></div>{l.map((h) => <Hallazgo key={h.huella} h={h} {...comun} />)}</div>; })}
      {!hay && informe.patrones.length === 0 && <div className="aviso-caja ok">No encontré nada firme que atender.{r.sinDatos > 0 && ` Ojo: hay ${r.sinDatos} puntos que no pude revisar por falta de datos; están más abajo.`}</div>}
      {informe.limpieza.length > 0 && (
        <details className="gd-sec-calma"><summary>Por ordenar · {informe.limpieza.reduce((a, l) => a + l.cantidad, 0)} registros viejos sin cerrar (no son problemas)</summary>
          <p className="gd-nota">Pedidos y reportes viejos que quedaron abiertos. Como no todo pedido se envía, es normal que se acumulen.</p>
          {informe.limpieza.map((l) => <div key={l.id} className="gd-card neutra"><h4 style={{ marginTop: 0 }}>{l.titulo}</h4><p>{l.detalle}</p>
            <table className="gd-tabla"><thead><tr><th>Dónde</th><th>Cuántos</th><th>El más viejo</th></tr></thead><tbody>{l.filas.map((f) => <tr key={f.tienda}><td>{f.tienda}</td><td>{f.cantidad}</td><td>hace {f.mas_vieja_dias} días</td></tr>)}</tbody></table>
            <p className="gd-nota"><b>Qué hacer:</b> {l.accion}</p></div>)}</details>
      )}
      {informe.observar.length > 0 && <details className="gd-sec-calma"><summary>Para tener presente, sin alarma ({informe.observar.length})</summary><div className="gd-stack">{informe.observar.map((h) => <Hallazgo key={h.huella} h={h} {...comun} />)}</div></details>}
      {informe.sinDatos.length > 0 && <details className="gd-sec-calma"><summary>No pude revisar ({informe.sinDatos.length})</summary><ul className="gd-lista">{informe.sinDatos.map((s) => <li key={s.id}><b>{s.nombre}:</b> {s.motivo}</li>)}</ul><p className="gd-nota">No es que esté bien ni mal: todavía no hay datos suficientes para opinar.</p></details>}
      {informe.enOrden.length > 0 && <details className="gd-sec-calma"><summary>Revisé y está en orden ({informe.enOrden.length})</summary><ul className="gd-lista">{informe.enOrden.map((s) => <li key={s.id}><b>{s.nombre}</b>{s.revisado ? ` — ${s.revisado}` : ''}</li>)}</ul></details>}
      {informe.descartados.length > 0 && <details className="gd-sec-calma"><summary>Los que descartaste ({informe.descartados.length})</summary><div className="gd-stack">{informe.descartados.map((h) => <Hallazgo key={h.huella} h={h} {...comun} />)}</div></details>}
      <p className="gd-nota">Lo que no puedo saber: si lo registrado coincide con lo que pasó en la realidad (por ejemplo, si un pesaje se hizo bien en la balanza), ni si una jornada larga cumple los límites de la ley. Esos puntos los juzgas tú.</p>
    </div>
  );
}

// ── Simulador ──
const CORTOS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const NOMBRES = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const PREGUNTAS = [['dias', 'Cambiar los días de reparto'], ['demanda', 'Si vende más o menos (o cierra)'], ['nueva', 'Abrir una tienda más']];
const nombreDias = (d) => d.map((x) => NOMBRES[x]).join(', ');
const num = (n, dec = 1) => (n == null ? '—' : Number(n).toLocaleString('es-HN', { maximumFractionDigits: dec }));
const lps = (n) => `L ${Number(n || 0).toLocaleString('es-HN', { maximumFractionDigits: 0 })}`;

function Fila({ nombre, antes, despues, mejorSiBaja, formato = (x) => num(x), sufijo = '' }) {
  const cambio = despues !== antes && antes != null && despues != null; const baja = despues < antes;
  const clase = !cambio || mejorSiBaja === undefined ? '' : (baja === mejorSiBaja ? 'mejor' : 'peor');
  return <><span>{nombre}</span><span>{formato(antes)}{sufijo}</span><span className={clase}>{formato(despues)}{sufijo}</span></>;
}
function Resultado({ r }) {
  const { antes, despues } = r.totales; const costo = (t) => (t.kg_sin_costo >= t.kg_semana * 0.99 && t.kg_semana > 0 ? null : t.costo_semana); const cambiaron = r.tiendas.filter((t) => t.cambia);
  return (
    <div className="gd-stack">
      <div className="gd-fila"><span className={`chip ${r.confianza === 'razonable' ? 'ok' : 'aviso'}`}>{r.confianza === 'razonable' ? 'Estimación razonable' : 'Solo orientativo'}</span></div>
      {r.lecturas.filter((l) => l.tema !== 'viaje_tienda').length === 0 ? <div className="aviso-caja">Con ese cambio no varía nada de lo que mido.</div> : <div className="gd-card ok"><h4>Lo que cambia</h4><ul className="gd-lista">{r.lecturas.map((l, i) => <li key={i}>{l.texto}</li>)}</ul></div>}
      {r.explicaciones.map((e, i) => <p key={i} className="gd-nota">{e}</p>)}
      <div className="gd-titulo">Todo el negocio, por semana</div>
      <div className="gd-comparacion"><span className="enc" /><span className="enc">Hoy</span><span className="enc">Con el cambio</span>
        <Fila nombre="Producción" antes={antes.kg_semana} despues={despues.kg_semana} sufijo=" kg" />
        <Fila nombre="Costo de producir" antes={costo(antes)} despues={costo(despues)} formato={(x) => (x === null ? 'sin dato' : lps(x))} mejorSiBaja />
        <Fila nombre="Viajes de reparto" antes={antes.viajes_semana} despues={despues.viajes_semana} mejorSiBaja />
        <Fila nombre="Días con camión" antes={antes.dias_de_camion} despues={despues.dias_de_camion} mejorSiBaja />
        <Fila nombre="Días en vitrina" antes={antes.edad_dias} despues={despues.edad_dias} formato={(x) => num(x, 2)} mejorSiBaja />
        <Fila nombre="Helado en vitrinas" antes={antes.inventario_vitrina_kg} despues={despues.inventario_vitrina_kg} sufijo=" kg" />
        <Fila nombre="Día de más carga" antes={antes.kg_dia_mayor} despues={despues.kg_dia_mayor} sufijo=" kg" mejorSiBaja /></div>
      <p className="gd-nota">«Días en vitrina»: cuánto tiempo pasa en promedio un kilo de helado en la tienda antes de venderse. Menos es más fresco.</p>
      {cambiaron.length > 0 && <><div className="gd-titulo">Por tienda</div>{cambiaron.map((t) => (
        <details key={t.sucursal_id} className="gd-card neutra" open={cambiaron.length === 1}><summary style={{ fontWeight: 600, cursor: 'pointer' }}>{t.nombre}{t.nueva ? ' (hipotética)' : ''}</summary>
          {!t.despues.abierta ? <p>Cerrada: deja de producirse para esta tienda {num(t.antes.kg_semana)} kg por semana.</p> : <>
            <p className="gd-nota">Reparto: {t.dias_antes.length ? `${nombreDias(t.dias_antes)} → ` : ''}<b>{nombreDias(t.dias_despues)}</b></p>
            <div className="gd-comparacion"><span className="enc" /><span className="enc">Hoy</span><span className="enc">Con el cambio</span>
              {!t.nueva ? <Fila nombre="Kg por viaje" antes={t.antes.kg_por_viaje} despues={t.despues.kg_por_viaje} /> : <><span>Kg por viaje</span><span>—</span><span>{num(t.despues.kg_por_viaje)}</span></>}
              {!t.nueva ? <Fila nombre="Kg por semana" antes={t.antes.kg_semana} despues={t.despues.kg_semana} /> : <><span>Kg por semana</span><span>—</span><span>{num(t.despues.kg_semana)}</span></>}
              {!t.nueva ? <Fila nombre="Días en vitrina" antes={t.antes.edad_dias} despues={t.despues.edad_dias} formato={(x) => num(x, 2)} mejorSiBaja /> : <><span>Días en vitrina</span><span>—</span><span>{num(t.despues.edad_dias, 2)}</span></>}
              <span>Riesgo de agotarse</span><span>{t.antes.riesgo_agotarse_pct ?? '—'}{t.nueva ? '' : '%'}</span><span>{t.despues.riesgo_agotarse_pct ?? '—'}%</span></div></>}
          {t.precision && <p className="gd-nota">Qué tan bien le acierta el modelo a esta tienda: error medio {t.precision.errorMedioPct}%; {t.precision.dentroDe20Pct}% de las veces dentro del 20%.</p>}
          {t.calibracion && <p className="gd-nota">Verificación: con el reparto de hoy el modelo da {t.calibracion.modelo_kg} kg/semana y en las últimas 4 semanas se enviaron {t.calibracion.real_kg} kg ({t.calibracion.desvio_pct > 0 ? '+' : ''}{t.calibracion.desvio_pct}%).</p>}
        </details>))}</>}
      {r.avisos.length > 0 && <div className="aviso-caja"><b>Tómalo con cuidado:</b><ul className="gd-lista">{r.avisos.map((a, i) => <li key={i}>{a}</li>)}</ul></div>}
      {r.supuestos.length > 0 && <details className="gd-plegable"><summary>Lo que supuse</summary><ul className="gd-lista">{r.supuestos.map((s, i) => <li key={i}>{s}</li>)}</ul></details>}
      <details className="gd-plegable"><summary>Cómo calculé esto</summary><p className="gd-nota">{r.metodo}</p></details>
    </div>
  );
}

function Simulador() {
  const [base, setBase] = useState(null); const [error, setError] = useState(''); const [pregunta, setPregunta] = useState('dias');
  const [tienda, setTienda] = useState(''); const [modoDias, setModoDias] = useState('cantidad'); const [cantidad, setCantidad] = useState(3); const [dias, setDias] = useState([]);
  const [porcentaje, setPorcentaje] = useState(-20); const [como, setComo] = useState(''); const [ventasNueva, setVentasNueva] = useState(100);
  const [resultado, setResultado] = useState(null); const [calculando, setCalculando] = useState(false); const [errorSim, setErrorSim] = useState('');
  useEffect(() => { get('/rep/gerente/simulador/base').then((b) => { setBase(b); if (b.tiendas[0]) { setTienda(b.tiendas[0].sucursal_id); setComo(b.tiendas[0].sucursal_id); setDias(b.tiendas[0].dias_reparto); } }).catch((e) => setError(e.message)); }, []);
  function elegir(id) { setTienda(id); setResultado(null); const t = base.tiendas.find((x) => x.sucursal_id === id); if (t) setDias(t.dias_reparto); }
  async function simular() {
    setCalculando(true); setErrorSim('');
    try {
      const cambios = pregunta === 'dias' ? [modoDias === 'cantidad' ? { tipo: 'dias_reparto', sucursal_id: tienda, cantidad } : { tipo: 'dias_reparto', sucursal_id: tienda, dias }]
        : pregunta === 'demanda' ? [{ tipo: 'demanda', sucursal_id: tienda || 'todas', porcentaje: Number(porcentaje) }] : [{ tipo: 'tienda_nueva', como, porcentaje: Number(ventasNueva) }];
      setResultado(await post('/rep/gerente/simulacion', { cambios }));
    } catch (e) { setErrorSim(e.message); setResultado(null); } finally { setCalculando(false); }
  }
  if (error) return <div className="aviso-caja mal">{error}</div>;
  if (!base) return <p className="gd-nota">Cargando…</p>;
  if (!base.tiendas.length) return <div className="aviso-caja">Todavía no hay suficientes despachos registrados para armar el simulador.</div>;
  const hoy = base.tiendas.find((t) => t.sucursal_id === tienda);
  return (
    <div className="gd-stack">
      <p className="gd-nota">Pregúntale «¿y si…?» al negocio. Es una simulación: no cambia nada real.</p>
      <div className="gd-titulo">Así estás hoy</div>
      {base.tiendas.map((t) => (
        <div key={t.sucursal_id} className="gd-card neutra"><b>{t.nombre}</b><p className="gd-nota">Reparto {nombreDias(t.dias_reparto)} · {t.viajes_semana} viajes · {num(t.kg_semana)} kg/semana · {num(t.edad_dias, 2)} días en vitrina</p>
          {t.calibracion && Math.abs(t.calibracion.desvio_pct) > 25 && <p className="gd-nota" style={{ color: 'var(--aviso)' }}>El modelo da {t.calibracion.modelo_kg} kg/semana y se enviaron {t.calibracion.real_kg}: aquí es menos fiable.</p>}</div>
      ))}
      {base.excluidas.length > 0 && <p className="gd-nota">No incluidas: {base.excluidas.map((e) => `${e.nombre}${e.motivo ? ` (${e.motivo})` : ''}`).join('; ')}.</p>}
      <div className="gd-titulo">¿Qué quieres preguntar?</div>
      <Tabs tabs={PREGUNTAS} valor={pregunta} onCambio={(p) => { setPregunta(p); setResultado(null); }} />
      <div className="gd-formulario">
        {pregunta === 'dias' && <>
          <label>Tienda<select value={tienda} onChange={(e) => elegir(e.target.value)}>{base.tiendas.map((t) => <option key={t.sucursal_id} value={t.sucursal_id}>{t.nombre}</option>)}</select></label>
          <div className="gd-botones"><button className={`btn chico ${modoDias === 'cantidad' ? 'primario' : ''}`} onClick={() => setModoDias('cantidad')}>Elige los mejores</button><button className={`btn chico ${modoDias === 'dias' ? 'primario' : ''}`} onClick={() => setModoDias('dias')}>Elijo yo los días</button></div>
          {modoDias === 'cantidad' ? <label>¿Cuántos días a la semana?{hoy ? ` (hoy: ${hoy.viajes_semana})` : ''}<select value={cantidad} onChange={(e) => setCantidad(Number(e.target.value))}>{[1, 2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>{n} {n === 1 ? 'día' : 'días'}</option>)}</select></label>
            : <div><label>Días de reparto</label><div className="gd-dias">{CORTOS.map((c, i) => <button key={i} className={dias.includes(i) ? 'active' : ''} onClick={() => setDias((d) => (d.includes(i) ? d.filter((x) => x !== i) : [...d, i].sort()))}>{c}</button>)}</div></div>}
        </>}
        {pregunta === 'demanda' && <>
          <label>Tienda<select value={tienda} onChange={(e) => { setTienda(e.target.value); setResultado(null); }}><option value="todas">Todas</option>{base.tiendas.map((t) => <option key={t.sucursal_id} value={t.sucursal_id}>{t.nombre}</option>)}</select></label>
          <label>Cambio en lo que vende (%)<input type="number" inputMode="numeric" value={porcentaje} min={-100} max={300} onChange={(e) => setPorcentaje(e.target.value)} /></label>
          <div className="gd-botones">{[-100, -30, -10, 10, 20, 50].map((p) => <button key={p} className="btn chico" onClick={() => setPorcentaje(p)}>{p === -100 ? 'Cierra' : `${p > 0 ? '+' : ''}${p}%`}</button>)}</div>
        </>}
        {pregunta === 'nueva' && <>
          <label>Vendería parecido a…<select value={como} onChange={(e) => setComo(e.target.value)}>{base.tiendas.map((t) => <option key={t.sucursal_id} value={t.sucursal_id}>{t.nombre}</option>)}</select></label>
          <label>…pero al (% de lo que vende esa tienda)<input type="number" inputMode="numeric" value={ventasNueva} min={10} max={300} onChange={(e) => setVentasNueva(e.target.value)} /></label>
          <p className="gd-nota">Es una suposición: una tienda nueva no tiene historia propia, así que se parece a la que elijas.</p>
        </>}
        <button className="btn primario grande bloque" onClick={simular} disabled={calculando || (pregunta === 'dias' && modoDias === 'dias' && !dias.length)}>{calculando ? 'Calculando…' : 'Ver qué pasaría'}</button>
        {errorSim && <p className="gd-falla">{errorSim}</p>}
      </div>
      {resultado && <Resultado r={resultado} />}
    </div>
  );
}

// ── Cobertura ──
const ETQ = { alta: 'Va a faltar gente', media: 'Riesgo alto', baja: 'Riesgo bajo' };
const fechaDM = (iso) => { const [, m, d] = iso.split('-'); return `${Number(d)}/${Number(m)}`; };
function Alerta({ a }) {
  return (
    <div className={`gd-card ${a.nivel}`}>
      <div className="gd-fila"><span className={`chip ${a.corto_en_papel ? 'mal' : a.nivel === 'media' ? 'aviso' : ''}`}>{a.corto_en_papel ? 'Corto en el horario' : ETQ[a.nivel]}</span><span className="chip">{a.tienda}</span></div>
      <h4>{a.nombre_dia} {fechaDM(a.fecha)}: {a.corto_en_papel ? `${a.programados.length} programad${a.programados.length === 1 ? 'a' : 'as'} y hacen falta ${a.requeridos}` : `alcanza en el papel, pero ${a.prob_corto_pct}% de probabilidad de quedar corto`}</h4>
      <p className="gd-nota">Programados: {a.programados.length ? a.programados.join(', ') : 'nadie'} · Hacen falta {a.requeridos}{a.fuente_minimo === 'habitual' ? ' (lo habitual de ese día)' : a.fuente_minimo === 'definido' ? ' (lo definiste tú)' : ' (según el horario)'}</p>
      {a.causas.length > 0 && <ul className="gd-lista">{a.causas.map((c, i) => <li key={i}>{c}</li>)}</ul>}
      {!a.corto_en_papel && <p className="gd-nota">Esperados presentes: {a.esperados_presentes} de {a.programados.length}.</p>}
      {a.sugerencias.length > 0 && <div className="gd-accion"><b>Qué se podría hacer (para consultar, no para ordenar):</b><ul className="gd-lista">{a.sugerencias.map((s, i) => <li key={i}>{s.texto}{s.riesgo_en_origen_pct != null ? ` Riesgo para esa tienda: ${s.riesgo_en_origen_pct}%.` : ''}</li>)}</ul></div>}
    </div>
  );
}
function Calendario({ tienda }) {
  const p = tienda.dias[0]; if (!p) return <p className="gd-nota">Sin días con actividad prevista.</p>;
  return (
    <div className="gd-semana">
      {CORTOS.map((c) => <div key={c} className="gd-nota centro">{c}</div>)}
      {Array.from({ length: p.dia_semana }, (_, i) => <div key={`h${i}`} />)}
      {tienda.dias.map((d) => <div key={d.fecha} className={`gd-celda ${d.nivel === 'ok' ? 'baja' : d.nivel}`} title={`${d.programados.length}/${d.requeridos}`}>{Number(d.fecha.slice(8))}<b>{d.programados.length}/{d.requeridos}</b></div>)}
    </div>
  );
}
function Cobertura({ toast }) {
  const [dias, setDias] = useState(14); const [datos, setDatos] = useState(null); const [error, setError] = useState(''); const [cargando, setCargando] = useState(true);
  async function cargar(d = dias) { setCargando(true); try { setDatos(await get(`/rep/gerente/cobertura?dias=${d}`)); setError(''); } catch (e) { setError(e.message); } finally { setCargando(false); } }
  useEffect(() => { cargar(dias); }, [dias]); // eslint-disable-line react-hooks/exhaustive-deps
  async function minimo(sucursal_id, dia_semana, m) { try { await put('/rep/gerente/cobertura/minimo', { sucursal_id, dia_semana, minimo: m }); toast(m === null ? 'Vuelvo a usar lo habitual' : 'Mínimo guardado'); await cargar(); } catch (e) { toast(e.message); } }
  if (cargando && !datos) return <p className="gd-nota">Calculando…</p>;
  if (error && !datos) return <div className="aviso-caja mal"><p>{error}</p><button className="btn chico" onClick={() => cargar()}>Reintentar</button></div>;
  const r = datos.resumen; const principales = datos.alertas.filter((a) => a.nivel !== 'baja'); const leves = datos.alertas.filter((a) => a.nivel === 'baja');
  const faltadores = datos.historia.personas.filter((p) => !p.excluida && p.turnos >= 15 && p.faltas >= 3).sort((a, b) => b.faltas / b.turnos - a.faltas / a.turnos);
  return (
    <div className="gd-stack">
      <Tabs tabs={[[7, 'Próximos 7 días'], [14, 'Próximos 14 días'], [30, 'Próximos 30 días']]} valor={dias} onCambio={setDias} />
      <div className="gd-resumen"><div className={`gd-dato ${r.en_papel ? 'alerta' : 'bien'}`}><b>{r.en_papel}</b><span>días cortos según el horario</span></div><div className={`gd-dato ${principales.length - r.en_papel ? 'alerta' : 'bien'}`}><b>{principales.length - r.en_papel}</b><span>días con riesgo alto por faltas</span></div></div>
      {principales.length === 0 ? <div className="aviso-caja ok">{leves.length > 0 ? 'Sin faltas de gente a la vista. ' : ''}Del {fechaDM(datos.desde)} al {fechaDM(datos.hasta)} las {r.tiendas_revisadas} tiendas tienen la gente que necesitan, y el riesgo por faltas es bajo.</div> : principales.map((a) => <Alerta key={`${a.sucursal_id}${a.fecha}`} a={a} />)}
      {leves.length > 0 && <details className="gd-plegable"><summary>Riesgo bajo ({leves.length} días)</summary><div className="gd-stack">{leves.map((a) => <Alerta key={`${a.sucursal_id}${a.fecha}`} a={a} />)}</div></details>}
      <div className="gd-titulo">Calendario por tienda</div>
      {datos.tiendas.map((t) => (
        <details key={t.sucursal_id} className="gd-plegable"><summary>{t.nombre} · {t.personas} personas · falta el {t.tasa_falta_pct}% de los turnos</summary>
          <Calendario tienda={t} /><p className="gd-nota">En cada día: programados / necesarios.</p>
          <p className="gd-nota">Cuánta gente hace falta cada día. Si lo dejas vacío uso lo habitual de esa tienda ese día.</p>
          <div className="gd-minimos">{t.minimo_por_dia.map((m) => <div key={`n${m.dia_semana}`}>{CORTOS[m.dia_semana]}</div>)}
            {t.minimo_por_dia.map((m) => <input key={m.dia_semana} type="number" inputMode="numeric" min={0} max={20} defaultValue={m.fuente === 'definido' ? m.valor : ''} placeholder={String(m.valor)} aria-label={`Mínimo del ${m.nombre_dia} en ${t.nombre}`}
              onBlur={(e) => { const v = e.target.value.trim(); const actual = m.fuente === 'definido' ? String(m.valor) : ''; if (v !== actual) minimo(t.sucursal_id, m.dia_semana, v === '' ? null : Number(v)); }} />)}</div>
        </details>
      ))}
      {datos.avisos.length > 0 && <div className="aviso-caja"><b>Lo que no pude verificar bien:</b><ul className="gd-lista">{datos.avisos.map((a, i) => <li key={i}>{a}</li>)}</ul></div>}
      <details className="gd-plegable"><summary>Cómo calculé esto</summary><p className="gd-nota">{datos.metodo}</p><p className="gd-nota">Base: {datos.historia.turnos_evaluados} turnos de los últimos {datos.historia.dias} días, {datos.historia.faltas} sin entrada ({datos.historia.tasa_global_pct}%).</p>
        {faltadores.length > 0 && <><p className="gd-nota"><b>Quién tiene más turnos sin entrada</b> (al menos 15 turnos y 3 faltas):</p><ul className="gd-lista">{faltadores.map((p) => <li key={p.id}>{p.nombre}: {p.faltas} de {p.turnos} turnos</li>)}</ul><p className="gd-nota">«Sin entrada» no es lo mismo que «faltó»: puede haber olvidado marcar o tener permiso. Es un dato para conversar, no una conclusión.</p></>}</details>
    </div>
  );
}
