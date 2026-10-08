import { useRef, useState } from 'react';
import { ACCEPT_DOC } from '@grupo/shared';
import Icono from '../ui/Icono.jsx';
import { problemaConArchivo } from './cliente.js';

/**
 * Zona para soltar archivos (escritorio) y botones grandes para elegir o tomar foto (celular y tablet).
 * onArchivos(File[]) recibe solo los que pasan la revisión; los demás salen en onError.
 */
export default function ZonaArchivos({ onArchivos, onError, multiple = false, ocupado = false, texto = 'Arrastra aquí el documento' }) {
  const [encima, setEncima] = useState(false);
  const elegir = useRef(null), camara = useRef(null);
  const recibir = (lista) => {
    const todos = [...(lista ?? [])];
    const buenos = [];
    for (const f of todos) { const p = problemaConArchivo(f); if (p) onError?.(p); else buenos.push(f); }
    if (buenos.length) onArchivos(multiple ? buenos : buenos.slice(0, 1));
  };
  return (
    <div className={`doc-zona ${encima ? 'encima' : ''} ${ocupado ? 'ocupada' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setEncima(true); }} onDragLeave={() => setEncima(false)}
      onDrop={(e) => { e.preventDefault(); setEncima(false); if (!ocupado) recibir(e.dataTransfer.files); }}>
      <Icono n="descargar" tam={28} />
      <b>{ocupado ? 'Subiendo…' : texto}</b>
      <small>PDF, imagen, Word o Excel · hasta 15 MB</small>
      <div className="fila" style={{ justifyContent: 'center' }}>
        <button type="button" className="btn primario" disabled={ocupado} onClick={() => elegir.current?.click()}>Elegir archivo</button>
        <button type="button" className="btn" disabled={ocupado} onClick={() => camara.current?.click()}>Tomar foto</button>
      </div>
      <input ref={elegir} type="file" hidden accept={ACCEPT_DOC} multiple={multiple} onChange={(e) => { recibir(e.target.files); e.target.value = ''; }} />
      <input ref={camara} type="file" hidden accept="image/*" capture="environment" onChange={(e) => { recibir(e.target.files); e.target.value = ''; }} />
    </div>
  );
}
