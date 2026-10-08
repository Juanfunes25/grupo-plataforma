import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ProveedorSesion } from './sesion.jsx';
import { ProveedorAvisos } from './ui/kit.jsx';
import TablasResponsivas from './ui/TablasResponsivas.jsx';
import { aplicarTema, leerTema } from './lib/acento.js';
import App from './App.jsx';
import LimiteError from './ui/LimiteError.jsx';
import './estilos.css';
import { registerSW } from 'virtual:pwa-register';

aplicarTema(leerTema());

// Versión nueva = se instala sola y la pantalla se recarga (autoUpdate). Además se busca cada minuto y al volver a la app,
// para que una tablet que se queda abierta días no se quede con una versión vieja.
registerSW({
  immediate: true,
  onRegisteredSW(_url, r) {
    if (!r) return;
    const buscar = () => { r.update().catch(() => {}); };
    setInterval(buscar, 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) buscar(); });
  },
});

createRoot(document.getElementById('raiz')).render(
  <StrictMode>
    <BrowserRouter>
      <ProveedorAvisos>
        <ProveedorSesion>
          <LimiteError><App /></LimiteError>
          <TablasResponsivas />
        </ProveedorSesion>
      </ProveedorAvisos>
    </BrowserRouter>
  </StrictMode>,
);
