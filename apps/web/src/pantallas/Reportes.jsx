import { useEffect, useMemo, useState } from 'react';
import { get, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Tabs, descargarCsv } from '../ui/kit.jsx';
import { Barra, MapaCalor, Variacion, colorSerie } from '../cierres/graficas.jsx';
import TablaOrdenable from '../cierres/TablaOrdenable.jsx';
import { ATAJOS, DIAS, DIAS_CORTOS, L, fechaCorta, fechaHora, hora12, hoyHn, imprimirReporte, num, primerDiaMes } from '../cierres/formato.js';
import '../cierres/cierres.css';

const CLAVE_FILTROS = 'grupo.reportes.filtros.v1';
const PESTANAS = [['resumen', 'Resumen'], ['tiempo', 'Días y horas'], ['equipo', 'Sucursales y cajeros'], ['productos', 'Productos'], ['pagos', 'Pagos y descuentos'], ['fiscal', 'ISV / Fiscal'], ['libro', 'Libro de ventas'], ['anulaciones', 'Anulaciones']];

function leerFiltros() {
  try { const f = JSON.parse(localStorage.getItem(CLAVE_FILTROS) ?? 'null'); if (f?.desde && f?.hasta) return f; } catch { /* sin almacenamiento */ }
  return { sucursal_id: '', desde: primerDiaMes(), hasta: hoyHn() };
}

/** Descarga CSV (abre directo en Excel): columnas = [[titulo, fila => valor]]. */
function exportar(nombre, filas, columnas) {
  descargarCsv(nombre, filas.map((f) => Object.fromEntries(columnas.map(([, fn], i) => [i, fn(f)]))), columnas.map(([t], i) => [i, t]));
}
const d2 = (v) => Number(v ?? 0).toFixed(2);

function Kpi({ titulo, valor, anterior, invertir, detalle, dinero = true }) {
  return (
    <div className="rep-kpi">
      <span className="titulo-k">{titulo}</span>
      <strong>{dinero ? L(valor) : num(valor)}</strong>
      <span className="pie-k"><Variacion actual={valor} anterior={anterior} invertir={invertir} />{detalle && <span>{detalle}</span>}</span>
    </div>
  );
}

function Seccion({ titulo, children, onCsv, extra }) {
  return (
    <div className="tarjeta rep-seccion">
      <div className="rep-seccion-cab"><h2>{titulo}</h2>{extra}{onCsv && <button className="btn chico no-imprimir" onClick={onCsv}>CSV</button>}</div>
      {children}
    </div>
  );
}

function Hallazgos({ d }) {
  const lista = [];
  const mejorDia = [...d.por_dia].sort((a, b) => b.total - a.total)[0];
  if (mejorDia) lista.push(`Mejor día: ${DIAS[mejorDia.dia_semana]} ${fechaCorta(mejorDia.fecha)} con ${L(mejorDia.total)} (${mejorDia.facturas} facturas).`);
  const pico = [...d.por_hora].sort((a, b) => b.total - a.total)[0];
  if (pico?.total > 0) lista.push(`Hora pico: ${hora12(pico.hora)} a ${hora12((pico.hora + 1) % 24)} — ${L(pico.total)} en el periodo.`);
  const fuerte = [...d.por_dia_semana].filter((x) => x.dias > 0).sort((a, b) => b.promedio_dia - a.promedio_dia)[0];
  if (fuerte) lista.push(`El ${DIAS[fuerte.dia].toLowerCase()} es el día más fuerte: promedio ${L(fuerte.promedio_dia)} por día.`);
  const estrella = d.productos[0];
  if (estrella) lista.push(`Producto estrella: ${estrella.nombre} — ${L(estrella.total)} (${estrella.participacion}% de la venta).`);
  if (d.por_sucursal.length > 1) lista.push(`Sucursal líder: ${d.por_sucursal[0].nombre} con ${d.por_sucursal[0].participacion}% de la venta.`);
  const ef = d.por_forma_pago.find((f) => f.tipo === 'efectivo');
  if (ef) lista.push(`El ${ef.participacion}% se cobró en efectivo (${L(ef.monto)} neto del cambio).`);
  if (d.kpis.anuladas > 0) lista.push(`${d.kpis.anuladas} factura(s) anulada(s) por ${L(d.kpis.monto_anulado)} — revísalas en la pestaña Anulaciones.`);
  if (d.isv.borrador.facturas > 0) lista.push(`${d.isv.borrador.facturas} comprobante(s) en modo borrador (sin CAI real): no entran en la base del ISV fiscal.`);
  if (!lista.length) return <small>Sin ventas en este rango.</small>;
  return <ul className="rep-hallazgos">{lista.map((t) => <li key={t}>{t}</li>)}</ul>;
}

