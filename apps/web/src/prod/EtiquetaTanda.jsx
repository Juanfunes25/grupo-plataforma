import { useEffect, useState } from 'react';
import { post } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { generarPngEtiqueta, nombreArchivo, LADO_PX, DPI } from './etiqueta.js';

/** Etiqueta 2×2" de una tanda lista para Munbyn Print: la vista previa ES la imagen que se imprime. */
export default function EtiquetaTanda({ tanda, onCerrar }) {
  const { empresa } = useSesion();
  const [png, setPng] = useState(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let vivo = true, creada = '';
    generarPngEtiqueta(tanda, empresa).then((b) => { if (!vivo || !b) return; creada = URL.createObjectURL(b); setPng(b); setUrl(creada); })
      .catch(() => vivo && setError('No se pudo generar la etiqueta'));
    post(`/prod/tandas/${tanda.id}/etiqueta`).catch(() => {});      // queda en la bitácora
    return () => { vivo = false; if (creada) URL.revokeObjectURL(creada); };
  }, [tanda, empresa]);

  const archivo = png ? new File([png], nombreArchivo(tanda), { type: 'image/png' }) : null;
  const compartible = archivo && navigator.canShare?.({ files: [archivo] });
  const compartir = async () => { try { await navigator.share({ files: [archivo], title: `Etiqueta ${tanda.lote}` }); } catch (e) { if (e?.name !== 'AbortError') setError('No se pudo compartir la etiqueta'); } };
  // Se abre en pestaña nueva (no se descarga directo): en modo app instalada Android bloquea sin avisar las descargas de blobs.
  const abrir = () => { if (!window.open(url, '_blank')) { const a = Object.assign(document.createElement('a'), { href: url, download: nombreArchivo(tanda) }); a.click(); } };

  if (error) return <div className="aviso-caja mal">{error}</div>;
  return (
    <div className="tarjeta" style={{ marginTop: 8 }}>
      <div className="pg-fila" style={{ border: 0, padding: 0 }}><b>Etiqueta 2×2"</b>{onCerrar && <button className="btn chico fantasma" onClick={onCerrar}>Cerrar</button>}</div>
      {url ? <img className="pg-etq" src={url} width={LADO_PX} height={LADO_PX} alt={`Etiqueta de la tanda ${tanda.lote}`} /> : <div className="vacio">Generando…</div>}
      {compartible && <button className="btn primario bloque" onClick={compartir}>Enviar a Munbyn Print</button>}
      <button className={`btn bloque ${compartible ? '' : 'primario'}`} style={{ marginTop: compartible ? 8 : 0 }} onClick={abrir} disabled={!png}>Abrir para guardar</button>
      <small className="pg-sub" style={{ marginTop: 8 }}>
        {compartible ? 'Con «Enviar a Munbyn Print» se abre el menú de compartir. Si Munbyn no aparece, usa «Abrir para guardar» y en la app Munbyn Print: Archivo → Importar.'
          : 'Toca «Abrir para guardar», mantén el dedo sobre la imagen y elige «Descargar imagen». Después, en Munbyn Print: Archivo → Importar.'}
      </small>
      <small className="pg-sub">Generada a {LADO_PX}×{LADO_PX} px (2×2" a {DPI} dpi) para que la impresora no la estire. El QR abre de dónde salió la tanda.</small>
    </div>
  );
}
