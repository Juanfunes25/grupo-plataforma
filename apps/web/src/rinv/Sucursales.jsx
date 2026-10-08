import { useMemo, useRef, useState } from 'react';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, Modal, useAccion, useAviso, useDatos } from '../ui/kit.jsx';
import { escribirConCola, idCliente, rget, rpost } from './api.js';
import { SIN_CATEGORIA, Chip, UNIDADES_PRESET, CATEGORIAS_SUGERIDAS, coincide, conUnidad, descargarCsvFilas, enAlerta } from './comun.jsx';
import { FiltroCategorias } from './Insumos.jsx';

/** Reposición semanal de UNA sucursal: escribe cuánto llegó de cada uno; lo que queda en blanco no se toca. */
function CargaLoteSucursal({ sucursalId, insumos, onListo }) {
  const avisar = useAviso();
  const items = useMemo(() => insumos.filter((i) => !i.es_equipo).sort((a, b) => a.nombre.localeCompare(b.nombre)), [insumos]);
  const [cant, setCant] = useState({}); const [motivo, setMotivo] = useState('Reposición'); const [q, setQ] = useState('');
  const [ejecutar, ocupado] = useAccion();
  const conValor = items.filter((i) => Number(cant[i.id]) > 0);
  const mostrados = q.trim() ? items.filter((i) => i.nombre.toUpperCase().includes(q.trim().toUpperCase())) : items;
  async function guardar() {
    const r = await ejecutar(() => escribirConCola('POST', `/sucursal/${sucursalId}/entradas-lote`, { items: conValor.map((i) => ({ id: i.id, cantidad: Number(cant[i.id]), cliente_id: idCliente() })), motivo: motivo.trim() || undefined }));
    if (r) { avisar(r.offline ? 'Sin señal: se guardó en el equipo y se envía solo' : `✓ ${r.guardados} insumo${r.guardados === 1 ? '' : 's'} cargado${r.guardados === 1 ? '' : 's'}`); setCant({}); onListo(); }
  }
  return (
    <div className="rejilla">
      <p className="tenue">Escribe cuánto llegó de cada uno. Lo que dejes en blanco no se toca.</p>
      <input placeholder="Buscar insumo para filtrar la lista…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="tarjeta pad0" style={{ maxHeight: '50vh', overflow: 'auto' }}>
        {mostrados.length === 0 && <div className="vacio">Sin resultados</div>}
        {mostrados.map((i) => (
          <div className="rv-fila" key={i.id}><div className="info"><b>{i.nombre}</b><span className="tenue">hay {i.cantidad} {i.unidad || 'u'}</span></div>
            <input type="number" min="0" step="any" inputMode="decimal" placeholder="0" style={{ width: 90, textAlign: 'right' }} title={`Cuántos ${i.unidad || 'u'} llegaron`} value={cant[i.id] ?? ''} onChange={(e) => setCant((c) => ({ ...c, [i.id]: e.target.value }))} /></div>
        ))}
      </div>
      <input placeholder="Motivo (ej: Reposición semanal, pedido)" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
      <button className="btn primario grande" disabled={ocupado || !conValor.length} onClick={guardar}>{conValor.length ? `➕ Registrar entrada de ${conValor.length}` : 'Escribe al menos una cantidad'}</button>
    </div>
  );
}

