import { useState } from 'react';
import { get, put, qs } from '../api.js';
import { Campo, Estado, Modal, useAccion, useAviso, useDatos } from '../ui/kit.jsx';
import { ESTADOS, ETIQUETA_TIPO, fechaHora } from './etiquetas.js';
import { refrescarPendientes } from './pendientes.js';

function Alerta({ a, onEstado }) {
  const [abierta, setAbierta] = useState(false);
  const detalle = Object.entries(a.detalle ?? {}).filter(([, v]) => v !== null && v !== '' && typeof v !== 'object');
  const cerrada = a.estado === 'resuelta' || a.estado === 'falso_positivo';
  return (
    <div className={`af-alerta ${a.severidad}${cerrada ? ' cerrada' : ''}`}>
      <div className="af-alerta-fila" onClick={() => setAbierta(!abierta)}>
        <span className={`af-sev ${a.severidad}`}>{a.severidad}</span>
        <div className="af-alerta-texto">
          <strong>{a.titulo}</strong>
          <span>{ETIQUETA_TIPO[a.tipo] ?? a.tipo} · {a.sucursal || 'General'} · {a.usuario_nombre ?? 'Sistema'} · {fechaHora(a.created_at)}</span>
        </div>
        <select value={a.estado} aria-label="Estado de la alerta" onClick={(e) => e.stopPropagation()} onChange={(e) => onEstado(a, e.target.value)}>
          {Object.entries(ESTADOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      {abierta && (
        <div className="af-alerta-detalle">
          {detalle.map(([k, v]) => <div key={k}><span>{k.replace(/_/g, ' ')}</span><strong>{String(v)}</strong></div>)}
          {a.nota_revision && <div><span>nota de seguimiento</span><strong>{a.nota_revision}</strong></div>}
          {a.revisor && <div><span>última revisión</span><strong>{a.revisor}{a.revisada_at ? ` · ${fechaHora(a.revisada_at)}` : ''}</strong></div>}
        </div>
      )}
    </div>
  );
}

function ModalEstado({ cambio, onCerrar, onListo }) {
  const [nota, setNota] = useState('');
  const [ejecutar, ocupado] = useAccion();
  const { alerta, estado } = cambio;
  const guardar = async () => {
    if (await ejecutar(() => put(`/antifraude/alertas/${alerta.id}/estado`, { estado, nota: nota || null }), `Alerta marcada como ${ESTADOS[estado].toLowerCase()}`)) onListo();
  };
  return (
    <Modal titulo={ESTADOS[estado]} onCerrar={onCerrar} tam="angosto" pie={<button className="btn primario" disabled={ocupado} onClick={guardar}>Guardar</button>}>
      <p style={{ margin: 0 }}>{alerta.titulo}</p>
      <Campo etiqueta="¿Qué encontraste o qué se hizo? (opcional)"><textarea rows={3} maxLength={500} value={nota} onChange={(e) => setNota(e.target.value)} autoFocus /></Campo>
    </Modal>
  );
}

// Patrones del periodo (descuentos, anulaciones, reimpresiones, saltos de numeración, descuadres): se calculan al vuelo.
function Patrones({ desde, hasta }) {
  const d = useDatos(() => get(`/antifraude/analisis${qs({ desde, hasta })}`), [desde, hasta]);
  return (
    <div className="tarjeta" style={{ display: 'grid', gap: 10 }}>
      <h3>Patrones del periodo</h3>
      <small>Calculados sobre las ventas de {desde} a {hasta}: descuentos y anulaciones por cajero, reimpresiones, saltos de numeración y descuadres. Señalan dónde mirar; no acusan a nadie.</small>
      <Estado d={d}>{(a) => !a ? null : a.alertas.length === 0
        ? <div className="aviso-caja ok">Sin patrones raros en este periodo.</div>
        : <div style={{ display: 'grid', gap: 8 }}>{a.alertas.map((x, i) => (
          <div key={i} className={`af-alerta ${x.severidad}`}><div className="af-alerta-fila" style={{ cursor: 'default' }}>
            <span className={`af-sev ${x.severidad}`}>{x.severidad}</span>
            <div className="af-alerta-texto"><strong>{x.titulo}</strong><span>{x.detalle}</span></div>
          </div></div>))}</div>}
      </Estado>
    </div>
  );
}

export default function PanelAlertas({ sucursalId, desde, hasta, version }) {
  const [filtro, setFiltro] = useState('abiertas');
  const [cambio, setCambio] = useState(null);
  const avisar = useAviso();
  const params = filtro === 'abiertas' ? { solo_pendientes: 1 } : filtro === 'todas' ? {} : { estado: filtro };
  const lista = useDatos(() => get(`/antifraude/alertas${qs({ ...params, sucursal_id: sucursalId })}`), [filtro, sucursalId, version]);

  const pedir = (alerta, estado) => {
    if (estado === alerta.estado) return;
    if (estado === 'investigando') {            // no pide nota: solo marca que alguien lo está viendo
      put(`/antifraude/alertas/${alerta.id}/estado`, { estado }).then(() => { lista.recargar(); refrescarPendientes(); }).catch((e) => avisar(e.message, 'mal'));
    } else setCambio({ alerta, estado });
  };

  return (
    <>
      <div className="tarjeta" style={{ display: 'grid', gap: 10 }}>
        <div className="fila espacio">
          <h3>Alertas</h3>
          <select value={filtro} onChange={(e) => setFiltro(e.target.value)} aria-label="Filtrar por estado">
            <option value="abiertas">Abiertas (pendientes e investigando)</option>
            <option value="pendiente">Pendientes</option>
            <option value="investigando">Investigando</option>
            <option value="resuelta">Resueltas</option>
            <option value="falso_positivo">Falsos positivos</option>
            <option value="todas">Todas</option>
          </select>
        </div>
        <Estado d={lista}>{(rows) => rows.length === 0 ? <div className="vacio">Sin alertas en esta vista.</div> : rows.map((a) => <Alerta key={a.id} a={a} onEstado={pedir} />)}</Estado>
      </div>
      <Patrones desde={desde} hasta={hasta} />
      {cambio && <ModalEstado cambio={cambio} onCerrar={() => setCambio(null)} onListo={() => { setCambio(null); lista.recargar(); refrescarPendientes(); }} />}
    </>
  );
}
