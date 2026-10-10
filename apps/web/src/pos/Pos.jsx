import AvisoRecepcion from '../rep/AvisoRecepcion.jsx';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AvisoSinStock from '../eco/AvisoSinStock.jsx';
import { MOTIVOS_DESCARTE, MOTIVOS_REIMPRESION, OPCIONES_DESCUENTO, UMBRAL_RTN_OBLIGATORIO, calcularTotales, formatearTicketProvisional, identidadValida, lempiras, nombreCortoSucursal, requiereRtn as faltaRtn, uuidCliente } from '@grupo/shared';
import { get, patch, post, put, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Cargando, ErrorCaja, Modal, useAccion, useAviso, vibrar } from '../ui/kit.jsx';
import Icono from '../ui/Icono.jsx';
import { colorSucursal } from '../lib/coloresSucursal.js';
import { imprimirLineas, imprimirTicket, leerConfigImpresora, verPdf } from '../lib/documentos.js';
import { registrarEvento } from '../lib/eventos.js';
import { useCambiosVentas, useCatalogoVivo } from '../lib/enVivo.js';
import OpcionesModal from './OpcionesModal.jsx';
import PesoModal from './PesoModal.jsx';
import CantidadModal from './CantidadModal.jsx';
import CobroModal from './CobroModal.jsx';
import CobroEfectivoModal from './CobroEfectivoModal.jsx';
import ClienteModal from './ClienteModal.jsx';
import AbiertasModal from './AbiertasModal.jsx';
import MotivoModal from './MotivoModal.jsx';
import AyudaAtajos from './AyudaAtajos.jsx';
import ColaModal from './ColaModal.jsx';
import { ATAJOS } from './atajos.js';
import { cola, codigoCaja, sincronizarAhora, useResumenCola } from './colaLocal.js';
import { CerrarTurno, MovimientoCaja } from './TurnoPanel.jsx';
import './pos.css';
import './pos-mostrador.css';

let contador = 0;
const nuevaLinea = (producto, extra = {}) => ({ key: ++contador, producto, cantidad: 1, opciones: [], notas: null, descuento_porcentaje: 0, ...extra });
const vacio = () => ({ id: null, ticket: null, nombre_orden: '', tipo_orden: null, cliente: null, tercera_edad: { nombre: '', identidad: '' }, nota: '', lineas: [] });
const cacheKey = (e, s) => `grupo.catalogo.${e}.${s}`;
const normalizar = (t) => String(t ?? '').trim().toLowerCase();
const redondear = (n) => Math.round(n * 100) / 100;
// «3*jugo» = 3 unidades de «jugo»: se separa la cantidad del texto que se busca.
const partirBusqueda = (txt) => { const m = /^\s*(\d{1,3})\s*[*xX]\s*(\S.*)$/.exec(String(txt ?? '')); return m ? { n: Math.min(999, Number(m[1])), texto: m[2] } : { n: 1, texto: String(txt ?? '') }; };
const esCampo = (el) => Boolean(el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable));
const MSG_SIN_TARJETA = 'Sin conexión solo se puede cobrar en efectivo: la tarjeta y la transferencia necesitan validarse en el momento.';

// Un lector de código de barras "teclea" el código muy rápido y termina con Enter. Se busca primero coincidencia EXACTA de
// código de barras o código interno: así el escaneo nunca agrega un producto parecido por error.
const buscarPorCodigo = (productos, codigo) => {
  const c = normalizar(codigo);
  if (!c) return null;
  return productos.find((p) => normalizar(p.codigo_barras) === c) ?? productos.find((p) => normalizar(p.codigo) === c) ?? null;
};

// Cuadrícula de productos. Memorizada: agregar a la orden, el aviso «+ producto» o el autoguardado vuelven a dibujar la orden,
// pero NO los cientos de botones del catálogo (en un teléfono de gama baja eso era lo que hacía sentir lenta la caja).
const Ficha = memo(function Ficha({ p, color, resaltado, modoEdicion, onTocar }) {
  return (
    <button className={`pos-prod ${p.disponible ? '' : 'agotado'}${resaltado ? ' primero' : ''}${modoEdicion ? ' editando' : ''}`} style={{ '--cc': color || 'var(--acento)' }} onClick={() => onTocar(p)}>
      {p.favorito && <span className="pos-estrella" aria-label="Favorito">★</span>}
      {modoEdicion === 'favorito' && !p.favorito && <span className="pos-estrella vacia" aria-hidden="true">☆</span>}
      <span className="pn">{p.nombre}</span>
      <span className="pp">{lempiras(p.precio)}{p.unidad !== 'unidad' ? ` / ${p.unidad}` : p.unidad_venta ? ` / ${p.unidad_venta === 'm2' ? 'm²' : p.unidad_venta}` : ''}</span>
      {!p.disponible && <span className="chip mal">Agotado</span>}
      {p.disponible && p.grupo_ids.length > 0 && <span className="pm">+ opciones</span>}
    </button>
  );
});

const Grilla = memo(function Grilla({ secciones, colores, resaltadoId, modoEdicion, onTocar }) {
  return secciones.map((s) => (s.prods.length > 0 || s.id === 'todos') && (
    <section key={s.id} className="pos-seccion">
      {s.titulo && <h3 className="pos-seccion-titulo">{s.titulo}</h3>}
      <div className="pos-grid">{s.prods.map((p) => <Ficha key={p.id} p={p} color={colores.get(p.categoria_id)} resaltado={s.id === 'busqueda' && resaltadoId === p.id} modoEdicion={modoEdicion} onTocar={onTocar} />)}</div>
    </section>
  ));
});

const leerCatalogoGuardado = (empresa) => { try { return JSON.parse(localStorage.getItem(cacheKey(empresa, 'cat')) || 'null'); } catch { return null; } };

