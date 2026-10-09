import { useState } from 'react';
import { fechaHN } from '@grupo/shared';
import { Buscador, Campo, Estado, Modal, useAccion, useDatos } from '../ui/kit.jsx';
import { get, post, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { ORIGEN, Variacion, dinero, lps } from './comun.jsx';

export default function Precios() {
  const { puede } = useSesion();
  const [q, setQ] = useState('');
  const [soloCambios, setSoloCambios] = useState(false);
  const d = useDatos(() => get(`/compras/precios${qs({ q })}`), [q]);
  const [abierto, setAbierto] = useState(null);
  const [nuevo, setNuevo] = useState(false);
  return (
    <>
      <div className="fila espacio">
        <div className="fila"><Buscador valor={q} onCambio={setQ} placeholder="Buscar ítem…" />
          <label className="fila" style={{ gap: 6 }}><input type="checkbox" checked={soloCambios} onChange={(e) => setSoloCambios(e.target.checked)} /><span>Solo los que cambiaron</span></label></div>
        {puede('compras:editar') && <button className="btn" onClick={() => setNuevo(true)}>+ Registrar cotización</button>}
      </div>
      <Estado d={d}>{({ resumen }) => {
        const v = resumen.filter((i) => !soloCambios || (i.variacion_pct !== null && i.variacion_pct !== 0));
        if (!v.length) return <div className="tarjeta vacio">{resumen.length ? 'Ningún ítem cambió de precio.' : 'Los precios aparecen aquí al recibir órdenes de compra o al registrar cotizaciones de proveedores.'}</div>;
        return v.map((i) => {
          const k = `${i.origen}:${i.item_id}`;
          const u = i.ultimo;
          return (
            <div className="cmp-precio-item" key={k}>
              <div className="cmp-precio-cab">
                <div><b>{i.descripcion}</b> <small>{ORIGEN[i.origen]} · {i.unidad}</small>
                  <div>Último: <b className="num">{lps(u.precio_lps)}</b>{u.moneda === 'USD' && <small> ({dinero(u.precio, 'USD')} × {u.tipo_cambio})</small>} <small>· {u.proveedor ?? 'sin proveedor'} · {u.fecha}</small></div></div>
                <div style={{ textAlign: 'right' }}><Variacion pct={i.variacion_pct} dolar={i.variacion_dolar} />
                  {i.ahorro_pct > 0 && <small style={{ display: 'block' }} className="cmp-var-baja">El más barato ahorra {String(i.ahorro_pct).replace('.', ',')} %</small>}</div>
              </div>
              {i.proveedores.length > 1 && (
                <div className="tabla-wrap libre"><table data-tarjetas>
                  <thead><tr><th>Proveedor</th><th className="der">Último precio</th><th>Fecha</th><th>Cambio</th><th className="der">Compras</th></tr></thead>
                  <tbody>{i.proveedores.map((p) => (
                    <tr key={p.proveedor_id ?? 'x'} className={i.mejor_proveedor_id && i.mejor_proveedor_id === p.proveedor_id ? 'cmp-mejor' : ''}>
                      <td data-etq="">{p.proveedor}{i.mejor_proveedor_id === p.proveedor_id && <span className="chip ok" style={{ marginLeft: 6 }}>más barato</span>}</td>
                      <td className="der num" data-etq="Último precio">{lps(p.ultimo.precio_lps)}{p.ultimo.moneda === 'USD' && <small style={{ display: 'block' }}>{dinero(p.ultimo.precio, 'USD')}</small>}</td>
                      <td className="num" data-etq="Fecha">{p.ultimo.fecha}</td><td data-etq="Cambio"><Variacion pct={p.variacion_pct} dolar={p.variacion_dolar} /></td><td className="der num" data-etq="Compras">{p.compras}</td></tr>))}</tbody>
                </table></div>
              )}
              <button className="btn chico fantasma" style={{ justifySelf: 'start' }} onClick={() => setAbierto(abierto === k ? null : k)}>{abierto === k ? 'Ocultar historial' : 'Ver historial'}</button>
              {abierto === k && <Historial origen={i.origen} itemId={i.item_id} />}
            </div>
          );
        });
      }}</Estado>
      {nuevo && <Cotizacion onCerrar={() => setNuevo(false)} onListo={() => { setNuevo(false); d.recargar(); }} />}
    </>
  );
}

function Historial({ origen, itemId }) {
  const d = useDatos(() => get(`/compras/precios${qs({ origen, item_id: itemId })}`), [origen, itemId]);
  return (
    <Estado d={d}>{({ historial }) => (
      <div className="tabla-wrap libre"><table data-tarjetas>
        <thead><tr><th>Fecha</th><th>Proveedor</th><th className="der">Precio</th><th className="der">En lempiras</th><th>Origen</th></tr></thead>
        <tbody>{historial.map((h) => <tr key={h.id}><td className="num" data-etq="">{h.fecha}</td><td data-etq="Proveedor">{h.proveedor ?? '—'}</td><td className="der num" data-etq="Precio">{dinero(h.precio, h.moneda)}{h.moneda === 'USD' && <small> × {h.tipo_cambio}</small>}</td><td className="der num" data-etq="En lempiras">{lps(h.precio_lps)}</td><td data-etq="Origen"><small>{h.fuente === 'cotizacion' ? 'cotización' : `recepción${h.documento ? ` · ${h.documento}` : ''}`}</small></td></tr>)}</tbody>
      </table></div>
    )}</Estado>
  );
}

function Cotizacion({ onCerrar, onListo }) {
  const provs = useDatos(() => get('/compras/proveedores'), []);
  const cat = useDatos(() => get('/compras/catalogo'), []);
  const cfg = useDatos(() => get('/compras/config'), []);
  const [f, setF] = useState({ proveedor_id: '', item: '', moneda: 'HNL', precio: '', tipo_cambio: '', fecha: fechaHN(), documento: '' });
  const [ejecutar, ocupado] = useAccion();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const [origen, item_id] = f.item.split(':');
  const valido = f.proveedor_id && item_id && parseFloat(f.precio) >= 0 && f.precio !== '' && (f.moneda === 'HNL' || parseFloat(f.tipo_cambio) > 0);
  return (
    <Modal titulo="Registrar cotización de proveedor" tam="angosto" onCerrar={onCerrar} pie={<button className="btn primario" disabled={ocupado || !valido}
      onClick={async () => { if (await ejecutar(() => post('/compras/precios', { proveedor_id: f.proveedor_id, origen, item_id, moneda: f.moneda, precio: parseFloat(f.precio), tipo_cambio: f.moneda === 'USD' ? parseFloat(f.tipo_cambio) : null, fecha: f.fecha, documento: f.documento || null }), 'Cotización registrada')) onListo(); }}>Guardar</button>}>
      <Campo etiqueta="Proveedor"><select value={f.proveedor_id} onChange={set('proveedor_id')}><option value="">Elegir…</option>{(provs.datos ?? []).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</select></Campo>
      <Campo etiqueta="Ítem"><select value={f.item} onChange={set('item')}><option value="">Elegir…</option>{(cat.datos ?? []).map((i) => <option key={`${i.origen}:${i.id}`} value={`${i.origen}:${i.id}`}>{i.nombre} ({i.unidad})</option>)}</select></Campo>
      <div className="rejilla cols-2">
        <Campo etiqueta="Moneda"><select value={f.moneda} onChange={(e) => setF({ ...f, moneda: e.target.value, tipo_cambio: e.target.value === 'USD' && !f.tipo_cambio && cfg.datos?.tipo_cambio_sugerido?.valor ? String(cfg.datos.tipo_cambio_sugerido.valor) : f.tipo_cambio })}><option value="HNL">Lempiras</option><option value="USD">Dólares</option></select></Campo>
        <Campo etiqueta="Precio por unidad"><input inputMode="decimal" value={f.precio} onChange={set('precio')} /></Campo>
        {f.moneda === 'USD' && <Campo etiqueta="Tipo de cambio"><input inputMode="decimal" value={f.tipo_cambio} onChange={set('tipo_cambio')} /></Campo>}
        <Campo etiqueta="Fecha"><input type="date" max={fechaHN()} value={f.fecha} onChange={set('fecha')} /></Campo>
      </div>
      <Campo etiqueta="Referencia (cotización o factura)"><input value={f.documento} onChange={set('documento')} /></Campo>
    </Modal>
  );
}
