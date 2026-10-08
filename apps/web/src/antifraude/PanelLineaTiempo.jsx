import { useState } from 'react';
import { fechaHN, lempiras } from '@grupo/shared';
import { get, qs } from '../api.js';
import { ErrorCaja, Kpi, Vacio, descargarCsv, useDatos } from '../ui/kit.jsx';
import { ETIQUETA_EVENTO, SENSIBLES, horaSeg, resumenEvento } from './etiquetas.js';

export default function PanelLineaTiempo() {
  const usuarios = useDatos(() => get('/antifraude/usuarios'), []);
  const [usuarioId, setUsuarioId] = useState('');
  const [fecha, setFecha] = useState(fechaHN());
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState('');
  const [soloSensibles, setSoloSensibles] = useState(false);

  const cargar = async () => {
    setError('');
    try { setDatos(await get(`/antifraude/linea-tiempo${qs({ usuario_id: usuarioId, fecha })}`)); } catch (e) { setError(e.message); }
  };
  const nombre = (usuarios.datos ?? []).find((u) => u.id === usuarioId)?.nombre ?? '';
  const items = (datos?.items ?? []).filter((i) => !soloSensibles || SENSIBLES.has(i.accion));
  const exportar = () => descargarCsv(`expediente-${nombre.replace(/\s+/g, '-')}-${fecha}.csv`,
    datos.items.map((i) => ({ hora: horaSeg(i.momento), accion: ETIQUETA_EVENTO[i.accion] ?? i.accion, detalle: resumenEvento(i) || JSON.stringify(i.detalle ?? {}), sucursal: i.sucursal ?? '', ip: i.ip ?? '' })),
    [['hora', 'Hora'], ['accion', 'Acción'], ['detalle', 'Detalle'], ['sucursal', 'Sucursal'], ['ip', 'IP']]);

  return (
    <div className="tarjeta" style={{ display: 'grid', gap: 12 }}>
      <h3>Línea de tiempo del turno</h3>
      <small>Todo lo que hizo una persona en un día, minuto a minuto: facturas, productos quitados, descuentos, reimpresiones, pantallas abiertas. Sirve para reconstruir un turno y cruzarlo con las cámaras. Se exporta como expediente.</small>
      <ErrorCaja error={error} />
      <div className="fila">
        <select value={usuarioId} onChange={(e) => setUsuarioId(e.target.value)} aria-label="Persona" style={{ width: 'auto' }}>
          <option value="">Elige a la persona…</option>
          {(usuarios.datos ?? []).map((u) => <option key={u.id} value={u.id}>{u.nombre} ({u.rol})</option>)}
        </select>
        <input type="date" value={fecha} max={fechaHN()} onChange={(e) => setFecha(e.target.value)} style={{ width: 'auto' }} aria-label="Día" />
        <button className="btn primario chico" onClick={cargar} disabled={!usuarioId || !fecha}>Ver turno</button>
        {datos && (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={soloSensibles} onChange={(e) => setSoloSensibles(e.target.checked)} />Solo movimientos sensibles</label>
            <button className="btn chico" onClick={exportar}>Exportar expediente (CSV)</button>
          </>
        )}
      </div>
      {datos && (
        <>
          <div className="rejilla cols-4">
            <Kpi etiqueta="Facturas" valor={datos.resumen.facturas} />
            <Kpi etiqueta="Vendido" valor={lempiras(datos.resumen.total)} />
            <Kpi etiqueta="Anuladas" valor={datos.resumen.anuladas} />
            <Kpi etiqueta="Reimpresiones" valor={datos.resumen.reimpresiones} />
            <Kpi etiqueta="3ª edad" valor={datos.resumen.tercera_edad} />
            <Kpi etiqueta="Primer / último movimiento" valor={datos.resumen.primer_movimiento ? `${horaSeg(datos.resumen.primer_movimiento).slice(0, 5)} – ${horaSeg(datos.resumen.ultimo_movimiento).slice(0, 5)}` : '—'} />
          </div>
          <ol className="af-linea">
            {items.length === 0 && <li style={{ display: 'block' }}><Vacio>Sin movimientos ese día.</Vacio></li>}
            {items.map((i, idx) => (
              <li key={idx} className={SENSIBLES.has(i.accion) ? 'sensible' : ''}>
                <span className="af-linea-hora">{horaSeg(i.momento)}</span><span className="af-linea-punto" />
                <span><strong>{ETIQUETA_EVENTO[i.accion] ?? i.accion}</strong>{resumenEvento(i) && <span className="tenue"> · {resumenEvento(i)}</span>}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
