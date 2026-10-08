import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get } from '../api.js';
import { refrescarPendientes } from './pendientes.js';
import './antifraude.css';

// Aviso inmediato al administrador cuando entra una alerta nueva: tarjeta emergente, sonido corto
// y notificación del navegador (aunque la pestaña esté en segundo plano).
function sonar(severidad) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const tonos = severidad === 'alta' ? [880, 660, 880] : [740];
    tonos.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.16);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.18);
      o.stop(ctx.currentTime + i * 0.18 + 0.17);
    });
  } catch { /* sin audio disponible */ }
}

export default function NotificacionesAlertas({ base }) {
  const [avisos, setAvisos] = useState([]);
  const ultimoId = useRef(null);
  const nav = useNavigate();

  useEffect(() => {
    ultimoId.current = null;
    try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {}); } catch { /* */ }
    let activo = true;
    async function revisar() {
      try {
        const nuevas = await get(`/antifraude/alertas/nuevas?desde_id=${ultimoId.current ?? 0}`);
        if (!activo || nuevas.length === 0) return;
        const maxId = Math.max(...nuevas.map((a) => a.id));
        const primera = ultimoId.current === null;       // la primera consulta solo fija el punto de partida
        ultimoId.current = maxId;
        if (primera) return;
        refrescarPendientes();
        const relevantes = nuevas.filter((a) => a.severidad !== 'baja');
        if (relevantes.length === 0) return;
        setAvisos((l) => [...relevantes, ...l].slice(0, 4));
        sonar(relevantes.some((a) => a.severidad === 'alta') ? 'alta' : 'media');
        try {
          if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
            for (const a of relevantes.slice(0, 3)) new Notification('Alerta de control', { body: a.titulo, tag: `alerta-${a.id}` });
          }
        } catch { /* */ }
      } catch { /* se reintenta en el próximo ciclo */ }
    }
    get('/antifraude/alertas/nuevas').then((r) => { if (ultimoId.current === null) ultimoId.current = r.length ? Math.max(...r.map((a) => a.id)) : 0; }).catch(() => { ultimoId.current = 0; });
    const t = setInterval(revisar, 30_000);
    return () => { activo = false; clearInterval(t); };
  }, []);

  if (avisos.length === 0) return null;
  const cerrar = (id) => setAvisos((l) => l.filter((x) => x.id !== id));
  return (
    <div className="af-notif-pila" role="alert">
      {avisos.map((a) => (
        <div key={a.id} className={`af-notif ${a.severidad}`}>
          <div><strong>{a.severidad === 'alta' ? 'Alerta grave' : 'Alerta'}</strong><p>{a.titulo}</p></div>
          <div className="fila">
            <button className="btn chico primario" onClick={() => { cerrar(a.id); nav(`${base}/antifraude`); }}>Ver</button>
            <button className="btn chico fantasma" onClick={() => cerrar(a.id)}>Cerrar</button>
          </div>
        </div>
      ))}
    </div>
  );
}
