import { useState } from 'react';
import { lempiras } from '@grupo/shared';
import { Estado, useDatos } from '../ui/kit.jsx';
import { rget, qs } from './api.js';
import { SIN_CATEGORIA, Chip, cantidad as fmt, conUnidad, cuando, descargarCsvFilas, fechaCorta, hoyIso, lps0 } from './comun.jsx';
import { Vencimientos, FiltroCategorias } from './Insumos.jsx';

const sumarDias = (f, d) => new Date(Date.parse(`${f}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
const rangos = () => { const h = hoyIso(); const mes = `${h.slice(0, 8)}01`; const ult = sumarDias(mes, -1); return { Hoy: [h, h], '7 días': [sumarDias(h, -6), h], 'Este mes': [mes, h], 'Mes pasado': [`${ult.slice(0, 8)}01`, ult] }; };

function GraficoMensual() {
  const d = useDatos(() => rget('/reportes/mensual?meses=6'), []);
  if (!d.datos) return null;
  const c = d.datos.meses.map((mes, i) => ({ mes, e: (d.datos.fabrica[i]?.entradas || 0) + (d.datos.sucursales[i]?.entradas || 0), s: (d.datos.fabrica[i]?.salidas || 0) + (d.datos.sucursales[i]?.salidas || 0) }));
  const max = Math.max(1, ...c.map((m) => Math.max(m.e, m.s)));
  return (
    <div className="tarjeta rejilla"><div className="tenue">📈 Movimientos por mes (últimos 6 meses)</div>
      <div className="rv-barras">{c.map((m) => <div className="mes" key={m.mes} title={`${m.mes}: ${m.e} entradas, ${m.s} salidas`}><div className="par"><i className="e" style={{ height: `${(m.e / max) * 100}%` }} /><i className="s" style={{ height: `${(m.s / max) * 100}%` }} /></div>{m.mes.slice(5)}</div>)}</div>
      <div className="fila tenue"><span style={{ color: 'var(--ok)' }}>■</span> entradas <span style={{ color: 'var(--peligro)' }}>■</span> salidas</div>
    </div>
  );
}

/** Kardex completo, filtrable: «¿qué pasó con las servilletas esta semana?». */
export function Movimientos({ sucursales }) {
  const h = hoyIso();
  const [f, setF] = useState({ desde: `${h.slice(0, 8)}01`, hasta: h, ambito: '', sucursalId: '', tipo: '', busqueda: '' });
  const [mas, setMas] = useState(false);
  const [aplicado, setAplicado] = useState(f);
  const d = useDatos(() => rget(`/movimientos${qs({ ...aplicado, sucursalId: aplicado.ambito === 'sucursal' ? aplicado.sucursalId : '' })}`), [aplicado]);
  const buscar = (extra = {}) => { const n = { ...f, ...extra }; setF(n); setAplicado(n); };
  const m = d.datos ?? [];
  const ent = m.filter((x) => x.tipo === 'entrada').length;
  return (
    <div className="rejilla">
      <GraficoMensual />
      <div className="tarjeta rejilla">
        <div className="fila"><input style={{ flex: 1 }} placeholder="Buscar por nombre de insumo…" value={f.busqueda} onChange={(e) => setF({ ...f, busqueda: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && buscar()} /><button className="btn primario" onClick={() => buscar()}>Buscar</button></div>
        <button className="btn chico fantasma" onClick={() => setMas((v) => !v)}>{mas ? '▲ Menos filtros' : '▼ Más filtros (fecha, ámbito, sucursal, tipo)'}</button>
        {mas && (
          <div className="rejilla">
            <div className="rv-pills">{Object.entries(rangos()).map(([n, [a, b]]) => <button key={n} className="btn chico" onClick={() => buscar({ desde: a, hasta: b })}>{n}</button>)}</div>
            <div className="fila"><input type="date" value={f.desde} onChange={(e) => setF({ ...f, desde: e.target.value })} /><input type="date" value={f.hasta} onChange={(e) => setF({ ...f, hasta: e.target.value })} /></div>
            <div className="fila">
              <select value={f.ambito} onChange={(e) => setF({ ...f, ambito: e.target.value, sucursalId: '' })}><option value="">Fábrica + sucursales</option><option value="fabrica">Solo fábrica</option><option value="sucursal">Solo sucursales</option></select>
              {f.ambito === 'sucursal' && <select value={f.sucursalId} onChange={(e) => setF({ ...f, sucursalId: e.target.value })}><option value="">Todas las sucursales</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select>}
              <select value={f.tipo} onChange={(e) => setF({ ...f, tipo: e.target.value })}><option value="">Entradas y salidas</option><option value="entrada">Solo entradas</option><option value="salida">Solo salidas</option></select>
            </div>
          </div>
        )}
      </div>
      <Estado d={d}>{() => (
        <>
          <div className="fila espacio"><div className="fila"><Chip tono="ok">➕ {ent}</Chip><Chip tono="mal">➖ {m.length - ent}</Chip>{m.length >= 1000 && <Chip>1000+</Chip>}</div>
            <button className="btn chico" disabled={!m.length} onClick={() => descargarCsvFilas(`movimientos_${aplicado.desde}_${aplicado.hasta}.csv`, ['Fecha', 'Ámbito/Sucursal', 'Insumo', 'Categoría', 'Tipo', 'Cantidad', 'Unidad', 'Saldo resultante', 'Motivo', 'Usuario'], m.map((x) => [x.creado_en, x.ambito === 'fabrica' ? 'Fábrica' : x.sucursal_nombre, x.insumo_nombre, x.categoria, x.tipo, x.cantidad, x.unidad, x.saldo_resultante, x.motivo || '', x.usuario_nombre || x.rol]))}>⬇ CSV</button></div>
          <div className="tarjeta pad0">{m.length === 0 ? <div className="vacio">Sin movimientos en este rango.</div> : m.map((x) => (
            <div className="rv-fila" key={x.id}>
              <div className="info"><b>{x.insumo_nombre}</b><span className="tenue">{x.ambito === 'fabrica' ? '🏭 Fábrica' : `🏬 ${x.sucursal_nombre}`} · {x.categoria}{x.motivo ? ` · ${x.motivo}` : ''}{x.usuario_nombre ? ` · ${x.usuario_nombre}` : ''}</span></div>
              <div style={{ textAlign: 'right' }}><b style={{ color: x.tipo === 'entrada' ? 'var(--ok)' : 'var(--peligro)' }}>{x.tipo === 'entrada' ? '➕' : '➖'} {conUnidad(x.cantidad, x.unidad)}</b><div className="tenue">saldo {fmt(x.saldo_resultante)} · {cuando(x.creado_en)}</div></div>
            </div>))}</div>
        </>
      )}</Estado>
    </div>
  );
}

/** Entradas y salidas agrupadas por categoría (no por insumo suelto): análisis, no trabajo diario. */
export function PorCategoria() {
  const h = hoyIso();
  const [r, setR] = useState([`${h.slice(0, 8)}01`, h]); const [ap, setAp] = useState(r);
  const d = useDatos(() => rget(`/reportes/categoria${qs({ desde: ap[0], hasta: ap[1] })}`), [ap]);
  const Tabla = ({ titulo, filas }) => (
    <div className="rejilla"><h3>{titulo}</h3><div className="tarjeta pad0">{!filas?.length ? <div className="vacio">Sin movimientos en este rango.</div> : filas.map((f) => <div className="rv-fila" key={f.categoria}><b className="info">{f.categoria}</b><Chip tono="ok">➕ {fmt(f.entradas)}</Chip><Chip tono="mal">➖ {fmt(f.salidas)}</Chip></div>)}</div></div>
  );
  return (
    <div className="rejilla">
      <p className="tenue">Entradas y salidas agrupadas por categoría, no por insumo suelto.</p>
      <div className="fila"><input type="date" value={r[0]} onChange={(e) => setR([e.target.value, r[1]])} /><input type="date" value={r[1]} onChange={(e) => setR([r[0], e.target.value])} /><button className="btn primario" onClick={() => setAp(r)}>Buscar</button></div>
      <Estado d={d}>{(x) => <><Tabla titulo="Fábrica" filas={x.fabrica} /><Tabla titulo="Sucursales" filas={x.sucursales} /></>}</Estado>
    </div>
  );
}

/** Cuánto dinero hay parado en bodega. Si hay insumos sin precio, sin peso o sin stock, el total es un PISO y se dice. */
export function Valor() {
  const d = useDatos(() => rget('/valor'), []);
  const [cat, setCat] = useState(''); const [todos, setTodos] = useState(false);
  return (
    <Estado d={d}>{(v) => {
      const cats = [...(v.categorias ?? [])].sort((a, b) => (v.porCategoria[b] || 0) - (v.porCategoria[a] || 0));
      const ins = cat ? v.insumos.filter((i) => i.categoria === cat) : v.insumos;
      const sinStock = cat ? v.sinStock.filter((i) => i.categoria === cat) : v.sinStock;
      const total = cat ? v.porCategoria[cat] || 0 : v.total;
      const vis = todos ? ins : ins.slice(0, 8);
      const detalle = (i) => (i.peso_unitario ? `${fmt(i.stock)} ${i.unidad} × ${fmt(i.peso_unitario)} kg × ${lps0(i.precio)}/kg` : `${fmt(i.stock)} ${i.unidad} × ${lps0(i.precio)}`);
      return (
        <div className="tarjeta rejilla">
          <h3>💰 Valor del inventario</h3>
          {cats.length > 1 && <div className="tabs"><button className={!cat ? 'activa' : ''} onClick={() => setCat('')}>Todas</button>{cats.map((c) => <button key={c} className={cat === c ? 'activa' : ''} onClick={() => setCat(c)}>{c}</button>)}</div>}
          <div className="rv-valor">{lempiras(total)}</div>
          <div className="tenue">en {ins.length} insumo{ins.length === 1 ? '' : 's'} con stock{cat ? ` de ${cat}` : ''}</div>
          {cat && !ins.length && sinStock.length > 0 && <div className="aviso-caja"><b>{sinStock.length} producto{sinStock.length === 1 ? '' : 's'} de {cat}, sin stock cargado todavía.</b> No suman nada hasta que se cargue cuánto hay de cada uno.</div>}
          {!cat && v.insumosSinPrecio > 0 && <div className="aviso-caja"><b>Este total es un piso, no el valor real.</b> {v.insumosSinPrecio} insumo{v.insumosSinPrecio === 1 ? '' : 's'} con stock pero sin precio, no se cuentan: {v.sinPrecio.slice(0, 4).map((i) => i.nombre).join(', ')}{v.sinPrecio.length > 4 ? '…' : ''}</div>}
          {!cat && v.insumosSinStock > 0 && <div className="aviso-caja"><b>{v.insumosSinStock} insumo{v.insumosSinStock === 1 ? '' : 's'} sin stock cargado.</b> Ya están dados de alta pero no cuentan hasta cargar cuánto hay: {v.sinStock.slice(0, 4).map((i) => i.nombre).join(', ')}{v.sinStock.length > 4 ? '…' : ''}</div>}
          {!cat && v.insumosSinPeso > 0 && <div className="aviso-caja"><b>Falta el peso de {v.insumosSinPeso === 1 ? 'un insumo' : `${v.insumosSinPeso} insumos`}.</b> Se cuentan por unidad pero el precio está por kilo: sin saber cuánto pesa cada envase no se valorizan. {v.sinPeso.slice(0, 4).map((i) => i.nombre).join(', ')}{v.sinPeso.length > 4 ? '…' : ''} — se carga en la ficha, en «Cuánto pesa cada unidad».</div>}
          {!cat && cats.length > 1 && <div className="rejilla" style={{ gap: 6 }}><h3>Por categoría</h3>{cats.map((c) => { const val = v.porCategoria[c] || 0; return <div key={c}><div className="fila espacio"><span>{c}</span><b>{lps0(val)}</b></div><div className="rv-mini"><i style={{ width: `${v.total > 0 ? (val / v.total) * 100 : 0}%` }} /></div></div>; })}</div>}
          <h3>Dónde está la plata</h3>
          {vis.map((i) => <div key={i.id}><div className="fila espacio"><b>{i.nombre}</b><b>{lps0(i.valor)}</b></div><div className="tenue">{detalle(i)} · {total > 0 ? ((i.valor / total) * 100).toFixed(0) : 0}% del total</div><div className="rv-mini"><i style={{ width: `${total > 0 ? (i.valor / total) * 100 : 0}%` }} /></div></div>)}
          {ins.length > 8 && <button className="btn chico" onClick={() => setTodos((x) => !x)}>{todos ? 'Ver solo los 8 primeros' : `Ver los ${ins.length} insumos`}</button>}
        </div>
      );
    }}</Estado>
  );
}

/** Calidad: de un lote de materia prima, cuánto salió y qué día, y a qué tiendas pudo llegar (el «botón de retiro»). */
export function Calidad() {
  const lotes = useDatos(() => rget('/lotes'), []);
  const [id, setId] = useState('');
  const t = useDatos(() => (id ? rget(`/trazabilidad/lote/${id}`) : Promise.resolve(null)), [id]);
  return (
    <div className="rejilla">
      <Vencimientos dias={90} />
      <p className="tenue">Elige un lote de materia prima para ver cuánto salió de bodega, qué día, qué tandas pudieron usarlo y a qué tiendas fueron.</p>
      <Estado d={lotes}>{(l) => (
        <select value={id} onChange={(e) => setId(e.target.value)}><option value="">Elige un lote…</option>{l.map((x) => <option key={x.id} value={x.id}>{x.insumo_nombre} · ingresó {fechaCorta(x.fecha_ingreso)} · quedan {fmt(x.cantidad_restante)} {x.unidad}</option>)}</select>
      )}</Estado>
      {id && <Estado d={t}>{(x) => x && (
        <div className="rejilla">
          <div className="tarjeta"><b>{x.lote.insumo_nombre}</b><div className="tenue">Ingresó {fechaCorta(x.lote.fecha_ingreso)} · vence {fechaCorta(x.lote.fecha_vencimiento)} · entró {fmt(x.lote.cantidad_inicial)} {x.lote.unidad}, quedan {fmt(x.lote.cantidad_restante)}{x.lote.motivo ? ` · ${x.lote.motivo}` : ''}</div></div>
          <div className="tarjeta rejilla"><h3>Salidas de bodega</h3>{x.salidas.length ? x.salidas.map((s) => <div className="fila espacio" key={s.fecha}><span>{fechaCorta(s.fecha)}</span><b>{fmt(s.cantidad)} {x.lote.unidad}</b></div>) : <div className="tenue">Todavía no ha salido nada de este lote.</div>}</div>
          {x.tiendas_afectadas.length > 0 && <div className="aviso-caja mal"><b>Tiendas a las que pudo llegar:</b> {x.tiendas_afectadas.map((s) => `${s.nombre} (${s.fechas.map(fechaCorta).join(', ')})`).join(' · ')}</div>}
          {[['Tandas que usaron este lote', x.tandas], ['Tandas producidas los días en que salió (lista corta donde mirar)', x.tandas_de_esos_dias]].map(([tit, ts]) => ts.length > 0 && (
            <div className="tarjeta rejilla" key={tit}><h3>{tit}</h3>{ts.map((p) => <div key={p.id}><b>{p.sabor_nombre}</b> · lote {p.lote} · {fechaCorta(p.fecha)} · {fmt(p.kg)} kg<div className="tenue">{p.destinos.length ? p.destinos.map((d) => `${d.sucursal_nombre} ${fechaCorta(d.fecha)}`).join(' · ') : 'sin despachos registrados'}</div></div>)}</div>
          ))}
          {x.incidencias.length > 0 && <div className="tarjeta rejilla"><h3>Incidencias de este lote</h3>{x.incidencias.map((i) => <div key={i.id}><Chip tono={i.gravedad === 'alta' ? 'mal' : 'aviso'}>{i.estado}</Chip> {i.descripcion}</div>)}</div>}
        </div>
      )}</Estado>}
      <FiltroCategorias items={[]} categoria="" setCategoria={() => {}} />
    </div>
  );
}
