// Formulario modal genérico para el módulo de personal: describe los campos y listo.
//   campos: [{ k, etiqueta, tipo: 'text'|'date'|'number'|'select'|'textarea'|'check'|'foto'|'time', opciones: [[valor, texto]], ayuda, req, ancho }]
//           o { seccion: 'Título' } para separar bloques.
import { useState } from 'react';
import { Campo, Modal, useAccion, useAviso } from '../ui/kit.jsx';
import { fotoReducida } from './util.js';

export default function Form({ titulo, campos, inicial = {}, onGuardar, onCerrar, textoGuardar = 'Guardar', tam = '', extra = null, soloCambios = false }) {
  const [f, setF] = useState(inicial);
  const [ejecutar, ocupado] = useAccion();
  const avisar = useAviso();
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const lista = campos.filter((c) => c.seccion || !c.si || c.si(f));
  const faltan = lista.filter((c) => c.req && (f[c.k] === undefined || f[c.k] === null || String(f[c.k]).trim() === ''));
  const guardar = async () => {
    const datos = {};
    for (const c of lista) {
      if (c.seccion) continue;
      if (soloCambios && (f[c.k] ?? '') === (inicial[c.k] ?? '')) continue;
      let v = f[c.k];
      if (c.tipo === 'number') v = v === '' || v === undefined || v === null ? null : Number(v);
      else if (c.tipo === 'check') v = Boolean(v);
      else if (v === undefined) v = c.tipo === 'select' || c.tipo === 'date' ? null : (c.req ? '' : null);
      datos[c.k] = v;
    }
    const r = await ejecutar(() => onGuardar(datos, f));
    if (r) onCerrar();
  };
  return (
    <Modal titulo={titulo} onCerrar={onCerrar} tam={tam} pie={<button className="btn primario" disabled={ocupado || faltan.length > 0} onClick={guardar}>{textoGuardar}</button>}>
      <div className="rejilla cols-2">
        {lista.map((c, i) => {
          if (c.seccion) return <h3 key={`s${i}`} style={{ gridColumn: '1 / -1', margin: '8px 0 0' }}>{c.seccion}</h3>;
          const estilo = c.ancho ? { gridColumn: '1 / -1' } : undefined;
          const v = f[c.k] ?? '';
          let ctl;
          if (c.tipo === 'select') ctl = <select value={v} onChange={(e) => set(c.k, e.target.value)}><option value="">{c.vacio ?? '—'}</option>{c.opciones.map(([val, txt]) => <option key={val} value={val}>{txt}</option>)}</select>;
          else if (c.tipo === 'textarea') ctl = <textarea rows={3} value={v} onChange={(e) => set(c.k, e.target.value)} />;
          else if (c.tipo === 'check') return <label key={c.k} className="fila" style={estilo}><input type="checkbox" checked={Boolean(f[c.k])} onChange={(e) => set(c.k, e.target.checked)} /> {c.etiqueta}</label>;
          else if (c.tipo === 'foto') {
            return (
              <div key={c.k} style={{ gridColumn: '1 / -1' }} className="fila">
                {f[c.k] ? <img src={f[c.k]} alt="Foto" style={{ width: 72, height: 72, borderRadius: 12, objectFit: 'cover' }} /> : <span className="chip">sin foto</span>}
                <label className="btn chico">Elegir foto<input type="file" accept="image/*" hidden onChange={async (e) => { const a = e.target.files?.[0]; if (!a) return; try { set(c.k, await fotoReducida(a)); } catch (er) { avisar(er.message, 'mal'); } }} /></label>
                {f[c.k] && <button type="button" className="btn chico fantasma" onClick={() => set(c.k, null)}>Quitar</button>}
              </div>
            );
          } else ctl = <input type={c.tipo === 'number' ? 'text' : c.tipo ?? 'text'} inputMode={c.tipo === 'number' ? 'decimal' : undefined} value={v} onChange={(e) => set(c.k, e.target.value)} placeholder={c.placeholder} />;
          return <div key={c.k} style={estilo}><Campo etiqueta={`${c.etiqueta}${c.req ? ' *' : ''}`} ayuda={c.ayuda}>{ctl}</Campo></div>;
        })}
      </div>
      {extra}
    </Modal>
  );
}
