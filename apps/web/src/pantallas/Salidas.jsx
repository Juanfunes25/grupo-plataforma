import { useEffect, useState } from 'react';
import { lempiras, numero } from '@grupo/shared';
import { get, post } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Modal } from '../ui/kit.jsx';
import AvisoSinStock from '../diserco/AvisoSinStock.jsx';
import SelectorProductos from '../diserco/SelectorProductos.jsx';
import '../diserco/diserco.css';

const fechaCorta = (iso) => new Date(iso).toLocaleDateString('es-HN', { timeZone: 'America/Tegucigalpa', day: '2-digit', month: 'short', year: 'numeric' });
const resumenItems = (items) => items.filter((i) => i.pendiente > 0).map((i) => `${numero(i.pendiente, 0)} × ${i.productos?.nombre}`).join(' · ');

// Salidas de material a proyecto. El administrador ve todo el control; el gestor / bodega ven dos botones grandes (sacar y recibir).
export default function Salidas() {
  const { puede } = useSesion();
  const admin = puede('admin:empresa');
  const [vista, setVista] = useState({ tipo: admin ? 'lista' : 'menu' });
  const [aviso, setAviso] = useState('');
  const [error, setError] = useState('');
  const [hecha, setHecha] = useState(null);       // confirmación para quien no es administrador
  const [intento, setIntento] = useState(0);
  const inicio = () => setVista({ tipo: admin ? 'lista' : 'menu' });

  if (!admin && hecha) {
    return (
      <div className="pagina"><div className="tarjeta centro">
        <h2 style={{ color: 'var(--ok)', fontSize: '1.8rem' }}>✔ Salida registrada</h2>
        <p style={{ fontSize: '1.15rem' }}><strong>{hecha.proyecto}</strong></p>
        <p className="tenue">{hecha.unidades} unidades quedaron registradas{hecha.sumada ? ' (se sumaron al material del proyecto)' : ''}.</p>
        <button className="btn primario dis-grande" onClick={() => { setHecha(null); setIntento((n) => n + 1); setVista({ tipo: 'nueva' }); }}>SACAR MÁS MATERIAL</button>
        <button className="btn bloque" style={{ marginTop: 8 }} onClick={() => { setHecha(null); inicio(); }}>Volver al inicio</button>
      </div></div>
    );
  }
  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Salidas a proyecto</h1></div>
      {error && <div className="aviso-caja mal" onClick={() => setError('')}>{error}</div>}
      {aviso && <div className="aviso-caja ok" onClick={() => setAviso('')}>{aviso}</div>}
      {vista.tipo === 'menu' && (
        <div className="tarjeta rejilla">
          <button className="btn primario dis-grande" onClick={() => setVista({ tipo: 'nueva' })}>SACAR MATERIAL A UN PROYECTO</button>
          <button className="btn dis-grande" onClick={() => setVista({ tipo: 'recibir' })}>RECIBIR MATERIAL Y TERMINAR PROYECTO</button>
        </div>
      )}
      {vista.tipo === 'lista' && <Lista onAbrir={(id) => setVista({ tipo: 'detalle', id })} onNueva={() => setVista({ tipo: 'nueva' })} onRecibir={() => setVista({ tipo: 'recibir' })} onError={setError} />}
      {vista.tipo === 'nueva' && <Nueva key={intento} onCancelar={inicio} onCreada={(s) => { if (admin) { setAviso(s.sumada ? `Material sumado al proyecto: ${s.proyecto}` : `Salida registrada: ${s.proyecto}`); setVista({ tipo: 'detalle', id: s.id }); } else setHecha(s); }} />}
      {vista.tipo === 'recibir' && <PorCerrar onElegir={(id) => setVista({ tipo: 'recepcion', id })} onVolver={inicio} />}
      {vista.tipo === 'recepcion' && <Recepcion id={vista.id} verCostos={puede('pos:catalogo')} onVolver={() => setVista({ tipo: 'recibir' })} onFin={inicio} />}
      {vista.tipo === 'detalle' && <Detalle id={vista.id} onVolver={() => setVista({ tipo: 'lista' })} onTerminar={() => setVista({ tipo: 'recepcion', id: vista.id })} />}
    </div>
  );
}

