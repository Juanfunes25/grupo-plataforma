import { lempiras } from '@grupo/shared';
import { get, qs } from '../api.js';
import { Estado, useDatos } from '../ui/kit.jsx';
import { ETIQUETA_EVENTO, fechaHora, resumenEvento } from './etiquetas.js';

function Mini({ semanas }) {
  const max = Math.max(1, ...semanas);
  return <span className="af-mini" title={`Últimas 4 semanas: ${semanas.join(' · ')}`}>{semanas.map((v, i) => <i key={i} style={{ height: `${Math.max(8, (v / max) * 100)}%`, opacity: v ? 1 : 0.25 }} />)}</span>;
}

export default function PanelCajeros({ desde, hasta, sucursalId, version }) {
  const d = useDatos(() => get(`/antifraude/indicadores${qs({ desde, hasta, sucursal_id: sucursalId })}`), [desde, hasta, sucursalId, version]);
  const t = useDatos(() => get('/antifraude/tendencia'), [version]);
  const tend = new Map((t.datos ?? []).map((x) => [x.usuario_id, x]));
  return (
    <Estado d={d}>{(datos) => !datos ? null : (
      <>
        <div className="tarjeta pad0">
          <div style={{ padding: '14px 16px 4px' }}>
            <h3>Señales por cajero</h3>
            <small>Cada cajero se compara con el promedio del grupo en el periodo. La mini-gráfica son sus alertas de las últimas 4 semanas. Una señal no prueba un robo: indica dónde mirar primero.</small>
          </div>
          <div className="tabla-wrap"><table>
            <thead><tr><th>Cajero</th><th>4 sem.</th><th className="der">Facturas</th><th className="der">Vendido</th><th className="der">% efect.</th><th className="der">% c/desc.</th><th className="der">3ª edad</th>
              <th className="der">Anuladas</th><th className="der">Descartadas</th><th className="der">Quitados</th><th className="der">Reimpr.</th><th className="der">Faltantes</th><th className="der">Sin permiso</th><th>Señales</th></tr></thead>
            <tbody>
              {datos.cajeros.length === 0 && <tr><td colSpan={14} className="centro tenue">Sin actividad en el rango.</td></tr>}
              {datos.cajeros.map((c) => (
                <tr key={c.cajero_id} className={c.riesgo >= 5 ? 'af-fila-alta' : c.riesgo >= 2 ? 'af-fila-media' : ''}>
                  <td><strong>{c.nombre}</strong></td>
                  <td>{tend.get(c.cajero_id) ? <Mini semanas={tend.get(c.cajero_id).semanas} /> : <span className="tenue">—</span>}</td>
                  <td className="der num">{c.facturas}</td><td className="der num">{lempiras(c.total)}</td><td className="der num">{c.pct_efectivo}%</td><td className="der num">{c.pct_descuento}%</td>
                  <td className="der num">{c.desc_25}</td><td className="der num">{c.anuladas}</td>
                  <td className="der num" title={lempiras(c.monto_descartado)}>{c.descartadas}</td><td className="der num" title={lempiras(c.monto_quitado)}>{c.quitados}</td>
                  <td className="der num">{c.reimpresiones}</td><td className="der num" title={lempiras(c.monto_faltante)}>{c.faltantes}</td><td className="der num">{c.accesos_denegados}</td>
                  <td><div className="af-senales">{c.senales.length === 0 && <span className="tenue">Sin señales</span>}{c.senales.map((s) => <span key={s.texto} className={`af-senal ${s.nivel}`}>{s.texto}</span>)}</div></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
        <div className="rejilla cols-2">
          <div className="tarjeta pad0">
            <div style={{ padding: '14px 16px 4px' }}><h3>Huecos sin facturar</h3><small>Ratos largos sin una sola factura con la tienda abierta. Si hubo clientes en cámara, hubo ventas sin facturar.</small></div>
            <div className="tabla-wrap"><table>
              <thead><tr><th>Sucursal</th><th>Día</th><th>Entre</th><th className="der">Minutos</th></tr></thead>
              <tbody>
                {datos.huecos.length === 0 && <tr><td colSpan={4} className="centro tenue">Sin huecos largos.</td></tr>}
                {datos.huecos.map((h, i) => <tr key={i}><td>{h.sucursal}</td><td>{h.fecha}</td><td>{h.desde} – {h.hasta}</td><td className="der num"><strong style={h.minutos >= 90 ? { color: 'var(--peligro)' } : undefined}>{h.minutos}</strong></td></tr>)}
              </tbody>
            </table></div>
          </div>
          <div className="tarjeta" style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
            <h3>Movimientos sensibles recientes</h3>
            <div className="af-feed">
              {datos.recientes.length === 0 && <div className="vacio">Nada que reportar.</div>}
              {datos.recientes.map((e) => (
                <div key={e.id} className="af-evento"><span>{fechaHora(e.created_at)}</span>
                  <span><strong>{e.usuario_nombre}</strong> · {ETIQUETA_EVENTO[e.accion] ?? e.accion}<br /><small>{resumenEvento(e)}</small></span></div>
              ))}
            </div>
          </div>
        </div>
      </>
    )}</Estado>
  );
}
