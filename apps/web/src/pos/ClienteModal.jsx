import { useEffect, useState } from 'react';
import { rtnLuceValido, rtnValido, soloDigitos } from '@grupo/shared';
import { get, post, qs } from '../api.js';
import { Campo, Modal, useAccion, useAviso } from '../ui/kit.jsx';

/** Buscar un cliente (nombre, RTN, teléfono) o darlo de alta al momento. Directorio común del grupo. */
export default function ClienteModal({ onElegir, onCerrar, puedeCrear, actual }) {
  const avisar = useAviso();
  const [q, setQ] = useState('');
  const [lista, setLista] = useState([]);
  const [buscando, setBuscando] = useState(false);
  const [nuevo, setNuevo] = useState(null);
  const [ejecutar, ocupado] = useAccion();

  // Búsqueda con pausa de 300 ms para no consultar en cada tecla.
  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) { setLista([]); return undefined; }
    let vigente = true;
    setBuscando(true);
    const id = setTimeout(async () => {
      try { const r = await get(`/terceros${qs({ q: t, tipo: 'cliente', limite: 12 })}`); if (vigente) setLista(r.filter((c) => !c.es_consumidor_final)); } catch { /* */ }
      if (vigente) setBuscando(false);
    }, 300);
    return () => { vigente = false; clearTimeout(id); };
  }, [q]);

  const rtn = nuevo?.rtn ?? '';
  const rtnMal = rtn && !rtnValido(rtn);
  const crear = async () => {
    const cuerpo = { nombre: nuevo.nombre.trim(), rtn: soloDigitos(rtn) || null, telefono: nuevo.telefono.trim() || null, correo: nuevo.correo.trim() || null, exento_impuestos: nuevo.exento, es_cliente: true };
    try {
      const c = await post('/terceros', cuerpo);
      avisar('Cliente creado'); onElegir(c);
    } catch (e) {
      // El RTN es único en todo el grupo: si ya existe esa ficha, se usa en vez de pelear con el cajero.
      if (cuerpo.rtn && e.status === 409) {
        const ya = (await get(`/terceros${qs({ q: cuerpo.rtn, tipo: 'cliente', limite: 1 })}`).catch(() => []))[0];
        if (ya) { avisar(`Ese RTN ya existía: se usó la ficha de ${ya.nombre}`); onElegir(ya); return; }
      }
      avisar(e.message, 'mal');
    }
  };

  return (
    <Modal titulo="Cliente" onCerrar={onCerrar} pie={nuevo && <>
      <button className="btn fantasma" onClick={() => setNuevo(null)}>Cancelar</button>
      <button className="btn primario grande" disabled={ocupado || nuevo.nombre.trim().length < 2 || rtnMal} onClick={() => ejecutar(crear)}>Guardar y usar</button>
    </>}>
      {!nuevo ? (
        <>
          <button className="btn grande bloque" aria-pressed={!actual} onClick={() => onElegir(null)}>Consumidor final</button>
          <Campo etiqueta="Buscar por nombre, RTN o teléfono">
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Escribe al menos 2 letras o dígitos" inputMode="search" />
          </Campo>
          <div style={{ display: 'grid', gap: 6 }}>
            {lista.map((c) => (
              <button key={c.id} className="btn" style={{ justifyContent: 'space-between', minHeight: 54, textAlign: 'left' }} onClick={() => onElegir(c)}>
                <span>{c.nombre}{c.exento_impuestos && <span className="chip aviso" style={{ marginLeft: 8 }}>Exento</span>}</span>
                <small>{c.rtn || c.telefono || 'sin RTN'}</small>
              </button>
            ))}
            {q.trim().length >= 2 && !buscando && lista.length === 0 && <small>Sin resultados.</small>}
          </div>
          {puedeCrear && <button className="btn" onClick={() => setNuevo({ nombre: /\d/.test(q) ? '' : q, rtn: /^[\d\s-]+$/.test(q) ? q : '', telefono: '', correo: '', exento: false })}>+ Cliente nuevo</button>}
        </>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          <Campo etiqueta="Nombre o razón social"><input autoFocus value={nuevo.nombre} onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })} /></Campo>
          <Campo etiqueta="RTN (opcional salvo ventas grandes)" ayuda={rtnMal ? (rtnLuceValido(rtn) ? 'El RTN lleva 14 dígitos exactos. Revisa que no falte uno.' : 'Solo números: el RTN lleva 14 dígitos.') : undefined}>
            <input inputMode="numeric" value={nuevo.rtn} onChange={(e) => setNuevo({ ...nuevo, rtn: e.target.value })} placeholder="0801-1990-123456" style={rtnMal ? { borderColor: 'var(--aviso)' } : undefined} />
          </Campo>
          <div className="rejilla cols-2">
            <Campo etiqueta="Teléfono"><input inputMode="tel" value={nuevo.telefono} onChange={(e) => setNuevo({ ...nuevo, telefono: e.target.value })} /></Campo>
            <Campo etiqueta="Correo"><input inputMode="email" value={nuevo.correo} onChange={(e) => setNuevo({ ...nuevo, correo: e.target.value })} /></Campo>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '.95rem', color: 'var(--texto)' }}>
            <input type="checkbox" checked={nuevo.exento} onChange={(e) => setNuevo({ ...nuevo, exento: e.target.checked })} /> Exento de impuestos (embajadas, ONG, instituciones exoneradas)
          </label>
        </div>
      )}
    </Modal>
  );
}
