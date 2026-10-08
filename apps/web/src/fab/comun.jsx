// Piezas compartidas por las pantallas de Fabricación (EcoStone).
import { fechaHN, numero } from '@grupo/shared';
import './fab.css';

export const hoyIso = () => fechaHN();
export const cuando = (iso) => (iso ? new Date(iso).toLocaleString('es-HN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Tegucigalpa' }) : '—');
export const horaCorta = (iso) => new Date(iso).toLocaleTimeString('es-HN', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Tegucigalpa' });
export const diaCorto = (iso) => new Date(iso).toLocaleDateString('es-HN', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'America/Tegucigalpa' });
export const fechaCorta = (f) => (f ? new Date(`${String(f).slice(0, 10)}T12:00:00`).toLocaleDateString('es-HN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const n = (v, d = 0) => numero(v, d);

/** Estados de la orden con el lenguaje del dueño. */
export const ESTADO = {
  planificada: ['Por iniciar', 'info'],
  curando: ['En secado', 'aviso'],
  terminada: ['Lista para vender', 'ok'],
  cancelada: ['Cancelada', ''],
};
export const ChipEstado = ({ estado }) => {
  const [txt, tono] = ESTADO[estado] ?? [estado, ''];
  return <span className={`chip ${tono}`}>{txt}</span>;
};
export const Chip = ({ tono = '', children }) => <span className={`chip ${tono}`}>{children}</span>;

/** Piedra plana = cajas de m² por caja; esquina = cajas de esquina. */
export function textoCantidad({ cantidad, unidad_venta, m2_por_caja }) {
  if (unidad_venta === 'caja') return `${n(cantidad, 0)} cajas de esquina`;
  const porCaja = Number(m2_por_caja) || 1;
  return `${n(cantidad, 0)} cajas · ${n(cantidad * porCaja, 2)} m²`;
}
