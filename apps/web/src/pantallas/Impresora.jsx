import { useState } from 'react';
import { useSesion } from '../sesion.jsx';
import { guardarConfigImpresora, imprimirPrueba, leerConfigImpresora, logoDelTicket, PAPELES } from '../lib/documentos.js';
import '../pos/pos.css';

const URL_BASE = typeof window !== 'undefined' ? window.location.origin : '';
const CHROME = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"';
const CHROME_X86 = '"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"';

/**
 * Acceso directo listo para pegar. `--user-data-dir` da a la caja su propio perfil de Chrome: así SIEMPRE se abre con
 * --kiosk-printing, aunque haya otra ventana de Chrome abierta (Chrome ignora las opciones si ya está corriendo con otro perfil).
 */
const accesoDirecto = (url, perfil = 'GrupoCaja') => `${CHROME} --kiosk-printing --user-data-dir="%LOCALAPPDATA%\\${perfil}" --app=${url}`;

/** Archivo .bat que prueba las dos rutas de instalación de Chrome. Se descarga y se deja en el escritorio. */
const archivoBat = (url, nombre) => [
  '@echo off',
  `rem ${nombre}: abre la caja con impresion directa (sin ventana de confirmacion)`,
  `set "URL=${url}"`,
  `set "PERFIL=%LOCALAPPDATA%\\GrupoCaja"`,
  `if exist ${CHROME} (start "" ${CHROME} --kiosk-printing --user-data-dir="%PERFIL%" --app=%URL% & exit /b)`,
  `if exist ${CHROME_X86} (start "" ${CHROME_X86} --kiosk-printing --user-data-dir="%PERFIL%" --app=%URL% & exit /b)`,
  'echo No se encontro Google Chrome en esta computadora. Instalalo desde google.com/chrome y vuelve a abrir este archivo.',
  'pause',
].join('\r\n');

function Copiable({ texto }) {
  const [copiado, setCopiado] = useState(false);
  const [error, setError] = useState('');
  const copiar = async () => {
    try { await navigator.clipboard.writeText(texto); setCopiado(true); setError(''); setTimeout(() => setCopiado(false), 2000); }
    catch { setError('No se pudo copiar: selecciona el texto y usa Ctrl+C.'); }
  };
  return (
    <>
      <div className="codigo-copiable"><code>{texto}</code><button className="btn chico" onClick={copiar}>{copiado ? 'Copiado' : 'Copiar'}</button></div>
      {error && <small style={{ color: 'var(--peligro-texto)' }}>{error}</small>}
    </>
  );
}

