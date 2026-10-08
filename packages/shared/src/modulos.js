// Catálogo de módulos de la plataforma. core.empresa_modulos decide cuáles
// tiene encendidos cada empresa; el permiso decide quién los ve dentro de ella.
// `nav` es el grupo del menú lateral (igual que en Italo Facturación):
// Operación · Negocio · Control · Ajustes.
export const GRUPOS_NAV = ['Operación', 'Fabricación', 'Negocio', 'Control', 'Ajustes'];

export const MODULOS = {
  // Operación
  pos:          { nav: 'Operación', nombre: 'Facturación',        descripcion: 'Cobrar y facturar',                       permiso: 'pos:vender',     ruta: 'pos',          icono: 'pos' },
  facturas:     { nav: 'Operación', nombre: 'Facturas',           descripcion: 'Listado, reimpresión y notas de crédito', permiso: 'pos:vender',     ruta: 'facturas',     icono: 'reportes' },
  cierres:      { nav: 'Operación', nombre: 'Cierre de caja',     descripcion: 'Cuadre del día por sucursal',             permiso: 'pos:vender',     ruta: 'cierres',      icono: 'dinero' },
  cotizaciones: { nav: 'Operación', nombre: 'Cotizaciones',       descripcion: 'Cotizaciones y eventos',                  permiso: 'cotizaciones:ver', ruta: 'cotizaciones', icono: 'catalogo' },
  kds:          { nav: 'Operación', nombre: 'Cocina',             descripcion: 'Pantalla de pedidos en preparación',      permiso: 'kds:ver',        ruta: 'cocina',       icono: 'cocina' },
  // Fabricación (EcoStone) — empresa con módulo 'fabrica'
  piedra:         { nav: 'Fabricación', nombre: 'Catálogo de piedra',   descripcion: 'Modelo + color, unidad de venta y listas de precio', permiso: 'pos:catalogo',  ruta: 'piedra',            icono: 'catalogo' },
  prod_registrar: { nav: 'Fabricación', nombre: 'Registrar producción', descripcion: 'Registro de producción desde el celular',          permiso: 'fab:registrar', ruta: 'registrar-produccion', icono: 'cocina' },
  prod_ordenes:   { nav: 'Fabricación', nombre: 'Órdenes y agenda',     descripcion: 'Órdenes de producción, colada, secado y calidad',  permiso: 'fab:ver',       ruta: 'produccion',        icono: 'reloj' },
  prod_recetas:   { nav: 'Fabricación', nombre: 'Recetas y costos',     descripcion: 'Insumos por m², merma y costo por m²',             permiso: 'fab:editar',    ruta: 'recetas',           icono: 'catalogo' },
  prod_insumos:   { nav: 'Fabricación', nombre: 'Insumos',              descripcion: 'Kardex, costo promedio, compras y mínimos',        permiso: 'inv:ver',       ruta: 'insumos',           icono: 'inventario' },
  prod_inventario:{ nav: 'Fabricación', nombre: 'Inventario de piedra', descripcion: 'Producto terminado por lote y calidad',            permiso: 'inv:ver',       ruta: 'inventario-piedra', icono: 'inventario' },
  prod_trazabilidad:{ nav: 'Fabricación', nombre: 'Trazabilidad de lotes', descripcion: 'Etiquetas, QR y ficha del lote',               permiso: 'fab:ver',       ruta: 'trazabilidad',      icono: 'escudo' },
  prod_reporte:   { nav: 'Fabricación', nombre: 'Reporte de producción', descripcion: 'Producido, secado, merma y consumo real vs receta', permiso: 'fab:ver',     ruta: 'reporte-produccion', icono: 'reportes' },
  // DISERCO (distribuidora) — empresa con módulo 'distribuidora'
  cot_dis:        { nav: 'Operación', nombre: 'Cotizaciones',         descripcion: 'Cotizaciones de proyecto (Excel/PDF)',               permiso: 'cotizaciones:ver', ruta: 'cotizaciones',   icono: 'catalogo' },
  dis_salidas:    { nav: 'Operación', nombre: 'Salidas a proyecto',   descripcion: 'Despacho de producto a proyectos',                   permiso: 'dis:salidas',   ruta: 'salidas',           icono: 'inventario' },
  dis_catalogo:   { nav: 'Negocio',   nombre: 'Productos',            descripcion: 'Catálogo de productos de DISERCO',                   permiso: 'inv:ver',       ruta: 'productos',         icono: 'catalogo' },
  dis_inventario: { nav: 'Negocio',   nombre: 'Inventario',           descripcion: 'Existencias de DISERCO',                             permiso: 'inv:ver',       ruta: 'inventario-d',      icono: 'inventario' },
  cot_eco:        { nav: 'Operación', nombre: 'Cotizaciones',         descripcion: 'Cotizaciones de proyecto: m², cajas, flete e instalación', permiso: 'cotizaciones:ver', ruta: 'cotizaciones', icono: 'catalogo' },
  // Negocio
  dashboard:    { nav: 'Negocio',   nombre: 'Dashboard',          descripcion: 'Ventas y números del día',                permiso: 'pos:reportes',   ruta: 'dashboard',    icono: 'dashboard' },
  gerente:      { nav: 'Negocio',   nombre: 'Gerente digital',    descripcion: 'Análisis de tus números con recomendaciones', permiso: 'gerente:ver', ruta: 'gerente',     icono: 'gerente' },
  reportes:     { nav: 'Negocio',   nombre: 'Reportes',           descripcion: 'Ventas por producto, forma de pago, cajero…', permiso: 'pos:reportes', ruta: 'reportes',    icono: 'reportes' },
  catalogo:     { nav: 'Negocio',   nombre: 'Catálogo',           descripcion: 'Productos, precios y modificadores',      permiso: 'pos:catalogo',   ruta: 'catalogo',     icono: 'catalogo' },
  clientes:     { nav: 'Negocio',   nombre: 'Clientes',           descripcion: 'Clientes y proveedores del grupo',        permiso: 'clientes:ver',   ruta: 'terceros',     icono: 'clientes' },
  caja_chica:   { nav: 'Negocio',   nombre: 'Caja chica',         descripcion: 'Entradas y salidas de efectivo',          permiso: 'pos:caja',       ruta: 'caja-chica',   icono: 'dinero' },
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
  fabrica: ['piedra', 'cot_eco', 'prod_registrar', 'prod_ordenes', 'prod_recetas', 'prod_insumos', 'prod_inventario', 'prod_trazabilidad', 'prod_reporte'],
  distribuidora: ['cot_dis', 'dis_salidas', 'dis_catalogo', 'dis_inventario'],
  antifraude: ['antifraude'],      // solo Italo y Origen; EcoStone y DISERCO no lo usan
  cotizaciones: ['cotizaciones'],
};
// Empresas de fábrica/distribuidora tienen su propio catálogo e inventario: se ocultan los genéricos.
export const MODULOS_OCULTOS_POR = { fabrica: ['catalogo', 'inventario', 'caja_chica'], distribuidora: ['catalogo', 'inventario', 'caja_chica'] };
// Siempre presentes (según permiso) en cualquier empresa.
export const MODULOS_SIEMPRE = ['admin', 'usuarios', 'sucursales', 'bitacora', 'impresora'];

/** Módulos visibles para un usuario en una empresa. */
export function modulosVisibles(modulosEmpresa, permisos) {
  const ids = new Set(MODULOS_SIEMPRE);
  for (const m of modulosEmpresa) for (const d of MODULOS_DERIVADOS[m] ?? []) ids.add(d);
  const tiene = (p) => (permisos instanceof Set ? permisos.has(p) : permisos.includes(p));
  const sinPos = !modulosEmpresa.includes('pos');
  for (const m of modulosEmpresa) for (const o of MODULOS_OCULTOS_POR[m] ?? []) ids.delete(o);
  return [...ids]
    .filter((id) => MODULOS[id] && tiene(MODULOS[id].permiso) && !(sinPos && id === 'impresora'))
    .map((id) => ({ id, ...MODULOS[id] }))
    .sort((a, b) => Object.keys(MODULOS).indexOf(a.id) - Object.keys(MODULOS).indexOf(b.id));
}
