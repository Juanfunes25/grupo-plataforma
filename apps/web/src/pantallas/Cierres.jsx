import { useCallback, useEffect, useMemo, useState } from 'react';
import { get, post, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, Modal, Tabs, descargarCsv, useAccion, useDatos } from '../ui/kit.jsx';
import { ChipDif, CampoMonto, FilaSistema } from '../cierres/Controles.jsx';
import { calcularCuadre, totalConteo } from '../cierres/cuadre.js';
import { L, fechaHora, inicioDeHoyIso, inputLocalAIso, isoAInputLocal } from '../cierres/formato.js';
import { pedirTicketCierre, useTicket } from '../cierres/ticket.jsx';
import '../cierres/cierres.css';

const VACIO = { pos: {}, efectivo_contado: '', fondo_caja: '', salidas: '', ingresos: '', observaciones: '' };

export default function Cierres() {
  const { puede, sucursal, sucursales } = useSesion();
  const [tab, setTab] = useState(puede('pos:caja') ? 'cierre' : 'historial');
  const tabs = [...(puede('pos:caja') ? [['cierre', 'Cerrar caja']] : []), ...(puede('pos:reportes') ? [['historial', 'Historial de cierres'], ['turnos', 'Turnos']] : [])];
  const [imprimir, nodoTicket] = useTicket();
  const [ejecutar] = useAccion();
  const reimprimir = async (id) => { const l = await ejecutar(() => pedirTicketCierre(id)); if (l && l !== true) imprimir(l); };

  if (!sucursal) return <div className="pagina"><div className="aviso-caja">Elige una sucursal en el menú lateral para hacer el cierre.</div></div>;
  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Cierre de caja</h1>{sucursales.length > 1 && <small>Para cerrar otra sucursal, cámbiala en el menú lateral.</small>}</div>
      {tabs.length > 1 && <Tabs tabs={tabs} valor={tab} onCambio={setTab} />}
      {tab === 'cierre' && <NuevoCierre sucursal={sucursal} reimprimir={reimprimir} />}
      {tab === 'historial' && <Historial sucursal={sucursal} reimprimir={reimprimir} />}
      {tab === 'turnos' && <Turnos sucursal={sucursal} />}
      {nodoTicket}
    </div>
  );
}

