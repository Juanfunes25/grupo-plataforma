// Montado una vez en el Layout: recorrido guiado la primera vez (por rol), botón «?» con la ayuda de la pantalla actual.
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useSesion } from '../sesion.jsx';
import Icono from '../ui/Icono.jsx';
import { rolDeAyuda } from './rol.js';

// El texto de la ayuda (12 kB) se descarga después del primer dibujo, no en el JavaScript de entrada.
let contenido = null;
const cargarContenido = () => import('./contenido.js').then((m) => { contenido = m; return m; });
function useContenido() {
  const [c, setC] = useState(contenido);
  useEffect(() => { if (!c) cargarContenido().then(setC).catch(() => {}); }, [c]);
  return c;
}
import { marcarVisto, yaVisto } from './recorridoEstado.js';
import './ayuda.css';

function Hoja({ titulo, onCerrar, children, etiqueta }) {
  useEffect(() => { const f = (e) => e.key === 'Escape' && onCerrar(); window.addEventListener('keydown', f); return () => window.removeEventListener('keydown', f); }, [onCerrar]);
  return (
    <div className="ay-hoja-velo" onMouseDown={(e) => e.target === e.currentTarget && onCerrar()}>
      <div className="ay-hoja" role="dialog" aria-modal="true" aria-label={etiqueta ?? titulo}>
        <div className="ay-hoja-cab"><h2>{titulo}</h2><button className="btn fantasma" onClick={onCerrar} aria-label="Cerrar"><Icono n="x" /></button></div>
        {children}
      </div>
    </div>
  );
}

function Recorrido({ rol, onFin, recorridos }) {
  const pasos = recorridos[rol] ?? recorridos.cajero;
  const [i, setI] = useState(0);
  const p = pasos[i], ultimo = i === pasos.length - 1;
  return (
    <Hoja titulo={p.t} etiqueta="Recorrido guiado" onCerrar={onFin}>
      <p style={{ margin: 0, fontSize: '1.02rem' }}>{p.x}</p>
      <div className="ay-puntos" aria-label={`Paso ${i + 1} de ${pasos.length}`}>{pasos.map((_, j) => <i key={j} className={j === i ? 'on' : ''} />)}</div>
      <div className="ay-pie">
        <button className="btn fantasma" onClick={onFin}>Saltar</button>
        <span style={{ display: 'flex', gap: 8 }}>
          {i > 0 && <button className="btn" onClick={() => setI(i - 1)}>Atrás</button>}
          <button className="btn primario" onClick={() => (ultimo ? onFin() : setI(i + 1))}>{ultimo ? 'Listo' : 'Siguiente'}</button>
        </span>
      </div>
    </Hoja>
  );
}

export default function AyudaGlobal({ base = '' }) {
  const { contexto, usuario } = useSesion();
  const { pathname } = useLocation();
  const [recorrido, setRecorrido] = useState(null);
  const [contextual, setContextual] = useState(false);
  const rol = rolDeAyuda(contexto?.rol, usuario?.es_dueno_grupo);
  const ruta = pathname.startsWith(`${base}/`) ? pathname.slice(base.length + 1).split('/')[0] : '';
  const c = useContenido();
  const ayuda = c?.AYUDA_PANTALLA[ruta];

  // Primera vez de este usuario con este rol.
  useEffect(() => {
    if (usuario?.id && contexto && !yaVisto(usuario.id, rol)) { const t = setTimeout(() => setRecorrido(rol), 900); return () => clearTimeout(t); }
    return undefined;
  }, [usuario?.id, rol, contexto]);
  useEffect(() => { const f = (e) => setRecorrido(e.detail.rol); window.addEventListener('grupo:recorrido', f); return () => window.removeEventListener('grupo:recorrido', f); }, []);
  const terminar = () => { if (usuario?.id) marcarVisto(usuario.id, rol); setRecorrido(null); };

  return (
    <>
      {ayuda && ruta !== 'pos' && <button className="ay-fab no-print" onClick={() => setContextual(true)} aria-label={`Ayuda de ${ayuda.t}`} title="Ayuda de esta pantalla"><Icono n="ayuda" tam={20} /></button>}
      {contextual && ayuda && (
        <Hoja titulo={ayuda.t} etiqueta={`Ayuda de ${ayuda.t}`} onCerrar={() => setContextual(false)}>
          <ul>{ayuda.p.map((x) => <li key={x}>{x}</li>)}</ul>
          <div className="ay-pie"><button className="btn" onClick={() => { setContextual(false); setRecorrido(rol); }}>Ver el recorrido</button>
            <Link className="btn primario" to={`${base}/ayuda`} onClick={() => setContextual(false)}>Abrir el manual</Link></div>
        </Hoja>
      )}
      {recorrido && c && <Recorrido rol={recorrido} onFin={terminar} recorridos={c.RECORRIDOS} />}
    </>
  );
}