function Lista({ onAbrir, onNueva, onRecibir, onError }) {
  const { puede } = useSesion();
  const [filas, setFilas] = useState([]);
  const [cerrados, setCerrados] = useState(false);
  const mueve = puede('dis:salidas');
  const costos = puede('pos:catalogo');
  useEffect(() => { get(`/diserco/salidas?estado=${cerrados ? 'cerrada' : 'abierta'}`).then(setFilas).catch((e) => onError(e.message)); }, [cerrados]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="tarjeta rejilla">
      {mueve && <button className="btn primario dis-grande" onClick={onNueva}>SACAR MATERIAL A UN PROYECTO</button>}
      {mueve && <button className="btn bloque" onClick={onRecibir}>Recibir material y terminar un proyecto</button>}
      <h3>{cerrados ? 'Proyectos cerrados' : 'Material que está en proyectos'}</h3>
      <div className="dis-lista-proy">
        {filas.map((s) => (
          <button key={s.id} className="btn" onClick={() => onAbrir(s.id)}>
            <strong style={{ fontSize: '1.1rem', display: 'block' }}>{s.proyecto}</strong>
            <small style={{ display: 'block', margin: '4px 0', whiteSpace: 'normal' }}>{resumenItems(s.items) || 'Sin material pendiente'}</small>
            <small>{numero(s.unidades, 0)} unidades · desde {fechaCorta(s.created_at)}{costos && s.costo_total != null ? ` · ${lempiras(s.costo_total)}` : ''}</small>
          </button>
        ))}
        {filas.length === 0 && <p className="vacio">{cerrados ? 'Aún no hay proyectos cerrados.' : 'No hay material fuera en este momento.'}</p>}
      </div>
      <div><button className="btn chico" onClick={() => setCerrados(!cerrados)}>{cerrados ? '← Ver proyectos en curso' : 'Ver proyectos cerrados'}</button></div>
    </div>
  );
}

function Nueva({ onCancelar, onCreada }) {
  const [productos, setProductos] = useState([]);
  const [abiertos, setAbiertos] = useState([]);
  const [cotizaciones, setCotizaciones] = useState([]);
  const [proyecto, setProyecto] = useState(null);       // { nombre, cotizacion_id }
  const [texto, setTexto] = useState('');
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [faltantes, setFaltantes] = useState(null);

  useEffect(() => {
    get('/diserco/inventario').then(setProductos).catch((e) => setError(e.message));
    get('/diserco/salidas/proyectos').then((r) => { setAbiertos(r.en_curso); setCotizaciones(r.cotizaciones); }).catch(() => {});
  }, []);

  async function guardar(confirmar) {
    if (!proyecto || items.length === 0) return;
    setError(''); setGuardando(true);
    try { onCreada(await post('/diserco/salidas', { proyecto: proyecto.nombre.trim(), cotizacion_id: proyecto.cotizacion_id || null, items, confirmar_sin_stock: confirmar })); }
    catch (e) { if (e.codigo === 'SIN_STOCK') setFaltantes(e.faltantes ?? []); else setError(e.message); }
    finally { setGuardando(false); }
  }

  // Paso 1: ¿a qué proyecto va?
  if (!proyecto) {
    return (
      <div className="tarjeta rejilla">
        <div className="fila espacio"><h2>¿A qué proyecto va?</h2><button className="btn chico" onClick={onCancelar}>← Volver</button></div>
        {error && <div className="aviso-caja mal">{error}</div>}
        {abiertos.length > 0 && <small>PROYECTOS EN CURSO</small>}
        {abiertos.map((a) => <button key={a.nombre} className="btn" style={{ justifyContent: 'flex-start' }} onClick={() => setProyecto({ nombre: a.nombre, cotizacion_id: a.cotizacion_id })}>{a.nombre}</button>)}
        {cotizaciones.length > 0 && <small>COTIZACIONES DE PROYECTO APROBADAS</small>}
        {cotizaciones.slice(0, 10).map((c) => <button key={c.cotizacion_id} className="btn" style={{ justifyContent: 'flex-start' }} onClick={() => setProyecto({ nombre: c.nombre, cotizacion_id: c.cotizacion_id })}>{c.proyecto} <small>— {c.cliente}</small></button>)}
        <small>OTRO PROYECTO</small>
        <div className="fila">
          <input style={{ flex: 1 }} placeholder="Escribe el nombre del proyecto" value={texto} onChange={(e) => setTexto(e.target.value)} />
          <button className="btn primario" disabled={texto.trim().length < 3} onClick={() => setProyecto({ nombre: texto.trim(), cotizacion_id: '' })}>Seguir →</button>
        </div>
      </div>
    );
  }
  // Paso 2: sacar el material
  return (
    <div className="tarjeta rejilla">
      {faltantes && <AvisoSinStock faltantes={faltantes} accion="registrar la salida" onCancelar={() => setFaltantes(null)} onContinuar={() => { setFaltantes(null); guardar(true); }} />}
      <div className="fila espacio" style={{ padding: '8px 12px', borderRadius: 10, background: 'var(--panel-2)' }}>
        <div><small>Proyecto</small><strong style={{ display: 'block' }}>{proyecto.nombre}</strong></div>
        <button className="btn chico" onClick={() => { setProyecto(null); setItems([]); }}>Cambiar</button>
      </div>
      {error && <div className="aviso-caja mal" onClick={() => setError('')}>{error}</div>}
      <h3>Sacar material</h3>
      <SelectorProductos productos={productos} items={items} onCambiar={setItems} />
      <button className="btn primario dis-grande" disabled={guardando || items.length === 0} onClick={() => guardar(false)}>
        {guardando ? 'Registrando…' : items.length ? `REGISTRAR SALIDA (${items.reduce((s, i) => s + i.cantidad, 0)})` : 'Escribe la cantidad de lo que sacas'}
      </button>
    </div>
  );
}

