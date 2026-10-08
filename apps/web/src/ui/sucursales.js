// Color de cada sucursal: el que se eligió en Sucursales, o uno estable por respaldo.
export const PALETA_SUCURSALES = [
  { color: '#c5603c', nombre: 'Terracota' }, { color: '#2e9e8f', nombre: 'Verde azulado' }, { color: '#b08d28', nombre: 'Dorado' },
  { color: '#6c7fd6', nombre: 'Azul' }, { color: '#d2567a', nombre: 'Frambuesa' }, { color: '#3d9fd6', nombre: 'Celeste' },
  { color: '#7fa83e', nombre: 'Lima' }, { color: '#a47bd6', nombre: 'Lila' },
];

export function colorDe(sucursal) {
  if (!sucursal) return 'var(--tenue)';
  if (sucursal.color) return sucursal.color;
  let h = 0;
  for (const ch of String(sucursal.id ?? sucursal.nombre ?? '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETA_SUCURSALES[h % PALETA_SUCURSALES.length].color;
}

/** Primer color de la paleta que ninguna otra sucursal usa. */
export function colorLibre(sucursales, excepto = null) {
  const usados = new Set(sucursales.filter((s) => s.activo !== false && s.id !== excepto).map((s) => s.color?.toLowerCase()).filter(Boolean));
  return PALETA_SUCURSALES.find((p) => !usados.has(p.color))?.color ?? PALETA_SUCURSALES[0].color;
}

/** «Inversiones Milano - 10 Calle» → «10 Calle»: la parte que distingue una sucursal de otra. */
export function nombreCorto(nombre) {
  const p = String(nombre ?? '').split(' - ');
  return p.length > 1 ? p.slice(1).join(' - ') : (nombre ?? '');
}
