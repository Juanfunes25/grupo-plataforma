import { useEffect, useState } from 'react';

/** Código QR de un texto (otpauth://…). La librería se carga solo cuando se necesita. */
export default function Qr({ texto, etiqueta = 'Código QR para tu aplicación de autenticación' }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let vivo = true;
    import('qrcode').then((m) => (m.default ?? m).toDataURL(texto, { margin: 1, width: 200, errorCorrectionLevel: 'M' })).then((u) => vivo && setSrc(u)).catch(() => {});
    return () => { vivo = false; };
  }, [texto]);
  return <div className="qr-caja">{src ? <img src={src} alt={etiqueta} /> : <small>Generando…</small>}</div>;
}