function ResumenCierre({ r, verCostos }) {
  const consumibles = r.lineas.filter((l) => l.consumible);
  const noConsumibles = r.lineas.filter((l) => !l.consumible);
  return (
    <div style={{ marginTop: 12 }}>
      <h3>Resumen del proyecto</h3>
      {consumibles.length > 0 && (<>
        <strong>Material que se consumió</strong>
        <div className="tabla-wrap"><table>
          <thead><tr><th>Producto</th><th className="der">Salió</th><th className="der">Regresó</th><th className="der" style={{ color: 'var(--aviso)' }}>Consumido</th>{verCostos && <th className="der">Costo</th>}</tr></thead>
          <tbody>{consumibles.map((l) => <tr key={l.producto_id}><td>{l.producto}</td><td className="der num">{l.salio}</td><td className="der num">{l.regreso}</td><td className="der num" style={{ fontWeight: 800, color: 'var(--aviso)' }}>{l.consumido}</td>{verCostos && <td className="der num">{lempiras(l.costo)}</td>}</tr>)}</tbody>
        </table></div>
        {verCostos && r.costo_consumido != null && <p><strong>Costo del material consumido: {lempiras(r.costo_consumido)}</strong></p>}
      </>)}
      {noConsumibles.length > 0 && (<>
        <strong>Herramientas y moldes (deben regresar)</strong>
        <div className="tabla-wrap"><table>
          <thead><tr><th>Producto</th><th className="der">Salió</th><th className="der">Regresó</th><th className="der">Estado</th></tr></thead>
          <tbody>{noConsumibles.map((l) => <tr key={l.producto_id}><td>{l.producto}</td><td className="der num">{l.salio}</td><td className="der num">{l.regreso}</td><td className="der" style={{ fontWeight: 700, color: l.consumido > 0 ? 'var(--peligro)' : 'var(--ok)' }}>{l.consumido > 0 ? `faltan ${l.consumido}` : '✔ completo'}</td></tr>)}</tbody>
        </table></div>
      </>)}
    </div>
  );
}