// ── Cerrar caja ────────────────────────────────────────────────────────────
function NuevoCierre({ sucursal, reimprimir }) {
  const sid = sucursal.id;
  const [config, setConfig] = useState(null);
  const [ultimo, setUltimo] = useState(null);
  const [desde, setDesde] = useState(null);
  const [hasta, setHasta] = useState(() => new Date().toISOString());
  const [hastaManual, setHastaManual] = useState(false);
  const [avisoDesde, setAvisoDesde] = useState('');
  const [resumen, setResumen] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [form, setForm] = useState(VACIO);
  const [contando, setContando] = useState(false);
  const [conteo, setConteo] = useState({});
  const [error, setError] = useState('');
  const [confirmar, setConfirmar] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [ejecutar, ocupado] = useAccion();

  const set = (campo) => (valor) => setForm((f) => ({ ...f, [campo]: valor }));
  const setPos = (banco) => (valor) => setForm((f) => ({ ...f, pos: { ...f.pos, [banco]: valor } }));

  // Arranque del cierre: donde terminó el último de esta sucursal. Si es muy viejo, se toma desde hoy 00:00 y se avisa.
  const arrancar = useCallback(async () => {
    setResultado(null); setResumen(null); setForm(VACIO); setConteo({}); setContando(false); setHastaManual(false); setHasta(new Date().toISOString()); setError('');
    try {
      const r = await get(`/pos/cierres/ultimo${qs({ sucursal_id: sid })}`);
      setConfig(r.config); setUltimo(r.ultimo);
      const ayer = new Date(inicioDeHoyIso()); ayer.setDate(ayer.getDate() - 1);
      if (r.ultimo?.fecha_fin && new Date(r.ultimo.fecha_fin) >= ayer) { setDesde(r.ultimo.fecha_fin); setAvisoDesde(''); }
      else {
        setDesde(inicioDeHoyIso());
        setAvisoDesde(r.ultimo?.fecha_fin ? `El último cierre de esta sucursal fue el ${fechaHora(r.ultimo.fecha_fin)}. Se tomó desde hoy 00:00: si quedaron ventas sin cerrar, ajusta «Desde».` : '');
      }
      if (r.ultimo?.fondo_caja != null) setForm((f) => ({ ...f, fondo_caja: String(Number(r.ultimo.fondo_caja)) }));
    } catch (e) { setError(e.message); setDesde(inicioDeHoyIso()); }
  }, [sid]);
  useEffect(() => { arrancar(); }, [arrancar]);

  const cargarResumen = useCallback(async () => {
    if (!sid || !desde || !hasta || new Date(hasta) <= new Date(desde)) { setResumen(null); return; }
    setCargando(true);
    try {
      const r = await get(`/pos/cierres/resumen${qs({ sucursal_id: sid, desde, hasta })}`);
      setResumen(r); setError('');
      // La caja chica del rango se sugiere como salidas/ingresos solo si nadie las tocó.
      setForm((f) => ({ ...f, salidas: f.salidas === '' && r.salidas_sugeridas > 0 ? String(r.salidas_sugeridas) : f.salidas, ingresos: f.ingresos === '' && r.ingresos_sugeridos > 0 ? String(r.ingresos_sugeridos) : f.ingresos }));
    } catch (e) { setError(e.message); } finally { setCargando(false); }
  }, [sid, desde, hasta]);
  useEffect(() => { const t = setTimeout(cargarResumen, 250); return () => clearTimeout(t); }, [cargarResumen]);

  // Si entran ventas mientras se cuenta, el «hasta» avanza solo (salvo que lo fijen a mano).
  useEffect(() => {
    if (resultado || hastaManual) return undefined;
    const t = setInterval(() => setHasta(new Date().toISOString()), 30000);
    return () => clearInterval(t);
  }, [resultado, hastaManual]);

  const ciego = resumen?.ciego ?? false;
  const bancos = config?.bancos ?? [];
  const contadoConteo = totalConteo(conteo);
  const efectivoContado = contando ? String(contadoConteo) : form.efectivo_contado;
  const cuadre = useMemo(() => (resumen && !ciego ? calcularCuadre(resumen, { ...form, efectivo_contado: efectivoContado }) : null), [resumen, ciego, form, efectivoContado]);
  const faltan = bancos.some((b) => form.pos[b] === undefined || form.pos[b] === '') || efectivoContado === '';
  const noCuadra = cuadre && !faltan && (Math.abs(cuadre.diferencia_tarjeta) >= 1 || Math.abs(cuadre.diferencia_efectivo) >= 1);
  const faltaObs = noCuadra && !form.observaciones.trim();
  const puedeCerrar = resumen && !faltan && !faltaObs && !ocupado && !cargando;

  const cerrar = async () => {
    const cuerpo = {
      sucursal_id: sid, fecha_inicio: desde, fecha_fin: hasta,
      pos: Object.fromEntries(bancos.map((b) => [b, Number(form.pos[b] || 0)])),
      efectivo_contado: Number(efectivoContado || 0), fondo_caja: Number(form.fondo_caja || 0), salidas: Number(form.salidas || 0), ingresos: Number(form.ingresos || 0),
      ...(contando ? { conteo: Object.fromEntries(Object.entries(conteo).filter(([, c]) => Number(c) > 0).map(([d, c]) => [d, Number(c)])) } : {}),
      observaciones: form.observaciones,
    };
    const r = await ejecutar(() => post('/pos/cierres', cuerpo));
    if (r && r !== true) { setConfirmar(false); setResultado(r); }
  };

  const [imprimiendo, setImprimiendo] = useState(false);
  if (!config && !error) return <div className="vacio">Cargando…</div>;

  return (
    <div className="cierre" style={{ '--color-cierre': sucursal.color || 'var(--acento)' }}>
      {error && <div className="aviso-caja mal">{error}</div>}
      <div className="tarjeta" style={{ display: 'grid', gap: 12 }}>
        <div className="cierre-titulo">
          <span className="cierre-punto" />
          <div><h2>Cierre de caja · {sucursal.nombre}</h2>
            <small>{ultimo?.fecha_fin ? `Último cierre: ${fechaHora(ultimo.fecha_fin)}` : 'Esta sucursal aún no tiene cierres'}</small></div>
        </div>
        <div className="cierre-rango">
          <Campo etiqueta="Desde"><input type="datetime-local" value={desde ? isoAInputLocal(desde) : ''} disabled={Boolean(resultado)} onChange={(e) => e.target.value && setDesde(inputLocalAIso(e.target.value))} /></Campo>
          <Campo etiqueta="Hasta"><input type="datetime-local" value={isoAInputLocal(hasta)} disabled={Boolean(resultado)} onChange={(e) => { if (e.target.value) { setHasta(inputLocalAIso(e.target.value)); setHastaManual(true); } }} /></Campo>
          <button className="btn" disabled={Boolean(resultado)} onClick={() => { setHasta(new Date().toISOString()); setHastaManual(false); }}>Hasta ahora</button>
        </div>
        {avisoDesde && <div className="aviso-caja">{avisoDesde}</div>}
        {resumen && (
          <div className="cierre-kpis">
            <div><span>Facturas</span><strong>{resumen.cantidad_facturas}</strong></div>
            <div><span>Rango</span><strong style={{ fontSize: '.9rem' }}>{resumen.factura_desde ? `${resumen.factura_desde.slice(-8)} → ${resumen.factura_hasta.slice(-8)}` : '—'}</strong></div>
            {!ciego && <div><span>Total ventas</span><strong>{L(resumen.total_ventas)}</strong></div>}
            {!ciego && <div><span>Anuladas</span><strong>{resumen.anuladas}{resumen.anuladas > 0 && <small> ({L(resumen.monto_anulado)})</small>}</strong></div>}
            {cargando && <div><span>Estado</span><strong style={{ fontSize: '.9rem' }}>Actualizando…</strong></div>}
          </div>
        )}
        {resumen?.ordenes_abiertas > 0 && !resultado && <div className="aviso-caja">Hay {resumen.ordenes_abiertas} orden(es) abierta(s) sin cobrar. No entran en el cierre: cóbralas o descártalas desde Facturación.</div>}
        {resumen?.turnos_abiertos?.length > 0 && !resultado && (
          <small>Al cerrar la caja se cerrarán {resumen.turnos_abiertos.length} turno(s) abierto(s): {resumen.turnos_abiertos.map((t) => t.cajero).join(', ')}.</small>
        )}
      </div>

      {ciego && <div className="aviso-caja">Cierre ciego: cuenta y anota lo que tienes. El sistema compara al guardar; el resultado lo ve tu supervisor.</div>}

      {resultado ? (
        <div className="tarjeta cierre-resultado">
          <h2>Cierre guardado</h2>
          {resultado.descuadre && <div className="aviso-caja mal"><b>Descuadre registrado.</b> Quedó en la bitácora para que lo revise la administración.</div>}
          <small>Facturas {resultado.factura_desde ?? '—'} a {resultado.factura_hasta ?? '—'} ({resultado.cantidad_facturas ?? 0}) · {resultado.turnos_cerrados} turno(s) cerrado(s)</small>
          {resultado.diferencia !== undefined ? (
            <div className="cierre-resultado-grid">
              <div><span>Tarjeta</span><ChipDif valor={resultado.diferencia_tarjeta} grande /></div>
              <div><span>Efectivo</span><ChipDif valor={resultado.diferencia_efectivo} grande /></div>
              <div><span>Total</span><ChipDif valor={resultado.diferencia} grande /></div>
            </div>
          ) : <p>Tu supervisor verá el resultado del cuadre.</p>}
          {resultado.alertas?.filter((a) => a.tipo !== 'descuadre').map((a) => <div key={a.tipo} className="aviso-caja mal">{a.titulo}</div>)}
          <div className="fila">
            <button className="btn primario" disabled={imprimiendo} onClick={async () => { setImprimiendo(true); await reimprimir(resultado.id); setImprimiendo(false); }}>Imprimir cierre</button>
            <button className="btn" onClick={arrancar}>Hacer otro cierre</button>
          </div>
          <small>Engrapa este ticket con los cierres de lote de los POS de tarjeta ({bancos.join(' y ')}).</small>
        </div>
      ) : (
        <>
          <div className="cierre-bloques">
            <section className="tarjeta cierre-bloque">
              <header><h3>Tarjeta</h3>{cuadre && bancos.every((b) => form.pos[b] !== undefined && form.pos[b] !== '') && <ChipDif valor={cuadre.diferencia_tarjeta} />}</header>
              {!ciego && resumen && <FilaSistema etiqueta="Según sistema" valor={resumen.tarjeta} fuerte />}
              {bancos.map((b, i) => <CampoMonto key={b} etiqueta={`Cierre POS ${b}`} valor={form.pos[b] ?? ''} onChange={setPos(b)} autoFocus={i === 0} obligatorio />)}
              <FilaSistema etiqueta="Total de los POS" valor={bancos.reduce((s, b) => s + Number(form.pos[b] || 0), 0)} />
            </section>

            <section className="tarjeta cierre-bloque">
              <header><h3>Efectivo</h3>{cuadre && efectivoContado !== '' && <ChipDif valor={cuadre.diferencia_efectivo} />}</header>
              {!ciego && resumen && <FilaSistema etiqueta="Ventas en efectivo (sin cambio)" valor={resumen.efectivo} />}
              <div className="cierre-dos">
                <CampoMonto etiqueta="Fondo de caja" valor={form.fondo_caja} onChange={set('fondo_caja')} />
                <CampoMonto etiqueta="Salidas de caja" valor={form.salidas} onChange={set('salidas')} ayuda={resumen?.salidas_sugeridas > 0 ? `Caja chica: ${L(resumen.salidas_sugeridas)}` : undefined} />
              </div>
              <CampoMonto etiqueta="Ingresos de caja" valor={form.ingresos} onChange={set('ingresos')} ayuda={resumen?.ingresos_sugeridos > 0 ? `Caja chica: ${L(resumen.ingresos_sugeridos)}` : 'Entradas de efectivo ajenas a las ventas'} />
              {cuadre && <FilaSistema etiqueta="Debe haber en gaveta" valor={cuadre.efectivo_esperado} fuerte />}
              <CampoMonto etiqueta="Efectivo contado a mano" valor={efectivoContado} onChange={set('efectivo_contado')} disabled={contando} obligatorio
                ayuda="Todo lo que hay en la gaveta, incluido el fondo" />
              <label className="fila" style={{ flexDirection: 'row', alignItems: 'center', color: 'var(--texto)' }}>
                <input type="checkbox" checked={contando} onChange={(e) => setContando(e.target.checked)} />Contar billetes y monedas
              </label>
              {contando && <Conteo denominaciones={config.denominaciones} conteo={conteo} onCambio={setConteo} />}
            </section>

            {!ciego && (
              <section className="tarjeta cierre-bloque">
                <header><h3>Transferencia y otros</h3></header>
                {resumen && <FilaSistema etiqueta="Transferencias según sistema" valor={resumen.transferencia} fuerte />}
                {resumen?.otros > 0 && <FilaSistema etiqueta="Otras formas de pago" valor={resumen.otros} />}
                {resumen?.formas?.length > 0 && <div style={{ display: 'grid', gap: 4 }}><small>Desglose por forma de pago</small>{resumen.formas.map((f) => <FilaSistema key={f.nombre} etiqueta={`${f.nombre} (${f.facturas})`} valor={f.monto} />)}</div>}
                <small>Revisa que las transferencias coincidan con lo acreditado en la banca en línea.</small>
              </section>
            )}
          </div>

          <div className="tarjeta cierre-pie">
            {cuadre && !faltan && <div className="cierre-total"><span>Resultado del cuadre</span><ChipDif valor={cuadre.diferencia_total} grande /></div>}
            <Campo etiqueta={<>Observaciones{noCuadra && <span className="obligatorio"> * (obligatorio: el cierre no cuadra)</span>}</>}>
              <textarea rows={2} value={form.observaciones} onChange={(e) => set('observaciones')(e.target.value)} placeholder="Ej. voucher de L 150 pasado dos veces en el POS, se anuló al día siguiente" />
            </Campo>
            <button className="btn primario grande" disabled={!puedeCerrar} onClick={() => setConfirmar(true)}>Cerrar caja</button>
            {faltan && <small>Llena el cierre de cada POS ({bancos.join(', ')}) y el efectivo contado (usa 0 si no hubo).</small>}
          </div>
        </>
      )}

      {confirmar && (
        <Modal titulo={`Cerrar caja de ${sucursal.nombre}`} onCerrar={() => setConfirmar(false)} tam="angosto"
          pie={<><button className="btn" onClick={() => setConfirmar(false)}>Revisar</button><button className="btn primario" disabled={ocupado} onClick={cerrar}>Confirmar cierre</button></>}>
          <small>Del {fechaHora(desde)} al {fechaHora(hasta)}</small>
          {bancos.map((b) => <FilaSistema key={b} etiqueta={`POS ${b}`} valor={Number(form.pos[b] || 0)} />)}
          <FilaSistema etiqueta="Efectivo contado" valor={Number(efectivoContado || 0)} fuerte />
          {cuadre && <>
            <div className="cierre-fila"><span>Tarjeta</span><ChipDif valor={cuadre.diferencia_tarjeta} /></div>
            <div className="cierre-fila"><span>Efectivo</span><ChipDif valor={cuadre.diferencia_efectivo} /></div>
          </>}
          <div className="aviso-caja">Un cierre no se puede editar después. ¿Confirmas?</div>
        </Modal>
      )}
    </div>
  );
}

