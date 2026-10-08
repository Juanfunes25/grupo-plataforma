import { useEffect, useState } from 'react';
import { Modal } from '../ui/kit.jsx';
import { bajarBlob, descargar } from './cliente.js';

/** Vista previa de un PDF o imagen (se baja con la sesión y se muestra desde un Blob). Otros tipos: solo descarga. */
export default function Vista({ doc, version, empresa, onCerrar }) {
  const [url, setUrl] = useState(null);
  const [tipo, setTipo] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let u = null, vivo = true;
    bajarBlob(doc.id, { version, empresa }).then(({ blob, tipo: t }) => {
      if (!vivo) return;
      u = URL.createObjectURL(blob); setUrl(u); setTipo(t);
    }).catch((e) => vivo && setError(e.message));
    return () => { vivo = false; if (u) URL.revokeObjectURL(u); };
  }, [doc.id, version, empresa]);
  const esPdf = tipo === 'application/pdf';
  return (
    <Modal titulo={doc.titulo} onCerrar={onCerrar} tam="ancho"
      pie={<button className="btn" onClick={() => descargar(doc.id, doc.nombre_archivo, { version, empresa }).catch((e) => setError(e.message))}>Descargar</button>}>
      {error && <div className="aviso-caja mal">{error}</div>}
      {!url && !error && <div className="vacio">Abriendo…</div>}
      {url && esPdf && <iframe title={doc.titulo} src={url} className="doc-visor" />}
      {url && tipo?.startsWith('image/') && <img alt={doc.titulo} src={url} className="doc-imagen" />}
      {url && !esPdf && !tipo?.startsWith('image/') && <div className="aviso-caja">Este tipo de archivo no se puede mostrar aquí. Usa «Descargar».</div>}
    </Modal>
  );
}
