// Catálogo de módulos de la plataforma. core.empresa_modulos decide cuáles
// tiene encendidos cada empresa; el permiso decide quién los ve dentro de ella.
export const MODULOS = {
  pos:        { nombre: 'Punto de venta',  descripcion: 'Cobrar, facturar y cerrar caja',        permiso: 'pos:vender',    ruta: 'pos',        icono: 'pos' },
  kds:        { nombre: 'Cocina',          descripcion: 'Pantalla de pedidos en preparación',     permiso: 'kds:ver',       ruta: 'cocina',     icono: 'cocina' },
  ventas:     { nombre: 'Ventas',          descripcion: 'Facturas, reportes y cierres',           permiso: 'pos:reportes',  ruta: 'ventas',     icono: 'reportes' },
  catalogo:   { nombre: 'Catálogo',        descripcion: 'Productos, precios y modificadores',     permiso: 'pos:catalogo',  ruta: 'catalogo',   icono: 'catalogo' },
  inventario: { nombre: 'Inventario',      descripcion: 'Insumos, recetas, compras y mermas',     permiso: 'inv:ver',       ruta: 'inventario', icono: 'inventario' },
  rrhh:       { nombre: 'Personal',        descripcion: 'Empleados, asistencia y vacaciones',     permiso: 'rrhh:ver',      ruta: 'personal',   icono: 'usuarios' },
  finanzas:   { nombre: 'Finanzas',        descripcion: 'Gastos y utilidad',                      permiso: 'fin:ver',       ruta: 'finanzas',   icono: 'dinero' },
  clientes:   { nombre: 'Clientes y proveedores', descripcion: 'Directorio común del grupo',      permiso: 'clientes:ver',  ruta: 'terceros',   icono: 'clientes' },
  grupo:      { nombre: 'Dirección',       descripcion: 'Consolidado de todas las empresas',      permiso: 'grupo:ver',     ruta: 'grupo',      icono: 'dashboard' },
  admin:      { nombre: 'Administración',  descripcion: 'Usuarios, sucursales, fiscal y auditoría', permiso: 'admin:usuarios', ruta: 'admin',    icono: 'sucursales' },
};

// Qué módulos "de base" se derivan de un módulo encendido en core.empresa_modulos.
export const MODULOS_DERIVADOS = {
  pos: ['pos', 'ventas', 'catalogo', 'clientes'],
  kds: ['kds'],
  inventario: ['inventario'],
  rrhh: ['rrhh'],
  finanzas: ['finanzas'],
  grupo: ['grupo'],
};
export const MODULOS_SIEMPRE = ['admin'];

/** Módulos visibles para un usuario en una empresa. */
export function modulosVisibles(modulosEmpresa, permisos) {
  const ids = new Set(MODULOS_SIEMPRE);
  for (const m of modulosEmpresa) for (const d of MODULOS_DERIVADOS[m] ?? []) ids.add(d);
  const tiene = (p) => (permisos instanceof Set ? permisos.has(p) : permisos.includes(p));
  return [...ids]
    .filter((id) => MODULOS[id] && (tiene(MODULOS[id].permiso) || (id === 'admin' && (tiene('admin:empresa') || tiene('auditoria:ver')))))
    .map((id) => ({ id, ...MODULOS[id] }));
}
