import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import Icono from './Icono.jsx';
import { aplicarVersionNueva, useEstadoApp } from '../lib/instalar.js';

const INACTIVO_MS = 15 * 60 * 1000;

/**
 * «Hay una versión nueva»: discreto, abajo, con botón. Se actualiza sola solo cuando no estorba:
 * en la entrada y el acceso, o tras 15 minutos sin tocar la pantalla (nunca en medio de una venta en la caja).
 */
export default function AvisoVersion() {
  const { hayNueva } = useEstadoApp();
  const { pathname } = useLocation();
  const [oculto, setOculto] = useState(false);
  const enSinTrabajo = pathname === '/' || pathname.startsWith('/acceso/');
  const enCaja = /\/pos(\/|$)/.test(pathname);

  useEffect(() => { if (hayNueva && enSinTrabajo) { const t = setTimeout(aplicarVersionNueva, 600); return () => clearTimeout(t); } return undefined; }, [hayNueva, enSinTrabajo]);
  useEffect(() => {
    if (!hayNueva || enCaja) return undefined;
    let t; const armar = () => { clearTimeout(t); t = setTimeout(aplicarVersionNueva, INACTIVO_MS); };
    const ev = ['pointerdown', 'keydown', 'touchstart'];
    ev.forEach((e) => window.addEventListener(e, armar, { passive: true })); armar();
    return () => { clearTimeout(t); ev.forEach((e) => window.removeEventListener(e, armar)); };
  }, [hayNueva, enCaja]);

  if (!hayNueva || enSinTrabajo || oculto) return null;
  return (
    <div className="aviso-version no-print" role="status">
      <Icono n="descargar" tam={18} /><span>Hay una versión nueva</span>
      <button className="btn primario" onClick={aplicarVersionNueva}>Actualizar</button>
      <button className="x" onClick={() => setOculto(true)} aria-label="Avisarme después"><Icono n="x" tam={16} /></button>
    </div>
  );
}
