import { useState } from 'react';
import { get, post } from '../api.js';
import { Estado, Kpi, useAccion, useDatos } from '../ui/kit.jsx';
import { hoyIso, lps, nf } from './util.js';

/** Los insumos Mec3 vienen en dólares y el dólar se mueve: re-expresa todos en Lempiras con un tipo de cambio nuevo (agrega precios, no borra nada). */
export default function CostTipoCambio() {
  const tc = useDatos(() => get('/prod/costeo/tipo-cambio'), []);
  const [valor, setValor] = useState('');
  const [fecha, setFecha] = useState(hoyIso());
  const [vp, setVp] = useState(null);
  const [ejecutar, ocupado] = useAccion();
  const cuerpo = (vista) => ({ tipo_cambio: Number(valor), fecha_vigencia: fecha, vista_previa: vista });
  return (
    <Estado d={tc}>{(x) => (
      <>
        <div className="rejilla" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))' }}>
          <Kpi acento etiqueta="Tipo de cambio actual" valor={x.tipo_cambio_usd ? `L ${nf(x.tipo_cambio_usd, 4)}` : '—'} sub="Lempiras por US$" />
          <Kpi etiqueta="Insumos en dólares" valor={nf(x.insumos_en_dolares)} />
        </div>
        <div className="tarjeta pg-ctl">
          <label>Nuevo tipo de cambio (L por US$)<input type="number" inputMode="decimal" min="0" step="0.0001" value={valor} onChange={(e) => { setValor(e.target.value); setVp(null); }} /></label>
          <label>Vigente desde<input type="date" value={fecha} onChange={(e) => { setFecha(e.target.value); setVp(null); }} /></label>
          <button className="btn" disabled={!(Number(valor) > 0) || ocupado} onClick={async () => setVp(await ejecutar(() => post('/prod/costeo/tipo-cambio/aplicar', cuerpo(true)), null))}>Ver el efecto</button>
        </div>
        {vp && (
          <>
            <div className="aviso-caja">{vp.cambios.length === 0 ? 'Ningún precio cambia con ese tipo de cambio.' : `Cambian ${vp.cambios.length} precios y ${vp.recetas.length} recetas.`} Los precios anteriores se conservan en el historial.</div>
            {vp.recetas.length > 0 && <div className="tarjeta"><b>Recetas: costo por kg</b>{vp.recetas.slice(0, 30).map((r) => (
              <div className="pg-fila" key={r.receta_id}><span>{r.nombre}</span><span className="pg-num">{lps(r.antes)} → <b>{lps(r.despues)}</b>{r.variacion_pct !== null && <span className="pg-sub">{r.variacion_pct > 0 ? '+' : ''}{r.variacion_pct.toFixed(1)}%</span>}</span></div>))}</div>}
            <button className="btn primario grande" disabled={ocupado || vp.cambios.length === 0} onClick={async () => { if (window.confirm(`¿Aplicar L ${valor} por US$ a ${vp.cambios.length} insumos?`) && await ejecutar(() => post('/prod/costeo/tipo-cambio/aplicar', cuerpo(false)), 'Precios actualizados')) { setVp(null); setValor(''); tc.recargar(); } }}>Aplicar a {vp.cambios.length} insumos</button>
          </>)}
      </>
    )}</Estado>
  );
}
