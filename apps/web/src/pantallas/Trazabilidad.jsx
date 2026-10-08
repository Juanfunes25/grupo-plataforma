import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { lempiras } from '@grupo/shared';
import { get } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { ErrorCaja, Kpi, useAccion, useDatos } from '../ui/kit.jsx';
import { ChipEstado, Chip, cuando, fechaCorta, n } from '../fab/comun.jsx';
import { imprimirEtiqueta } from '../fab/etiqueta.js';

const MOV = { produccion: 'Entró al inventario (lista para vender)', reserva: 'Reservado para una cotización', liberacion: 'Reserva liberada', despacho: 'Despachado', venta: 'Vendido', merma: 'Merma', ajuste: 'Ajuste de inventario', inicial: 'Existencia inicial' };

/** Trazabilidad de un lote: de dónde vino (insumos, operario, calidad) y a dónde fue. Es la pantalla que abre el QR de la etiqueta. */
export default function Trazabilidad() {
  const { puede } = useSesion();
  const [params, setParams] = useSearchParams();
  const lote = params.get('lote') ?? '';
  const [q, setQ] = useState('');
  const [qBusca, setQBusca] = useState('');
  const [ejecutar] = useAccion();
  const gerencia = puede('fab:editar');
  useEffect(() => { const id = setTimeout(() => setQBusca(q), 250); return () => clearTimeout(id); }, [q]);
  const lista = useDatos(() => get(`/fab/trazabilidad?q=${encodeURIComponent(qBusca)}`), [qBusca]);
  const ficha = useDatos(() => (lote ? get(`/fab/trazabilidad/lote/${encodeURIComponent(lote)}`) : Promise.resolve(null)), [lote]);
  const t = ficha.datos;
  const o = t?.orden;

  const linea = useMemo(() => {
    if (!t) return [];
    const ev = [];
    if (o) {
      ev.push({ f: o.registrado_at, txt: `Producción registrada: ${n(o.cantidad_registrada, 0)} de ${o.producto}`, por: o.operario });
      if (o.etiqueta_at) ev.push({ f: o.etiqueta_at, txt: `Etiqueta del lote generada${o.etiquetas_impresas ? ` (impresa ${o.etiquetas_impresas} ${o.etiquetas_impresas === 1 ? 'vez' : 'veces'})` : ''}` });
    }
    for (const c of t.calidad) ev.push({ f: c.fecha, txt: `Control de calidad — ${c.prueba}: ${c.resultado}${c.valor != null ? ` (${n(c.valor, 3)} ${c.unidad ?? ''})` : ''}`, por: c.por });
    for (const m of t.movimientos) ev.push({ f: m.fecha, txt: `${MOV[m.tipo] ?? m.tipo}${m.calidad === 'segunda' ? ' (segunda)' : ''}: ${m.cantidad > 0 ? '+' : ''}${n(m.cantidad, 0)}${m.cotizacion ? ` · Cot. ${m.cotizacion}${m.cliente ? ` (${m.cliente})` : ''}` : ''}${m.factura ? ` · Factura ${m.factura}` : ''}${m.detalle && !m.cotizacion ? ` · ${m.detalle}` : ''}`, por: m.por });
    return ev.filter((e) => e.f).sort((a, b) => new Date(a.f) - new Date(b.f));
  }, [t, o]);

  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Trazabilidad de lotes</h1></div>
      <div className="tarjeta pad0">
        <div style={{ padding: 12 }}>
          <p className="fab-sub" style={{ marginTop: 0 }}>Busca por número de lote o por producto, o escanea el QR de la etiqueta.</p>
          <div className="fab-toolbar"><input className="crece" placeholder="Lote (ej.: EC-261008-01) o producto…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        </div>
        <div className="tabla-wrap"><table>
          <thead><tr><th>Lote</th><th>Producto</th><th className="der">Cantidad</th><th>Estado</th><th>Producido</th><th></th></tr></thead>
          <tbody>
            {(lista.datos ?? []).map((x) => (
              <tr key={x.lote} style={x.lote === lote ? { background: 'var(--ok-fondo)' } : undefined}>
                <td><b>{x.lote}</b></td><td>{x.producto}</td><td className="der num">{n(x.cantidad, 0)}</td><td><ChipEstado estado={x.estado} /></td><td>{cuando(x.registrado_at)}</td>
                <td><button className="btn chico" onClick={() => setParams({ lote: x.lote })}>Trazar</button></td>
              </tr>
            ))}
            {(lista.datos ?? []).length === 0 && <tr><td colSpan={6} className="vacio">Sin lotes</td></tr>}
          </tbody>
        </table></div>
      </div>

      <ErrorCaja error={lote ? ficha.error : null} />
      {t && (
        <>
          <div className="tarjeta" style={{ marginTop: 14 }}>
            <div className="fab-toolbar" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>Lote {t.lote} {o && <ChipEstado estado={o.estado} />}</h2>
              {o && (
                <div className="fab-toolbar" style={{ margin: 0 }}>
                  <button className="btn primario" onClick={() => ejecutar(async () => { await imprimirEtiqueta(t.lote); ficha.recargar(); })}>Imprimir etiqueta</button>
                  <button className="btn" onClick={() => { if (o.cantidad_registrada > 60 && !window.confirm(`Se generarán ${o.cantidad_registrada} etiquetas (una por caja). ¿Continuar?`)) return; ejecutar(async () => { await imprimirEtiqueta(t.lote, 'cajas'); ficha.recargar(); }); }}>Etiquetas por caja ({n(o.cantidad_registrada, 0)})</button>
                </div>
              )}
            </div>
            {!o && <p style={{ color: 'var(--aviso)' }}>Este lote no viene de una orden de producción (es existencia inicial o un ajuste): solo hay movimientos de inventario.</p>}
            {o && (
              <div className="rejilla cols-2">
                <div>
                  <p><b>{o.producto}</b>{o.color && ` · ${o.color}`}</p>
                  <p>Producido: <b>{cuando(o.registrado_at)}</b></p>
                  <p>Operario: <b>{o.operario ?? '—'}</b></p>
                  <p>Lista para vender: <b>{o.lista_at ? cuando(o.lista_at) : `se espera el ${fechaCorta(o.disponible_desde)}`}</b></p>
                </div>
                <div>
                  <p>Orden de producción: <b>#{o.numero}</b></p>
                  <p>Mezcla / receta: <b>{o.receta ?? 'sin receta'}</b></p>
                  {o.molde && <p>Molde: <b>{o.molde}</b></p>}
                  {o.cotizacion_origen && <p>Producido para la cotización <b>#{o.cotizacion_origen.numero}</b></p>}
                  {gerencia && o.costo_m2 != null && <p>Costo real: <b>{lempiras(o.costo_m2)}</b> por m²</p>}
                </div>
              </div>
            )}
          </div>

          <div className="rejilla cols-4" style={{ marginTop: 14 }}>
            {o && <Kpi etiqueta="Registrado" valor={n(o.cantidad_registrada, 0)} />}
            {o && <Kpi etiqueta="Lista para vender" valor={o.cantidad_lista != null ? n(o.cantidad_lista, 0) : '—'} sub={o.merma ? `${n(o.merma, 0)} de merma` : undefined} />}
            <Kpi etiqueta="En inventario hoy" valor={n(t.inventario.fisico, 0)} />
            <Kpi etiqueta="Reservado" valor={n(t.inventario.reservado, 0)} />
            <Kpi acento etiqueta="Disponible" valor={n(t.inventario.disponible, 0)} />
          </div>

          {t.consumos.length > 0 && (
            <div className="tarjeta pad0" style={{ marginTop: 14 }}>
              <h2 style={{ padding: '12px 14px 0', margin: 0, fontSize: '1.05rem' }}>Materia prima usada (hacia atrás)</h2>
              <div className="tabla-wrap"><table>
                <thead><tr><th>Insumo</th><th className="der">Según receta</th><th className="der">Usado</th><th>Última compra antes del lote (proveedor · factura)</th></tr></thead>
                <tbody>
                  {t.consumos.map((c, i) => {
                    const compra = t.compras[i]?.ultima_compra;
                    return (
                      <tr key={c.insumo}><td>{c.insumo}</td><td className="der num">{n(c.teorico, 2)} {c.unidad}</td><td className="der num">{c.real != null ? `${n(c.real, 2)} ${c.unidad}` : '—'}</td>
                        <td>{compra ? `${compra.proveedor ?? 'sin proveedor'} · ${compra.factura ?? 'sin factura'} · ${fechaCorta(compra.fecha)}` : <span className="fab-sub">sin compras registradas</span>}</td></tr>
                    );
                  })}
                </tbody>
              </table></div>
            </div>
          )}

          {t.calidad.length > 0 && (
            <div className="tarjeta pad0" style={{ marginTop: 14 }}>
              <h2 style={{ padding: '12px 14px 0', margin: 0, fontSize: '1.05rem' }}>Calidad (ASTM C1670)</h2>
              <div className="tabla-wrap"><table>
                <thead><tr><th>Prueba</th><th>Resultado</th><th>Valor</th><th>Notas</th><th>Por</th></tr></thead>
                <tbody>{t.calidad.map((c, i) => <tr key={i}><td>{c.prueba}</td><td><Chip tono={c.resultado === 'aprobado' ? 'ok' : c.resultado === 'observado' ? 'aviso' : 'mal'}>{c.resultado}</Chip></td><td>{c.valor != null ? `${n(c.valor, 3)} ${c.unidad ?? ''}` : '—'}</td><td>{c.notas}</td><td>{c.por}</td></tr>)}</tbody>
              </table></div>
            </div>
          )}

          {t.destinos.length > 0 && (
            <div className="tarjeta pad0" style={{ marginTop: 14 }}>
              <h2 style={{ padding: '12px 14px 0', margin: 0, fontSize: '1.05rem' }}>Destino: cotizaciones y facturas (hacia adelante)</h2>
              <div className="tabla-wrap"><table>
                <thead><tr><th>Cotización</th><th>Cliente</th><th className="der">Reservado</th><th>Factura</th></tr></thead>
                <tbody>{t.destinos.map((d, i) => <tr key={i}><td>{d.cotizacion ? `#${d.cotizacion}` : '—'}</td><td>{d.cliente ?? '—'}</td><td className="der num">{n(d.reservado, 0)}</td><td>{d.facturas.join(', ') || '—'}</td></tr>)}</tbody>
              </table></div>
            </div>
          )}

          <div className="tarjeta" style={{ marginTop: 14 }}>
            <h2 style={{ marginTop: 0, fontSize: '1.05rem' }}>Historia del lote</h2>
            {linea.map((e, i) => (
              <div key={i} className="fab-linea"><time>{cuando(e.f)}</time><span style={{ flex: 1 }}>{e.txt}{e.por && <span className="fab-sub" style={{ display: 'inline' }}> · {e.por}</span>}</span></div>
            ))}
            {linea.length === 0 && <p className="fab-sub">Sin eventos.</p>}
          </div>
        </>
      )}
    </div>
  );
}
