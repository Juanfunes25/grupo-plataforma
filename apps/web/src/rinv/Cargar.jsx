import { useMemo, useState } from 'react';
import { Estado, useAccion, useAviso, useDatos } from '../ui/kit.jsx';
import { ErrorApi } from '../api.js';
import { escribirConCola, idCliente, leerCache, guardarCache, rget, rpost } from './api.js';
import { Chip, cantidad as fmt, conUnidad, hoyIso } from './comun.jsx';
import Escaner from './Escaner.jsx';

/** Carga del pedido de Mec3, contado en botes/bolsas (así es la factura). El peso de cada bote se recuerda para el próximo pedido. */
export function CargaLoteMec3({ insumos, onGuardar }) {
  const items = useMemo(() => insumos.filter((i) => i.tipo === 'mec3').sort((a, b) => a.nombre.localeCompare(b.nombre)), [insumos]);
  const [unidades, setUnidades] = useState({}); const [pesos, setPesos] = useState({});
  const [motivo, setMotivo] = useState('Pedido Mec3'); const [fecha, setFecha] = useState(hoyIso()); const [q, setQ] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const pesoDe = (i) => (pesos[i.id] !== undefined ? pesos[i.id] : i.peso_unitario ?? '');
  const conValor = items.filter((i) => Number(unidades[i.id]) > 0);
  const sinPeso = conValor.filter((i) => !(Number(pesoDe(i)) > 0));
  const mostrados = q.trim() ? items.filter((i) => i.nombre.toUpperCase().includes(q.trim().toUpperCase())) : items;
  async function guardar() {
    if (!conValor.length || sinPeso.length) return;
    setOcupado(true);
    try { await onGuardar(conValor.map((i) => ({ id: i.id, unidades: Number(unidades[i.id]), peso_unitario: Number(pesoDe(i)) })), motivo.trim() || undefined, fecha); setUnidades({}); } finally { setOcupado(false); }
  }
  if (!items.length) return <div className="vacio">Todavía no hay insumos Mec3 en el catálogo.</div>;
  return (
    <div className="rejilla">
      <p className="tenue">Cuenta botes/bolsas, no kilos. Lo que dejes en blanco no se toca.</p>
      <input placeholder="Buscar para filtrar la lista…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="tarjeta pad0" style={{ maxHeight: '55vh', overflow: 'auto' }}>
        {mostrados.map((i) => {
          const peso = pesoDe(i); const sub = Number(unidades[i.id]) > 0 && Number(peso) > 0 ? Number(unidades[i.id]) * Number(peso) : null;
          return (
            <div className="rv-fila" key={i.id} style={{ flexWrap: 'wrap' }}>
              <div className="info"><b>{i.nombre}</b><span className="tenue">{i.stock_actual === null ? 'sin cargar' : `hay ${conUnidad(i.stock_actual, i.unidad)}`}{sub !== null && ` · = ${fmt(sub)} ${i.unidad}`}</span></div>
              <div className="rv-fila-cant">
                <input type="number" min="0" step="1" inputMode="numeric" placeholder="botes" title="Cuántos botes/bolsas llegaron" value={unidades[i.id] ?? ''} onChange={(e) => setUnidades((u) => ({ ...u, [i.id]: e.target.value }))} />
                <span className="tenue">×</span>
                <input type="number" min="0" step="any" inputMode="decimal" placeholder="kg/bote" title="Cuántos kg trae cada bote o bolsa" value={peso} onChange={(e) => setPesos((p) => ({ ...p, [i.id]: e.target.value }))} />
              </div>
              {Number(unidades[i.id]) > 0 && !(Number(peso) > 0) && <div className="tenue" style={{ width: '100%', color: 'var(--peligro)' }}>Falta cuántos kg trae cada bote/bolsa</div>}
            </div>
          );
        })}
      </div>
      <div className="fila"><input type="date" value={fecha} max={hoyIso()} onChange={(e) => setFecha(e.target.value)} title="Fecha en que llegó el pedido (define cuándo vence: 1 año después)" style={{ flex: 1 }} />
        <input style={{ flex: 2 }} placeholder="Motivo (ej: Pedido Mec3 agosto)" value={motivo} onChange={(e) => setMotivo(e.target.value)} /></div>
      <p className="tenue">📅 Cada insumo Mec3 vence al año de esta fecha — te avisamos antes.</p>
      <button className="btn primario grande" disabled={ocupado || !conValor.length || sinPeso.length > 0} onClick={guardar}>
        {!conValor.length ? 'Escribe al menos un bote/bolsa' : sinPeso.length ? `Falta el peso de ${sinPeso.length} insumo${sinPeso.length === 1 ? '' : 's'}` : `➕ Registrar entrada de ${conValor.length}`}
      </button>
    </div>
  );
}

