import { Modal } from '../ui/kit.jsx';

// Aviso cuando se va a facturar o sacar material sin existencia suficiente. Deja continuar (queda en negativo y se registra) o cancelar.
export default function AvisoSinStock({ faltantes, accion = 'facturar', onContinuar, onCancelar }) {
  return (
    <Modal titulo="No hay existencia suficiente" tam="angosto" onCerrar={onCancelar}
      pie={<><button className="btn" onClick={onCancelar}>Cancelar</button><button className="btn primario" onClick={onContinuar}>Sí, {accion} de todos modos</button></>}>
      <div className="aviso-caja">Según el inventario, esto no alcanza:</div>
      <table>
        <thead><tr><th>Producto</th><th className="der">Pides</th><th className="der">Hay</th></tr></thead>
        <tbody>{faltantes.map((x) => <tr key={x.producto}><td><strong>{x.producto}</strong></td><td className="der num">{x.pedido}</td><td className="der num" style={{ color: 'var(--peligro)', fontWeight: 700 }}>{x.hay}</td></tr>)}</tbody>
      </table>
      <small>Si continúas, el inventario quedará en negativo y quedará registrado en la bitácora. Revisa el conteo físico y registra la compra pendiente.</small>
    </Modal>
  );
}
