import { useMemo, useState } from 'react';
import { lempiras } from '@grupo/shared';
import { Modal } from '../ui/kit.jsx';

/** Elegir tamaño / extras de un producto. Respeta mínimos y máximos de cada grupo. */
export default function OpcionesModal({ producto, grupos, inicial, onListo, onCerrar }) {
  const [sel, setSel] = useState(() => new Set((inicial?.opciones ?? []).map((o) => o.id)));
  const [notas, setNotas] = useState(inicial?.notas ?? '');
  const [cantidad, setCantidad] = useState(inicial?.cantidad ?? 1);

  const toggle = (g, m) => setSel((prev) => {
    const n = new Set(prev);
    const delGrupo = g.modificadores.filter((x) => n.has(x.id));
    if (n.has(m.id)) n.delete(m.id);
    else if (g.max_sel === 1) { delGrupo.forEach((x) => n.delete(x.id)); n.add(m.id); }
    else if (delGrupo.length < g.max_sel) n.add(m.id);
    return n;
  });

  const faltan = useMemo(() => grupos.filter((g) => g.modificadores.filter((m) => sel.has(m.id)).length < g.min_sel), [grupos, sel]);
  const elegidas = grupos.flatMap((g) => g.modificadores.filter((m) => sel.has(m.id)).map((m) => ({ id: m.id, grupo: g.nombre, nombre: m.nombre, precio_extra: Number(m.precio_extra) })));
  const extras = elegidas.reduce((s, o) => s + o.precio_extra, 0);

  return (
    <Modal titulo={producto.nombre} onCerrar={onCerrar}
      pie={<>
        <div className="fila" style={{ marginRight: 'auto' }}>
          <button className="btn" onClick={() => setCantidad((c) => Math.max(1, c - 1))} aria-label="Menos">−</button>
          <b className="num" style={{ minWidth: 28, textAlign: 'center' }}>{cantidad}</b>
          <button className="btn" onClick={() => setCantidad((c) => c + 1)} aria-label="Más">+</button>
        </div>
        <button className="btn primario grande" disabled={faltan.length > 0} onClick={() => onListo({ opciones: elegidas, notas: notas.trim() || null, cantidad })}>
          {faltan.length ? `Falta: ${faltan[0].nombre}` : `Agregar · ${lempiras((Number(producto.precio) + extras) * cantidad)}`}
        </button>
      </>}>
      {grupos.map((g) => (
        <section key={g.id} style={{ display: 'grid', gap: 8 }}>
          <div className="fila espacio"><h3>{g.nombre}</h3><small>{g.min_sel > 0 ? 'Obligatorio' : 'Opcional'}{g.max_sel > 1 ? ` · hasta ${g.max_sel}` : ''}</small></div>
          <div className="fila">
            {g.modificadores.map((m) => {
              const on = sel.has(m.id);
              return (
                <button key={m.id} className="btn" aria-pressed={on} onClick={() => toggle(g, m)}
                  style={on ? { background: 'var(--acento)', borderColor: 'transparent', color: '#fff' } : undefined}>
                  {m.nombre}{Number(m.precio_extra) > 0 && <small style={{ color: on ? '#fff' : undefined }}> +{lempiras(m.precio_extra)}</small>}
                </button>
              );
            })}
          </div>
        </section>
      ))}
      <label>Nota para cocina<input value={notas} maxLength={200} onChange={(e) => setNotas(e.target.value)} placeholder="Sin hielo, poco dulce…" /></label>
    </Modal>
  );
}
