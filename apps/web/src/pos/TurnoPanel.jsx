import { useState } from 'react';
import { lempiras, horaHN, formatearCierreTurno } from '@grupo/shared';
import { post } from '../api.js';
import { Campo, Modal, useAccion } from '../ui/kit.jsx';
import { imprimirLineas, leerConfigImpresora } from '../lib/documentos.js';

export function AbrirTurno({ sucursal, puede, onAbierto }) {
  const [fondo, setFondo] = useState('');
  const [ejecutar, ocupado] = useAccion();
  const abrir = async () => {
    const r = await ejecutar(() => post('/pos/turno/abrir', { sucursal_id: sucursal.id, fondo_inicial: parseFloat(fondo || '0') }), 'Turno abierto');
    if (r) onAbierto();
  };
  return (
    <div className="pagina" style={{ maxWidth: 480 }}>
      <div className="tarjeta" style={{ display: 'grid', gap: 14 }}>
        <h2>Abrir turno de caja</h2>
        <p className="tenue" style={{ margin: 0 }}>{sucursal.nombre}. Cuenta el efectivo con el que empiezas: al cerrar, el sistema cuadra contra esto.</p>
        {puede ? (
          <>
            <Campo etiqueta="Fondo inicial en efectivo (L)"><input inputMode="decimal" autoFocus value={fondo} onChange={(e) => setFondo(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0.00" style={{ fontSize: '1.5rem', minHeight: 56 }} /></Campo>
            <button className="btn primario grande" disabled={ocupado} onClick={abrir}>Abrir turno</button>
          </>
        ) : <div className="aviso-caja">Tu rol no abre caja. Pídele a un gerente que lo haga.</div>}
      </div>
    </div>
  );
}

export function MovimientoCaja({ sucursal, onCerrar, onListo }) {
  const [tipo, setTipo] = useState('salida');
  const [monto, setMonto] = useState('');
  const [concepto, setConcepto] = useState('');
  const [ejecutar, ocupado] = useAccion();
  const guardar = async () => {
    const r = await ejecutar(() => post('/pos/turno/movimiento', { sucursal_id: sucursal.id, tipo, monto: parseFloat(monto), concepto }), 'Movimiento registrado');
    if (r) onListo();
  };
  return (
    <Modal titulo="Movimiento de caja" onCerrar={onCerrar} tam="angosto" pie={<button className="btn primario" disabled={ocupado || !(parseFloat(monto) > 0) || concepto.trim().length < 3} onClick={guardar}>Registrar</button>}>
      <div className="fila"><button className="btn" aria-pressed={tipo === 'salida'} onClick={() => setTipo('salida')} style={tipo === 'salida' ? { background: 'var(--peligro-fondo)' } : undefined}>Salida de efectivo</button><button className="btn" onClick={() => setTipo('ingreso')} style={tipo === 'ingreso' ? { background: 'var(--ok-fondo)' } : undefined}>Ingreso</button></div>
      <Campo etiqueta="Monto (L)"><input inputMode="decimal" value={monto} onChange={(e) => setMonto(e.target.value.replace(/[^\d.]/g, ''))} autoFocus /></Campo>
      <Campo etiqueta="Concepto"><input value={concepto} onChange={(e) => setConcepto(e.target.value)} placeholder="Compra de hielo, cambio, propinas…" /></Campo>
    </Modal>
  );
}

export function CerrarTurno({ sucursal, turno, resumen, empresa, cajero, onCerrar, onCerrado }) {
  const [contado, setContado] = useState('');
  const [obs, setObs] = useState('');
  const [resultado, setResultado] = useState(null);
  const [ejecutar, ocupado] = useAccion();
  const cerrar = async () => {
    const r = await ejecutar(() => post('/pos/turno/cerrar', { sucursal_id: sucursal.id, efectivo_contado: parseFloat(contado), observaciones: obs || null }));
    if (r && r !== true) setResultado(r);
  };

  if (resultado) {
    const t = resultado.turno, rs = resultado.resumen;
    const dif = t.diferencia;
    // Cierre imprimible en la térmica de la caja (mismo ancho de papel que la factura); el cajero lo firma y lo guarda con el dinero.
    const imprimir = () => ejecutar(() => imprimirLineas(formatearCierreTurno({ empresa: empresa ?? {}, sucursal, cajero, turno: t, resumen: rs }, leerConfigImpresora().columnas), { logo: false }));
    return (
      <Modal titulo="Turno cerrado" onCerrar={onCerrado}>
        <div className={`aviso-caja ${dif === 0 ? 'ok' : dif < 0 ? 'mal' : ''}`}>
          {dif === 0 ? 'Caja cuadrada. ¡Buen trabajo!' : dif < 0 ? `Faltante de ${lempiras(-dif)}` : `Sobrante de ${lempiras(dif)}`}
        </div>
        <table><tbody>
          <tr><td>Facturas</td><td className="der num">{rs.facturas}</td></tr>
          <tr><td>Ventas totales</td><td className="der num">{lempiras(rs.total)}</td></tr>
          <tr><td>Tarjeta</td><td className="der num">{lempiras(rs.tarjeta)}</td></tr>
          <tr><td>Transferencia</td><td className="der num">{lempiras(rs.transferencia)}</td></tr>
          <tr><td>Efectivo esperado (fondo + ventas ± movimientos)</td><td className="der num">{lempiras(rs.efectivo_esperado)}</td></tr>
          <tr><td>Efectivo contado</td><td className="der num">{lempiras(t.efectivo_contado)}</td></tr>
          <tr><td><b>Diferencia</b></td><td className="der num"><b>{lempiras(dif)}</b></td></tr>
        </tbody></table>
        <div className="fila">
          <button className="btn" disabled={ocupado} onClick={imprimir}>Imprimir cierre de caja</button>
          <button className="btn primario" onClick={onCerrado}>Listo</button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal titulo="Cerrar turno" onCerrar={onCerrar} tam="angosto" pie={<button className="btn primario grande" disabled={ocupado || !(parseFloat(contado) >= 0) || contado === ''} onClick={cerrar}>Cerrar turno</button>}>
      <small>Turno abierto a las {horaHN(turno.abierto_at)} · fondo {lempiras(turno.fondo_inicial)} · {resumen?.facturas ?? 0} facturas</small>
      <Campo etiqueta="Efectivo contado en caja (L)" ayuda="Cuenta todo el efectivo, incluido el fondo. El sistema calcula la diferencia al cerrar."><input inputMode="decimal" autoFocus value={contado} onChange={(e) => setContado(e.target.value.replace(/[^\d.]/g, ''))} style={{ fontSize: '1.5rem', minHeight: 56 }} /></Campo>
      <Campo etiqueta="Observaciones (opcional)"><input value={obs} onChange={(e) => setObs(e.target.value)} /></Campo>
    </Modal>
  );
}
