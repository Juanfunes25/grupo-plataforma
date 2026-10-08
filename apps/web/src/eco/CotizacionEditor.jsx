import { useEffect, useMemo, useState } from 'react';
import { lempiras } from '@grupo/shared';
import { get, post, put } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, ErrorCaja, useAccion, useDatos, Cargando } from '../ui/kit.jsx';
import { calcularCotizacion, dimensionarLinea, sugerirAccesorios } from './cotizacion.js';
import { entero, num } from './util.js';
import './eco.css';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const LINEA_VACIA = (tipo) => ({ tipo, producto_id: '', descripcion: '', unidad: 'viaje', m2_neto: '', desperdicio_pct: '', cantidad: '', precio_unitario: '' });
const TIPO_CLIENTE = [['final', 'Cliente final'], ['constructora', 'Constructora'], ['arquitecto', 'Arquitecto / diseñador'], ['instalador', 'Instalador'], ['ferreteria', 'Ferretería'], ['distribuidor', 'Distribuidor']];

/** Editor de cotización: m² (+ desperdicio) → cajas completas, accesorios sugeridos por rendimiento, flete e instalación,
 *  ISV incluido o separado según la lista, descuento % opcional y existencias en vivo. */
export default function CotizacionEditor({ inicial, onGuardada, onCancelar }) {
  const { puede } = useSesion();
  const [ejecutar, ocupado] = useAccion();
  const cat = useDatos(async () => {
    const [productos, listas, pr, parametros, inv] = await Promise.all([
      get('/eco/productos'), get('/eco/listas-precio'), get('/eco/listas-precio/precios'), get('/eco/parametros'),
      get('/eco/inventario/pt').catch(() => []),
    ]);
    return { productos, listas, precios: Object.fromEntries(pr.map((x) => [`${x.producto_id}|${x.lista_id}`, Number(x.precio)])), parametros, stock: new Map(inv.map((i) => [i.id, i])) };
  }, []);
  const [cli, setCli] = useState({ cliente_id: '', nombre_cliente: '', rtn_cliente: '', telefono: '', email: '', tipo_cliente: 'final', lista_precio_id: '', exento: false });
  const [enc, setEnc] = useState({ vigencia_dias: 15, anticipo_pct: 0, notas: '', descuento_pct: '', proyecto: '', direccion_obra: '', entrega: 'retira', fecha_entrega: '' });
  const [verDescuento, setVerDescuento] = useState(false);
  const [lineas, setLineas] = useState([LINEA_VACIA('producto')]);
  const [busca, setBusca] = useState('');
  const [resultados, setResultados] = useState([]);
  const [error, setError] = useState('');
  const datos = cat.datos;

  // Cargar la cotización a editar o los valores por defecto de la empresa (una vez que llegó el catálogo).
  const [listo, setListo] = useState(false);
  useEffect(() => {
    if (!datos || listo) return;
    setListo(true);
    if (inicial) {
      setCli({ cliente_id: inicial.cliente_id ?? '', nombre_cliente: inicial.nombre_cliente, rtn_cliente: inicial.rtn_cliente ?? '', telefono: inicial.telefono ?? '', email: inicial.email ?? '',
        tipo_cliente: inicial.tipo_cliente ?? 'final', lista_precio_id: inicial.lista_precio_id ?? '', exento: Boolean(inicial.exento_impuestos) });
      setEnc({ vigencia_dias: inicial.vigencia_dias, anticipo_pct: Number(inicial.anticipo_pct), notas: inicial.notas ?? '', descuento_pct: Number(inicial.descuento_pct) || '', proyecto: inicial.proyecto ?? '',
        direccion_obra: inicial.direccion_obra ?? '', entrega: inicial.entrega, fecha_entrega: inicial.fecha_entrega ?? '' });
      setVerDescuento(Number(inicial.descuento_pct) > 0);
      const lista = datos.listas.find((x) => x.id === inicial.lista_precio_id);
      setLineas(inicial.lineas.map((l) => {
        const prod = datos.productos.find((x) => x.id === l.producto_id);
        const deLista = prod ? datos.precios[`${prod.id}|${inicial.lista_precio_id}`] ?? (lista && !lista.isv_incluido ? r2(Number(prod.precio) / (1 + Number(prod.impuesto_tasa ?? 0.15))) : Number(prod.precio)) : null;
        const factor = prod && l.m2_neto && Number(prod.m2_por_caja) > 0 && prod.unidad_venta === 'm2' ? Number(prod.m2_por_caja) : 1;
        const manual = l.producto_id ? Math.abs(Number(l.precio_unitario) - r2(deLista * factor)) > 0.005 : true;
        return { tipo: l.tipo, producto_id: l.producto_id ?? '', descripcion: l.descripcion, unidad: l.unidad, m2_neto: l.m2_neto ?? '', desperdicio_pct: Number(l.desperdicio_pct) || '', cantidad: Number(l.cantidad), precio_unitario: manual ? Number(l.precio_unitario) : '' };
      }));
    } else {
      setEnc((e) => ({ ...e, vigencia_dias: datos.parametros.vigencia_cotizacion_dias ?? 15, anticipo_pct: datos.parametros.anticipo_pct_default ?? 0 }));
    }
  }, [datos, listo, inicial]);

  // Búsqueda de clientes del directorio (con su tipo y lista de precio).
  useEffect(() => {
    const q = busca.trim();
    if (!q) { setResultados([]); return undefined; }
    const h = setTimeout(() => get(`/eco/clientes?q=${encodeURIComponent(q)}`).then(setResultados).catch(() => {}), 200);
    return () => clearTimeout(h);
  }, [busca]);

  const lista = useMemo(() => datos && (datos.listas.find((l) => l.id === cli.lista_precio_id) ?? datos.listas.find((l) => l.orden === 1) ?? datos.listas[0]), [datos, cli.lista_precio_id]);
  const porId = useMemo(() => new Map((datos?.productos ?? []).map((p) => [p.id, p])), [datos]);
  // Precio del catálogo = lista Público (con ISV). En una lista sin ISV sin precio propio se quita el ISV.
  const precioLista = (p) => datos.precios[`${p.id}|${lista?.id}`] ?? (lista && !lista.isv_incluido ? r2(Number(p.precio) / (1 + Number(p.impuesto_tasa ?? 0.15))) : Number(p.precio));

  const resueltas = useMemo(() => {
    if (!datos) return [];
    return lineas.map((l) => {
      const p = l.producto_id ? porId.get(l.producto_id) : null;
      const dim = l.tipo === 'producto' && p && Number(l.m2_neto) > 0 ? dimensionarLinea(p, Number(l.m2_neto), Number(l.desperdicio_pct) || 0) : null;
      const cantidad = dim ? dim.cantidad : Number(l.cantidad) || 0;
      const factor = dim?.factor_precio ?? 1;
      const lp = p ? r2(precioLista(p) * factor) : 0;
      const precio = l.precio_unitario !== '' && l.precio_unitario !== undefined ? Number(l.precio_unitario) : p ? lp : 0;
      const costoBase = Number(p?.costo_estandar || 0);
      return { ...l, descuento_pct: 0, p, dim, cantidad, precio_unitario: precio, precio_lista: lp, isv_tasa: p ? Number(p.impuesto_tasa ?? 0.15) : 0.15,
        costo_unitario: p ? (p.unidad_venta === 'caja' ? costoBase * Number(p.m2_por_caja || 0) : costoBase * factor) : 0 };
    });
  }, [lineas, datos, lista]); // eslint-disable-line react-hooks/exhaustive-deps
  const calc = useMemo(() => calcularCotizacion(resueltas, { isv_incluido: lista?.isv_incluido ?? true, descuento_pct: verDescuento ? Number(enc.descuento_pct) || 0 : 0, cliente_exento: cli.exento }),
    [resueltas, lista, enc.descuento_pct, verDescuento, cli.exento]);

  const setL = (i, patch) => setLineas((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const elegirCliente = (c) => {
    setCli({ cliente_id: c.id, nombre_cliente: c.nombre, rtn_cliente: c.rtn ?? '', telefono: c.telefono ?? '', email: c.email ?? '', tipo_cliente: c.tipo_cliente ?? 'final', lista_precio_id: c.lista_precio_id ?? '', exento: Boolean(c.exento_impuestos) });
    setEnc((e) => ({ ...e, direccion_obra: e.direccion_obra || c.direccion || '' }));
    setBusca(''); setResultados([]);
  };

  // Accesorios sugeridos por rendimiento (m² que cubre cada unidad) según los m² de piedra cotizados.
  const m2Total = resueltas.filter((l) => l.tipo === 'producto' && l.dim).reduce((s, l) => s + l.dim.m2_total, 0);
  const sugeridos = useMemo(() => (datos && m2Total > 0 ? sugerirAccesorios(m2Total, datos.productos.filter((a) => a.tipo === 'accesorio')) : []), [datos, m2Total]);
  const agregarSugeridos = () => setLineas((ls) => {
    const sin = ls.filter((l) => l.producto_id || l.descripcion);
    const nuevos = sugeridos.filter((s) => !sin.some((l) => l.tipo === 'accesorio' && l.producto_id === s.producto_id))
      .map((s) => ({ ...LINEA_VACIA('accesorio'), producto_id: s.producto_id, unidad: s.unidad, cantidad: s.cantidad }));
    return [...sin, ...nuevos];
  });

  const guardar = async () => {
    setError('');
    const cuerpo = {
      ...cli, ...enc, lista_precio_id: lista?.id ?? null, anticipo_pct: Number(enc.anticipo_pct) || 0, vigencia_dias: Number(enc.vigencia_dias) || 15,
      fecha_entrega: enc.entrega === 'despacho' ? enc.fecha_entrega || null : null, descuento_pct: verDescuento ? Number(enc.descuento_pct) || 0 : 0,
      lineas: lineas.filter((l) => l.producto_id || l.descripcion).map((l) => ({
        tipo: l.tipo, producto_id: l.producto_id || null, descripcion: l.descripcion, unidad: l.unidad, m2_neto: l.m2_neto === '' ? null : Number(l.m2_neto), desperdicio_pct: Number(l.desperdicio_pct) || 0,
        cantidad: resueltas[lineas.indexOf(l)]?.cantidad ?? Number(l.cantidad), precio_unitario: l.precio_unitario === '' ? undefined : Number(l.precio_unitario), descuento_pct: 0 })),
    };
    const r = await ejecutar(() => (inicial ? put(`/eco/cotizaciones/${inicial.id}`, cuerpo) : post('/eco/cotizaciones', cuerpo)));
    if (r && r !== true) onGuardada(r);
  };

  if (cat.cargando && !datos) return <Cargando texto="Cargando catálogo…" />;
  if (!datos) return <ErrorCaja error={cat.error} />;
  const piedras = datos.productos.filter((p) => p.tipo === 'piedra');
  const accs = datos.productos.filter((p) => p.tipo === 'accesorio');

  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>{inicial ? `Editar cotización #${inicial.numero}` : 'Nueva cotización de proyecto'}</h1></div>
      <ErrorCaja error={error} />
      <div className="tarjeta">
        <div style={{ position: 'relative' }}>
          <input placeholder="Buscar cliente existente (nombre, RTN, teléfono)…" value={busca} onChange={(e) => setBusca(e.target.value)} />
          {resultados.length > 0 && <div className="eco-resultados">{resultados.map((c) => <button key={c.id} className="btn chico" onClick={() => elegirCliente(c)}>{c.nombre}{c.rtn ? ` · ${c.rtn}` : ''}{c.telefono ? ` · ${c.telefono}` : ''}</button>)}</div>}
        </div>
        <div className="eco-form" style={{ marginTop: 10 }}>
          <Campo etiqueta="Cliente"><input value={cli.nombre_cliente} onChange={(e) => setCli({ ...cli, cliente_id: '', nombre_cliente: e.target.value })} /></Campo>
          <Campo etiqueta="RTN"><input value={cli.rtn_cliente} onChange={(e) => setCli({ ...cli, cliente_id: '', rtn_cliente: e.target.value })} inputMode="numeric" /></Campo>
          <Campo etiqueta="Teléfono"><input value={cli.telefono} onChange={(e) => setCli({ ...cli, telefono: e.target.value })} inputMode="tel" /></Campo>
          <Campo etiqueta="Correo"><input value={cli.email} onChange={(e) => setCli({ ...cli, email: e.target.value })} /></Campo>
          <Campo etiqueta="Tipo de cliente"><select value={cli.tipo_cliente} onChange={(e) => setCli({ ...cli, tipo_cliente: e.target.value })}>{TIPO_CLIENTE.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></Campo>
          <Campo etiqueta="Lista de precios"><select value={lista?.id ?? ''} onChange={(e) => setCli({ ...cli, lista_precio_id: e.target.value })}>{datos.listas.map((l) => <option key={l.id} value={l.id}>{l.nombre} · {l.isv_incluido ? 'ISV incluido' : '+ ISV'}</option>)}</select></Campo>
        </div>
        <div className="eco-form" style={{ marginTop: 10 }}>
          <Campo etiqueta="Proyecto / obra"><input value={enc.proyecto} onChange={(e) => setEnc({ ...enc, proyecto: e.target.value })} /></Campo>
          <Campo etiqueta="Dirección de la obra"><input value={enc.direccion_obra} onChange={(e) => setEnc({ ...enc, direccion_obra: e.target.value })} /></Campo>
          <Campo etiqueta="Entrega"><select value={enc.entrega} onChange={(e) => setEnc({ ...enc, entrega: e.target.value })}><option value="retira">Retira en planta</option><option value="despacho">Despacho a obra</option></select></Campo>
          {enc.entrega === 'despacho' && <Campo etiqueta="Fecha de entrega"><input type="date" value={enc.fecha_entrega} onChange={(e) => setEnc({ ...enc, fecha_entrega: e.target.value })} /></Campo>}
          <Campo etiqueta="Vigencia (días)"><input type="number" value={enc.vigencia_dias} onChange={(e) => setEnc({ ...enc, vigencia_dias: e.target.value })} /></Campo>
          <Campo etiqueta="Anticipo pactado (%)"><input type="number" min="0" max="100" value={enc.anticipo_pct} onChange={(e) => setEnc({ ...enc, anticipo_pct: e.target.value })} /></Campo>
        </div>
      </div>

      <div className="tarjeta eco-lineas">
        <h2>Líneas</h2>
        <div className="eco-barra">
          <button className="btn primario" onClick={() => setLineas([...lineas, LINEA_VACIA('producto')])}>+ Piedra</button>
          <button className="btn" onClick={() => setLineas([...lineas, LINEA_VACIA('accesorio')])}>+ Accesorio</button>
          <button className="btn" onClick={() => setLineas([...lineas, { ...LINEA_VACIA('flete'), descripcion: 'Flete', cantidad: 1 }])}>+ Flete</button>
          <button className="btn" onClick={() => setLineas([...lineas, { ...LINEA_VACIA('instalacion'), descripcion: 'Instalación', unidad: 'm2' }])}>+ Instalación</button>
          <button className="btn" onClick={() => setLineas([...lineas, LINEA_VACIA('otro')])}>+ Otro</button>
        </div>
        {sugeridos.length > 0 && (
          <div className="aviso-caja ok">
            <b>Accesorios sugeridos para {num(m2Total, 1)} m²:</b>
            <div className="eco-sugeridos">{sugeridos.map((s) => <span className="chip" key={s.producto_id}>{s.cantidad} × {s.descripcion}</span>)}</div>
            <button className="btn chico" onClick={agregarSugeridos}>Agregar sugeridos</button>
          </div>
        )}
        <div className="tabla-wrap"><table style={{ minWidth: 820 }}>
          <thead><tr><th>Concepto</th><th style={{ width: 110 }}>m²</th><th style={{ width: 90 }}>Desp. %</th><th style={{ width: 170 }}>Se entrega</th><th style={{ width: 130 }}>Precio {lista?.isv_incluido ? 'c/ISV' : 's/ISV'}</th><th className="der" style={{ width: 120 }}>Importe</th><th style={{ width: 40 }}></th></tr></thead>
          <tbody>
            {lineas.map((l, i) => {
              const r = resueltas[i], c = calc.lineas[i];
              const esProd = l.tipo === 'producto', esAcc = l.tipo === 'accesorio';
              const st = esProd && r?.p ? datos.stock.get(r.p.id) : null;
              const pide = st ? (r.p.unidad_venta === 'caja' ? r.cantidad : (r.dim?.m2_entregado ?? r.cantidad)) : 0;
              return (
                <tr key={i}>
                  <td>
                    {esProd && <select value={l.producto_id} onChange={(e) => setL(i, { producto_id: e.target.value, unidad: porId.get(e.target.value)?.unidad_venta ?? 'm2', precio_unitario: '' })}>
                      <option value="">Elige piedra…</option>{piedras.map((p) => { const s = datos.stock.get(p.id); return <option key={p.id} value={p.id}>{p.nombre}{s ? ` — ${s.disponible_primera > 0 ? `${num(s.disponible_primera, 1)} ${s.unidad} disp.` : 'sin existencia'}` : ''}</option>; })}</select>}
                    {esAcc && <select value={l.producto_id} onChange={(e) => setL(i, { producto_id: e.target.value, unidad: porId.get(e.target.value)?.unidad_venta ?? 'unidad', precio_unitario: '' })}><option value="">Elige accesorio…</option>{accs.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</select>}
                    {!esProd && !esAcc && <input placeholder="Descripción" value={l.descripcion} onChange={(e) => setL(i, { descripcion: e.target.value })} />}
                    {st && <span className="eco-sub" style={pide > 0 && st.disponible_primera < pide ? { color: 'var(--peligro)' } : undefined}>
                      En inventario: <b>{num(st.disponible_primera, 2)} {st.unidad}</b> disponibles{st.reservado > 0 && ` (${num(st.reservado, 2)} reservados)`}{st.en_secado > 0 && ` · ${num(st.en_secado, 2)} en secado`}
                      {pide > 0 && (st.disponible_primera >= pide ? ' · ✔ alcanza' : ` · faltan ${num(pide - st.disponible_primera, 2)} ${st.unidad}: al aprobar se ordenará producir`)}</span>}
                    {r?.p && r.precio_unitario < r.precio_lista * 0.995 && <span className="eco-sub eco-mal">Bajo lista ({lempiras(r.precio_lista)})</span>}
                  </td>
                  <td>{esProd && <input type="number" inputMode="numeric" step="1" min="1" value={l.m2_neto} onChange={(e) => setL(i, { m2_neto: entero(e.target.value) })} />}</td>
                  <td>{esProd && <input type="number" inputMode="decimal" step="1" min="0" max="50" value={l.desperdicio_pct} placeholder="0" onChange={(e) => setL(i, { desperdicio_pct: e.target.value })} />}</td>
                  <td>{esProd && r?.dim ? (
                    <span><b>{num(r.dim.cantidad, 0)} {r.dim.unidad_linea === 'caja' ? 'cajas' : r.p?.unidad_venta === 'm2' ? 'm²' : r.dim.unidad_linea}</b>
                      {r.dim.unidad_linea === 'caja' && r.p?.unidad_venta === 'm2' && <span className="eco-sub">= {num(r.dim.m2_entregado, 2)} m² (cajas de {num(r.p.m2_por_caja, 2)} m²){r.dim.factor_precio !== 1 && ` · ${lempiras(r.precio_lista)} por caja`}</span>}</span>)
                    : <span className="fila" style={{ gap: 4 }}><input type="number" inputMode="numeric" step="1" min="1" value={l.cantidad} onChange={(e) => setL(i, { cantidad: entero(e.target.value) })} /><small>{l.unidad}</small></span>}</td>
                  <td><input type="number" step="0.01" value={l.precio_unitario} placeholder={r?.p ? String(r.precio_lista) : ''} onChange={(e) => setL(i, { precio_unitario: e.target.value })} /></td>
                  <td className="der num">{lempiras(c?.monto ?? 0)}</td>
                  <td><button className="btn chico" aria-label="Quitar línea" onClick={() => setLineas(lineas.filter((_, j) => j !== i))}>✕</button></td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
        <div className="rejilla cols-2" style={{ marginTop: 12 }}>
          <Campo etiqueta="Notas para el cliente"><textarea rows={3} value={enc.notas} onChange={(e) => setEnc({ ...enc, notas: e.target.value })} /></Campo>
          <div className="eco-totales">
            {!verDescuento && <div><button className="btn chico" onClick={() => setVerDescuento(true)}>+ Aplicar descuento negociado</button></div>}
            {verDescuento && (
              <div className="fila" style={{ justifyContent: 'flex-end', alignItems: 'flex-end' }}>
                <Campo etiqueta="Descuento negociado (%)"><input type="number" min="0" max="100" step="0.5" autoFocus value={enc.descuento_pct} onChange={(e) => setEnc({ ...enc, descuento_pct: e.target.value })} /></Campo>
                <button className="btn chico" onClick={() => { setVerDescuento(false); setEnc({ ...enc, descuento_pct: '' }); }}>Quitar</button>
              </div>
            )}
            {calc.descuento_total > 0 && <div>Descuento {num(calc.descuento_pct, 2)}%: −{lempiras(calc.descuento_total)}</div>}
            <div>Subtotal {lempiras(calc.subtotal)}</div>
            <div>ISV 15% {lempiras(calc.isv)}</div>
            <div className="gran">Total {lempiras(calc.total)}</div>
            {puede('pos:catalogo') && calc.costo > 0 && <small>Costo {lempiras(calc.costo)} · margen {num(calc.margen_pct, 1)}%</small>}
          </div>
        </div>
        <div className="eco-barra" style={{ marginTop: 12 }}>
          <button className="btn primario" disabled={ocupado || !cli.nombre_cliente.trim() || calc.total <= 0} onClick={guardar}>{ocupado ? 'Guardando…' : 'Guardar cotización'}</button>
          <button className="btn" onClick={onCancelar}>Cancelar</button>
        </div>
      </div>
    </div>
  );
}
