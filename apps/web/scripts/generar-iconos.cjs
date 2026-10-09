// Genera los iconos PNG de la app (192, 512, maskable 512 y apple-touch 180) por empresa a partir de las marcas vectoriales
// de ui/Logo.jsx y del logo real de DISERCO. Se corre a mano cuando cambia un logo:
//   NODE_PATH=<carpeta con playwright-core> node apps/web/scripts/generar-iconos.cjs
// Los PNG quedan en apps/web/public/icons (se versionan; no se generan en el build).
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const OUT = path.join(__dirname, '..', 'public', 'icons');
const FONDO = '#0e1320';
const mezclaBlanco = (hex, p) => {
  const n = parseInt(hex.slice(1), 16); const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * p + 255 * (1 - p)));
  return `rgb(${c.join(',')})`;
};
const MARCAS = {
  italo: { color: '#c5603c', svg: (c) => `<circle cx="32" cy="27.5" r="19" fill="none" stroke="${c}" stroke-width="8.3"/><rect x="12.8" y="53" width="38.4" height="8.3" rx="1.7" fill="${c}"/>` },
  origen: { color: '#5c9a3a', svg: (c) => `<circle cx="32" cy="34" r="22" fill="none" stroke="${c}" stroke-width="4"/><path d="M32 54V30" stroke="${c}" stroke-width="4" stroke-linecap="round"/><path d="M32 34c0-9 6-14 15-14 0 9-6 14-15 14z" fill="${c}"/><path d="M32 40c0-7-5-11-12-11 0 7 5 11 12 11z" fill="${c}" opacity=".65"/>` },
  ecostone: { color: '#4f6b3c', svg: (c) => `<rect x="6" y="36" width="24" height="16" rx="3" fill="${c}"/><rect x="34" y="36" width="24" height="16" rx="3" fill="${c}" opacity=".7"/><rect x="20" y="14" width="24" height="18" rx="3" fill="${c}" opacity=".85"/>` },
  grupo: { color: '#c9a227', svg: (c) => `<circle cx="32" cy="14" r="8" fill="${c}"/><circle cx="14" cy="46" r="8" fill="${c}" opacity=".8"/><circle cx="50" cy="46" r="8" fill="${c}" opacity=".6"/><path d="M32 22 18 40M32 22l14 18M22 46h20" stroke="${c}" stroke-width="3" fill="none"/>` },
  base: { color: '#c9a227', svg: () => `<circle cx="32" cy="29" r="15" fill="none" stroke="#c9a227" stroke-width="7"/><rect x="16" y="49" width="32" height="7" rx="2" fill="#c5603c"/>` },
};
const dis = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '..', 'public', 'logos', 'diserco.png')).toString('base64');

// escala = parte del lienzo que ocupa la marca; redondo = esquinas redondeadas (icono "any"); el maskable va a sangre completa.
function pagina(codigo, tam, escala, redondo) {
  const m = MARCAS[codigo];
  let fondo = FONDO; let interior;
  if (codigo === 'diserco') { fondo = '#e8762b'; interior = `<img src="${dis}" style="width:${escala * 100}%;position:absolute;left:${(1 - escala) * 50}%;top:50%;transform:translateY(-50%)">`; }
  else {
    const lado = tam * escala; const c = mezclaBlanco(m.color, 0.88);
    interior = `<svg viewBox="0 0 64 64" width="${lado}" height="${lado}" style="position:absolute;left:${(tam - lado) / 2}px;top:${(tam - lado) / 2}px">${m.svg(c)}</svg>`;
  }
  return `<html><body style="margin:0;background:transparent"><div style="position:relative;width:${tam}px;height:${tam}px;background:${fondo};border-radius:${redondo ? tam * 0.22 : 0}px;overflow:hidden">${interior}</div></body></html>`;
}

(async () => {
  const br = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const codigos = ['italo', 'origen', 'ecostone', 'diserco', 'grupo', 'base'];
  for (const codigo of codigos) {
    const trabajos = [[`${codigo}-192.png`, 192, 0.7, true], [`${codigo}-512.png`, 512, 0.7, true], [`${codigo}-maskable-512.png`, 512, 0.56, false], [`${codigo}-180.png`, 180, 0.64, false]];
    for (const [nombre, tam, esc, red] of trabajos) {
      const p = await br.newPage({ viewport: { width: tam, height: tam } });
      await p.setContent(pagina(codigo, tam, codigo === 'diserco' ? esc + 0.1 : esc, red));
      await p.waitForTimeout(150);
      await p.screenshot({ path: path.join(OUT, nombre), omitBackground: true });
      await p.close();
    }
  }
  await br.close();
  console.log('Iconos listos en', OUT);
})();
