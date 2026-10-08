import { useState } from 'react';
import { get } from '../api.js';
import { Campo, Modal, useAccion, useDatos, Estado } from '../ui/kit.jsx';
import { descargar, esVisible, fechaCorta, tamanoLegible } from './cliente.js';
import Vista from './Vista.jsx';

/** Pide el motivo (obligatorio) antes de archivar o borrar. */
export function MotivoModal({ titulo, aviso, boton, peligro = false, onConfirmar, onCerrar }) {
  const [motivo, setMotivo] = useState('');
  const [ejecutar, ocupado] = useAccion();
  return (
    <Modal titulo={titulo} onCerrar={onCerrar} tam="angosto"
      pie={<button className={`btn ${peligro ? 'peligro' : 'primario'}`} disabled={ocupado || motivo.trim().length < 3} onClick={async () => { if (await ejecutar(() => onConfirmar(motivo.trim()))) onCerrar(); }}>{boton}</button>}>
      {aviso && <div className="aviso-caja">{aviso}</div>}
      <Campo etiqueta="Motivo" ayuda="Queda registrado en la bitácora."><input value={motivo} onChange={(e) => setMotivo(e.target.value)} autoFocus placeholder="Ej.: se renovó con otro proveedor" maxLength={300} /></Campo>
    </Modal>
  );
}

/** Historial de versiones de un documento: cada una se puede ver o descargar. */
export function Versiones({ doc, empresa, onCerrar }) {
  const d = useDatos(() => get(`/documentos/${doc.id}/versiones`, { empresa }), [doc.id]);
  const [ver, setVer] = useState(null);
  const [ejecutar] = useAccion();
  return (
    <Modal titulo={`Versiones · ${doc.titulo}`} onCerrar={onCerrar}>
      <Estado d={d}>{(vs) => (
        <div className="tarjeta pad0">
          {vs.map((v, i) => (
            <div className="doc-fila" key={v.id}>
              <div>
                <b>Versión {v.numero}</b> {i === 0 && <span className="chip ok">actual</span>}
                <div><small>{v.nombre_archivo} · {tamanoLegible(v.tamano)} · {fechaCorta(String(v.created_at).slice(0, 10))}{v.subido_por_nombre ? ` · ${v.subido_por_nombre}` : ''}</small></div>
                {v.nota && <small className="tenue">{v.nota}</small>}
              </div>
              <div className="acciones">
                {v.purgada ? <span className="chip">eliminada</span> : <>
                  {esVisible(v.mime) && <button className="btn chico" onClick={() => setVer(v)}>Ver</button>}
                  <button className="btn chico" onClick={() => ejecutar(() => descargar(doc.id, v.nombre_archivo, { version: v.numero, empresa }))}>Descargar</button>
                </>}
              </div>
            </div>
          ))}
        </div>
      )}</Estado>
      {ver && <Vista doc={{ ...doc, titulo: `${doc.titulo} · v${ver.numero}`, nombre_archivo: ver.nombre_archivo }} version={ver.numero} empresa={empresa} onCerrar={() => setVer(null)} />}
    </Modal>
  );
}