function BloqueFiscal({ titulo, r, aviso, conNc = false }) {
  return (
    <div style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
      <h3>{titulo}</h3>
      {aviso && <small>{aviso}</small>}
      <div className="tabla-wrap"><table><tbody>
        <tr><td>Ventas exentas</td><td className="der num">{L(r.exento)}</td></tr>
        <tr><td>Ventas exoneradas</td><td className="der num">{L(r.exonerado)}</td></tr>
        <tr><td>Ventas gravadas 15 % (base)</td><td className="der num">{L(r.gravado_15)}</td></tr>
        {r.gravado_18 > 0 && <tr><td>Ventas gravadas 18 % (base)</td><td className="der num">{L(r.gravado_18)}</td></tr>}
        <tr><td>ISV facturado</td><td className="der num">{L(r.isv)}</td></tr>
        {conNc && <tr><td>(−) ISV de notas de crédito parciales ({L(r.notas_credito)})</td><td className="der num">{L(-r.isv_notas_credito)}</td></tr>}
        <tr className="fila-total"><td>ISV neto</td><td className="der num">{L(r.isv_neto)}</td></tr>
        <tr><td>Facturas válidas / anuladas</td><td className="der num">{r.facturas} / {r.anuladas}</td></tr>
      </tbody></table></div>
      {r.rangos.length > 0 && (<>
        <h4>Numeración emitida</h4>
        <div className="tabla-wrap"><table>
          <thead><tr><th>Sucursal</th><th>Desde</th><th>Hasta</th><th className="der">Emitidas</th><th className="der">Anuladas</th><th className="der">Faltan</th></tr></thead>
          <tbody>{r.rangos.map((x) => (
            <tr key={x.sucursal + x.desde}><td>{x.sucursal}</td><td className="mono">{x.desde}</td><td className="mono">{x.hasta}</td><td className="der num">{x.emitidas}</td><td className="der num">{x.anuladas}</td>
              <td className="der num" title="Números del rango que no aparecen en estas fechas">{x.huecos > 0 ? <span className="alerta-num">{x.huecos}</span> : 0}</td></tr>))}</tbody>
        </table></div>
      </>)}
      {r.por_mes.length > 1 && (<>
        <h4>Por mes</h4>
        <div className="tabla-wrap"><table>
          <thead><tr><th>Mes</th><th className="der">Exento</th><th className="der">Exonerado</th><th className="der">Gravado 15 %</th><th className="der">ISV</th><th className="der">Total</th></tr></thead>
          <tbody>{r.por_mes.map((m) => <tr key={m.mes}><td>{m.mes}</td><td className="der num">{L(m.exento)}</td><td className="der num">{L(m.exonerado)}</td><td className="der num">{L(m.gravado_15)}</td><td className="der num">{L(m.isv)}</td><td className="der num">{L(m.total)}</td></tr>)}</tbody>
        </table></div>
      </>)}
    </div>
  );
}

