// El reporte que sube cada tienda al cerrar la noche, por sucursal y período: la pregunta real del dueño
// no es «cuánto pesó tal sabor» sino «¿me están subiendo el reporte todas las noches?».
import { useState } from 'react';
import { get, qs } from '../api.js';
import { Estado, Kpi, useDatos } from '../ui/kit.jsx';
import { fechaCorta, hoyIso, sumarDias } from './lib.js';
import { useSucursalesRep } from './comun.jsx';

export function Historial({ sucursalId }) {
  const { lista, sucursal } = useSucursalesRep();
  const [sel, setSel] = useState(sucursalId || '');
  const id = sel || sucursal?.id || '';
  const [desde, setDesde] = useState(() => sumarDias(hoyIso(), -6));
  const [hasta, setHasta] = useState(hoyIso());
  const listo = id && desde && hasta && desde <= hasta;
  const d = useDatos(() => (listo ? get(`/rep/pesajes/historial${qs({ sucursal_id: id, desde, hasta })}`) : Promise.resolve(null)), [id, desde, hasta]);
  return (
    <div className="rejilla">
      {lista.length > 1 && <div className="rep-tiendas">{lista.map((s) => <button key={s.id} className={`rep-ficha ${id === s.id ? 'on' : ''}`} onClick={() => setSel(s.id)}>{s.nombre}</button>)}</div>}
      <div className="tarjeta fila">
        <input type="date" value={desde} max={hasta} onChange={(e) => setDesde(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
        <span className="tenue">a</span>
        <input type="date" value={hasta} min={desde} max={hoyIso()} onChange={(e) => setHasta(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
      </div>
      {!listo ? <div className="vacio">Elige una sucursal y las dos fechas.</div> : (
        <Estado d={d}>{(x) => x && (
          <>
            <Kpi etiqueta="Noches reportadas" valor={`${x.nochesConReporte} / ${x.diasEnRango}`} acento />
            {x.diasEnRango - x.nochesConReporte > 0 && <div className="aviso-caja">Faltan {x.diasEnRango - x.nochesConReporte} noche{x.diasEnRango - x.nochesConReporte === 1 ? '' : 's'} sin reportar en este período.</div>}
            {x.noches.length === 0 ? <div className="vacio">No hay ningún reporte en este período.</div> : x.noches.map((n) => (
              <div className="tarjeta" key={n.fecha}>
                <div className="fila espacio"><b>{fechaCorta(n.fecha)}</b><span className="chip">{n.totalKg} kg</span></div>
                {n.sabores.map((s) => <div className="rep-fila" key={s.sabor_id}><div className="rep-fila-info"><b>{s.nombre}</b></div><b className="num">{s.kg} kg</b></div>)}
              </div>
            ))}
          </>
        )}</Estado>
      )}
    </div>
  );
}