/**
 * Pedido escrito o pegado desde una hoja («Pasta pistacho 8x4,5kg»): se interpreta, se empareja con el catálogo y la persona
 * VERIFICA antes de cargar. Nada se guarda hasta tocar «Cargar»; lo que no calza con el catálogo no se carga.
 * (La lectura automática de una foto o PDF con IA no está conectada: este es el camino sin IA.)
 */
export function PedidoDeTexto({ onCargar }) {
  const avisar = useAviso();
  const [texto, setTexto] = useState(''); const [res, setRes] = useState(null);
  const [edit, setEdit] = useState({}); const [fuera, setFuera] = useState({}); const [ocupado, setOcupado] = useState(false);
  async function leer() {
    setOcupado(true);
    try { setRes(await rpost('/fabrica/leer-pedido', { texto })); setEdit({}); setFuera({}); } catch (e) { avisar(e.message, 'mal'); } finally { setOcupado(false); }
  }
  const val = (i, it, c) => (edit[i]?.[c] !== undefined ? edit[i][c] : it[c] ?? '');
  const ok = (res?.items ?? []).map((it, i) => ({ it, i })).filter(({ it }) => it.insumo_id);
  const sin = (res?.items ?? []).filter((it) => !it.insumo_id);
  const listos = ok.filter(({ i }) => !fuera[i]).map(({ it, i }) => ({ id: it.insumo_id, unidades: Number(val(i, it, 'unidades')), peso_unitario: Number(val(i, it, 'peso_unitario')) })).filter((x) => x.unidades > 0 && x.peso_unitario > 0);
  const incompletos = ok.filter(({ it, i }) => !fuera[i] && !(Number(val(i, it, 'unidades')) > 0 && Number(val(i, it, 'peso_unitario')) > 0)).length;
  if (!res) {
    return (
      <div className="rejilla">
        <p className="tenue">Pega aquí las líneas del pedido o de la factura, una por producto: <code>Nombre  8x4,5kg</code> (8 botes de 4,5 kg), <code>Nombre; 8; 4.5</code>. Tú revisas los números antes de cargarlos.</p>
        <textarea rows={8} value={texto} onChange={(e) => setTexto(e.target.value)} placeholder={'Pasta pistacho 8x4,5kg\nBase alba 2+1x5kg'} />
        <button className="btn primario" disabled={ocupado || !texto.trim()} onClick={leer}>Leer el pedido</button>
      </div>
    );
  }
  return (
    <div className="rejilla">
      <div className="aviso-caja"><b>Revisa antes de cargar.</b> Corrige lo que esté mal y quita lo que no quieras cargar.</div>
      {ok.map(({ it, i }) => (
        <div className="rv-fila tarjeta" key={i} style={{ opacity: fuera[i] ? 0.45 : 1, flexWrap: 'wrap' }}>
          <div className="info"><b>{it.nombre_catalogo}</b><span className="tenue">“{it.texto_crudo}” · <Chip tono={it.confianza === 'alta' ? 'ok' : it.confianza === 'media' ? 'aviso' : 'mal'}>{it.confianza}</Chip></span></div>
          <div className="rv-fila-cant">
            <input type="number" min="0" inputMode="numeric" placeholder="botes" value={val(i, it, 'unidades')} onChange={(e) => setEdit((p) => ({ ...p, [i]: { ...p[i], unidades: e.target.value } }))} />
            <span className="tenue">×</span>
            <input type="number" min="0" step="any" inputMode="decimal" placeholder="kg" value={val(i, it, 'peso_unitario')} onChange={(e) => setEdit((p) => ({ ...p, [i]: { ...p[i], peso_unitario: e.target.value } }))} />
            <button className={`btn chico ${fuera[i] ? '' : 'peligro'}`} onClick={() => setFuera((p) => ({ ...p, [i]: !p[i] }))}>{fuera[i] ? '↩' : '✕'}</button>
          </div>
        </div>
      ))}
      {!ok.length && <div className="vacio">No se reconoció ningún insumo del catálogo en ese texto.</div>}
      {sin.length > 0 && <div className="aviso-caja"><b>{sin.length} línea{sin.length === 1 ? '' : 's'} sin reconocer</b> — no coinciden con el catálogo y no se cargan: {sin.map((x) => x.nombre).join(', ')}.</div>}
      {incompletos > 0 && <div className="aviso-caja mal">{incompletos} línea{incompletos === 1 ? '' : 's'} sin botes o sin peso: complétalas o quítalas.</div>}
      <div className="fila">
        <button className="btn primario grande" style={{ flex: 1 }} disabled={ocupado || !listos.length} onClick={async () => { setOcupado(true); try { await onCargar(listos); setRes(null); setTexto(''); } finally { setOcupado(false); } }}>✓ Cargar {listos.length} insumo{listos.length === 1 ? '' : 's'}</button>
        <button className="btn" onClick={() => setRes(null)}>Descartar</button>
      </div>
    </div>
  );
}