export default function Pos() {
  const { contexto, sucursal, puede, modulos, elegirSucursal, usuario } = useSesion();
  const avisar = useAviso();
  const [ejecutar, ocupado] = useAccion();
  const resumenCola = useResumenCola();
  // La caja abre al instante con el catálogo guardado en este equipo y se actualiza en cuanto responde el servidor
  // (que de todos modos recalcula los precios al guardar y al cobrar).
  const [cat, setCat] = useState(() => leerCatalogoGuardado(contexto?.empresa?.codigo));
  const [offline, setOffline] = useState(false);       // el servidor no responde: se trabaja con el catálogo guardado y las ventas van a la cola
  const [enLinea, setEnLinea] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [error, setError] = useState('');
  const [verOrden, setVerOrden] = useState(false);       // solo pantallas angostas: la orden se abre sobre el catálogo
  const [turno, setTurno] = useState(undefined);       // undefined = cargando, null = sin turno (se abre solo al primer cobro)
  const [resumenTurno, setResumenTurno] = useState(null);
  const [orden, setOrden] = useState(vacio);
  const [catActiva, setCatActiva] = useState('todas');
  const [busca, setBusca] = useState('');
  const [modoEdicion, setModoEdicion] = useState(null);  // null | 'favorito' (encargados)
  const [modal, setModal] = useState(null);            // {tipo, ...}
  const [recibo, setRecibo] = useState(null);
  const [errCobro, setErrCobro] = useState('');
  const [cobrando, setCobrando] = useState(false);
  const [abiertas, setAbiertas] = useState(0);
  const [toast, setToast] = useState('');
  const [avisoStock, setAvisoStock] = useState(null);   // fábricas: faltan existencias, pide confirmación
  const [puedeDeshacer, setPuedeDeshacer] = useState(false);

  const empresa = contexto.empresa.codigo;
  const sinRed = !enLinea || offline;

  // Referencias: el autoguardado corre en un temporizador, así que lee SIEMPRE lo último desde aquí (no del estado de su cierre).
  const ordenRef = useRef(orden); ordenRef.current = orden;
  const sucursalRef = useRef(sucursal); sucursalRef.current = sucursal;
  const catRef = useRef(cat); catRef.current = cat;
  const sinRedRef = useRef(sinRed); sinRedRef.current = sinRed;
  const ventaIdRef = useRef(null);
  const idCobroRef = useRef(null);                    // id de esta venta: el mismo en el cobro normal y en el reintento sin conexión (jamás se factura dos veces)
  const colaRef = useRef(Promise.resolve());
  const descartadaRef = useRef(false);
  const timerRef = useRef(null);
  const pendienteRef = useRef(false);
  const omitirGuardadoRef = useRef(false);
  const ultimaRef = useRef(null);
  const buscadorRef = useRef(null);
  const toastRef = useRef(null);
  // Historial para «Deshacer» (Ctrl+Z): fotos anteriores de las líneas de ESTA orden.
  const histRef = useRef([]);
  const prevLineasRef = useRef(orden.lineas);
  const reinicioHistRef = useRef(false);
  const deshaciendoRef = useRef(false);

  const mostrarToast = (t) => { setToast(t); clearTimeout(toastRef.current); toastRef.current = setTimeout(() => setToast(''), 1400); };

  // ── Carga de datos ──────────────────────────────────────────────────────
  const cargarCatalogo = useCallback(async () => {
    try { const c = await get('/pos/catalogo'); setCat(c); setOffline(false); try { localStorage.setItem(cacheKey(empresa, 'cat'), JSON.stringify(c)); } catch { /* */ } }
    catch (e) {
      const c = leerCatalogoGuardado(empresa);
      if (c) { setCat(c); setOffline(true); } else setError(e.message);
    }
  }, [empresa]);
  const cargarTurno = useCallback(async () => {
    if (!sucursal) return;
    try { const r = await get(`/pos/turno/actual${qs({ sucursal_id: sucursal.id })}`); setTurno(r.turno); setResumenTurno(r.resumen ?? null); }
    catch { setTurno((t) => (t === undefined ? null : t)); }
  }, [sucursal]);
  const contarAbiertas = useCallback(async () => {
    if (!sucursal) return;
    try { setAbiertas((await get(`/pos/ventas${qs({ estado: 'abierta', sucursal_id: sucursal.id })}`)).length); } catch { /* */ }
  }, [sucursal]);

  useEffect(() => { cargarCatalogo(); }, [cargarCatalogo]);
  useEffect(() => { setTurno(undefined); cargarTurno(); contarAbiertas(); }, [cargarTurno, contarAbiertas]);
  useEffect(() => { buscadorRef.current?.focus(); }, [cat === null]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Sincronización en vivo (consulta liviana cada pocos segundos): un precio nuevo o un "se acabó" marcado en otra caja aparece solo,
  // igual que una orden guardada o cobrada en otra caja.
  useCatalogoVivo(cargarCatalogo, { activo: !offline });
  useCambiosVentas(sucursal?.id, contarAbiertas, { cada: 8000, activo: Boolean(sucursal) && !offline });
  // Sin conexión: cada 10 s se vuelve a preguntar al servidor; en cuanto contesta se sale solo del modo local.
  useEffect(() => {
    if (!offline) return undefined;
    const id = setInterval(() => { cargarCatalogo(); }, 10_000);
    return () => clearInterval(id);
  }, [offline, cargarCatalogo]);

  useEffect(() => {
    const on = () => { setEnLinea(true); cargarCatalogo(); cargarTurno(); if (ordenRef.current.lineas.length) guardarEnCola().catch(() => {}); };
    const off = () => setEnLinea(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Bloqueo de cambio de sucursal con una orden en curso: el selector vive en el menú lateral; si lo mueven con productos en pantalla,
  // se devuelve a la sucursal de la orden y se avisa (una orden no puede pasar de una sucursal a otra).
  const sucPrevia = useRef(sucursal?.id);
  useEffect(() => {
    const nueva = sucursal?.id;
    if (sucPrevia.current && nueva && nueva !== sucPrevia.current && ordenRef.current.lineas.length > 0) {
      avisar('Hay una orden en curso: termínala, guárdala o descártala antes de cambiar de sucursal.', 'mal');
      elegirSucursal(sucPrevia.current);
      return;
    }
    if (nueva !== sucPrevia.current) { ventaIdRef.current = null; idCobroRef.current = null; reinicioHistRef.current = true; setOrden(vacio()); setAbiertas(0); }
    sucPrevia.current = nueva;
  }, [sucursal?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Cálculo en vivo (el servidor recalcula con precios de la base al guardar) ──
  const totales = useMemo(() => calcularTotales(
    orden.lineas.map((l) => ({
      producto_id: l.producto.id, nombre_producto: l.producto.nombre, cantidad: l.cantidad, precio_base: Number(l.producto.precio),
      extras: l.opciones.reduce((s, o) => s + o.precio_extra, 0), impuesto_tasa: Number(l.producto.impuesto_tasa), exento: l.producto.exento,
      descuento_porcentaje: l.descuento_porcentaje,
    })), orden.cliente, 0), [orden.lineas, orden.cliente]);

  const gruposDe = (p) => (cat?.grupos ?? []).filter((g) => p.grupo_ids.includes(g.id));

  // Vista del catálogo: buscando → coincidencias; «Todo» → Favoritos y Más vendidos arriba y luego todo; una categoría → sus productos.
  const vista = useMemo(() => {
    const todos = cat?.productos ?? [];
    const q = normalizar(partirBusqueda(busca).texto);
    const porId = new Map(todos.map((p) => [p.id, p]));
    const favoritos = todos.filter((p) => p.favorito);
    const masIds = (cat?.mas_vendidos ?? []).filter((id) => porId.has(id));
    const mas = masIds.map((id) => porId.get(id));
    if (q) return { secciones: [{ id: 'busqueda', titulo: null, prods: todos.filter((p) => normalizar(p.nombre).includes(q) || normalizar(p.codigo).includes(q) || normalizar(p.codigo_barras).includes(q)) }], favoritos, mas };
    if (catActiva === 'fav') return { secciones: [{ id: 'fav', titulo: null, prods: favoritos }], favoritos, mas };
    if (catActiva === 'mas') return { secciones: [{ id: 'mas', titulo: null, prods: mas }], favoritos, mas };
    if (catActiva === 'todas') {
      const masSinFav = mas.filter((p) => !p.favorito);
      const conArriba = favoritos.length > 0 || masSinFav.length > 0;
      return { secciones: [
        ...(favoritos.length ? [{ id: 'fav', titulo: '★ Favoritos', prods: favoritos }] : []),
        ...(masSinFav.length ? [{ id: 'mas', titulo: 'Más vendidos', prods: masSinFav }] : []),
        { id: 'todos', titulo: conArriba ? 'Todos los productos' : null, prods: todos },
      ], favoritos, mas };
    }
    return { secciones: [{ id: 'cat', titulo: null, prods: todos.filter((p) => p.categoria_id === catActiva) }], favoritos, mas };
  }, [cat, catActiva, busca]);
  const hayResultados = vista.secciones.some((s) => s.prods.length > 0);
  const resultadoBusqueda = busca.trim() ? (buscarPorCodigo(cat?.productos ?? [], partirBusqueda(busca).texto) ?? vista.secciones[0]?.prods[0] ?? null) : null;

  const umbral = cat?.config?.umbral_rtn ?? UMBRAL_RTN_OBLIGATORIO;
  const hayTerceraEdad = orden.lineas.some((l) => l.descuento_porcentaje === 25);
  const terceraEdadLista = orden.tercera_edad.nombre.trim().length >= 3 && identidadValida(orden.tercera_edad.identidad);
  const exigeCarne = cat?.config?.exigir_tercera_edad !== false;
  const faltaCarne = hayTerceraEdad && exigeCarne && !terceraEdadLista;
  const sinRtn = faltaRtn(totales.total, orden.cliente, umbral);
  const rtnBloquea = cat?.config?.rtn_bloqueante !== false;   // EcoStone/DISERCO: solo avisa y deja constancia
  const necesitaRtn = sinRtn && rtnBloquea;
  const fiscal = cat && sucursal ? cat.fiscal[sucursal.id] : null;
  const sinPunto = Boolean(cat && sucursal && !fiscal);
  const bloqueoFiscal = sinPunto || Boolean(fiscal?.agotado || fiscal?.vencido);
  const hayLineas = orden.lineas.length > 0;
  const cobroBloqueado = !hayLineas || !orden.tipo_orden || bloqueoFiscal || necesitaRtn || faltaCarne || cobrando || ocupado;
  const hayPiedra = orden.lineas.some((l) => l.producto.es_piedra);

  // Al abrir una factura nueva se pregunta si es para comer aquí o para llevar (métrica: tienda vs. autoservicio). No se puede omitir.
  useEffect(() => {
    if (!orden.id && !orden.tipo_orden && !recibo && !modal && cat) setModal({ tipo: 'servicio' });
  }, [orden.id, orden.tipo_orden, recibo, modal, cat]);

  // ── Guardado automático de la orden como "abierta" (la recupera Órdenes abiertas aunque se cierre la pantalla) ──
  const cuerpoOrden = (o, sucId) => ({
    sucursal_id: sucId, tipo_orden: o.tipo_orden ?? 'aqui', nombre_orden: o.nombre_orden, notas: o.nota, cliente_id: o.cliente?.id ?? null,
    items: o.lineas.map((l) => ({ producto_id: l.producto.id, cantidad: l.cantidad, opciones: l.opciones.map((x) => x.id), notas: l.notas, descuento_porcentaje: l.descuento_porcentaje })),
    ...(o.lineas.some((l) => l.descuento_porcentaje === 25) && o.tercera_edad.nombre.trim().length >= 3 && identidadValida(o.tercera_edad.identidad)
      ? { tercera_edad: { nombre: o.tercera_edad.nombre.trim(), identidad: o.tercera_edad.identidad.trim() } } : {}),
  });

  async function guardarOrden() {
    const o = ordenRef.current, suc = sucursalRef.current;
    if (!o.lineas.length || !suc) return ventaIdRef.current;
    const cuerpo = cuerpoOrden(o, suc.id);
    try {
      if (ventaIdRef.current) await put(`/pos/ventas/${ventaIdRef.current}`, cuerpo);
      else {
        const v = await post('/pos/ventas', cuerpo);
        if (descartadaRef.current) { post(`/pos/ventas/${v.id}/descartar`, { motivo: 'Orden descartada' }).catch(() => {}); return null; }
        ventaIdRef.current = v.id;
        setOrden((x) => ({ ...x, id: v.id, ticket: v.ticket_dia }));
      }
      pendienteRef.current = false;
      setError('');
      return ventaIdRef.current;
    } catch (e) {
      if (e.codigo === 'sin_red') { setOffline(true); throw e; }   // sin conexión no es un error: la orden sigue en pantalla y se cobra en modo local
      setError(e.message); throw e;
    }
  }
  // Encola cada guardado en serie: nunca corren dos a la vez (dos órdenes duplicadas).
  function guardarEnCola() {
    const p = colaRef.current.catch(() => {}).then(() => (descartadaRef.current ? ventaIdRef.current : guardarOrden()));
    colaRef.current = p;
    return p;
  }
  function vaciarEnServidor() {
    const id = ventaIdRef.current;
    if (!id) return;
    ventaIdRef.current = null;
    setOrden((o) => ({ ...o, id: null, ticket: null }));
    post(`/pos/ventas/${id}/descartar`, { motivo: 'Orden vaciada por el cajero' }).catch(() => {});
  }

  const primeraVez = useRef(true);
  useEffect(() => {
    if (primeraVez.current) { primeraVez.current = false; return undefined; }
    if (omitirGuardadoRef.current) { omitirGuardadoRef.current = false; return undefined; }
    if (!sucursalRef.current) return undefined;
    if (orden.lineas.length === 0) { vaciarEnServidor(); return undefined; }
    descartadaRef.current = false;
    pendienteRef.current = true;
    if (sinRedRef.current) return undefined;     // sin conexión la orden vive en pantalla; al volver la señal se guarda sola
    timerRef.current = setTimeout(() => { guardarEnCola().catch(() => { if (!sinRedRef.current) setTimeout(() => guardarEnCola().catch(() => {}), 2000); }); }, 700);
    return () => clearTimeout(timerRef.current);
  }, [orden.lineas, orden.cliente, orden.tipo_orden, orden.nombre_orden, orden.tercera_edad, orden.nota]); // eslint-disable-line react-hooks/exhaustive-deps
  // Al salir de la pantalla no se pierde lo último que se tocó.
  useEffect(() => () => { if (pendienteRef.current && !sinRedRef.current) guardarEnCola().catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Historial de la orden (Deshacer) ──────────────────────────────────────
  useEffect(() => {
    if (deshaciendoRef.current) { deshaciendoRef.current = false; prevLineasRef.current = orden.lineas; return; }
    if (reinicioHistRef.current) { reinicioHistRef.current = false; histRef.current = []; prevLineasRef.current = orden.lineas; setPuedeDeshacer(false); return; }
    if (prevLineasRef.current !== orden.lineas) {
      histRef.current.push(prevLineasRef.current);
      if (histRef.current.length > 30) histRef.current.shift();
      prevLineasRef.current = orden.lineas;
      setPuedeDeshacer(true);
    }
  }, [orden.lineas]);

  // ── Líneas de la orden ──────────────────────────────────────────────────
  const agregar = useCallback((p, extra) => {
    setRecibo(null);
    setOrden((o) => {
      if (!extra && (p.unidad === 'unidad' || p.es_piedra)) {
        // Se suma a la línea del mismo producto SIN opciones ni descuento; si la existente tiene descuento, la unidad nueva va aparte.
        const i = o.lineas.findIndex((l) => l.producto.id === p.id && !l.opciones.length && !l.notas && !l.descuento_porcentaje);
        if (i >= 0) return { ...o, lineas: o.lineas.map((l, j) => (j === i ? { ...l, cantidad: l.cantidad + 1 } : l)) };
      }
      return { ...o, lineas: [...o.lineas, nuevaLinea(p, extra)] };
    });
    mostrarToast(`+ ${p.nombre}`);
  }, []);
  const tocar = (p, cantidad = 1) => {
    vibrar(10);
    if (modoEdicion === 'favorito') {
      ejecutar(async () => { await patch(`/pos/catalogo/productos/${p.id}/favorito`, { favorito: !p.favorito }); await cargarCatalogo(); }, p.favorito ? `${p.nombre}: ya no es favorito` : `${p.nombre}: ahora es favorito`);
      return;
    }
    if (!p.disponible) { avisar(`${p.nombre} está agotado`, 'mal'); return; }
    if (sinRedRef.current && p.es_piedra) { avisar('La piedra no se vende sin conexión: no se puede verificar la existencia. Espera a que vuelva el internet.', 'mal'); return; }
    // Con grupos OBLIGATORIOS (ej. tamaño) se pregunta; si todo es opcional se agrega directo y los extras se piden tocando la línea.
    if (gruposDe(p).some((g) => g.min_sel > 0)) setModal({ tipo: 'opciones', producto: p });
    else if (p.unidad !== 'unidad' && !p.es_piedra) setModal({ tipo: 'peso', producto: p });
    else if (cantidad > 1) agregar(p, { cantidad });
    else agregar(p);
  };

  const tocarRef = useRef(tocar); tocarRef.current = tocar;
  const onTocar = useCallback((p) => tocarRef.current(p), []);
  const colores = useMemo(() => new Map((cat?.categorias ?? []).map((c) => [c.id, c.color])), [cat]);

  // Lector de código de barras con el cursor fuera de cualquier campo (por ejemplo justo después de tocar un producto): se captura la
  // ráfaga de teclas y se agrega el producto al terminar con Enter. Si el cursor está en un campo de texto, esa escritura es de una persona.
  const buffer = useRef({ txt: '', t: 0 });
  useEffect(() => {
    const f = (e) => {
      const el = document.activeElement;
      if (esCampo(el) || modal || recibo || e.ctrlKey || e.altKey || e.metaKey) return;
      const ahora = Date.now();
      if (ahora - buffer.current.t > 80) buffer.current.txt = '';
      buffer.current.t = ahora;
      if (e.key === 'Enter') {
        const code = buffer.current.txt; buffer.current.txt = '';
        if (code.length >= 3) {
          const p = buscarPorCodigo(catRef.current?.productos ?? [], code);
          if (p) tocar(p); else mostrarToast(`Código ${code} no encontrado`);
          e.preventDefault();
        }
      } else if (e.key.length === 1) buffer.current.txt += e.key;
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // Quitar productos de una orden ya armada (sobre todo después de que el cliente vio el total) es una forma de cobrar de más sin
  // facturarlo: cada quitada queda en la bitácora.
  const registrarQuitado = (l, cantidad) => {
    if (!l || cantidad <= 0) return;
    registrarEvento('orden.quitar_producto', { producto: l.producto.nombre, cantidad, monto: Math.round(Number(l.producto.precio) * cantidad * 100) / 100, orden_id: ventaIdRef.current ?? '', quedan_en_orden: ordenRef.current.lineas.length }, sucursal?.id);
  };
  const cambiarCant = (key, d) => {
    const l = ordenRef.current.lineas.find((x) => x.key === key);
    if (d < 0) registrarQuitado(l, -d);
    setOrden((o) => ({ ...o, lineas: o.lineas.map((x) => (x.key === key ? { ...x, cantidad: Math.round((x.cantidad + d) * 1000) / 1000 } : x)).filter((x) => x.cantidad > 0) }));
  };
  // Cantidad escrita (teclado en pantalla o físico). Por peso admite 3 decimales; unidades y cajas de piedra, solo enteros.
  const fijarCantidad = (key, valor, decimal = false) => {
    const n = decimal ? Math.round(Number(valor) * 1000) / 1000 : Math.floor(Number(valor) || 1);
    const cantidad = Math.min(999, Math.max(decimal ? 0.001 : 1, n));
    const l = ordenRef.current.lineas.find((x) => x.key === key);
    if (l && cantidad < l.cantidad) registrarQuitado(l, redondear(l.cantidad - cantidad));
    setOrden((o) => ({ ...o, lineas: o.lineas.map((x) => (x.key === key ? { ...x, cantidad } : x)) }));
  };
  const quitar = (key) => {
    const l = ordenRef.current.lineas.find((x) => x.key === key);
    registrarQuitado(l, l?.cantidad ?? 0);
    setOrden((o) => ({ ...o, lineas: o.lineas.filter((x) => x.key !== key) }));
  };
  const fijarDescuento = (key, pct) => {
    const l = ordenRef.current.lineas.find((x) => x.key === key);
    if (l && pct > 0) registrarEvento('orden.descuento', { producto: l.producto.nombre, cantidad: l.cantidad, porcentaje: pct }, sucursal?.id);
    setOrden((o) => ({ ...o, lineas: o.lineas.map((x) => (x.key === key ? { ...x, descuento_porcentaje: pct } : x)) }));
  };
  // "2 jugos, uno para un adulto mayor": saca 1 unidad a su propia línea para ponerle el descuento solo a esa.
  const separarUnidad = (key) => setOrden((o) => {
    const i = o.lineas.findIndex((l) => l.key === key);
    if (i < 0 || o.lineas[i].cantidad < 2) return o;
    const copia = [...o.lineas];
    copia[i] = { ...copia[i], cantidad: copia[i].cantidad - 1 };
    copia.splice(i + 1, 0, { ...o.lineas[i], key: ++contador, cantidad: 1, descuento_porcentaje: 0 });
    return { ...o, lineas: copia };
  });
  // Deshacer: vuelve a la foto anterior de las líneas. Lo que desaparece por deshacer también queda en la bitácora como producto quitado.
  const deshacer = () => {
    const h = histRef.current;
    if (!h.length) { mostrarToast('Nada que deshacer'); return; }
    const previa = h.pop();
    for (const l of ordenRef.current.lineas) {
      const p = previa.find((x) => x.key === l.key);
      const quitado = p ? l.cantidad - p.cantidad : l.cantidad;
      if (quitado > 0) registrarQuitado(l, quitado);
    }
    deshaciendoRef.current = true;
    setOrden((o) => ({ ...o, lineas: previa }));
    setPuedeDeshacer(h.length > 0);
    mostrarToast('Deshecho');
  };

  // ── Nueva / descartar / en espera / recuperar ────────────────────────────
  const reiniciar = () => {
    clearTimeout(timerRef.current); pendienteRef.current = false;
    ventaIdRef.current = null; idCobroRef.current = null; reinicioHistRef.current = true;
    setOrden(vacio()); setError(''); setErrCobro(''); setBusca('');
    setTimeout(() => buscadorRef.current?.focus(), 50);
  };
  const nueva = () => { if (ordenRef.current.lineas.length) setModal({ tipo: 'descartar' }); else reiniciar(); };
  const descartarConMotivo = async (motivo) => {
    descartadaRef.current = true;
    const id = ventaIdRef.current;
    setModal(null); reiniciar();
    if (id) { try { await post(`/pos/ventas/${id}/descartar`, { motivo }); } catch (e) { avisar(e.message, 'mal'); } }
    contarAbiertas();
  };
  const dejarEnEspera = async () => {
    if (sinRedRef.current) { avisar('Sin conexión no se puede dejar la orden en espera: se guarda en el servidor. Cóbrala en efectivo o espera la señal.', 'mal'); return; }
    if (!ordenRef.current.lineas.length) return;
    const r = await ejecutar(() => guardarEnCola());
    if (r) { avisar(`Orden #${ordenRef.current.ticket ?? ''} guardada en espera`); reiniciar(); contarAbiertas(); }
  };
  const abrirOrden = async (id) => {
    if (ordenRef.current.lineas.length) await guardarEnCola().catch(() => {});
    const v = await ejecutar(() => get(`/pos/ventas/${id}`));
    if (!v || v === true) return;
    if (v.estado !== 'abierta') { setError('Esa orden ya fue cobrada o descartada en otra caja.'); contarAbiertas(); return; }
    const porId = new Map(cat.productos.map((p) => [p.id, p]));
    const lineas = v.lineas.filter((l) => porId.has(l.producto_id)).map((l) => nuevaLinea(porId.get(l.producto_id), { cantidad: Number(l.cantidad), opciones: l.opciones, notas: l.notas, descuento_porcentaje: Number(l.descuento_porcentaje) }));
    if (lineas.length < v.lineas.length) avisar('Algún producto de esa orden ya no está en el catálogo y no se cargó.', 'mal');
    descartadaRef.current = false; omitirGuardadoRef.current = true; reinicioHistRef.current = true; idCobroRef.current = null;
    ventaIdRef.current = v.id;
    setOrden({
      id: v.id, ticket: v.ticket_dia, nombre_orden: v.nombre_orden ?? '', tipo_orden: v.tipo_orden, nota: v.notas ?? '',
      cliente: v.cliente?.es_consumidor_final ? null : v.cliente,
      tercera_edad: { nombre: v.tercera_edad_nombre ?? '', identidad: v.tercera_edad_identidad ?? '' },
      lineas,
    });
    setError(''); setModal(null);
  };
  const repetirUltima = () => {
    const u = ultimaRef.current;
    if (!u) return;
    omitirGuardadoRef.current = false; reinicioHistRef.current = true; idCobroRef.current = null;
    setOrden({ ...vacio(), cliente: u.cliente, lineas: u.lineas.map((l) => ({ ...l, key: ++contador })) });
    setRecibo(null);
    mostrarToast('Pedido repetido: revisa y cobra');
  };

  // ── Cobro ────────────────────────────────────────────────────────────────
  const cierreDeVenta = (venta) => {
    ultimaRef.current = { cliente: ordenRef.current.cliente, lineas: ordenRef.current.lineas };
    pendienteRef.current = false; ventaIdRef.current = null; idCobroRef.current = null; reinicioHistRef.current = true;
    setModal(null); setOrden(vacio()); setBusca('');
    setRecibo(venta); setVerOrden(false);
  };

  /**
   * SIN CONEXIÓN: la venta se cobra en efectivo, se entrega un comprobante PROVISIONAL (OFF-xxxx-0001, NO es factura) y queda en la cola
   * local con su id. El número fiscal real lo asigna el servidor al sincronizar (nunca se repite ni se salta); ver docs/POS-SIN-CONEXION.md.
   */
  const cobrarSinConexion = async (pagos) => {
    const efectivoId = cat.formas_pago.find((f) => f.tipo === 'efectivo')?.id;
    if (!pagos.every((p) => p.forma_pago_id === efectivoId)) { setErrCobro(MSG_SIN_TARJETA); setError(MSG_SIN_TARJETA); return; }
    if (hayPiedra) { const m = 'La piedra no se vende sin conexión: no se puede verificar la existencia. Quita la piedra o espera a que vuelva el internet.'; setErrCobro(m); setError(m); return; }
    setCobrando(true); setErrCobro(''); setError('');
    try {
      clearTimeout(timerRef.current);
      const o = ordenRef.current, suc = sucursalRef.current;
      const recibido = redondear(pagos.reduce((s, p) => s + p.monto, 0));
      const total = totales.total;
      const id = idCobroRef.current ?? (idCobroRef.current = uuidCliente());
      const numero = await cola().siguienteNumero(codigoCaja());
      const fecha = new Date();
      const { columnas, autoImprimir } = leerConfigImpresora();
      const ticket = formatearTicketProvisional({
        empresa: cat.empresa ?? contexto.empresa, sucursal: cat.sucursales.find((x) => x.id === suc.id) ?? suc, cajero: usuario?.nombre, cliente: o.cliente, numero, fecha, totales, recibido, cambio: Math.max(0, redondear(recibido - total)),
        lineas: o.lineas.map((l) => ({ nombre: l.producto.nombre, cantidad: l.cantidad, opciones: l.opciones, notas: l.notas })),
        borrador: fiscal?.borrador !== false,
      }, columnas);
      await cola().encolar({
        id_cliente: id, ...(ventaIdRef.current ? { orden_id: ventaIdRef.current } : {}), ...cuerpoOrden(o, suc.id),
        cobrar: { pagos: pagos.map((p) => ({ forma_pago_id: p.forma_pago_id, monto: p.monto, referencia: p.referencia ?? null })) }, confirmar_sin_stock: true,
        offline: { vendida_at: fecha.toISOString(), numero_provisional: numero, cajero_nombre: usuario?.nombre ?? null, total_cliente: total },
      }, { empresa, resumen: { total, lineas: o.lineas.length, cajero: usuario?.nombre ?? '', provisional: numero } });
      cierreDeVenta({ offline: true, total, cambio: Math.max(0, redondear(recibido - total)), provisional: numero, ticket, impresa: false, es_borrador_fiscal: fiscal?.borrador !== false });
      if (autoImprimir) {
        imprimirLineas(ticket).then(() => setRecibo((x) => (x && x.provisional === numero ? { ...x, impresa: true } : x)))
          .catch((e) => setError(`La venta quedó guardada, pero no se pudo imprimir el comprobante: ${e.message}`));
      }
      if (typeof navigator !== 'undefined' && navigator.onLine) sincronizarAhora().catch(() => {});   // por si «sin conexión» era solo una falla del servidor
    } catch (e) { setErrCobro(e.message); setError(e.message); }
    finally { setCobrando(false); }
  };

  const confirmarPago = async (pagos, confirmarSinStock = false) => {
    if (cobroBloqueado && !modal) return;
    if (sinRedRef.current) { await cobrarSinConexion(pagos); return; }
    const efectivoId = cat.formas_pago.find((f) => f.tipo === 'efectivo')?.id;
    const soloEfectivo = pagos.every((p) => p.forma_pago_id === efectivoId);
    setCobrando(true); setErrCobro(''); setError('');
    try {
      clearTimeout(timerRef.current);
      const id = await guardarEnCola();            // el total cobrado es SIEMPRE el que ve el cajero
      if (!id) throw new Error('No se pudo guardar la orden antes de cobrar');
      const idCobro = idCobroRef.current ?? (idCobroRef.current = uuidCliente());
      const venta = await post(`/pos/ventas/${id}/cobrar`, { pagos, id_cliente: idCobro, ...(confirmarSinStock ? { confirmar_sin_stock: true } : {}) }, { espera: 20_000 });
      cierreDeVenta({ ...venta, impresa: false });
      cargarTurno(); contarAbiertas();
      if (leerConfigImpresora().autoImprimir) {
        imprimirTicket(venta.id).then(() => setRecibo((x) => (x && x.id === venta.id ? { ...x, impresa: true } : x)))
          .catch((e) => setError(`La factura se emitió, pero no se pudo imprimir: ${e.message}`));
      }
    } catch (e) {
      if (e.codigo === 'sin_red') {
        setOffline(true);
        if (soloEfectivo) { setCobrando(false); await cobrarSinConexion(pagos); return; }   // el mismo id evita facturar dos veces si el servidor sí alcanzó a cobrar
        const m = 'Se perdió la conexión mientras se cobraba con tarjeta. Antes de volver a cobrar revisa en Facturas si la orden quedó cobrada.';
        setErrCobro(m); setError(m);
      } else if (e.codigo === 'SIN_STOCK' && e.faltantes?.length) { setErrCobro(''); setError(''); setAvisoStock({ faltantes: e.faltantes, pagos, bloqueante: cat?.config?.permitir_sin_stock !== true }); }
      else { setErrCobro(e.message); setError(e.message); }
    } finally { setCobrando(false); }
  };
  // Un solo toque: Efectivo y Tarjeta cobran de inmediato el total exacto. Con cambio / dividir pagos / transferencia: ventanas aparte.
  const pagoInstantaneo = (tipo) => {
    const f = cat.formas_pago.find((x) => x.tipo === tipo);
    if (!f) { avisar(`Esta empresa no tiene forma de pago "${tipo}" activa`, 'mal'); return; }
    if (cobroBloqueado) return;
    if (tipo !== 'efectivo' && sinRedRef.current) { avisar(MSG_SIN_TARJETA, 'mal'); return; }
    confirmarPago([{ forma_pago_id: f.id, monto: totales.total }]);
  };
  const cobrarEfectivoRecibido = (recibido) => {
    const f = cat.formas_pago.find((x) => x.tipo === 'efectivo');
    if (!f) { avisar('Esta empresa no tiene forma de pago "efectivo" activa', 'mal'); return; }
    confirmarPago([{ forma_pago_id: f.id, monto: recibido }]);
  };
  const abrirEfectivo = () => { if (!cobroBloqueado) { setErrCobro(''); setModal({ tipo: 'efectivo' }); } };
  const abrirMasPagos = () => {
    if (!hayLineas || bloqueoFiscal || faltaCarne || cobrando) return;
    if (sinRedRef.current) { avisar(MSG_SIN_TARJETA, 'mal'); return; }
    setErrCobro(''); setModal({ tipo: 'cobro' });
  };

  const imprimirRecibo = async (razon) => {
    if (recibo?.offline) {
      const lineas = recibo.impresa ? ['*** COPIA ***', ...recibo.ticket] : recibo.ticket;
      const r = await ejecutar(() => imprimirLineas(lineas));
      if (r !== null) setRecibo((x) => ({ ...x, impresa: true }));
      return;
    }
    const r = await ejecutar(() => imprimirTicket(recibo.id, { reimpresion: Boolean(razon), razon }));
    if (r !== null) setRecibo((x) => ({ ...x, impresa: true }));
    setModal(null);
  };

  // ── Atajos de teclado ────────────────────────────────────────────────────
  // Se registra en cada render para leer siempre el estado de ahora (igual que el lector de código de barras).
  useEffect(() => {
    if (!cat) return undefined;
    const f = (e) => {
      const enCampo = esCampo(document.activeElement);
      // Con el recibo abierto, Enter = «Nueva venta» aunque el foco se haya ido (por ejemplo, tras imprimir).
      if (recibo && !modal && e.key === 'Enter' && !e.ctrlKey && !enCampo && document.activeElement?.tagName !== 'BUTTON') { e.preventDefault(); setRecibo(null); buscadorRef.current?.focus(); return; }
      if (modal || recibo || avisoStock) return;
      if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'z') {
        if (enCampo && document.activeElement === buscadorRef.current && busca) return;   // dentro del texto, Ctrl+Z deshace el texto
        e.preventDefault(); deshacer(); return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const accion = {
        F1: () => setModal({ tipo: 'ayuda' }), F2: () => pagoInstantaneo('efectivo'), F3: () => pagoInstantaneo('tarjeta'), F4: abrirEfectivo,
        F6: abrirMasPagos, F7: () => setModal({ tipo: 'abiertas' }), F8: dejarEnEspera, F9: () => setModal({ tipo: 'cliente' }),
      }[e.key];
      if (accion) { e.preventDefault(); accion(); return; }
      if (e.key === 'Escape') {
        if (enCampo && busca) { setBusca(''); e.preventDefault(); return; }
        if (modoEdicion) { setModoEdicion(null); return; }
        if (ordenRef.current.lineas.length) { e.preventDefault(); nueva(); }
        return;
      }
      if (enCampo) return;
      const ult = ordenRef.current.lineas[ordenRef.current.lineas.length - 1];
      if (e.key === '/') { e.preventDefault(); buscadorRef.current?.focus(); }
      else if (ult && (e.key === '+' || e.key === '=') && ult.producto.unidad === 'unidad') { e.preventDefault(); cambiarCant(ult.key, 1); }
      else if (ult && (e.key === '-' || e.key === '_') && (ult.producto.unidad === 'unidad' || ult.producto.es_piedra)) { e.preventDefault(); cambiarCant(ult.key, -1); }
      else if (ult && e.key === '*') { e.preventDefault(); setModal({ tipo: 'cantidad', key: ult.key }); }
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  if (error && !cat) return <div className="pagina"><ErrorCaja error={error} /></div>;
  if (!cat || !sucursal) return <Cargando texto="Preparando la caja…" />;

  const colorSuc = colorSucursal(cat.sucursales, sucursal.id);
  const catsOrdenadas = cat.categorias;
  const otrasAbiertas = Math.max(0, abiertas - (orden.id ? 1 : 0));
  const cantidadTotal = orden.lineas.reduce((n, l) => n + (Number(l.cantidad) || 0), 0);
  const catalogoOrdenado = vista.secciones;

  const buscarEnter = () => {
    const { n, texto } = partirBusqueda(busca);
    const p = buscarPorCodigo(cat.productos, texto) ?? vista.secciones[0]?.prods[0];
    if (p) { tocar(p, n); setBusca(''); } else if (busca.trim()) mostrarToast(`"${busca.trim()}" no encontrado`);
  };

  return (
    <div className="pos">
      <AvisoRecepcion />
      {toast && <div className="pos-toast" role="status">{toast}</div>}
      <div className="pos-izq">
        <div className="pos-barra">
          <div className="fila" style={{ gap: 6 }}>
            {turno && <span className="chip ok">Caja desde {new Date(turno.abierto_at).toLocaleTimeString('es-HN', { timeZone: 'America/Tegucigalpa', hour: '2-digit', minute: '2-digit' })}</span>}
            {fiscal?.borrador && <span className="chip aviso" title="Sin CAI real: las facturas no tienen validez fiscal">BORRADOR · sin valor fiscal</span>}
            {sinRed && <span className="chip mal" title="El catálogo está guardado en esta caja; las ventas en efectivo se guardan y se mandan solas al volver el internet">Sin conexión · modo local</span>}
            {resumenCola.total > 0 && (
              <button className={`chip pos-chip-cola ${resumenCola.revisar ? 'mal' : 'aviso'}`} onClick={() => setModal({ tipo: 'cola' })}>
                {resumenCola.sincronizando ? 'Sincronizando…' : `${resumenCola.total} venta${resumenCola.total === 1 ? '' : 's'} por sincronizar${resumenCola.revisar ? ` · ${resumenCola.revisar} por revisar` : ''}`}
              </button>
            )}
          </div>
          <span className="sep" style={{ flex: 1 }} />
          {puede('pos:catalogo') && !sinRed && (
            <>
              {/* Sin botón de «agotados» en la caja: decisión del dueño (la disponibilidad se cambia en Catálogo). */}
              <button className={`btn chico${modoEdicion === 'favorito' ? ' primario' : ''}`} aria-pressed={modoEdicion === 'favorito'} onClick={() => setModoEdicion((m) => (m === 'favorito' ? null : 'favorito'))} title="Marca los productos favoritos para todas las cajas">★ Favoritos</button>
            </>
          )}
          <button className="btn chico" onClick={() => setModal({ tipo: 'abiertas' })} disabled={sinRed} title={sinRed ? 'Requiere conexión' : 'F7'}>Abiertas{otrasAbiertas > 0 && <span className="chip aviso">{otrasAbiertas}</span>}</button>
          <button className="btn chico fantasma" onClick={() => setModal({ tipo: 'ayuda' })} title="Atajos del teclado (F1)" aria-label="Ayuda de atajos"><kbd>F1</kbd> Ayuda</button>
        </div>

        {sinRed && <div className="aviso-caja mal" role="status">Sin conexión: se vende solo en efectivo, con comprobante provisional; la factura sale sola al volver el internet.</div>}
        {modoEdicion && <div className="aviso-caja" role="status">Toca un producto para marcarlo (o quitarlo) de Favoritos. Esc para salir.</div>}

        <input ref={buscadorRef} className="pos-buscar" placeholder="Buscar o escanear…  (Enter agrega · 3*jugo agrega 3 · / para volver aquí)" value={busca} onChange={(e) => setBusca(e.target.value)} aria-label="Buscar producto"
          onKeyDown={(e) => { if (e.key === 'Enter') buscarEnter(); }} />
        <div className="pos-cuerpo">
        <div className="pos-cats" aria-label="Categorías">
          <button className={catActiva === 'todas' ? 'on' : ''} onClick={() => setCatActiva('todas')}>Todo</button>
          {vista.favoritos.length > 0 && <button className={`cat-especial${catActiva === 'fav' ? ' on' : ''}`} onClick={() => setCatActiva('fav')}>★ Favoritos</button>}
          {vista.mas.length > 0 && <button className={`cat-especial${catActiva === 'mas' ? ' on' : ''}`} onClick={() => setCatActiva('mas')}>Más vendidos</button>}
          {catsOrdenadas.map((c) => <button key={c.id} className={catActiva === c.id ? 'on' : ''} onClick={() => setCatActiva(c.id)} style={{ '--cc': c.color || 'var(--acento)' }}>{c.nombre}</button>)}
        </div>
        <div className="pos-productos">
          <Grilla secciones={catalogoOrdenado} colores={colores} resaltadoId={resultadoBusqueda?.id ?? null} modoEdicion={modoEdicion} onTocar={onTocar} />
          {!hayResultados && (
            <div className="vacio pos-vacio">
              {cat.productos.length === 0 ? 'Aún no hay productos. Agrégalos en Catálogo.'
                : busca.trim() ? <>No hay productos que coincidan con «{busca.trim()}».<br /><small>Revisa la escritura, prueba otra palabra o escanea el código de barras.</small><br /><button className="btn chico" onClick={() => { setBusca(''); buscadorRef.current?.focus(); }}>Borrar búsqueda</button></>
                : catActiva === 'fav' ? <>Todavía no hay favoritos.<br /><small>Un encargado los marca con el botón «★ Favoritos» de arriba.</small></>
                : catActiva === 'mas' ? <>Aún no hay ventas suficientes para calcular los más vendidos.</>
                : 'Esta categoría no tiene productos.'}
            </div>
          )}
        </div>
        </div>
        <div className="pos-atajos-tira" aria-label="Atajos del teclado">
          {ATAJOS.filter((a) => a.corta).map((a) => <span key={a.teclas}><kbd>{a.teclas}</kbd> {a.corta}</span>)}
        </div>
      </div>

      {!verOrden && (
        <button className="pos-barra-orden" onClick={() => setVerOrden(true)}>
          <span className="bo-cant">{cantidadTotal}</span>
          <span className="bo-txt">{hayLineas ? 'Ver orden y cobrar' : 'Orden vacía'}</span>
          <b className="num bo-total">{lempiras(totales.total)}</b>
        </button>
      )}
      <aside className={`pos-der${verOrden ? ' abierta' : ''}`} aria-label="Orden actual">
        <button className="btn chico pos-volver" onClick={() => setVerOrden(false)}>← Seguir agregando</button>
        <div className="pos-sucursal-banner" style={{ background: colorSuc }}>
          <b>{nombreCortoSucursal(sucursal.nombre, sucursal.alias)}</b><span>{sucursal.nombre}</span>
        </div>
        {sinPunto && <div className="aviso-caja mal">Esta sucursal no tiene un punto de emisión activo: no se puede facturar.</div>}
        {fiscal && (fiscal.agotado || fiscal.vencido || fiscal.alerta) && (
          <div className={`aviso-caja ${fiscal.agotado || fiscal.vencido ? 'mal' : ''}`} role="alert">
            {fiscal.agotado && 'El rango de facturas está agotado: no se puede facturar. '}
            {fiscal.vencido && 'El CAI ya venció: no se puede facturar. '}
            {!fiscal.agotado && !fiscal.vencido && `El CAI está por vencer o agotarse (quedan ${fiscal.restantes} facturas${fiscal.dias_restantes != null ? ` y ${fiscal.dias_restantes} días` : ''}): avisa al dueño.`}
          </div>
        )}

        <div className="pos-wz-total-art">Total de artículos: <b>{cantidadTotal}</b></div>
        <div className="pos-wz-info">
          <div className="pos-wz-fila"><label>Orden</label><div className="pos-wz-val">{orden.id ? `#${orden.ticket}` : 'Nueva'}<button className="btn chico" style={{ marginLeft: 'auto' }} onClick={() => setOrden((o) => ({ ...o, tipo_orden: o.tipo_orden === 'aqui' ? 'llevar' : 'aqui' }))}>{orden.tipo_orden === 'aqui' ? 'Comer aquí' : orden.tipo_orden === 'llevar' ? 'Para llevar' : 'Elegir'}</button></div></div>
          <div className="pos-wz-fila"><label>Cliente</label>
            <div className={`pos-wz-val clic${necesitaRtn ? ' falta' : ''}`} onClick={() => setModal({ tipo: 'cliente' })} role="button" tabIndex={0}>
              <span className="pos-wz-nombre">{orden.cliente?.nombre ?? 'Consumidor Final'}{orden.cliente?.exento_impuestos && <span className="chip aviso" style={{ marginLeft: 8 }}>Exento</span>}</span>
              {orden.cliente && <button className="btn chico fantasma" title="Volver a Consumidor Final" aria-label="Quitar cliente" onClick={(e) => { e.stopPropagation(); setOrden((o) => ({ ...o, cliente: null })); }}>✕</button>}
              <Icono n="clientes" tam={18} />
            </div>
          </div>
          <div className="pos-wz-fila dos">
            <label>RTN</label><div className={`pos-wz-val clic${necesitaRtn ? ' falta' : ''}`} onClick={() => setModal({ tipo: 'cliente' })} role="button" tabIndex={0}>{orden.cliente?.rtn ?? <span className="tenue">—</span>}</div>
            <label>Fecha</label><div className="pos-wz-val">{new Date().toLocaleDateString('es-HN', { timeZone: 'America/Tegucigalpa' })}</div>
          </div>
        </div>

        <div className="pos-lineas pos-wz-tabla">
          <div className="pos-wz-th"><span>Producto</span><span>Cantidad</span><span>Precio</span><span>Monto</span><span /></div>
          {!hayLineas && (
            <div className="vacio pos-orden-vacia">
              <b>Orden vacía</b>
              <span>Toca un producto, busca por nombre o escanea un código de barras.</span>
              <small>Con teclado: Enter agrega · F1 muestra todos los atajos</small>
            </div>
          )}
          {orden.lineas.map((l, i) => {
            const t = totales.lineas[i];
            const unidad = l.producto.unidad === 'unidad' || l.producto.es_piedra;
            const piedra = Boolean(l.producto.es_piedra);
            const bruto = Math.round(t.precio_unitario * l.cantidad * 100) / 100;
            return (
              <div className={`pos-wz-tr${l.descuento_porcentaje ? ' con-descuento' : ''}`} key={l.key}>
                <div className="pos-wz-prod" onClick={() => l.producto.grupo_ids.length && setModal({ tipo: 'opciones', producto: l.producto, editar: l })}>
                  <b>{l.producto.nombre}</b>{!unidad && <small> ({l.producto.unidad})</small>}{piedra && <small> (caja · {Number(l.producto.m2_por_caja) || 1} m²)</small>}
                  {l.descuento_porcentaje > 0 && <small className="chip ok" style={{ marginLeft: 6 }}>−{l.descuento_porcentaje}%</small>}
                  {l.opciones.map((o) => <small key={o.id} className="tenue" style={{ display: 'block' }}>+ {o.nombre}</small>)}
                  {l.notas && <small style={{ display: 'block', color: 'var(--aviso)' }}>“{l.notas}”</small>}
                </div>
                <div className="pos-wz-cant">
                  <button onClick={() => cambiarCant(l.key, -1)} aria-label="Menos" disabled={!unidad}>−</button>
                  <button className="pos-cant-valor num" onClick={() => setModal({ tipo: 'cantidad', key: l.key })} aria-label={`Cantidad de ${l.producto.nombre}: ${l.cantidad}. Tocar para escribir otra`}>{l.cantidad}</button>
                  <button onClick={() => cambiarCant(l.key, 1)} aria-label="Más" disabled={!unidad}>+</button>
                </div>
                <div className="num der">{lempiras(t.precio_unitario).replace('L ', '')}</div>
                <div className="num der">{t.descuento > 0 ? <><small style={{ textDecoration: 'line-through', display: 'block' }}>{lempiras(bruto).replace('L ', '')}</small><b style={{ color: 'var(--ok)' }}>{lempiras(t.monto).replace('L ', '')}</b></> : lempiras(t.monto).replace('L ', '')}</div>
                <button className="pos-wz-opc" onClick={() => setModal({ tipo: 'linea', key: l.key })}><Icono n="editar" tam={14} /> Opciones</button>
              </div>
            );
          })}
        </div>

        {hayTerceraEdad && (
          <div className={`pos-tercera-edad${faltaCarne ? ' incompleto' : ''}`}>
            <span className="tit">Descuento 3ª edad: datos del carné</span>
            <input placeholder="Nombre completo" value={orden.tercera_edad.nombre} onChange={(e) => setOrden((o) => ({ ...o, tercera_edad: { ...o.tercera_edad, nombre: e.target.value } }))} />
            <input placeholder="No. identidad / carné" inputMode="numeric" value={orden.tercera_edad.identidad} onChange={(e) => setOrden((o) => ({ ...o, tercera_edad: { ...o.tercera_edad, identidad: e.target.value } }))} />
            {faltaCarne && <small style={{ color: 'var(--aviso)' }}>Obligatorio para cobrar con el 25 %.</small>}
          </div>
        )}

        <div className="pos-wz-tot">
          <div><span>Sub - Total</span><b className="num">{(totales.total - totales.isv_total).toFixed(2)}</b></div>
          <div><span>Impuesto</span><b className="num">{totales.isv_total.toFixed(2)}</b></div>
          <div><span>Descuento</span><b className="num">{Object.values(totales.descuentos_por_porcentaje).reduce((n, v) => n + v, 0).toFixed(2)}</b></div>
          <div className="gran"><span>Total</span><b className="num">{totales.total.toFixed(2)}</b></div>
        </div>
        {sinRtn && !rtnBloquea && <small style={{ color: 'var(--aviso)' }}>Recordatorio: venta mayor a L {umbral.toLocaleString('es-HN')} sin RTN del cliente (no bloquea el cobro; queda en la bitácora). <button className="btn chico" style={{ marginLeft: 6 }} onClick={() => setModal({ tipo: 'cliente' })}>Elegir cliente</button></small>}
        {necesitaRtn && <small style={{ color: 'var(--aviso)' }}>Se necesita el RTN del cliente para cobrar (venta mayor a L {umbral.toLocaleString('es-HN')}). <button className="btn chico" style={{ marginLeft: 6 }} onClick={() => setModal({ tipo: 'cliente' })}>Elegir cliente</button></small>}

        <ErrorCaja error={error} />

        <div className="pos-acciones-fila">
          <button className="btn" onClick={nueva}>Nueva</button>
          <button className="btn" disabled={!puedeDeshacer} onClick={deshacer} title="Ctrl+Z">↶ Deshacer</button>
          <button className="btn" disabled={!hayLineas || ocupado || sinRed} onClick={dejarEnEspera} title="F8">En espera</button>
          <button className="btn" disabled={sinRed} onClick={() => setModal({ tipo: 'abiertas' })} title="F7">Abiertas{otrasAbiertas > 0 ? ` (${otrasAbiertas})` : ''}</button>
        </div>

        {/* Efectivo y Tarjeta en extremos opuestos con un hueco ancho en medio: un toque mal apuntado cae en el vacío, nunca en el botón de al lado. */}
        <div className="pos-botones-cobro">
          <button className="boton-cobro efectivo" disabled={cobroBloqueado} onClick={() => pagoInstantaneo('efectivo')}><Icono n="dinero" tam={24} />EFECTIVO<kbd>F2</kbd></button>
          <span className="pos-cobro-separador" aria-hidden="true" />
          <button className="boton-cobro tarjeta" disabled={cobroBloqueado || sinRed} title={sinRed ? 'No disponible sin conexión' : undefined} onClick={() => pagoInstantaneo('tarjeta')}><Icono n="pos" tam={24} />TARJETA<kbd>F3</kbd></button>
        </div>
        {cobrando && <small className="centro">Procesando…</small>}
        <button className="btn chico pos-btn-mas" disabled={!hayLineas || bloqueoFiscal || faltaCarne || cobrando || sinRed} onClick={abrirMasPagos}>Más formas de pago <kbd>F6</kbd></button>
      </aside>

      {modal?.tipo === 'opciones' && (
        <OpcionesModal producto={modal.producto} grupos={gruposDe(modal.producto)} inicial={modal.editar} onCerrar={() => setModal(null)}
          onListo={(r) => {
            if (modal.editar) setOrden((o) => ({ ...o, lineas: o.lineas.map((l) => (l.key === modal.editar.key ? { ...l, opciones: r.opciones, notas: r.notas, cantidad: r.cantidad } : l)) }));
            else agregar(modal.producto, { opciones: r.opciones, notas: r.notas, cantidad: r.cantidad });
            setModal(null);
          }} />
      )}
      {modal?.tipo === 'linea' && (() => {
        const l = orden.lineas.find((x) => x.key === modal.key);
        if (!l) return null;
        const unidad = l.producto.unidad === 'unidad';
        return (
          <Modal titulo={l.producto.nombre} tam="angosto" onCerrar={() => setModal(null)}
            pie={<><button className="btn peligro" onClick={() => { quitar(l.key); setModal(null); }}><Icono n="borrar" tam={16} /> Quitar de la orden</button><button className="btn primario" onClick={() => setModal(null)}>Listo</button></>}>
            {puede('pos:descuento') && (
              <div className="pos-linea-desc" role="radiogroup" aria-label="Descuento" style={{ marginBottom: 12 }}>
                {OPCIONES_DESCUENTO.map((o) => (
                  <button key={o.porcentaje} role="radio" aria-checked={l.descuento_porcentaje === o.porcentaje} className={`pos-chip-desc${l.descuento_porcentaje === o.porcentaje ? ' activo' : ''}`} onClick={() => fijarDescuento(l.key, o.porcentaje)}>{o.corta === '—' ? 'Sin descuento' : o.corta}</button>
                ))}
                {unidad && l.cantidad > 1 && <button className="pos-chip-desc separar" title="Separar una unidad para darle otro descuento" onClick={() => separarUnidad(l.key)}>÷ Separar 1</button>}
              </div>
            )}
            {l.producto.grupo_ids.length > 0 && <button className="btn" onClick={() => setModal({ tipo: 'opciones', producto: l.producto, editar: l })}>Extras y notas</button>}
          </Modal>
        );
      })()}
      {modal?.tipo === 'cantidad' && (() => {
        const l = orden.lineas.find((x) => x.key === modal.key);
        if (!l) return null;
        const decimal = !(l.producto.unidad === 'unidad' || l.producto.es_piedra);
        return <CantidadModal producto={l.producto} inicial={l.cantidad} decimal={decimal} onCerrar={() => setModal(null)} onListo={(n) => { fijarCantidad(l.key, n, decimal); setModal(null); }} />;
      })()}
      {modal?.tipo === 'peso' && <PesoModal producto={modal.producto} onCerrar={() => setModal(null)} onListo={(n) => { agregar(modal.producto, { cantidad: n }); setModal(null); }} />}
      {modal?.tipo === 'cliente' && <ClienteModal actual={orden.cliente} puedeCrear={puede('clientes:editar')} onCerrar={() => setModal(null)} onElegir={(c) => { setOrden((o) => ({ ...o, cliente: c })); setModal(null); }} />}
      {modal?.tipo === 'abiertas' && <AbiertasModal sucursalId={sucursal.id} actualId={orden.id} onCerrar={() => setModal(null)} onElegir={abrirOrden} />}
      {modal?.tipo === 'movimiento' && <MovimientoCaja sucursal={sucursal} onCerrar={() => setModal(null)} onListo={() => { setModal(null); cargarTurno(); }} />}
      {modal?.tipo === 'cerrar' && <CerrarTurno sucursal={sucursal} turno={turno} resumen={resumenTurno} empresa={contexto.empresa} cajero={usuario?.nombre} onCerrar={() => setModal(null)} onCerrado={() => { setModal(null); setTurno(null); reiniciar(); cargarTurno(); }} />}
      {modal?.tipo === 'efectivo' && <CobroEfectivoModal total={totales.total} ocupado={cobrando} error={errCobro} sinConexion={sinRed} onCerrar={() => setModal(null)} onCobrar={cobrarEfectivoRecibido} />}
      {modal?.tipo === 'cobro' && <CobroModal total={totales.total} formas={cat.formas_pago} cliente={orden.cliente} ocupado={cobrando} error={errCobro} requiereRtn={necesitaRtn} avisoRtn={sinRtn && !rtnBloquea} umbralRtn={umbral} onCerrar={() => setModal(null)} onCobrar={confirmarPago} />}
      {modal?.tipo === 'ayuda' && <AyudaAtajos onCerrar={() => setModal(null)} />}
      {modal?.tipo === 'cola' && <ColaModal puedeDescartar={puede('pos:anular')} sucursalId={sucursal.id} onCerrar={() => setModal(null)} />}
      {modal?.tipo === 'servicio' && (
        <Modal titulo="¿Cómo se consume?" onCerrar={() => {}} tam="angosto">
          <div className="pos-servicio">
            <button className="btn primario grande" autoFocus onClick={() => { setOrden((o) => ({ ...o, tipo_orden: 'aqui' })); setModal(null); setTimeout(() => buscadorRef.current?.focus(), 50); }}>Comer aquí</button>
            <button className="btn primario grande" onClick={() => { setOrden((o) => ({ ...o, tipo_orden: 'llevar' })); setModal(null); setTimeout(() => buscadorRef.current?.focus(), 50); }}>Para llevar</button>
          </div>
        </Modal>
      )}

      {modal?.tipo === 'descartar' && (
        <MotivoModal titulo="Descartar la orden" texto="¿Por qué se descarta esta orden? Los productos se pierden y queda registrado." opciones={MOTIVOS_DESCARTE} etiquetaBoton="Descartar orden" peligro
          onCerrar={() => setModal(null)} onListo={descartarConMotivo} />
      )}

      {avisoStock && <AvisoSinStock faltantes={avisoStock.faltantes} bloqueante={avisoStock.bloqueante} onCancelar={() => setAvisoStock(null)} onContinuar={() => { const p = avisoStock.pagos; setAvisoStock(null); confirmarPago(p, true); }} />}
      {recibo && (
        <Modal titulo={recibo.offline ? 'Venta guardada sin conexión' : recibo.es_borrador_fiscal ? 'Orden registrada' : 'Factura emitida'} onCerrar={() => { setRecibo(null); buscadorRef.current?.focus(); }} tam="angosto"
          pie={<><button className="btn" onClick={() => repetirUltima()}>Repetir pedido</button><button className="btn primario grande" autoFocus onClick={() => { setRecibo(null); buscadorRef.current?.focus(); }}>Nueva venta (Enter)</button></>}>
          <div className="centro" style={{ display: 'grid', gap: 6 }}>
            <div className="kpi acento"><div className="etq">Total</div><div className="val">{lempiras(recibo.total)}</div></div>
            <div className="kpi" style={{ borderColor: recibo.cambio > 0 ? 'var(--ok)' : undefined }}><div className="etq">Cambio a entregar</div><div className="val" style={{ color: recibo.cambio > 0 ? 'var(--ok)' : undefined, fontSize: '3.2rem' }}>{lempiras(recibo.cambio ?? 0)}</div></div>
            {recibo.offline ? (
              <>
                <small className="num">Comprobante provisional {recibo.provisional}</small>
                <div className="aviso-caja">No es factura: la factura se emite sola cuando vuelva el internet ({resumenCola.total} venta{resumenCola.total === 1 ? '' : 's'} por sincronizar).</div>
              </>
            ) : (
              <>
                <small>Orden #{recibo.ticket_dia}{recibo.nombre_orden ? ` · ${recibo.nombre_orden}` : ''} · {recibo.cliente?.nombre ?? 'Consumidor Final'}</small>
                <small className="num">Factura {recibo.numero_factura}</small>
              </>
            )}
            {recibo.es_borrador_fiscal && <span className="chip aviso" style={{ justifySelf: 'center' }}>BORRADOR · sin valor fiscal</span>}
            {recibo.aviso_rtn && <div className="aviso-caja mal">{recibo.aviso_rtn}</div>}
            {recibo.faltantes_inventario?.length > 0 && <div className="aviso-caja mal">Se facturó sin existencia suficiente: {recibo.faltantes_inventario.map((f) => f.producto).join(', ')}. Revisa el inventario.</div>}
          </div>
          <div className="fila" style={{ justifyContent: 'center' }}>
            <button className="btn" disabled={ocupado} onClick={() => (recibo.impresa && !recibo.offline ? setModal({ tipo: 'reimprimir' }) : imprimirRecibo())}><Icono n="impresora" tam={16} /> {recibo.impresa ? 'Reimprimir ticket' : 'Imprimir ticket'}</button>
            {!recibo.offline && <button className="btn" onClick={() => verPdf(recibo.id).catch((e) => avisar(e.message, 'mal'))}>Ver PDF carta</button>}
          </div>
        </Modal>
      )}
      {modal?.tipo === 'reimprimir' && (
        <MotivoModal titulo="Reimprimir el ticket" texto="Saldrá marcado como COPIA. Indica el motivo (queda en la bitácora)." opciones={MOTIVOS_REIMPRESION} etiquetaBoton="Reimprimir" ocupado={ocupado}
          onCerrar={() => setModal(null)} onListo={imprimirRecibo} />
      )}
    </div>
  );
}
