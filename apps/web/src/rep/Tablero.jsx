// Tablero de gelato: la noche de un vistazo para dueño, administrador y manager. Todo dentro de la plataforma, sin subsitio.
// Semáforo por tienda · qué despachar y producir · recepciones y discrepancias · alertas · consumo · accesos directos.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import Icono from '../ui/Icono.jsx';
import { ErrorCaja } from '../ui/kit.jsx';
import { Barra, Esqueleto } from './comun.jsx';
import { cuandoTexto, fechaCorta, guardarCache, haceCuanto, hoyIso, leerCache, sumarDias } from './lib.js';
import './rep.css';

const saludo = () => { const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Tegucigalpa', hour: '2-digit', hourCycle: 'h23' }).format(new Date())); return h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches'; };
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
const horaLimite = (h) => `${h > 12 ? h - 12 : h} p. m.`;
const diaLargo = (f) => { const [y, m, d] = f.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('es-HN', { weekday: 'long', day: 'numeric', month: 'long' }); };

/** Texto y tono de una tienda según el semáforo. */
function resumenTienda(t, noche) {
  switch (t.estado) {
    case 'completo': return { tono: 'ok', titulo: 'Ya pesó', detalle: `${t.pesados} de ${t.esperados} sabores${t.reportado_en ? ` · ${cuandoTexto(t.reportado_en)}` : ''}` };
    case 'parcial': return { tono: 'aviso', titulo: 'Pesó una parte', detalle: `Faltan ${t.esperados - t.pesados} de ${t.esperados} sabores${t.reportado_en ? ` · último envío ${cuandoTexto(t.reportado_en)}` : ''}` };
    case 'pendiente': return { tono: 'aviso', titulo: 'Todavía no pesa', detalle: `Se espera antes de las ${horaLimite(noche.hora_limite_pesaje)}` };
    case 'falta': return { tono: 'mal', titulo: noche.esHoy ? 'No envió su pesaje' : 'No pesó esa noche', detalle: t.noches_sin_reporte > 1 ? `Lleva ${t.noches_sin_reporte} noches sin pesar` : t.ultima_noche ? `Última vez: ${fechaCorta(t.ultima_noche)}` : 'Sin pesajes en la última semana' };
    default: return { tono: 'neutro', titulo: 'No es obligatorio', detalle: 'Se sirve directo de fábrica' };
  }
}

function TarjetaTienda({ t, noche }) {
  const r = resumenTienda(t, noche);
  return (
    <div className={`gt-tienda ${r.tono}`}>
      <div className="gt-luz" aria-hidden="true" />
      <div className="gt-tienda-cuerpo">
        <div className="fila espacio"><b>{t.nombre}</b><span className={`chip ${r.tono === 'neutro' ? '' : r.tono}`}>{r.titulo}</span></div>
        <small>{r.detalle}</small>
        {(t.rojas > 0 || t.amarillas > 0 || t.insumos_por_juntar > 0) && (
          <div className="gt-chips">
            {t.rojas > 0 && <span className="chip mal">{plural(t.rojas, 'sabor urgente', 'sabores urgentes')}</span>}
            {t.amarillas > 0 && <span className="chip aviso">{plural(t.amarillas, 'sabor bajo', 'sabores bajos')}</span>}
            {t.panas_por_armar > 0 && <span className="chip">{plural(t.panas_por_armar, 'pana', 'panas')} por armar</span>}
            {t.insumos_por_juntar > 0 && <span className="chip">{plural(t.insumos_por_juntar, 'insumo', 'insumos')} pedido{t.insumos_por_juntar === 1 ? '' : 's'}</span>}
          </div>
        )}
        {t.estado !== 'opcional' && <small className="tenue">Reportó {t.noches_con_reporte_7d} de las últimas 7 noches</small>}
      </div>
    </div>
  );
}

function Tarjeta({ titulo, ir, irTexto, children, ancho }) {
  return (
    <section className={`tarjeta gt-bloque${ancho ? ' ancho' : ''}`}>
      <div className="fila espacio"><h3>{titulo}</h3>{ir && <Link className="btn chico" to={ir}>{irTexto}</Link>}</div>
      {children}
    </section>
  );
}

