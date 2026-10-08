// Catálogo de módulos de la plataforma. core.empresa_modulos decide cuáles
// tiene encendidos cada empresa; el permiso decide quién los ve dentro de ella.
// `nav` es el grupo del menú lateral (igual que en Italo Facturación):
// Operación · Negocio · Control · Ajustes.
export const GRUPOS_NAV = ['Operación', 'Negocio', 'Control', 'Ajustes'];

export const MODULOS = {
  // Operación
  pos:          { nav: 'Operación', nombre: 'Facturación',        descripcion: 'Cobrar y facturar',                       permiso: 'pos:vender',     ruta: 'pos',          icono: 'pos' },
  facturas:     { nav: 'Operación', nombre: 'Facturas',           descripcion: 'Listado, reimpresión y notas de crédito', permiso: 'pos:reportes',   ruta: 'facturas',     icono: 'reportes' },
  cierres:      { nav: 'Operación', nombre: 'Cierre de caja',     descripcion: 'Cuadre del día por sucursal',             permiso: 'pos:vender',     ruta: 'cierres',      icono: 'dinero' },
  cotizaciones: { nav: 'Operación', nombre: 'Cotizaciones',       descripcion: 'Cotizaciones y eventos',                  permiso: 'cotizaciones:ver', ruta: 'cotizaciones', icono: 'catalogo' },
  kds:          { nav: 'Operación', nombre: 'Cocina',             descripcion: 'Pantalla de pedidos en preparación',      permiso: 'kds:ver',        ruta: 'cocina',       icono: 'cocina' },
  // Negocio
  dashboard:    { nav: 'Negocio',   nombre: 'Dashboard',          descripcion: 'Ventas y números del día',                permiso: 'pos:reportes',   ruta: 'dashboard',    icono: 'dashboard' },
  gerente:      { nav: 'Negocio',   nombre: 'Gerente digital',    descripcion: 'Análisis de tus números con recomendaciones', permiso: 'gerente:ver', ruta: 'gerente',     icono: 'gerente' },
  reportes:     { nav: 'Negocio',   nombre: 'Reportes',           descripcion: 'Ventas por producto, forma de pago, cajero…', permiso: 'pos:reportes', ruta: 'reportes',    icono: 'reportes' },
  catalogo:     { nav: 'Negocio',   nombre: 'Catálogo',           descripcion: 'Productos, precios y modificadores',      permiso: 'pos:catalogo',   ruta: 'catalogo',     icono: 'catalogo' },
  clientes:     { nav: 'Negocio',   nombre: 'Clientes',           descripcion: 'Clientes y proveedores del grupo',        permiso: 'clientes:ver',   ruta: 'terceros',     icono: 'clientes' },
  caja_chica:   { nav: 'Negocio',   nombre: 'Caja chica',         descripcion: 'Entradas y salidas de efectivo',          permiso: 'pos:reportes',   ruta: 'caja-chica',   icono: 'dinero' },
  inventario:   { nav: 'Negocio',   nombre: 'Inventario',         descripcion: 'Insumos, recetas, compras y mermas',      permiso: 'inv:ver',        ruta: 'inventario',   icono: 'inventario' },
  rrhh:         { nav: 'Negocio',   nombre: 'Personal',           descripcion: 'Empleados, asistencia y vacaciones',      permiso: 'rrhh:ver',       ruta: 'personal',     icono: 'usuarios' },
  finanzas:     { nav: 'Negocio',   nombre: 'Finanzas',           descripcion: 'Gastos y utilidad',                       permiso: 'fin:ver',        ruta: 'finanzas',     icono: 'dinero' },
  // Control
  antifraude:   { nav: 'Control',   nombre: 'Antifraude',         descripcion: 'Alertas, arqueos y vigilancia de caja',   permiso: 'antifraude:ver', ruta: 'antifraude',   icono: 'escudo' },
  bitacora:     { nav: 'Control',   nombre: 'Bitácora',           descripcion: 'Registro inalterable de acciones',        permiso: 'auditoria:ver',  ruta: 'bitacora',     icono: 'reloj' },
  cai:          { nav: 'Control',   nombre: 'CAI / Emisión',      descripcion: 'CAI y puntos de emisión',                 permiso: 'pos:fiscal',     ruta: 'cai',          icono: 'impresora' },
  usuarios:     { nav: 'Control',   nombre: 'Usuarios',           descripcion: 'Usuarios, roles y accesos',               permiso: 'admin:usuarios', ruta: 'usuarios',     icono: 'usuarios' },
  sucursales:   { nav: 'Control',   nombre: 'Sucursales',         descripcion: 'Sucursales y datos de la empresa',        permiso: 'admin:empresa',  ruta: 'sucursales',   icono: 'sucursales' },
  // Ajustes
  impresora:    { nav: 'Ajustes',   nombre: 'Impresora',          descripcion: 'Ticket y prueba de impresión',            permiso: 'pos:vender',     ruta: 'impresora',    icono: 'impresora' },
  admin:        { nav: 'Ajustes',   nombre: 'Administración',     descripcion: 'Módulos, fiscal y auditoría',             permiso: 'admin:usuarios', ruta: 'admin',        icono: 'sucursales' },
  // Dirección NO es módulo de empresa: vive solo en /grupo.
  grupo:        { nav: null,        nombre: 'Dirección',          descripcion: 'Consolidado de todas las empresas',       permiso: 'grupo:ver',      ruta: 'grupo',        icono: 'dashboard' },
};

// Qué módulos "de base" se derivan de un módulo encendido en core.empresa_modulos.
export const MODULOS_DERIVADOS = {
  pos: ['pos', 'facturas', 'cierres', 'dashboard', 'reportes', 'catalogo', 'clientes', 'caja_chica', 'gerente', 'cai'],
  kds: ['kds'],
  inventario: ['inventario'],
  rrhh: ['rrhh'],
  finanzas: ['finanzas'],
  antifraude: ['antifraude'],      // solo Italo y Origen; EcoStone y DISERCO no lo usan
  cotizaciones: ['cotizaciones'],
};
// Siempre presentes (según permiso) en cualquier empresa.
export const MODULOS_SIEMPRE = ['admin', 'usuarios', 'sucursales', 'bitacora', 'impresora'];

/** Módulos visibles para un usuario en una empresa. */
export function modulosVisibles(modulosEmpresa, permisos) {
  const ids = new Set(MODULOS_SIEMPRE);
  for (const m of modulosEmpresa) for (const d of MODULOS_DERIVADOS[m] ?? []) ids.add(d);
  const tiene = (p) => (permisos instanceof Set ? permisos.has(p) : permisos.includes(p));
  const sinPos = !modulosEmpresa.includes('pos');
  return [...ids]
    .filter((id) => MODULOS[id] && tiene(MODULOS[id].permiso) && !(sinPos && id === 'impresora'))
    .map((id) => ({ id, ...MODULOS[id] }))
    .sort((a, b) => Object.keys(MODULOS).indexOf(a.id) - Object.keys(MODULOS).indexOf(b.id));
}
