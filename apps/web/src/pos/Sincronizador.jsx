import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useAviso } from '../ui/kit.jsx';
import { sincronizarAhora, useResumenCola } from './colaLocal.js';
import './offline.css';

/**
 * Manda las ventas hechas sin conexión en cuanto vuelve la señal (y cada 20 s mientras haya algo pendiente), esté la persona en la
 * pantalla que esté. No pinta nada salvo una píldora pequeña cuando hay ventas por sincronizar y NO se está en el POS (ahí las muestra la caja).
 */
export default function Sincronizador() {
  const avisar = useAviso();
  const r = useResumenCola();
  const { pathname } = useLocation();
  const avisarRef = useRef(avisar); avisarRef.current = avisar;
  const yaRevisadas = useRef(0);

  useEffect(() => {
    let vivo = true;
    const intentar = async () => {
      if (!vivo || document.hidden || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
      try {
        const res = await sincronizarAhora();
        if (!vivo) return;
        if (res.enviadas.length) avisarRef.current(`${res.enviadas.length === 1 ? 'Se sincronizó 1 venta' : `Se sincronizaron ${res.enviadas.length} ventas`} hecha${res.enviadas.length === 1 ? '' : 's'} sin conexión.`);
        if (res.revisar > yaRevisadas.current) avisarRef.current(`${res.revisar} venta${res.revisar === 1 ? '' : 's'} sin conexión necesita${res.revisar === 1 ? '' : 'n'} revisión de un encargado (entra al POS).`, 'mal');
        yaRevisadas.current = res.revisar;
      } catch { /* sin red: se vuelve a intentar */ }
    };
    intentar();
    const id = setInterval(() => { if (r.pendientes > 0) intentar(); }, 20_000);
    window.addEventListener('online', intentar);
    document.addEventListener('visibilitychange', intentar);
    return () => { vivo = false; clearInterval(id); window.removeEventListener('online', intentar); document.removeEventListener('visibilitychange', intentar); };
  }, [r.pendientes > 0]);   // eslint-disable-line react-hooks/exhaustive-deps

  const enPos = /\/pos\/?$/.test(pathname);
  if (enPos || r.total === 0) return null;
  return (
    <div className={`cola-pildora${r.revisar ? ' mal' : ''}`} role="status">
      {r.sincronizando ? 'Sincronizando ventas…' : `${r.total} venta${r.total === 1 ? '' : 's'} por sincronizar${r.revisar ? ` · ${r.revisar} por revisar` : ''}`}
    </div>
  );
}