/** Insumo nuevo: avisa si ya existe uno parecido escrito distinto ("Vaso 8oz" vs "Vasos 8 oz"), pero decide la persona. */
function NuevoInsumo({ sucursalId, onCerrar, onCreado }) {
  const [f, setF] = useState({ nombre: '', cantidad: '', categoria: '', unidad: 'u' });
  const [parecidos, setParecidos] = useState([]);
  const [ejecutar, ocupado] = useAccion();
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  async function buscar() { if (f.nombre.trim().length >= 3) try { setParecidos(await rget(`/sucursal/parecidos?nombre=${encodeURIComponent(f.nombre.trim())}`)); } catch { setParecidos([]); } }
  async function crear() {
    const r = await ejecutar(() => escribirConCola('POST', `/sucursal/${sucursalId}/nuevo`, { nombre: f.nombre.trim(), cantidad: Number(f.cantidad) || 0, categoria: f.categoria || null, unidad: f.unidad, cliente_id: idCliente() }), 'Insumo guardado ✓');
    if (r) { onCreado(); onCerrar(); }
  }
  return (
    <Modal titulo="Agregar insumo nuevo" onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Cancelar</button><button className="btn primario" disabled={ocupado || !f.nombre.trim()} onClick={crear}>Guardar</button></>}>
      <Campo etiqueta="Nombre"><input autoFocus value={f.nombre} onChange={set('nombre')} onBlur={buscar} /></Campo>
      {parecidos.length > 0 && <div className="aviso-caja">Ya hay algo parecido: {parecidos.map((p) => p.nombre).join(', ')}. Si es el mismo, ábrelo en vez de crear otro.</div>}
      <div className="fila">
        <Campo etiqueta="Cantidad que hay hoy"><input type="number" min="0" step="any" value={f.cantidad} onChange={set('cantidad')} /></Campo>
        <Campo etiqueta="Unidad"><select value={f.unidad} onChange={set('unidad')}>{UNIDADES_PRESET.map((u) => <option key={u}>{u}</option>)}</select></Campo>
      </div>
      <Campo etiqueta="Categoría"><input list="rv-cats3" value={f.categoria} onChange={set('categoria')} /><datalist id="rv-cats3">{CATEGORIAS_SUGERIDAS.map((c) => <option key={c} value={c} />)}</datalist></Campo>
    </Modal>
  );
}

function separar(linea) {
  const cols = []; let a = ''; let c = false;
  for (const ch of linea) { if (ch === '"') { c = !c; continue; } if (ch === ',' && !c) { cols.push(a.trim()); a = ''; continue; } a += ch; }
  cols.push(a.trim()); return cols;
}
/** CSV con columnas nombre (obligatoria), categoria, cantidad y unidad: para poblar de cero el catálogo de una tienda nueva. */
function ImportarCsv({ sucursalId, onTerminado }) {
  const ref = useRef(null);
  const [filas, setFilas] = useState(null); const [progreso, setProgreso] = useState(null); const [resultado, setResultado] = useState(null);
  function leer(e) {
    const f = e.target.files?.[0]; e.target.value = ''; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const lineas = String(r.result).split(/\r?\n/).filter((l) => l.trim());
      if (!lineas.length) return setFilas([]);
      const enc = separar(lineas[0]).map((c) => c.toLowerCase());
      const iN = enc.indexOf('nombre'); const iC = enc.includes('categoria') ? enc.indexOf('categoria') : enc.indexOf('categoría');
      const iQ = enc.indexOf('cantidad'); const iU = enc.indexOf('unidad'); const con = iN !== -1;
      setFilas((con ? lineas.slice(1) : lineas).map((l) => { const c = separar(l); return { nombre: (con ? c[iN] : c[0]) || '', categoria: con && iC !== -1 ? c[iC] || '' : '', cantidad: con && iQ !== -1 ? c[iQ] || '' : '', unidad: con && iU !== -1 ? c[iU] || '' : '' }; }).filter((x) => x.nombre));
    };
    r.readAsText(f);
  }
  async function importar() {
    let ok = 0; let mal = 0; setProgreso(0);
    for (const f of filas) {
      try { await rpost(`/sucursal/${sucursalId}/nuevo`, { nombre: f.nombre, cantidad: Number(f.cantidad) || 0, categoria: f.categoria || null, unidad: f.unidad || null, cliente_id: idCliente() }); ok += 1; } catch { mal += 1; }
      setProgreso((p) => p + 1);
    }
    setProgreso(null); setResultado({ ok, mal }); setFilas(null); onTerminado();
  }
  return (
    <div className="rejilla">
      <p className="tenue">Sube un CSV con columnas <code>nombre</code> (obligatoria), <code>categoria</code>, <code>cantidad</code> y <code>unidad</code> (opcionales); se exporta así desde Excel o Google Sheets.</p>
      <input ref={ref} type="file" accept=".csv,text/csv" hidden onChange={leer} />
      <button className="btn" onClick={() => ref.current?.click()} disabled={progreso !== null}>📄 Elegir archivo CSV</button>
      {filas && (
        <div className="tarjeta rejilla">
          <b>{filas.length} insumo{filas.length === 1 ? '' : 's'} en el archivo</b>
          <div className="tenue">{filas.slice(0, 8).map((f, i) => <div key={i}>{f.nombre}{f.categoria ? ` · ${f.categoria}` : ''}{f.cantidad ? ` · ${f.cantidad} ${f.unidad}` : ''}</div>)}{filas.length > 8 && <div>… y {filas.length - 8} más</div>}</div>
          <button className="btn primario" disabled={progreso !== null || !filas.length} onClick={importar}>{progreso !== null ? `Importando… ${progreso}/${filas.length}` : `Importar ${filas.length}`}</button>
        </div>
      )}
      {resultado && <div className={`aviso-caja ${resultado.mal ? '' : 'ok'}`}>✓ {resultado.ok} importado{resultado.ok === 1 ? '' : 's'}{resultado.mal ? ` — ${resultado.mal} no se pudieron cargar` : ''}</div>}
    </div>
  );
}

