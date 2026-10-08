// Consumo y reposición: panorama, consumo medido vs venta del POS, rotación, qué mandar, pedidos,
// catálogo de sabores y sucursales, reportes de peso, gerente digital y resumen diario.
// Calco de AdminDueno.jsx del original (las partes de Reposición).
import { useEffect, useMemo, useState } from 'react';
import { api, get, patch, post, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Estado, Kpi, Modal, Tabs, descargarCsv, useAccion, useAviso, useDatos } from '../ui/kit.jsx';
import { Barra, CatalogoSabores, Esqueleto, Pill } from './comun.jsx';
import { Historial } from './Historial.jsx';
import { Gerente } from './Gerente.jsx';
import { agruparPedidosPorSucursal, cuandoTexto, fechaCorta, hoyIso, leerCache, guardarCache, sumarDias } from './lib.js';

const RANGOS = [[7, 'Semana'], [30, 'Mes'], [90, '3 meses']];
const ETIQUETA = {
  estrella: ['★ Estrella', 'ok', 'Muy por encima del sabor típico. Cuida que nunca falte.'],
  normal: ['Normal', '', null],
  lento: ['Lento', 'aviso', 'Se mueve bastante menos que el resto.'],
  muerto: ['✕ No se mueve', 'mal', 'Se produjo y aun así no se pidió. Candidato a salir del catálogo.'],
  falta_stock: ['⚠ Faltó', 'mal', 'Se pidió y no había. Es lo contrario a un sabor muerto: hay que producir más.'],
  sin_producir: ['Sin producir', '', 'No se produjo en el período, así que no tuvo oportunidad de venderse.'],
};
const lps = (n) => (n == null ? '—' : `L ${Number(n).toLocaleString('es-HN', { maximumFractionDigits: 0 })}`);

export default function Consumo() {
  const { puede } = useSesion();
  const verGerente = puede('gerente:ver');
  const admin = puede('rep:costeo');
  const [tab, setTab] = useState('panorama');
  const tabs = [['panorama', 'Panorama'], ['consumo', 'Consumo y ventas'], ['rotacion', 'Rotación'], ['sugerido', 'Qué mandar'], ['pedidos', 'Pedidos'], ['reportes', 'Reportes de peso'], ...(admin ? [['sabores', 'Sabores'], ['sucursales', 'Sucursales']] : []), ...(verGerente ? [['gerente', 'Gerente digital']] : []), ...(admin ? [['resumen', 'Resumen diario']] : [])];
  return (
    <div className="rep ancha">
      <div className="encabezado-pagina"><div><h1>Consumo y reposición</h1><div className="rep-sub">Cuánto gelato se consume, se envía y se vende por sucursal y sabor · {fechaCorta(hoyIso())}</div></div></div>
      <Tabs tabs={tabs} valor={tab} onCambio={setTab} />
      {tab === 'panorama' && <Panorama ir={setTab} />}
      {tab === 'consumo' && <ConsumoVentas />}
      {tab === 'rotacion' && <Rotacion />}
      {tab === 'sugerido' && <Sugerido />}
      {tab === 'pedidos' && <Pedidos />}
      {tab === 'reportes' && <Historial />}
      {tab === 'sabores' && <Sabores />}
      {tab === 'sucursales' && <Sucursales />}
      {tab === 'gerente' && <Gerente />}
      {tab === 'resumen' && <Resumen />}
    </div>
  );
}

