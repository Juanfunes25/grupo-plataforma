// Despacho y recepción: qué enviar a cada sucursal, tandas, pedidos de insumos y estados.
// Calco de Despacho.jsx + DetalleTienda.jsx del original, en el kit oscuro y táctil.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { nocheDeTrabajo } from '@grupo/shared';
import { api, get, patch } from '../api.js';
import { useAviso } from '../ui/kit.jsx';
import { BotonesPanas, Esqueleto, LotePanasConExcepciones, Pill, useAvisoDeshacer } from './comun.jsx';
import { ESTADOS_HECHOS, ESTADOS_RESUELTOS, ORDEN_ESTADO, cuandoTexto, diaAnterior, fechaCorta, guardarCache, haceCuanto, hoyIso, leerCache, textoUltimaProduccion, vibrar } from './lib.js';

const PROTECCION_MS = 6000;   // un cambio recién tocado no lo pisa el refresco automático
const saludo = () => { const h = new Date().getHours(); return h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches'; };
// Las tiendas pesan de noche y aquí se despacha a la mañana siguiente: antes del mediodía el reporte que importa es el de ANOCHE.
const nocheInicial = () => nocheDeTrabajo().fecha;
const textoDia = (f) => (f === hoyIso() ? `${fechaCorta(f)} · hoy` : f === diaAnterior(hoyIso()) ? `${fechaCorta(f)} · anoche` : fechaCorta(f));

function mezclar(actual, nuevo, ids) {
  if (!ids.size) return nuevo;
  const porId = new Map(); for (const l of Object.values(actual)) for (const d of l) porId.set(d.id, d);
  const out = {}; for (const [s, l] of Object.entries(nuevo)) out[s] = l.map((d) => (ids.has(d.id) ? porId.get(d.id) || d : d));
  return out;
}
function mezclarProd(actual, nuevo, ids) {
  if (!ids.size) return nuevo;
  const porId = new Map(); for (const i of Object.values(actual)) for (const d of i.destinos) porId.set(d.despachoId, d);
  const out = {}; for (const [s, i] of Object.entries(nuevo)) out[s] = { ...i, destinos: i.destinos.map((d) => (ids.has(d.despachoId) ? porId.get(d.despachoId) || d : d)) };
  return out;
}

export default function Despacho() {
  const avisar = useAviso();
  const { mostrar, vista: avisoVista } = useAvisoDeshacer();
  const [pantalla, setPantalla] = useState(null);   // null = tiendas · 'produccion' · 'juntar' · id de tienda
  const [porSucursal, setPorSucursal] = useState({});
  const [produccion, setProduccion] = useState({});
  const [ultimaProd, setUltimaProd] = useState({});
  const [pedidos, setPedidos] = useState([]);
  const [reportado, setReportado] = useState({});
  const [sucTotales, setSucTotales] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [actualizando, setActualizando] = useState(false);
  const [datoDesde, setDatoDesde] = useState(null);
  const [error, setError] = useState('');
  const [fecha, setFecha] = useState(nocheInicial);
  const yaCargo = useRef(false);
  const cambios = useRef(new Map());

  const protegidos = () => { const ahora = Date.now(); const s = new Set(); for (const [id, ts] of cambios.current) { if (ahora - ts < PROTECCION_MS) s.add(id); else cambios.current.delete(id); } return s; };
  const aplicar = useCallback((d) => {
    const p = protegidos();
    setPorSucursal((a) => mezclar(a, d.porSucursal || {}, p)); setProduccion((a) => mezclarProd(a, d.porSabor || {}, p));
    setUltimaProd(d.ultimaProduccion || {}); setPedidos(d.pedidos || []); setReportado(d.reportadoPorSucursal || {}); yaCargo.current = true;
  }, []);

  useEffect(() => { get('/rep/sucursales').then((l) => setSucTotales(l.filter((s) => !s.fuera_de_analisis))).catch(() => {}); }, []);
  useEffect(() => { const c = leerCache('panel'); if (c?.datos?.fecha === fecha) { aplicar(c.datos); setDatoDesde(c.ts); setCargando(false); } }, [fecha, aplicar]);
  const recargar = useCallback(async () => {
    setActualizando(true); setError('');
    try { const d = await get(`/rep/analitica/panel-despacho/${fecha}`); aplicar(d); guardarCache('panel', d); setDatoDesde(Date.now()); }
    catch (e) { if (!yaCargo.current) setError(e.message); else avisar(`No se pudo actualizar: ${e.message}`, 'mal'); }
    finally { setCargando(false); setActualizando(false); }
  }, [fecha, aplicar, avisar]);
  useEffect(() => { yaCargo.current = false; recargar(); }, [recargar]);
  // Las tiendas reportan durante la noche y el despachador trabaja con la app abierta.
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') recargar(); }, 60000);
    const v = () => { if (document.visibilityState === 'visible') recargar(); };
    document.addEventListener('visibilitychange', v);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', v); };
  }, [recargar]);

  function cambioLocal(ids, c) {
    const ahora = Date.now(); for (const id of ids) cambios.current.set(id, ahora);
    const set = new Set(ids); const aS = porSucursal; const aP = produccion;
    const nS = {}; for (const [s, l] of Object.entries(porSucursal)) nS[s] = l.map((d) => (set.has(d.id) ? { ...d, ...c } : d));
    const nP = {}; for (const [s, i] of Object.entries(produccion)) nP[s] = { ...i, destinos: i.destinos.map((d) => (set.has(d.despachoId) ? { ...d, ...c } : d)) };
    setPorSucursal(nS); setProduccion(nP);
    return () => { setPorSucursal(aS); setProduccion(aP); };
  }
  const porId = useMemo(() => { const m = new Map(); for (const l of Object.values(porSucursal)) for (const d of l) m.set(d.id, d); return m; }, [porSucursal]);
  const restaurar = (anteriores) => Promise.all(anteriores.map((d) => patch(`/rep/despachos/${d.id}/restaurar`, { estado: d.estado, panas: d.panas, gramos_enviados: d.gramos_enviados })));

  async function marcarPanas(id, panas) {
    const antes = porId.get(id); const gp = antes && antes.panas > 0 ? antes.gramos_enviados / antes.panas : (antes?.gramos_pana ?? null);
    const deshacer = cambioLocal([id], { estado: 'enviado', panas, ...(gp ? { gramos_enviados: panas * gp } : {}) });
    try {
      await patch(`/rep/despachos/${id}/panas-enviadas`, { panas });
      if (antes) mostrar(`Enviado ×${panas}`, { onDeshacer: async () => { deshacer(); try { await restaurar([antes]); } catch (e) { mostrar(`No se pudo deshacer del todo: ${e.message}`, { tipo: 'mal' }); } } });
    } catch (e) { deshacer(); mostrar(`No se pudo registrar el envío: ${e.message}`, { tipo: 'mal' }); }
  }
  async function noHay(id) {
    const antes = porId.get(id); vibrar(15);
    const deshacer = cambioLocal([id], { estado: 'no_disponible', panas: 0, gramos_enviados: 0 });
    try {
      await patch(`/rep/despachos/${id}/no-disponible`);
      if (antes) mostrar(`${antes.sabor_nombre}: marcado sin stock`, { onDeshacer: async () => { deshacer(); try { await restaurar([antes]); } catch (e) { mostrar(`No se pudo deshacer del todo: ${e.message}`, { tipo: 'mal' }); } } });
    } catch (e) { deshacer(); mostrar(`No se pudo marcar: ${e.message}`, { tipo: 'mal' }); }
  }
  async function lotePanas(ids, panas) {
    if (!ids.length) return;
    vibrar(18);
    const antes = ids.map((i) => porId.get(i)).filter(Boolean);
    const deshacer = cambioLocal(ids, { estado: 'enviado', panas });
    try {
      await patch('/rep/despachos/lote/panas-enviadas', { ids, panas });
      mostrar(`${ids.length} enviados ×${panas}`, { onDeshacer: async () => { deshacer(); try { await restaurar(antes); } catch (e) { mostrar(`No se pudo deshacer del todo: ${e.message}`, { tipo: 'mal' }); } } });
    } catch (e) { deshacer(); mostrar(`No se pudo registrar el envío: ${e.message}`, { tipo: 'mal' }); }
  }
  async function alternarItem(itemId, actual) {
    vibrar();
    const ap = (v) => setPedidos((l) => l.map((p) => ({ ...p, items: p.items.map((i) => (i.id === itemId ? { ...i, preparado: v } : i)) })));
    ap(actual ? 0 : 1);
    try { await patch(`/rep/pedidos/items/${itemId}/preparado`, { preparado: !actual }); }
    catch (e) { ap(actual ? 1 : 0); mostrar(`No se pudo marcar: ${e.message}`, { tipo: 'mal' }); }
  }
  // Manda SOLO los insumos tildados y cierra el pedido: casi nunca hay de todo, lo que no se marcó no queda pendiente.
  async function despacharInsumos(pedido, marcados) {
    if (!marcados.length) return;
    vibrar(20);
    const antes = pedidos; const set = new Set(marcados);
    const sinEnviar = pedido.items.filter((i) => !i.enviado && !set.has(i.id)).length;
    const previo = pedido.estado; const prev = pedido.items.filter((i) => i.preparado).map((i) => i.id);
    setPedidos((l) => l.map((p) => (p.id === pedido.id ? { ...p, estado: 'recibido', items: p.items.map((i) => (set.has(i.id) ? { ...i, enviado: 1, preparado: 1 } : i)) } : p)));
    try {
      await patch(`/rep/pedidos/${pedido.id}/despachar-marcados`, { items_enviados: marcados });
      mostrar(sinEnviar === 0 ? `${pedido.sucursal_nombre}: insumos enviados` : `${pedido.sucursal_nombre}: ${marcados.length} enviados, ${sinEnviar} no había: pedido cerrado`,
        { onDeshacer: async () => { setPedidos(antes); try { await patch(`/rep/pedidos/${pedido.id}/reabrir`, { estado: previo, items_preparados: prev }); } catch (e) { mostrar(`No se pudo deshacer del todo: ${e.message}`, { tipo: 'mal' }); } } });
    } catch (e) { setPedidos(antes); mostrar(`No se pudieron enviar: ${e.message}`, { tipo: 'mal' }); }
  }

  // ── Derivados ──
  const idsSuc = Object.keys(porSucursal);
  const pedidosPorTienda = useMemo(() => { const m = new Map(); for (const p of pedidos) { if (p.estado === 'recibido') continue; if (!m.has(p.sucursal_id)) m.set(p.sucursal_id, []); m.get(p.sucursal_id).push(p); } return m; }, [pedidos]);
  const idsActividad = useMemo(() => { const s = new Set(idsSuc); for (const p of pedidos) if (p.estado !== 'recibido') s.add(p.sucursal_id); return [...s]; }, [idsSuc.join('|'), pedidos]); // eslint-disable-line react-hooks/exhaustive-deps
  const peor = (lista) => lista.reduce((p, x) => (ORDEN_ESTADO[x] < ORDEN_ESTADO[p] ? x : p), 'recibido');
  const tiendas = useMemo(() => idsActividad.map((sid) => {
    const items = porSucursal[sid] || []; const insumos = pedidosPorTienda.get(sid) || [];
    const eg = peor([peor(items.map((d) => d.estado)), peor(insumos.map((p) => p.estado))]);
    const pend = items.filter((d) => !ESTADOS_RESUELTOS.includes(d.estado));
    const rojas = pend.filter((d) => d.categoria === 'roja').reduce((a, d) => a + d.panas, 0);
    const insPend = insumos.reduce((a, p) => a + p.items.filter((i) => !i.enviado).length, 0);
    const reportadoEn = [reportado[sid], ...insumos.map((p) => p.creado_en)].filter(Boolean).sort().pop() || null;
    return { id: sid, nombre: items[0]?.sucursal_nombre || insumos[0]?.sucursal_nombre || sid, items, insumos, reportadoEn, estadoGeneral: eg, saboresPendientes: pend.length, insumosPendientes: insPend, panasPorArmar: pend.reduce((a, d) => a + d.panas, 0), panasRojas: rojas, listo: pend.length === 0 && insPend === 0 };
  }).sort((a, b) => Number(a.listo) - Number(b.listo) || b.panasRojas - a.panasRojas || b.panasPorArmar - a.panasPorArmar), [idsActividad, porSucursal, pedidosPorTienda, reportado]);
  const sinReportar = useMemo(() => { const a = new Set(idsActividad); return sucTotales.filter((s) => !a.has(s.id)); }, [sucTotales, idsActividad]);
  const totalPanas = tiendas.reduce((a, t) => a + t.panasPorArmar, 0);
  const totalIns = tiendas.reduce((a, t) => a + t.insumosPendientes, 0);
  const todos = Object.values(porSucursal).flat();
  const enviados = todos.filter((d) => ESTADOS_HECHOS.includes(d.estado)).length;
  const totalDesp = todos.filter((d) => d.estado !== 'no_disponible').length;
  const sabores = useMemo(() => Object.entries(produccion).sort((a, b) => {
    const fa = a[1].destinos.some((d) => !ESTADOS_RESUELTOS.includes(d.estado)); const fb = b[1].destinos.some((d) => !ESTADOS_RESUELTOS.includes(d.estado));
    return fa !== fb ? (fa ? -1 : 1) : b[1].totalPanas - a[1].totalPanas;
  }), [produccion]);
  const consolidados = useMemo(() => {
    const m = new Map();
    for (const p of pedidos) { if (p.estado === 'recibido') continue; for (const it of p.items) { if (it.enviado) continue; if (!m.has(it.insumo_texto)) m.set(it.insumo_texto, { nombre: it.insumo_texto, detalles: [] }); m.get(it.insumo_texto).detalles.push({ sucursal: p.sucursal_nombre, cantidad: (it.cantidad || '').trim() }); } }
    return [...m.values()].sort((a, b) => b.detalles.length - a.detalles.length);
  }, [pedidos]);
  const nada = tiendas.length === 0 && sinReportar.length === 0;

  function compartir() {
    const l = [`*Despacho ${fecha}*`, ''];
    for (const t of tiendas) {
      if (t.listo) continue;
      l.push(`*${t.nombre}*`);
      for (const d of t.items.filter((x) => !ESTADOS_RESUELTOS.includes(x.estado))) l.push(`• ${d.sabor_nombre} — ${d.panas} pana${d.panas > 1 ? 's' : ''}`);
      for (const p of t.insumos) for (const i of p.items.filter((x) => !x.enviado)) l.push(`• ${i.insumo_texto}${i.cantidad ? ` (${i.cantidad})` : ''}`);
      l.push('');
    }
    if (l.length <= 2) l.push('Todo despachado');
    const texto = l.join('\n');
    if (navigator.share) navigator.share({ text: texto }).catch(() => {});
    else navigator.clipboard?.writeText(texto).then(() => avisar('Resumen copiado: pégalo en WhatsApp'), () => avisar('No se pudo copiar', 'mal'));
  }

  if (cargando) return <div className="rep"><div className="encabezado-pagina"><h1>Despacho</h1></div><Esqueleto alto={90} /><Esqueleto alto={90} /><small className="centro">Cargando lo de hoy… la primera vez del día puede tardar unos segundos.</small></div>;
  if (error && !yaCargo.current) return <div className="rep"><div className="encabezado-pagina"><h1>Despacho</h1></div><div className="tarjeta centro"><b>No se pudo cargar</b><p>{error}</p><button className="btn primario bloque" onClick={recargar} disabled={actualizando}>Reintentar</button></div></div>;

  const abierta = tiendas.find((t) => t.id === pantalla);
  if (abierta) {
    const pend = abierta.items.filter((d) => !ESTADOS_RESUELTOS.includes(d.estado));
    const hechos = abierta.items.length - pend.length;
    return (
      <div className="rep">
        <div className="fila espacio"><button className="btn" onClick={() => setPantalla(null)}>← Tiendas</button><h2 style={{ flex: 1, textAlign: 'center' }}>{abierta.nombre}</h2><Pill estado={abierta.estadoGeneral} /><span className="chip">{hechos}/{abierta.items.length}</span></div>
        {abierta.reportadoEn && <div className="aviso-caja">Esta tienda envió su reporte <b>{cuandoTexto(abierta.reportadoEn)}</b></div>}
        {abierta.items.length > 0 && (
          <>
            <h3>Panas a armar</h3>
            {['roja', 'amarilla'].map((cat) => {
              const items = abierta.items.filter((d) => d.categoria === cat);
              if (!items.length) return null;
              return (
                <div className="tarjeta" key={cat}>
                  <b>{cat === 'roja' ? '🔴 Urgentes (2 panas)' : '🟡 Bajos (1 pana)'}</b>
                  {items.map((d) => {
                    const abierto = !ESTADOS_RESUELTOS.includes(d.estado); const pista = abierto ? textoUltimaProduccion(ultimaProd[d.sabor_id], fecha) : null;
                    return (
                      <div className="rep-recep" key={d.id}>
                        <div className="fila espacio">
                          <div className="rep-fila-info"><b>{d.sabor_nombre}</b>{d.estado !== 'no_disponible' && <small>{d.panas} pana{d.panas === 1 ? '' : 's'}</small>}{pista && <small>{pista}</small>}</div>
                          {d.estado === 'enviado' && <span className="chip ok">Enviado ×{d.panas}</span>}
                          {d.estado === 'recibido' && <span className={`chip ${d.discrepancia ? 'mal' : 'ok'}`}>{d.discrepancia ? 'Discrepancia' : `Recibido ×${d.panas}`}</span>}
                          {d.estado === 'no_disponible' && <span className="chip">No hay</span>}
                        </div>
                        {abierto && <div className="fila espacio"><BotonesPanas sugerido={d.panas} onSeleccionar={(n) => marcarPanas(d.id, n)} /><button className="rep-btn-no" onClick={() => noHay(d.id)}>No hay</button></div>}
                      </div>
                    );
                  })}
                </div>
              );
            })}
            <LotePanasConExcepciones pendientes={pend.map((d) => ({ id: d.id, etiqueta: d.sabor_nombre }))} onEnviar={lotePanas} />
          </>
        )}
        {abierta.insumos.length > 0 && (
          <>
            <h3>Insumos a juntar</h3>
            {abierta.insumos.map((p) => <ChecklistInsumos key={p.id} pedido={p} onAlternar={alternarItem} onDespachar={despacharInsumos} />)}
          </>
        )}
        {avisoVista}
      </div>
    );
  }

  if (pantalla === 'produccion') {
    return (
      <div className="rep">
        <div className="fila espacio"><button className="btn" onClick={() => setPantalla(null)}>← Tiendas</button><h2>Qué preparar</h2><span className="chip">{totalPanas}</span></div>
        {sabores.length === 0 && <div className="vacio">Nada pendiente para preparar</div>}
        {sabores.map(([saborId, info]) => {
          const pend = info.destinos.filter((d) => !ESTADOS_RESUELTOS.includes(d.estado)); const listo = pend.length === 0;
          return (
            <div className="tarjeta" key={saborId} style={listo ? { opacity: 0.7 } : undefined}>
              <div className="fila espacio"><h3 style={{ flex: 1 }}>{listo && '✓ '}{info.nombre}</h3><span className="chip">{info.totalPanas} panas</span></div>
              {!listo && textoUltimaProduccion(ultimaProd[saborId], fecha) && <small>{textoUltimaProduccion(ultimaProd[saborId], fecha)}</small>}
              {info.destinos.map((d) => (
                <div className="rep-recep" key={d.despachoId}>
                  <div className="fila espacio"><div className="rep-fila-info"><b>{d.sucursal}</b>{d.estado !== 'no_disponible' && <small>{d.panas} pana{d.panas === 1 ? '' : 's'}</small>}</div>
                    {ESTADOS_HECHOS.includes(d.estado) && <span className="chip ok">×{d.panas}</span>}{d.estado === 'no_disponible' && <span className="chip">No hay</span>}</div>
                  {!ESTADOS_RESUELTOS.includes(d.estado) && <div className="fila espacio"><BotonesPanas sugerido={d.panas} onSeleccionar={(n) => marcarPanas(d.despachoId, n)} /><button className="rep-btn-no" onClick={() => noHay(d.despachoId)}>No hay</button></div>}
                </div>
              ))}
              <LotePanasConExcepciones pendientes={pend.map((d) => ({ id: d.despachoId, etiqueta: d.sucursal }))} onEnviar={lotePanas} />
            </div>
          );
        })}
        {avisoVista}
      </div>
    );
  }

  if (pantalla === 'juntar') {
    return (
      <div className="rep">
        <div className="fila espacio"><button className="btn" onClick={() => setPantalla(null)}>← Tiendas</button><h2>Lista para juntar</h2><span className="chip">{consolidados.length}</span></div>
        {consolidados.length === 0 ? <div className="vacio">No hay insumos pendientes</div> : (
          <div className="tarjeta">
            <small>Todo el material que hay que juntar hoy, sumado de las {tiendas.length} tiendas. Después despachas tienda por tienda.</small>
            {consolidados.map((i) => (
              <div className="rep-fila" key={i.nombre}><div className="rep-fila-info"><b>{i.nombre}</b><small>{i.detalles.map((d) => (d.cantidad ? `${d.sucursal}: ${d.cantidad}` : d.sucursal)).join(' · ')}</small></div><span className="chip aviso">{i.detalles.length} tienda{i.detalles.length > 1 ? 's' : ''}</span></div>
            ))}
          </div>
        )}
        {avisoVista}
      </div>
    );
  }

  return (
    <div className="rep">
      <div className="encabezado-pagina">
        <div><h1>Despacho</h1><div className="rep-sub">{textoDia(fecha)}</div></div>
        <button className="btn" onClick={recargar} disabled={actualizando} title="Actualizar ahora">{actualizando ? 'Actualizando…' : `⟳ ${datoDesde ? haceCuanto(datoDesde) : ''}`}</button>
      </div>
      <div className="tarjeta fila" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ flex: '1 1 190px', minWidth: 0 }}>Noche del reporte<input type="date" style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }} value={fecha} max={hoyIso()} onChange={(e) => e.target.value && setFecha(e.target.value)} /></label>
        {fecha === hoyIso() ? <button className="btn" onClick={() => setFecha(diaAnterior(fecha))}>Ver anoche</button>
          : fecha === diaAnterior(hoyIso()) ? <button className="btn" onClick={() => setFecha(hoyIso())}>Ver la de hoy</button>
            : <button className="btn" onClick={() => setFecha(nocheInicial())}>Ir a la más reciente</button>}
      </div>
      {fecha !== nocheInicial() && <div className="aviso-caja">Estás viendo el reporte del <b>{fechaCorta(fecha)}</b>, no el de la noche vigente. Lo que marques se guarda en ese día.</div>}
      <div><h2>{saludo()}</h2><div className="rep-sub">{nada ? 'Todavía nadie ha enviado su reporte.' : 'Toca una tienda para armarla.'}</div></div>
      {!nada && (
        <div className="rejilla cols-3">
          <div className="kpi"><div className="etq">Panas por armar</div><div className="val">{totalPanas}</div></div>
          <div className="kpi"><div className="etq">Insumos por juntar</div><div className="val" style={{ color: totalIns ? 'var(--aviso)' : 'var(--ok)' }}>{totalIns}</div></div>
          <div className="kpi"><div className="etq">Ya enviado</div><div className="val">{enviados}/{totalDesp}</div></div>
        </div>
      )}
      {nada && <div className="vacio">Nada por hacer todavía. En cuanto una tienda envíe su reporte, aparece aquí.</div>}
      {tiendas.length > 0 && tiendas.every((t) => t.listo) && <div className="aviso-caja ok"><b>Todo despachado</b>: las {tiendas.length} tiendas quedaron listas.</div>}
      {!nada && (
        <>
          <h3>Tiendas · {tiendas.filter((t) => t.listo).length}/{tiendas.length} listas</h3>
          <div className="rep-lista">
            {tiendas.map((t) => (
              <button key={t.id} className={`rep-tienda ${t.listo ? 'lista' : ''}`} onClick={() => setPantalla(t.id)}>
                <span className="icono">{t.listo ? '✓' : t.nombre.slice(0, 1)}</span>
                <span className="info"><b>{t.nombre}</b>
                  {t.listo ? <small>Todo listo</small> : <small>{t.panasPorArmar > 0 && `${t.panasPorArmar} pana${t.panasPorArmar === 1 ? '' : 's'}`}{t.panasPorArmar > 0 && t.insumosPendientes > 0 && ' · '}{t.insumosPendientes > 0 && `${t.insumosPendientes} insumo${t.insumosPendientes === 1 ? '' : 's'}`}</small>}
                  {t.reportadoEn && <small>Envió {cuandoTexto(t.reportadoEn)}</small>}</span>
                <Pill estado={t.estadoGeneral} />
              </button>
            ))}
            {sinReportar.map((s) => <div key={s.id} className="rep-tienda vacia"><span className="icono">{s.nombre.slice(0, 1)}</span><span className="info"><b>{s.nombre}</b><small>Todavía no reportó esta noche</small></span></div>)}
          </div>
          <div className="fila">
            <button className="btn" onClick={() => setPantalla('juntar')}>Juntar todo ({consolidados.length})</button>
            <button className="btn" onClick={() => setPantalla('produccion')}>Ver por sabor</button>
            <button className="btn" onClick={compartir}>Compartir</button>
          </div>
        </>
      )}
      {avisoVista}
    </div>
  );
}

