import { useState } from 'react';
import { useSesion } from '../sesion.jsx';
import { guardarConfigImpresora, imprimirPrueba, leerConfigImpresora, PAPELES } from '../lib/documentos.js';
import '../pos/pos.css';

const URL_APP = typeof window !== 'undefined' ? window.location.origin : '';
const ACCESO_DIRECTO = `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --kiosk-printing --app=${URL_APP}`;

/** Impresora térmica de ESTA caja: ancho del papel, impresión automática al cobrar, ticket de prueba y guía de impresión directa. */
export default function Impresora() {
  const { sucursal, contexto } = useSesion();
  const [config, setConfig] = useState(leerConfigImpresora);
  const [estado, setEstado] = useState('');
  const [error, setError] = useState('');
  const [copiado, setCopiado] = useState(false);

  const actualizar = (cambios) => {
    const nueva = { ...config, ...cambios };
    setConfig(nueva); guardarConfigImpresora(nueva);
    setEstado('Guardado en esta computadora.');
  };
  const probar = async () => {
    setError(''); setEstado('Enviando prueba…');
    try { await imprimirPrueba(sucursal?.id); setEstado('Prueba enviada a la impresora.'); } catch (e) { setEstado(''); setError(e.message); }
  };
  const copiar = async () => {
    try { await navigator.clipboard.writeText(ACCESO_DIRECTO); setCopiado(true); setTimeout(() => setCopiado(false), 2000); }
    catch { setError('No se pudo copiar: selecciona el texto y usa Ctrl+C.'); }
  };

  return (
    <div className="pagina" style={{ maxWidth: 860 }}>
      <div className="encabezado-pagina"><h1>Impresora</h1></div>
      {error && <div className="aviso-caja mal">{error}</div>}

      <div className="tarjeta" style={{ display: 'grid', gap: 14 }}>
        <div>
          <h2>Impresora térmica de esta caja</h2>
          <p className="tenue" style={{ margin: '4px 0 0' }}>Esta configuración se guarda en este equipo: cada caja puede tener su propia impresora.</p>
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
        <div className="fila">
          <button className="btn primario" onClick={probar}>Imprimir ticket de prueba</button>
          {estado && <small>{estado}</small>}
        </div>
        <small className="tenue">La primera impresión de una factura sale como original; cualquier otra sale marcada “COPIA #n” y queda registrada con su motivo. Toda reimpresión se revisa en Antifraude.</small>
      </div>

      <div className="tarjeta" style={{ display: 'grid', gap: 10 }}>
        <h2>Imprimir directo, sin ventana de confirmación</h2>
        <p className="tenue" style={{ margin: 0 }}>Sin este paso la factura igual se imprime, pero Chrome muestra la ventana de impresión y hay que dar Enter cada vez. Se configura una sola vez por computadora (Windows):</p>
        <ol className="pasos">
          <li>Instala el driver de la impresora (Epson, Xprinter, 3nStar, etc.) y en <b>Configuración → Impresoras</b> márcala como <b>predeterminada</b>. En sus preferencias elige papel de 80 mm (o 58 mm) y márgenes en 0.</li>
          <li>En el escritorio: clic derecho → <b>Nuevo → Acceso directo</b> y pega esto como ubicación:
            <div className="codigo-copiable"><code>{ACCESO_DIRECTO}</code><button className="btn chico" onClick={copiar}>{copiado ? 'Copiado' : 'Copiar'}</button></div>
          </li>
          <li>Nómbralo <b>“{contexto?.empresa?.nombre ?? 'Caja'}”</b>. Cierra todas las ventanas de Chrome y abre el sistema siempre desde ese acceso directo.</li>
          <li>Entra, vuelve a esta pantalla y toca <b>Imprimir ticket de prueba</b>: debe salir directo por la térmica, sin preguntar. Si las líneas salen cortadas, cambia el ancho del papel arriba.</li>
        </ol>
        <small className="tenue"><b>--kiosk-printing</b> hace que Chrome imprima en la impresora predeterminada sin mostrar el diálogo. <b>--app</b> abre el sistema como aplicación, sin barra de direcciones ni pestañas. En una tablet Android, la impresión usa el servicio de impresión del sistema.</small>
      </div>
    </div>
  );
}
