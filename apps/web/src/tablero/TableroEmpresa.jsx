// Tablero de la empresa activa: hoy contra ayer y contra el mismo día de la semana pasada, hecho para el celular.
import { useNavigate } from 'react-router-dom';
import { lempiras } from '@grupo/shared';
import { useSesion } from '../sesion.jsx';
import Icono from '../ui/Icono.jsx';
import { COLOR_FORMA, colorSerie } from '../cierres/graficas.jsx';
import { Alertas, Comparacion, Delta, EsqueletoTablero, IndicadorDeslizar, Tendencia7 } from './piezas.jsx';
import { hora12, moduloDeAlerta, useDeslizar, useTableroDatos } from './util.js';
import './tablero.css';

const DIAS_LARGOS = { Dom: 'domingo', Lun: 'lunes', Mar: 'martes', Mié: 'miércoles', Jue: 'jueves', Vie: 'viernes', Sáb: 'sábado' };

export default function TableroEmpresa() {
  const { modulos, contexto } = useSesion();
  const nav = useNavigate();
  const t = useTableroDatos('/tablero', [contexto?.empresa?.codigo]);
  const { tiro, ocupado } = useDeslizar(t.recargar);
  const base = contexto ? `/${contexto.empresa.codigo}` : '';
  const ir = (a) => { const m = moduloDeAlerta(modulos, a.modulo); return m ? () => nav(`${base}/${m.ruta}`) : undefined; };

  if (t.cargando) return <EsqueletoTablero />;
  if (t.error && !t.datos) return <div className="aviso-caja mal" role="alert">{t.error} <button className="btn chico" onClick={t.recargar}>Reintentar</button></div>;
  const d = t.datos;
  const dia = DIAS_LARGOS[d.semana_pasada.dia] ?? 'semana';
  const margenMenos = (d.hoy.margen_pct ?? null) !== null && d.ayer.margen_pct !== null ? Math.round((d.hoy.margen_pct - d.ayer.margen_pct) * 10) / 10 : null;
  const maxSuc = Math.max(1, ...d.sucursales.map((s) => s.hoy.total));
  const totalPagos = d.formas_pago.reduce((s, p) => s + p.monto, 0);
  const colorPago = (p, i) => COLOR_FORMA[p.tipo] ?? colorSerie(i + 3);

  return (
    <section className="tb" aria-label="Tablero de hoy">
      <IndicadorDeslizar tiro={tiro} ocupado={ocupado} />
      <div className="tb-cab">
        <div>
          <h2>Hoy en {d.empresa.nombre}</h2>
          <small>Actualizado a las {hora12(new Date(d.generado_at).toLocaleTimeString('en-GB', { timeZone: 'America/Tegucigalpa', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }))}</small>
        </div>
        <button className={`btn chico${t.actualizando ? ' cargando' : ''}`} onClick={t.recargar} disabled={t.actualizando} aria-label="Actualizar el tablero"><Icono n="deshacer" tam={16} /> {t.actualizando ? 'Actualizando…' : 'Actualizar'}</button>
      </div>

      <Alertas alertas={d.alertas} ir={ir} />

      <div className="tb-heroe">
        <div className="tb-heroe-etq"><span>Ventas de hoy</span><span>hasta las {hora12(d.hora_corte)}</span></div>
        <div className="tb-heroe-valor">{lempiras(d.hoy.total)}</div>
        <div className="tb-heroe-sub"><span>{d.hoy.facturas} {d.hoy.facturas === 1 ? 'factura' : 'facturas'}</span><span>Ticket {lempiras(d.hoy.ticket_promedio)}</span></div>
        <div className="tb-comps">
          <Comparacion titulo="Ayer a esta hora" valor={d.ayer.total_corte} v={d.vs_ayer.misma_hora} completo={d.ayer.total} tituloCompleto="Ayer completo" />
          <Comparacion titulo={`${dia[0].toUpperCase()}${dia.slice(1)} pasado`} valor={d.semana_pasada.total_corte} v={d.vs_semana_pasada.misma_hora} completo={d.semana_pasada.total} tituloCompleto="Día completo" />
        </div>
      </div>

      <div className="tb-dos">
        <div className="tb-mini"><span className="etq">Margen</span><span className="val">{d.hoy.margen_pct === null ? '—' : `${d.hoy.margen_pct.toLocaleString('es-HN')} %`}</span>
          <span className="sub">{margenMenos !== null && <Delta v={{ pct: margenMenos, nuevo: false }} etiqueta="Margen contra ayer" />}{d.hoy.cobertura_pct !== null && <span>{d.hoy.cobertura_pct} % con costo</span>}</span></div>
        <div className="tb-mini"><span className="etq">Ticket promedio</span><span className="val">{lempiras(d.hoy.ticket_promedio)}</span>
          <span className="sub">Ayer {lempiras(d.ayer.ticket_promedio)}</span></div>
      </div>

      <div className="tb-cuadricula">
        <div className="tb-bloque">
          <h2>Por sucursal</h2>
          {d.sucursales.length === 0 ? <small>Sin sucursales activas.</small> : (
            <div className="tb-suc">{d.sucursales.map((s) => (
              <div key={s.id} className="tb-suc-fila" style={s.color ? { '--suc': s.color } : undefined}>
                <div className="tb-suc-cab"><span className="tb-suc-nombre"><i />{s.nombre}</span><b className="tb-suc-total">{lempiras(s.hoy.total)}</b></div>
                <div className="tb-suc-pista"><i style={{ width: `${(s.hoy.total / maxSuc) * 100}%` }} /></div>
                <div className="tb-suc-pie"><span>{s.hoy.facturas} facturas · ticket {lempiras(s.hoy.ticket_promedio)}</span><Delta v={s.vs_ayer} etiqueta={`${s.nombre} contra ayer`} /><small>vs. ayer</small><Delta v={s.vs_semana_pasada} etiqueta={`${s.nombre} contra la semana pasada`} /><small>vs. sem. pasada</small></div>
              </div>))}</div>
          )}
        </div>
        <div className="tb-bloque">
          <h2>Formas de pago de hoy</h2>
          {d.formas_pago.length === 0 ? <small>Todavía no hay cobros hoy.</small> : (
            <>
              <div className="tb-pago-barra" role="img" aria-label={d.formas_pago.map((p) => `${p.nombre} ${p.porcentaje}%`).join(', ')}>{d.formas_pago.map((p, i) => <i key={p.nombre} style={{ width: `${(p.monto / totalPagos) * 100}%`, background: colorPago(p, i) }} />)}</div>
              <div className="tb-pago-lista">{d.formas_pago.map((p, i) => <div key={p.nombre} className="tb-pago-fila"><span><i style={{ background: colorPago(p, i) }} />{p.nombre} · {p.porcentaje} %</span><b>{lempiras(p.monto)}</b></div>)}</div>
            </>
          )}
        </div>
      </div>

      <div className="tb-bloque">
        <h2>Últimos 7 días</h2>
        <Tendencia7 dias={d.tendencia} color={contexto?.empresa?.color} />
      </div>
      {t.error && <small role="alert" style={{ color: 'var(--peligro-texto)' }}>No se pudo actualizar: {t.error}</small>}
    </section>
  );
}