// ── Panorama ──────────────────────────────────────────────────────────────────────────────
function Panorama({ ir }) {
  const { puede } = useSesion();
  const [ejecutar] = useAccion();
  const fecha = hoyIso();
  const d = useDatos(async () => { const x = await get(`/rep/analitica/dueno/${fecha}?dias=14`); guardarCache('dueno', x); return x; }, []);
  const datos = d.datos ?? (leerCache('dueno')?.datos?.fecha === fecha ? leerCache('dueno').datos : null);
  if (!datos) return d.error ? <div className="aviso-caja mal">{d.error}</div> : <Esqueleto alto={200} />;
  const resolver = async (id) => { if (await ejecutar(() => patch(`/rep/despachos/${id}/resolver-discrepancia`), 'Discrepancia resuelta')) d.recargar(); };
  return (
    <div className="rejilla">
      <div className="rejilla cols-3">
        <Kpi etiqueta="Discrepancias (14 días)" valor={datos.discrepancias.length} acento={datos.discrepancias.length > 0} />
        <Kpi etiqueta="Producido hoy (fábrica)" valor={`${datos.produccionHoyKg} kg`} sub="Detalle en Producción de gelato" />
        <Kpi etiqueta="Sucursales activas" valor={datos.porSucursal.length} />
      </div>
      <h3>Top 10 insumos que más se despachan (30 días)</h3>
      <InsumosDespachados dias={30} limite={10} />
      {datos.saboresParados.length > 0 && (
        <>
          <h3>Sabores que no se están moviendo</h3>
          <small>Se produjeron en los últimos 30 días y casi no se despacharon: plata parada en el freezer.</small>
          <div className="tarjeta">
            {datos.saboresParados.map((s) => (
              <div className="rep-fila clic" key={s.sabor_id} onClick={() => ir('rotacion')}>
                <div className="rep-fila-info"><b>{s.nombre}</b><small>Producido: {s.producidoKg} kg{s.diasSinDespachar !== null ? ` · hace ${s.diasSinDespachar} día${s.diasSinDespachar === 1 ? '' : 's'}` : ' · nunca despachado'}</small></div>
                <span className={`chip ${s.clasificacion === 'muerto' ? 'mal' : 'aviso'}`}>{s.clasificacion === 'muerto' ? '✕ No se mueve' : 'Lento'}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {datos.discrepancias.length > 0 && (
        <>
          <h3>Discrepancias recientes</h3>
          <div className="tarjeta">
            {datos.discrepancias.map((x) => (
              <div className="rep-fila" key={x.id}>
                <div className="rep-fila-info"><b>{x.sucursal_nombre} · {x.sabor_nombre}</b><small>{fechaCorta(x.fecha)}: enviadas {x.panas} pana{x.panas === 1 ? '' : 's'}, recibidas {x.panas_recibidas ?? '?'}</small></div>
                {puede('rep:costeo') && <button className="btn chico" onClick={() => resolver(x.id)}>Resolver</button>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SelectorRango({ dias, setDias, personalizado, setPersonalizado, desde, setDesde, hasta, setHasta }) {
  return (
    <>
      <div className="rep-rangos">
        {RANGOS.map(([n, t]) => <button key={n} className={`btn ${!personalizado && dias === n ? 'on' : ''}`} onClick={() => { setPersonalizado(false); setDias(n); }}>{t}</button>)}
        <button className={`btn ${personalizado ? 'on' : ''}`} onClick={() => setPersonalizado((v) => !v)}>Período</button>
      </div>
      {personalizado && (
        <div className="tarjeta fila">
          <input type="date" value={desde} max={hasta || hoyIso()} onChange={(e) => setDesde(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
          <span className="tenue">a</span>
          <input type="date" value={hasta} min={desde || undefined} max={hoyIso()} onChange={(e) => setHasta(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
        </div>
      )}
    </>
  );
}
function useRango(inicial = 30) {
  const [dias, setDias] = useState(inicial); const [personalizado, setPersonalizado] = useState(false);
  const [desde, setDesde] = useState(''); const [hasta, setHasta] = useState('');
  const listo = !personalizado || (desde && hasta && desde <= hasta);
  const params = personalizado ? { desde, hasta } : { dias };
  return { dias, setDias, personalizado, setPersonalizado, desde, setDesde, hasta, setHasta, listo, params };
}

// ── Consumo medido en vitrina vs venta del POS ────────────────────────────────────────────
function ConsumoVentas() {
  const r = useRango(14); const [abierta, setAbierta] = useState(null);
  const d = useDatos(() => (r.listo ? get(`/rep/analitica/consumo${qs(r.params)}`) : Promise.resolve(null)), [r.dias, r.personalizado, r.desde, r.hasta]);
  return (
    <div className="rejilla">
      <SelectorRango {...r} />
      <div className="aviso-caja">Consumo de una noche = lo que había en vitrina anoche + lo que entró hoy − lo que queda esta noche (los pesajes). Se cruza con lo que vendió el POS de cada tienda ese mismo día. Solo cuentan las noches con pesaje esa noche y la anterior; las noches con consumo negativo (pesaje inconsistente) se descartan y se cuentan aparte.</div>
      <Estado d={d}>{(x) => x && (
        <>
          <div className="rejilla cols-3">
            <Kpi etiqueta="Consumido (vitrina)" valor={`${x.totales.consumoKg} kg`} acento />
            <Kpi etiqueta="Enviado a tiendas" valor={`${x.totales.enviadoKg} kg`} />
            <Kpi etiqueta="Vendido (POS)" valor={x.hayVentas ? lps(x.totales.ventasLps) : '—'} sub={x.hayVentas ? undefined : 'Sin ventas del POS en el período'} />
          </div>
          {x.medianaGramosPorCienLps && <small>Lo típico: {x.medianaGramosPorCienLps} g de gelato por cada L 100 vendidos. Una tienda a 25 % o más por encima conviene revisarla (merma, regalos o desperdicio).</small>}
          <div className="tarjeta">
            {x.sucursales.map((s) => (
              <div key={s.sucursal_id}>
                <div className="rep-fila clic" onClick={() => setAbierta(abierta === s.sucursal_id ? null : s.sucursal_id)}>
                  <div className="rep-fila-info">
                    <b>{s.nombre} {s.alerta && <span className="chip mal">Consume de más</span>} {s.fuera_de_analisis && <span className="chip">Se sirve de la fábrica</span>}</b>
                    <small>Enviado {s.enviadoKg} kg · {s.nochesMedidas} noches medidas{s.nochesDescartadas ? ` · ${s.nochesDescartadas} descartadas` : ''}{s.cruce ? ` · ${s.cruce.gramosPorCienLps} g por L 100${s.desviacionPct != null ? ` (${s.desviacionPct > 0 ? '+' : ''}${s.desviacionPct}% vs lo típico)` : ''}` : ''}</small>
                  </div>
                  <div style={{ textAlign: 'right' }}><b className="num">{s.consumoKg} kg</b><br /><small>{x.hayVentas ? lps(s.ventasLps) : ''}</small></div>
                </div>
                {abierta === s.sucursal_id && (
                  <div style={{ padding: '0 0 12px 12px' }} className="rejilla">
                    {s.cruce && <small>Gramos por venta: {s.cruce.gramosPorVenta ?? '—'} · {s.ventasN} ventas en el período.</small>}
                    {s.porSabor.length === 0 ? <small>Sin noches medidas.</small> : s.porSabor.slice(0, 12).map((v) => <Barra key={v.sabor_id} nombre={v.nombre} valor={v.consumoG} total={s.porSabor[0].consumoG} texto={`${v.consumoKg} kg`} />)}
                    {s.porDia.length > 0 && <details className="gd-plegable"><summary>Por día</summary>{s.porDia.map((p) => <div className="rep-fila" key={p.fecha}><div className="rep-fila-info"><b>{fechaCorta(p.fecha)}</b></div><span className="num">{p.consumoKg} kg</span><small className="num">{p.ventasLps != null ? lps(p.ventasLps) : '—'}</small></div>)}</details>}
                  </div>
                )}
              </div>
            ))}
          </div>
          <h3>Por sabor</h3>
          <div className="tarjeta">
            {x.sabores.length === 0 ? <div className="vacio">Sin noches medidas en este período.</div> : x.sabores.slice(0, 25).map((v) => <Barra key={v.sabor_id} nombre={v.nombre} valor={v.consumoKg} total={x.sabores[0].consumoKg} texto={`${v.consumoKg} kg`} />)}
          </div>
        </>
      )}</Estado>
    </div>
  );
}

// ── Rotación ──────────────────────────────────────────────────────────────────────────────
function Rotacion() {
  const r = useRango(30); const [vista, setVista] = useState('sabor'); const [abierto, setAbierto] = useState(null);
  const d = useDatos(() => (r.listo ? get(`/rep/analitica/rotacion${qs(r.params)}`) : Promise.resolve(null)), [r.dias, r.personalizado, r.desde, r.hasta]);
  return (
    <div className="rejilla">
      <SelectorRango {...r} />
      <Tabs tabs={[['sabor', 'Por sabor'], ['tienda', 'Por tienda'], ['insumos', 'Insumos']]} valor={vista} onCambio={(v) => { setVista(v); setAbierto(null); }} />
      {vista === 'insumos' ? <InsumosDespachados {...r.params} /> : (
        <>
          <div className="aviso-caja">Lo que salió de fábrica hacia cada tienda (despachos). No usa datos de venta: la factura es por tamaño y nunca dice el sabor. Para cruzarlo con la venta del POS mira «Consumo y ventas».</div>
          <Estado d={d}>{(x) => x && (vista === 'sabor' ? (
            x.sabores.length === 0 ? <div className="vacio">Sin movimiento en este período.</div> : (
              <div className="tarjeta">
                {x.sabores.map((s, i) => { const m = ETIQUETA[s.clasificacion]; return (
                  <div key={s.sabor_id}>
                    <div className="rep-fila clic" onClick={() => setAbierto(abierto === s.sabor_id ? null : s.sabor_id)}>
                      <span className="rep-num">{i + 1}</span>
                      <div className="rep-fila-info"><b>{s.nombre} <span className={`chip ${m[1]}`}>{m[0]}</span></b><small>{s.diasSinDespachar !== null && `hace ${s.diasSinDespachar} día${s.diasSinDespachar === 1 ? '' : 's'}`}{s.vecesSinStock > 0 && ` · faltó ${s.vecesSinStock} ${s.vecesSinStock === 1 ? 'vez' : 'veces'}`}</small></div>
                      <span className={`chip ${m[1]}`}>{s.despachadoKg} kg</span>
                    </div>
                    {abierto === s.sabor_id && (
                      <div style={{ padding: '0 0 12px 36px' }} className="rejilla">
                        {m[2] && <small>{m[2]}</small>}<small>Producido en el período: {s.producidoKg} kg</small>
                        {s.porSucursal.length === 0 ? <small>No se despachó a ninguna tienda.</small> : s.porSucursal.map((p) => <Barra key={p.sucursal_id} nombre={p.nombre} valor={p.despachadoGramos} total={s.despachadoGramos} texto={`${p.despachadoKg} kg`} />)}
                      </div>
                    )}
                  </div>
                ); })}
              </div>
            )
          ) : x.tiendas.length === 0 ? <div className="vacio">Sin movimiento en este período.</div> : (
            <div className="tarjeta">
              {x.tiendas.map((t, i) => (
                <div key={t.sucursal_id}>
                  <div className="rep-fila clic" onClick={() => setAbierto(abierto === t.sucursal_id ? null : t.sucursal_id)}>
                    <span className="rep-num">{i + 1}</span><div className="rep-fila-info"><b>{t.nombre}</b><small>{t.porSabor.length} sabor{t.porSabor.length === 1 ? '' : 'es'} enviado{t.porSabor.length === 1 ? '' : 's'}</small></div><span className="chip">{t.despachadoKg} kg</span>
                  </div>
                  {abierto === t.sucursal_id && <div style={{ padding: '0 0 12px 36px' }} className="rejilla"><small>De más a menos enviado:</small>{t.porSabor.map((s) => <Barra key={s.sabor_id} nombre={s.nombre} valor={s.despachadoGramos} total={t.despachadoGramos} texto={`${s.despachadoKg} kg`} />)}</div>}
                </div>
              ))}
            </div>
          ))}</Estado>
        </>
      )}
    </div>
  );
}

function InsumosDespachados({ dias = 30, desde, hasta, limite }) {
  const [abierto, setAbierto] = useState(null);
  const d = useDatos(() => get(`/rep/analitica/insumos-despachados${qs(desde ? { desde, hasta } : { dias })}`), [dias, desde, hasta]);
  return (
    <Estado d={d}>{(x) => {
      const lista = limite ? x.insumos.slice(0, limite) : x.insumos;
      return (
        <div className="rejilla">
          <small>No son los que las tiendas piden, sino los que el despachador de verdad marcó como enviados. Toca uno para ver a qué tienda se mandó más.</small>
          {lista.length === 0 ? <div className="vacio">Sin insumos despachados en este período.</div> : (
            <div className="tarjeta">
              {lista.map((i, idx) => (
                <div key={i.nombre}>
                  <div className="rep-fila clic" onClick={() => setAbierto(abierto === i.nombre ? null : i.nombre)}><span className="rep-num">{idx + 1}</span><div className="rep-fila-info"><b>{i.nombre}</b><small>{i.porTienda.length} tienda{i.porTienda.length === 1 ? '' : 's'}</small></div><span className="chip">{i.veces}×</span></div>
                  {abierto === i.nombre && <div style={{ padding: '0 0 12px 36px' }} className="rejilla">{i.porTienda.map((t) => <Barra key={t.sucursal_id} nombre={t.nombre} valor={t.veces} total={i.veces} texto={`${t.veces}×`} />)}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }}</Estado>
  );
}

// ── Qué mandar (recomendación de despacho) ────────────────────────────────────────────────
function Sugerido() {
  const d = useDatos(() => get(`/rep/analitica/recomendacion-despacho${qs({ hoy: hoyIso(), dias: 90 })}`), []);
  const [tiendaId, setTiendaId] = useState(null);
  return (
    <Estado d={d}>{(x) => {
      if (!x || x.tiendas.length === 0) return <div className="tarjeta"><div className="vacio">Todavía no hay suficiente historial para calcular un plan: hacen falta al menos un par de semanas con despachos seguidos a la misma tienda.</div></div>;
      const t = x.tiendas.find((z) => z.sucursal_id === tiendaId) || x.tiendas[0];
      const reparto = new Set(t.dias.map((z) => z.diaSemana));
      const max = Math.max(...t.perfilSemanal.map((z) => z.factor)); const plano = max / Math.min(...t.perfilSemanal.map((z) => z.factor)) < 1.15;
      const fuerte = t.perfilSemanal.reduce((a, z) => (z.factor > a.factor ? z : a));
      return (
        <div className="rejilla">
          <div className="aviso-caja">Cuántas panas conviene mandar de cada sabor, día por día. Sale de tu propio historial ({fechaCorta(x.desde)} a {fechaCorta(x.hasta)}): cuánto se consumió cada día, cuánto varía de una semana a otra y las veces que algo se acabó. Lo que ves es <b>lo que falta</b>, no lo que la tienda necesita: arranca del pesaje de vitrina de la última noche y descuenta lo que ya está allá, por eso a veces la respuesta es «no mandes nada». «Qué producir» está en Producción de gelato.</div>
          {x.excluidas?.length > 0 && <div className="aviso-caja">{x.excluidas.map((s) => <div key={s.id}><b>{s.nombre} queda fuera de este análisis.</b> {s.motivo}</div>)}</div>}
          <div className="rep-tiendas">{x.tiendas.map((z) => <button key={z.sucursal_id} className={`rep-ficha ${t.sucursal_id === z.sucursal_id ? 'on' : ''}`} onClick={() => setTiendaId(z.sucursal_id)}>{z.nombre}</button>)}</div>
          <h3>Qué días consume más · {t.nombre}</h3>
          <div className="tarjeta rejilla">
            <div className="rep-dias" style={{ height: 110 }}>
              {t.perfilSemanal.map((z) => (
                <div key={z.diaSemana} className={`rep-dia ${z.factor >= 1.15 ? 'fuerte' : z.factor <= 0.85 ? 'flojo' : ''} ${reparto.has(z.diaSemana) ? 'reparto' : ''}`}>
                  <span>{z.factor.toFixed(2)}</span><i style={{ height: `${max > 0 ? Math.max(6, (z.factor / max) * 70) : 6}px` }} /><span>{z.nombreCorto}</span>
                </div>
              ))}
            </div>
            <small>1.00 es un día normal. {plano ? 'Por ahora el consumo se ve parejo toda la semana.' : `El ${fuerte.nombreDia.toLowerCase()} mueve ${Math.round((fuerte.factor - 1) * 100)}% más que un día normal.`} En negrita, los días en que esta tienda recibe reparto.</small>
            <small>{t.fuentePerfil === 'vitrina' ? <><b>Medido noche por noche</b> con los pesajes de vitrina ({t.observacionesVitrina} noches).</> : <><b>Estimado a partir de los envíos</b>, no medido día por día: con el calendario actual hay días que siempre viajan juntos y desde los despachos no se pueden separar. Si la tienda pesa todas las noches, esto se afina solo.</>}</small>
            {t.precision && <small>Probado contra su propia historia, el modelo le erra en promedio <b>{t.precision.errorMedioPct}%</b> ({t.precision.dentroDe20Pct}% de los envíos dentro de ±20%), sobre {t.visitas} repartos.</small>}
          </div>
          {t.oportunidad && (
            <div className="aviso-caja ok"><b>¿Conviene sumar un día de reparto?</b> El envío del {t.oportunidad.parteEl.toLowerCase()} aguanta {t.oportunidad.diasACubrirActual} días y sale con {t.oportunidad.kgPicoActual} kg de una vez.{t.oportunidad.diasFuertesAlFinal.length > 0 && ` Además ${t.oportunidad.diasFuertesAlFinal.join(' y ').toLowerCase()}, de los días más fuertes, caen al final de esa ventana.`} Con un reparto el {t.oportunidad.nombreDia.toLowerCase()}, el envío más grande bajaría a ~{t.oportunidad.kgPicoTrasDividir} kg ({t.oportunidad.reduccionPct}% menos).</div>
          )}
          <h3>Qué mandar, día por día</h3>
          {t.pesajeDesde ? <small>Arranca de lo que quedó en vitrina el <b>{fechaCorta(t.pesajeDesde)}</b> y proyecta el consumo de cada día.{t.saboresSinPesaje > 0 && ` De ${t.saboresSinPesaje} sabor${t.saboresSinPesaje === 1 ? '' : 'es'} no hay pesaje reciente: se asume vitrina vacía.`}</small>
            : <div className="aviso-caja">Sin pesajes recientes de esta tienda no se sabe qué tiene en vitrina: estos números asumen que está vacía y salen altos.</div>}
          {t.agenda.map((a) => {
            const nada = a.totalPanas === 0;
            return (
              <div key={a.fecha} className="tarjeta" style={{ opacity: nada ? 0.72 : 1 }}>
                <div className="fila espacio"><b>{fechaCorta(a.fecha)}</b><span className="chip">{a.cubre.join(' · ')}</span></div>
                <small>{nada ? 'No hace falta mandar nada: con lo que tienen alcanza hasta el próximo reparto.' : `${a.totalPanas} pana${a.totalPanas === 1 ? '' : 's'} (${a.totalKg} kg) · tiene que aguantar ${a.diasACubrir} día${a.diasACubrir === 1 ? '' : 's'}`}</small>
                {a.sabores.filter((s) => s.panas > 0 || !nada).map((s) => (
                  <div className="rep-fila" key={s.sabor_id}>
                    <div className="rep-fila-info">
                      <b>{s.nombre} {s.confianza === 'baja' && <span className="chip">pocos datos</span>}</b>
                      <small>necesita {s.kgObjetivo} kg · {s.stockMedido ? 'va a tener' : 'sin pesaje, se asume'} {s.kgStock} kg</small>
                      {s.kgPiso > 0 && <small>incluye {s.kgPiso} kg que tienen que quedar en vitrina</small>}
                      {(s.vecesSinStock > 0 || s.vecesVitrinaVacia > 0) && <small style={{ color: 'var(--peligro)' }}>⚠ se acabó {s.vecesSinStock + s.vecesVitrinaVacia}x este día de la semana</small>}
                    </div>
                    <div style={{ textAlign: 'right' }}>{s.panas === 0 ? <b style={{ color: 'var(--ok)' }}>no hace falta</b> : <><b>{s.panas} pana{s.panas === 1 ? '' : 's'}</b><br /><small>{s.kgEnviar} kg</small></>}</div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      );
    }}</Estado>
  );
}

// ── Pedidos de insumos (vista del dueño) ──────────────────────────────────────────────────
function Pedidos() {
  const { puede } = useSesion();
  const [ejecutar] = useAccion(); const avisar = useAviso();
  const d = useDatos(() => get('/rep/pedidos'), []);
  const [fs, setFs] = useState(''); const [fe, setFe] = useState(''); const [cerrados, setCerrados] = useState({});
  const lista = d.datos ?? [];
  const hoy = hoyIso();
  const filtrados = useMemo(() => lista.filter((p) => (!fs || p.sucursal_nombre === fs) && (!fe || p.estado === fe)), [lista, fs, fe]);
  const tableros = agruparPedidosPorSucursal(filtrados);
  const delDia = lista.filter((p) => p.fecha === hoy);
  const conPend = new Set(lista.filter((p) => p.estado !== 'recibido').map((p) => p.sucursal_nombre)).size;
  const masItems = agruparPedidosPorSucursal(delDia).sort((a, b) => b.totalItems - a.totalItems)[0];
  const cambiar = async (id, estado) => { if (await ejecutar(() => patch(`/rep/pedidos/${id}/estado`, { estado }))) d.recargar(); };
  return (
    <div className="rejilla">
      <h3>Cómo va el día</h3>
      <div className="rejilla cols-4">
        <Kpi etiqueta="Pendientes" valor={delDia.filter((p) => p.estado === 'pedido').length} />
        <Kpi etiqueta="En preparación" valor={delDia.filter((p) => p.estado === 'preparado').length} />
        <Kpi etiqueta="Despachados hoy" valor={delDia.filter((p) => ['enviado', 'recibido'].includes(p.estado)).length} />
        <Kpi etiqueta="Sucursales con pedidos activos" valor={conPend} sub={masItems ? `Más ítems hoy: ${masItems.nombre} (${masItems.totalItems})` : undefined} />
      </div>
      <div className="fila espacio"><h3>Pedidos por sucursal</h3>
        <button className="btn chico" disabled={!filtrados.length} onClick={() => descargarCsv(`pedidos_${hoy}.csv`, filtrados.flatMap((p) => p.items.map((i) => ({ fecha: p.fecha, sucursal: p.sucursal_nombre, estado: p.estado, insumo: i.insumo_texto, cantidad: i.cantidad, notas: p.notas }))), [['fecha', 'Fecha'], ['sucursal', 'Sucursal'], ['estado', 'Estado'], ['insumo', 'Insumo'], ['cantidad', 'Cantidad'], ['notas', 'Notas']])}>Descargar CSV</button></div>
      <div className="tarjeta fila">
        <select value={fs} onChange={(e) => setFs(e.target.value)} style={{ flex: 1, minWidth: 150 }}><option value="">Todas las sucursales</option>{[...new Set(lista.map((p) => p.sucursal_nombre))].sort().map((n) => <option key={n}>{n}</option>)}</select>
        <select value={fe} onChange={(e) => setFe(e.target.value)} style={{ flex: 1, minWidth: 150 }}><option value="">Todos los estados</option><option value="pedido">Pendiente</option><option value="preparado">En preparación</option><option value="enviado">Despachado</option><option value="recibido">Entregado</option></select>
      </div>
      <Estado d={d}>{() => tableros.length === 0 ? <div className="vacio">No hay pedidos con estos filtros.</div> : tableros.map((t) => {
        const cerrado = cerrados[t.id] ?? true;
        return (
          <div className="tarjeta" key={t.id}>
            <div className="rep-fila clic" onClick={() => setCerrados((c) => ({ ...c, [t.id]: !cerrado }))} style={{ borderTop: 0 }}>
              <div className="rep-fila-info"><b>{t.nombre}</b><small>{t.pedidos.length} pedido{t.pedidos.length === 1 ? '' : 's'} · {t.totalItems} ítem{t.totalItems === 1 ? '' : 's'} · {cuandoTexto(t.ultimaHora)}</small></div>
              <Pill estado={t.estadoGeneral} /><span>{cerrado ? '▸' : '▾'}</span>
            </div>
            {!cerrado && t.pedidos.map((p) => (
              <div className="rep-recep" key={p.id}>
                <div className="fila espacio"><small>{fechaCorta(p.fecha)}{p.notas ? ` · ${p.notas}` : ''}</small>
                  {p.estado !== 'recibido' && puede('rep:despachar') ? <select value={p.estado} onChange={(e) => cambiar(p.id, e.target.value)} style={{ width: 'auto' }}><option value="pedido">Pendiente</option><option value="preparado">En preparación</option><option value="enviado">Despachado</option><option value="recibido">Entregado</option></select> : <Pill estado={p.estado} />}</div>
                {p.items.length === 0 && <small style={{ color: 'var(--peligro)' }}>Pedido sin ítems registrados</small>}
                {p.items.map((i) => <small key={i.id}>• {i.insumo_texto}{i.cantidad ? ` (${i.cantidad})` : ''}{i.preparado ? ' ✓' : ''}</small>)}
              </div>
            ))}
          </div>
        );
      })}</Estado>
    </div>
  );
}

// ── Catálogo global de sabores ────────────────────────────────────────────────────────────
function Sabores() {
  const avisar = useAviso(); const [ejecutar] = useAccion();
  const d = useDatos(() => get('/rep/sabores'), []);
  const [q, setQ] = useState(''); const [inact, setInact] = useState(false); const [edit, setEdit] = useState(null); const [datos, setDatos] = useState({ nombre: '', gramos_pana: '' });
  const [fusion, setFusion] = useState(null); const [buscar, setBuscar] = useState(''); const [confirmar, setConfirmar] = useState(null); const [nuevo, setNuevo] = useState(null);
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  const lista = d.datos ?? [];
  const visibles = lista.filter((s) => (inact ? !s.activo : s.activo)).filter((s) => s.nombre.includes(q.trim().toUpperCase()));
  const inactivos = lista.filter((s) => !s.activo).length;
  const guardar = async (id) => { const g = Number(datos.gramos_pana); if (!datos.nombre.trim() || !(g > 0)) return; if (await ejecutar(() => patch(`/rep/sabores/${id}`, { nombre: datos.nombre, gramos_pana: g }), 'Sabor actualizado')) { setEdit(null); d.recargar(); } };
  const alternar = async (s) => { if (await ejecutar(() => patch(`/rep/sabores/${s.id}`, { activo: !s.activo }))) d.recargar(); };
  async function fusionar() {
    const { origen, destino } = confirmar;
    const r = await ejecutar(() => post(`/rep/sabores/${origen.id}/fusionar`, { en: destino.id }));
    if (r?.ok) {
      const partes = Object.entries(r.movidos || {}).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
      avisar(`"${r.origen}" fusionado en "${r.destino}"${partes.length ? ` (${partes.join(', ')})` : ''}${r.receta_sin_fusionar ? '. Algo quedó sin mover (recetas u otros): revísalo' : ''}`);
      setConfirmar(null); setFusion(null); setBuscar(''); d.recargar();
    }
  }
  async function crear(forzar = false) {
    try {
      await post('/rep/sabores', { nombre: nuevo.nombre, gramos_pana: Number(nuevo.gramos_pana) || undefined, forzar });
      avisar('Sabor creado: actívalo en las sucursales que lo venden'); setNuevo(null); d.recargar();
    } catch (e) {
      if (e.status === 409 && !forzar && window.confirm(`${e.message}\n\n¿Crearlo de todos modos?`)) return crear(true);
      if (e.status !== 409) avisar(e.message, 'mal');
    }
  }
  return (
    <div className="rejilla">
      <div className="tarjeta rejilla">
        <div className="fila espacio"><h3>Catálogo global de sabores</h3><button className="btn chico primario" onClick={() => setNuevo({ nombre: '', gramos_pana: 3000 })}>+ Nuevo sabor</button></div>
        <small>Corrige el nombre o el peso de pana de un sabor, reactiva uno desactivado por error, o junta duplicados con 🔗.</small>
        <div className="fila"><input placeholder="Buscar sabor…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />{inactivos > 0 && <button className={`btn chico ${inact ? 'primario' : 'fantasma'}`} onClick={() => setInact((v) => !v)}>{inact ? '✓ ' : ''}{inactivos} inactivo{inactivos === 1 ? '' : 's'}</button>}</div>
        {visibles.map((s) => (
          <div key={s.id} style={{ opacity: s.activo ? 1 : 0.6 }}>
            {edit === s.id ? (
              <form className="fila" onSubmit={(e) => { e.preventDefault(); guardar(s.id); }}>
                <input autoFocus style={{ flex: 1, minWidth: 140 }} value={datos.nombre} onChange={(e) => setDatos({ ...datos, nombre: e.target.value })} />
                <input type="number" min="1" style={{ width: 110 }} value={datos.gramos_pana} onChange={(e) => setDatos({ ...datos, gramos_pana: e.target.value })} />
                <button className="btn chico primario">Guardar</button><button type="button" className="btn chico fantasma" onClick={() => setEdit(null)}>Cancelar</button>
              </form>
            ) : (
              <div className="rep-fila">
                <div className="rep-fila-info clic" style={{ cursor: 'pointer' }} onClick={() => { setEdit(s.id); setDatos({ nombre: s.nombre, gramos_pana: s.gramos_pana }); }}><b>{s.nombre}</b><small>pana {s.gramos_pana} g · toca para editar</small></div>
                <button className="btn chico fantasma" title="Fusionar con otro sabor (juntar duplicados)" onClick={() => { setFusion(fusion === s.id ? null : s.id); setBuscar(''); }}>🔗</button>
                <button className={`btn chico ${s.activo ? 'primario' : 'fantasma'}`} onClick={() => alternar(s)}>{s.activo ? 'Activo' : 'Reactivar'}</button>
              </div>
            )}
            {fusion === s.id && (
              <div className="tarjeta rejilla">
                <small>Fusionar <b>«{s.nombre}»</b> dentro de otro sabor: todo lo que se pesó, produjo o despachó a su nombre pasa a contar para el que elijas.</small>
                <input autoFocus placeholder="Buscar el sabor que se queda…" value={buscar} onChange={(e) => setBuscar(e.target.value)} />
                <div style={{ maxHeight: 180, overflow: 'auto' }}>
                  {lista.filter((x) => x.id !== s.id && x.activo).filter((x) => !buscar.trim() || norm(x.nombre).includes(norm(buscar))).slice(0, 20).map((x) => <div key={x.id} className="rep-fila clic" onClick={() => setConfirmar({ origen: s, destino: x })}><b>{x.nombre}</b></div>)}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      {confirmar && <Modal titulo="Fusionar sabores" tam="angosto" onCerrar={() => setConfirmar(null)} pie={<><button className="btn" onClick={() => setConfirmar(null)}>Cancelar</button><button className="btn peligro" onClick={fusionar}>Sí, fusionar</button></>}>
        <p>Todo lo de <b>«{confirmar.origen.nombre}»</b> va a pasar a contar como <b>«{confirmar.destino.nombre}»</b>, y «{confirmar.origen.nombre}» sale del catálogo. No se puede deshacer.</p></Modal>}
      {nuevo && <Modal titulo="Nuevo sabor" tam="angosto" onCerrar={() => setNuevo(null)} pie={<><button className="btn" onClick={() => setNuevo(null)}>Cancelar</button><button className="btn primario" disabled={!nuevo.nombre.trim()} onClick={() => crear(false)}>Crear</button></>}>
        <label>Nombre<input autoFocus value={nuevo.nombre} onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })} /></label>
        <label>Peso de una pana (g)<input type="number" min="1" value={nuevo.gramos_pana} onChange={(e) => setNuevo({ ...nuevo, gramos_pana: e.target.value })} /></label>
        <small>Si el nombre se parece a uno existente o trae el peso pegado, te aviso antes de crearlo.</small></Modal>}
    </div>
  );
}

// ── Sucursales: cerrar/reactivar, fuera de análisis y catálogo por sucursal ───────────────
function Sucursales() {
  const [ejecutar] = useAccion();
  const d = useDatos(() => get('/rep/sucursales/todas'), []);
  const [sel, setSel] = useState(null);
  const lista = d.datos ?? [];
  const cambiar = async (s, c) => { if (await ejecutar(() => patch(`/rep/sucursales/${s.id}/config`, c), 'Guardado')) d.recargar(); };
  return (
    <div className="rejilla">
      <h3>Sucursales</h3>
      <div className="tarjeta">
        <small>Una sucursal cerrada sale del pesaje y de los análisis pero conserva todo su historial. «Fuera del análisis» la deja pesar sin que entre a los modelos de demanda (Los Andes se sirve sola de la fábrica). Las sucursales en sí se crean y editan en Administración → Sucursales; la ubicación para marcar asistencia está en Personal.</small>
        {lista.map((s) => (
          <div className="rep-fila" key={s.id} style={{ opacity: s.cerrada ? 0.6 : 1 }}>
            <div className="rep-fila-info"><b>{s.nombre}</b><small>{s.cerrada ? 'cerrada' : 'abierta'}{s.fuera_de_analisis ? ' · fuera del análisis de demanda' : ''}</small></div>
            <button className={`btn chico ${s.fuera_de_analisis ? 'primario' : 'fantasma'}`} onClick={() => cambiar(s, { fuera_de_analisis: !s.fuera_de_analisis })}>Fuera del análisis</button>
            <button className={`btn chico ${s.cerrada ? 'primario' : 'fantasma'}`} onClick={() => cambiar(s, { cerrada: !s.cerrada })}>{s.cerrada ? 'Reabrir' : 'Cerrar'}</button>
          </div>
        ))}
      </div>
      <h3>Catálogo de sabores por sucursal</h3>
      <small>Cada tienda puede activar y desactivar los suyos desde su pantalla de pesaje; esto es para armarlo la primera vez o resolver algo a distancia.</small>
      <div className="rep-tiendas">{lista.filter((s) => !s.cerrada).map((s) => <button key={s.id} className={`rep-ficha ${sel === s.id ? 'on' : ''}`} onClick={() => setSel(s.id)}>{s.nombre}</button>)}</div>
      {sel && <CatalogoSabores sucursalId={sel} />}
    </div>
  );
}

// ── Resumen diario ────────────────────────────────────────────────────────────────────────
function Resumen() {
  const [fecha, setFecha] = useState(hoyIso()); const [ejecutar] = useAccion();
  const d = useDatos(() => get(`/rep/analitica/resumen/${fecha}`), [fecha]);
  const [ver, setVer] = useState(false);
  async function enviar() { const r = await ejecutar(() => post(`/rep/analitica/resumen/${fecha}/enviar`)); if (r) d.recargar(); }
  return (
    <div className="rejilla">
      <div className="aviso-caja"><b>Envío por correo pendiente de configurar.</b> El resumen diario (lista de envíos por sucursal, discrepancias) se arma completo aquí; el servidor todavía no tiene correo configurado, así que «Preparar envío» lo deja guardado y listo para mandarse cuando se configure.</div>
      <div className="tarjeta fila"><label style={{ flex: 1, minWidth: 170 }}>Día<input type="date" value={fecha} max={hoyIso()} onChange={(e) => e.target.value && setFecha(e.target.value)} /></label>
        <button className="btn primario" onClick={enviar}>Preparar envío</button><button className="btn" onClick={() => setVer((v) => !v)}>{ver ? 'Ocultar' : 'Ver contenido'}</button></div>
      <Estado d={d}>{(x) => (
        <>
          {x.envio && <div className="aviso-caja">Estado: <b>{x.envio.estado === 'pendiente_configurar' ? 'pendiente de configurar' : x.envio.estado}</b> · {x.envio.detalle}</div>}
          <div className="rejilla cols-3"><Kpi etiqueta="Despachos del día" valor={x.totalDespachos} /><Kpi etiqueta="Discrepancias" valor={x.discrepancias.length} /><Kpi etiqueta="Sucursales con envío" valor={Object.keys(x.porSucursal).length} /></div>
          {ver && <div className="tarjeta"><pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'inherit' }}>{x.texto}</pre></div>}
        </>
      )}</Estado>
    </div>
  );
}
