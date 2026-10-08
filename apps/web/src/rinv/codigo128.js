// Código de barras Code 128 (set B) como SVG, sin librerías: para imprimir la etiqueta de un insumo.
const PATRONES = ['212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212','112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131','311222','321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321','112313','132113','132311','211313','231113','231311','112133','112331','132131','113123','113321','133121','313121','211331','231131','213113','213311','213131','311123','311321','331121','312113','312311','332111','314111','221411','431111','111224','111422','121124','121421','141122','141221','112214','112412','122114','122411','142112','142211','241211','221114','413111','241112','134111','111242','121142','121241','114212','124112','124211','411212','421112','421211','212141','214121','412121','111143','111341','131141','114113','114311','411113','411311','113141','114131','311141','411131','211412','211214','211232','2331112'];

/** Devuelve el SVG, o null si el texto trae caracteres que Code 128-B no puede representar. */
export function svgCode128(texto, { alto = 60, modulo = 1.6 } = {}) {
  const t = String(texto);
  if (!t || [...t].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126)) return null;
  const codigos = [104, ...[...t].map((c) => c.charCodeAt(0) - 32)];
  const suma = codigos.reduce((a, c, i) => a + c * (i === 0 ? 1 : i), 0);
  codigos.push(suma % 103, 106);
  let x = 10; const barras = [];
  for (const c of codigos) {
    const p = PATRONES[c];
    for (let i = 0; i < p.length; i++) {
      const w = Number(p[i]) * modulo;
      if (i % 2 === 0) barras.push(`<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${alto}" />`);
      x += w;
    }
  }
  const ancho = x + 10;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ancho.toFixed(1)} ${alto + 16}" width="${ancho.toFixed(0)}" height="${alto + 16}"><g fill="#000">${barras.join('')}</g><text x="${(ancho / 2).toFixed(1)}" y="${alto + 13}" font-size="11" text-anchor="middle" font-family="monospace">${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text></svg>`;
}
