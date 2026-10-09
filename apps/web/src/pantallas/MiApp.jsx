import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Icono from '../ui/Icono.jsx';
import { useAviso } from '../ui/kit.jsx';
import { OPCIONES, guardarPref, usePref } from '../lib/preferencias.js';
import { aplicarVersionNueva, instalarAhora, plataforma, useEstadoApp } from '../lib/instalar.js';

function Segmentos({ clave, etiqueta, vertical = false }) {
  const [valor, poner] = usePref(clave);
  return (
    <div className="ajuste-fila" role="group" aria-label={etiqueta}>
      <b>{etiqueta}</b>
      <div className={`segmentos${vertical ? ' v' : ''}`}>
        {OPCIONES[clave].map(([v, t]) => <button key={v} type="button" aria-pressed={valor === v} onClick={() => poner(v)}>{t}</button>)}
      </div>
    </div>
  );
}

const PASOS = {
  android: ['Abre esta página en Chrome.', 'Toca el menú ⋮ (arriba a la derecha).', 'Elige «Instalar app» (o «Agregar a la pantalla principal»).', 'Confirma con «Instalar». El icono queda junto a tus otras apps.'],
  ios: ['Abre esta página en Safari (en iPhone no funciona desde otros navegadores).', 'Toca el botón Compartir (el cuadro con una flecha hacia arriba).', 'Baja y elige «Agregar a pantalla de inicio».', 'Toca «Agregar». Se abre en pantalla completa, como una app.'],
  windows: ['Abre esta página en Chrome o Edge.', 'Toca el icono de instalar en la barra de direcciones (o el menú ⋮ → «Guardar y compartir» → «Instalar página como aplicación»).', 'Confirma con «Instalar». Queda en el menú Inicio y puedes anclarla a la barra de tareas.', 'Tiendas con impresora térmica: pide al técnico que el acceso directo de Chrome lleve --kiosk-printing para imprimir el ticket sin ventana de confirmación.'],
};
const NOMBRES = { android: 'Android (celular o tablet)', ios: 'iPhone o iPad', windows: 'Computadora con Windows' };

export default function MiApp() {
  const nav = useNavigate();
  const avisar = useAviso();
  const { puedeInstalar, hayNueva, instalada } = useEstadoApp();
  const [quiosco] = usePref('quiosco');
  const [buscando, setBuscando] = useState(false);
  const mia = plataforma();
  const volver = () => { if (window.history.length > 1) nav(-1); else nav('/'); };

  const instalar = async () => { if (await instalarAhora()) avisar('App instalada'); };
  const activarQuiosco = () => {
    guardarPref('quiosco', 'si');
    try { document.documentElement.requestFullscreen?.(); } catch { /* sin pantalla completa */ }
    avisar('Modo quiosco activado. El botón ⋯ de la esquina abre las opciones.');
    nav('/');
  };
  const buscarActualizacion = async () => {
    setBuscando(true);
    try {
      const r = await navigator.serviceWorker?.getRegistration();
      await r?.update();
      await new Promise((ok) => setTimeout(ok, 1200));
      if (!hayNueva) avisar('Ya tienes la última versión.');
    } catch { avisar('No se pudo buscar ahora. Revisa tu conexión.', 'mal'); } finally { setBuscando(false); }
  };

  return (
    <main className="ajustes" id="contenido">
      <div className="ajustes-cab">
        <button className="btn fantasma" onClick={volver} aria-label="Volver"><Icono n="atras" tam={22} /></button>
        <h1>Mi dispositivo</h1>
      </div>

      <section className="tarjeta ajuste-grupo" aria-labelledby="t-apariencia">
        <h2 id="t-apariencia">Apariencia</h2>
        <p className="tenue" style={{ margin: 0 }}>Se guarda solo en este aparato. Cada persona y cada tablet puede tener la suya.</p>
        <Segmentos clave="tema" etiqueta="Tema" />
        <Segmentos clave="contraste" etiqueta="Contraste" vertical />
        <Segmentos clave="letra" etiqueta="Tamaño de letra" />
        <Segmentos clave="densidad" etiqueta="Densidad de la pantalla" />
        <div className="ajuste-muestra" aria-hidden="true"><small>Así se ve</small><b>L 12,450.00</b><span>Ventas de hoy · 38 facturas</span></div>
      </section>

      <section className="tarjeta ajuste-grupo" aria-labelledby="t-instalar">
        <h2 id="t-instalar">Instalar la app</h2>
        {instalada
          ? <div className="aviso-caja ok alerta"><Icono n="check" tam={20} /><div><b>Ya estás usando la app instalada.</b>Se abre en pantalla completa y se actualiza sola.</div></div>
          : <p className="tenue" style={{ margin: 0 }}>Instalada, se abre en pantalla completa con su propio icono, sin la barra del navegador. Cada empresa se instala como su propia app: entra primero a la empresa y luego instala.</p>}
        {puedeInstalar && !instalada && <button className="btn primario grande bloque" onClick={instalar}><Icono n="descargar" tam={20} /> Instalar ahora</button>}
        {['android', 'ios', 'windows'].map((p) => (
          <details key={p} className="instalar-plataforma" open={p === mia || (mia === 'otro' && p === 'android')}>
            <summary><span>{NOMBRES[p]}</span>{p === mia && <span className="chip info">Este aparato</span>}</summary>
            <div><ol className="pasos">{PASOS[p].map((t, i) => <li key={i}>{t}</li>)}</ol></div>
          </details>
        ))}
      </section>

      <section className="tarjeta ajuste-grupo" aria-labelledby="t-quiosco">
        <h2 id="t-quiosco">Modo quiosco</h2>
        <p className="tenue" style={{ margin: 0 }}>Para una tablet fija (caja, planta, pantalla de pedidos): pantalla completa y sin menús. Un botón discreto en la esquina permite volver al inicio o salir.</p>
        {quiosco === 'si'
          ? <button className="btn bloque" onClick={() => { guardarPref('quiosco', 'no'); try { if (document.fullscreenElement) document.exitFullscreen(); } catch { /* */ } avisar('Modo quiosco desactivado'); }}>Salir del modo quiosco</button>
          : <button className="btn primario bloque" onClick={activarQuiosco}>Activar modo quiosco en este aparato</button>}
      </section>

      <section className="tarjeta ajuste-grupo" aria-labelledby="t-version">
        <h2 id="t-version">Versión</h2>
        <div className="fila espacio" style={{ alignItems: 'center' }}><span>Versión <b className="num">{__VERSION__}</b></span>
          {hayNueva ? <button className="btn primario" onClick={aplicarVersionNueva}>Actualizar ahora</button> : <button className={`btn${buscando ? ' cargando' : ''}`} disabled={buscando} onClick={buscarActualizacion}>Buscar actualización</button>}
        </div>
      </section>
    </main>
  );
}