/** Existencias de insumos y empaques en cada sucursal: matriz para comparar, o una tienda a la vez. */
export default function Sucursales({ onAbrir }) {
  const { sucursales } = useSesion();
  const resumen = useDatos(() => rget('/resumen-stock'), []);
  const [vista, setVista] = useState(''); const [q, setQ] = useState(''); const [cat, setCat] = useState('');
  const [soloAlertas, setSoloAlertas] = useState(false); const [equipos, setEquipos] = useState(false); const [modo, setModo] = useState('ver');
  const [nuevo, setNuevo] = useState(false);
  const suc = vista || sucursales[0]?.id || '';
  const lista = useDatos(() => (suc ? rget(`/sucursal/${suc}`) : Promise.resolve([])), [suc]);
  const abrir = (i, l) => onAbrir('sucursal', suc, i, l);
  const r = resumen.datos;
  const alertaMatriz = (i) => !i.es_equipo && Object.values(i.porSucursal).some((c) => c === 0 || (i.stock_minimo != null && c < i.stock_minimo));
  const matriz = (r?.catalogoSucursal ?? []).filter((i) => equipos || !i.es_equipo).filter((i) => coincide(i.nombre, '', q)).filter((i) => !cat || (i.categoria || SIN_CATEGORIA) === cat).filter((i) => !soloAlertas || alertaMatriz(i));
  const clase = (i, c) => (i.es_equipo ? '' : c === 0 ? 'cero' : i.stock_minimo != null && c < i.stock_minimo ? 'bajo' : '');
  const propias = (lista.datos ?? []).filter((i) => equipos || !i.es_equipo).filter((i) => coincide(i.nombre, i.codigo_barras, q)).filter((i) => !cat || (i.categoria || SIN_CATEGORIA) === cat);
  const recargar = () => { resumen.recargar(); lista.recargar(); };
  return (
    <div className="rejilla">
      <div className="rv-pills">
        {[['ver', '📦 Stock'], ['cargar', '📥 Reposición'], ['importar', '📄 Importar CSV']].map(([k, n]) => <button key={k} className={`btn ${modo === k ? 'primario' : ''}`} onClick={() => setModo(k)}>{n}</button>)}
        <select style={{ width: 'auto', minHeight: 46 }} value={vista} onChange={(e) => setVista(e.target.value)} aria-label="Sucursal">
          <option value="">{modo === 'ver' ? 'Matriz (todas)' : 'Elige sucursal'}</option>{(r?.sucursales ?? sucursales).map((s) => <option key={s.id} value={s.id}>{modo === 'ver' ? `Solo ${s.nombre}` : s.nombre}</option>)}
        </select>
        <button className="btn" onClick={() => setNuevo(true)} disabled={!suc}>+ Insumo nuevo</button>
      </div>
      {modo === 'cargar' && <div className="tarjeta"><Estado d={lista}>{(l) => <CargaLoteSucursal sucursalId={suc} insumos={l} onListo={recargar} />}</Estado></div>}
      {modo === 'importar' && <div className="tarjeta"><ImportarCsv sucursalId={suc} onTerminado={recargar} /></div>}
      {modo === 'ver' && (
        <Estado d={resumen}>{() => (
          <>
            <div className="fila">
              <input style={{ flex: 1 }} placeholder="Buscar insumo…" value={q} onChange={(e) => setQ(e.target.value)} />
              <label className="fila" style={{ display: 'flex' }}><input type="checkbox" checked={soloAlertas} onChange={(e) => setSoloAlertas(e.target.checked)} /> Solo en alerta</label>
              <label className="fila" style={{ display: 'flex' }}><input type="checkbox" checked={equipos} onChange={(e) => setEquipos(e.target.checked)} /> Equipos</label>
            </div>
            <FiltroCategorias items={r.catalogoSucursal} categoria={cat} setCategoria={setCat} />
            {vista ? (
              <div className="tarjeta pad0"><Estado d={lista}>{() => (propias.length === 0 ? <div className="vacio">Sin resultados</div> : propias.filter((i) => !soloAlertas || enAlerta(i.cantidad, i.stock_minimo, i.es_equipo)).map((i) => (
                <div key={i.id} className="rv-fila clic" onClick={() => abrir(i, propias)}><div className="info"><b>{i.nombre}{i.es_equipo ? ' 🔧' : ''}</b><span className="tenue">{i.categoria || SIN_CATEGORIA} · {i.unidad}</span></div>
                  <Chip tono={i.es_equipo ? '' : enAlerta(i.cantidad, i.stock_minimo) ? 'mal' : 'ok'}>{conUnidad(i.cantidad, i.unidad)}</Chip></div>)))}</Estado></div>
            ) : (
              <div className="tarjeta pad0 tabla-wrap">
                <table className="rv-tabla"><thead><tr><th>Insumo</th>{r.sucursales.map((s) => <th key={s.id} className="der">{s.nombre}</th>)}</tr></thead>
                  <tbody>{matriz.length === 0 && <tr><td colSpan={r.sucursales.length + 1} className="centro tenue">Sin resultados</td></tr>}
                    {matriz.map((i) => (
                      <tr key={i.id}><td>{i.nombre}{i.es_equipo ? ' 🔧' : ''}<div className="tenue">{i.categoria || SIN_CATEGORIA}</div></td>
                        {r.sucursales.map((s) => <td key={s.id} className={`der num clic ${clase(i, i.porSucursal[s.id] ?? 0)}`} style={{ cursor: 'pointer' }} onClick={async () => { try { const l = await rget(`/sucursal/${s.id}`); const x = l.find((y) => y.id === i.id); if (x) onAbrir('sucursal', s.id, x, l); } catch { /* sin red */ } }}>{i.porSucursal[s.id] ?? 0}</td>)}</tr>
                    ))}</tbody></table>
              </div>
            )}
            <div className="fila"><button className="btn chico" onClick={() => descargarCsvFilas('inventario_sucursales.csv', ['Insumo', 'Categoría', ...r.sucursales.map((s) => s.nombre)], matriz.map((i) => [i.nombre, i.categoria || SIN_CATEGORIA, ...r.sucursales.map((s) => i.porSucursal[s.id] ?? 0)]))}>⬇ CSV</button></div>
          </>
        )}</Estado>
      )}
      {nuevo && <NuevoInsumo sucursalId={suc} onCerrar={() => setNuevo(false)} onCreado={recargar} />}
    </div>
  );
}
