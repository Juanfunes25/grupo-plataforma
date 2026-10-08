import { lempiras } from '@grupo/shared';
import Icono from './Icono.jsx';

const COLOR = { alta: 'var(--peligro)', media: 'var(--aviso)', info: 'var(--info)', positivo: 'var(--ok)' };
const ETQ = { alta: 'Urgente', media: 'Atención', info: 'Para saber', positivo: 'Va bien' };

/** Anillo de salud 0–100. */
export function Anillo({ valor, nivel, tam = 120 }) {
  const r = tam / 2 - 10, c = 2 * Math.PI * r;
  const color = valor >= 80 ? 'var(--ok)' : valor >= 60 ? 'var(--aviso)' : 'var(--peligro)';
  return (
    <svg width={tam} height={tam} viewBox={`0 0 ${tam} ${tam}`} role="img" aria-label={`Salud ${valor} de 100`}>
      <circle cx={tam / 2} cy={tam / 2} r={r} fill="none" stroke="var(--panel-3)" strokeWidth="10" />
      <circle cx={tam / 2} cy={tam / 2} r={r} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${(valor / 100) * c} ${c}`} transform={`rotate(-90 ${tam / 2} ${tam / 2})`} />
      <text x="50%" y="48%" textAnchor="middle" fontSize={tam * 0.28} fontFamily="Barlow Condensed" fontWeight="600" fill="currentColor">{valor}</text>
      <text x="50%" y="66%" textAnchor="middle" fontSize={tam * 0.1} fill="var(--tenue)">{nivel}</text>
    </svg>
  );
}

export function ListaHallazgos({ hallazgos, max }) {
  const lista = max ? hallazgos.slice(0, max) : hallazgos;
  if (!lista.length) return <div className="aviso-caja ok">Sin hallazgos: todo se ve en orden.</div>;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {lista.map((h, i) => (
        <article key={i} className="tarjeta" style={{ borderLeft: `4px solid ${COLOR[h.severidad]}`, display: 'grid', gap: 6 }}>
          <div className="fila espacio">
            <b>{h.titulo}</b>
            <span className="fila" style={{ gap: 6 }}>
              {h.valor > 0 && <span className="chip">≈ {lempiras(h.valor)}</span>}
              <span className="chip" style={{ color: COLOR[h.severidad] }}>{ETQ[h.severidad]}</span>
            </span>
          </div>
          <small style={{ color: 'var(--texto)', opacity: 0.85 }}>{h.detalle}</small>
          {h.accion && <small><Icono n="gerente" tam={14} /> <b>Qué hacer:</b> {h.accion}</small>}
        </article>
      ))}
    </div>
  );
}

/** Cabecera del análisis de una empresa: salud, resumen en lenguaje natural y 3 prioridades. */
export function InformeEmpresa({ r, completo = true }) {
  const m = r.metricas;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div className="tarjeta" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 18, alignItems: 'center' }}>
        {r.salud ? <Anillo valor={r.salud.puntaje} nivel={r.salud.nivel} /> : <div className="chip">sin datos</div>}
        <div style={{ display: 'grid', gap: 8 }}>
          <b style={{ fontSize: '1.05rem', lineHeight: 1.45 }}>{r.resumen}</b>
          {r.acciones.length > 0 && (
            <div style={{ display: 'grid', gap: 4 }}>
              <small className="tenue" style={{ textTransform: 'uppercase', letterSpacing: '.06em' }}>Tres prioridades</small>
              {r.acciones.map((a, i) => <small key={i}><b>{i + 1}.</b> {a.titulo} — {a.accion}</small>)}
            </div>
          )}
        </div>
      </div>
      {completo && r.salud && (
        <div className="rejilla cols-4">
          <div className="kpi"><div className="etq">Ventas netas</div><div className="val">{lempiras(m.ventas_netas)}</div><div className="sub">{m.variacion_ventas_pct == null ? '' : `${m.variacion_ventas_pct >= 0 ? '+' : ''}${m.variacion_ventas_pct}% vs periodo anterior`}</div></div>
          <div className="kpi"><div className="etq">Margen bruto</div><div className="val">{m.margen_bruto_pct == null ? '—' : `${m.margen_bruto_pct}%`}</div><div className="sub">Ticket {lempiras(m.ticket_promedio)}</div></div>
          <div className="kpi"><div className="etq">Gastos operativos</div><div className="val">{lempiras(m.gastos_operativos)}</div></div>
          <div className="kpi"><div className="etq">Utilidad operativa</div><div className="val" style={{ color: m.utilidad_operativa < 0 ? 'var(--peligro)' : undefined }}>{lempiras(m.utilidad_operativa)}</div><div className="sub">{m.margen_operativo_pct == null ? '' : `${m.margen_operativo_pct}% de las ventas`}</div></div>
        </div>
      )}
    </div>
  );
}
