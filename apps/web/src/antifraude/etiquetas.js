import { fechaHoraHN, lempiras } from '@grupo/shared';

export const ESTADOS = { pendiente: 'Pendiente', investigando: 'Investigando', resuelta: 'Resuelta', falso_positivo: 'Falso positivo' };

export const ETIQUETA_TIPO = {
  'cierre.descuadre': 'Descuadre de caja',
  'cierre.patron_desvio': 'Patrón de desvío',
  'cierre.reincidencia': 'Faltantes repetidos',
  'venta.anular': 'Factura anulada',
  'venta.nota_credito': 'Nota de crédito',
  descartar_orden: 'Orden descartada',
  'venta.doble_factura': 'Posible doble factura',
  reimpresion_repetida: 'Reimpresiones repetidas',
  'orden.estacionada': 'Orden estacionada',
  'tercera_edad.carne_repetido': 'Carné repetido',
  'tercera_edad.exceso': 'Exceso de 3ª edad',
  'acceso.denegado': 'Acceso sin permiso',
  'horario.fuera': 'Fuera de horario',
  'sesion.dispositivo_nuevo': 'Dispositivo nuevo',
  'sesion.simultanea': 'Sesión simultánea',
  'sesion.login_fallido': 'Intentos de entrada fallidos',
  'producto.baja_precio': 'Baja de precio',
  'usuario.crear': 'Usuario nuevo',
  'usuario.permisos': 'Cambio de permisos',
  'cai.cambio': 'Cambio fiscal (CAI)',
  'arqueo.descuadre': 'Arqueo con diferencia',
  'bitacora.alterada': 'Bitácora alterada',
};

// Acciones tal como las guarda la bitácora (las del API usan guion bajo; las de la pantalla, punto).
export const ETIQUETA_EVENTO = {
  orden_descartada: 'Descartó una orden',
  'orden.quitar_producto': 'Quitó producto de una orden',
  'orden.descuento': 'Aplicó descuento',
  factura_reimpresa: 'Reimprimió factura',
  factura_impresa: 'Imprimió factura',
  venta_cobrada: 'Emitió factura',
  venta_anulada: 'Anuló una venta',
  nota_credito_emitida: 'Emitió nota de crédito',
  turno_abierto: 'Abrió turno',
  turno_cerrado: 'Cerró turno',
  cierre_caja: 'Cerró caja',
  arqueo_sorpresa: 'Hizo un arqueo sorpresa',
  alerta_revisada: 'Revisó una alerta',
  antifraude_reglas: 'Cambió las reglas del antifraude',
  login: 'Entró al sistema',
  login_fallido: 'Intento de entrada fallido',
  pin_fallido: 'PIN incorrecto',
  'acceso.denegado': 'Intentó entrar sin permiso',
  'sesion.inicio': 'Inició sesión',
  'sesion.fin': 'Cerró sesión',
  'sesion.bloqueo': 'Pantalla bloqueada por inactividad',
  'sesion.desbloqueo': 'Desbloqueó la pantalla',
  'sesion.desbloqueo_fallido': 'Contraseña incorrecta al desbloquear',
  'sesion.dispositivo_nuevo': 'Entró desde un dispositivo nuevo',
  'pantalla.ver': 'Abrió pantalla',
  'factura.buscar': 'Buscó facturas',
  'factura.ver': 'Vio una factura',
  'cierre.ver': 'Vio un cierre',
  'reporte.generar': 'Generó reporte',
};

export const SENSIBLES = new Set(['orden_descartada', 'orden.quitar_producto', 'orden.descuento', 'factura_reimpresa', 'venta_anulada', 'nota_credito_emitida', 'acceso.denegado',
  'sesion.desbloqueo_fallido', 'login_fallido', 'pin_fallido', 'arqueo_sorpresa']);

export function resumenEvento(e) {
  const d = e.detalle ?? {};
  switch (e.accion) {
    case 'orden.quitar_producto': return `${d.cantidad ?? 1} × ${d.producto ?? ''} (${lempiras(d.monto)})`;
    case 'orden.descuento': return `${d.porcentaje}% a ${d.cantidad} × ${d.producto}`;
    case 'orden_descartada': return `${lempiras(d.total)} · ${d.motivo ?? 'sin motivo'} · ${(d.items ?? []).join(', ')}`;
    case 'acceso.denegado': return `${d.metodo ?? ''} ${d.ruta ?? ''}${d.motivo ? ` (${d.motivo})` : ''}`;
    case 'factura_reimpresa': return `${d.factura ?? ''} · copia #${d.reimpresion_no ?? ''}${d.motivo ? ` · ${d.motivo}` : ''}`;
    case 'factura_impresa':
    case 'venta_cobrada': return `${d.factura ?? ''} · ${lempiras(d.total)}`;
    case 'venta_anulada': return `${d.factura ?? ''} · ${lempiras(d.total)} · ${d.motivo ?? ''}`;
    case 'nota_credito_emitida': return `${d.nota ?? ''} sobre ${d.factura ?? ''} · ${lempiras(d.monto)}`;
    case 'arqueo_sorpresa': return `esperado ${lempiras(d.esperado)} · contado ${lempiras(d.contado)} · diferencia ${lempiras(d.diferencia)}`;
    case 'alerta_revisada': return `${d.titulo ?? ''} → ${ESTADOS[d.estado] ?? d.estado}${d.nota ? ` · ${d.nota}` : ''}`;
    case 'pantalla.ver': return d.pantalla ?? '';
    case 'factura.buscar': return d.q ? `"${d.q}"` : `${d.desde ?? ''} a ${d.hasta ?? ''}`;
    case 'factura.ver': return `${d.factura ?? ''} · ${lempiras(d.total)}`;
    case 'login_fallido': return d.email ?? '';
    default: return '';
  }
}

export const fechaHora = (iso) => fechaHoraHN(iso);
export const horaSeg = (iso) => new Date(iso).toLocaleTimeString('es-HN', { timeZone: 'America/Tegucigalpa', hour: '2-digit', minute: '2-digit', second: '2-digit' });
