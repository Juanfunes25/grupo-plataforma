import { lempiras, horaHN } from '@grupo/shared';
import { get, qs } from '../api.js';
import { Modal, useDatos, Vacio } from '../ui/kit.jsx';

export default function AbiertasModal({ sucursalId, onElegir, onCerrar }) {
  const d = useDatos(() => get(`/pos/ventas${qs({ estado: 'abierta', sucursal_id: sucursalId })}`), [sucursalId]);
  return (
    <Modal titulo="Órdenes abiertas" onCerrar={onCerrar}>
      {d.cargando && !d.datos ? <Vacio>Cargando…</Vacio> : (d.datos ?? []).length === 0 ? <Vacio>No hay órdenes guardadas.</Vacio> : (
        <div style={{ display: 'grid', gap: 8 }}>
          {d.datos.map((v) => (
            <button key={v.id} className="btn" style={{ justifyContent: 'space-between', minHeight: 56 }} onClick={() => onElegir(v.id)}>
              <span><b>#{v.ticket_dia}</b> {v.nombre_orden || ''} <small>· {v.lineas} prod. · {horaHN(v.created_at)} · {v.cajero}</small></span>
              <b className="num">{lempiras(v.total)}</b>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
