import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { get } from '../api.js';
import { useSesion } from '../sesion.jsx';
import BloqueoInactividad from './BloqueoInactividad.jsx';
import NotificacionesAlertas from './NotificacionesAlertas.jsx';
import { registrarEvento } from './eventos.js';

/**
 * Se monta una vez en el Layout de la empresa. Si la empresa tiene el antifraude encendido:
 *   · registra en la bitácora el inicio de sesión y cada pantalla que se abre,
 *   · bloquea la pantalla tras X minutos sin uso,
 *   · y, para quien puede ver el antifraude, avisa en vivo de las alertas nuevas.
 * En una empresa sin el módulo (EcoStone, DISERCO) no hace nada.
 */
export default function Vigilancia({ base }) {
  const s = useSesion();
  const loc = useLocation();
  const [cfg, setCfg] = useState(null);
  const empresa = s.contexto?.empresa?.codigo;

  useEffect(() => {
    let vivo = true;
    setCfg(null);
    if (!empresa) return undefined;
    get('/antifraude/sesion').then((r) => { if (vivo) setCfg(r); }).catch(() => { if (vivo) setCfg({ activo: false }); });
    return () => { vivo = false; };
  }, [empresa]);

  const activo = cfg?.activo;
  useEffect(() => {
    if (!activo) return;
    const k = `grupo.af.inicio.${empresa}`;           // una vez por sesión del navegador, no en cada recarga
    try { if (sessionStorage.getItem(k)) return; sessionStorage.setItem(k, '1'); } catch { /* */ }
    registrarEvento('sesion.inicio', { empresa, via: s.via ?? '' });
  }, [activo, empresa]); // eslint-disable-line react-hooks/exhaustive-deps

  const pantalla = loc.pathname.startsWith(base) ? loc.pathname.slice(base.length).split('/')[1] || 'inicio' : '';
  useEffect(() => {
    if (!activo || !pantalla) return;
    const m = s.modulos.find((x) => x.ruta === pantalla);
    registrarEvento('pantalla.ver', { pantalla: m?.nombre ?? pantalla });
  }, [activo, pantalla]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!activo) return null;
  return (
    <>
      <BloqueoInactividad minutos={cfg.minutos_bloqueo} />
      {s.puede('antifraude:ver') && <NotificacionesAlertas base={base} />}
    </>
  );
}