function PorCerrar({ onElegir, onVolver }) {
  const [filas, setFilas] = useState(null);
  useEffect(() => { get('/diserco/salidas/por-cerrar').then(setFilas).catch(() => setFilas([])); }, []);
  return (
    <div className="tarjeta rejilla">
      <div className="fila espacio"><h2>¿Qué proyecto terminó?</h2><button className="btn chico" onClick={onVolver}>← Volver</button></div>
      <div className="dis-lista-proy">
        {(filas ?? []).map((f) => (
          <button key={f.id} className="btn" onClick={() => onElegir(f.id)}>
            <strong>{f.proyecto}</strong>
            <small style={{ display: 'block' }}>{f.productos} producto{f.productos === 1 ? '' : 's'} · {f.unidades} unidades fuera · desde {fechaCorta(f.desde)}</small>
          </button>
        ))}
        {filas && filas.length === 0 && <p className="vacio">No hay proyectos con material fuera.</p>}
        {!filas && <p className="vacio">Cargando…</p>}
      </div>
    </div>
  );
}

// Conteo físico al terminar: se ve lo que salió, se escribe lo que regresó, y el sistema cuadra.
function Recepcion({ id, verCostos, onVolver, onFin }) {
  const [d, setD] = useState(null);
  const [conteo, setConteo] = useState({});
  const [error, setError] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [intento, setIntento] = useState(false);
  useEffect(() => { get(`/diserco/salidas/${id}/recepcion`).then(setD).catch((e) => setError(e.message)); }, [id]);

  if (resultado) {
    return (
      <div className="tarjeta">
        <h2 style={{ color: 'var(--ok)' }}>✔ Proyecto terminado</h2>
        <p><strong>{resultado.proyecto}</strong></p>
        <ResumenCierre r={resultado} verCostos={verCostos} />
        <button className="btn primario dis-grande" style={{ marginTop: 14 }} onClick={onFin}>LISTO</button>
      </div>
    );
  }
  if (!d) return <div className="tarjeta">{error ? <div className="aviso-caja mal">{error}</div> : 'Cargando…'}<button className="btn chico" onClick={onVolver}>← Volver</button></div>;

  const falta = d.items.filter((i) => conteo[i.producto_id] === undefined || conteo[i.producto_id] === '');
  const pone = (pid, t) => setConteo({ ...conteo, [pid]: t === '' ? '' : String(Math.max(0, Math.round(Number(t)) || 0)) });
  const grupos = [['Se consumen al usarse', d.items.filter((i) => i.consumible)], ['Herramientas y moldes (deben regresar)', d.items.filter((i) => !i.consumible)]];

  async function terminar() {
    setIntento(true);
    if (falta.length) return;
    const gastado = d.items.filter((i) => Number(conteo[i.producto_id]) < i.salio).map((i) => `${i.nombre}: ${i.salio - Number(conteo[i.producto_id])} ${i.consumible ? 'consumidas' : 'NO regresan'}`);
    if (!window.confirm(`¿Terminar “${d.proyecto}”?\n\n${gastado.length ? gastado.join('\n') : 'Todo regresó completo.'}\n\nEsto no se puede deshacer.`)) return;
    setEnviando(true); setError('');
    try { setResultado(await post(`/diserco/salidas/${id}/cerrar`, { conteo: d.items.map((i) => ({ producto_id: i.producto_id, regreso: Number(conteo[i.producto_id]) })) })); }
    catch (e) { setError(e.message); } finally { setEnviando(false); }
  }

  return (
    <div className="tarjeta rejilla">
      <div className="fila espacio"><h2>Contar lo que regresó</h2><button className="btn chico" onClick={onVolver}>← Volver</button></div>
      <p><strong>{d.proyecto}</strong><small style={{ display: 'block' }}>Cuenta lo que físicamente regresó de cada producto (escribe 0 si no regresó nada).</small></p>
      {error && <div className="aviso-caja mal" onClick={() => setError('')}>{error}</div>}
      {grupos.map(([titulo, items]) => items.length > 0 && (
        <div key={titulo}>
          <small>{titulo.toUpperCase()}</small>
          <div className="dis-rec"><small>Producto</small><small className="centro">Salió</small><small className="centro">Regresó</small><span /></div>
          {items.map((i) => {
            const v = conteo[i.producto_id] ?? '';
            const sinContar = intento && v === '';
            return (
              <div key={i.producto_id} className="dis-rec" style={sinContar ? { background: 'var(--peligro-fondo)' } : undefined}>
                <div style={{ minWidth: 0, lineHeight: 1.2 }}>
                  <span style={{ fontWeight: 600 }}>{i.nombre}</span>
                  {Number(v) < i.salio && v !== '' && <small style={{ display: 'block', color: i.consumible ? 'var(--aviso)' : 'var(--peligro)' }}>{i.consumible ? `${i.salio - Number(v)} consumidas` : `faltan ${i.salio - Number(v)} por regresar`}</small>}
                </div>
                <strong className="centro" style={{ fontSize: '1.2rem' }}>{i.salio}</strong>
                <input className="dis-cant" style={{ width: '100%' }} type="number" inputMode="numeric" min="0" max={i.salio} step="1" placeholder="?" value={v} onChange={(e) => pone(i.producto_id, e.target.value)} aria-label={`Regresó de ${i.nombre}`} />
                <button className="btn chico" title="Regresó todo" onClick={() => pone(i.producto_id, i.salio)}>todo</button>
              </div>
            );
          })}
        </div>
      ))}
      <button className="btn primario dis-grande" disabled={enviando} onClick={terminar}>{enviando ? 'Guardando…' : falta.length ? `TERMINAR PROYECTO (faltan ${falta.length} por contar)` : 'TERMINAR PROYECTO'}</button>
    </div>
  );
}

