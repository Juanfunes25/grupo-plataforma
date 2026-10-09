import { useEffect, useState } from 'react';
import { Estado, useAccion, useDatos } from '../ui/kit.jsx';
import { get, post, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { BotonExcel } from '../fin/comun.jsx';
import { ORIGEN, cant, lps } from './comun.jsx';

export default function Reorden({ onOrdenes }) {
  const { puede } = useSesion();
  const d = useDatos(() => get('/compras/reorden'), []);
  const provs = useDatos(() => get('/compras/proveedores'), []);
  const [sel, setSel] = useState({});       // clave → { cantidad, proveedor_id }
  const [ejecutar, ocupado] = useAccion();
  useEffect(() => setSel({}), [d.datos]);
  const clave = (i) => `${i.origen}:${i.id}`;
  const alternar = (i) => setSel((s) => { const n = { ...s }; if (n[clave(i)]) delete n[clave(i)]; else n[clave(i)] = { cantidad: String(i.sugerido || ''), proveedor_id: i.ultimo?.proveedor_id ?? '' }; return n; });
  const crear = async (lista) => {
    const grupos = {};
    for (const i of lista) { const s = sel[clave(i)]; (grupos[s.proveedor_id] ??= []).push({ origen: i.origen, item_id: i.id, cantidad: parseFloat(s.cantidad), precio_unitario: i.ultimo?.moneda === 'HNL' || !i.ultimo ? (i.ultimo?.precio_lps ?? i.costo ?? 0) : i.ultimo.precio_lps }); }
    let n = 0;
    for (const [proveedor_id, lineas] of Object.entries(grupos)) {
      if (await ejecutar(() => post('/compras/ordenes', { proveedor_id, lineas }))) n += 1;
    }
    if (n) { onOrdenes(`${n} ${n === 1 ? 'orden creada' : 'órdenes creadas'} en borrador`); }
  };
  return (
    <Estado d={d}>{(l) => {
      const elegidos = l.filter((i) => sel[clave(i)]);
      const listo = elegidos.length > 0 && elegidos.every((i) => sel[clave(i)].proveedor_id && parseFloat(sel[clave(i)].cantidad) > 0);
      return (
        <>
          <div className="fila espacio"><span className="fin-nota">Lo que está en o bajo su mínimo. Se descuenta lo que ya viene en camino en órdenes enviadas. Los ítems sin conteo no se sugieren.</span><BotonExcel ruta={`/compras/exportar${qs({ reporte: 'reorden' })}`} nombre="sugerencias-de-reorden.xlsx" /></div>
          <div className="tarjeta pad0"><div className="tabla-wrap"><table data-tarjetas>
            <thead><tr><th></th><th>Ítem</th><th className="der">Hay</th><th className="der">Mínimo</th><th className="der">En camino</th><th className="der">Sugerido</th><th>Último precio</th>{puede('compras:editar') && <th>Pedir</th>}</tr></thead>
            <tbody>{l.map((i) => {
              const s = sel[clave(i)];
              return (
                <tr key={clave(i)}>
                  <td data-etq="">{puede('compras:editar') && i.sugerido > 0 && <input type="checkbox" checked={!!s} onChange={() => alternar(i)} aria-label={`Elegir ${i.nombre}`} />}</td>
                  <td data-etq="Ítem">{i.nombre} <small>{ORIGEN[i.origen]} · {i.unidad}</small></td>
                  <td className={`der num ${i.stock <= 0 ? 'fin-neg' : ''}`} data-etq="Hay">{cant(i.stock)}</td><td className="der num" data-etq="Mínimo">{cant(i.minimo)}</td>
                  <td className="der num" data-etq="En camino">{i.en_camino ? cant(i.en_camino) : '—'}</td>
                  <td className="der num" data-etq="Sugerido">{i.cubierto_en_camino ? <span className="chip ok">ya viene</span> : <b>{cant(i.sugerido)}</b>}</td>
                  <td data-etq="Último precio">{i.ultimo ? <>{lps(i.ultimo.precio_lps)}<small style={{ display: 'block' }}>{i.ultimo.proveedor ?? ''}</small></> : <small>{i.costo ? `costo ${lps(i.costo)}` : 'sin precio'}</small>}</td>
                  {puede('compras:editar') && <td data-etq="Pedir">{s && <div className="fila" style={{ flexWrap: 'nowrap' }}>
                    <input inputMode="decimal" aria-label={`Cantidad de ${i.nombre}`} value={s.cantidad} onChange={(e) => setSel({ ...sel, [clave(i)]: { ...s, cantidad: e.target.value } })} style={{ maxWidth: 90, textAlign: 'right' }} />
                    <select aria-label={`Proveedor de ${i.nombre}`} value={s.proveedor_id} onChange={(e) => setSel({ ...sel, [clave(i)]: { ...s, proveedor_id: e.target.value } })} style={{ minWidth: 140 }}><option value="">Proveedor…</option>{(provs.datos ?? []).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</select></div>}</td>}
                </tr>);
            })}</tbody>
          </table>{l.length === 0 && <div className="vacio">Nada bajo su mínimo. Todo está surtido.</div>}</div></div>
          {puede('compras:editar') && elegidos.length > 0 && (
            <div className="fila" style={{ justifyContent: 'flex-end' }}>
              <span className="fin-nota">{elegidos.length} elegidos · se crea una orden en borrador por proveedor, para revisar y enviar.</span>
              <button className="btn primario" disabled={ocupado || !listo} onClick={() => crear(elegidos)}>Crear órdenes en borrador</button>
            </div>)}
        </>
      );
    }}</Estado>
  );
}
