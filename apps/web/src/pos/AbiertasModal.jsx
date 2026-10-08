import { lempiras, horaHN } from '@grupo/shared';
import { get, qs } from '../api.js';
import { Modal, useDatos, Vacio } from '../ui/kit.jsx';
import { useCambiosVentas } from '../lib/enVivo.js';

/** Órdenes guardadas sin cobrar. Se actualiza sola si otra caja agrega, cobra o descarta una. */
export default function AbiertasModal({ sucursalId, actualId, onElegir, onCerrar }) {
  const d = useDatos(() => get(`/pos/ventas${qs({ estado: 'abierta', sucursal_id: sucursalId })}`), [sucursalId]);
  useCambiosVentas(sucursalId, d.recargar, { cada: 5000 });
  const lista = (d.datos ?? []).filter((v) => v.id !== actualId);
  return (
    <Modal titulo="Órdenes abiertas" onCerrar={onCerrar}>
      <small>Órdenes completas guardadas sin cobrar. Se actualizan solas cuando otra caja guarda o cobra una.</small>
      {d.error && <div className="aviso-caja mal">{d.error}</div>}
      {d.cargando && !d.datos ? <Vacio>Cargando…</Vacio> : lista.length === 0 ? <Vacio>No hay otras órdenes abiertas.</Vacio> : (
        <div style={{ display: 'grid', gap: 8 }}>
          {lista.map((v) => (
            <button key={v.id} className="btn" style={{ justifyContent: 'space-between', minHeight: 60, textAlign: 'left' }} onClick={() => onElegir(v.id)}>
              <span style={{ display: 'grid', gap: 2 }}>
                <b>Orden #{v.ticket_dia}{v.nombre_orden ? ` · ${v.nombre_orden}` : ''}</b>
                <small>{v.es_consumidor_final ? 'Consumidor Final' : v.cliente} · {v.lineas} prod. · {v.cajero ?? ''} · {horaHN(v.created_at)}</small>
              </span>
              <b className="num">{lempiras(v.total)}</b>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
