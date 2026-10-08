// Formatos y llamadas comunes de Producción de gelato.
import { fechaHN, lempiras, numero } from '@grupo/shared';
import { api } from '../api.js';

export const hoyIso = () => fechaHN();
export const lps = (v) => (v === null || v === undefined ? '—' : lempiras(v));
export const kg = (v, d = 1) => (v === null || v === undefined ? '—' : `${numero(v, d)} kg`);
export const nf = (v, d = 0) => numero(v, d);
export const del = (ruta) => api(ruta, { metodo: 'DELETE' });
export const fechaCorta = (f) => (f ? new Date(`${String(f).slice(0, 10)}T12:00:00`).toLocaleDateString('es-HN', { weekday: 'short', day: '2-digit', month: 'short' }) : '—');
export const horaDe = (iso) => (iso ? new Date(iso).toLocaleTimeString('es-HN', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Tegucigalpa' }) : '');
export const textoDesviacion = (p) => (p === null || p === undefined ? '' : Math.abs(p) < 0.05 ? 'igual a la receta' : `${Math.abs(p)}% de ${p > 0 ? 'más' : 'menos'}`);
export const idCliente = () => (globalThis.crypto?.randomUUID?.() ?? `c${Date.now()}${Math.random().toString(16).slice(2)}`);