/** Impresora térmica de ESTA caja: ancho del papel, logo, impresión automática, prueba y guía paso a paso para Windows. */
export default function Impresora() {
  const { sucursal, contexto } = useSesion();
  const [config, setConfig] = useState(leerConfigImpresora);
  const [estado, setEstado] = useState('');
  const [error, setError] = useState('');
  const codigo = contexto?.empresa?.codigo ?? '';
  const urlCaja = `${URL_BASE}/${codigo}/pos`;
  const nombreCaja = contexto?.empresa?.nombre ?? 'Caja';

  const actualizar = (cambios) => {
    const nueva = { ...config, ...cambios };
    setConfig(nueva); guardarConfigImpresora(nueva);
    setEstado('Guardado en esta computadora.');
  };
  const probar = async () => {
    setError(''); setEstado('Enviando prueba…');
    try { await imprimirPrueba(sucursal?.id); setEstado('Prueba enviada a la impresora.'); } catch (e) { setEstado(''); setError(e.message); }
  };
  const descargarBat = () => {
    const url = URL.createObjectURL(new Blob([archivoBat(urlCaja, nombreCaja)], { type: 'application/octet-stream' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `Caja-${nombreCaja.replace(/[^\w-]+/g, '_')}.bat` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  return (
    <div className="pagina" style={{ maxWidth: 900 }}>
      <div className="encabezado-pagina"><h1>Impresora</h1></div>
      {error && <div className="aviso-caja mal">{error}</div>}

      <div className="tarjeta" style={{ display: 'grid', gap: 14 }}>
        <div>
          <h2>Impresora térmica de esta caja</h2>
          <p className="tenue" style={{ margin: '4px 0 0' }}>Esta configuración se guarda en esta computadora: cada caja puede tener su propia impresora y su propio ancho de papel.</p>
        </div>
        <div>
          <small>Ancho del papel</small>
          <div className="seg" role="radiogroup" aria-label="Ancho del papel" style={{ marginTop: 6 }}>
            {PAPELES.map((p) => <button key={p.columnas} role="radio" aria-checked={config.columnas === p.columnas} className={config.columnas === p.columnas ? 'activo' : ''} onClick={() => actualizar({ columnas: p.columnas })}>{p.etiqueta}</button>)}
          </div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, flexDirection: 'row', fontSize: '.95rem', color: 'var(--texto)' }}>
          <input type="checkbox" checked={config.autoImprimir} onChange={(e) => actualizar({ autoImprimir: e.target.checked })} />
          Imprimir la factura automáticamente al cobrar (1 copia)
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, flexDirection: 'row', fontSize: '.95rem', color: 'var(--texto)' }}>
          <input type="checkbox" checked={config.logo !== false} onChange={(e) => actualizar({ logo: e.target.checked })} />
          Imprimir el logo de la empresa arriba del ticket
        </label>
        {config.logo !== false && logoDelTicket() && (
          <div className="fila" style={{ alignItems: 'center', gap: 10 }}>
            <img src={logoDelTicket()} alt="" style={{ maxHeight: 54, maxWidth: 160, background: '#fff', borderRadius: 6, padding: 4, filter: 'grayscale(1) contrast(1.6)' }} onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.nextSibling.style.display = 'inline'; }} />
            <small className="tenue" style={{ display: 'none' }}>Esta empresa todavía no tiene logo para el ticket: se imprime sin logo. Para agregarlo, guarda una imagen PNG en blanco y negro (fondo blanco) como <b>logos/{codigo}.png</b> dentro de la carpeta pública de la web.</small>
          </div>
        )}
        <div className="fila">
          <button className="btn primario" onClick={probar}>Imprimir ticket de prueba</button>
          {estado && <small>{estado}</small>}
        </div>
        <small className="tenue">La primera impresión de una factura sale como original; cualquier otra sale marcada “COPIA #n” y queda registrada con su motivo. Toda reimpresión se revisa en Antifraude. Mientras no haya CAI real, todo ticket y factura dice “BORRADOR – SIN VALOR FISCAL”.</small>
      </div>

      <div className="tarjeta" style={{ display: 'grid', gap: 10 }}>
        <h2>Imprimir directo, sin ventana de confirmación (Windows)</h2>
        <p className="tenue" style={{ margin: 0 }}>Sin este paso la factura igual se imprime, pero Chrome muestra la ventana de impresión y hay que dar Enter cada vez. Se hace una sola vez por computadora:</p>
        <ol className="pasos">
          <li><b>Driver.</b> Instala el driver de la impresora (Epson, Xprinter, 3nStar, Bixolon…) con el cable USB conectado. En <b>Configuración → Bluetooth y dispositivos → Impresoras</b> márcala como <b>predeterminada</b>.</li>
          <li><b>Papel.</b> En <b>Preferencias de impresión</b> de esa impresora elige papel de <b>80 mm</b> (o 58 mm), largo continuo (“rollo”), márgenes en <b>0</b> y activa “cortar al final del documento” si tu impresora tiene cortador.</li>
          <li><b>Acceso directo.</b> Descarga el archivo y déjalo en el escritorio: <div className="fila" style={{ marginTop: 6 }}><button className="btn primario" onClick={descargarBat}>Descargar «Caja-{nombreCaja}.bat»</button></div>
            <small className="tenue">O, si prefieres crearlo a mano: clic derecho en el escritorio → <b>Nuevo → Acceso directo</b> y pega esto como ubicación:</small>
            <Copiable texto={accesoDirecto(urlCaja)} />
            <small className="tenue">Si Chrome está instalado en <b>Program Files (x86)</b>, cambia esa parte de la ruta.</small>
          </li>
          <li><b>Siempre desde ese acceso.</b> Abre la caja únicamente con ese acceso directo (puedes copiarlo a <b>shell:startup</b> para que se abra solo al prender la computadora). Tiene su propio perfil de Chrome, por eso funciona aunque haya otras ventanas de Chrome abiertas.</li>
          <li><b>Prueba.</b> Entra, vuelve a esta pantalla y toca <b>Imprimir ticket de prueba</b>: debe salir directo, sin preguntar. Si la línea de números sale cortada, cambia el ancho del papel arriba.</li>
        </ol>
        <div className="aviso-caja info" role="note"><b>Si algo no sale bien.</b> Sale con ventana de confirmación → la caja no se abrió con el acceso directo. Sale en otra impresora → no es la predeterminada. Letra muy chica o con márgenes → en Preferencias deja escala 100 % y márgenes 0. No corta el papel → activa el cortador en el driver. Sale en blanco → cierra todo y vuelve a abrir desde el acceso directo.</div>
        <small className="tenue"><b>--kiosk-printing</b> hace que Chrome imprima en la impresora predeterminada sin mostrar el diálogo. <b>--app</b> abre el sistema como aplicación, sin barra de direcciones ni pestañas. <b>--user-data-dir</b> separa la caja de tu Chrome personal. En una tablet Android, la impresión usa el servicio de impresión del sistema (no hay impresión silenciosa).</small>
      </div>
    </div>
  );
}