function Conteo({ denominaciones, conteo, onCambio }) {
  const grupo = (tipo, titulo) => (
    <div style={{ display: 'grid', gap: 6 }}>
      <small>{titulo}</small>
      <div className="conteo">{denominaciones.filter((d) => d.tipo === tipo).map((d) => (
        <label key={d.valor}>L {d.valor}
          <input inputMode="numeric" placeholder="0" value={conteo[d.valor] ?? ''} onChange={(e) => onCambio({ ...conteo, [d.valor]: e.target.value.replace(/\D/g, '').slice(0, 6) })} />
        </label>))}
      </div>
    </div>
  );
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {grupo('billete', 'Billetes')}{grupo('moneda', 'Monedas')}
      <div className="conteo-sub"><span>Total contado</span><span className="num">{L(totalConteo(conteo))}</span></div>
    </div>
  );
}

// ── Historial ──────────────────────────────────────────────────────────────
function Historial({ sucursal, reimprimir }) {
  const { sucursales } = useSesion();
  const [soloEsta, setSoloEsta] = useState(true);
  const lista = useDatos(() => get(`/pos/cierres${qs({ sucursal_id: soloEsta ? sucursal.id : '' })}`), [soloEsta, sucursal.id]);
  const [detalle, setDetalle] = useState(null);
  const exportar = () => {
    const f = lista.datos ?? [];
    const filas = f.map((c) => ({
      desde: fechaHora(c.fecha_inicio), hasta: fechaHora(c.fecha_fin), sucursal: c.sucursal, cajero: c.cajero, f1: c.factura_desde ?? '', f2: c.factura_hasta ?? '', facturas: c.cantidad_facturas,
      ventas: c.total_ventas, tsis: c.tarjeta_sistema, trep: c.tarjeta_reportada, dt: c.diferencia_tarjeta, esis: c.efectivo_sistema, fondo: c.fondo_caja, ing: c.ingresos, sal: c.salidas,
      esp: c.efectivo_esperado, cont: c.efectivo_contado, de: c.diferencia_efectivo, trf: c.transferencia_sistema, dif: c.diferencia, bancos: Object.entries(c.pos_bancos ?? {}).map(([b, m]) => `${b} ${m}`).join(' · '), obs: c.observaciones ?? '',
    }));
    descargarCsv(`cierres-${new Date().toISOString().slice(0, 10)}.csv`, filas, [['desde', 'Desde'], ['hasta', 'Hasta'], ['sucursal', 'Sucursal'], ['cajero', 'Cajero'], ['f1', 'De factura'], ['f2', 'A factura'], ['facturas', 'Facturas'],
      ['ventas', 'Total ventas'], ['tsis', 'Tarjeta sistema'], ['bancos', 'POS'], ['trep', 'Tarjeta reportada'], ['dt', 'Dif. tarjeta'], ['esis', 'Efectivo ventas'], ['fondo', 'Fondo'], ['ing', 'Ingresos'], ['sal', 'Salidas'],
      ['esp', 'Efectivo esperado'], ['cont', 'Efectivo contado'], ['de', 'Dif. efectivo'], ['trf', 'Transferencias'], ['dif', 'Diferencia total'], ['obs', 'Observaciones']]);
  };
  return (
    <>
      <div className="fila espacio">
        {sucursales.length > 1 ? <label className="fila" style={{ flexDirection: 'row', alignItems: 'center' }}><input type="checkbox" checked={soloEsta} onChange={(e) => setSoloEsta(e.target.checked)} />Solo {sucursal.nombre}</label> : <span />}
        <button className="btn" disabled={!lista.datos?.length} onClick={exportar}>Exportar CSV</button>
      </div>
      <Estado d={lista}>{(l) => (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Cierre</th><th>Sucursal</th><th>Cajero</th><th className="der">Facturas</th><th className="der">Ventas</th><th>Tarjeta</th><th>Efectivo</th><th className="der">Transf.</th><th>Total</th><th /></tr></thead>
          <tbody>{l.map((c) => (
            <tr key={c.id}>
              <td>{fechaHora(c.fecha_fin)}</td>
              <td><span className="cierre-punto" style={{ display: 'inline-block', width: 9, height: 9, marginRight: 6, background: c.sucursal_color || 'var(--acento)' }} />{c.sucursal}</td>
              <td>{c.cajero}</td><td className="der num">{c.cantidad_facturas}</td><td className="der num">{L(c.total_ventas)}</td>
              <td><ChipDif valor={c.diferencia_tarjeta} /></td><td><ChipDif valor={c.diferencia_efectivo} /></td>
              <td className="der num">{L(c.transferencia_sistema)}</td><td><ChipDif valor={c.diferencia} /></td>
              <td><div className="fila" style={{ flexWrap: 'nowrap' }}><button className="btn chico" onClick={() => setDetalle(c.id)}>Ver</button><button className="btn chico" onClick={() => reimprimir(c.id)}>Imprimir</button></div></td>
            </tr>))}</tbody>
        </table>{l.length === 0 && <div className="vacio">Sin cierres todavía.</div>}</div></div>
      )}</Estado>
      {detalle && <DetalleCierre id={detalle} onCerrar={() => setDetalle(null)} reimprimir={reimprimir} />}
    </>
  );
}

