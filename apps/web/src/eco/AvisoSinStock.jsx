import { Modal } from '../ui/kit.jsx';

/** Ventana de aviso cuando se va a facturar sin existencia suficiente (igual que en EcoStone Facturación):
 *  deja continuar (el inventario queda en negativo y queda constancia en la bitácora) o cancelar. */
export default function AvisoSinStock({ faltantes, accion = 'facturar', onContinuar, onCancelar, bloqueante = false }) {
  return (
    <Modal titulo="⚠ No hay existencia suficiente" onCerrar={onCancelar} tam="angosto"
      pie={<>
        <button className="btn" onClick={onCancelar}>Cancelar</button>
        {!bloqueante && <button className="btn primario" onClick={onContinuar}>Sí, {accion} de todos modos</button>}
      </>}>
      <p>Según el inventario, esto no alcanza:</p>
      <div className="tabla-wrap"><table>
        <thead><tr><th>Producto</th><th className="der">Pides</th><th className="der">Hay</th></tr></thead>
        <tbody>{faltantes.map((f) => <tr key={f.producto}><td><b>{f.producto}</b></td><td className="der num">{f.pedido}</td><td className="der num eco-mal"><b>{f.hay}</b></td></tr>)}</tbody>
      </table></div>
      <small>{bloqueante ? 'Esta empresa no permite facturar sin existencia: produce o ajusta el inventario antes.' : 'Si continúas, el inventario quedará en negativo y quedará constancia en la bitácora. Revisa el conteo físico y registra la producción pendiente.'}</small>
    </Modal>
  );
}
