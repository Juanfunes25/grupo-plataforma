import { useState } from 'react';
import { lempiras, sumarDias } from '@grupo/shared';
import { get, qs } from '../api.js';
import { BarrasH, Columnas, Estado, Kpi, descargarCsv, useDatos } from '../ui/kit.jsx';
import { Chip, ChipEstado, cuando, fechaCorta, hoyIso, n, ESTADO } from '../fab/comun.jsx';

/** Panorama de producción: producido, en secado, lista para vender, merma, consumo real vs receta, inventario, calidad y alertas. */
export default function ReporteProduccion() {
  const [rango, setRango] = useState({ desde: sumarDias(hoyIso(), -29), hasta: hoyIso() });
  const d = useDatos(() => get(`/fab/reporte${qs(rango)}`), [rango.desde, rango.hasta]);
  const atajo = (dias) => setRango({ desde: sumarDias(hoyIso(), -(dias - 1)), hasta: hoyIso() });

  const exportar = (r) => descargarCsv(`registros-produccion-${rango.desde}_${rango.hasta}.csv`,
    r.registros.map((x) => ({ ...x, fecha: cuando(x.registrado_at), estado_txt: ESTADO[x.estado]?.[0] ?? x.estado, disp: x.disponible_desde ? String(x.disponible_desde).slice(0, 10) : '' })),
    [['fecha', 'Fecha y hora'], ['operario', 'Operario'], ['producto', 'Producto'], ['cantidad', 'Cantidad'], ['unidad', 'Unidad'], ['lote', 'Lote'], ['estado_txt', 'Estado'], ['disp', 'Disponible desde']]);

  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Reporte de producción</h1></div>
      <div className="fab-toolbar">
        <button className="btn" onClick={() => atajo(1)}>Hoy</button>
        <button className="btn" onClick={() => atajo(7)}>7 días</button>
        <button className="btn" onClick={() => atajo(30)}>30 días</button>
        <button className="btn" onClick={() => setRango({ desde: `${hoyIso().slice(0, 7)}-01`, hasta: hoyIso() })}>Este mes</button>
        <input type="date" value={rango.desde} max={rango.hasta} onChange={(e) => setRango({ ...rango, desde: e.target.value })} />
        <input type="date" value={rango.hasta} min={rango.desde} max={hoyIso()} onChange={(e) => setRango({ ...rango, hasta: e.target.value })} />
        {d.datos && <button className="btn" onClick={() => exportar(d.datos)}>Exportar registros (CSV)</button>}
      </div>
      <Estado d={d}>{(r) => (
        <>
          <div className="rejilla cols-4">
            <Kpi acento etiqueta="Producido" valor={`${n(r.kpis.m2_producidos, 1)} m²`} sub={`${r.kpis.registros} registros${r.kpis.cajas_esquina_producidas ? ` · ${n(r.kpis.cajas_esquina_producidas, 0)} cajas de esquina` : ''}`} />
            <Kpi etiqueta="En secado" valor={`${n(r.kpis.en_produccion_m2, 1)} m²`} sub={`${r.kpis.en_produccion_lotes} lotes que aún no pasan a lista para vender`} />
            <Kpi etiqueta="Lista para vender" valor={`${n(r.kpis.liberado_m2, 1)} m²`} sub={r.kpis.segunda_m2 ? `+ ${n(r.kpis.segunda_m2, 1)} m² de segunda` : 'primera calidad'} />
            <Kpi etiqueta="Merma" valor={`${n(r.kpis.merma_pct, 1)}%`} sub={`${n(r.kpis.merma_m2, 1)} m² perdidos`} />
            <Kpi etiqueta="Insumos consumidos" valor={lempiras(r.kpis.costo_insumos)} sub="a costo promedio" />
            <Kpi etiqueta="Costo por m²" valor={r.kpis.costo_m2_promedio != null ? lempiras(r.kpis.costo_m2_promedio) : '—'} sub="lotes ya liberados" />
          </div>

          <div className="tarjeta" style={{ marginTop: 14 }}>
            <h2 style={{ marginTop: 0, fontSize: '1.05rem' }}>Producción por día (m²)</h2>
            <Columnas datos={r.por_dia.length > 45 ? r.por_dia.slice(-45) : r.por_dia} etiqueta={(x) => x.etiqueta} valor={(x) => x.valor} formato={(v) => n(v, 1)} />
          </div>

          <div className="rejilla cols-2" style={{ marginTop: 14 }}>
            <div className="tarjeta"><h2 style={{ marginTop: 0, fontSize: '1.05rem' }}>Por modelo (m²)</h2>{r.por_modelo.length ? <BarrasH datos={r.por_modelo} etiqueta={(x) => x.nombre} valor={(x) => x.valor} formato={(v) => n(v, 1)} /> : <div className="vacio">Sin datos</div>}</div>
            <div className="tarjeta"><h2 style={{ marginTop: 0, fontSize: '1.05rem' }}>Por operario</h2>{r.por_operario.length ? <BarrasH datos={r.por_operario} etiqueta={(x) => `${x.nombre} (${x.registros})`} valor={(x) => x.valor} formato={(v) => n(v, 1)} /> : <div className="vacio">Sin datos</div>}</div>
          </div>

          <div className="tarjeta pad0" style={{ marginTop: 14 }}>
            <h2 style={{ padding: '12px 14px 0', margin: 0, fontSize: '1.05rem' }}>Producido por producto</h2>
            <div className="tabla-wrap"><table>
              <thead><tr><th>Producto</th><th className="der">Cantidad</th><th className="der">Registros</th></tr></thead>
              <tbody>
                {r.por_producto.map((p) => <tr key={p.nombre + p.unidad}><td>{p.nombre}</td><td className="der num">{n(p.valor, 2)} {p.unidad}</td><td className="der num">{p.registros}</td></tr>)}
                {r.por_producto.length === 0 && <tr><td colSpan={3} className="vacio">Sin producción en este rango</td></tr>}
              </tbody>
            </table></div>
          </div>

          <div className="tarjeta pad0" style={{ marginTop: 14 }}>
            <h2 style={{ padding: '12px 14px 0', margin: 0, fontSize: '1.05rem' }}>Materia prima: consumo real vs. receta</h2>
            <div className="tabla-wrap"><table>
              <thead><tr><th>Insumo</th><th className="der">Según receta</th><th className="der">Consumido</th><th className="der">Desvío</th><th className="der">Costo</th></tr></thead>
              <tbody>
                {r.consumo.map((c) => (
                  <tr key={c.insumo}><td>{c.insumo}</td><td className="der num">{n(c.teorico, 2)} {c.unidad}</td><td className="der num">{n(c.real, 2)} {c.unidad}</td>
                    <td className="der num" style={{ color: c.desvio_pct != null && Math.abs(c.desvio_pct) > 10 ? 'var(--peligro)' : undefined }}>{c.desvio_pct != null ? `${c.desvio_pct > 0 ? '+' : ''}${n(c.desvio_pct, 1)}%` : '—'}</td>
                    <td className="der num">{lempiras(c.costo)}</td></tr>
                ))}
                {r.consumo.length === 0 && <tr><td colSpan={5} className="vacio">Sin consumos. Si los modelos no tienen receta, no se descuenta materia prima.</td></tr>}
              </tbody>
            </table></div>
          </div>

          <div className="rejilla cols-2" style={{ marginTop: 14 }}>
            <div className="tarjeta pad0">
              <h2 style={{ padding: '12px 14px 0', margin: 0, fontSize: '1.05rem' }}>Inventario de piedra hoy</h2>
              <table><tbody>
                {r.inventario.map((i) => <tr key={i.nombre}><td>{i.nombre}</td><td className="der num"><b>{n(i.disponible, 1)}</b> {i.unidad} disp.{i.fisico !== i.disponible && <span className="fab-sub">{n(i.fisico, 1)} físicos (hay reservas)</span>}</td></tr>)}
                {r.inventario.length === 0 && <tr><td className="vacio">Aún no hay piedra en inventario (entra al pasar a lista para vender).</td></tr>}
              </tbody></table>
            </div>
            <div className="tarjeta pad0">
              <h2 style={{ padding: '12px 14px 0', margin: 0, fontSize: '1.05rem' }}>Insumos críticos</h2>
              <table><tbody>
                {r.insumos_criticos.map((i) => <tr key={i.nombre}><td>{i.nombre}</td><td className="der num">{n(i.stock, 2)} {i.unidad} {i.stock < 0 ? <Chip tono="mal">negativo</Chip> : <Chip tono="aviso">bajo mínimo</Chip>}</td></tr>)}
                {r.insumos_criticos.length === 0 && <tr><td style={{ color: 'var(--ok)' }}>Todo en orden</td></tr>}
              </tbody></table>
              {r.insumos_criticos.some((i) => i.stock < 0) && <p className="fab-sub" style={{ padding: '0 14px 12px' }}>Negativo = se produjo con más materia prima de la registrada: falta cargar compras.</p>}
            </div>
          </div>

          {r.por_producir.length > 0 && (
            <div className="tarjeta pad0" style={{ marginTop: 14 }}>
              <h2 style={{ padding: '12px 14px 0', margin: 0, fontSize: '1.05rem' }}>Por producir (pedidos que faltan)</h2>
              <table><tbody>{r.por_producir.map((o) => <tr key={o.lote}><td>{o.producto}</td><td>{n(o.cantidad, 2)} {o.unidad}</td><td>{fechaCorta(o.fecha_programada)}</td><td>{o.cotizacion ? `Cot. #${o.cotizacion}` : 'Stock'}</td></tr>)}</tbody></table>
            </div>
          )}

          <div className="rejilla cols-2" style={{ marginTop: 14 }}>
            <div className="tarjeta"><h2 style={{ marginTop: 0, fontSize: '1.05rem' }}>Calidad</h2>
              <Chip tono="ok">{r.calidad.aprobado} aprobados</Chip> <Chip tono="aviso">{r.calidad.observado} observados</Chip> <Chip tono="mal">{r.calidad.rechazado} rechazados</Chip>
            </div>
            <div className="tarjeta"><h2 style={{ marginTop: 0, fontSize: '1.05rem' }}>Alertas de producción</h2>
              {r.alertas.map((a) => <div key={a.id} className="fab-linea" style={{ display: 'block' }}><Chip tono={a.severidad === 'alta' ? 'mal' : 'aviso'}>{a.severidad}</Chip> {a.titulo}<span className="fab-sub">{cuando(a.created_at)} · {a.estado}</span></div>)}
              {r.alertas.length === 0 && <p style={{ color: 'var(--ok)', margin: 0 }}>Sin alertas en el rango.</p>}
            </div>
          </div>

          <div className="tarjeta pad0" style={{ marginTop: 14 }}>
            <h2 style={{ padding: '12px 14px 0', margin: 0, fontSize: '1.05rem' }}>Registros del operario (detalle)</h2>
            <div className="tabla-wrap"><table>
              <thead><tr><th>Fecha y hora</th><th>Operario</th><th>Producto</th><th className="der">Cantidad</th><th>Lote</th><th>Estado</th><th>Lista para vender</th></tr></thead>
              <tbody>
                {r.registros.map((x) => (
                  <tr key={x.id}><td>{cuando(x.registrado_at)}</td><td>{x.operario}</td><td>{x.producto}</td><td className="der num">{n(x.cantidad, 2)} {x.unidad}</td><td>{x.lote}</td><td><ChipEstado estado={x.estado} /></td><td>{fechaCorta(x.disponible_desde)}</td></tr>
                ))}
                {r.registros.length === 0 && <tr><td colSpan={7} className="vacio">Sin registros en este rango</td></tr>}
              </tbody>
            </table></div>
          </div>
        </>
      )}</Estado>
    </div>
  );
}
