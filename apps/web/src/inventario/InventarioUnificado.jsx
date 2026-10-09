// Inventario unificado de la empresa activa: las tablas propias de cada empresa vistas con los mismos conceptos.
import { useMemo, useState } from 'react';
import { fechaHN, lempiras, numero } from '@grupo/shared';
import { get, put, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, Kpi, Modal, Tabs, Vacio, descargarCsv, useAccion, useDatos } from '../ui/kit.jsx';
import { Conteos } from './Conteos.jsx';
import { Traslados } from './Traslados.jsx';
import './inv-unificado.css';

export const ESTADOS = { ok: 'Normal', bajo: 'Bajo mínimo', agotado: 'Agotado', negativo: 'Negativo', sin_cargar: 'Sin cargar' };
export const Estadito = ({ e }) => <span className={`iu-estado ${e}`}>{ESTADOS[e] ?? e}</span>;

export default function InventarioUnificado() {
  const [tab, setTab] = useState('existencias');
  const tabs = [['existencias', 'Existencias'], ['alertas', 'Alertas'], ['conteos', 'Conteos'], ['traslados', 'Traslados'], ['kardex', 'Kardex']];
  return (
    <div className="pagina">
      <div className="encabezado-pagina"><div><h1>Inventario unificado</h1><small>Existencia, mínimo, valor y estado con los mismos conceptos en todas las empresas.</small></div></div>
      <Tabs tabs={tabs} valor={tab} onCambio={setTab} />
      {tab === 'existencias' && <Existencias />}
      {tab === 'alertas' && <Alertas ir={setTab} />}
      {tab === 'conteos' && <Conteos />}
      {tab === 'traslados' && <Traslados />}
      {tab === 'kardex' && <Kardex />}
    </div>
  );
}

