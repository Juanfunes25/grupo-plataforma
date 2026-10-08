export function categoriaParaGramos(gramos) {
  if (gramos < 3000) return 'roja';
  if (gramos <= 5000) return 'amarilla';
  return null;
}

export function panasParaCategoria(categoria) {
  if (categoria === 'roja') return 2;
  if (categoria === 'amarilla') return 1;
  return 0;
}
