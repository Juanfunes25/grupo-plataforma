// Gráficas del kit adaptadas a lo que muestra Italo: leyenda, barras horizontales con color por barra,
// barras verticales con valor y mapa de calor. HTML/CSS puro, sin librerías (mismo criterio que el kit).
import { DIAS, DIAS_CORTOS, Lm, hora12 } from './formato.js';
import './cierres.css';

export const SERIES = ['var(--serie-1)', 'var(--serie-2)', 'var(--serie-3)', 'var(--serie-4)', 'var(--serie-5)'];
export const colorSerie = (i) => SERIES[i % SERIES.length];
export const COLOR_FORMA = { efectivo: 'var(--serie-1)', tarjeta: 'var(--serie-2)', transferencia: 'var(--serie-3)' };

export const Leyenda = ({ items }) => (
  <div className="leyenda">{items.map((it) => <span key={it.nombre} className="leyenda-item"><i style={{ background: it.color }} />{it.nombre}</span>)}</div>
);

/** Barras horizontales: datos = [{ nombre, valor, color? }]. */
export function BarraH({ datos, formato = (v) => v, color = 'var(--serie-1)', vacio = 'Sin datos en este rango.' }) {
  const max = Math.max(1, ...datos.map((d) => Number(d.valor)));
  if (!datos.length) return <div className="vacio">{vacio}</div>;
  return (
    <div className="barras">
      {datos.map((d) => (
        <div className="barra-fila" key={d.nombre}>
          <span title={d.nombre} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.nombre}</span>
          <div className="pista"><i style={{ width: `${(Number(d.valor) / max) * 100}%`, background: d.color ?? color }} /></div>
          <b className="num">{formato(Number(d.valor))}</b>
        </div>
      ))}
    </div>
  );
}

/** Barras verticales con el valor encima: datos = [{ etiqueta, valor, color?, titulo? }]. */
export function BarrasV({ datos, formato = (v) => v, color = 'var(--serie-1)', alto = 150, vacio = 'Sin datos en este rango.' }) {
  const max = Math.max(1, ...datos.map((d) => Number(d.valor)));
  if (!datos.length) return <div className="vacio">{vacio}</div>;
  const muchas = datos.length > 16;
  return (
    <div className="barras-v" style={{ height: alto + 34 }}>
      {datos.map((d, i) => (
        <div className="barra-v" key={`${d.etiqueta}-${i}`} title={d.titulo ?? `${d.etiqueta}: ${formato(Number(d.valor))}`}>
          {!muchas && <span className="barra-v-valor">{formato(Number(d.valor))}</span>}
          <i style={{ height: Math.max(3, (Number(d.valor) / max) * alto), background: d.color ?? color }} />
          <span className="barra-v-etq">{d.etiqueta}</span>
        </div>
      ))}
    </div>
  );
}

/** Barra de progreso en línea (para tablas). */
export function Barra({ valor, maximo, color = 'var(--serie-1)' }) {
  const ancho = maximo > 0 ? Math.max(1.5, (valor / maximo) * 100) : 0;
  return <span className="mini-barra"><i style={{ width: `${ancho}%`, background: color }} /></span>;
}

/** Mapa de calor día de la semana × hora (solo las horas con movimiento). */
export function MapaCalor({ calor, color = 'var(--acento)' }) {
  const max = Math.max(0, ...calor.flat());
  const horas = Array.from({ length: 24 }, (_, h) => h).filter((h) => calor.some((f) => f[h] > 0));
  if (!horas.length) return <div className="vacio">Sin ventas en este rango.</div>;
  return (
    <div className="tabla-wrap">
      <table className="calor">
        <thead><tr><th />{horas.map((h) => <th key={h}>{hora12(h)}</th>)}</tr></thead>
        <tbody>{calor.map((fila, dia) => (
          <tr key={dia}><th>{DIAS_CORTOS[dia]}</th>{horas.map((h) => {
            const i = max > 0 ? fila[h] / max : 0;
            return <td key={h} title={`${DIAS[dia]} ${hora12(h)}: ${Lm(fila[h])}`} style={{ background: `color-mix(in srgb, ${color} ${Math.round(i * 100)}%, var(--panel-2))` }}>{fila[h] > 0 && i > 0.45 ? `${Math.round(fila[h] / 1000)}k` : ''}</td>;
          })}</tr>
        ))}</tbody>
      </table>
      <small>Más intenso = más venta. Sirve para decidir turnos y cuándo reforzar personal.</small>
    </div>
  );
}

/** Variación contra el periodo anterior. `invertir` = bajar es bueno (descuentos, notas de crédito). */
export function Variacion({ actual, anterior, invertir = false }) {
  if (anterior === undefined || anterior === null) return null;
  if (Number(anterior) === 0) return Number(actual) > 0 ? <span className="chip">nuevo</span> : null;
  const v = Math.round(((Number(actual) - Number(anterior)) / Math.abs(Number(anterior))) * 1000) / 10;
  const bueno = invertir ? v <= 0 : v >= 0;
  return <span className={`chip ${bueno ? 'ok' : 'mal'}`} title={`Periodo anterior: ${Number(anterior).toLocaleString('es-HN')}`}>{v >= 0 ? '▲' : '▼'} {Math.abs(v)}%</span>;
}
