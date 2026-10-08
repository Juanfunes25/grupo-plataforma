import { useState } from 'react';
import { get, post, qs } from '../api.js';
import { Campo, Modal, useAccion, useDatos } from '../ui/kit.jsx';

/** Buscar o crear un cliente (directorio común del grupo). */
export default function ClienteModal({ onElegir, onCerrar, puedeCrear }) {
  const [q, setQ] = useState('');
  const [nuevo, setNuevo] = useState(null);
  const [ejecutar, ocupado] = useAccion();
  const d = useDatos(() => (q.trim().length >= 2 ? get(`/terceros${qs({ q: q.trim(), tipo: 'cliente', limite: 12 })}`) : Promise.resolve([])), [q]);

  const crear = async () => {
    const c = await ejecutar(() => post('/terceros', { nombre: nuevo.nombre, rtn: nuevo.rtn || null, telefono: nuevo.telefono || null, es_cliente: true }), 'Cliente creado');
    if (c && c !== true) onElegir(c);
  };

  return (
    <Modal titulo="Cliente" onCerrar={onCerrar}>
      <button className="btn bloque" onClick={() => onElegir(null)}>Consumidor final</button>
      {!nuevo ? (
        <>
          <Campo etiqueta="Buscar por nombre, RTN o teléfono"><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Escribe al menos 2 letras" /></Campo>
          <div style={{ display: 'grid', gap: 6 }}>
            {(d.datos ?? []).filter((c) => !c.es_consumidor_final).map((c) => (
              <button key={c.id} className="btn" style={{ justifyContent: 'space-between' }} onClick={() => onElegir(c)}>
                <span>{c.nombre}</span><small>{c.rtn || c.telefono || ''}</small>
              </button>
            ))}
            {q.trim().length >= 2 && !d.cargando && (d.datos ?? []).length === 0 && <small>Sin resultados.</small>}
          </div>
          {puedeCrear && <button className="btn fantasma" onClick={() => setNuevo({ nombre: q, rtn: '', telefono: '' })}>+ Cliente nuevo</button>}
        </>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          <Campo etiqueta="Nombre o razón social"><input value={nuevo.nombre} onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })} /></Campo>
          <Campo etiqueta="RTN (14 dígitos, para factura con datos)"><input inputMode="numeric" value={nuevo.rtn} onChange={(e) => setNuevo({ ...nuevo, rtn: e.target.value })} /></Campo>
          <Campo etiqueta="Teléfono"><input inputMode="tel" value={nuevo.telefono} onChange={(e) => setNuevo({ ...nuevo, telefono: e.target.value })} /></Campo>
          <div className="fila"><button className="btn primario" disabled={ocupado || nuevo.nombre.trim().length < 2} onClick={crear}>Guardar y usar</button><button className="btn fantasma" onClick={() => setNuevo(null)}>Cancelar</button></div>
        </div>
      )}
    </Modal>
  );
}