export default function Tablero() {
  const { contexto, modulos, usuario } = useSesion();
  const base = `/${contexto.empresa.codigo}`;
  const [fecha, setFecha] = useState('');                       // '' = la noche de trabajo que decide el servidor
  const clave = `tablero.${fecha || 'auto'}`;
  const [datos, setDatos] = useState(() => leerCache(clave)?.datos ?? null);
  const [desde, setDesde] = useState(() => leerCache(clave)?.ts ?? null);
  const [error, setError] = useState('');
  const [actualizando, setActualizando] = useState(false);
  const recargar = useRef(() => {});

  useEffect(() => {
    let vivo = true;
    const c = leerCache(clave); if (c?.datos) { setDatos(c.datos); setDesde(c.ts); } else setDatos(null);
    const cargar = async () => {
      setActualizando(true);
      try { const d = await get(`/rep/tablero${qs({ fecha })}`); if (!vivo) return; setDatos(d); setDesde(Date.now()); setError(''); guardarCache(clave, d); }
      catch (e) { if (vivo) setError(e.message); }
      finally { if (vivo) setActualizando(false); }
    };
    cargar();
    const t = setInterval(() => { if (document.visibilityState === 'visible') cargar(); }, 60000);
    const v = () => { if (document.visibilityState === 'visible') cargar(); };
    document.addEventListener('visibilitychange', v);
    recargar.current = cargar;
    return () => { vivo = false; clearInterval(t); document.removeEventListener('visibilitychange', v); };
  }, [clave]); // eslint-disable-line react-hooks/exhaustive-deps

  const accesos = useMemo(() => modulos.filter((m) => m.nav === 'Gelato' && m.id !== 'rep_tablero'), [modulos]);
  const ruta = (r, tab) => `${base}/${r}${tab ? `?tab=${tab}` : ''}`;

  if (!datos) return error ? <div className="rep ancha"><ErrorCaja error={error} onReintentar={() => recargar.current()} /></div> : <div className="rep ancha"><Esqueleto alto={110} /><Esqueleto alto={180} /><Esqueleto alto={180} /></div>;

  const { noche, semaforo: sem, tiendas, despacho, producir, alertas, consumo, discrepancias } = datos;
  const obligatorias = tiendas.filter((t) => t.estado !== 'opcional');
  const listas = sem.completo;
  const hayRojo = sem.falta > 0;
  const tonoHero = hayRojo ? 'mal' : sem.parcial + sem.pendiente > 0 ? 'aviso' : 'ok';
  const maxConsumo = Math.max(1, ...consumo.map((c) => c.consumoKg));
  const porRecibirPorTienda = Object.entries(Object.groupBy(datos.por_recibir, (d) => d.sucursal));
  const anochePosible = noche.esHoy ? sumarDias(hoyIso(), -1) : null;

  return (
    <div className="rep ancha gt">
      <div className="encabezado-pagina">
        <div>
          <h1>{saludo()}, {usuario.nombre.split(' ')[0]}</h1>
          <div className="rep-sub">Gelato · noche del {diaLargo(noche.fecha)}{noche.esHoy ? ' (hoy)' : ' (anoche)'}</div>
        </div>
        <div className="fila">
          {noche.esHoy
            ? <button className="btn" onClick={() => setFecha(anochePosible)}>Ver anoche</button>
            : <button className="btn" onClick={() => setFecha(hoyIso())}>Ver hoy</button>}
          <button className="btn" onClick={() => recargar.current()} disabled={actualizando} title="Actualizar ahora">{actualizando ? 'Actualizando…' : `⟳ ${desde ? haceCuanto(desde) : ''}`}</button>
        </div>
      </div>
      {error && <div className="aviso-caja mal">No se pudo actualizar ({error}). Se muestra lo último que se vio.</div>}

      <div className={`rep-hero gt-hero ${tonoHero}`}>
        <div className="gt-hero-num">{listas}<small>/{obligatorias.length}</small></div>
        <div>
          <b>{listas === obligatorias.length && obligatorias.length > 0 ? 'Todas las tiendas ya pesaron' : `${plural(listas, 'tienda ya pesó', 'tiendas ya pesaron')} su gelato`}</b>
          <div className="rep-sub">
            {[sem.falta > 0 && `${plural(sem.falta, 'no envió', 'no enviaron')} su pesaje`, sem.parcial > 0 && `${sem.parcial} a medias`, sem.pendiente > 0 && `${sem.pendiente} por pesar (se espera antes de las ${horaLimite(noche.hora_limite_pesaje)})`].filter(Boolean).join(' · ') || 'No falta nadie.'}
          </div>
        </div>
      </div>

      <h2 className="gt-sec">Tiendas · {noche.esHoy ? 'esta noche' : 'esa noche'}</h2>
      <div className="gt-tiendas">
        {[...tiendas].sort((a, b) => (a.estado === 'opcional') - (b.estado === 'opcional')).map((t) => <TarjetaTienda key={t.id} t={t} noche={noche} />)}
      </div>

      <div className="gt-rejilla">
        <Tarjeta titulo="Para despachar" ir={ruta('despacho')} irTexto="Abrir despacho">
          {despacho.sabores_totales === 0 && despacho.insumos_por_juntar === 0
            ? <div className="vacio">Todavía no hay nada que despachar. Aparece apenas una tienda envíe su pesaje.</div>
            : (
              <>
                <div className="gt-numeros">
                  <div><b>{despacho.panas_por_armar}</b><small>panas por armar</small></div>
                  <div><b>{despacho.enviados}<small>/{despacho.sabores_totales}</small></b><small>sabores enviados</small></div>
                  <div><b>{despacho.insumos_por_juntar}</b><small>insumos por juntar</small></div>
                </div>
                {despacho.top_sabores.length > 0 && <small>Lo que más se pide: {despacho.top_sabores.map((s) => `${s.nombre} (${s.panas})`).join(' · ')}</small>}
                {despacho.pendientes === 0 && despacho.sabores_totales > 0 && <div className="aviso-caja ok">Todo despachado.</div>}
              </>
            )}
        </Tarjeta>

        <Tarjeta titulo="Para producir hoy" ir={ruta('gelato-produccion', 'plan')} irTexto="Ver plan">
          {!producir || producir.panas === 0
            ? <div className="vacio">El plan no pide producir nada hoy (o aún no hay suficientes noches pesadas para calcularlo).</div>
            : (
              <>
                <div className="gt-numeros"><div><b>{producir.panas}</b><small>panas</small></div><div><b>{producir.kg}</b><small>kg</small></div></div>
                {producir.sabores.map((s) => <div className="rep-fila" key={s.nombre}><div className="rep-fila-info"><b>{s.nombre}</b></div><span className="chip">{plural(s.panas, 'pana', 'panas')} · {s.kg} kg</span></div>)}
              </>
            )}
        </Tarjeta>
      </div>

      {(porRecibirPorTienda.length > 0 || discrepancias.length > 0) && (
        <Tarjeta titulo="Recepción de lo enviado" ancho>
          {porRecibirPorTienda.map(([tienda, lista]) => (
            <div className="rep-fila" key={tienda}>
              <div className="rep-fila-info"><b>{tienda}</b><small>{plural(lista.length, 'sabor enviado', 'sabores enviados')} el {fechaCorta(lista[0].enviado_en)}, falta que la tienda confirme que llegó</small></div>
              <span className={`chip ${lista[0].enviado_en < datos.hoy ? 'aviso' : ''}`}>{lista[0].enviado_en < datos.hoy ? 'sin confirmar' : 'en camino'}</span>
            </div>
          ))}
          {discrepancias.map((d) => (
            <div className="rep-fila" key={d.id}>
              <div className="rep-fila-info"><b>{d.sucursal_nombre} · {d.sabor_nombre}</b><small>{fechaCorta(d.fecha)}: se enviaron {d.panas}, llegaron {d.panas_recibidas ?? '?'}</small></div>
              <Link className="btn chico" to={ruta('consumo', 'panorama')}>Resolver</Link>
            </div>
          ))}
        </Tarjeta>
      )}

      <Tarjeta titulo={alertas.length ? `Alertas (${alertas.length})` : 'Alertas'} ancho>
        {alertas.length === 0
          ? <div className="aviso-caja ok">Sin alertas: tiendas al día, inventario sobre el mínimo y nada pendiente.</div>
          : alertas.map((a) => (
            <Link key={a.id} to={ruta(a.ir, a.tab)} className={`gt-alerta ${a.tono}`}>
              <span className="gt-luz" aria-hidden="true" />
              <span className="rep-fila-info"><b>{a.titulo}</b>{a.detalle && <small>{a.detalle}</small>}</span>
              <Icono n="derecha" tam={18} />
            </Link>
          ))}
      </Tarjeta>

      <Tarjeta titulo="Consumo de la última noche medida" ir={ruta('consumo', 'consumo')} irTexto="Ver detalle" ancho>
        {consumo.length === 0
          ? <div className="vacio">Todavía no hay consumo medido: se calcula cuando una tienda pesa dos noches seguidas.</div>
          : (
            <>
              {consumo.map((c) => (
                <div key={c.sucursal_id} className="gt-consumo">
                  <Barra nombre={c.nombre} valor={c.consumoKg} total={maxConsumo} texto={`${c.consumoKg} kg`} />
                  <small>{fechaCorta(c.fecha)}{c.ventasLps != null ? ` · vendió L ${Math.round(c.ventasLps).toLocaleString('es-HN')}` : ''}</small>
                </div>
              ))}
              <small>Consumo = lo que había anoche + lo que llegó − lo que queda esta noche. Una tienda a medio pesar muestra la noche anterior.</small>
            </>
          )}
      </Tarjeta>

      <h2 className="gt-sec">Ir a</h2>
      <nav className="gt-accesos" aria-label="Módulos de gelato">
        {accesos.map((m) => (
          <Link key={m.id} to={`${base}/${m.ruta}`} className="gt-acceso"><span className="ico"><Icono n={m.icono} tam={22} /></span><span><b>{m.nombre}</b><small>{m.descripcion}</small></span></Link>
        ))}
      </nav>
    </div>
  );
}