function Historial({ id, refrescar }) {
  const [abierto, setAbierto] = useState(false);
  const [filas, setFilas] = useState(null);
  useEffect(() => { if (abierto) get(`/diserco/salidas/${id}/historial`).then(setFilas).catch(() => setFilas([])); }, [abierto, id, refrescar]);
  return (
    <div>
      <button className="btn chico" onClick={() => setAbierto(!abierto)}>{abierto ? '▾' : '▸'} Historial de movimientos</button>
      {abierto && (
        <div style={{ marginTop: 6, maxHeight: 260, overflowY: 'auto' }}>
          {(filas ?? []).map((h) => (
            <div key={h.clave} className="dis-hist">
              <span className="tenue" style={{ minWidth: 118 }}>{new Date(h.fecha).toLocaleString('es-HN', { timeZone: 'America/Tegucigalpa', dateStyle: 'short', timeStyle: 'short' })}</span>
              <span style={{ flex: 1, color: h.tipo === 'salida' ? 'var(--aviso)' : h.tipo === 'retorno' ? 'var(--ok)' : undefined }}>{h.texto}</span>
              <span className="tenue">{h.usuario}</span>
            </div>
          ))}
          {filas && filas.length === 0 && <small>Sin movimientos.</small>}
        </div>
      )}
    </div>
  );
}

