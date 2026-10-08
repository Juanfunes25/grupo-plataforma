// Utilidades de la interfaz de personal.
import { api } from '../api.js';
export const del = (ruta, o) => api(ruta, { metodo: 'DELETE', ...o });
export const nombreDe = (e) => `${e.nombres ?? ''} ${e.apellidos ?? ''}`.trim();
export const iniciales = (e) => `${(e.nombres ?? '?')[0] ?? ''}${(e.apellidos ?? '')[0] ?? ''}`.toUpperCase();
export const fechaCorta = (f) => {
  if (!f) return '—';
  const [y, m, d] = String(f).slice(0, 10).split('-');
  const M = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${Number(d)} ${M[Number(m) - 1]} ${y}`;
};
export const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
export const DIAS_ORDEN = [1, 2, 3, 4, 5, 6, 0];   // semana de lunes a domingo (0 = domingo en la base)
export const ESTADOS = { activo: 'Activo', vacaciones: 'En vacaciones', suspendido: 'Suspendido', baja: 'Baja' };
export const claseEstado = (e) => (e === 'activo' ? 'ok' : e === 'baja' ? 'mal' : 'aviso');
export const TIPOS_CONTRATO = { indefinido: 'Indefinido', plazo_fijo: 'Plazo fijo', prueba: 'Período de prueba', temporal: 'Temporal', por_horas: 'Por horas', servicios: 'Servicios profesionales' };
export const TIPOS_PAGO = { mensual: 'Mensual', quincenal: 'Quincenal', semanal: 'Semanal', por_hora: 'Por hora' };
export const TIPOS_BAJA = { renuncia: 'Renuncia', despido: 'Despido', fin_contrato: 'Fin de contrato', abandono: 'Abandono', mutuo_acuerdo: 'Mutuo acuerdo', fallecimiento: 'Fallecimiento', otro: 'Otro' };
export const TIPOS_AUSENCIA = { dia_libre: 'Día libre', permiso: 'Permiso', ausencia: 'Ausencia', incapacidad: 'Incapacidad', tardanza: 'Llegada tarde', licencia: 'Licencia' };
export const SITUACION = { presente: ['Presente', 'ok'], tarde: ['Tarde', 'aviso'], incompleto: ['Sin salida', 'aviso'], sin_marcar: ['Sin marcar', 'mal'], vacaciones: ['Vacaciones', ''], libre: ['Libre', ''], otra_tienda: ['Otra tienda', ''], pendiente: ['Pendiente', ''], sin_horario: ['—', ''], ausencia: ['Ausencia', 'mal'], permiso: ['Permiso', ''], dia_libre: ['Día libre', ''], incapacidad: ['Incapacidad', ''], licencia: ['Licencia', ''] };
export const ESTADO_PERIODO = { vigente: ['Vigente', 'ok'], por_vencer: ['Por vencer', 'aviso'], vencido: ['Vencido', 'mal'], tomado: ['Tomado', ''] };
export const hora = (h) => (h ? String(h).slice(0, 5) : '');
export const txtDias = (n) => `${Number(n)} ${Number(n) === 1 ? 'día' : 'días'}`;
export const claseVence = (dias) => (dias == null ? '' : dias < 0 ? 'mal' : dias <= 30 ? 'aviso' : 'ok');
export const textoVence = (dias) => (dias == null ? '' : dias < 0 ? `venció hace ${-dias} d` : dias === 0 ? 'vence hoy' : `vence en ${dias} d`);

/** Redimensiona una foto a un cuadrado pequeño (JPEG) para guardarla sin Storage. */
export function fotoReducida(archivo, lado = 256) {
  return new Promise((ok, mal) => {
    const url = URL.createObjectURL(archivo);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = lado;
      const s = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, lado, lado);
      URL.revokeObjectURL(url);
      ok(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); mal(new Error('No se pudo leer la imagen')); };
    img.src = url;
  });
}
