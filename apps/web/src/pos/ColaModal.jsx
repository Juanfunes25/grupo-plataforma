import { useEffect, useState } from 'react';
import { fechaHoraHN, lempiras } from '@grupo/shared';
import { Modal, useAccion, useAviso, useConfirmar, usePedirTexto } from '../ui/kit.jsx';
import { registrarEvento } from '../lib/eventos.js';
import { cola, sincronizarAhora, useResumenCola } from './colaLocal.js';

/**
 * Ventas hechas sin conexión que todavía no están en el servidor. Un encargado puede reintentar las que el servidor rechazó
 * (por ejemplo, un precio que cambió) o descartarlas con motivo: descartar una venta que el cliente ya pagó queda en la bitácora.
 */
export default function ColaModal({ puedeDescartar, sucursalId, onCerrar }) {
  const [lista, setLista] = useState([]);
  const r = useResumenCola();
  const [ejecutar, ocupado] = useAccion();
  const avisar = useAviso();
  const confirmar = useConfirmar();
  const pedir = usePedirTexto();
  const recargar = async () => setLista(await cola().lista());
  useEffect(() => { recargar(); }, [r.total, r.revisar, r.sincronizando]);   // eslint-disable-line react-hooks/exhaustive-deps

  const ahora = () => ejecutar(async () => {
    const res = await sincronizarAhora();
    avisar(res.detenida === 'red' ? 'Todavía no hay conexión con el servidor.' : res.detenida === 'sesion' ? 'La sesión venció: vuelve a entrar para sincronizar.' : `Sincronización terminada: ${res.enviadas.length} enviada(s).`, res.detenida ? 'mal' : 'ok');
    await recargar();
  });
  const reintentar = (it) => ejecutar(async () => { await cola().reintentar(it.id); await sincronizarAhora(); await recargar(); });
  const descartar = async (it) => {
    if (!(await confirmar({ titulo: 'Descartar venta sin conexión', mensaje: `El cliente ya pagó ${lempiras(it.resumen?.total)} (comprobante ${it.payload.offline?.numero_provisional}). Si la descartas, esa venta NO se factura. Solo hazlo si ya se resolvió por otro lado.`, peligro: true, textoOk: 'Descartar' }))) return;
    const motivo = await pedir({ titulo: 'Motivo', etiqueta: 'Motivo del descarte', obligatorio: true, minimo: 5 });
    if (!motivo) return;
    const quitada = await cola().descartar(it.id);
    registrarEvento('offline.descartada', { provisional: quitada?.payload.offline?.numero_provisional, total: quitada?.resumen?.total, motivo, error: quitada?.ultimoError, id_cliente: it.id }, sucursalId);
    await recargar();
  };

  return (
    <Modal titulo="Ventas por sincronizar" onCerrar={onCerrar} tam="ancho"
      pie={<><button className="btn" onClick={onCerrar}>Cerrar</button><button className="btn primario" disabled={ocupado || r.sincronizando || lista.length === 0} onClick={ahora}>{r.sincronizando ? 'Sincronizando…' : 'Sincronizar ahora'}</button></>}>
      {!r.persistente && <div className="aviso-caja mal">Este navegador no deja guardar datos (ventana privada). Si lo cierras ahora, se pierden estas ventas.</div>}
      <small>Son ventas cobradas en efectivo mientras no había internet. Se envían solas al volver la señal; cada una se factura una sola vez aunque se reintente.</small>
      {lista.length === 0 ? <div className="vacio">No hay ventas pendientes. Todo está sincronizado.</div> : (
        <div style={{ display: 'grid', gap: 8 }}>
          {lista.map((it) => (
            <div key={it.id} className={`cola-fila${it.estado === 'revisar' ? ' revisar' : ''}`}>
              <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                <b>{it.payload.offline?.numero_provisional} · {lempiras(it.resumen?.total)}</b>
                <small>{fechaHoraHN(it.creada)} · {it.resumen?.lineas ?? '?'} producto(s) · {it.resumen?.cajero ?? ''}</small>
                {it.estado === 'revisar'
                  ? <small className="cola-error">Rechazada por el servidor: {it.ultimoError}</small>
                  : it.ultimoError ? <small className="tenue">Último intento: {it.ultimoError}</small> : <small className="tenue">Esperando conexión…</small>}
              </div>
              <div className="fila" style={{ flexShrink: 0 }}>
                {it.estado === 'revisar' && <button className="btn chico" disabled={ocupado} onClick={() => reintentar(it)}>Reintentar</button>}
                {puedeDescartar && it.estado === 'revisar' && <button className="btn chico peligro" onClick={() => descartar(it)}>Descartar</button>}
              </div>
            </div>
          ))}
        </div>
      )}
      {lista.some((x) => x.estado === 'revisar') && !puedeDescartar && <div className="aviso-caja">Las ventas rechazadas las resuelve un encargado con permiso para anular.</div>}
    </Modal>
  );
}