function DetalleCierre({ id, onCerrar, reimprimir }) {
  const d = useDatos(() => get(`/pos/cierres/${id}`), [id]);
  return (
    <Modal titulo="Cierre de caja" onCerrar={onCerrar} tam="ancho" pie={<><button className="btn" onClick={() => reimprimir(id)}>Imprimir</button><button className="btn primario" onClick={onCerrar}>Cerrar</button></>}>
      <Estado d={d}>{(c) => (
        <>
          <div><b>{c.sucursal}</b><br /><small>{fechaHora(c.fecha_inicio)} → {fechaHora(c.fecha_fin)} · {c.cajero}</small></div>
          {c.diferencia !== undefined && (
            <div className="tabla-wrap"><table>
              <thead><tr><th /><th className="der">Sistema</th><th className="der">Reportado</th><th>Diferencia</th></tr></thead>
              <tbody>
                <tr><td>Tarjeta<br /><small>{Object.entries(c.pos_bancos ?? {}).map(([b, m]) => `${b} ${L(m)}`).join(' · ')}</small></td><td className="der num">{L(c.tarjeta_sistema)}</td><td className="der num">{L(c.tarjeta_reportada)}</td><td><ChipDif valor={c.diferencia_tarjeta} /></td></tr>
                <tr><td>Efectivo<br /><small>Fondo {L(c.fondo_caja)} + ventas {L(c.efectivo_sistema)} + ingresos {L(c.ingresos)} − salidas {L(c.salidas)}</small></td><td className="der num">{L(c.efectivo_esperado)}</td><td className="der num">{L(c.efectivo_contado)}</td><td><ChipDif valor={c.diferencia_efectivo} /></td></tr>
                <tr><td>Transferencia</td><td className="der num">{L(c.transferencia_sistema)}</td><td className="der">—</td><td /></tr>
                {Number(c.otros_sistema) > 0 && <tr><td>Otras formas de pago</td><td className="der num">{L(c.otros_sistema)}</td><td className="der">—</td><td /></tr>}
              </tbody>
            </table></div>
          )}
          {c.alertas?.length > 0 && c.alertas.map((a, i) => <div key={i} className="aviso-caja mal">{a.titulo}</div>)}
          {c.observaciones && <div className="aviso-caja"><b>Observaciones:</b> {c.observaciones}</div>}
          {c.conteo && Object.keys(c.conteo).length > 0 && <small>Conteo: {Object.entries(c.conteo).sort((a, b) => b[0] - a[0]).map(([den, n]) => `${n} × L ${den}`).join(' · ')}</small>}
          {c.desglose && (
            <>
              {c.desglose.tarjeta.length > 0 && <div><b>Pagos con tarjeta ({c.desglose.tarjeta.length})</b><div className="lista-facturas">{c.desglose.tarjeta.map((x, i) => <div key={i}><span>{x.numero} {x.referencia ? `· ${x.referencia}` : ''}</span><span className="num">{L(x.monto)}</span></div>)}</div></div>}
              {c.desglose.transferencia.length > 0 && <div><b>Transferencias ({c.desglose.transferencia.length})</b><div className="lista-facturas">{c.desglose.transferencia.map((x, i) => <div key={i}><span>{x.numero} {x.referencia ? `· ${x.referencia}` : ''}</span><span className="num">{L(x.monto)}</span></div>)}</div></div>}
              <div><b>Facturas ({c.facturas.length})</b><div className="lista-facturas">{c.facturas.map((f) => <div key={f.id} className={f.estado === 'anulada' ? 'anulada' : ''}><span>{f.numero_factura} · {f.cliente}</span><span className="num">{L(f.total)}</span></div>)}</div></div>
              {c.turnos_cerrados_lista?.length > 0 && <small>Turnos cerrados con este cierre: {c.turnos_cerrados_lista.map((t) => `${t.cajero} (desde ${fechaHora(t.abierto_at)})`).join(', ')}</small>}
            </>
          )}
        </>
      )}</Estado>
    </Modal>
  );
}

