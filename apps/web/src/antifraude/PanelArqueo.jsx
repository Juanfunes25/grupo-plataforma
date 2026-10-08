import { useState } from 'react';
import { lempiras } from '@grupo/shared';
import { get, post } from '../api.js';
import { Estado, useAccion, useDatos } from '../ui/kit.jsx';
import { fechaHora } from './etiquetas.js';
import { refrescarPendientes } from './pendientes.js';

export default function PanelArqueo({ sucursales }) {
  const [f, setF] = useState({ sucursal_id: sucursales.length === 1 ? sucursales[0].id : '', contado: '', fondo_caja: '', nota: '' });
  const [resultado, setResultado] = useState(null);
  const [ejecutar, ocupado] = useAccion();
  const hist = useDatos(() => get('/antifraude/arqueos'), []);

  const registrar = async () => {
    if (!window.confirm('¿Registrar el arqueo? El sistema compara lo contado contra lo que debería haber en este momento.')) return;
    const r = await ejecutar(() => post('/antifraude/arqueos', { sucursal_id: f.sucursal_id, contado: Number(f.contado), fondo_caja: f.fondo_caja, nota: f.nota || null }));
    if (r && r !== true) { setResultado(r); setF({ ...f, contado: '', nota: '' }); hist.recargar(); refrescarPendientes(); }
  };

  return (
    <>
      <div className="tarjeta" style={{ display: 'grid', gap: 12 }}>
        <h3>Arqueo sorpresa</h3>
        <small>Llega a la sucursal sin avisar, cuenta el efectivo de la gaveta y regístralo aquí. El sistema NO muestra antes cuánto debería haber: primero se cuenta, después compara contra fondo + ventas en efectivo + ingresos − salidas desde el último cierre.</small>
        <div className="fila">
          <select value={f.sucursal_id} onChange={(e) => setF({ ...f, sucursal_id: e.target.value })} aria-label="Sucursal" style={{ width: 'auto' }}>
            <option value="">Sucursal…</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
          </select>
          <input type="number" inputMode="decimal" min="0" step="0.01" placeholder="Efectivo contado (L)" value={f.contado} onChange={(e) => setF({ ...f, contado: e.target.value })} style={{ width: 190 }} />
          <input type="number" inputMode="decimal" min="0" step="0.01" placeholder="Fondo (vacío = el de los turnos abiertos)" value={f.fondo_caja} onChange={(e) => setF({ ...f, fondo_caja: e.target.value })} style={{ width: 270 }} />
          <input placeholder="Nota (opcional)" maxLength={300} value={f.nota} onChange={(e) => setF({ ...f, nota: e.target.value })} style={{ width: 220 }} />
          <button className="btn primario" disabled={!f.sucursal_id || f.contado === '' || ocupado} onClick={registrar}>{ocupado ? 'Registrando…' : 'Registrar arqueo'}</button>
        </div>
        {resultado && (
          <div className={`aviso-caja ${Math.abs(resultado.diferencia) < 1 ? 'ok' : 'mal'}`} style={{ fontWeight: 600 }}>
            {Math.abs(resultado.diferencia) < 1
              ? `Cuadra. Esperado ${lempiras(resultado.esperado)}, contado ${lempiras(resultado.contado)}.`
              : `${resultado.diferencia < 0 ? 'Faltan' : 'Sobran'} ${lempiras(Math.abs(resultado.diferencia))}. Esperado ${lempiras(resultado.esperado)}, contado ${lempiras(resultado.contado)}. Se generó una alerta.`}
          </div>
        )}
      </div>
      <div className="tarjeta pad0">
        <div style={{ padding: '14px 16px 4px' }}><h3>Arqueos anteriores</h3></div>
        <Estado d={hist}>{(rows) => (
          <div className="tabla-wrap"><table>
            <thead><tr><th>Fecha</th><th>Sucursal</th><th>Contó</th><th>En turno</th><th className="der">Esperado</th><th className="der">Contado</th><th className="der">Diferencia</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={7} className="centro tenue">Todavía no hay arqueos.</td></tr>}
              {rows.map((a) => (
                <tr key={a.id}><td>{fechaHora(a.created_at)}</td><td>{a.sucursal}</td><td>{a.usuario ?? ''}</td><td>{a.cajeros_turno ?? '—'}</td>
                  <td className="der num">{lempiras(a.esperado)}</td><td className="der num">{lempiras(a.contado)}</td>
                  <td className="der num"><strong style={a.diferencia <= -1 ? { color: 'var(--peligro)' } : undefined}>{lempiras(a.diferencia)}</strong></td></tr>
              ))}
            </tbody>
          </table></div>
        )}</Estado>
      </div>
    </>
  );
}
