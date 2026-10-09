import { Modal } from '../ui/kit.jsx';
import { ATAJOS } from './atajos.js';

export default function AyudaAtajos({ onCerrar }) {
  return (
    <Modal titulo="Atajos del teclado" onCerrar={onCerrar} tam="ancho" pie={<button className="btn primario" autoFocus onClick={onCerrar}>Entendido</button>}>
      <small>Con pantalla táctil todo se hace tocando; con teclado, estos atajos agilizan la caja. Sirven aunque el cursor esté en la búsqueda.</small>
      <table className="pos-atajos-tabla"><tbody>
        {ATAJOS.map((a) => <tr key={a.teclas}><td><kbd>{a.teclas}</kbd></td><td>{a.texto}</td></tr>)}
      </tbody></table>
      <small>Lector de código de barras: escanea en cualquier momento, aunque no haya nada seleccionado; el producto se agrega solo.</small>
    </Modal>
  );
}
