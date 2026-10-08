// Módulo de Documentos: tipos por defecto, grupos y expectativas por tipo de negocio.
// Es la fuente de verdad para el API (siembra de doc.tipos por empresa) y para la web (etiquetas).

export const MAX_ARCHIVO_BYTES = 15 * 1024 * 1024;           // 15 MB por archivo
export const EXTENSIONES_DOC = ['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'doc', 'docx', 'xls', 'xlsx'];

export const GRUPOS_DOC = {
  legal: 'Legal y registros', sanitario: 'Sanitario y operación', inmueble: 'Inmuebles y contratos',
  laboral: 'Personal', finanzas: 'Seguros y finanzas', otro: 'Otros',
};

// codigo, nombre, grupo, vence (pide fecha de vencimiento), confidencial, dias_aviso, de_empleado
const T = (codigo, nombre, grupo, vence, extra = {}) => ({ codigo, nombre, grupo, requiere_vencimiento: vence, confidencial: false, dias_aviso: 30, de_empleado: false, ...extra });

export const TIPOS_DOC = [
  T('contrato_arrendamiento', 'Contrato de arrendamiento', 'inmueble', true, { dias_aviso: 90 }),
  T('permiso_operacion', 'Permiso de operación', 'sanitario', true, { dias_aviso: 60 }),
  T('arsa_permiso', 'Permiso / licencia ARSA (Agencia de Regulación Sanitaria)', 'sanitario', true, { dias_aviso: 60 }),
  T('licencia_manipulacion', 'Licencia sanitaria de manipulación de alimentos', 'sanitario', true, { dias_aviso: 30 }),
  T('registro_sanitario', 'Registro sanitario', 'sanitario', true, { dias_aviso: 60 }),
  T('licencia_municipal', 'Licencia municipal / permiso de la alcaldía', 'legal', true, { dias_aviso: 45 }),
  T('licencia_ambiental', 'Licencia ambiental', 'legal', true, { dias_aviso: 60 }),
  T('registro_mercantil', 'Registro mercantil', 'legal', false),
  T('rtn_sar', 'RTN y constancias del SAR', 'legal', true, { dias_aviso: 30 }),
  T('poliza_seguro', 'Póliza de seguro', 'finanzas', true, { dias_aviso: 45 }),
  T('contrato_proveedor', 'Contrato con proveedor', 'inmueble', true, { dias_aviso: 45 }),
  T('contrato_empleado', 'Contrato de empleado', 'laboral', false, { confidencial: true, de_empleado: true }),
  T('identidad_empleado', 'Identidad del empleado', 'laboral', true, { confidencial: true, de_empleado: true, dias_aviso: 60 }),
  T('escritura_propiedad', 'Escritura / propiedad', 'legal', false),
  T('certificado_otro', 'Certificado u otro', 'otro', false),
];

// Qué se espera tener, por tipo de negocio (core.empresas.tipo_negocio). [codigo, porSucursal]
const ALIMENTOS = [['arsa_permiso', true], ['licencia_manipulacion', true], ['permiso_operacion', true], ['contrato_arrendamiento', true], ['licencia_municipal', true], ['poliza_seguro', false], ['registro_mercantil', false], ['rtn_sar', false]];
export const ESPERADOS_DOC = {
  gelateria: ALIMENTOS,
  fruteria: ALIMENTOS,
  fabrica: [['permiso_operacion', false], ['licencia_ambiental', false], ['licencia_municipal', false], ['contrato_arrendamiento', true], ['poliza_seguro', false], ['registro_mercantil', false], ['rtn_sar', false]],
  distribuidora: [['permiso_operacion', false], ['licencia_municipal', false], ['contrato_arrendamiento', true], ['poliza_seguro', false], ['registro_mercantil', false], ['rtn_sar', false]],
  holding: [['registro_mercantil', false], ['rtn_sar', false], ['licencia_municipal', false]],
  comercio: [['permiso_operacion', false], ['licencia_municipal', false], ['registro_mercantil', false], ['rtn_sar', false]],
};

/** Tipos de una empresa nueva con su checklist según el tipo de negocio. */
export function tiposPorDefecto(tipoNegocio) {
  const esp = new Map((ESPERADOS_DOC[tipoNegocio] ?? ESPERADOS_DOC.comercio).map(([c, s]) => [c, s]));
  return TIPOS_DOC.map((t, i) => ({ ...t, orden: i + 1, esperado: esp.has(t.codigo), por_sucursal: esp.get(t.codigo) === true }));
}

export const ESTADOS_DOC = { vigente: 'Vigente', por_vencer: 'Por vencer', vencido: 'Vencido', archivado: 'Archivado' };
export const CONFIDENCIALIDAD_DOC = { normal: 'Normal', restringido: 'Restringido (solo dueño y administrador)' };

/** Tipos de archivo permitidos para el atributo accept del navegador. */
export const ACCEPT_DOC = '.pdf,.jpg,.jpeg,.png,.gif,.webp,.doc,.docx,.xls,.xlsx,application/pdf,image/*';
