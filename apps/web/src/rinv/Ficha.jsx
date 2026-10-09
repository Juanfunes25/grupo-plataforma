import { useEffect, useRef, useState } from 'react';
import { lempiras } from '@grupo/shared';
import { useSesion } from '../sesion.jsx';
import { Campo, Modal, useAviso } from '../ui/kit.jsx';
import { escribirConCola, idCliente, rget, rpatch, rpost } from './api.js';
import { CATEGORIAS_FABRICA, SIN_CATEGORIA, UNIDADES_PRESET, cantidad as fmt, cuando, fechaCorta, haceCuanto } from './comun.jsx';
import Escaner from './Escaner.jsx';
import { svgCode128 } from './codigo128.js';

const SALTOS = [1, 5, 10, 25, 50];
const MOTIVOS = ['Compra', 'Merma', 'Traspaso', 'Conteo físico'];
const VENTANA_DESHACER_MS = 8000;

/** Etiqueta imprimible con el código de barras (Code 128), generada aquí mismo. */
function CodigoImprimible({ nombre, codigo }) {
  const svg = svgCode128(codigo);
  function imprimir() {
    const w = window.open('', '_blank', 'width=420,height=320');
    if (!w) return;
    w.document.write(`<html><head><title>${nombre.replace(/</g, '&lt;')}</title></head><body style="text-align:center;font-family:sans-serif"><p>${nombre.replace(/</g, '&lt;')}</p>${svg ?? ''}</body></html>`);
    w.document.close(); w.focus(); w.print();
  }
  return (
    <div className="rv-barcode">
      {svg ? <div dangerouslySetInnerHTML={{ __html: svg }} /> : <b>{codigo}</b>}
      <button type="button" className="btn chico fantasma" style={{ color: '#000' }} onClick={imprimir}>🖨️ Imprimir etiqueta</button>
    </div>
  );
}

/**
 * Ficha completa de UN insumo, como pantalla propia: lo que se hace todos los días (sumar o restar) es lo primero y lo más
 * grande, con saltos rápidos y un «Deshacer» de 8 s. El código de barras es el atajo para no confundir nombres parecidos.
 * Categoría, límites, unidad y «es equipo» —datos que se tocan una vez— viven detrás de «Más detalles». Sirve para fábrica
 * y para una sucursal puntual; `ambito` decide a qué endpoints habla.
 */
