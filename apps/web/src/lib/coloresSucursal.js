// Color fijo por sucursal, para que un cajero nunca confunda en cuál está facturando. El color vive en core.sucursales.color
// (se elige en Sucursales); si una sucursal aún no tiene, se usa uno estable derivado de su id. Misma paleta que Italo Facturación.
export const PALETA_SUCURSALES = [
  { color: '#c5603c', nombre: 'Terracota' }, { color: '#2e9e8f', nombre: 'Verde azulado' }, { color: '#b08d28', nombre: 'Dorado' }, { color: '#6c7fd6', nombre: 'Azul' },
  { color: '#d2567a', nombre: 'Frambuesa' }, { color: '#3d9fd6', nombre: 'Celeste' }, { color: '#7fa83e', nombre: 'Lima' }, { color: '#a47bd6', nombre: 'Lila' },
];

const hash = (t) => { let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0; return h; };

/** Color de una sucursal. `sucursales` es la lista del contexto/catálogo (con `color`); sin id devuelve un gris neutro. */
export function colorSucursal(sucursales, id) {
  if (!id) return 'var(--tenue)';
  const s = (sucursales ?? []).find((x) => x.id === id);
  return s?.color || PALETA_SUCURSALES[hash(String(id)) % PALETA_SUCURSALES.length].color;
}
