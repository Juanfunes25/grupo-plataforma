import { useMemo, useState } from 'react';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, Modal, useAccion, useAviso, useDatos } from '../ui/kit.jsx';
import { rget, rpost } from './api.js';
import { SIN_CATEGORIA, Chip, coincide, conUnidad, descargarCsvFilas, enAlerta, fechaCorta, hoyIso, haceCuanto, CATEGORIAS_FABRICA, porCategoria } from './comun.jsx';

export function FiltroCategorias({ items, categoria, setCategoria }) {
  const cats = useMemo(() => [...new Set(items.filter((i) => !i.es_equipo).map((i) => i.categoria || SIN_CATEGORIA))].sort(porCategoria), [items]);
  if (cats.length <= 1) return null;
  return (
    <div className="tabs">
      <button className={!categoria ? 'activa' : ''} onClick={() => setCategoria('')}>Todas</button>
      {cats.map((c) => <button key={c} className={categoria === c ? 'activa' : ''} onClick={() => setCategoria(c)}>{c}</button>)}
    </div>
  );
}

/** Lotes de Mec3 por vencer o ya vencidos. Se muestra por lote, no por insumo: el stock total puede verse sano con una parte vieja. */
export function Vencimientos({ dias = 60 }) {
  const d = useDatos(() => rget(`/fabrica/vencimientos?dias=${dias}`), [dias]);
  const [abierto, setAbierto] = useState(false);
  const lotes = d.datos;
  if (!lotes?.length) return null;
  const vencidos = lotes.filter((l) => l.dias_para_vencer < 0);
  return (
    <div className="rejilla" style={{ gap: 8 }}>
      <button className={`aviso-caja ${vencidos.length ? 'mal' : ''}`} style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setAbierto((v) => !v)}>
        ⏰ {lotes.length} lote{lotes.length === 1 ? '' : 's'} de Mec3{vencidos.length ? ` — ${vencidos.length} ya vencido${vencidos.length === 1 ? '' : 's'}` : ' por vencer'} — <b>{abierto ? 'ocultar' : 'ver detalle'}</b>
      </button>
      {abierto && (
        <div className="tarjeta pad0">
          {lotes.map((l) => (
            <div className="rv-fila" key={l.id}>
              <div className="info"><b>{l.insumo_nombre}</b><span className="tenue">Ingresó {fechaCorta(l.fecha_ingreso)} · vence {fechaCorta(l.fecha_vencimiento)}</span></div>
              <Chip tono={l.dias_para_vencer < 0 ? 'mal' : 'aviso'}>{conUnidad(l.cantidad_restante, l.unidad)} · {l.dias_para_vencer < 0 ? `vencido hace ${-l.dias_para_vencer} d` : `en ${l.dias_para_vencer} d`}</Chip>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Alta de un insumo de fábrica nuevo (con su precio) — solo quien ve costos. */
function NuevoInsumo({ onCerrar, onCreado }) {
  const avisar = useAviso();
  const [f, setF] = useState({ nombre: '', tipo: 'local', unidad: 'unidad', categoria: '', peso_unitario: '', lps_kg: '' });
  const [ejecutar, ocupado] = useAccion();
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  async function crear() {
    const r = await ejecutar(() => rpost('/fabrica', { ...f, categoria: f.categoria || (f.tipo === 'mec3' ? 'MEC3' : 'Otros'), peso_unitario: f.peso_unitario === '' ? null : Number(f.peso_unitario), lps_kg: f.lps_kg === '' ? null : Number(f.lps_kg) }), 'Insumo creado ✓');
    if (r) { onCreado(); onCerrar(); } else avisar('No se pudo crear', 'mal');
  }
  return (
    <Modal titulo="Insumo nuevo de fábrica" onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Cancelar</button><button className="btn primario" disabled={ocupado || f.nombre.trim().length < 2} onClick={crear}>Crear</button></>}>
      <Campo etiqueta="Nombre"><input value={f.nombre} onChange={set('nombre')} autoFocus /></Campo>
      <div className="fila">
        <Campo etiqueta="Tipo"><select value={f.tipo} onChange={set('tipo')}><option value="local">Compra local</option><option value="mec3">Materia prima Mec3 (con lote y vencimiento)</option></select></Campo>
        <Campo etiqueta="Unidad"><input value={f.unidad} onChange={set('unidad')} /></Campo>
      </div>
      <Campo etiqueta="Categoría"><select value={f.categoria || (f.tipo === 'mec3' ? 'MEC3' : 'Otros')} onChange={set('categoria')}>{CATEGORIAS_FABRICA.map((c) => <option key={c} value={c}>{c}</option>)}</select></Campo>
      <div className="fila">
        <Campo etiqueta="Peso de cada envase (kg)"><input type="number" min="0" step="any" value={f.peso_unitario} onChange={set('peso_unitario')} /></Campo>
        <Campo etiqueta="Precio por kg (L)"><input type="number" min="0" step="any" value={f.lps_kg} onChange={set('lps_kg')} /></Campo>
      </div>
    </Modal>
  );
}

/** Insumos de fábrica agrupados por categoría y plegables: se abre el estante en el que se está parado. */
export function Fabrica({ onAbrir, onEscanear }) {
  const { puede } = useSesion();
  const d = useDatos(() => rget('/fabrica'), []);
  const [q, setQ] = useState(''); const [cat, setCat] = useState(''); const [equipos, setEquipos] = useState(false); const [abiertas, setAbiertas] = useState({});
  const [nuevo, setNuevo] = useState(false);
  const insumos = d.datos ?? [];
  const filtrados = insumos.filter((i) => equipos || !i.es_equipo).filter((i) => coincide(i.nombre, i.codigo_barras, q)).filter((i) => !cat || (i.categoria || SIN_CATEGORIA) === cat);
  const grupos = useMemo(() => {
    const m = new Map();
    for (const i of filtrados) { const c = i.categoria || SIN_CATEGORIA; if (!m.has(c)) m.set(c, []); m.get(c).push(i); }
    return [...m.entries()].sort((a, b) => porCategoria(a[0], b[0]));
  }, [filtrados]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="rejilla">
      <Vencimientos />
      <div className="rv-sticky">
        <FiltroCategorias items={insumos} categoria={cat} setCategoria={setCat} />
        <div className="fila"><input style={{ flex: 1 }} placeholder="Buscar insumo o código…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn" onClick={onEscanear} aria-label="Escanear">📷</button>
          {puede('rep:costeo') && <button className="btn" onClick={() => setNuevo(true)}>+ Insumo</button>}</div>
        <label className="fila" style={{ display: 'flex' }}><input type="checkbox" checked={equipos} onChange={(e) => setEquipos(e.target.checked)} /> Mostrar también equipos/utensilios</label>
      </div>
      <Estado d={d}>{() => (filtrados.length === 0 ? <div className="tarjeta vacio">Sin resultados</div> : grupos.map(([nombre, items]) => {
        const abierta = Boolean(q.trim()) || abiertas[nombre];
        const alertas = items.filter((i) => enAlerta(i.stock_actual, i.stock_minimo, i.es_equipo)).length;
        return (
          <div className="rv-grupo" key={nombre}>
            <button onClick={() => setAbiertas((a) => ({ ...a, [nombre]: !a[nombre] }))}>
              <span className="nombre">{nombre}</span>{alertas > 0 && <Chip tono="mal">{alertas} en alerta</Chip>}<Chip>{items.length}</Chip><span>{abierta ? '▾' : '▸'}</span>
            </button>
            {abierta && items.map((i) => (
              <div key={i.id} className="rv-fila clic" onClick={() => onAbrir(i, filtrados)}>
                <div className="info"><b>{i.nombre}{i.es_equipo ? ' 🔧' : ''}</b><span className="tenue">{i.unidad}{i.codigo_barras ? ' · 📊 con código' : ''}{i.stock_actualizado_en ? ` · actualizado ${haceCuanto(i.stock_actualizado_en)}` : ''}</span></div>
                <Chip tono={i.stock_actual === null ? '' : enAlerta(i.stock_actual, i.stock_minimo) ? 'mal' : 'ok'}>{i.stock_actual === null ? 'sin cargar' : conUnidad(i.stock_actual, i.unidad)}</Chip>
              </div>
            ))}
          </div>
        );
      }))}</Estado>
      {nuevo && <NuevoInsumo onCerrar={() => setNuevo(false)} onCreado={d.recargar} />}
    </div>
  );
}

/** Solo lo que está bajo el mínimo, para no revisar el catálogo entero cada vez que toca reordenar. */
export function Reordenar({ onAbrir }) {
  const avisar = useAviso();
  const d = useDatos(() => rget('/fabrica'), []);
  const [cat, setCat] = useState('');
  const bajo = (d.datos ?? []).filter((i) => !i.es_equipo && i.stock_minimo != null && (Number(i.stock_actual) || 0) < Number(i.stock_minimo));
  const lista = bajo.filter((i) => !cat || (i.categoria || SIN_CATEGORIA) === cat).sort((a, b) => porCategoria(a.categoria || SIN_CATEGORIA, b.categoria || SIN_CATEGORIA) || a.nombre.localeCompare(b.nombre));
  const faltan = (i) => Math.max(0, Number(i.stock_minimo) - (Number(i.stock_actual) || 0));
  const grupos = [...lista.reduce((m, i) => { const c = i.categoria || SIN_CATEGORIA; m.set(c, [...(m.get(c) ?? []), i]); return m; }, new Map()).entries()];
  function compartir() {
    const l = [`*Para reordenar — ${hoyIso()}*`, ''];
    for (const [c, items] of grupos) { l.push(`_${c}_`); for (const i of items) l.push(`• ${i.nombre}: tiene ${conUnidad(i.stock_actual ?? 0, i.unidad)}, mínimo ${conUnidad(i.stock_minimo, i.unidad)} → faltan ${conUnidad(faltan(i), i.unidad)}`); l.push(''); }
    const texto = l.join('\n').trim();
    if (navigator.share) navigator.share({ text: texto }).catch(() => {});
    else navigator.clipboard?.writeText(texto).then(() => avisar('Lista copiada — pégala en WhatsApp'), () => avisar('No se pudo copiar', 'mal'));
  }
  return (
    <Estado d={d}>{() => bajo.length === 0 ? <div className="tarjeta centro">✅ Nada bajo el mínimo por ahora.</div> : (
      <div className="rejilla">
        <FiltroCategorias items={bajo} categoria={cat} setCategoria={setCat} />
        <div className="fila"><button className="btn primario" onClick={compartir}>📤 Compartir</button>
          <button className="btn" onClick={() => descargarCsvFilas(`reordenar-${hoyIso()}.csv`, ['Categoría', 'Insumo', 'Unidad', 'Cantidad actual', 'Cantidad mínima', 'Faltan'], lista.map((i) => [i.categoria || SIN_CATEGORIA, i.nombre, i.unidad, i.stock_actual ?? 0, i.stock_minimo, faltan(i)]))}>⬇️ Descargar CSV</button></div>
        {grupos.map(([c, items]) => (
          <div className="rv-grupo" key={c}>
            <div className="rv-fila"><b style={{ flex: 1 }}>{c}</b><Chip tono="mal">{items.length}</Chip></div>
            {items.map((i) => (
              <div key={i.id} className="rv-fila clic" onClick={() => onAbrir(i, lista)}>
                <div className="info"><b>{i.nombre}</b><span className="tenue">Tiene {conUnidad(i.stock_actual ?? 0, i.unidad)} · mínimo {conUnidad(i.stock_minimo, i.unidad)}</span></div>
                <Chip tono="mal">faltan {conUnidad(faltan(i), i.unidad)}</Chip>
              </div>
            ))}
          </div>
        ))}
      </div>
    )}</Estado>
  );
}
