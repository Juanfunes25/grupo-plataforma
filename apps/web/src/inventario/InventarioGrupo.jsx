// Inventario del grupo (Dirección): lo mismo de cada empresa, lado a lado, con alertas y traslados en curso.
import { useState } from 'react';
import { lempiras, numero } from '@grupo/shared';
import { get, qs } from '../api.js';
import { Estado, Kpi, useDatos } from '../ui/kit.jsx';
import { ListaAlertas } from './InventarioUnificado.jsx';
import './inv-unificado.css';

export default function InventarioGrupo() {
  const [dias, setDias] = useState(7);
  const d = useDatos(() => get(`/inv/u/grupo${qs({ dias })}`), [dias]);
  return (
    <Estado d={d}>{(g) => (
      <div style={{ display: 'grid', gap: 14 }}>
        <div className="rejilla cols-4">
          <Kpi acento etiqueta="Valor del inventario del grupo" valor={g.total.valor == null ? '—' : lempiras(g.total.valor)} />
          <Kpi etiqueta="Bajo mínimo" valor={g.total.bajo_minimo} /><Kpi etiqueta="Existencia negativa" valor={g.total.negativos} />
          <Kpi etiqueta={`Vencen en ${dias} días`} valor={g.total.por_vencer} sub={`${g.total.traslados_en_transito} traslado(s) en tránsito`} />
        </div>
        <div className="iu-filtros"><label>Vencimientos en los próximos <select value={dias} onChange={(e) => setDias(Number(e.target.value))}>{[3, 7, 15, 30].map((n) => <option key={n} value={n}>{n} días</option>)}</select></label></div>
        <div className="iu-tarjetas">{g.empresas.map((e) => (
          <div key={e.codigo} className="tarjeta iu-grupo-emp" style={{ '--c': e.color }}>
            <h3>{e.nombre}</h3><small>{e.fuentes.join(' · ')}</small>
            <table><tbody>
              <tr><td>Ítems</td><td className="der num">{numero(e.resumen.items)}</td></tr>
              <tr><td>Valor</td><td className="der num">{e.costos ? lempiras(e.resumen.valor) : '—'}{e.resumen.sin_costo ? <small> ({e.resumen.sin_costo} sin costo)</small> : null}</td></tr>
              <tr><td>Bajo mínimo / agotados</td><td className="der num">{e.resumen.bajo_minimo} / {e.resumen.agotados}</td></tr>
              <tr><td>Negativos</td><td className="der num">{e.resumen.negativos}</td></tr>
              <tr><td>Por vencer</td><td className="der num">{e.resumen.por_vencer}</td></tr>
              <tr><td>Conteos pendientes</td><td className="der num">{e.conteos_pendientes.length}</td></tr>
            </tbody></table>
          </div>))}</div>
        {g.empresas.map((e) => (e.resumen.bajo_minimo || e.resumen.negativos || e.vencimientos.length) ? (
          <details key={e.codigo} className="tarjeta"><summary><b>{e.nombre}</b> · qué atender</summary><ListaAlertas a={{ ...e, resumen: e.resumen }} compacta /></details>) : null)}
        {g.traslados.length > 0 && <div className="tarjeta"><h3>Traslados recientes</h3><div className="tabla-wrap"><table>
          <thead><tr><th>Documento</th><th>De → A</th><th>Estado</th><th className="der">Valor</th></tr></thead>
          <tbody>{g.traslados.map((t) => <tr key={t.id}><td className="num">{t.numero_doc}</td><td>{t.origen} → {t.destino}{t.entre_empresas ? ' (entre empresas)' : ''}</td><td>{t.estado === 'en_transito' ? 'En tránsito' : t.estado === 'recibido' ? 'Recibido' : 'Anulado'}</td><td className="der num">{t.valor_total == null ? '—' : lempiras(t.valor_total)}</td></tr>)}</tbody></table></div></div>}
      </div>
    )}</Estado>
  );
}
