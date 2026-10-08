// Roles y permisos del grupo. Es la ÚNICA fuente de verdad: la usan el API
// (para autorizar) y el frontend (para mostrar u ocultar). Un usuario tiene un
// rol por empresa (core.accesos) y se le pueden sumar o quitar permisos sueltos.

export const PERMISOS = {
  // Punto de venta
  'pos:vender':       'Tomar órdenes y cobrar',
  'pos:caja':         'Abrir y cerrar turno de caja',
  'pos:anular':       'Anular ventas',
  'pos:descuento':    'Aplicar descuentos',
  'pos:reimprimir':   'Reimprimir facturas',
  'pos:catalogo':     'Editar productos, precios y modificadores',
  'pos:fiscal':       'Administrar CAI y puntos de emisión',
  'pos:reportes':     'Ver reportes de ventas',
  'kds:ver':          'Ver y mover la pantalla de cocina',
  // Inventario
  'inv:ver':          'Ver inventario',
  'inv:mover':        'Registrar compras, mermas y conteos',
  'inv:recetas':      'Editar recetas',
  // RRHH
  'rrhh:ver':         'Ver personal',
  'rrhh:editar':      'Editar personal, horarios y vacaciones',
  'rrhh:asistencia':  'Registrar asistencia',
  // Finanzas
  'fin:ver':          'Ver finanzas',
  'fin:gastos':       'Registrar gastos',
  // Dirección
  'grupo:ver':        'Ver el consolidado del grupo',
  'gerente:ver':      'Ver el gerente digital (análisis de la empresa)',
  // Administración
  'admin:usuarios':   'Administrar usuarios y accesos',
  'admin:empresa':    'Administrar sucursales y datos de la empresa',
  'auditoria:ver':    'Ver la bitácora de auditoría',
  'clientes:ver':     'Ver clientes y proveedores',
  'clientes:editar':  'Crear y editar clientes y proveedores',
};

const TODOS = Object.keys(PERMISOS);

export const ROLES = {
  dueno:   { nombre: 'Dueño de la empresa', permisos: TODOS },
  admin:   { nombre: 'Administrador', permisos: TODOS.filter((p) => p !== 'grupo:ver') },   // administra SU empresa; el consolidado es de dirección
  gerente: {
    nombre: 'Manager',
    permisos: ['gerente:ver', 'pos:vender', 'pos:caja', 'pos:anular', 'pos:descuento', 'pos:reimprimir', 'pos:catalogo', 'pos:reportes',
      'kds:ver', 'inv:ver', 'inv:mover', 'inv:recetas', 'rrhh:ver', 'rrhh:asistencia', 'fin:ver', 'fin:gastos',
      'clientes:ver', 'clientes:editar'],
  },
  cajero: {
    nombre: 'Cajero',
    permisos: ['pos:vender', 'pos:caja', 'pos:descuento', 'pos:reimprimir', 'kds:ver', 'clientes:ver', 'clientes:editar', 'rrhh:asistencia'],
  },
  produccion: {
    nombre: 'Producción / cocina',
    permisos: ['kds:ver', 'inv:ver', 'inv:mover', 'rrhh:asistencia'],
  },
  bodega: {
    nombre: 'Bodega',
    permisos: ['inv:ver', 'inv:mover', 'rrhh:asistencia'],
  },
  ventas: {
    nombre: 'Ventas',
    permisos: ['pos:vender', 'pos:descuento', 'pos:reimprimir', 'pos:reportes', 'clientes:ver', 'clientes:editar', 'inv:ver'],
  },
  contador: {
    nombre: 'Contador',
    permisos: ['gerente:ver', 'pos:reportes', 'fin:ver', 'fin:gastos', 'inv:ver', 'clientes:ver', 'auditoria:ver', 'grupo:ver'],
  },
  solo_lectura: {
    nombre: 'Solo lectura',
    permisos: ['pos:reportes', 'inv:ver', 'rrhh:ver', 'fin:ver', 'clientes:ver'],
  },
};

// Roles que PUEDEN entrar con PIN (operación de mostrador/cocina/bodega).
// Los roles de dirección exigen correo + contraseña.
export const ROLES_CON_PIN = ['cajero', 'produccion', 'bodega', 'ventas', 'gerente'];

/** Conjunto efectivo de permisos de un acceso. */
export function permisosDe(rol, extra = [], quitados = []) {
  const base = ROLES[rol]?.permisos ?? [];
  const set = new Set([...base, ...extra.filter((p) => p in PERMISOS)]);
  for (const q of quitados) set.delete(q);
  return set;
}

export const tienePermiso = (permisos, p) => permisos instanceof Set ? permisos.has(p) : (permisos ?? []).includes(p);