/** Lista de un pedido de insumos: se tilda lo que se junta, y «Despachar» manda solo lo marcado y cierra el pedido. */
function ChecklistInsumos({ pedido, onAlternar, onDespachar }) {
  const hecho = pedido.estado === 'recibido' || pedido.estado === 'enviado';
  const marcados = pedido.items.filter((i) => i.preparado && !i.enviado).map((i) => i.id);
  return (
    <div className="tarjeta">
      <div className="fila espacio"><small>{fechaCorta(pedido.fecha)}{pedido.notas ? ` · ${pedido.notas}` : ''}</small><Pill estado={pedido.estado} /></div>
      {pedido.items.map((i) => (
        <label key={i.id} className={`rep-check ${i.enviado ? 'hecho' : ''}`}>
          <input type="checkbox" checked={Boolean(i.preparado || i.enviado)} disabled={hecho || Boolean(i.enviado)} onChange={() => onAlternar(i.id, Boolean(i.preparado))} />
          <span style={{ flex: 1 }}><b style={{ color: 'var(--texto)' }}>{i.insumo_texto}</b>{i.cantidad ? <small> · {i.cantidad}</small> : null}</span>
        </label>
      ))}
      {!hecho && <button className="btn primario grande bloque" disabled={!marcados.length} onClick={() => onDespachar(pedido, marcados)}>{marcados.length ? `Despachar ${marcados.length} marcado${marcados.length === 1 ? '' : 's'}` : 'Marca lo que sí hay para despachar'}</button>}
    </div>
  );
}
