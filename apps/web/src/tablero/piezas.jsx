// Piezas visuales del tablero (tarjetas grandes para el celular).
import { lempiras } from '@grupo/shared';
import Icono from '../ui/Icono.jsx';
import { Esqueleto } from '../ui/kit.jsx';
import { textoVariacion, tonoVariacion } from './util.js';
import './tablero.css';

/** Chip de variación con flecha y color (verde sube, rojo baja). */
export function Delta({ v, etiqueta }) {
  const tono = tonoVariacion(v);
  const flecha = v?.pct > 0.05 ? '▲' : v?.pct < -0.05 ? '▼' : '';
  return <span className={`tb-delta ${tono}`} aria-label={`${etiqueta ?? 'Variación'}: ${textoVariacion(v)}`}>{flecha && <i aria-hidden="true">{flecha}</i>}{textoVariacion(v)}</span>;
}

/** Indicador de «deslizar para actualizar» (se asoma arriba mientras se jala). */
export function IndicadorDeslizar({ tiro, ocupado }) {
  const visible = tiro > 4 || ocupado;
  return (
    <div className={`tb-tirar${visible ? ' visible' : ''}${ocupado ? ' ocupado' : ''}`} style={{ height: ocupado ? 40 : tiro }} aria-hidden={!visible} role="status">
      <span className="tb-tirar-giro"><Icono n="deshacer" tam={18} /></span>
      <small>{ocupado ? 'Actualizando…' : tiro >= 64 ? 'Suelta para actualizar' : 'Desliza para actualizar'}</small>
    </div>
  );
}

/** Alertas del tablero: lo urgente va arriba. `ir(alerta)` navega al módulo (o undefined si no hay). */
export function Alertas({ alertas, ir }) {
  if (!alertas?.length) return <div className="tb-todo-bien"><Icono n="check" tam={18} /> Todo en orden: sin alertas por atender.</div>;
  return (
    <section className="tb-alertas" aria-label="Alertas">
      {alertas.map((a, i) => {
        const destino = ir?.(a);
        const cuerpo = (
          <>
            <span className={`tb-alerta-ico ${a.severidad}`}><Icono n="alerta" tam={18} /></span>
            <span className="tb-alerta-texto">
              <b>{a.empresa ? `${a.empresa} · ` : ''}{a.titulo}</b>
              {a.detalle && <small>{a.detalle}</small>}
            </span>
            {a.cantidad > 1 && <span className={`chip ${a.severidad === 'alta' ? 'mal' : 'aviso'}`}>{a.cantidad}</span>}
            {destino && <Icono n="derecha" tam={16} />}
          </>
        );
        return destino
          ? <button key={i} type="button" className={`tb-alerta ${a.severidad}`} onClick={destino}>{cuerpo}</button>
          : <div key={i} className={`tb-alerta ${a.severidad}`}>{cuerpo}</div>;
      })}
    </section>
  );
}

/** Bloque de comparación: «Ayer a esta hora L X (+12 %)». */
export function Comparacion({ titulo, valor, completo, tituloCompleto, v }) {
  return (
    <div className="tb-comp">
      <div className="tb-comp-cab"><span>{titulo}</span><Delta v={v} etiqueta={titulo} /></div>
      <b className="num">{lempiras(valor)}</b>
      <small>{tituloCompleto}: {lempiras(completo)}</small>
    </div>
  );
}

/** Tendencia de 7 días: barras con el valor; hoy resaltado. */
export function Tendencia7({ dias, color }) {
  const max = Math.max(1, ...dias.map((d) => d.total));
  const abrev = (v) => (v >= 10000 ? `${Math.round(v / 1000)}k` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)));
  return (
    <div className="tb-tend" role="img" aria-label={dias.map((d) => `${d.dia} ${d.fecha}: ${lempiras(d.total)}`).join('; ')}>
      {dias.map((d, i) => (
        <div key={d.fecha} className={`tb-tend-col${i === dias.length - 1 ? ' hoy' : ''}`} title={`${d.fecha}: ${lempiras(d.total)} · ${d.facturas} facturas`}>
          <span className="tb-tend-val">{abrev(d.total)}</span>
          <i style={{ height: `${Math.max(4, (d.total / max) * 100)}%`, ...(color ? { '--tb-color': color } : {}) }} />
          <span className="tb-tend-dia">{i === dias.length - 1 ? 'Hoy' : d.dia}</span>
        </div>
      ))}
    </div>
  );
}

export function EsqueletoTablero() {
  return (
    <div className="tb-carga" aria-busy="true" aria-label="Cargando el tablero">
      <Esqueleto alto={150} /><div className="tb-dos"><Esqueleto alto={96} /><Esqueleto alto={96} /></div>
      <Esqueleto alto={190} /><Esqueleto alto={130} />
    </div>
  );
}