function Detalle({ id, onVolver, onTerminar }) {
  const [s, setS] = useState(null);
  const [productos, setProductos] = useState([]);
  const [cant, setCant] = useState({});
  const [agregando, setAgregando] = useState(false);
  const [nuevos, setNuevos] = useState([]);
  const [faltantes, setFaltantes] = useState(null);
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);

  async function cargar() {
    setS(await get(`/diserco/salidas/${id}`));
    get('/diserco/inventario').then(setProductos).catch(() => {});
  }
  useEffect(() => { cargar().catch((e) => setError(e.message)); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function mover(items, confirmar = false) {
    setError(''); setOcupado(true);
    try {
      setS(await post(`/diserco/salidas/${id}/movimiento`, { items, confirmar_sin_stock: confirmar }));
      get('/diserco/inventario').then(setProductos).catch(() => {});
      return true;
    } catch (e) {
      if (e.codigo === 'SIN_STOCK') setFaltantes({ faltantes: e.faltantes ?? [], items }); else setError(e.message);
      return false;
    } finally { setOcupado(false); }
  }
  if (!s) return <div className="tarjeta">{error ? <div className="aviso-caja mal">{error}</div> : 'Cargando…'}</div>;
  const abierta = s.estado === 'abierta';
  const enBodega = new Map(productos.map((p) => [p.id, p.existencia]));
  const filas = s.items.filter((i) => i.pendiente > 0 || i.cantidad_salida > 0);

  return (
    <div className="tarjeta rejilla">
      {faltantes && <AvisoSinStock faltantes={faltantes.faltantes} accion="sacar el material" onCancelar={() => setFaltantes(null)} onContinuar={() => { const it = faltantes.items; setFaltantes(null); mover(it, true); }} />}
      <div className="fila espacio"><h2>{s.proyecto}</h2><button className="btn chico" onClick={onVolver}>← Volver</button></div>
      <p className="tenue">{abierta ? 'Material que está en este proyecto' : 'Proyecto terminado · material usado'} · desde {fechaCorta(s.created_at)}{s.cotizacion?.codigo ? ` · Cot. ${s.cotizacion.codigo}` : ''}</p>
      {error && <div className="aviso-caja mal" onClick={() => setError('')}>{error}</div>}
      <div>
        {filas.map((i) => {
          const c = Math.max(1, Number(cant[i.producto_id]) || 1);
          return (
            <div key={i.id} className="dis-fila-prod">
              <div className="nom"><span style={{ fontWeight: 600 }}>{i.productos?.nombre}</span>{abierta && <small style={{ display: 'block' }}>Bodega: {numero(enBodega.get(i.producto_id) ?? 0, 0)}</small>}</div>
              <div className="centro" style={{ minWidth: 54 }}><strong style={{ fontSize: '1.35rem', color: 'var(--aviso)' }}>{numero(i.pendiente, 0)}</strong><small style={{ display: 'block', fontSize: '.68rem' }}>{abierta ? 'en proyecto' : 'usadas'}</small></div>
              {abierta && (
                <div className="fila" style={{ gap: 4, flexWrap: 'nowrap' }}>
                  <button className="btn chico" disabled={ocupado || c > i.pendiente} title="Devolver a bodega" aria-label="Devolver" onClick={() => mover([{ producto_id: i.producto_id, cantidad: -c }])}>−</button>
                  <input className="dis-cant" style={{ width: 52 }} type="number" inputMode="numeric" min="1" step="1" value={cant[i.producto_id] ?? 1} onChange={(e) => setCant({ ...cant, [i.producto_id]: e.target.value })} />
                  <button className="btn chico primario" disabled={ocupado} title="Sacar más de la bodega" aria-label="Sacar más" onClick={() => mover([{ producto_id: i.producto_id, cantidad: c }])}>+</button>
                </div>
              )}
            </div>
          );
        })}
        {filas.length === 0 && <p className="vacio">Sin material.</p>}
      </div>
      {s.costo_total != null && <p><strong>Costo del material: {lempiras(s.costo_total)}</strong></p>}
      {!abierta && s.resumen && <ResumenCierre r={s.resumen} verCostos />}
      <Historial id={id} refrescar={s.items.length + s.unidades + (abierta ? 1 : 0)} />
      {abierta && (
        <div className="rejilla">
          <button className="btn primario dis-grande" onClick={() => { setNuevos([]); setAgregando(true); }}>+ AGREGAR OTRO PRODUCTO</button>
          <button className="btn bloque" onClick={onTerminar}>Recibir material y terminar proyecto</button>
        </div>
      )}
      {!abierta && <button className="btn" onClick={async () => { try { setS(await post(`/diserco/salidas/${id}/reabrir`, {})); } catch (e) { setError(e.message); } }}>Reabrir proyecto</button>}
      {agregando && (
        <Modal titulo="Agregar material" tam="ancho" onCerrar={() => setAgregando(false)}
          pie={<><button className="btn" onClick={() => setAgregando(false)}>Cancelar</button><button className="btn primario" disabled={!nuevos.length || ocupado} onClick={async () => { if (await mover(nuevos)) setAgregando(false); }}>SACAR DE BODEGA</button></>}>
          <SelectorProductos productos={productos} items={nuevos} onCambiar={setNuevos} />
        </Modal>
      )}
    </div>
  );
}
