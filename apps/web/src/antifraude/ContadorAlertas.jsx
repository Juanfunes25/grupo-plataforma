import { useAlertasPendientes } from './pendientes.js';
import './antifraude.css';

/** Globito con las alertas abiertas, para el menú lateral. */
export default function ContadorAlertas() {
  const { pendientes, altas } = useAlertasPendientes(true);
  if (!pendientes) return null;
  return <span className={`af-contador${altas ? ' alta' : ''}`} title={`${pendientes} alerta(s) por revisar${altas ? `, ${altas} grave(s)` : ''}`}>{pendientes > 99 ? '99+' : pendientes}</span>;
}