/** Cargar el pedido que acaba de llegar: a mano, o pegando el texto del pedido. */
export function CargarPedido({ onCargado }) {
  const avisar = useAviso();
  const [modo, setModo] = useState('manual');
  const d = useDatos(async () => { try { const r = await rget('/fabrica'); guardarCache('fabrica', r); return r; } catch (e) { const c = leerCache('fabrica'); if (c?.datos) return c.datos; throw e; } }, []);
  async function guardar(items, motivo, fecha) {
    try {
      const body = { items: items.map((i) => ({ ...i, cliente_id: idCliente() })), motivo, fecha };
      const r = await escribirConCola('POST', '/fabrica/entradas-lote', body);
      avisar(r.offline ? 'Sin señal: se guardó en el equipo y se envía solo' : `✓ ${r.guardados} insumo${r.guardados === 1 ? '' : 's'} cargado${r.guardados === 1 ? '' : 's'}`);
      d.recargar(); onCargado?.();
    } catch (e) { avisar(e instanceof ErrorApi ? e.message : 'No se pudo cargar', 'mal'); throw e; }
  }
  return (
    <div className="rejilla">
      <div className="rv-pills">
        <button className={`btn ${modo === 'manual' ? 'primario' : ''}`} onClick={() => setModo('manual')}>✍️ A mano</button>
        <button className={`btn ${modo === 'texto' ? 'primario' : ''}`} onClick={() => setModo('texto')}>📋 Pegar texto del pedido</button>
      </div>
      <div className="tarjeta">
        <Estado d={d}>{(ins) => (modo === 'manual' ? <CargaLoteMec3 insumos={ins} onGuardar={(i, m, f) => guardar(i, m, f).catch(() => {})} />
          : <PedidoDeTexto onCargar={(items) => guardar(items, 'Pedido leído de texto', hoyIso())} />)}</Estado>
      </div>
    </div>
  );
}

