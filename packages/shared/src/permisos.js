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
  'inv:unificado':    'Ver el inventario unificado de la empresa (menú)',
  'inv:mover':        'Registrar compras, mermas y conteos',
  'inv:recetas':      'Editar recetas',
  'inv:aprobar':      'Aprobar las diferencias de un conteo de inventario y ajustar',
  // RRHH
  'rrhh:ver':         'Ver personal',
  'rrhh:editar':      'Editar personal, horarios y vacaciones',
  'rrhh:asistencia':  'Registrar asistencia',
  'rrhh:sensible':    'Ver y editar datos sensibles del personal (salario, cuenta bancaria, identidad)',
  // Finanzas
  'fin:ver':          'Ver finanzas',
  'fin:gastos':       'Registrar gastos',
  'fin:presupuesto':  'Definir el presupuesto mensual',
  // Compras
  'compras:ver':      'Ver compras, proveedores y precios',
  'compras:editar':   'Crear, enviar y anular órdenes de compra',
  'compras:recibir':  'Recibir mercadería de una orden de compra',
  // Dirección
  'grupo:ver':        'Ver el consolidado del grupo',
  'gerente:ver':      'Ver el gerente digital (análisis de la empresa)',
  'antifraude:ver':   'Ver y gestionar el antifraude (alertas, arqueos)',
  'rep:pesar':        'Pesar gelato y recibir despachos en la sucursal',
  'rep:despachar':    'Armar despachos y pedidos hacia las sucursales',
  'rep:producir':     'Registrar producción de gelato (tandas y lotes)',
  'rep:ver':          'Ver consumo, reposición y mantenimiento',
  'rep:costeo':       'Ver y editar recetas y costeo de gelato',
  'rep:inventario':   'Ver y mover el inventario de insumos por sucursal',
  'doc:ver':          'Ver documentos de la empresa (contratos, permisos, registros)',
  'doc:editar':       'Subir, editar y borrar documentos de la empresa',
  'fab:registrar':    'Registrar producción de fábrica',
  'fab:ver':          'Ver órdenes, trazabilidad y reportes de producción',
  'fab:editar':       'Editar recetas, costos y órdenes de producción',
  'dis:salidas':      'Registrar salidas a proyecto (DISERCO)',
  'cotizaciones:ver': 'Ver y crear cotizaciones y eventos',
  // Administración
  'admin:usuarios':   'Administrar usuarios y accesos',
  'admin:empresa':    'Administrar sucursales y datos de la empresa',
  'auditoria:ver':    'Ver la bitácora de auditoría',
  'sistema:ver':      'Ver el estado del sistema y exportar copias de la empresa',
  'clientes:ver':     'Ver clientes y proveedores',
  'clientes:editar':  'Crear y editar clientes y proveedores',
  // Cobranza (EcoStone y DISERCO)
  'cobranza:ver':     'Ver cuentas por cobrar, antigüedad y estados de cuenta',
  'cobranza:gestionar': 'Registrar gestiones de cobro, promesas de pago y recordatorios',
};

const TODOS = Object.keys(PERMISOS);

export const ROLES = {
  dueno:   { nombre: 'Dueño de la empresa', permisos: TODOS },
  admin:   { nombre: 'Administrador', permisos: TODOS.filter((p) => p !== 'grupo:ver' && p !== 'sistema:ver') },   // administra SU empresa; el consolidado es de dirección
  gerente: {
    nombre: 'Manager',
    permisos: ['gerente:ver', 'pos:vender', 'pos:caja', 'pos:anular', 'pos:descuento', 'pos:reimprimir', 'pos:catalogo', 'pos:reportes',
      'kds:ver', 'inv:ver', 'inv:unificado', 'inv:mover', 'inv:recetas', 'inv:aprobar', 'rrhh:ver', 'rrhh:asistencia', 'fin:ver', 'fin:gastos', 'compras:ver', 'compras:editar', 'compras:recibir', 'fab:ver', 'fab:editar', 'fab:registrar', 'dis:salidas', 'rep:pesar', 'rep:despachar', 'rep:producir', 'rep:ver', 'rep:costeo', 'rep:inventario', 'doc:ver',
      'clientes:ver', 'clientes:editar', 'cotizaciones:ver', 'cobranza:ver', 'cobranza:gestionar'],
  },
  cajero: {
    nombre: 'Cajero',
    permisos: ['pos:vender', 'pos:caja', 'pos:descuento', 'pos:reimprimir', 'kds:ver', 'clientes:ver', 'clientes:editar', 'rrhh:asistencia'],   // caja y facturas; el pesaje es un perfil aparte
  },
  pesaje: {
    nombre: 'Pesaje de gelato (tienda)',
    permisos: ['rep:pesar', 'rrhh:asistencia'],   // se usa desde el teléfono; solo ve Pesaje
  },
  produccion: {
    nombre: 'Producción / cocina',
    permisos: ['kds:ver', 'inv:ver', 'inv:unificado', 'inv:mover', 'rrhh:asistencia', 'fab:registrar', 'fab:ver', 'rep:producir', 'rep:ver'],
  },
  prod_despacho: {
    nombre: 'Producción y despacho',
    permisos: ['kds:ver', 'inv:ver', 'inv:unificado', 'inv:mover', 'rrhh:asistencia', 'fab:registrar', 'fab:ver', 'rep:producir', 'rep:ver', 'rep:despachar', 'rep:inventario'],   // la misma persona produce y despacha
  },
  bodega: {
    nombre: 'Bodega',
    permisos: ['inv:ver', 'inv:unificado', 'inv:mover', 'rrhh:asistencia', 'fab:ver', 'dis:salidas', 'rep:despachar', 'rep:inventario', 'rep:pesar'],
  },
  gestor: {
    nombre: 'Gestor de proyectos',
    permisos: ['dis:salidas', 'inv:ver', 'inv:unificado', 'rrhh:asistencia'],   // salidas; necesita ver existencias para elegir qué sacar
  },
  ventas: {
    nombre: 'Ventas',
    permisos: ['pos:vender', 'pos:descuento', 'pos:reimprimir', 'pos:reportes', 'clientes:ver', 'clientes:editar', 'inv:ver', 'cotizaciones:ver'],
  },
  contador: {
    nombre: 'Contador',
    permisos: ['gerente:ver', 'pos:reportes', 'fin:ver', 'fin:gastos', 'fin:presupuesto', 'compras:ver', 'inv:ver', 'inv:unificado', 'clientes:ver', 'auditoria:ver', 'grupo:ver', 'doc:ver', 'cobranza:ver'],
  },
  solo_lectura: {
    nombre: 'Solo lectura',
    permisos: ['pos:reportes', 'inv:ver', 'inv:unificado', 'rrhh:ver', 'fin:ver', 'compras:ver', 'clientes:ver'],
  },
};

// Roles que PUEDEN entrar con PIN (operación de mostrador/cocina/bodega).
// Los roles de dirección exigen correo + contraseña.
export const ROLES_CON_PIN = ['cajero', 'pesaje', 'produccion', 'prod_despacho', 'bodega', 'ventas', 'gerente', 'gestor'];

/** Conjunto efectivo de permisos de un acceso. */
export function permisosDe(rol, extra = [], quitados = []) {
  const base = ROLES[rol]?.permisos ?? [];
  const set = new Set([...base, ...extra.filter((p) => p in PERMISOS)]);
  for (const q of quitados) set.delete(q);
  return set;
}

export const tienePermiso = (permisos, p) => permisos instanceof Set ? permisos.has(p) : (permisos ?? []).includes(p);