// ── Turnos (se abren solos al primer cobro; el cierre del día los cierra) ───
function Turnos({ sucursal }) {
  const [todas, setTodas] = useState(true);
  const t = useDatos(() => get(`/pos/turno${qs({ sucursal_id: todas ? '' : sucursal.id })}`), [todas, sucursal.id]);
  return (
    <>
      <div className="aviso-caja ok">Los turnos se abren solos con el primer cobro (fondo L 0.00) y se cierran con el cierre de caja de la sucursal. Aquí se consultan.</div>
      <label className="fila" style={{ flexDirection: 'row', alignItems: 'center' }}><input type="checkbox" checked={todas} onChange={(e) => setTodas(e.target.checked)} />Todas las sucursales</label>
      <Estado d={t}>{(l) => (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Apertura</th><th>Sucursal</th><th>Cajero</th><th className="der">Fondo</th><th className="der">Ventas</th><th className="der">Contado</th><th className="der">Diferencia</th><th>Estado</th></tr></thead>
          <tbody>{l.map((x) => (
            <tr key={x.id}>
              <td>{fechaHora(x.abierto_at)}</td><td>{x.sucursal}</td><td>{x.cajero}</td><td className="der num">{L(x.fondo_inicial)}</td>
              <td className="der num">{x.total_ventas == null ? '—' : L(x.total_ventas)}</td><td className="der num">{x.efectivo_contado == null ? '—' : L(x.efectivo_contado)}</td>
              <td className="der">{x.diferencia == null ? '' : <ChipDif valor={x.diferencia} />}</td>
              <td>{x.estado === 'abierto' ? <span className="chip aviso">abierto</span> : <span className="chip">{x.cierre_id ? 'cerrado con el cierre' : 'cerrado'}</span>}</td>
            </tr>))}</tbody>
        </table>{l.length === 0 && <div className="vacio">Sin turnos.</div>}</div></div>
      )}</Estado>
    </>
  );
}
