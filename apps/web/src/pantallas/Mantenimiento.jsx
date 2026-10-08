import MantenimientoPanel from '../rinv/MantenimientoPanel.jsx';
import '../rinv/rinv.css';

/** Tablero de equipos dañados: cualquiera que note algo roto lo anota, y el técnico revisa todo de una pasada. */
export default function Mantenimiento() {
  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Mantenimiento</h1></div>
      <MantenimientoPanel />
    </div>
  );
}