/** Sacar de bodega todo junto: en la mañana se baja UNA vez y se saca todo. Todo o nada: si a uno no le alcanza, no sale nada. */
export function SacarDeBodega({ onSacado }) {
  const avisar = useAviso();
  const d = useDatos(async () => { try { const r = await rget('/fabrica'); guardarCache('fabrica', r); return r; } catch (e) { const c = leerCache('fabrica'); if (c?.datos) return c.datos; throw e; } }, []);
  const [q, setQ] = useState(''); const [elegidos, setElegidos] = useState([]); const [motivo, setMotivo] = useState('');
  const [escaneando, setEscaneando] = useState(false); const [sinStock, setSinStock] = useState(null);
  const [ejecutar, ocupado] = useAccion();
  const insumos = d.datos ?? [];
  const agregar = (i) => { setSinStock(null); setElegidos((a) => { const k = a.findIndex((e) => e.id === i.id); if (k !== -1) { const c = [...a]; c[k] = { ...c[k], cantidad: String(Number(c[k].cantidad || 0) + 1) }; return c; } return [...a, { id: i.id, nombre: i.nombre, unidad: i.unidad, stock: i.stock_actual, cantidad: '1', clienteId: idCliente() }]; }); };
  function alEscanear(codigo) {
    const i = insumos.find((x) => x.codigo_barras && String(x.codigo_barras) === String(codigo));
    if (!i) { avisar(`Ese código no está asignado a ningún insumo (${codigo})`, 'mal'); return; }
    agregar(i); avisar(`✓ ${i.nombre}`);
  }
  const sugerencias = q.trim() ? insumos.filter((i) => !i.es_equipo && i.nombre.toUpperCase().includes(q.trim().toUpperCase())).slice(0, 8) : [];
  const listos = elegidos.filter((e) => Number(e.cantidad) > 0);
  async function sacar() {
    setSinStock(null);
    try {
      const r = await escribirConCola('POST', '/fabrica/salidas-lote', { items: listos.map((e) => ({ id: e.id, cantidad: Number(e.cantidad), cliente_id: e.clienteId })), motivo: motivo.trim() || undefined });
      avisar(r.offline ? 'Sin señal: se guardó en el equipo y se envía solo' : `✓ ${r.guardados} insumo${r.guardados === 1 ? '' : 's'} sacado${r.guardados === 1 ? '' : 's'} de bodega`);
      setElegidos([]); setMotivo(''); d.recargar(); onSacado?.();
    } catch (e) { if (e.faltantes?.length) setSinStock(e.faltantes); else avisar(e.message, 'mal'); }
  }
  return (
    <div className="rejilla">
      <div className="tarjeta rejilla">
        <p className="tenue">Arma la lista y sácala toda junta. Se puede repetir varias veces en el día.</p>
        <button className="btn primario" onClick={() => setEscaneando(true)}>📷 Escanear varios seguidos</button>
        <input type="search" placeholder="…o busca el insumo por nombre" value={q} onChange={(e) => setQ(e.target.value)} />
        {sugerencias.map((i) => <div key={i.id} className="rv-fila clic" onClick={() => { agregar(i); setQ(''); }}><div className="info"><b>{i.nombre}</b><span className="tenue">{i.stock_actual === null ? 'sin cargar' : `hay ${conUnidad(i.stock_actual, i.unidad)}`}</span></div><Chip>+</Chip></div>)}
      </div>
      {sinStock && (
        <div className="aviso-caja mal"><b>No se sacó nada.</b> {sinStock.length === 1 ? 'A este insumo no le alcanza' : 'A estos insumos no les alcanza'} el stock:
          {sinStock.map((s) => <div key={s.id}>· {s.nombre}: pediste {fmt(s.pedido)}, hay {conUnidad(s.hay, s.unidad)}</div>)}
          Corrige esas cantidades y vuelve a mandar. Si el stock del sistema está mal, ajústalo primero desde la ficha del insumo.</div>
      )}
      {elegidos.length > 0 && (
        <div className="tarjeta rejilla">
          <h3>Se va a sacar · {listos.length} insumo{listos.length === 1 ? '' : 's'}</h3>
          {elegidos.map((e, i) => (
            <div className="rv-fila" key={e.id} style={{ padding: '6px 0' }}>
              <div className="info"><b>{e.nombre}</b><span className="tenue">{e.stock === null ? 'sin cargar' : `hay ${conUnidad(e.stock, e.unidad)}`}</span></div>
              <div className="rv-fila-cant"><input type="number" min="0" step="any" inputMode="decimal" value={e.cantidad} aria-label={`Cuánto sacar de ${e.nombre}`} onChange={(ev) => setElegidos((a) => a.map((x, j) => (j === i ? { ...x, cantidad: ev.target.value } : x)))} /><span className="tenue">{e.unidad}</span>
                <button className="btn chico fantasma" aria-label={`Quitar ${e.nombre}`} onClick={() => setElegidos((a) => a.filter((_, j) => j !== i))}>✕</button></div>
            </div>
          ))}
          <input placeholder="Para qué (opcional, ej: producción del martes)" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
          <button className="btn primario grande" disabled={!listos.length || ocupado} onClick={() => ejecutar(sacar)}>📤 Sacar de bodega ({listos.length})</button>
        </div>
      )}
      {escaneando && <Escaner continuo leidos={elegidos.length} onDetectado={alEscanear} onCerrar={() => setEscaneando(false)} />}
    </div>
  );
}