function Existencias() {
  const { puede } = useSesion();
  const [f, setF] = useState({ fuente: '', sucursal_id: '', categoria: '', estado: '', q: '' });
  const d = useDatos(() => get(`/inv/u/existencias${qs(f)}`), [f.fuente, f.sucursal_id, f.categoria, f.estado, f.q]);
  const [min, setMin] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <>
      <Estado d={d}>{({ items, resumen, filtros, costos }) => (
        <>
          <div className="rejilla cols-4">
            <Kpi acento etiqueta="Valor del inventario" valor={costos ? lempiras(resumen.valor) : '—'} sub={costos ? (resumen.sin_costo ? `${resumen.sin_costo} sin costo` : '') : 'Sin permiso de costos'} />
            <Kpi etiqueta="Bajo mínimo" valor={resumen.bajo_minimo} />
            <Kpi etiqueta="Agotados / negativos" valor={`${resumen.agotados} / ${resumen.negativos}`} />
            <Kpi etiqueta="Vencen en 30 días" valor={resumen.por_vencer} />
          </div>
          <div className="iu-filtros">
            <input placeholder="Buscar…" value={f.q} onChange={set('q')} aria-label="Buscar" />
            {filtros.fuentes.length > 1 && <select value={f.fuente} onChange={set('fuente')} aria-label="Tipo"><option value="">Todo</option>{filtros.fuentes.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}</select>}
            {filtros.sucursales.length > 1 && <select value={f.sucursal_id} onChange={set('sucursal_id')} aria-label="Sucursal"><option value="">Todas las sucursales</option>{filtros.sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select>}
            <select value={f.categoria} onChange={set('categoria')} aria-label="Categoría"><option value="">Todas las categorías</option>{filtros.categorias.map((c) => <option key={c}>{c}</option>)}</select>
            <select value={f.estado} onChange={set('estado')} aria-label="Estado"><option value="">Todos los estados</option>{Object.entries(ESTADOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <button className="btn" onClick={() => descargarCsv(`inventario-${fechaHN()}.csv`, items, [['nombre', 'Ítem'], ['sucursal', 'Sucursal'], ['categoria', 'Categoría'], ['existencia', 'Existencia'], ['unidad', 'Unidad'], ['minimo', 'Mínimo'], ['valor', 'Valor'], ['vence', 'Vence'], ['estado', 'Estado']])}>Descargar CSV</button>
          </div>
          <div className="tarjeta pad0"><div className="tabla-wrap"><table>
            <thead><tr><th>Ítem</th><th>Sucursal</th><th className="der">Existencia</th><th className="der">Mínimo</th>{costos && <th className="der">Valor</th>}<th>Vence</th><th>Estado</th></tr></thead>
            <tbody>{items.map((i) => (
              <tr key={i.clave}><td>{i.nombre}<br /><small>{i.categoria}</small></td><td>{i.sucursal ?? '—'}</td>
                <td className="der num">{numero(i.existencia, 2)} {i.unidad}</td>
                <td className="der num">{puede('inv:mover') ? <button className="btn fantasma" onClick={() => setMin(i)} title="Cambiar mínimo">{i.minimo == null ? '—' : numero(i.minimo, 1)}{i.minimo_propio ? ' ✎' : ''}</button> : (i.minimo == null ? '—' : numero(i.minimo, 1))}</td>
                {costos && <td className="der num">{i.valor == null ? <small>sin costo</small> : lempiras(i.valor)}</td>}
                <td className="num">{i.vence ?? ''}</td><td><Estadito e={i.estado} /></td></tr>))}</tbody>
          </table>{items.length === 0 && <Vacio titulo="Sin resultados">Cambia los filtros.</Vacio>}</div></div>
        </>
      )}</Estado>
      {min && <Minimo item={min} onCerrar={() => setMin(null)} onListo={() => { setMin(null); d.recargar(); }} />}
    </>
  );
}

function Minimo({ item, onCerrar, onListo }) {
  const [v, setV] = useState(item.minimo ?? '');
  const [ejecutar, ocupado] = useAccion();
  const guardar = (valor) => ejecutar(async () => { await put('/inv/u/minimos', { fuente: item.fuente, ref_id: item.ref_id, sucursal_id: item.sucursal_id, minimo: valor === '' || valor === null ? null : Number(valor) }); onListo(); }, 'Mínimo guardado');
  return (
    <Modal titulo={`Mínimo · ${item.nombre}`} tam="angosto" onCerrar={onCerrar}
      pie={<>{item.minimo_propio && <button className="btn" disabled={ocupado} onClick={() => guardar(null)}>Volver al de origen</button>}<button className="btn primario" disabled={ocupado} onClick={() => guardar(v)}>Guardar</button></>}>
      <Campo etiqueta={`Mínimo (${item.unidad})`} ayuda="Si baja de aquí, sale en las alertas. Vacío = sin mínimo."><input type="number" inputMode="decimal" min="0" value={v} onChange={(e) => setV(e.target.value)} autoFocus /></Campo>
    </Modal>
  );
}

export function ListaAlertas({ a, compacta = false }) {
  return (
    <>
      {a.bajo_minimo.length > 0 && <div className="tarjeta"><h3>Bajo el mínimo ({a.resumen.bajo_minimo})</h3>
        <table><tbody>{a.bajo_minimo.slice(0, compacta ? 6 : 200).map((i) => <tr key={i.clave}><td>{i.nombre}{i.sucursal ? <small> · {i.sucursal}</small> : null}</td><td className="der num">{numero(i.existencia, 2)} / {numero(i.minimo, 1)} {i.unidad}</td></tr>)}</tbody></table></div>}
      {a.negativos.length > 0 && <div className="tarjeta"><h3>Existencia negativa</h3><small>Se vendió o salió algo sin registrar la entrada.</small>
        <table><tbody>{a.negativos.slice(0, compacta ? 5 : 200).map((i) => <tr key={i.clave}><td>{i.nombre}{i.sucursal ? <small> · {i.sucursal}</small> : null}</td><td className="der num">{numero(i.existencia, 2)} {i.unidad}</td></tr>)}</tbody></table></div>}
      {a.vencimientos.length > 0 && <div className="tarjeta"><h3>Vencimientos</h3>
        <table><tbody>{a.vencimientos.slice(0, compacta ? 6 : 200).map((v) => <tr key={`${v.fuente}${v.id}`}><td>{v.nombre}<small> · {v.sucursal}</small></td><td className="der num">{numero(v.cantidad, 2)} {v.unidad}</td>
          <td className="der"><span className={`iu-estado ${v.dias_restantes < 0 ? 'agotado' : v.dias_restantes <= 2 ? 'bajo' : 'ok'}`}>{v.dias_restantes < 0 ? `venció hace ${-v.dias_restantes} d` : v.dias_restantes === 0 ? 'vence hoy' : `${v.dias_restantes} d`}</span></td></tr>)}</tbody></table></div>}
    </>
  );
}

function Alertas({ ir }) {
  const [dias, setDias] = useState(7);
  const d = useDatos(() => get(`/inv/u/alertas${qs({ dias })}`), [dias]);
  return (
    <Estado d={d}>{(a) => {
      const nada = !a.bajo_minimo.length && !a.negativos.length && !a.vencimientos.length && !a.conteos_pendientes.length && !a.traslados_en_transito.length;
      return (
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="iu-filtros"><label>Vencimientos en los próximos <select value={dias} onChange={(e) => setDias(Number(e.target.value))}>{[3, 7, 15, 30, 60].map((n) => <option key={n} value={n}>{n} días</option>)}</select></label></div>
          {nada && <Vacio titulo="Todo en orden">No hay alertas de inventario.</Vacio>}
          <ListaAlertas a={a} />
          {a.conteos_pendientes.length > 0 && <div className="tarjeta"><h3>Conteos pendientes</h3><table><tbody>{a.conteos_pendientes.map((c) => <tr key={c.id}><td>#{c.numero} {c.nombre}</td><td>{c.fecha_programada}</td><td>{c.vencido ? <span className="iu-estado agotado">atrasado</span> : c.estado === 'por_aprobar' ? <span className="iu-estado bajo">por aprobar</span> : c.estado === 'en_conteo' ? 'contando' : 'programado'}</td></tr>)}</tbody></table><button className="btn" onClick={() => ir('conteos')}>Ir a conteos</button></div>}
          {a.traslados_en_transito.length > 0 && <div className="tarjeta"><h3>Traslados en tránsito ({a.traslados_en_transito.length})</h3><small>{a.traslados_en_transito.filter((t) => t.por_recibir).length} esperan que los recibas.</small><br /><button className="btn" onClick={() => ir('traslados')}>Ir a traslados</button></div>}
        </div>
      );
    }}</Estado>
  );
}

function Kardex() {
  const [f, setF] = useState({ desde: '', hasta: '', q: '', fuente: '' });
  const d = useDatos(() => get(`/inv/u/kardex${qs(f)}`), [f.desde, f.hasta, f.q, f.fuente]);
  const fuentes = useDatos(() => get('/inv/u/existencias?q=__'), []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const fecha = (x) => new Date(x).toLocaleString('es-HN', { timeZone: 'America/Tegucigalpa', dateStyle: 'short', timeStyle: 'short' });
  return (
    <>
      <div className="iu-filtros">
        <input type="date" value={f.desde} onChange={set('desde')} aria-label="Desde" /><input type="date" value={f.hasta} onChange={set('hasta')} aria-label="Hasta" />
        <input placeholder="Buscar ítem…" value={f.q} onChange={set('q')} aria-label="Buscar" />
        {(fuentes.datos?.filtros.fuentes.length ?? 0) > 1 && <select value={f.fuente} onChange={set('fuente')} aria-label="Tipo"><option value="">Todo</option>{fuentes.datos.filtros.fuentes.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}</select>}
        <button className="btn" onClick={() => d.datos && descargarCsv(`kardex-${fechaHN()}.csv`, d.datos.map((m) => ({ ...m, fecha: fecha(m.fecha) })), [['fecha', 'Fecha'], ['nombre', 'Ítem'], ['sucursal', 'Sucursal'], ['tipo', 'Tipo'], ['cantidad', 'Cantidad'], ['motivo', 'Motivo'], ['usuario', 'Usuario']])}>Descargar CSV</button>
      </div>
      <Estado d={d}>{(rows) => (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Fecha</th><th>Ítem</th><th>Tipo</th><th className="der">Cantidad</th><th>Motivo</th><th>Quién</th></tr></thead>
          <tbody>{rows.map((m) => <tr key={m.id}><td className="num">{fecha(m.fecha)}</td><td>{m.nombre}{m.sucursal ? <small> · {m.sucursal}</small> : null}</td><td>{m.tipo}</td>
            <td className={`der num ${m.cantidad < 0 ? 'iu-dif falta' : ''}`}>{m.cantidad > 0 ? '+' : ''}{numero(m.cantidad, 2)} {m.unidad}</td><td><small>{m.motivo}</small></td><td><small>{m.usuario}</small></td></tr>)}</tbody>
        </table>{rows.length === 0 && <Vacio titulo="Sin movimientos" />}</div></div>
      )}</Estado>
    </>
  );
}
