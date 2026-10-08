import { useState } from 'react';
import { get, qs } from '../api.js';
import { BarrasH, Estado, Kpi, descargarCsv, useDatos } from '../ui/kit.jsx';
import { hoyIso, kg, nf } from './util.js';
import { sumarDias } from '@grupo/shared';

/** Lo producido entre dos fechas exactas, tanda por tanda, para auditar. */
export default function Rango() {
  const [desde, setDesde] = useState(sumarDias(hoyIso(), -6));
  const [hasta, setHasta] = useState(hoyIso());
  const listo = desde && hasta && desde <= hasta;
  const d = useDatos(() => (listo ? get(`/prod/tandas/rango${qs({ desde, hasta })}`) : Promise.resolve(null)), [desde, hasta]);
  return (
    <>
      <div className="tarjeta pg-ctl"><label>Desde<input type="date" value={desde} max={hasta || hoyIso()} onChange={(e) => setDesde(e.target.value)} /></label><label>Hasta<input type="date" value={hasta} min={desde} max={hoyIso()} onChange={(e) => setHasta(e.target.value)} /></label></div>
      {!listo ? <div className="vacio">Elige las dos fechas para ver lo producido en ese período.</div> : (
        <Estado d={d}>{(r) => r && (
          <>
            <div className="rejilla" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}><Kpi acento etiqueta="Producido en el período" valor={kg(r.totalKg)} /><Kpi etiqueta="Tandas registradas" valor={nf(r.tandas)} /></div>
            {r.porSabor.length > 0 && <div className="tarjeta"><b>Por sabor</b><BarrasH datos={r.porSabor} etiqueta={(s) => s.sabor_nombre} valor={(s) => s.kg} formato={(v) => `${nf(v, 1)} kg`} /></div>}
            <div className="pg-fila" style={{ border: 0 }}><h3 style={{ margin: 0 }}>Detalle del período</h3>
              <button className="btn chico" disabled={!r.items.length} onClick={() => descargarCsv(`produccion_${desde}_a_${hasta}.csv`, r.items, [['fecha', 'Fecha'], ['sabor_nombre', 'Sabor'], ['kg', 'Kg'], ['lote', 'Lote'], ['operario', 'Operario'], ['notas', 'Notas']])}>Descargar CSV</button></div>
            {r.items.length === 0 ? <div className="vacio">Sin producción en este período.</div> : (
              <div className="tarjeta">{r.items.map((p) => (
                <div className="pg-fila" key={p.id}><div className="info"><b>{p.sabor_nombre}</b><span className="pg-sub">{p.fecha} · lote {p.lote}{p.operario ? ` · ${p.operario}` : ''}{p.notas ? ` · ${p.notas}` : ''}</span></div><span className="chip">{p.kg} kg</span></div>))}</div>
            )}
          </>)}</Estado>
      )}
    </>
  );
}
