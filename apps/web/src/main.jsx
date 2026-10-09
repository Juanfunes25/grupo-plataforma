import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ProveedorSesion } from './sesion.jsx';
import { ProveedorAvisos } from './ui/kit.jsx';
import TablasResponsivas from './ui/TablasResponsivas.jsx';
import { aplicarPreferencias, vigilarSistema } from './lib/preferencias.js';
import { hayVersionNueva, registrarActualizacion, vigilarInstalacion } from './lib/instalar.js';
import AvisoVersion from './ui/AvisoVersion.jsx';
import App from './App.jsx';
import LimiteError from './ui/LimiteError.jsx';
import './estilos.css';
import './ui/app.css';
import { registerSW } from 'virtual:pwa-register';

aplicarPreferencias();
vigilarSistema();
vigilarInstalacion();

// Versión nueva: se descarga sola en segundo plano y se avisa con un botón «Actualizar» (no recarga en medio de una venta).
// Se busca cada minuto y al volver a la app, para que una tablet que se queda abierta días no se quede con una versión vieja.
const actualizarSW = registerSW({
  immediate: true,
  onNeedRefresh() { hayVersionNueva(); },
  onRegisteredSW(_url, r) {
    if (!r) return;
    const buscar = () => { r.update().catch(() => {}); };
    setInterval(buscar, 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) buscar(); });
  },
});
registrarActualizacion(actualizarSW);

createRoot(document.getElementById('raiz')).render(
  <StrictMode>
    <BrowserRouter>
      <ProveedorAvisos>
        <ProveedorSesion>
          <LimiteError><App /></LimiteError>
          <TablasResponsivas />
          <AvisoVersion />
        </ProveedorSesion>
      </ProveedorAvisos>
    </BrowserRouter>
  </StrictMode>,
);
