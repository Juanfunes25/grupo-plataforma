import { useState } from 'react';
import { fechaHN, sumarDias } from '@grupo/shared';
import { post } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Kpi, Tabs, useAccion } from '../ui/kit.jsx';
import PanelAlertas from '../antifraude/PanelAlertas.jsx';
import PanelCajeros from '../antifraude/PanelCajeros.jsx';
import PanelLineaTiempo from '../antifraude/PanelLineaTiempo.jsx';
import PanelArqueo from '../antifraude/PanelArqueo.jsx';
import PanelUso from '../antifraude/PanelUso.jsx';
import PanelReglas from '../antifraude/PanelReglas.jsx';
import { refrescarPendientes, useAlertasPendientes } from '../antifraude/pendientes.js';
import '../antifraude/antifraude.css';

// Antifraude: bandeja de alertas con seguimiento, señales por cajero, línea de tiempo de un turno,
// arqueos sorpresa, uso del sistema (pantallas, dispositivos, intentos de entrada, integridad) y reglas.
export default function Antifraude() {
  const { sucursales, puede, contexto } = useSesion();
  const hoy = fechaHN();
  const [f, setF] = useState({ desde: sumarDias(hoy, -6), hasta: hoy, sucursal_id: '' });
  const [tab, setTab] = useState('alertas');
  const [version, setVersion] = useState(0);
  const [ejecutar, ocupado] = useAccion();
  const { pendientes, altas } = useAlertasPendientes(true);

  if (!puede('antifraude:ver')) return <div className="pagina"><div className="aviso-caja mal">Solo el dueño o el administrador pueden ver el antifraude.</div></div>;

  const analizar = async () => { if (await ejecutar(() => post('/antifraude/revisar'))) { setVersion((v) => v + 1); refrescarPendientes(); } };

  return (
    <div className="pagina">
      <div className="encabezado-pagina">
        <div>
          <h1>Antifraude</h1>
          <small>Todo lo que se hace en {contexto?.empresa?.nombre ?? 'la empresa'} queda en la bitácora inalterable. Aquí se resume lo que merece revisión y se investiga cada caso hasta cerrarlo.</small>
        </div>
        <div className="fila">
          {sucursales.length > 1 && (
            <select value={f.sucursal_id} onChange={(e) => setF({ ...f, sucursal_id: e.target.value })} aria-label="Sucursal">
              <option value="">Todas las sucursales</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
            </select>
          )}
          <input type="date" value={f.desde} max={f.hasta} onChange={(e) => setF({ ...f, desde: e.target.value })} aria-label="Desde" style={{ width: 'auto' }} />
          <input type="date" value={f.hasta} min={f.desde} max={hoy} onChange={(e) => setF({ ...f, hasta: e.target.value })} aria-label="Hasta" style={{ width: 'auto' }} />
          <button className="btn primario" onClick={analizar} disabled={ocupado}>{ocupado ? 'Analizando…' : 'Analizar'}</button>
        </div>
      </div>

      <div className="rejilla cols-3">
        <Kpi acento={pendientes > 0} etiqueta="Alertas abiertas" valor={pendientes} sub="pendientes e investigando" />
        <Kpi etiqueta="Graves abiertas" valor={altas} sub={altas ? 'revísalas primero' : 'ninguna grave'} />
        <Kpi etiqueta="Periodo analizado" valor={`${f.desde.slice(5)} → ${f.hasta.slice(5)}`} sub="señales, patrones y uso" />
      </div>
      <div className="aviso-caja">Las alertas llegan en vivo a este panel: aviso en pantalla, sonido y notificación del navegador mientras haya una sesión de administrador abierta.</div>

      <Tabs tabs={[['alertas', pendientes ? `Alertas (${pendientes})` : 'Alertas'], ['cajeros', 'Señales por cajero'], ['linea', 'Línea de tiempo'], ['arqueo', 'Arqueo sorpresa'], ['uso', 'Uso del sistema'], ['reglas', 'Reglas']]} valor={tab} onCambio={setTab} />

      {tab === 'alertas' && <PanelAlertas sucursalId={f.sucursal_id} desde={f.desde} hasta={f.hasta} version={version} />}
      {tab === 'cajeros' && <PanelCajeros sucursalId={f.sucursal_id} desde={f.desde} hasta={f.hasta} version={version} />}
      {tab === 'linea' && <PanelLineaTiempo />}
      {tab === 'arqueo' && <PanelArqueo sucursales={sucursales} />}
      {tab === 'uso' && <PanelUso desde={f.desde} hasta={f.hasta} version={version} />}
      {tab === 'reglas' && <PanelReglas />}
    </div>
  );
}
