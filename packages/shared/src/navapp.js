// Barra inferior tipo app (celular y tablet): Inicio · hasta 3 accesos según el rol · Más.
// Inicio y Más los pone la pantalla; aquí se eligen los accesos del medio con los módulos y permisos del usuario.
import { MODULOS } from './modulos.js';
import { inicioGelato } from './gelato.js';

// [id de módulo, etiqueta corta, ícono]. El orden es la prioridad.
const PRINCIPALES = [
  ['rep_tablero', 'Tablero', 'dashboard'], ['pos', 'Facturar', 'pos'], ['rep_despacho', 'Despacho', 'pos'], ['rep_pesaje', 'Pesaje', 'inventario'],
  ['prod_registrar', 'Producción', 'cocina'], ['rep_produccion', 'Producción', 'cocina'], ['dis_salidas', 'Salidas', 'inventario'],
  ['cot_eco', 'Cotizar', 'catalogo'], ['cot_dis', 'Cotizar', 'catalogo'], ['cotizaciones', 'Cotizar', 'catalogo'], ['kds', 'Cocina', 'cocina'], ['prod_ordenes', 'Órdenes', 'reloj'],
];
const SECUNDARIOS = [
  ['antifraude', 'Alertas', 'escudo', true], ['dashboard', 'Números', 'dashboard'], ['cierres', 'Cierre', 'dinero'],
  ['inventario', 'Inventario', 'inventario'], ['dis_inventario', 'Inventario', 'inventario'], ['prod_inventario', 'Inventario', 'inventario'], ['facturas', 'Facturas', 'reportes'],
];

const ES_HOME = Object.fromEntries([...PRINCIPALES, ...SECUNDARIOS].map(([id, nombre, icono]) => [id, [nombre, icono]]));
const aIds = (modulos) => new Set((modulos ?? []).map((m) => (typeof m === 'string' ? m : m.id)));

/** Módulo al que cae el usuario al entrar a su empresa (misma regla que la pantalla de inicio). null = no hay módulos: se muestra el menú. */
export function moduloInicio(modulos, permisos, ahora = new Date()) {
  const lista = (modulos ?? []).map((m) => (typeof m === 'string' ? { id: m, ...MODULOS[m] } : { ...MODULOS[m.id], ...m }));
  const g = inicioGelato(modulos, permisos, ahora);
  if (g) return lista.find((m) => m.ruta === g)?.id ?? null;
  return (lista.find((m) => m.id === 'pos') ?? lista.find((m) => m.nav === 'Operación') ?? lista.find((m) => m.nav === 'Negocio'))?.id ?? null;
}

/**
 * Accesos de la barra inferior (sin «Más», que lo agrega la pantalla): primero el inicio del rol (con el nombre de lo que hace:
 * Facturar, Tablero, Pesaje…; «Inicio» si no es una tarea), luego hasta 3 accesos según el rol. Total máximo 4.
 * @returns [{ id, nombre, ruta, icono, alertas?, inicio? }] con ruta relativa a la empresa ('' = pantalla de inicio)
 */
export function accesosApp(modulos, permisos, ahora = new Date()) {
  const ids = aIds(modulos);
  const idIni = moduloInicio(modulos, permisos, ahora);
  const [nomIni, icoIni] = ES_HOME[idIni] ?? ['Inicio', 'casa'];
  const salida = [idIni ? { id: idIni, nombre: nomIni, ruta: MODULOS[idIni].ruta, icono: icoIni, inicio: true } : { id: 'inicio', nombre: 'Inicio', ruta: '', icono: 'casa', inicio: true }];
  const vistos = new Set([nomIni, idIni]);
  const principales = PRINCIPALES.filter(([id]) => ids.has(id));
  const sec = SECUNDARIOS.filter(([id]) => ids.has(id));
  const meter = ([id, nombre, icono, alertas]) => {
    if (salida.length >= 4 || vistos.has(nombre) || vistos.has(id) || !MODULOS[id]) return;
    vistos.add(nombre); vistos.add(id); salida.push({ id, nombre, ruta: MODULOS[id].ruta, icono, ...(alertas ? { alertas: true } : {}) });
  };
  // Un principal más y uno de seguimiento (alertas / números); si faltan, completan los demás.
  principales.slice(0, 3).forEach((p) => { if (salida.length < 3) meter(p); });
  sec.slice(0, 1).forEach(meter);
  principales.forEach(meter);
  sec.forEach(meter);
  return salida;
}
