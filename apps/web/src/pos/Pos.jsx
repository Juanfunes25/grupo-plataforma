import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { calcularTotales, lempiras, horaHN } from '@grupo/shared';
import { get, patch, post, put, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Cargando, ErrorCaja, Modal, useAccion, useAviso } from '../ui/kit.jsx';
import Icono from '../ui/Icono.jsx';
import OpcionesModal from './OpcionesModal.jsx';
import PesoModal from './PesoModal.jsx';
import CobroModal from './CobroModal.jsx';
import ClienteModal from './ClienteModal.jsx';
import AbiertasModal from './AbiertasModal.jsx';
import { AbrirTurno, CerrarTurno, MovimientoCaja } from './TurnoPanel.jsx';

let contador = 0;
const nuevaLinea = (producto, extra = {}) => ({ key: ++contador, producto, cantidad: 1, opciones: [], notas: null, descuento_porcentaje: 0, ...extra });
const vacio = () => ({ id: null, ticket: null, nombre_orden: '', tipo_orden: 'aqui', cliente: null, lineas: [] });
const cacheKey = (e, s) => `grupo.catalogo.${e}.${s}`;

export default function Pos() {
  const { contexto, sucursal, puede } = useSesion();
  const avisar = useAviso();
  const [ejecutar, ocupado] = useAccion();
  const [cat, setCat] = useState(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState('');
  const [turno, setTurno] = useState(undefined);       // undefined = cargando, null = sin turno
  const [resumenTurno, setResumenTurno] = useState(null);
  const [orden, setOrden] = useState(vacio);
  const [catActiva, setCatActiva] = useState('todas');
  const [busca, setBusca] = useState('');
  const [agotados, setAgotados] = useState(false);
  const [modal, setModal] = useState(null);            // {tipo, ...}
  const [recibo, setRecibo] = useState(null);
  const [ticket, setTicket] = useState(null);
  const [errCobro, setErrCobro] = useState('');
  const [abiertas, setAbiertas] = useState(0);

  const empresa = contexto.empresa.codigo;

  const cargarCatalogo = useCallback(async () => {
    try { const c = await get('/pos/catalogo'); setCat(c); setOffline(false); try { localStorage.setItem(cacheKey(empresa, 'cat'), JSON.stringify(c)); } catch { /* */ } }
    catch (e) {
      let c = null; try { c = JSON.parse(localStorage.getItem(cacheKey(empresa, 'cat'))); } catch { /* */ }
      if (c) { setCat(c); setOffline(true); } else setError(e.message);
    }
  }, [empresa]);
  const cargarTurno = useCallback(async () => {
    if (!sucursal) return;
    try { const r = await get(`/pos/turno/actual${qs({ sucursal_id: sucursal.id })}`); setTurno(r.turno); setResumenTurno(r.resumen ?? null); }
    catch (e) { setError(e.message); setTurno(null); }
  }, [sucursal]);
  const contarAbiertas = useCallback(async () => {
    if (!sucursal) return;
    try { setAbiertas((await get(`/pos/ventas${qs({ estado: 'abierta', sucursal_id: sucursal.id })}`)).length); } catch { /* */ }
  }, [sucursal]);

  useEffect(() => { cargarCatalogo(); }, [cargarCatalogo]);
  useEffect(() => { setTurno(undefined); cargarTurno(); contarAbiertas(); }, [cargarTurno, contarAbiertas]);

  // ── Cálculo en vivo (el servidor recalcula con precios de la base al guardar) ──
  const totales = useMemo(() => calcularTotales(
    orden.lineas.map((l) => ({
      producto_id: l.producto.id, nombre_producto: l.producto.nombre, cantidad: l.cantidad, precio_base: Number(l.producto.precio),
      extras: l.opciones.reduce((s, o) => s + o.precio_extra, 0), impuesto_tasa: Number(l.producto.impuesto_tasa), exento: l.producto.exento,
      descuento_porcentaje: l.descuento_porcentaje,
    })), orden.cliente, 0), [orden.lineas, orden.cliente]);

  const gruposDe = (p) => (cat?.grupos ?? []).filter((g) => p.grupo_ids.includes(g.id));
  const productos = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return (cat?.productos ?? []).filter((p) => (catActiva === 'todas' || p.categoria_id === catActiva) && (!q || p.nombre.toLowerCase().includes(q) || (p.codigo ?? '').toLowerCase() === q));
  }, [cat, catActiva, busca]);

  // ── Agregar producto ─────────────────────────────────────────────────────
  const agregar = useCallback((p, extra) => {
    setOrden((o) => {
      if (!extra && p.unidad === 'unidad') {
        const i = o.lineas.findIndex((l) => l.producto.id === p.id && !l.opciones.length && !l.notas && !l.descuento_porcentaje);
        if (i >= 0) return { ...o, lineas: o.lineas.map((l, j) => (j === i ? { ...l, cantidad: l.cantidad + 1 } : l)) };
      }
      return { ...o, lineas: [...o.lineas, nuevaLinea(p, extra)] };
    });
  }, []);
  const tocar = (p) => {
    if (agotados) {
      ejecutar(async () => { await patch(`/pos/catalogo/productos/${p.id}/disponible`, { disponible: !p.disponible }); await cargarCatalogo(); }, p.disponible ? `${p.nombre}: marcado como agotado` : `${p.nombre}: disponible de nuevo`);
      return;
    }
    if (!p.disponible) { avisar(`${p.nombre} está agotado`, 'mal'); return; }
    // Con grupos OBLIGATORIOS (ej. tamaño) se pregunta; si todo es opcional se agrega directo y los extras se piden tocando la línea.
    if (gruposDe(p).some((g) => g.min_sel > 0)) setModal({ tipo: 'opciones', producto: p });
    else if (p.unidad !== 'unidad') setModal({ tipo: 'peso', producto: p });
    else agregar(p);
  };

  // Lector de código de barras (teclado virtual rápido + Enter)
  const buffer = useRef({ txt: '', t: 0 });
  useEffect(() => {
    const f = (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || modal) return;
      const ahora = Date.now();
      if (ahora - buffer.current.t > 80) buffer.current.txt = '';
      buffer.current.t = ahora;
      if (e.key === 'Enter') {
        const code = buffer.current.txt; buffer.current.txt = '';
        const p = code.length >= 3 && cat?.productos.find((x) => x.codigo_barras === code || x.codigo === code);
        if (p) tocar(p);
      } else if (e.key.length === 1) buffer.current.txt += e.key;
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const cuerpoItems = () => orden.lineas.map((l) => ({ producto_id: l.producto.id, cantidad: l.cantidad, opciones: l.opciones.map((o) => o.id), notas: l.notas, descuento_porcentaje: l.descuento_porcentaje }));
  const cambiarCant = (key, d) => setOrden((o) => ({ ...o, lineas: o.lineas.flatMap((l) => (l.key !== key ? [l] : l.cantidad + d > 0 || l.producto.unidad !== 'unidad' ? [{ ...l, cantidad: Math.round((l.cantidad + d) * 1000) / 1000 }] : [])).filter((l) => l.cantidad > 0) }));
  const quitar = (key) => setOrden((o) => ({ ...o, lineas: o.lineas.filter((l) => l.key !== key) }));
  const ciclarDescuento = (key) => setOrden((o) => ({ ...o, lineas: o.lineas.map((l) => (l.key === key ? { ...l, descuento_porcentaje: l.descuento_porcentaje === 0 ? 10 : l.descuento_porcentaje === 10 ? 25 : 0 } : l)) }));

  const base = () => ({ sucursal_id: sucursal.id, tipo_orden: orden.tipo_orden, nombre_orden: orden.nombre_orden || null, cliente_id: orden.cliente?.id ?? null, items: cuerpoItems() });

  // ── Guardar / cobrar / cargar abiertas ──────────────────────────────────
  const guardarOrden = async () => {
    const r = await ejecutar(() => (orden.id ? put(`/pos/ventas/${orden.id}`, base()) : post('/pos/ventas', base())));
    if (r && r !== true) { avisar(`Orden #${r.ticket_dia} guardada`); setOrden(vacio()); contarAbiertas(); }
  };
  const descartar = async () => {
    if (orden.id) await ejecutar(() => post(`/pos/ventas/${orden.id}/anular`, { motivo: 'Orden descartada' }));
    setOrden(vacio()); contarAbiertas();
  };
  const cobrar = async (pagos) => {
    setErrCobro('');
    const r = await ejecutar(async () => {
      try {
        if (orden.id) { await put(`/pos/ventas/${orden.id}`, base()); return await post(`/pos/ventas/${orden.id}/cobrar`, { pagos }); }
        return await post('/pos/ventas', { ...base(), cobrar: { pagos } });
      } catch (e) { setErrCobro(e.message); throw e; }
    });
    if (r && r !== true) { setModal(null); setRecibo(r); setOrden(vacio()); cargarTurno(); contarAbiertas(); }
  };
  const abrirOrden = async (id) => {
    const v = await ejecutar(() => get(`/pos/ventas/${id}`));
    if (!v || v === true) return;
    const porId = new Map(cat.productos.map((p) => [p.id, p]));
    setOrden({
      id: v.id, ticket: v.ticket_dia, nombre_orden: v.nombre_orden ?? '', tipo_orden: v.tipo_orden, cliente: v.cliente?.nombre === 'Consumidor Final' ? null : v.cliente,
      lineas: v.lineas.filter((l) => porId.has(l.producto_id)).map((l) => nuevaLinea(porId.get(l.producto_id), { cantidad: l.cantidad, opciones: l.opciones, notas: l.notas, descuento_porcentaje: l.descuento_porcentaje })),
    });
    setModal(null);
  };

  const imprimir = async (id, reimpresion = false) => {
    const r = await ejecutar(() => get(`/pos/ventas/${id}/ticket${qs({ reimpresion: reimpresion ? 'true' : '' })}`));
    if (r && r !== true) setTicket(r.lineas);
  };
  useEffect(() => { if (ticket) { const t = setTimeout(() => { window.print(); setTicket(null); }, 150); return () => clearTimeout(t); } }, [ticket]);

  if (error && !cat) return <div className="pagina"><ErrorCaja error={error} /></div>;
  if (!cat || !sucursal || turno === undefined) return <Cargando texto="Preparando la caja…" />;
  if (!turno) return <AbrirTurno sucursal={sucursal} puede={puede('pos:caja')} onAbierto={cargarTurno} />;

  const fiscal = cat.fiscal[sucursal.id];
  const hayLineas = orden.lineas.length > 0;
  const catsConProductos = cat.categorias;

  return (
    <div className="pos">
      <div className="pos-izq">
        <div className="pos-barra">
          <div className="fila" style={{ gap: 6 }}>
            <span className="chip ok">Turno {horaHN(turno.abierto_at)}</span>
            {fiscal?.borrador && <span className="chip aviso" title="Sin CAI real: las facturas no tienen validez fiscal">Modo borrador</span>}
            {fiscal && !fiscal.borrador && fiscal.restantes <= 50 && <span className="chip mal">Quedan {fiscal.restantes} facturas</span>}
            {offline && <span className="chip mal">Sin conexión · catálogo guardado</span>}
          </div>
          <span className="sep" style={{ flex: 1 }} />
          <button className="btn chico" onClick={() => setModal({ tipo: 'abiertas' })}>Abiertas{abiertas > 0 && <span className="chip aviso">{abiertas}</span>}</button>
          {puede('pos:catalogo') || puede('pos:vender') ? <button className="btn chico" aria-pressed={agotados} onClick={() => setAgotados((a) => !a)} style={agotados ? { background: 'var(--aviso-fondo)', borderColor: 'var(--aviso)' } : undefined}>{agotados ? 'Terminar “agotados”' : 'Marcar agotados'}</button> : null}
          <button className="btn chico" onClick={() => setModal({ tipo: 'movimiento' })}>Movimiento</button>
          <button className="btn chico peligro" onClick={() => setModal({ tipo: 'cerrar' })}>Cerrar turno</button>
        </div>

        <div className="pos-cats">
          <button className={catActiva === 'todas' ? 'on' : ''} onClick={() => setCatActiva('todas')}>Todo</button>
          {catsConProductos.map((c) => <button key={c.id} className={catActiva === c.id ? 'on' : ''} onClick={() => setCatActiva(c.id)} style={{ '--cc': c.color || 'var(--acento)' }}>{c.nombre}</button>)}
          <input className="pos-buscar" placeholder="Buscar…" value={busca} onChange={(e) => setBusca(e.target.value)} />
        </div>
        {agotados && <div className="aviso-caja" style={{ margin: '0 0 8px' }}>Toca un producto para marcarlo agotado (o disponible de nuevo).</div>}
        <div className="pos-grid">
          {productos.map((p) => {
            const c = cat.categorias.find((x) => x.id === p.categoria_id)?.color;
            return (
              <button key={p.id} className={`pos-prod ${p.disponible ? '' : 'agotado'}`} style={{ '--cc': c || 'var(--acento)' }} onClick={() => tocar(p)}>
                <span className="pn">{p.nombre}</span>
                <span className="pp">{lempiras(p.precio)}{p.unidad !== 'unidad' ? ` / ${p.unidad}` : ''}</span>
                {!p.disponible && <span className="chip mal">Agotado</span>}
                {p.disponible && p.grupo_ids.length > 0 && <span className="pm">+ opciones</span>}
              </button>
            );
          })}
          {productos.length === 0 && <div className="vacio" style={{ gridColumn: '1/-1' }}>{cat.productos.length === 0 ? 'Aún no hay productos. Agrégalos en Catálogo.' : 'Sin resultados.'}</div>}
        </div>
      </div>

      <aside className="pos-der" aria-label="Orden actual">
        <div className="pos-cab">
          <b className="titulo" style={{ fontSize: '1.2rem' }}>{orden.id ? `Orden #${orden.ticket}` : 'Nueva orden'}</b>
          <div className="fila" style={{ gap: 6 }}>
            <button className="btn chico" onClick={() => setOrden((o) => ({ ...o, tipo_orden: o.tipo_orden === 'aqui' ? 'llevar' : 'aqui' }))}>{orden.tipo_orden === 'aqui' ? 'Aquí' : 'Para llevar'}</button>
            <button className="btn chico" onClick={() => setModal({ tipo: 'cliente' })}>{orden.cliente ? orden.cliente.nombre.slice(0, 16) : 'Consumidor final'}</button>
          </div>
        </div>
        <input placeholder="Nombre para llamar (opcional)" value={orden.nombre_orden} onChange={(e) => setOrden((o) => ({ ...o, nombre_orden: e.target.value }))} maxLength={60} />
        <div className="pos-lineas">
          {!hayLineas && <div className="vacio">Toca un producto para empezar.</div>}
          {orden.lineas.map((l, i) => {
            const t = totales.lineas[i];
            return (
              <div className="pos-linea" key={l.key}>
                <div className="pl-cant">
                  <button onClick={() => cambiarCant(l.key, l.producto.unidad === 'unidad' ? 1 : 0)} aria-label="Más" disabled={l.producto.unidad !== 'unidad'}>+</button>
                  <b className="num">{l.cantidad}</b>
                  <button onClick={() => cambiarCant(l.key, -1)} aria-label="Menos" disabled={l.producto.unidad !== 'unidad'}>−</button>
                </div>
                <div className="pl-info" onClick={() => l.producto.grupo_ids.length && setModal({ tipo: 'opciones', producto: l.producto, editar: l })}>
                  <b>{l.producto.nombre}</b>{l.producto.unidad !== 'unidad' && <small> ({l.producto.unidad})</small>}
                  {l.opciones.map((o) => <small key={o.id} className="tenue" style={{ display: 'block' }}>+ {o.nombre}</small>)}
                  {!l.opciones.length && l.producto.grupo_ids.length > 0 && <small className="tenue" style={{ display: 'block', opacity: .7 }}>Toca para extras</small>}
                  {l.notas && <small style={{ display: 'block', color: 'var(--aviso)' }}>“{l.notas}”</small>}
                  {l.descuento_porcentaje > 0 && <small style={{ display: 'block', color: 'var(--ok)' }}>Descuento {l.descuento_porcentaje}%</small>}
                </div>
                <div className="pl-monto"><b className="num">{lempiras(t.monto)}</b>
                  <div className="fila" style={{ gap: 4, justifyContent: 'flex-end' }}>
                    {puede('pos:descuento') && <button className="btn chico fantasma" onClick={() => ciclarDescuento(l.key)} title="Descuento 10% / 25% (3ª edad)">%</button>}
                    <button className="btn chico fantasma" onClick={() => quitar(l.key)} aria-label="Quitar"><Icono n="borrar" tam={15} /></button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="pos-tot">
          {totales.descuento > 0 && <div className="fila espacio"><small>Descuentos</small><small className="num">−{lempiras(totales.descuento)}</small></div>}
          <div className="fila espacio"><small>ISV incluido</small><small className="num">{lempiras(totales.isv_total)}</small></div>
          <div className="fila espacio"><span className="titulo" style={{ fontSize: '1.2rem' }}>Total</span><b className="num pos-total">{lempiras(totales.total)}</b></div>
        </div>
        <div className="pos-acciones">
          <button className="btn grande primario" disabled={!hayLineas || ocupado} onClick={() => { setErrCobro(''); setModal({ tipo: 'cobro' }); }}>Cobrar</button>
          <div className="fila" style={{ flexWrap: 'nowrap' }}>
            <button className="btn bloque" disabled={!hayLineas || ocupado} onClick={guardarOrden}>Guardar</button>
            <button className="btn bloque peligro" disabled={!hayLineas && !orden.id} onClick={descartar}>Descartar</button>
          </div>
        </div>
      </aside>

      {modal?.tipo === 'opciones' && (
        <OpcionesModal producto={modal.producto} grupos={gruposDe(modal.producto)} inicial={modal.editar} onCerrar={() => setModal(null)}
          onListo={(r) => {
            if (modal.editar) setOrden((o) => ({ ...o, lineas: o.lineas.map((l) => (l.key === modal.editar.key ? { ...l, opciones: r.opciones, notas: r.notas, cantidad: r.cantidad } : l)) }));
            else agregar(modal.producto, { opciones: r.opciones, notas: r.notas, cantidad: r.cantidad });
            setModal(null);
          }} />
      )}
      {modal?.tipo === 'peso' && <PesoModal producto={modal.producto} onCerrar={() => setModal(null)} onListo={(n) => { agregar(modal.producto, { cantidad: n }); setModal(null); }} />}
      {modal?.tipo === 'cliente' && <ClienteModal puedeCrear={puede('clientes:editar')} onCerrar={() => setModal(null)} onElegir={(c) => { setOrden((o) => ({ ...o, cliente: c })); setModal(null); }} />}
      {modal?.tipo === 'abiertas' && <AbiertasModal sucursalId={sucursal.id} onCerrar={() => setModal(null)} onElegir={abrirOrden} />}
      {modal?.tipo === 'movimiento' && <MovimientoCaja sucursal={sucursal} onCerrar={() => setModal(null)} onListo={() => { setModal(null); cargarTurno(); }} />}
      {modal?.tipo === 'cerrar' && <CerrarTurno sucursal={sucursal} turno={turno} resumen={resumenTurno} onCerrar={() => setModal(null)} onCerrado={() => { setModal(null); setTurno(null); setOrden(vacio()); cargarTurno(); }} />}
      {modal?.tipo === 'cobro' && <CobroModal total={totales.total} formas={cat.formas_pago} cliente={orden.cliente} ocupado={ocupado} error={errCobro} onCerrar={() => setModal(null)} onCobrar={cobrar} />}

      {recibo && (
        <Modal titulo="Venta cobrada" onCerrar={() => setRecibo(null)} tam="angosto"
          pie={<><button className="btn" onClick={() => imprimir(recibo.id)}><Icono n="impresora" tam={16} /> Imprimir</button><button className="btn primario grande" onClick={() => setRecibo(null)}>Nueva venta</button></>}>
          <div className="centro" style={{ display: 'grid', gap: 6 }}>
            <div className="kpi acento"><div className="etq">Total</div><div className="val">{lempiras(recibo.total)}</div></div>
            {recibo.cambio > 0 && <div className="kpi" style={{ borderColor: 'var(--ok)' }}><div className="etq">Cambio a entregar</div><div className="val" style={{ color: 'var(--ok)', fontSize: '3rem' }}>{lempiras(recibo.cambio)}</div></div>}
            <small>Orden #{recibo.ticket_dia}{recibo.nombre_orden ? ` · ${recibo.nombre_orden}` : ''}</small>
            <small className="num">{recibo.numero_factura}</small>
            {recibo.es_borrador_fiscal && <span className="chip aviso" style={{ justifySelf: 'center' }}>Sin validez fiscal (CAI pendiente)</span>}
          </div>
        </Modal>
      )}
      {ticket && <pre className="ticket-print">{ticket.join('\n')}</pre>}
    </div>
  );
}
