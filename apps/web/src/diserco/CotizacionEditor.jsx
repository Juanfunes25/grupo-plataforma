import { useEffect, useMemo, useState } from 'react';
import { lempiras, numero } from '@grupo/shared';
import { get, post, put, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, useAccion } from '../ui/kit.jsx';
import { calcularCotizacion } from './calculo.js';
import { FIRMA_DEFECTO, SECCIONES_PRODUCTOS, SECCIONES_PROYECTO } from './plantillas.js';

const UNIDADES = ['m2', 'ml', 'global', 'unidad'];
const entero = (v) => (v === '' ? '' : String(Math.max(0, Math.round(Number(v)) || 0)));
const vacia = (tipo) => (tipo === 'proyecto'
  ? { producto_id: '', descripcion: '', cantidad: '', unidad: 'm2', precio_unitario: '', costo_unitario: '', presentacion: '' }
  : { producto_id: '', descripcion: '', cantidad: '1', unidad: 'unidad', precio_unitario: '', costo_unitario: '', presentacion: '' });

// Editor de cotizaciones DISERCO: Proyecto (área × valor por m², secciones y firma) o Productos (kits con cantidad, presentación, rendimientos e información bancaria).
export default function CotizacionEditor({ inicial, tipo: tipoNuevo, onCancelar, onGuardada }) {
  const { puede } = useSesion();
  const [ejecutar, guardando] = useAccion();
  const tipo = inicial?.tipo ?? tipoNuevo;
  const esProyecto = tipo === 'proyecto';
  const gerencia = puede('pos:anular');
  const [cli, setCli] = useState({ cliente_id: '', nombre_cliente: '', rtn_cliente: '', telefono: '', email: '', exento: false });
  const [enc, setEnc] = useState({ contacto: '', proyecto: '', ubicacion: '', vigencia_dias: 30, descuento_pct: '', mostrar_bancos: !esProyecto, firma_nombre: esProyecto ? FIRMA_DEFECTO.firma_nombre : '', firma_cargo: esProyecto ? FIRMA_DEFECTO.firma_cargo : '', notas_internas: '' });
  const [lineas, setLineas] = useState([vacia(tipo)]);
  const [secciones, setSecciones] = useState(esProyecto ? SECCIONES_PROYECTO : SECCIONES_PRODUCTOS);
  const [productos, setProductos] = useState([]);
  const [resultados, setResultados] = useState([]);
  const [busca, setBusca] = useState('');

  useEffect(() => {
    get('/diserco/productos').then(setProductos).catch(() => {});
    if (inicial) {
      setCli({ cliente_id: inicial.cliente_id ?? '', nombre_cliente: inicial.nombre_cliente, rtn_cliente: inicial.rtn_cliente ?? '', telefono: inicial.telefono ?? '', email: inicial.email ?? '', exento: !!inicial.exento_impuestos });
      setEnc({ contacto: inicial.contacto ?? '', proyecto: inicial.proyecto ?? '', ubicacion: inicial.ubicacion ?? '', vigencia_dias: inicial.vigencia_dias, descuento_pct: Number(inicial.descuento_pct) || '', mostrar_bancos: !!inicial.mostrar_bancos, firma_nombre: inicial.firma_nombre ?? '', firma_cargo: inicial.firma_cargo ?? '', notas_internas: inicial.notas_internas ?? '' });
      setSecciones(inicial.secciones ?? []);
      setLineas(inicial.lineas.map((l) => ({ producto_id: l.producto_id ?? '', descripcion: l.descripcion, cantidad: String(Number(l.cantidad)), unidad: l.unidad, precio_unitario: String(Number(l.precio_unitario)), costo_unitario: Number(l.costo_unitario) ? String(Number(l.costo_unitario)) : '', presentacion: l.presentacion ?? '' })));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Búsqueda de clientes existentes en el directorio común del grupo.
  useEffect(() => {
    const t = busca.trim();
    if (t.length < 2) { setResultados([]); return undefined; }
    const h = setTimeout(() => get(`/terceros${qs({ q: t, tipo: 'cliente', limite: 6 })}`).then((r) => setResultados(r.filter((c) => !c.es_consumidor_final))).catch(() => setResultados([])), 250);
    return () => clearTimeout(h);
  }, [busca]);

  const porId = useMemo(() => new Map(productos.map((p) => [p.id, p])), [productos]);
  function elegirCliente(c) {
    setCli({ cliente_id: c.id, nombre_cliente: c.nombre, rtn_cliente: c.rtn ?? '', telefono: c.telefono ?? '', email: c.correo ?? '', exento: !!c.exento_impuestos });
    setBusca('');
  }
  const setL = (i, cambios) => setLineas((ls) => ls.map((l, j) => (j === i ? { ...l, ...cambios } : l)));
  function elegirProducto(i, id) {
    const p = porId.get(id);
    if (!p) return setL(i, { producto_id: '' });
    setL(i, { producto_id: p.id, descripcion: p.nombre, presentacion: p.presentacion ?? '', unidad: p.unidad_venta ?? 'unidad', precio_unitario: String(Number(p.precio)), costo_unitario: Number(p.costo_estandar) ? String(Number(p.costo_estandar)) : '' });
    if (!esProyecto && p.rendimiento_texto) {
      setSecciones((ss) => {
        const linea = `${p.nombre}: ${p.rendimiento_texto}`;
        const i0 = ss.findIndex((s) => /rendimiento/i.test(s.titulo));
        if (i0 < 0) return [...ss, { titulo: 'Rendimientos aproximados', texto: linea }];
        if (ss[i0].texto.includes(linea)) return ss;
        return ss.map((s, k) => (k === i0 ? { ...s, texto: s.texto ? `${s.texto}\n${linea}` : linea } : s));
      });
    }
  }

  const calc = useMemo(
    () => calcularCotizacion(lineas.map((l) => ({ cantidad: Number(l.cantidad) || 0, precio_unitario: Number(l.precio_unitario) || 0, isv_tasa: 0.15, costo_unitario: Number(l.costo_unitario) || 0 })), { descuento_pct: Number(enc.descuento_pct) || 0, cliente_exento: cli.exento }),
    [lineas, enc.descuento_pct, cli.exento],
  );

  async function guardar() {
    const cuerpo = {
      tipo, cliente_id: cli.cliente_id || null, nombre_cliente: cli.nombre_cliente, rtn_cliente: cli.rtn_cliente, telefono: cli.telefono, email: cli.email, ...enc,
      descuento_pct: Number(enc.descuento_pct) || 0, vigencia_dias: Number(enc.vigencia_dias) || 30, secciones, anticipo_pct: esProyecto ? 50 : 0,
      lineas: lineas.map((l) => ({ ...l, producto_id: l.producto_id || null, cantidad: Number(l.cantidad), precio_unitario: l.precio_unitario === '' ? '' : Number(l.precio_unitario), costo_unitario: Number(l.costo_unitario) || 0 })),
    };
    const c = await ejecutar(() => (inicial ? put(`/diserco/cotizaciones/${inicial.id}`, cuerpo) : post('/diserco/cotizaciones', cuerpo)));
    if (c && c !== true) onGuardada(c);
  }

  const completa = cli.nombre_cliente.trim() && lineas.length > 0 && lineas.every((l) => l.descripcion.trim() && Number(l.cantidad) > 0 && l.precio_unitario !== '') && (!esProyecto || enc.proyecto.trim());
  const mover = (arr, i, d) => arr.map((x, j) => (j === i + d ? arr[i] : j === i ? arr[i + d] : x));

  return (
    <div className="pagina">
      <div className="tarjeta rejilla">
        <h2>{inicial ? `Editar cotización ${inicial.codigo}` : esProyecto ? 'Nueva cotización de proyecto' : 'Nueva cotización de productos'}</h2>
        <div style={{ position: 'relative' }}>
          <input placeholder="Buscar cliente existente (nombre, RTN, teléfono)…" value={busca} onChange={(e) => setBusca(e.target.value)} />
          {resultados.length > 0 && (
            <div className="dis-resultados">
              {resultados.map((c) => <button key={c.id} className="btn chico" style={{ justifyContent: 'flex-start' }} onClick={() => elegirCliente(c)}>{c.nombre} {c.rtn ? `· ${c.rtn}` : ''} {c.telefono ? `· ${c.telefono}` : ''}</button>)}
            </div>
          )}
        </div>
        <div className="dis-grid">
          <Campo etiqueta="Cliente / empresa"><input value={cli.nombre_cliente} onChange={(e) => setCli({ ...cli, cliente_id: '', nombre_cliente: e.target.value })} /></Campo>
          <Campo etiqueta="RTN"><input value={cli.rtn_cliente} onChange={(e) => setCli({ ...cli, cliente_id: '', rtn_cliente: e.target.value })} /></Campo>
          <Campo etiqueta="Teléfono / Cel"><input value={cli.telefono} onChange={(e) => setCli({ ...cli, telefono: e.target.value })} /></Campo>
          <Campo etiqueta="Correo"><input value={cli.email} onChange={(e) => setCli({ ...cli, email: e.target.value })} /></Campo>
          {esProyecto ? (<>
            <Campo etiqueta="Proyecto"><input value={enc.proyecto} onChange={(e) => setEnc({ ...enc, proyecto: e.target.value })} placeholder="Ej.: Epóxico sólido" /></Campo>
            <Campo etiqueta="Ubicación"><input value={enc.ubicacion} onChange={(e) => setEnc({ ...enc, ubicacion: e.target.value })} placeholder="Ej.: Choloma, Cortés" /></Campo>
          </>) : (
            <Campo etiqueta="Para (nombre de contacto)" ayuda="Si lo dejas vacío sale el nombre del cliente"><input value={enc.contacto} onChange={(e) => setEnc({ ...enc, contacto: e.target.value })} /></Campo>
          )}
          <Campo etiqueta="Vigencia (días)"><input type="number" value={enc.vigencia_dias} onChange={(e) => setEnc({ ...enc, vigencia_dias: e.target.value })} /></Campo>
        </div>
      </div>

      <div className="tarjeta rejilla">
        <div className="fila espacio"><h2>{esProyecto ? 'Trabajos a cotizar' : 'Productos'}</h2><button className="btn chico primario" onClick={() => setLineas([...lineas, vacia(tipo)])}>+ {esProyecto ? 'Agregar trabajo' : 'Agregar producto'}</button></div>
        <div className="tabla-wrap">
          <table className="dis-tabla-ancha" style={{ minWidth: 780 }}>
            <thead><tr>
              <th>{esProyecto ? 'Descripción del trabajo' : 'Producto'}</th><th style={{ width: 100 }}>{esProyecto ? 'Área' : 'Cantidad'}</th><th style={{ width: 120 }}>{esProyecto ? 'Unidad' : 'Presentación'}</th>
              <th style={{ width: 130 }}>{esProyecto ? 'Valor por unidad' : 'P. unitario'} <small>(sin ISV)</small></th>{gerencia && esProyecto && <th style={{ width: 110 }}>Costo est.</th>}
              <th className="der" style={{ width: 120 }}>Subtotal</th><th style={{ width: 36 }} />
            </tr></thead>
            <tbody>
              {lineas.map((l, i) => {
                const p = l.producto_id ? porId.get(l.producto_id) : null;
                const pide = Number(l.cantidad) || 0;
                return (
                  <tr key={i}>
                    <td>
                      {!esProyecto && (
                        <select value={l.producto_id} onChange={(e) => elegirProducto(i, e.target.value)} style={{ marginBottom: 4 }}>
                          <option value="">Elige un producto del catálogo…</option>
                          {productos.map((x) => <option key={x.id} value={x.id}>{x.nombre}{x.controla_inventario ? ` — ${x.existencia > 0 ? `${numero(x.existencia, 0)} disp.` : 'sin existencia'}` : ''}</option>)}
                        </select>
                      )}
                      {esProyecto
                        ? <textarea rows={4} value={l.descripcion} onChange={(e) => setL(i, { descripcion: e.target.value })} placeholder="Ej.: Nave #7. Suministro e instalación de sistema epóxico sólido color gris claro. Incluye preparación de superficie…" />
                        : <input value={l.descripcion} onChange={(e) => setL(i, { descripcion: e.target.value })} placeholder="Descripción (o elige del catálogo)" />}
                      {p?.controla_inventario && (
                        <small style={{ display: 'block', marginTop: 3, color: pide > p.existencia ? 'var(--peligro)' : undefined }}>
                          En inventario: <strong>{numero(p.existencia, 0)}</strong>{pide > p.existencia ? ` · faltan ${numero(pide - p.existencia, 0)}: se podrá facturar con aviso` : pide > 0 ? ' · alcanza' : ''}
                        </small>
                      )}
                    </td>
                    <td><input type="number" step={esProyecto ? '0.01' : '1'} min="0" inputMode={esProyecto ? 'decimal' : 'numeric'} value={l.cantidad} onChange={(e) => setL(i, { cantidad: esProyecto ? e.target.value : entero(e.target.value) })} /></td>
                    <td>{esProyecto
                      ? <select value={l.unidad} onChange={(e) => setL(i, { unidad: e.target.value })}>{[...new Set([...UNIDADES, l.unidad])].map((u) => <option key={u}>{u}</option>)}</select>
                      : <input value={l.presentacion} onChange={(e) => setL(i, { presentacion: e.target.value })} placeholder="Kit, galón…" />}</td>
                    <td><input type="number" step="0.01" min="0" value={l.precio_unitario} onChange={(e) => setL(i, { precio_unitario: e.target.value })} /></td>
                    {gerencia && esProyecto && <td><input type="number" step="0.01" min="0" value={l.costo_unitario} onChange={(e) => setL(i, { costo_unitario: e.target.value })} placeholder="opcional" /></td>}
                    <td className="der num">{lempiras(pide * (Number(l.precio_unitario) || 0))}</td>
                    <td><button className="btn chico" disabled={lineas.length === 1} onClick={() => setLineas(lineas.filter((_, j) => j !== i))} aria-label="Quitar">✕</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="dis-totales">
          {gerencia && <Campo etiqueta="Descuento negociado (%)"><input type="number" min="0" max="100" step="0.5" value={enc.descuento_pct} onChange={(e) => setEnc({ ...enc, descuento_pct: e.target.value })} style={{ width: 180 }} /></Campo>}
          {calc.descuento_total > 0 && <div>Descuento {numero(Number(enc.descuento_pct), 2)}%: −{lempiras(calc.descuento_total)}</div>}
          <div>Sub total {lempiras(calc.subtotal)}</div>
          <div>ISV 15% {lempiras(calc.isv)}</div>
          <div className="gran">Total {lempiras(calc.total)}</div>
          {gerencia && esProyecto && calc.costo > 0 && <small>Costo estimado {lempiras(calc.costo)} · margen {lempiras(calc.margen)} ({numero(calc.margen_pct, 1)}%)</small>}
        </div>
      </div>

      <div className="tarjeta rejilla">
        <h2>Textos de la cotización</h2>
        {secciones.map((s, i) => (
          <div key={i} className="dis-seccion">
            <div className="fila">
              <input style={{ flex: 1, fontWeight: 700 }} value={s.titulo} onChange={(e) => setSecciones(secciones.map((x, j) => (j === i ? { ...x, titulo: e.target.value } : x)))} placeholder="Título (ej.: Observaciones)" />
              <button className="btn chico" disabled={i === 0} onClick={() => setSecciones(mover(secciones, i, -1))} aria-label="Subir">↑</button>
              <button className="btn chico" disabled={i === secciones.length - 1} onClick={() => setSecciones(mover(secciones, i, 1))} aria-label="Bajar">↓</button>
              <button className="btn chico" onClick={() => setSecciones(secciones.filter((_, j) => j !== i))} aria-label="Quitar">✕</button>
            </div>
            <textarea rows={Math.min(10, Math.max(2, s.texto.split('\n').length + 1))} value={s.texto} onChange={(e) => setSecciones(secciones.map((x, j) => (j === i ? { ...x, texto: e.target.value } : x)))} />
          </div>
        ))}
        <div><button className="btn chico" onClick={() => setSecciones([...secciones, { titulo: '', texto: '' }])}>+ Agregar sección de texto</button></div>
        {!esProyecto && <label className="dis-check"><input type="checkbox" checked={enc.mostrar_bancos} onChange={(e) => setEnc({ ...enc, mostrar_bancos: e.target.checked })} /> Mostrar información bancaria en el PDF</label>}
        {esProyecto && (
          <div className="dis-grid">
            <Campo etiqueta="Firma — nombre"><input value={enc.firma_nombre} onChange={(e) => setEnc({ ...enc, firma_nombre: e.target.value })} /></Campo>
            <Campo etiqueta="Firma — cargo"><input value={enc.firma_cargo} onChange={(e) => setEnc({ ...enc, firma_cargo: e.target.value })} /></Campo>
          </div>
        )}
        <Campo etiqueta="Notas internas (no salen en el PDF)"><input value={enc.notas_internas} onChange={(e) => setEnc({ ...enc, notas_internas: e.target.value })} /></Campo>
        <div className="fila">
          <button className="btn primario" disabled={guardando || !completa || calc.total <= 0} onClick={guardar}>{guardando ? 'Guardando…' : 'Guardar cotización'}</button>
          <button className="btn" onClick={onCancelar}>Cancelar</button>
        </div>
      </div>
    </div>
  );
}