export default function Ficha({ ambito, sucursalId, insumo, onVolver, onEscanearSiguiente, onAnterior, onSiguiente, posicion, onCambio }) {
  const { puede } = useSesion();
  const avisar = useAviso();
  const fab = ambito === 'fabrica';
  const base = fab ? `/fabrica/${insumo.id}` : `/sucursal/${sucursalId}/${insumo.id}`;
  const verCostos = fab && puede('rep:costeo');

  const [stock, setStock] = useState(fab ? insumo.stock_actual : insumo.cantidad);
  const [actualizado, setActualizado] = useState(fab ? insumo.stock_actualizado_en : insumo.actualizado_en);
  const [esEquipo, setEsEquipo] = useState(!!insumo.es_equipo);
  const [codigo, setCodigo] = useState(insumo.codigo_barras || '');
  const [categoria, setCategoria] = useState(insumo.categoria || '');
  const [min, setMin] = useState(insumo.stock_minimo ?? null);
  const [max, setMax] = useState(insumo.stock_maximo ?? null);
  const [unidad, setUnidad] = useState(insumo.unidad || (fab ? 'unidad' : 'u'));
  const [cant, setCant] = useState('');
  const [motivo, setMotivo] = useState('');
  const [absoluto, setAbsoluto] = useState(false);
  const [valAbs, setValAbs] = useState(''); const [motAbs, setMotAbs] = useState('');
  const [historial, setHistorial] = useState(undefined);
  const [verHist, setVerHist] = useState(false);
  const [mas, setMas] = useState(false);
  const [editCodigo, setEditCodigo] = useState(false);
  const [catEd, setCatEd] = useState(categoria); const [codEd, setCodEd] = useState(codigo);
  const [minEd, setMinEd] = useState(min ?? ''); const [maxEd, setMaxEd] = useState(max ?? ''); const [verMax, setVerMax] = useState(max != null);
  const [unidEd, setUnidEd] = useState(unidad); const [pesoEd, setPesoEd] = useState(insumo.peso_unitario ?? '');
  const [escaneando, setEscaneando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [modoConteo, setModoConteo] = useState(false);
  const [confirmarArchivar, setConfirmarArchivar] = useState(false);
  const [ultima, setUltima] = useState(null);
  const [deshacer, setDeshacer] = useState(null);
  const [precios, setPrecios] = useState(null);
  const [precioNuevo, setPrecioNuevo] = useState('');
  const t = useRef(null);
  useEffect(() => () => clearTimeout(t.current), []);

  const sinStock = stock === null || stock === undefined;
  const bajo = !sinStock && (Number(stock) === 0 || (min != null && Number(stock) < Number(min)));
  const cantOk = Number.isFinite(Number(cant)) && Number(cant) > 0;
  const saltar = (d) => setCant((v) => { const n = (Number(v) || 0) + d; return n <= 0 ? '' : String(n); });

  function prepararDeshacer(fn, etiqueta) {
    clearTimeout(t.current); setDeshacer({ fn, etiqueta });
    t.current = setTimeout(() => setDeshacer(null), VENTANA_DESHACER_MS);
  }
  const refrescar = () => { setActualizado(new Date().toISOString()); setHistorial(undefined); onCambio?.(); };

  async function mover(tipo, c, mot, esDeshacer = false) {
    setOcupado(true);
    try {
      const r = await escribirConCola('PATCH', `${base}/movimiento`, { tipo, cantidad: c, motivo: mot || undefined, cliente_id: idCliente() });
      if (r.offline) {
        setStock((s) => Math.round(((Number(s) || 0) + (tipo === 'entrada' ? c : -c)) * 100) / 100);
        avisar('Sin señal: se guardó en el equipo y se envía solo');
      } else {
        setStock(fab ? r.stock_actual : r.cantidad);
        avisar(esDeshacer ? 'Deshecho ✓' : tipo === 'entrada' ? `✓ Entrada de ${fmt(c)}` : `✓ Salida de ${fmt(c)}`);
      }
      refrescar();
      if (esDeshacer) { setDeshacer(null); setUltima({ texto: `Deshecho: ${tipo === 'entrada' ? '+' : '−'}${fmt(c)} ${unidad}` }); }
      else {
        setUltima({ texto: `${tipo === 'entrada' ? '+' : '−'}${fmt(c)} ${unidad}` });
        prepararDeshacer(() => mover(tipo === 'entrada' ? 'salida' : 'entrada', c, 'Deshecho: corrige movimiento anterior', true), `${tipo === 'entrada' ? '➕' : '➖'} ${fmt(c)} ${unidad} registrado`);
      }
      return true;
    } catch (e) { avisar(e.message, 'mal'); return false; } finally { setOcupado(false); }
  }
  async function aplicar(tipo) {
    if (!cantOk) return;
    if (await mover(tipo, Number(cant), motivo.trim())) { setCant(''); setMotivo(''); }
  }

  async function guardarAbsoluto() {
    const v = Number(valAbs);
    if (!Number.isFinite(v) || v < 0 || valAbs === '') return;
    const antes = stock;
    setOcupado(true);
    try {
      const cuerpo = fab ? { stock_actual: v, motivo: motAbs.trim() || undefined } : { cantidad: v, motivo: motAbs.trim() || undefined };
      await escribirConCola('PATCH', base, cuerpo);
      setStock(v); avisar('Total corregido ✓'); setUltima({ texto: `Total corregido a ${fmt(v)} ${unidad}` });
      setAbsoluto(false); setValAbs(''); setMotAbs(''); refrescar();
      if (antes !== null && antes !== undefined) {
        prepararDeshacer(async () => {
          try { await escribirConCola('PATCH', base, fab ? { stock_actual: antes, motivo: 'Deshecho: corrige ajuste anterior' } : { cantidad: antes, motivo: 'Deshecho: corrige ajuste anterior' }); setStock(antes); setDeshacer(null); avisar('Deshecho ✓'); refrescar(); } catch (e) { avisar(e.message, 'mal'); }
        }, `✏️ Total corregido a ${fmt(v)} ${unidad}`);
      }
    } catch (e) { avisar(e.message, 'mal'); } finally { setOcupado(false); }
  }

  async function guardar(fn, ok) { setOcupado(true); try { await fn(); avisar(ok); onCambio?.(); } catch (e) { avisar(e.message, 'mal'); } finally { setOcupado(false); } }

  async function guardarCodigo(c, forzar) {
    setOcupado(true);
    try {
      await rpatch(`${base}/codigo-barras`, { codigo_barras: c, forzar });
      setCodigo(c || ''); setCodEd(c || ''); setEditCodigo(false); avisar(c ? 'Código guardado ✓' : 'Código quitado'); onCambio?.();
    } catch (e) {
      if (e.status === 409 && e.faltantes?.nombre && window.confirm(`${e.message}. ¿Reasignarlo a este insumo?`)) { setOcupado(false); return guardarCodigo(c, true); }
      avisar(e.message, 'mal');
    } finally { setOcupado(false); }
  }

  async function abrirHistorial() {
    const abrir = !verHist; setVerHist(abrir);
    if (abrir && historial === undefined) { try { setHistorial(await rget(`${base}/movimientos`)); } catch { setHistorial([]); } }
  }
  async function cargarPrecios() { try { setPrecios(await rget(`/fabrica/${insumo.id}/precios`)); } catch (e) { avisar(e.message, 'mal'); } }

  return (
    <div className={`pagina ${modoConteo ? 'rv-conteo' : ''}`}>
      <div className="fila espacio">
        <button className="btn fantasma" onClick={onVolver}>← Volver</button>
        <h1 style={{ flex: 1, textAlign: 'center', fontSize: '1.5rem', minWidth: 0 }}>{insumo.nombre}{esEquipo ? ' 🔧' : ''}</h1>
        <span className={`chip ${sinStock ? '' : bajo ? 'mal' : 'ok'}`}>{sinStock ? 'sin cargar' : `${fmt(stock)} ${unidad}`}</span>
      </div>
      {(onAnterior || onSiguiente) && (
        <div className="fila espacio">
          <button className="btn chico" disabled={!onAnterior} onClick={onAnterior}>‹ Anterior</button>
          {posicion && <span className="tenue">{posicion.actual} de {posicion.total}</span>}
          <button className="btn chico" disabled={!onSiguiente} onClick={onSiguiente}>Siguiente ›</button>
        </div>
      )}
      <div className="tenue centro">🏷️ {categoria || SIN_CATEGORIA}{actualizado ? ` · actualizado ${haceCuanto(actualizado)}` : ''}{insumo.descripcion ? ` · ${insumo.descripcion}` : ''}</div>

      <div className="tarjeta rv-stock">
        <div className={`grande ${sinStock ? '' : bajo ? 'mal' : 'ok'}`}>{sinStock ? '—' : fmt(stock)}{!sinStock && <small style={{ fontSize: '1.1rem' }}> {unidad}</small>}</div>
        <div className="tenue">en stock ahora{min != null ? ` · mínimo ${fmt(min)}` : ''}</div>
        <div className="rv-paso">
          <button className="btn" aria-label="Restar 1" onClick={() => saltar(-1)}>−</button>
          <input type="number" min="0" step="any" inputMode="decimal" placeholder="0" value={cant} onChange={(e) => setCant(e.target.value)} />
          <button className="btn" aria-label="Sumar 1" onClick={() => saltar(1)}>+</button>
        </div>
        <div className="rv-saltos">{SALTOS.map((n) => <button key={n} className="btn chico" onClick={() => saltar(n)}>+{n}</button>)}</div>
        {!modoConteo && (
          <>
            <input placeholder="Motivo (opcional, ej: compra, merma)" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
            <div className="rv-saltos">{MOTIVOS.map((m) => <button key={m} className="btn chico fantasma" onClick={() => setMotivo(m)}>{m}</button>)}</div>
          </>
        )}
        <div className="fila" style={{ marginTop: 8 }}>
          <button className="btn primario grande" style={{ flex: 1 }} disabled={ocupado || !cantOk} onClick={() => aplicar('entrada')}>➕ Agregar</button>
          <button className="btn peligro grande" style={{ flex: 1 }} disabled={ocupado || !cantOk} onClick={() => aplicar('salida')}>➖ Sacar</button>
        </div>
      </div>

      {ultima && (
        <div className="aviso-caja ok fila espacio">
          <span>✓ {ultima.texto}</span>
          {deshacer && <button className="btn chico" disabled={ocupado} onClick={deshacer.fn}>↩ Deshacer</button>}
        </div>
      )}
      <div className="fila">
        {onEscanearSiguiente && <button className="btn" style={{ flex: 1 }} onClick={onEscanearSiguiente}>📷 Escanear el próximo</button>}
        <button className={`btn ${modoConteo ? 'primario' : ''}`} style={{ flex: 1 }} onClick={() => setModoConteo((v) => !v)} title="Número más grande y menos texto, para contar seguido">{modoConteo ? '✕ Salir de modo conteo' : '🖐️ Modo conteo'}</button>
      </div>

      {!modoConteo && (
        <>
          <div className="tarjeta rejilla">
            <h3>📊 Código de barras</h3>
            {codigo && !editCodigo ? (
              <>
                <CodigoImprimible nombre={insumo.nombre} codigo={codigo} />
                <button className="btn chico" onClick={() => setEditCodigo(true)}>Cambiar código</button>
              </>
            ) : (
              <>
                {!codigo && (
                  <div className="rejilla">
                    <button className="btn primario" onClick={() => setEscaneando(true)}>📷 Escanear y asignar código</button>
                    <button className="btn" onClick={() => { const c = `INT${insumo.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`; setCodEd(c); guardarCodigo(c, false); }}>🖨️ Generar código interno (para imprimir)</button>
                  </div>
                )}
                <div className="fila">
                  <input style={{ flex: 1 }} placeholder="Código de barras" value={codEd} onChange={(e) => setCodEd(e.target.value)} />
                  <button className="btn" onClick={() => setEscaneando(true)} aria-label="Escanear">📷</button>
                  <button className="btn primario" disabled={ocupado} onClick={() => guardarCodigo(codEd.trim() || null, false)}>Guardar</button>
                </div>
              </>
            )}
          </div>

          <button className="btn" onClick={() => setMas((v) => !v)}>⚙️ {mas ? 'Ocultar más detalles' : 'Más detalles (categoría, unidad, límites)'}</button>
          {mas && (
            <div className="tarjeta rejilla">
              <Campo etiqueta="Categoría">
                <div className="fila"><input list="rv-cats" style={{ flex: 1 }} value={catEd} onChange={(e) => setCatEd(e.target.value)} placeholder="Categoría" />
                  <button className="btn" disabled={ocupado} onClick={() => guardar(async () => { await rpatch(`${base}/categoria`, { categoria: catEd }); setCategoria(catEd.trim()); }, 'Categoría guardada ✓')}>Guardar</button></div>
                <datalist id="rv-cats">{CATEGORIAS_FABRICA.map((c) => <option key={c} value={c} />)}</datalist>
              </Campo>
              <Campo etiqueta="Mínimo de stock (avisa cuando baja de aquí)">
                <div className="fila">
                  <input type="number" min="0" step="any" style={{ flex: 1 }} placeholder="Mínimo" value={minEd} onChange={(e) => setMinEd(e.target.value)} />
                  {verMax && <input type="number" min="0" step="any" style={{ flex: 1 }} placeholder="Máximo" value={maxEd} onChange={(e) => setMaxEd(e.target.value)} />}
                  <button className="btn" disabled={ocupado} onClick={() => guardar(async () => {
                    const a = minEd === '' ? null : Number(minEd); const b = maxEd === '' ? null : Number(maxEd);
                    await rpatch(`${base}/limites`, { stock_minimo: a, stock_maximo: b }); setMin(a); setMax(b);
                  }, 'Límites guardados ✓')}>Guardar</button>
                </div>
                {!verMax && <button className="btn chico fantasma" onClick={() => setVerMax(true)}>+ también quiero un máximo</button>}
              </Campo>
              <Campo etiqueta="Unidad de medida">
                <div className="fila">
                  <select style={{ flex: 1 }} value={unidEd} onChange={(e) => setUnidEd(e.target.value)}>
                    {(UNIDADES_PRESET.includes(unidEd) ? UNIDADES_PRESET : [unidEd, ...UNIDADES_PRESET]).map((u) => <option key={u}>{u}</option>)}
                  </select>
                  <button className="btn" disabled={ocupado} onClick={() => guardar(async () => {
                    const u = unidEd.trim() || (fab ? 'unidad' : 'u');
                    await rpatch(`${base}/unidad`, fab ? { unidad: u, peso_unitario: pesoEd === '' ? null : Number(pesoEd) } : { unidad: u }); setUnidad(u);
                  }, 'Unidad guardada ✓')}>Guardar</button>
                </div>
              </Campo>
              {fab && !['kg', 'l'].includes(unidEd.trim().toLowerCase()) && (
                <Campo etiqueta={`Cuánto pesa cada ${unidEd.trim() || 'unidad'} (kg)`} ayuda="Se guarda junto con la unidad. Sin este dato el insumo no se puede sumar al valor del inventario.">
                  <input type="number" min="0" step="any" placeholder="Ej: 4.5" value={pesoEd} onChange={(e) => setPesoEd(e.target.value)} />
                </Campo>
              )}
              <Campo etiqueta="Tipo de insumo" ayuda={esEquipo ? 'No se agota: no entra en alertas de quiebre ni de vencimiento.' : 'Normal: cuenta stock y entra en las alertas.'}>
                <div className="fila">
                  <button className={`btn ${!esEquipo ? 'primario' : ''}`} disabled={ocupado} onClick={() => esEquipo && guardar(async () => { await rpatch(`${base}/equipo`, { es_equipo: false }); setEsEquipo(false); }, 'Ya no es equipo ✓')}>Insumo normal</button>
                  <button className={`btn ${esEquipo ? 'primario' : ''}`} disabled={ocupado} onClick={() => !esEquipo && guardar(async () => { await rpatch(`${base}/equipo`, { es_equipo: true }); setEsEquipo(true); }, 'Marcado como equipo ✓')}>🔧 Equipo</button>
                  {(!fab || verCostos) && <button className="btn peligro" disabled={ocupado} onClick={() => setConfirmarArchivar(true)}>🗄️ Archivar</button>}
                </div>
              </Campo>
            </div>
          )}

          {verCostos && (
            <div className="tarjeta rejilla">
              <div className="fila espacio"><h3>💲 Precio por kilo</h3><button className="btn chico" onClick={cargarPrecios}>Ver historial</button></div>
              <div className="fila">
                <input type="number" min="0" step="any" style={{ flex: 1 }} placeholder="Lempiras por kg (por envase si es Ristoris)" value={precioNuevo} onChange={(e) => setPrecioNuevo(e.target.value)} />
                <button className="btn primario" disabled={ocupado || precioNuevo === ''} onClick={() => guardar(async () => { await rpost(`/fabrica/${insumo.id}/precio`, { lps_kg: Number(precioNuevo) }); setPrecioNuevo(''); setPrecios(await rget(`/fabrica/${insumo.id}/precios`)); }, 'Precio registrado ✓')}>Registrar</button>
              </div>
              {precios && (precios.length ? precios.map((p) => <div key={p.id} className="fila espacio tenue"><span>{fechaCorta(p.fecha_vigencia)} · {p.fuente === 'factura_mec3' ? 'factura Mec3' : 'manual'}</span><b>{lempiras(p.lps_kg)}</b></div>) : <div className="tenue">Sin precio cargado.</div>)}
            </div>
          )}

          <div className="fila">
            <button className="btn" onClick={() => { setAbsoluto((v) => !v); setValAbs(''); setMotAbs(''); }}>✏️ Corregir total</button>
            <button className="btn" onClick={abrirHistorial}>🕘 {verHist ? 'Ocultar historial' : 'Ver historial'}</button>
          </div>
          {absoluto && (
            <div className="tarjeta rejilla">
              <div className="fila"><input type="number" min="0" step="any" inputMode="decimal" autoFocus style={{ flex: 1 }} placeholder="Cantidad total" value={valAbs} onChange={(e) => setValAbs(e.target.value)} />
                <button className="btn primario" disabled={ocupado} onClick={guardarAbsoluto}>✓ Guardar total</button></div>
              <input placeholder="Motivo (ej: conteo físico mensual, se rompieron)" value={motAbs} onChange={(e) => setMotAbs(e.target.value)} />
            </div>
          )}
          {verHist && (
            <div className="tarjeta pad0">
              {historial === undefined ? <div className="vacio">Cargando…</div> : historial.length === 0 ? <div className="vacio">Sin movimientos todavía.</div>
                : historial.map((m) => (
                  <div key={m.id} className="rv-fila"><div className="info"><b>{m.tipo === 'entrada' ? '➕' : '➖'} {fmt(m.cantidad)}{m.motivo ? ` · ${m.motivo}` : ''}</b><span className="tenue">{m.usuario_nombre || m.rol} · saldo {fmt(m.saldo_resultante)}</span></div><span className="tenue">{cuando(m.creado_en)}</span></div>
                ))}
            </div>
          )}
        </>
      )}

      {escaneando && <Escaner onDetectado={(c) => { setEscaneando(false); guardarCodigo(c, false); }} onCerrar={() => setEscaneando(false)} />}
      {confirmarArchivar && (
        <Modal titulo="Archivar insumo" onCerrar={() => setConfirmarArchivar(false)} pie={<><button className="btn" onClick={() => setConfirmarArchivar(false)}>Cancelar</button>
          <button className="btn peligro" onClick={async () => { setConfirmarArchivar(false); try { await rpatch(fab ? `${base}/archivar` : `${base}/archivar`, { archivar: true }); avisar('Insumo archivado ✓'); onCambio?.(); onVolver(); } catch (e) { avisar(e.message, 'mal'); } }}>Sí, archivar</button></>}>
          ¿Archivar «{insumo.nombre}»? Deja de aparecer en la lista, pero conserva su historial.
        </Modal>
      )}
    </div>
  );
}
