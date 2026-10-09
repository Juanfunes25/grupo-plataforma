import { lempiras } from '@grupo/shared';
import '../fin/fin.css';

export const ESTADOS = { borrador: ['', 'Borrador'], enviada: ['info', 'Enviada'], recibida_parcial: ['aviso', 'Recibida parcial'], recibida: ['ok', 'Recibida'], cerrada: ['ok', 'Cerrada'], anulada: ['mal', 'Anulada'] };
export const ORIGEN = { inv: 'Inventario', fab: 'Materia prima', rinv_fab: 'Materia prima (gelato)', rep_suc: 'Insumo de sucursal', dis: 'Producto' };
export const EstadoOC = ({ estado }) => { const [c, t] = ESTADOS[estado] ?? ['', estado]; return <span className={`chip ${c}`}>{t}</span>; };

/** Importe en la moneda de la orden: L 1,200.00 o US$ 45.50. */
export const dinero = (n, moneda = 'HNL') => (moneda === 'USD' ? `US$ ${Number(n || 0).toLocaleString('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : lempiras(n));
export const lps = (n) => lempiras(n);
export const cant = (n) => Number(n || 0).toLocaleString('es-HN', { maximumFractionDigits: 3 });

/** Variación de precio: sube en rojo, baja en verde. */
export function Variacion({ pct, dolar }) {
  if (pct === null || pct === undefined) return <span className="tenue">primera compra</span>;
  if (pct === 0) return <span className="tenue">sin cambio</span>;
  const sube = pct > 0;
  return (
    <span className={sube ? 'cmp-var-sube' : 'cmp-var-baja'} title={sube ? 'Subió contra la compra anterior' : 'Bajó contra la compra anterior'}>
      {sube ? '▲' : '▼'} {String(Math.abs(pct)).replace('.', ',')} %
      {dolar && dolar.usd_pct !== null && <small style={{ display: 'block', color: 'var(--tenue)' }}>{dolar.usd_pct > 0 ? '+' : ''}{String(dolar.usd_pct).replace('.', ',')} % en US$ · {dolar.cambio_pct > 0 ? '+' : ''}{String(dolar.cambio_pct).replace('.', ',')} % por cambio</small>}
    </span>
  );
}
