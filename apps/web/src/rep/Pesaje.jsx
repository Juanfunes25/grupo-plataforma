// Pesaje de sucursal: pesaje nocturno por pana, pedido de insumos, recepción de despachos y catálogo.
// Calco de PesajeSucursal.jsx del original, en el kit oscuro y pensado para tablet/celular en tienda.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, get, patch, post, put } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Tabs, useAviso } from '../ui/kit.jsx';
import { BotonesPanas, CatalogoInsumos, CatalogoSabores, Esqueleto, FajaConexion, SelectorSucursal, useSucursalesRep } from './comun.jsx';
import { Historial } from './Historial.jsx';
import { alVolverLaSenal, contarPendientes, cuandoTexto, fechaCorta, guardarCache, hoyIso, idCliente, leerCache, postConCola, reducirFoto, sincronizar, sumarDias, vibrar } from './lib.js';

const del = (ruta) => api(ruta, { metodo: 'DELETE' });
const BORRADOR = (suc, fecha) => `rep.borrador.${suc}.${fecha}`;
const leerBorrador = (k) => { try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch { return {}; } };

export default function Pesaje() {
  const { puede } = useSesion();
  const avisar = useAviso();
  const { lista, cargando: cargandoSuc, sucursal, setId } = useSucursalesRep();
  const sid = sucursal?.id;
  const hoy = hoyIso();
  const [tab, setTab] = useState('sabores');
  const [subCat, setSubCat] = useState('sabores');
  const [sabores, setSabores] = useState([]);
  const [cargandoSab, setCargandoSab] = useState(true);
  const [errorCarga, setErrorCarga] = useState('');
  const [valores, setValores] = useState({});
  const [guardados, setGuardados] = useState({});
  const clientes = useRef({});               // sabor_id → cliente_id estable: un reintento llega con el MISMO id
  const [q, setQ] = useState('');
  const [soloFaltan, setSoloFaltan] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [lento, setLento] = useState(false);
  const [sinSenal, setSinSenal] = useState(0);
  // pedido
  const [carrito, setCarrito] = useState([]);
  const [otro, setOtro] = useState({ insumo_texto: '', cantidad: '' });
  const [notas, setNotas] = useState('');
  const [corrigiendo, setCorrigiendo] = useState(null);
  const [catalogoIns, setCatalogoIns] = useState([]);
  const [todosChips, setTodosChips] = useState(false);
  const [misPedidos, setMisPedidos] = useState([]);
  const [ultimo, setUltimo] = useState(null);
  // foto
  const [fotoOk, setFotoOk] = useState(false);
  const [leyendo, setLeyendo] = useState(false);
  const [porFoto, setPorFoto] = useState({});
  const [nuevosFoto, setNuevosFoto] = useState([]);
  // recepción
  const [fechaRecep, setFechaRecep] = useState(hoy);
  const [despachos, setDespachos] = useState([]);
  const [ocupadoRecep, setOcupadoRecep] = useState(null);

  // ── Carga ──
  const aplicarSabores = useCallback((datos) => {
    setSabores(datos);
    const ya = {}; for (const s of datos) if (s.ultimo_peso_fecha === hoy) ya[s.id] = true;
    setGuardados((g) => ({ ...ya, ...g }));
  }, [hoy]);

  const cargarSabores = useCallback(async () => {
    if (!sid) return;
    try { const d = await get(`/rep/sucursales/${sid}/sabores`); aplicarSabores(d); guardarCache(`sabores.${sid}`, d); setErrorCarga(''); }
    catch (e) { setErrorCarga((prev) => (sabores.length ? prev : e.message)); }
    finally { setCargandoSab(false); }
  }, [sid, aplicarSabores]); // eslint-disable-line react-hooks/exhaustive-deps

  const cargarPedidos = useCallback(async () => { try { setMisPedidos(await get('/rep/pedidos')); } catch { /* sin señal */ } }, []);
  const cargarCatalogoIns = useCallback(async () => {
    if (!sid) return;
    try { const d = await get(`/rep/insumos/catalogo?sucursal_id=${sid}`); setCatalogoIns(d); guardarCache(`insumos.${sid}`, d); } catch { /* caché */ }
  }, [sid]);
  const cargarDespachos = useCallback(async () => {
    if (!sid) return;
    try { const d = await get(`/rep/despachos/${fechaRecep}`); setDespachos(d[sid] || []); } catch { /* sin señal */ }
  }, [sid, fechaRecep]);
  const contar = useCallback(async () => setSinSenal(await contarPendientes()), []);
  const sincronizarTodo = useCallback(async () => { const quedan = await sincronizar(); setSinSenal(quedan); if (!quedan) { cargarPedidos(); cargarSabores(); } }, [cargarPedidos, cargarSabores]);

  // Pintar de una lo último que se vio y refrescar atrás: la primera llamada del día puede tardar.
  useEffect(() => {
    if (!sid) return;
    setGuardados({}); setPorFoto({}); setNuevosFoto([]);
    const cs = leerCache(`sabores.${sid}`); if (cs?.datos?.length) { aplicarSabores(cs.datos); setCargandoSab(false); } else { setSabores([]); setCargandoSab(true); }
    const ci = leerCache(`insumos.${sid}`); if (ci?.datos) setCatalogoIns(ci.datos);
    setValores(leerBorrador(BORRADOR(sid, hoy)).valores || {}); clientes.current = leerBorrador(BORRADOR(sid, hoy)).clientes || {};
    cargarSabores(); cargarPedidos(); cargarCatalogoIns();
    get('/rep/pedidos/ultimo?sucursal_id=' + sid).then(setUltimo).catch(() => {});
    api('/rep/extraccion/estado').then((r) => setFotoOk(Boolean(r.disponible))).catch(() => setFotoOk(false));
    contar(); sincronizarTodo();
    return alVolverLaSenal(sincronizarTodo);
  }, [sid]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { cargarDespachos(); }, [cargarDespachos]);

  // El borrador de lo escrito sobrevive a un cierre o recarga (operación sin buena conexión).
  useEffect(() => {
    if (!sid) return;
    try { localStorage.setItem(BORRADOR(sid, hoy), JSON.stringify({ valores, clientes: clientes.current })); } catch { /* */ }
  }, [valores, sid, hoy]);

  // ── Derivados ──
  const escrito = (id) => valores[id] !== undefined && valores[id] !== '';
  const pendientesPesaje = useMemo(() => sabores.filter((s) => escrito(s.id) && !guardados[s.id]), [sabores, valores, guardados]); // eslint-disable-line react-hooks/exhaustive-deps
  const sinTocar = useMemo(() => sabores.filter((s) => !guardados[s.id] && !escrito(s.id)).length, [sabores, valores, guardados]); // eslint-disable-line react-hooks/exhaustive-deps
  const totalGuardados = sabores.filter((s) => guardados[s.id]).length;
  const huboPedidoHoy = misPedidos.some((p) => p.fecha === hoy && p.sucursal_id === sid);
  const hayPendientes = pendientesPesaje.length > 0 || carrito.length > 0;
  const filtrados = useMemo(() => {
    const t = q.trim().toUpperCase();
    let l = t ? sabores.filter((s) => s.nombre.includes(t)) : sabores;
    if (soloFaltan) l = l.filter((s) => !guardados[s.id] && !escrito(s.id));
    return [...l].sort((a, b) => a.nombre.localeCompare(b.nombre));
  }, [sabores, q, soloFaltan, valores, guardados]); // eslint-disable-line react-hooks/exhaustive-deps
  const sePuedeCorregir = (p) => p.estado === 'pedido' && !p.items.some((i) => i.preparado);
  const pedidoAbiertoHoy = misPedidos.find((p) => p.fecha === hoy && p.sucursal_id === sid && sePuedeCorregir(p));

  // ── Foto ──
  async function leerFoto(e) {
    const archivo = e.target.files?.[0]; e.target.value = '';
    if (!archivo) return;
    setLeyendo(true);
    try {
      const imageBase64 = await reducirFoto(archivo);
      const r = await post(`/rep/extraccion/${sid}`, { imageBase64, mediaType: 'image/jpeg' });
      const vals = {}; const conf = {};
      for (const s of r.sabores) if (s.sabor_id && s.total !== null) { vals[s.sabor_id] = s.total; conf[s.sabor_id] = s.confianza; }
      setValores((v) => ({ ...v, ...vals })); setPorFoto((d) => ({ ...d, ...conf }));
      setNuevosFoto(r.sabores_nuevos.filter((s) => s.total !== null));
      avisar(`Foto leída: ${Object.keys(vals).length} sabores detectados. Revisa los números antes de enviar.`);
    } catch (err) { avisar(`Error leyendo la foto: ${err.message}`, 'mal'); }
    finally { setLeyendo(false); }
  }

  // ── Pedido ──
  const agregarOtro = (e) => { e.preventDefault(); if (!otro.insumo_texto.trim()) return; setCarrito((c) => [...c, otro]); setOtro({ insumo_texto: '', cantidad: '' }); };
  const alternarChip = (n) => setCarrito((c) => (c.some((i) => i.insumo_texto === n) ? c.filter((i) => i.insumo_texto !== n) : [...c, { insumo_texto: n, cantidad: '' }]));
  function repetirUltimo() {
    if (!ultimo?.items?.length) return;
    setCarrito(ultimo.items.map((i) => ({ insumo_texto: i.insumo_texto, cantidad: i.cantidad || '' })));
    avisar(`${ultimo.items.length} insumos cargados: revisa y envía`);
  }
  function empezarCorregir(p) { setCorrigiendo(p.id); setCarrito(p.items.map((i) => ({ insumo_texto: i.insumo_texto, cantidad: i.cantidad || '' }))); setNotas(p.notas || ''); avisar('Corrige la lista y toca Guardar corrección'); }
  const cancelarCorreccion = () => { setCorrigiendo(null); setCarrito([]); setNotas(''); };
  async function borrarPedido(p) {
    if (!window.confirm('¿Borrar este pedido? El despachador deja de verlo.')) return;
    try { await del(`/rep/pedidos/${p.id}`); if (corrigiendo === p.id) cancelarCorreccion(); avisar('Pedido borrado'); cargarPedidos(); } catch (e) { avisar(e.message, 'mal'); }
  }

  // ── Enviar reporte (pesajes en UNA solicitud + pedido) ──
  async function enviarReporte() {
    if (enviando || !hayPendientes) return;
    setEnviando(true);
    const t = setTimeout(() => setLento(true), 2500);
    try {
      let offline = false;
      if (pendientesPesaje.length) {
        const pesajes = pendientesPesaje.map((s) => {
          clientes.current[s.id] ||= idCliente();
          return { sabor_id: s.id, gramos: Number(valores[s.id]), cliente_id: clientes.current[s.id], fuente: porFoto[s.id] ? 'foto' : 'manual' };
        });
        const r = await postConCola('pesaje_lote', '/rep/pesajes/lote', { sucursal_id: sid, fecha: hoy, pesajes });
        offline = Boolean(r.offline);
        setGuardados((g) => { const n = { ...g }; for (const s of pendientesPesaje) n[s.id] = true; return n; });
      }
      if (carrito.length) {
        if (corrigiendo) { await put(`/rep/pedidos/${corrigiendo}`, { items: carrito, notas }); setCorrigiendo(null); }
        else { const r = await postConCola('pedido', '/rep/pedidos', { sucursal_id: sid, fecha: hoy, notas, items: carrito }); offline = offline || Boolean(r.offline); }
        setCarrito([]); setNotas(''); cargarPedidos();
      }
      vibrar(25);
      avisar(offline ? 'Guardado sin señal: se envía solo cuando vuelva el internet' : 'Reporte enviado: el despachador ya lo ve');
      contar(); cargarSabores();
    } catch (e) { avisar(`No se pudo enviar: ${e.message}`, 'mal'); }
    finally { clearTimeout(t); setLento(false); setEnviando(false); }
  }

  // ── Recepción ──
  async function recibir(d, n) {
    setOcupadoRecep(d.id);
    const antes = despachos; const dif = n !== d.panas;
    setDespachos((l) => l.map((x) => (x.id === d.id ? { ...x, estado: 'recibido', panas_recibidas: n, discrepancia: dif ? 1 : 0 } : x)));
    try {
      await patch(`/rep/despachos/${d.id}/recepcion`, { panas_recibidas: n });
      vibrar(20);
      avisar(dif ? `Anotado: llegaron ${n} de ${d.panas}. El dueño lo va a ver.` : 'Recepción confirmada');
    } catch (e) { setDespachos(antes); avisar(`No se pudo confirmar: ${e.message}`, 'mal'); }
    finally { setOcupadoRecep(null); }
  }
  async function corregirRecep(d) {
    setOcupadoRecep(d.id); const antes = despachos;
    setDespachos((l) => l.map((x) => (x.id === d.id ? { ...x, estado: 'enviado', panas_recibidas: null, discrepancia: 0 } : x)));
    try { await patch(`/rep/despachos/${d.id}/corregir-recepcion`); } catch (e) { setDespachos(antes); avisar(`No se pudo deshacer: ${e.message}`, 'mal'); }
    finally { setOcupadoRecep(null); }
  }

  if (cargandoSuc && !sucursal) return <div className="rep"><Esqueleto alto={160} /></div>;
  if (!sucursal) return <div className="rep"><div className="aviso-caja">No hay sucursales de reposición disponibles para tu usuario.</div></div>;

  const tabs = [['sabores', `Sabores${totalGuardados ? ` (${totalGuardados})` : ''}`], ['insumos', `Insumos${carrito.length ? ` (${carrito.length})` : ''}`], ['recepcion', `Recepción${despachos.length ? ` (${despachos.length})` : ''}`], ['catalogo', 'Catálogo'], ...(puede('rep:ver') ? [['historial', 'Reportes']] : [])];

  return (
    <div className="rep">
      <div className="encabezado-pagina">
        <div><h1>Pesaje de {sucursal.nombre}</h1><div className="rep-sub">Pesaje nocturno · {fechaCorta(hoy)}</div></div>
      </div>
      <SelectorSucursal lista={lista} valor={sucursal.id} onCambio={setId} />
      <FajaConexion pendientes={sinSenal} />

      {hayPendientes ? (
        <div className="rep-hero aviso">
          <b>
            {pendientesPesaje.length > 0 && `${pendientesPesaje.length} sabor${pendientesPesaje.length === 1 ? '' : 'es'} sin enviar`}
            {pendientesPesaje.length > 0 && carrito.length > 0 && ' · '}
            {carrito.length > 0 && `${carrito.length} insumo${carrito.length === 1 ? '' : 's'} en el pedido`}
          </b>
          <div className="rep-sub">{corrigiendo ? 'Estás corrigiendo un pedido que ya mandaste: toca «Guardar corrección».' : 'El despachador todavía no ve nada. Toca «Enviar reporte» cuando termines.'}</div>
        </div>
      ) : (totalGuardados > 0 || huboPedidoHoy) ? (
        <div className="rep-hero ok">
          <b style={{ fontSize: '1.15rem' }}>Reporte de la noche enviado</b>
          <div className="rep-sub">{totalGuardados > 0 && `${totalGuardados} sabor${totalGuardados === 1 ? '' : 'es'} pesado${totalGuardados === 1 ? '' : 's'}`}{totalGuardados > 0 && huboPedidoHoy && ' y '}{huboPedidoHoy && 'pedido de insumos enviado'}. El despachador ya lo puede ver; puedes seguir agregando si hace falta.</div>
        </div>
      ) : null}

      <Tabs tabs={tabs} valor={tab} onCambio={setTab} />

      {tab === 'sabores' && (
        <>
          <div className="fila">
            {fotoOk ? (
              <label className="btn grande" style={{ flex: 1 }}>
                {leyendo ? 'Leyendo la foto…' : 'Leer pesaje por foto'}
                <input type="file" accept="image/*" capture="environment" onChange={leerFoto} disabled={leyendo} hidden />
              </label>
            ) : (
              <span className="chip" title="Falta ANTHROPIC_API_KEY en el servidor">Lectura por foto desactivada en este servidor: pesa a mano</span>
            )}
          </div>
          {Object.keys(porFoto).length > 0 && <div className="aviso-caja">{Object.keys(porFoto).length} sabores detectados por foto: revisa los números y toca «Enviar reporte» cuando termines.</div>}
          {nuevosFoto.length > 0 && (
            <div className="tarjeta">
              <b>No coinciden con tu catálogo</b>
              <small>La foto trae estos nombres pero no están en tu lista (puede ser un sabor que aún no está activo en esta tienda). No se guardan solos: actívalos en «Catálogo» y escribe el número.</small>
              {nuevosFoto.map((s) => <div className="rep-fila" key={s.nombre}><div className="rep-fila-info"><b>{s.nombre}</b><small>{s.total} g · confianza {s.confianza}</small></div></div>)}
            </div>
          )}
          <div className="fila">
            <input placeholder="Buscar sabor…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
            <button className={`btn ${soloFaltan ? 'primario' : 'fantasma'}`} onClick={() => setSoloFaltan((v) => !v)}>{soloFaltan ? '✓ Solo los que faltan' : `Solo los que faltan (${sinTocar})`}</button>
            {pendientesPesaje.length > 0 && <button className="btn fantasma" onClick={() => { setValores({}); avisar('Se limpió lo escrito'); }}>Limpiar lo escrito</button>}
          </div>
          {cargandoSab && !sabores.length ? (
            <div className="rep-grid">{[0, 1, 2, 3, 4, 5].map((i) => <Esqueleto key={i} alto={110} />)}</div>
          ) : errorCarga && !sabores.length ? (
            <div className="tarjeta centro"><b>No se pudo cargar la lista</b><p>{errorCarga}</p><button className="btn primario bloque" onClick={cargarSabores}>Reintentar</button></div>
          ) : filtrados.length === 0 ? (
            <div className="vacio">Sin resultados</div>
          ) : (
            <div className="rep-grid">
              {filtrados.map((s) => {
                const tiene = escrito(s.id); const sinEnviar = tiene && !guardados[s.id];
                return (
                  <div className={`rep-celda ${guardados[s.id] ? 'listo' : sinEnviar ? 'pend' : ''}`} key={s.id}>
                    <b>{s.nombre}</b>
                    {porFoto[s.id] && <small>foto · confianza {porFoto[s.id]}</small>}
                    {s.ultimo_peso != null && <span className="rep-ayer">última vez: {s.ultimo_peso} g</span>}
                    <div className="rep-entrada">
                      <input type="number" inputMode="numeric" min="0" placeholder="g" value={valores[s.id] ?? ''} aria-label={`Gramos de ${s.nombre}`}
                        onChange={(e) => { delete clientes.current[s.id]; setValores((v) => ({ ...v, [s.id]: e.target.value })); setGuardados((g) => ({ ...g, [s.id]: false })); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }} />
                      {guardados[s.id] ? <span className="rep-estado ok">✓</span> : sinEnviar ? <span className="rep-estado pend">•</span> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {tab === 'insumos' && (
        <div className="tarjeta rejilla">
          {ultimo?.items?.length > 0 && carrito.length === 0 && (
            <button className="btn grande" onClick={repetirUltimo} style={{ whiteSpace: 'normal', textAlign: 'left' }}>
              <span><b>Pedir lo mismo que la última vez</b><br /><small>{ultimo.items.map((i) => i.insumo_texto).join(', ')}</small></span>
            </button>
          )}
          {carrito.length > 0 && (
            <div>
              {carrito.map((it, i) => (
                <div className="rep-fila" key={i}>
                  <div className="rep-fila-info"><b>{it.insumo_texto}</b>
                    <input placeholder="cantidad (opcional)" value={it.cantidad} onChange={(e) => setCarrito((c) => c.map((x, j) => (j === i ? { ...x, cantidad: e.target.value } : x)))} /></div>
                  <button className="btn chico peligro" onClick={() => setCarrito((c) => c.filter((_, j) => j !== i))}>Quitar</button>
                </div>
              ))}
              <button className="btn chico fantasma" onClick={() => setCarrito([])}>Vaciar lista</button>
            </div>
          )}
          {catalogoIns.length > 0 && (
            <div>
              <label>Toca para agregar rápido</label>
              <div className="rep-chips" style={{ marginTop: 6 }}>
                {catalogoIns.slice(0, todosChips ? catalogoIns.length : 24).map((i) => {
                  const on = carrito.some((c) => c.insumo_texto === i.nombre);
                  return <button key={i.nombre} className={`rep-chip ${on ? 'on' : ''}`} onClick={() => alternarChip(i.nombre)}>{on ? '✓ ' : ''}{i.nombre}</button>;
                })}
                {!todosChips && catalogoIns.length > 24 && <button className="rep-chip punteada" onClick={() => setTodosChips(true)}>+ {catalogoIns.length - 24} más</button>}
              </div>
            </div>
          )}
          <form onSubmit={agregarOtro} className="rejilla" style={{ gap: 8 }}>
            <label>Otro insumo (no está en la lista de arriba)
              <input list="rep-lista-insumos" placeholder="Ej: Vasos 8oz" value={otro.insumo_texto} onChange={(e) => setOtro({ ...otro, insumo_texto: e.target.value })} /></label>
            <datalist id="rep-lista-insumos">{catalogoIns.map((i) => <option key={i.nombre} value={i.nombre} />)}</datalist>
            <label>Cantidad (opcional)<input placeholder="Ej: 200 unidades" value={otro.cantidad} onChange={(e) => setOtro({ ...otro, cantidad: e.target.value })} /></label>
            <button type="submit" className="btn bloque">+ Agregar otro ítem al pedido</button>
          </form>
          <label>Notas del pedido (opcional)<input value={notas} onChange={(e) => setNotas(e.target.value)} /></label>
          {misPedidos.filter((p) => p.sucursal_id === sid).length > 0 && (
            <div>
              <h3>Mis pedidos recientes</h3>
              {misPedidos.filter((p) => p.sucursal_id === sid).slice(0, 2).map((p) => (
                <div className="rep-recep" key={p.id}>
                  <div className="fila espacio"><small>{fechaCorta(p.fecha)}</small><span className="chip">{p.estado === 'pedido' ? 'pendiente' : p.estado}</span></div>
                  {p.items.map((i) => <small key={i.id}>• {i.insumo_texto}{i.cantidad ? ` (${i.cantidad})` : ''}</small>)}
                  {sePuedeCorregir(p) ? (corrigiendo === p.id ? <small>Lo estás corrigiendo arriba. Toca Guardar para dejarlo así.</small> : (
                    <div className="fila"><button className="btn chico" onClick={() => empezarCorregir(p)}>Corregir</button><button className="btn chico peligro" onClick={() => borrarPedido(p)}>Borrar</button></div>
                  )) : <small>Ya lo están preparando: para cambiarlo habla con el despachador.</small>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'recepcion' && (
        <>
          <div className="tarjeta fila">
            <label style={{ flex: 1, minWidth: 180 }}>Día que te lo mandaron<input type="date" value={fechaRecep} max={hoy} onChange={(e) => e.target.value && setFechaRecep(e.target.value)} /></label>
            {fechaRecep === hoy && <button className="btn" onClick={() => setFechaRecep(sumarDias(hoy, -1))}>Ver ayer</button>}
          </div>
          <div className="tarjeta">
            {despachos.length === 0 ? (
              <div className="vacio">Fábrica todavía no despachó nada para el {fechaCorta(fechaRecep)}. Apenas salga te aparece aquí: el día es el de la entrega, no el del pedido.</div>
            ) : (
              <>
                <small>Cuenta las panas que te llegaron de cada sabor y toca el número.</small>
                {despachos.map((d) => (
                  <div className="rep-recep" key={d.id}>
                    <div className="fila espacio"><b>{d.sabor_nombre}</b><small>Te mandaron <b>{d.panas} pana{d.panas === 1 ? '' : 's'}</b></small></div>
                    {d.estado === 'recibido' ? (
                      <div className="fila">
                        <span className={`chip ${d.discrepancia ? 'mal' : 'ok'}`}>{d.discrepancia ? `Llegaron ${d.panas_recibidas ?? '?'}` : `Recibí ${d.panas_recibidas ?? d.panas}`}</span>
                        <button className="btn chico fantasma" disabled={ocupadoRecep === d.id} onClick={() => corregirRecep(d)}>Corregir</button>
                      </div>
                    ) : (
                      <div className="rep-panas">
                        {[0, 1, 2, 3, 4].map((n) => <button key={n} className={`rep-pana ${n === d.panas ? 'sugerido' : ''}`} disabled={ocupadoRecep === d.id} onClick={() => recibir(d, n)}>{n}</button>)}
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        </>
      )}

      {tab === 'catalogo' && (
        <>
          <Tabs tabs={[['sabores', 'Sabores'], ['insumos', 'Insumos']]} valor={subCat} onCambio={setSubCat} />
          {subCat === 'sabores' ? <CatalogoSabores sucursalId={sid} onCambio={cargarSabores} /> : <CatalogoInsumos sucursalId={sid} onCambio={cargarCatalogoIns} />}
        </>
      )}

      {tab === 'historial' && <Historial sucursalId={sid} />}

      {tab !== 'recepcion' && hayPendientes && (
        <div className="rep-barra-fija">
          <div>
            <button className="btn primario" onClick={enviarReporte} disabled={enviando}>
              {enviando ? 'Enviando…' : corrigiendo ? `Guardar corrección (${carrito.length})` : pedidoAbiertoHoy && carrito.length > 0 ? `Agregar a mi pedido de hoy (${pendientesPesaje.length + carrito.length})` : `Enviar reporte (${pendientesPesaje.length + carrito.length})`}
            </button>
            {corrigiendo && <button className="btn chico fantasma bloque" onClick={cancelarCorreccion}>Cancelar la corrección</button>}
            {lento && <small className="centro">Conectando con el servidor… no cierres la app, tus datos no se pierden.</small>}
          </div>
        </div>
      )}
    </div>
  );
}
