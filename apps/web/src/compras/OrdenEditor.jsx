import { useMemo, useState } from 'react';
import { fechaHN } from '@grupo/shared';
import { Buscador, Campo, Modal, useAccion, useDatos } from '../ui/kit.jsx';
import { get, post, put } from '../api.js';
import { useSesion } from '../sesion.jsx';
import Icono from '../ui/Icono.jsx';
import { ORIGEN, cant, dinero } from './comun.jsx';
import { NuevoProveedor } from './Proveedores.jsx';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const necesitaSucursal = (l) => l.origen === 'inv' || l.origen === 'rep_suc';

/** Precio sugerido en la moneda de la orden a partir de la última compra del ítem. */
function precioSugerido(it, moneda, tc) {
  const u = it.ultimo;
  if (u) {
    if (moneda === 'USD') return u.moneda === 'USD' ? u.precio : tc ? r2(u.precio_lps / tc) : '';
    return u.precio_lps;
  }
  if (it.costo && moneda === 'HNL') return it.costo;
  return '';
}

export default function OrdenEditor({ orden, inicial, onCerrar, onListo }) {
  const { sucursales, sucursalId } = useSesion();
  const provs = useDatos(() => get('/compras/proveedores'), []);
  const cat = useDatos(() => get('/compras/catalogo'), []);
  const cfg = useDatos(() => get('/compras/config'), []);
  const [ejecutar, ocupado] = useAccion();
  const [nuevoProv, setNuevoProv] = useState(false);
  const [q, setQ] = useState('');
  const base = orden ?? inicial ?? {};
  const [f, setF] = useState({
    proveedor_id: base.proveedor_id ?? '', sucursal_id: base.sucursal_id ?? (sucursales.length === 1 ? sucursales[0].id : sucursalId ?? ''), moneda: base.moneda ?? 'HNL', tipo_cambio: base.tipo_cambio && base.moneda === 'USD' ? String(base.tipo_cambio) : '',
    fecha_esperada: base.fecha_esperada ?? '', condicion: base.condicion ?? 'contado', dias_credito: String(base.dias_credito || 30), isv_pct: String(base.isv_pct ?? 0), notas: base.notas ?? '', correo: true,
  });
  const [lineas, setLineas] = useState((base.lineas ?? []).map((l) => ({ origen: l.origen, item_id: l.item_id, nombre: l.descripcion, unidad: l.unidad, cantidad: String(l.cantidad), precio_unitario: String(l.precio_unitario) })));
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const tcNum = parseFloat(f.tipo_cambio);
  const sugerido = cfg.datos?.tipo_cambio_sugerido;
  const ya = new Set(lineas.map((l) => `${l.origen}:${l.item_id}`));
  const resultados = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (cat.datos ?? []).filter((i) => !ya.has(`${i.origen}:${i.id}`) && (!t || i.nombre.toLowerCase().includes(t))).slice(0, 40);
  }, [cat.datos, q, lineas]); // eslint-disable-line react-hooks/exhaustive-deps
  const agregar = (i) => {
    setLineas([...lineas, { origen: i.origen, item_id: i.id, nombre: i.nombre, unidad: i.unidad, cantidad: i.sugerido > 0 ? String(i.sugerido) : '1', precio_unitario: String(precioSugerido(i, f.moneda, tcNum)) }]);
    setQ('');
  };
  const cambiarMoneda = (m) => setF({ ...f, moneda: m, tipo_cambio: m === 'USD' && !f.tipo_cambio && sugerido?.valor ? String(sugerido.valor) : f.tipo_cambio });
  const subtotal = r2(lineas.reduce((s, l) => s + r2((parseFloat(l.cantidad) || 0) * (parseFloat(l.precio_unitario) || 0)), 0));
  const isv = r2((subtotal * Number(f.isv_pct)) / 100);
  const requiereSucursal = lineas.some(necesitaSucursal);
  const prov = (provs.datos ?? []).find((p) => p.id === f.proveedor_id);
  const valido = f.proveedor_id && lineas.length > 0 && lineas.every((l) => parseFloat(l.cantidad) > 0 && parseFloat(l.precio_unitario) >= 0 && l.precio_unitario !== '')
    && (f.moneda === 'HNL' || tcNum > 0) && (!requiereSucursal || f.sucursal_id);
  const cuerpo = () => ({
    proveedor_id: f.proveedor_id, sucursal_id: requiereSucursal ? f.sucursal_id : null, moneda: f.moneda, tipo_cambio: f.moneda === 'USD' ? tcNum : null,
    fecha_esperada: f.fecha_esperada || null, condicion: f.condicion, dias_credito: f.condicion === 'credito' ? parseInt(f.dias_credito, 10) || 0 : 0, isv_pct: Number(f.isv_pct), notas: f.notas || null,
    lineas: lineas.map((l) => ({ origen: l.origen, item_id: l.item_id, cantidad: parseFloat(l.cantidad), precio_unitario: parseFloat(l.precio_unitario) })),
  });
  const guardar = async (enviar) => {
    const guardada = await ejecutar(() => (orden ? put(`/compras/ordenes/${orden.id}`, cuerpo()) : post('/compras/ordenes', cuerpo())), enviar ? null : 'Borrador guardado');
    if (!guardada) return;
    if (!enviar) return onListo(guardada);
    const r = await ejecutar(() => post(`/compras/ordenes/${guardada.id}/enviar`, { correo: f.correo && !!prov?.correo }), 'Orden enviada');
    if (r) onListo(r.orden, r.correo);
  };
  return (
    <Modal titulo={orden ? `Orden de compra N.° ${orden.numero}` : 'Nueva orden de compra'} tam="ancho" onCerrar={onCerrar}
      pie={<><button className="btn" disabled={ocupado || !valido} onClick={() => guardar(false)}>Guardar borrador</button><button className="btn primario" disabled={ocupado || !valido} onClick={() => guardar(true)}>Guardar y enviar</button></>}>
      <div className="rejilla cols-2">
        <Campo etiqueta="Proveedor" requerido>
          <div className="fila" style={{ flexWrap: 'nowrap' }}>
            <select value={f.proveedor_id} onChange={set('proveedor_id')}><option value="">Elegir proveedor…</option>{(provs.datos ?? []).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</select>
            <button type="button" className="btn" onClick={() => setNuevoProv(true)} aria-label="Nuevo proveedor"><Icono n="mas" tam={16} /></button>
          </div>
        </Campo>
        <Campo etiqueta="Entrega esperada"><input type="date" min={fechaHN()} value={f.fecha_esperada} onChange={set('fecha_esperada')} /></Campo>
        <Campo etiqueta="Moneda"><select value={f.moneda} onChange={(e) => cambiarMoneda(e.target.value)}><option value="HNL">Lempiras</option><option value="USD">Dólares (US$)</option></select></Campo>
        {f.moneda === 'USD' && <Campo etiqueta="Tipo de cambio (L por US$)" ayuda={sugerido?.valor ? `Sugerido ${sugerido.valor} (${sugerido.fuente}). Lo puedes cambiar; al recibir pones el del día de la factura.` : 'Escríbelo; al recibir pones el del día de la factura.'}><input inputMode="decimal" value={f.tipo_cambio} onChange={set('tipo_cambio')} /></Campo>}
        <Campo etiqueta="Pago"><select value={f.condicion} onChange={set('condicion')}><option value="contado">Contado</option><option value="credito">Crédito</option></select></Campo>
        {f.condicion === 'credito' && <Campo etiqueta="Días de crédito"><input inputMode="numeric" value={f.dias_credito} onChange={set('dias_credito')} /></Campo>}
        <Campo etiqueta="ISV de la compra"><select value={f.isv_pct} onChange={set('isv_pct')}><option value="0">Sin ISV / exento</option><option value="15">15 %</option><option value="18">18 %</option></select></Campo>
        {requiereSucursal && <Campo etiqueta="Entra a la sucursal" requerido><select value={f.sucursal_id} onChange={set('sucursal_id')}><option value="">Elegir…</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select></Campo>}
      </div>

      <h3 style={{ marginTop: 6 }}>Qué se compra</h3>
      <Buscador valor={q} onCambio={setQ} placeholder="Buscar insumo o producto para agregar…" ancho={520} />
      {(q.trim() || lineas.length === 0) && (
        <div className="cmp-buscar-lista" role="listbox" aria-label="Resultados">
          {cat.cargando && <small style={{ padding: 8 }}>Cargando catálogo…</small>}
          {resultados.map((i) => (
            <button type="button" key={`${i.origen}:${i.id}`} onClick={() => agregar(i)} role="option">
              <span>{i.nombre} <small>{i.unidad}</small></span>
              <small>{i.bajo_minimo ? 'bajo mínimo · ' : ''}{i.stock === null ? 'sin conteo' : `hay ${cant(i.stock)}`} · {ORIGEN[i.origen]}</small>
            </button>))}
          {!cat.cargando && resultados.length === 0 && <small style={{ padding: 8 }}>No hay coincidencias. Los ítems nuevos se crean primero en Inventario.</small>}
        </div>
      )}
      <div className="cmp-lineas">
        {lineas.map((l, k) => {
          const imp = r2((parseFloat(l.cantidad) || 0) * (parseFloat(l.precio_unitario) || 0));
          const act = (campo) => (e) => setLineas(lineas.map((x, j) => (j === k ? { ...x, [campo]: e.target.value } : x)));
          return (
            <div className="cmp-linea" key={`${l.origen}:${l.item_id}`}>
              <div className="nom"><b>{l.nombre}</b><small>{ORIGEN[l.origen]} · {l.unidad}</small></div>
              <input inputMode="decimal" aria-label={`Cantidad de ${l.nombre}`} placeholder="Cant." value={l.cantidad} onChange={act('cantidad')} />
              <input inputMode="decimal" aria-label={`Precio de ${l.nombre}`} placeholder={f.moneda === 'USD' ? 'US$' : 'L'} value={l.precio_unitario} onChange={act('precio_unitario')} />
              <div className="imp">{dinero(imp, f.moneda)}</div>
              <button type="button" className="btn fantasma quitar" aria-label={`Quitar ${l.nombre}`} onClick={() => setLineas(lineas.filter((_, j) => j !== k))}><Icono n="x" tam={16} /></button>
            </div>);
        })}
      </div>
      <div style={{ textAlign: 'right', display: 'grid', gap: 2 }}>
        <span>Subtotal <b className="num">{dinero(subtotal, f.moneda)}</b></span>
        {isv > 0 && <span>ISV {f.isv_pct} % <b className="num">{dinero(isv, f.moneda)}</b></span>}
        <span style={{ fontSize: '1.2rem' }}>Total <b className="num">{dinero(subtotal + isv, f.moneda)}</b>{f.moneda === 'USD' && tcNum > 0 && <small> ≈ {dinero((subtotal + isv) * tcNum)}</small>}</span>
      </div>
      <Campo etiqueta="Notas para el proveedor"><textarea rows={2} value={f.notas} onChange={set('notas')} /></Campo>
      {prov && <label className="fila" style={{ gap: 8 }}><input type="checkbox" checked={f.correo && !!prov.correo} disabled={!prov.correo} onChange={(e) => setF({ ...f, correo: e.target.checked })} />
        <span>{prov.correo ? `Al enviar, mandar la orden por correo a ${prov.correo}` : 'Este proveedor no tiene correo: se imprime o se manda por otro medio'}</span></label>}
      {nuevoProv && <NuevoProveedor onCerrar={() => setNuevoProv(false)} onListo={(p) => { setNuevoProv(false); provs.recargar(); setF((x) => ({ ...x, proveedor_id: p.id })); }} />}
    </Modal>
  );
}
