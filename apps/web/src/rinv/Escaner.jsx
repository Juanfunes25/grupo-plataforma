import { useEffect, useRef, useState } from 'react';
import { Modal } from '../ui/kit.jsx';

const FORMATOS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar'];
const MS_ANTES_DE_REPETIR = 2500;

/**
 * Lee un código de barras de tres maneras, de la más cómoda a la de respaldo:
 *  1. cámara trasera (API nativa BarcodeDetector, donde el navegador la traiga);
 *  2. foto del código (más fácil de enfocar que el video en vivo);
 *  3. escribirlo, o apuntar con un lector de barras USB/Bluetooth (escribe el código y un Enter).
 * En modo `continuo` no se cierra al leer: se va cargando uno tras otro (sacar de bodega).
 */
export default function Escaner({ onDetectado, onCerrar, continuo = false, leidos = 0 }) {
  const video = useRef(null);
  const vistos = useRef(new Map());
  const [error, setError] = useState('');
  const [manual, setManual] = useState('');
  const [ultimo, setUltimo] = useState('');
  const soportado = typeof window !== 'undefined' && 'BarcodeDetector' in window;

  function detectado(codigo) {
    const t = Date.now();
    if (continuo && t - (vistos.current.get(codigo) || 0) < MS_ANTES_DE_REPETIR) return;
    vistos.current.set(codigo, t);
    try { navigator.vibrate?.(15); } catch { /* no todos lo permiten */ }
    setUltimo(codigo);
    onDetectado(codigo);
  }

  useEffect(() => {
    if (!soportado || !navigator.mediaDevices?.getUserMedia) return undefined;
    let parar = false; let flujo = null; let timer = null;
    (async () => {
      try {
        flujo = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
        if (parar) { flujo.getTracks().forEach((x) => x.stop()); return; }
        video.current.srcObject = flujo; await video.current.play();
        const det = new window.BarcodeDetector({ formats: FORMATOS });
        const ciclo = async () => {
          if (parar) return;
          try { const r = await det.detect(video.current); if (r[0]?.rawValue) { detectado(r[0].rawValue); if (!continuo) return; } } catch { /* un cuadro malo */ }
          timer = setTimeout(ciclo, 200);
        };
        ciclo();
      } catch { setError('No se pudo abrir la cámara. Toma una foto del código o escríbelo.'); }
    })();
    return () => { parar = true; clearTimeout(timer); flujo?.getTracks().forEach((x) => x.stop()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function deFoto(e) {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    try {
      const det = new window.BarcodeDetector({ formats: FORMATOS });
      const img = await createImageBitmap(f);
      const r = await det.detect(img);
      if (r[0]?.rawValue) detectado(r[0].rawValue); else setError('No se encontró un código en la foto. Acércate más y que se vea nítido.');
    } catch { setError('No se pudo leer la foto.'); }
  }

  return (
    <Modal titulo={continuo ? `Escaneando… ${leidos} en la lista` : 'Escanear código de barras'} onCerrar={onCerrar} pie={<button className="btn primario" onClick={onCerrar}>{continuo ? 'Listo' : 'Cerrar'}</button>}>
      {soportado ? <video ref={video} playsInline muted style={{ width: '100%', borderRadius: 14, background: '#000', maxHeight: '45vh', objectFit: 'cover' }} /> : <div className="aviso-caja">Este navegador no lee códigos con la cámara. Usa un lector de barras o escribe el código.</div>}
      {error && <div className="aviso-caja mal">{error}</div>}
      {ultimo && <div className="aviso-caja ok">Último leído: <b>{ultimo}</b></div>}
      <form className="fila" onSubmit={(e) => { e.preventDefault(); const c = manual.trim(); if (c) { detectado(c); setManual(''); } }}>
        <input autoFocus value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Escribe el código o usa el lector de barras" inputMode="text" style={{ flex: 1 }} />
        <button className="btn" type="submit">Usar</button>
      </form>
      {soportado && <label className="btn bloque">📷 Tomar foto del código<input type="file" accept="image/*" capture="environment" hidden onChange={deFoto} /></label>}
    </Modal>
  );
}
