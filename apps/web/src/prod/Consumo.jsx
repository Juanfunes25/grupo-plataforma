import { useState } from 'react';
import { get, post } from '../api.js';
import { Estado, Kpi, useAccion, useDatos } from '../ui/kit.jsx';
import { del, hoyIso, kg, nf, textoDesviacion } from './util.js';

/** Materia prima usada por tanda: la receta sugiere, quien confirma corrige lo que de verdad se usó. */
export default function Consumo() {
  const [fecha, setFecha] = useState(hoyIso());
  const [sel, setSel] = useState(null);
  const tandas = useDatos(() => get(`/prod/tandas?fecha=${fecha}`), [fecha]);
  if (sel) return <Detalle id={sel} onVolver={() => { setSel(null); tandas.recargar(); }} />;
  return (
    <>
      <div className="tarjeta pg-ctl"><label>Día<input type="date" value={fecha} max={hoyIso()} onChange={(e) => e.target.value && setFecha(e.target.value)} /></label></div>
      <small className="pg-sub">La materia prima sale de bodega en una salida por lote; aquí se confirma cuánta llevó cada tanda para saber el rendimiento real y de qué lote vino.</small>
      <Estado d={tandas}>{(l) => l.length === 0 ? <div className="vacio">Sin tandas ese día.</div> : (
        <div className="tarjeta">{l.map((t) => (
          <div className="pg-fila" key={t.id}>
            <div className="info"><b>{t.sabor_nombre}</b><span className="pg-sub">lote {t.lote} · {kg(t.kg)}</span></div>
            {t.con_consumo ? <span className="chip ok">consumo confirmado</span> : <span className="chip aviso">sin confirmar</span>}
            <button className="btn chico" onClick={() => setSel(t.id)}>Abrir</button>
          </div>))}</div>
      )}</Estado>
    </>
  );
}

function Detalle({ id, onVolver }) {
  const d = useDatos(() => get(`/prod/tandas/${id}/consumo`), [id]);
  const [real, setReal] = useState(null);       // { insumo_id: cantidad } mientras se corrige
  const [ejecutar, ocupado] = useAccion();
  return (
    <Estado d={d}>{(x) => {
      const filas = real ?? Object.fromEntries((x.confirmado ? x.guardado.map((g) => ({ insumo_id: g.insumo_id, cantidad: g.real })) : x.sugerido.consumos.map((c) => ({ insumo_id: c.insumo_id, cantidad: c.cantidad }))).map((f) => [f.insumo_id, f.cantidad]));
      const nombre = new Map([...x.sugerido.consumos.map((c) => [c.insumo_id, c]), ...x.guardado.map((g) => [g.insumo_id, g])]);
      const sugeridas = new Map(x.sugerido.consumos.map((c) => [c.insumo_id, c.sugerida ?? c.cantidad]));
      const confirmar = async () => {
        const consumos = Object.entries(filas).filter(([, v]) => Number(v) > 0).map(([insumo_id, v]) => ({ insumo_id, cantidad: Number(v) }));
        const r = await ejecutar(() => post(`/prod/tandas/${id}/consumo`, { consumos }), 'Consumo confirmado');
        if (r) { if (r.sin_inventario?.length) window.alert(`Estos insumos no están en el inventario de fábrica, así que no se descontó su existencia:\n\n${r.sin_inventario.join('\n')}`); setReal(null); d.recargar(); }
      };
      const deshacer = async () => { if (window.confirm('¿Deshacer el consumo? La materia prima vuelve al inventario y a sus lotes.') && await ejecutar(() => del(`/prod/tandas/${id}/consumo`), 'Consumo deshecho')) { setReal(null); d.recargar(); } };
      return (
        <>
          <button className="btn chico fantasma" onClick={onVolver}>← Tandas</button>
          <div className="tarjeta"><h2 style={{ margin: 0 }}>{x.tanda.sabor_nombre}</h2><small className="pg-sub">lote {x.tanda.lote} · {x.tanda.fecha} · {kg(x.tanda.kg)}</small></div>
          {!x.sugerido.tiene_receta && <div className="aviso-caja">Este sabor no tiene receta: indica qué se usó o cárgala en Recetas y costeo.</div>}
          {x.confirmado && <div className="aviso-caja ok">Consumo confirmado. Puedes corregirlo y volver a confirmar (reemplaza al anterior).</div>}
          <div className="tarjeta">
            {Object.keys(filas).length === 0 && <div className="vacio">Sin ingredientes.</div>}
            {Object.entries(filas).map(([iid, v]) => {
              const inf = nombre.get(iid); const sug = sugeridas.get(iid); const g = x.guardado.find((q) => q.insumo_id === iid);
              const desv = sug && Number(v) > 0 ? Math.round(((Number(v) - sug) / sug) * 1000) / 10 : null;
              return (
                <div className="pg-fila" key={iid}>
                  <div className="info"><b>{inf?.nombre}</b>
                    <span className="pg-sub">receta: {nf(sug ?? 0, 2)} {inf?.unidad}{desv !== null ? ` · ${textoDesviacion(desv)}` : ''}</span>
                    {g?.lotes?.length > 0 && <span className="pg-sub">lotes: {g.lotes.map((l) => `${nf(l.cantidad, 2)} del lote …${String(l.lote_id).slice(-6)}`).join(', ')}</span>}
                    {g?.sin_lote > 0 && <span className="pg-sub">{nf(g.sin_lote, 2)} sin lote de origen registrado</span>}
                  </div>
                  <input type="number" inputMode="decimal" min="0" step="0.01" style={{ width: 110 }} value={v} onChange={(e) => setReal({ ...filas, [iid]: e.target.value })} />
                  <span className="tenue">{inf?.unidad}</span>
                </div>);
            })}
          </div>
          <Kpi etiqueta="Ingredientes" valor={Object.keys(filas).length} />
          <div className="pg-ctl"><button className="btn primario grande" disabled={ocupado || !Object.keys(filas).length} onClick={confirmar}>{x.confirmado ? 'Volver a confirmar' : 'Confirmar consumo'}</button>{x.confirmado && <button className="btn peligro" onClick={deshacer}>Deshacer</button>}</div>
        </>
      );
    }}</Estado>
  );
}
