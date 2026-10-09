// «Hoy» de Dirección del Grupo: las empresas juntas, con acceso directo a cada una. Pensado para el celular.
import { Link, useNavigate } from 'react-router-dom';
import { lempiras } from '@grupo/shared';
import Icono from '../ui/Icono.jsx';
import { Alertas, Comparacion, Delta, EsqueletoTablero, IndicadorDeslizar, Tendencia7 } from './piezas.jsx';
import { comparar } from './comparar.js';
import { hora12, moduloDeAlerta, useDeslizar, useTableroDatos } from './util.js';
import './tablero.css';

export default function TableroGrupo() {
  const nav = useNavigate();
  const t = useTableroDatos('/tablero/grupo');
  const { tiro, ocupado } = useDeslizar(t.recargar);
  if (t.cargando) return <EsqueletoTablero />;
  if (t.error && !t.datos) return <div className="aviso-caja mal" role="alert">{t.error} <button className="btn chico" onClick={t.recargar}>Reintentar</button></div>;
  const d = t.datos;
  if (!d.empresas.length) return <div className="aviso-caja">Tu usuario no tiene permiso para ver el consolidado.</div>;
  const alertas = d.empresas.flatMap((e) => e.alertas.map((a) => ({ ...a, empresa: e.nombre, _codigo: e.codigo }))).sort((a, b) => (a.severidad === b.severidad ? 0 : a.severidad === 'alta' ? -1 : 1));
  // Una alerta lleva directo al módulo de ESA empresa (la ruta se arma con el catálogo de módulos de cada una).
  const ir = (a) => { const m = moduloDeAlerta(RUTAS_BASE, a.modulo); return m ? () => nav(`/${a._codigo}/${m.ruta}`) : undefined; };
  const vsAyer = comparar(d.total.hoy, d.total.ayer_misma_hora), vsSem = comparar(d.total.hoy, d.total.semana_misma_hora);

  return (
    <section className="tb" aria-label="Hoy en el grupo">
      <IndicadorDeslizar tiro={tiro} ocupado={ocupado} />
      <div className="tb-cab">
        <div><h2>Hoy en el grupo</h2><small>Hasta las {hora12(d.hora_corte)} · {d.empresas.length} empresas</small></div>
        <button className={`btn chico${t.actualizando ? ' cargando' : ''}`} onClick={t.recargar} disabled={t.actualizando} aria-label="Actualizar el tablero"><Icono n="deshacer" tam={16} /> {t.actualizando ? 'Actualizando…' : 'Actualizar'}</button>
      </div>

      <Alertas alertas={alertas} ir={ir} />

      <div className="tb-heroe">
        <div className="tb-heroe-etq"><span>Vendido hoy · suma de las empresas</span></div>
        <div className="tb-heroe-valor">{lempiras(d.total.hoy)}</div>
        <div className="tb-heroe-sub"><span>{d.total.facturas_hoy} facturas</span></div>
        <div className="tb-comps">
          <Comparacion titulo="Ayer a esta hora" valor={d.total.ayer_misma_hora} v={vsAyer} completo={d.total.ayer} tituloCompleto="Ayer completo" />
          <Comparacion titulo="Semana pasada" valor={d.total.semana_misma_hora} v={vsSem} completo={d.total.semana_pasada} tituloCompleto="Día completo" />
        </div>
      </div>

      <div className="tb-empresas">{d.empresas.map((e) => (
        <article key={e.codigo} className="tb-empresa" style={{ '--emp': e.color }}>
          <div className="tb-empresa-cab"><h2>{e.nombre}</h2>{e.alertas.length > 0 && <span className={`chip ${e.alertas.some((a) => a.severidad === 'alta') ? 'mal' : 'aviso'}`}>{e.alertas.length} {e.alertas.length === 1 ? 'alerta' : 'alertas'}</span>}</div>
          <div className="tb-empresa-valor">{lempiras(e.hoy.total)}</div>
          <div className="fila" style={{ gap: 8, flexWrap: 'wrap' }}><Delta v={e.vs_ayer.misma_hora} etiqueta={`${e.nombre} contra ayer`} /><small className="tenue">vs. ayer</small><Delta v={e.vs_semana_pasada.misma_hora} etiqueta={`${e.nombre} contra la semana pasada`} /><small className="tenue">vs. sem. pasada</small></div>
          <div className="tb-empresa-datos">
            <div><small>Facturas</small><b>{e.hoy.facturas}</b></div>
            <div><small>Ticket</small><b>{lempiras(e.hoy.ticket_promedio)}</b></div>
            <div><small>Margen</small><b>{e.hoy.margen_pct === null ? '—' : `${e.hoy.margen_pct} %`}</b></div>
          </div>
          <Tendencia7 dias={e.tendencia} color={e.color} />
          <Link className="btn primario tb-abrir" to={`/${e.codigo}`}>Abrir {e.nombre} <Icono n="derecha" tam={16} /></Link>
        </article>))}
      </div>
      <div className="tb-bloque"><h2>Grupo · últimos 7 días</h2><Tendencia7 dias={d.tendencia} /></div>
      {t.error && <small role="alert" style={{ color: 'var(--peligro-texto)' }}>No se pudo actualizar: {t.error}</small>}
    </section>
  );
}

// Rutas de los módulos que una alerta del grupo puede abrir (iguales en todas las empresas del catálogo compartido).
const RUTAS_BASE = [
  { id: 'inventario', ruta: 'inventario' }, { id: 'cierres', ruta: 'cierres' }, { id: 'cai', ruta: 'cai' },
  { id: 'antifraude', ruta: 'antifraude' }, { id: 'documentos', ruta: 'documentos' },
];