export default function Reportes() {
  const { sucursales, sucursalId, contexto } = useSesion();
  const usaNc = Boolean(contexto?.usar_notas_credito);   // el negocio hoy no usa notas de crédito: no se muestran
  const [filtros, setFiltros] = useState(() => { const f = leerFiltros(); return sucursales.some((s) => s.id === f.sucursal_id) || !f.sucursal_id ? f : { ...f, sucursal_id: '' }; });
  const [datos, setDatos] = useState(null);
  const [tab, setTab] = useState('resumen');
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');
  const [buscarProducto, setBuscarProducto] = useState('');
  const [categoria, setCategoria] = useState('');
  const [buscarLibro, setBuscarLibro] = useState('');
  const [soloFiscal, setSoloFiscal] = useState(false);

  async function generar(f = filtros) {
    if (!f.desde || !f.hasta) return setError('Elige fecha inicial y final');
    if (f.hasta < f.desde) return setError('La fecha final es anterior a la inicial');
    setError(''); setCargando(true);
    try { localStorage.setItem(CLAVE_FILTROS, JSON.stringify(f)); } catch { /* no crítico */ }
    try { setDatos(await get(`/pos/reportes/completo${qs({ desde: f.desde, hasta: f.hasta, sucursal_id: f.sucursal_id })}`)); }
    catch (e) { setError(e.message); } finally { setCargando(false); }
  }
  useEffect(() => { generar(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const sufijo = `${filtros.desde}_a_${filtros.hasta}`;
  const nombreSucursal = filtros.sucursal_id ? sucursales.find((s) => s.id === filtros.sucursal_id)?.nombre : 'Todas las sucursales';

  const productos = useMemo(() => {
    if (!datos) return [];
    const q = buscarProducto.trim().toLowerCase();
    return datos.productos.filter((p) => (!q || p.nombre.toLowerCase().includes(q)) && (!categoria || p.categoria === categoria)).map((p, i) => ({ ...p, clave: `${p.nombre}-${i}` }));
  }, [datos, buscarProducto, categoria]);

  const libro = useMemo(() => {
    if (!datos) return [];
    const q = buscarLibro.trim().toLowerCase();
    return datos.libro_ventas.filter((f) => !soloFiscal || !f.borrador)
      .filter((f) => !q || (f.numero_factura ?? '').toLowerCase().includes(q) || f.cliente.toLowerCase().includes(q) || (f.rtn ?? '').includes(q) || f.cajero.toLowerCase().includes(q))
      .map((f, i) => ({ ...f, clave: f.numero_factura ?? i, claseFila: f.anulada ? 'fila-anulada' : undefined }));
  }, [datos, buscarLibro, soloFiscal]);

  const k = datos?.kpis, ka = datos?.kpis_anterior;
  const maxDia = datos ? Math.max(0, ...datos.por_dia.map((x) => x.total)) : 0;
  const maxHora = datos ? Math.max(0, ...datos.por_hora.map((x) => x.total)) : 0;
  const maxSemana = datos ? Math.max(0, ...datos.por_dia_semana.map((x) => x.promedio_dia)) : 0;
  const colorSuc = (id) => sucursales.find((s) => s.id === id)?.color || 'var(--acento)';

  return (
    <div className="pagina reporte-imprimible">
      <div className="encabezado-pagina"><h1>Reportes</h1></div>
      {error && <div className="aviso-caja mal">{error}</div>}

      <div className="tarjeta no-imprimir" style={{ display: 'grid', gap: 10 }}>
        <div className="filtros">
          {sucursales.length > 1 && <Campo etiqueta="Sucursal"><select value={filtros.sucursal_id} onChange={(e) => setFiltros({ ...filtros, sucursal_id: e.target.value })}><option value="">Todas las sucursales</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select></Campo>}
          <Campo etiqueta="Desde"><input type="date" value={filtros.desde} max={hoyHn()} onChange={(e) => setFiltros({ ...filtros, desde: e.target.value })} /></Campo>
          <Campo etiqueta="Hasta"><input type="date" value={filtros.hasta} max={hoyHn()} onChange={(e) => setFiltros({ ...filtros, hasta: e.target.value })} /></Campo>
          <button className="btn primario" disabled={cargando} onClick={() => generar()}>{cargando ? 'Generando…' : 'Generar'}</button>
          <button className="btn" disabled={!datos} onClick={imprimirReporte}>Imprimir / PDF</button>
        </div>
        <div className="atajos">{ATAJOS.map((a) => <button key={a.etiqueta} className="btn chico" disabled={cargando} onClick={() => { const f = { ...filtros, ...a.calcular() }; setFiltros(f); generar(f); }}>{a.etiqueta}</button>)}</div>
      </div>

      <div className="solo-impresion"><b>Reporte de ventas</b> · {nombreSucursal} · {filtros.desde} a {filtros.hasta}</div>

      {datos && (<>
        <div className="no-imprimir"><Tabs tabs={PESTANAS.map(([id, n]) => [id, id === 'anulaciones' && k.anuladas + (usaNc ? datos.notas_credito.length : 0) > 0 ? `${n} (${k.anuladas + (usaNc ? datos.notas_credito.filter((x) => x.tipo === 'Parcial').length : 0)})` : n])} valor={tab} onCambio={setTab} /></div>

        {tab === 'resumen' && (<>
          <div className="rep-kpis">
            <Kpi titulo="Ventas netas" valor={k.ventas_netas} anterior={ka.ventas_netas} detalle={`vs. ${datos.rango_anterior.desde} a ${datos.rango_anterior.hasta}`} />
            <Kpi titulo="Facturas" valor={k.facturas} anterior={ka.facturas} dinero={false} />
            <Kpi titulo="Ticket promedio" valor={k.ticket_promedio} anterior={ka.ticket_promedio} />
            <Kpi titulo="Unidades vendidas" valor={k.unidades} anterior={ka.unidades} dinero={false} />
            <Kpi titulo="Ventas brutas" valor={k.ventas_brutas} anterior={ka.ventas_brutas} detalle="antes de descuentos" />
            <Kpi titulo="Descuentos" valor={k.descuentos} anterior={ka.descuentos} invertir />
            {usaNc && <Kpi titulo="Notas de crédito" valor={k.notas_credito} anterior={ka.notas_credito} invertir detalle="parciales" />}
            <Kpi titulo="ISV facturado" valor={k.isv} anterior={ka.isv} />
            <Kpi titulo="Gastos caja chica" valor={datos.gastos.total} detalle={`${datos.gastos.movimientos} movimientos`} />
            <Kpi titulo="Ventas netas − gastos" valor={k.ventas_netas - datos.gastos.total} />
          </div>
          <Seccion titulo="Hallazgos del periodo"><Hallazgos d={datos} /></Seccion>
          <Seccion titulo="Ventas por día" onCsv={() => exportar(`ventas-por-dia-${sufijo}.csv`, datos.por_dia, [['Fecha', (x) => x.fecha], ['Día', (x) => DIAS[x.dia_semana]], ['Facturas', (x) => x.facturas], ['Total', (x) => d2(x.total)], ['Ticket promedio', (x) => d2(x.ticket_promedio)], ['Descuentos', (x) => d2(x.descuentos)]])}>
            {datos.por_dia.length === 0 ? <div className="vacio">Sin ventas en este rango.</div> : (
              <div className="barras-v" style={{ height: 180 }}>{datos.por_dia.map((x) => (
                <div key={x.fecha} className="barra-v" title={`${DIAS[x.dia_semana]} ${x.fecha}: ${L(x.total)} · ${x.facturas} facturas`}>
                  <i style={{ height: Math.max(3, maxDia > 0 ? (x.total / maxDia) * 140 : 0), background: x.dia_semana >= 5 ? 'var(--serie-3)' : 'var(--serie-1)' }} /><span className="barra-v-etq">{x.fecha.slice(8)}</span>
                </div>))}</div>
            )}
            <small>Sábados y domingos en dorado.</small>
          </Seccion>
        </>)}

        {tab === 'tiempo' && (<>
          <Seccion titulo="Mapa de calor: día de la semana × hora"><MapaCalor calor={datos.calor} color={colorSuc(filtros.sucursal_id || sucursalId)} /></Seccion>
          <div className="rep-dos">
            <Seccion titulo="Por hora" onCsv={() => exportar(`ventas-por-hora-${sufijo}.csv`, datos.por_hora, [['Hora', (x) => `${x.hora}:00`], ['Facturas', (x) => x.facturas], ['Total', (x) => d2(x.total)]])}>
              <div className="tabla-wrap"><table><tbody>{datos.por_hora.filter((x) => x.facturas > 0).map((x) => (
                <tr key={x.hora}><td>{hora12(x.hora)}</td><td><Barra valor={x.total} maximo={maxHora} /></td><td className="der num">{L(x.total)}</td><td className="der num tenue">{x.facturas}</td></tr>))}</tbody></table></div>
            </Seccion>
            <Seccion titulo="Por día de la semana (promedio por día)">
              <div className="tabla-wrap"><table><tbody>{datos.por_dia_semana.map((x) => (
                <tr key={x.dia}><td>{DIAS[x.dia]}</td><td><Barra valor={x.promedio_dia} maximo={maxSemana} color="var(--serie-3)" /></td><td className="der num">{L(x.promedio_dia)}</td><td className="der num tenue">{x.dias} día(s)</td></tr>))}</tbody></table></div>
            </Seccion>
          </div>
          <Seccion titulo="Detalle diario">
            <TablaOrdenable filas={datos.por_dia.map((x) => ({ ...x, clave: x.fecha }))} ordenInicial={{ clave: 'fecha', desc: false }} columnas={[
              { clave: 'fecha', titulo: 'Fecha', render: (x) => `${DIAS_CORTOS[x.dia_semana]} ${x.fecha}` },
              { clave: 'facturas', titulo: 'Facturas', numerica: true },
              { clave: 'ticket_promedio', titulo: 'Ticket', numerica: true, render: (x) => L(x.ticket_promedio) },
              { clave: 'descuentos', titulo: 'Descuentos', numerica: true, render: (x) => L(x.descuentos) },
              { clave: 'total', titulo: 'Total', numerica: true, render: (x) => L(x.total) }]} />
          </Seccion>
        </>)}

        {tab === 'equipo' && (<>
          <Seccion titulo="Por sucursal" onCsv={() => exportar(`ventas-por-sucursal-${sufijo}.csv`, datos.por_sucursal, [['Sucursal', (x) => x.nombre], ['Facturas', (x) => x.facturas], ['Total', (x) => d2(x.total)], ['Participación %', (x) => x.participacion], ['Ticket promedio', (x) => d2(x.ticket_promedio)], ['Descuentos', (x) => d2(x.descuentos)], ['Anuladas', (x) => x.anuladas], ['Monto anulado', (x) => d2(x.monto_anulado)]])}>
            <TablaOrdenable filas={datos.por_sucursal.map((x) => ({ ...x, clave: x.sucursal_id }))} ordenInicial={{ clave: 'total', desc: true }} columnas={[
              { clave: 'nombre', titulo: 'Sucursal', render: (x) => <span><span className="cierre-punto" style={{ display: 'inline-block', width: 9, height: 9, marginRight: 6, background: colorSuc(x.sucursal_id) }} />{x.nombre}</span> },
              { clave: 'participacion', titulo: 'Participación', render: (x) => <span><Barra valor={x.participacion} maximo={100} color={colorSuc(x.sucursal_id)} />{x.participacion}%</span> },
              { clave: 'facturas', titulo: 'Facturas', numerica: true },
              { clave: 'ticket_promedio', titulo: 'Ticket', numerica: true, render: (x) => L(x.ticket_promedio) },
              { clave: 'descuentos', titulo: 'Descuentos', numerica: true, render: (x) => L(x.descuentos) },
              { clave: 'anuladas', titulo: 'Anuladas', numerica: true },
              { clave: 'total', titulo: 'Total', numerica: true, render: (x) => L(x.total) }]} />
          </Seccion>
          <Seccion titulo="Por cajero" onCsv={() => exportar(`ventas-por-cajero-${sufijo}.csv`, datos.por_cajero, [['Cajero', (x) => x.nombre], ['Facturas', (x) => x.facturas], ['Total', (x) => d2(x.total)], ['Ticket promedio', (x) => d2(x.ticket_promedio)], ['Facturas con descuento', (x) => x.con_descuento], ['Monto descuentos', (x) => d2(x.descuentos)], ['Anuladas', (x) => x.anuladas]])}>
            <TablaOrdenable filas={datos.por_cajero.map((x, i) => ({ ...x, clave: `${x.nombre}-${i}` }))} ordenInicial={{ clave: 'total', desc: true }} columnas={[
              { clave: 'nombre', titulo: 'Cajero' },
              { clave: 'facturas', titulo: 'Facturas', numerica: true },
              { clave: 'ticket_promedio', titulo: 'Ticket', numerica: true, render: (x) => L(x.ticket_promedio) },
              { clave: 'con_descuento', titulo: 'Con descuento', numerica: true, render: (x) => `${x.con_descuento} (${x.facturas ? Math.round((x.con_descuento / x.facturas) * 100) : 0}%)` },
              { clave: 'descuentos', titulo: 'Descuentos', numerica: true, render: (x) => L(x.descuentos) },
              { clave: 'anuladas', titulo: 'Anuladas', numerica: true, render: (x) => (x.anuladas > 0 ? <span className="alerta-num">{x.anuladas}</span> : 0) },
              { clave: 'total', titulo: 'Total', numerica: true, render: (x) => L(x.total) }]} />
            <small>Un cajero con muchos descuentos o anulaciones frente a los demás merece una revisión en la Bitácora.</small>
          </Seccion>
          {datos.clientes.length > 0 && (
            <Seccion titulo="Clientes con factura a nombre (sin Consumidor Final)" onCsv={() => exportar(`clientes-${sufijo}.csv`, datos.clientes, [['Cliente', (x) => x.nombre], ['RTN', (x) => x.rtn], ['Facturas', (x) => x.facturas], ['Total', (x) => d2(x.total)]])}>
              <TablaOrdenable filas={datos.clientes.map((x, i) => ({ ...x, clave: `${x.nombre}-${i}` }))} ordenInicial={{ clave: 'total', desc: true }} columnas={[
                { clave: 'nombre', titulo: 'Cliente' }, { clave: 'rtn', titulo: 'RTN', render: (x) => <span className="mono">{x.rtn || '—'}</span> },
                { clave: 'facturas', titulo: 'Facturas', numerica: true }, { clave: 'ultima', titulo: 'Última compra', render: (x) => fechaHora(x.ultima) },
                { clave: 'total', titulo: 'Total', numerica: true, render: (x) => L(x.total) }]} />
            </Seccion>
          )}
        </>)}

        {tab === 'productos' && (<>
          <Seccion titulo="Por categoría" onCsv={() => exportar(`ventas-por-categoria-${sufijo}.csv`, datos.por_categoria, [['Categoría', (x) => x.nombre], ['Unidades', (x) => x.cantidad], ['Total', (x) => d2(x.total)], ['Participación %', (x) => x.participacion]])}>
            <div className="tabla-wrap"><table><tbody>{datos.por_categoria.map((c, i) => (
              <tr key={c.nombre} className={`clic ${categoria === c.nombre ? 'fila-sel' : ''}`} onClick={() => setCategoria(categoria === c.nombre ? '' : c.nombre)}>
                <td>{c.nombre}</td><td><Barra valor={c.participacion} maximo={datos.por_categoria[0]?.participacion ?? 100} color={colorSerie(i)} /></td>
                <td className="der num">{c.participacion}%</td><td className="der num tenue">{num(c.cantidad)} u.</td><td className="der num">{L(c.total)}</td></tr>))}</tbody></table>
              {datos.por_categoria.length === 0 && <div className="vacio">Sin ventas en este rango.</div>}</div>
            <small className="no-imprimir">Toca una categoría para filtrar los productos de abajo.</small>
          </Seccion>
          <Seccion titulo={`Productos${categoria ? ` · ${categoria}` : ''} (${productos.length})`}
            extra={<input className="rep-buscar no-imprimir" placeholder="Buscar producto…" value={buscarProducto} onChange={(e) => setBuscarProducto(e.target.value)} />}
            onCsv={() => exportar(`productos-${sufijo}.csv`, productos, [['Producto', (x) => x.nombre], ['Categoría', (x) => x.categoria], ['Unidades', (x) => x.cantidad], ['Facturas', (x) => x.facturas], ['Precio promedio', (x) => d2(x.precio_promedio)], ['Total', (x) => d2(x.total)], ['Participación %', (x) => x.participacion], ['Margen % (receta)', (x) => x.margen_pct ?? '']])}>
            <TablaOrdenable filas={productos} limite={100} ordenInicial={{ clave: 'total', desc: true }} columnas={[
              { clave: 'nombre', titulo: 'Producto' }, { clave: 'categoria', titulo: 'Categoría' },
              { clave: 'cantidad', titulo: 'Unidades', numerica: true, render: (x) => num(x.cantidad) }, { clave: 'facturas', titulo: 'Facturas', numerica: true },
              { clave: 'precio_promedio', titulo: 'Precio prom.', numerica: true, render: (x) => L(x.precio_promedio) },
              { clave: 'participacion', titulo: '% venta', numerica: true, render: (x) => `${x.participacion}%` },
              { clave: 'margen_pct', titulo: 'Margen', numerica: true, ordenar: (x) => x.margen_pct ?? -1, render: (x) => (x.margen_pct == null ? <small>sin receta</small> : <span className={`chip ${x.margen_pct >= 55 ? 'ok' : x.margen_pct >= 35 ? 'aviso' : 'mal'}`}>{Math.round(x.margen_pct * 10) / 10}%</span>) },
              { clave: 'total', titulo: 'Total', numerica: true, render: (x) => L(x.total) }]} />
            <small>El precio promedio ya incluye los descuentos aplicados. El margen sale del costo de receta al momento de la venta.</small>
          </Seccion>
        </>)}

        {tab === 'pagos' && (
          <div className="rep-dos">
            <Seccion titulo="Formas de pago" onCsv={() => exportar(`formas-de-pago-${sufijo}.csv`, datos.por_forma_pago, [['Forma', (x) => x.nombre], ['Monto', (x) => d2(x.monto)], ['Facturas', (x) => x.facturas], ['Participación %', (x) => x.participacion]])}>
              <div className="tabla-wrap"><table><tbody>{datos.por_forma_pago.map((f, i) => (
                <tr key={f.nombre}><td>{f.nombre}</td><td><Barra valor={f.participacion} maximo={100} color={colorSerie(i)} /></td><td className="der num">{f.participacion}%</td><td className="der num tenue">{f.facturas} fact.</td><td className="der num">{L(f.monto)}</td></tr>))}</tbody></table>
                {datos.por_forma_pago.length === 0 && <div className="vacio">Sin ventas en este rango.</div>}</div>
              <small>Efectivo neto del cambio devuelto. El detalle por POS de tarjeta está en cada cierre de caja.</small>
            </Seccion>
            <Seccion titulo="Descuentos">
              <div className="tabla-wrap"><table>
                <thead><tr><th>Tipo</th><th className="der">Facturas</th><th className="der">Descontado</th><th className="der">Vendido</th></tr></thead>
                <tbody>{datos.descuentos.map((x) => <tr key={x.porcentaje}><td>{x.porcentaje === 25 ? '25 % tercera edad' : x.porcentaje ? `${x.porcentaje} %` : 'Otro'}</td><td className="der num">{x.facturas}</td><td className="der num">{L(x.monto)}</td><td className="der num">{L(x.ventas)}</td></tr>)}</tbody>
              </table>{datos.descuentos.length === 0 && <div className="vacio">Sin descuentos en este rango.</div>}</div>
              <small>Los descuentos equivalen al {k.ventas_brutas > 0 ? Math.round((k.descuentos / k.ventas_brutas) * 1000) / 10 : 0}% de la venta bruta.</small>
            </Seccion>
            {datos.gastos_por_tipo.length > 0 && (
              <Seccion titulo="Gastos de caja chica" onCsv={() => exportar(`caja-chica-${sufijo}.csv`, datos.gastos_por_tipo, [['Categoría', (x) => x.tipo], ['Movimientos', (x) => x.movimientos], ['Monto', (x) => d2(x.monto)]])}>
                <div className="tabla-wrap"><table><tbody>
                  {datos.gastos_por_tipo.map((g) => <tr key={g.tipo}><td>{g.tipo}</td><td className="der num tenue">{g.movimientos}</td><td className="der num">{L(g.monto)}</td></tr>)}
                  <tr className="fila-total"><td>Total</td><td /><td className="der num">{L(datos.gastos.total)}</td></tr>
                </tbody></table></div>
              </Seccion>
            )}
          </div>
        )}

        {tab === 'fiscal' && (
          <Seccion titulo="ISV — base para la declaración" onCsv={() => exportar(`isv-${sufijo}.csv`, [{ tipo: 'Fiscal (CAI real)', ...datos.isv.fiscal }, { tipo: 'Borrador (sin CAI)', ...datos.isv.borrador }],
            [['Tipo', (x) => x.tipo], ['Exento', (x) => d2(x.exento)], ['Exonerado', (x) => d2(x.exonerado)], ['Gravado 15%', (x) => d2(x.gravado_15)], ['Gravado 18%', (x) => d2(x.gravado_18)], ['ISV facturado', (x) => d2(x.isv)],
              ...(usaNc ? [['ISV notas de crédito', (x) => d2(x.isv_notas_credito)]] : []), ['ISV neto', (x) => d2(x.isv_neto)], ['Facturas', (x) => x.facturas], ['Anuladas', (x) => x.anuladas]])}>
            <div className="rep-dos">
              <BloqueFiscal titulo="Facturas fiscales (CAI real)" r={datos.isv.fiscal} conNc={usaNc} />
              <BloqueFiscal titulo="Comprobantes en modo borrador" r={datos.isv.borrador} conNc={usaNc} aviso="Emitidos sin CAI real: no son facturas fiscales. Coméntalos con el contador antes de declarar." />
            </div>
            <small>Base de trabajo para el contador: no incluye compras (crédito fiscal).{usaNc && ' Las notas de crédito se cuentan en el periodo en que se emitieron.'}</small>
          </Seccion>
        )}

        {tab === 'libro' && (
          <Seccion titulo={`Libro de ventas (${libro.length})`}
            extra={<span className="fila no-imprimir"><label className="fila" style={{ flexDirection: 'row', alignItems: 'center' }}><input type="checkbox" checked={soloFiscal} onChange={(e) => setSoloFiscal(e.target.checked)} />Solo fiscales</label>
              <input className="rep-buscar" placeholder="Factura, cliente, RTN o cajero…" value={buscarLibro} onChange={(e) => setBuscarLibro(e.target.value)} /></span>}
            onCsv={() => exportar(`libro-de-ventas-${sufijo}.csv`, libro, [['Fecha', (x) => fechaHora(x.fecha)], ['Factura', (x) => x.numero_factura], ['Sucursal', (x) => x.sucursal], ['Cliente', (x) => x.cliente], ['RTN', (x) => x.rtn],
              ['Exento', (x) => d2(x.anulada ? 0 : x.exento)], ['Exonerado', (x) => d2(x.anulada ? 0 : x.exonerado)], ['Gravado 15%', (x) => d2(x.anulada ? 0 : x.gravado_15)], ['Gravado 18%', (x) => d2(x.anulada ? 0 : x.gravado_18)],
              ['ISV', (x) => d2(x.anulada ? 0 : x.isv)], ['Descuento', (x) => d2(x.descuento)], ['Total', (x) => d2(x.anulada ? 0 : x.total)], ['Estado', (x) => (x.anulada ? 'ANULADA' : 'Válida')], ['Tipo', (x) => (x.borrador ? 'Borrador' : 'Fiscal')], ['Cajero', (x) => x.cajero]])}>
            <TablaOrdenable filas={libro} limite={300} ordenInicial={{ clave: 'numero_factura', desc: false }} columnas={[
              { clave: 'fecha', titulo: 'Fecha', render: (x) => fechaHora(x.fecha) },
              { clave: 'numero_factura', titulo: 'Factura', render: (x) => <span className="mono">{x.numero_factura}</span> },
              { clave: 'sucursal', titulo: 'Sucursal' },
              { clave: 'cliente', titulo: 'Cliente', render: (x) => (x.rtn ? `${x.cliente} · ${x.rtn}` : x.cliente) },
              { clave: 'gravado_15', titulo: 'Gravado', numerica: true, render: (x) => L(x.gravado_15) },
              { clave: 'isv', titulo: 'ISV', numerica: true, render: (x) => L(x.isv) },
              { clave: 'total', titulo: 'Total', numerica: true, render: (x) => L(x.total) },
              { clave: 'anulada', titulo: 'Estado', ordenar: (x) => (x.anulada ? 1 : 0), render: (x) => (x.anulada ? <span className="alerta-num">Anulada</span> : x.borrador ? 'Borrador' : 'Válida') }]} />
          </Seccion>
        )}

        {tab === 'anulaciones' && (<>
          <Seccion titulo={`Facturas anuladas (${datos.anuladas.length})`} onCsv={() => exportar(`anuladas-${sufijo}.csv`, datos.anuladas, [['Factura', (x) => x.numero_factura], ['Fecha', (x) => fechaHora(x.fecha)], ['Sucursal', (x) => x.sucursal], ['Cliente', (x) => x.cliente], ['Cajero', (x) => x.cajero], ['Total', (x) => d2(x.total)], ['Motivo', (x) => x.motivo]])}>
            <TablaOrdenable filas={datos.anuladas.map((x, i) => ({ ...x, clave: x.numero_factura ?? i }))} ordenInicial={{ clave: 'fecha', desc: true }} vacio="Ninguna factura anulada en este rango." columnas={[
              { clave: 'numero_factura', titulo: 'Factura', render: (x) => <span className="mono">{x.numero_factura}</span> }, { clave: 'fecha', titulo: 'Emitida', render: (x) => fechaHora(x.fecha) },
              { clave: 'sucursal', titulo: 'Sucursal' }, { clave: 'cliente', titulo: 'Cliente' }, { clave: 'cajero', titulo: 'Cajero' }, { clave: 'motivo', titulo: 'Motivo' },
              { clave: 'total', titulo: 'Total', numerica: true, render: (x) => L(x.total) }]} />
          </Seccion>
          {usaNc && <Seccion titulo={`Notas de crédito emitidas (${datos.notas_credito.length})`} onCsv={() => exportar(`notas-de-credito-${sufijo}.csv`, datos.notas_credito, [['Nota', (x) => x.numero_nota], ['Factura', (x) => x.numero_factura], ['Fecha', (x) => fechaHora(x.fecha)], ['Tipo', (x) => x.tipo], ['Monto', (x) => d2(x.monto)], ['Motivo', (x) => x.motivo], ['Usuario', (x) => x.usuario]])}>
            <TablaOrdenable filas={datos.notas_credito.map((x, i) => ({ ...x, clave: `${x.numero_nota}-${i}` }))} ordenInicial={{ clave: 'fecha', desc: true }} vacio="Ninguna nota de crédito en este rango." columnas={[
              { clave: 'fecha', titulo: 'Fecha', render: (x) => fechaHora(x.fecha) }, { clave: 'numero_nota', titulo: 'Nota', render: (x) => <span className="mono">{x.numero_nota}</span> },
              { clave: 'numero_factura', titulo: 'Factura', render: (x) => <span className="mono">{x.numero_factura}</span> }, { clave: 'tipo', titulo: 'Tipo' }, { clave: 'motivo', titulo: 'Motivo' },
              { clave: 'usuario', titulo: 'Autorizó' }, { clave: 'monto', titulo: 'Monto', numerica: true, render: (x) => L(x.monto) }]} />
          </Seccion>}
        </>)}
      </>)}

      {!datos && cargando && <div className="vacio">Generando reporte…</div>}
    </div>
  );
}
