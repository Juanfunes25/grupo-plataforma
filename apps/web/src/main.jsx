import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ProveedorSesion } from './sesion.jsx';
import { ProveedorAvisos } from './ui/kit.jsx';
import TablasResponsivas from './ui/TablasResponsivas.jsx';
import { aplicarTema, leerTema } from './lib/acento.js';
import App from './App.jsx';
import './estilos.css';

aplicarTema(leerTema());

createRoot(document.getElementById('raiz')).render(
  <StrictMode>
    <BrowserRouter>
      <ProveedorAvisos>
        <ProveedorSesion>
          <App />
          <TablasResponsivas />
        </ProveedorSesion>
      </ProveedorAvisos>
    </BrowserRouter>
  </StrictMode>,
);
