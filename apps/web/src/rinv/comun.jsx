// Piezas y formatos compartidos por las pantallas del inventario de reposición.
import { fechaHN } from '@grupo/shared';
import './rinv.css';

export const hoyIso = () => fechaHN();
export const SIN_CATEGORIA = 'Sin categoría';

/** Cantidades con máx. 2 decimales y sin ceros de sobra; null = «todavía no se cargó» (no es 0). */
export function cantidad(n, dec = 2) {
  if (n === null || n === undefined || n === '') return '—';
  const x = Number(n);
  return Number.isFinite(x) ? x.toLocaleString('es-HN', { maximumFractionDigits: dec }) : '—';
}
export const conUnidad = (n, u) => (u ? `${cantidad(n)} ${u}` : cantidad(n));
export const lps0 = (n) => `L ${Math.round(Number(n) || 0).toLocaleString('es-HN')}`;
export const fechaCorta = (f) => (f ? new Date(`${String(f).slice(0, 10)}T12:00:00`).toLocaleDateString('es-HN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const cuando = (iso) => (iso ? new Date(iso).toLocaleString('es-HN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'America/Tegucigalpa' }) : '—');
export function haceCuanto(iso) {
  if (!iso) return '';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return 'hace un momento';
  if (m < 60) return `hace ${m} min`;
  if (m < 1440) return `hace ${Math.round(m / 60)} h`;
  return `hace ${Math.round(m / 1440)} d`;
}

export const CATEGORIAS_SUGERIDAS = ['Ristoris', 'Materia prima gelato', 'Insumos locales/lácteos', 'Empaque para venta', 'Empaque/insumos de producción', 'Limpieza', 'Papelería y oficina', 'Equipos y utensilios'];
export const UNIDADES_PRESET = ['u', 'kg', 'g', 'L', 'lb', 'unidad'];

export const coincide = (nombre, codigo, q) => {
  const b = q.trim().toUpperCase();
  return !b || nombre.toUpperCase().includes(b) || (codigo || '').toUpperCase().includes(b);
};
export const enAlerta = (stock, min, equipo) => !equipo && stock !== null && stock !== undefined && (Number(stock) === 0 || (min != null && Number(stock) < Number(min)));

export const Chip = ({ tono = '', children, ...p }) => <span className={`chip ${tono}`} {...p}>{children}</span>;

/** Texto para descargar/compartir. */
export function descargarCsvFilas(nombre, encabezados, filas) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [encabezados.map(esc).join(','), ...filas.map((f) => f.map(esc).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: nombre });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
