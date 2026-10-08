import ExcelJS from 'exceljs';
import { DISERCO } from './config.js';

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

function valorCelda(c) {
  let v = c?.value;
  if (v == null) return null;
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if ('result' in v) v = v.result;
    else if ('text' in v) v = v.text;
    else if (v instanceof Date) return v;
  }
  return v ?? null;
}
const texto = (v) => (v == null ? '' : v instanceof Date ? '' : String(v).replace(/\r/g, '').trim());
const numeroDe = (v) => {
  if (typeof v === 'number') return v;
  const t = texto(v).replace(/[L$\s,]/g, '');
  return t !== '' && Number.isFinite(Number(t)) ? Number(t) : null;
};

const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
function parsearFecha(t) {
  const m = norm(t).match(/(\d{1,2}) de ([a-z]+) del? (\d{4})/);
  const mes = m && MESES[m[2]];
  return mes ? `${m[3]}-${String(mes).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

// Lee un Excel de cotización (formato DISERCO u otro parecido) y devuelve los datos
// listos para guardar, más los avisos de lo que no se pudo leer con certeza.
export async function leerCotizacionExcel(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('El archivo no tiene hojas');
  const avisos = [];
  const filas = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    const celdas = [];
    row.eachCell({ includeEmpty: false }, (c, col) => {
      // En celdas combinadas solo cuenta la principal.
      if (c.isMerged && c.master && c.master.address !== c.address) return;
      const v = valorCelda(c);
      if (v != null && texto(v) !== '') celdas.push({ col, v });
    });
    if (celdas.length) filas.push({ n, celdas });
  });

  // 1) Encabezado de la tabla de partidas
  let iEnc = -1;
  let cols = {};
  for (let i = 0; i < filas.length && iEnc < 0; i++) {
    const c = {};
    for (const { col, v } of filas[i].celdas) {
      const t = norm(texto(v));
      if (/^(descripcion|detalle|concepto|producto|articulo)/.test(t)) c.desc = col;
      else if (/^(area|cantidad|cant\b|cant\.)/.test(t)) c.cant = col;
      else if (/^(unidad|um$|u\/m)/.test(t)) c.unidad = col;
      else if (/^(valor|precio|p\.? ?unit|costo)/.test(t)) c.precio = col;
      else if (/^(total|importe|monto)$/.test(t)) c.total = col;
    }
    if (c.desc && c.cant && (c.precio || c.total)) { iEnc = i; cols = c; }
  }
  if (iEnc < 0) throw new Error('No encontré la tabla de partidas (columnas Descripción, Área/Cantidad, Valor/Precio y Total). Revisa que el archivo sea una cotización.');
  const encabezado = norm(filas[iEnc].celdas.map((x) => texto(x.v)).join(' '));

  // 2) Datos de cabecera (arriba de la tabla)
  const meta = {};
  let codigoOriginal = '';
  let fechaTexto = '';
  for (let i = 0; i < iEnc; i++) {
    const cs = filas[i].celdas;
    for (let k = 0; k < cs.length; k++) {
      const t = texto(cs[k].v);
      const e = norm(t).replace(/[:\s]+$/, '');
      const sig = cs[k + 1] ? texto(cs[k + 1].v) : '';
      if (e === 'proyecto') meta.proyecto = sig;
      else if (e === 'cliente') meta.cliente = sig;
      else if (/^ubicacion|^lugar|^direccion/.test(e)) meta.ubicacion = sig;
      else if (/^(telefono|tel)$/.test(e)) meta.telefono = sig;
      else if (/^(correo|email|e-mail)$/.test(e)) meta.email = sig;
      else if (/^rtn$/.test(e)) meta.rtn = sig;
      else if (/^(contacto|atencion|atn)$/.test(e)) meta.contacto = sig;
      const m = t.match(/No\.?\s*([A-Z]*)\s*(\d+)\s*-\s*(\d{2})/i);
      if (m) codigoOriginal = `${m[1]}${m[2]}-${m[3]}`.toUpperCase();
      if (/\d{1,2}\s+de\s+\w+\s+del?\s+\d{4}/i.test(t)) fechaTexto = t;
    }
  }
  if (!meta.cliente) throw new Error('No encontré el nombre del cliente (fila "Cliente:")');

  // 3) Partidas hasta la fila de "Sub total"
  const lineas = [];
  let grupo = '';
  let iFin = filas.length;
  let totalExcel = null;
  for (let i = iEnc + 1; i < filas.length; i++) {
    const f = filas[i];
    const porCol = Object.fromEntries(f.celdas.map((x) => [x.col, x.v]));
    const texts = f.celdas.map((x) => norm(texto(x.v)));
    if (texts.some((t) => /^sub ?total/.test(t))) { iFin = i; break; }
    let desc = texto(porCol[cols.desc]);
    const cant = numeroDe(porCol[cols.cant]);
    let precio = cols.precio ? numeroDe(porCol[cols.precio]) : null;
    const total = cols.total ? numeroDe(porCol[cols.total]) : null;
    if (desc && !(cant > 0) && precio == null && total == null) {
      // Fila de solo texto dentro de la tabla: continúa la descripción anterior (si empieza en minúscula) o es un grupo/título de las siguientes partidas.
      if (lineas.length && /^[a-záéíóúñ(]/.test(desc)) lineas[lineas.length - 1].descripcion += ` ${desc}`;
      else grupo = desc;
      continue;
    }
    if (!desc || !(cant > 0)) continue;
    if (grupo) { desc = `${grupo}. ${desc}`; grupo = ''; }
    if (precio == null && total != null) precio = Math.round((total / cant) * 100) / 100;
    if (precio == null) { avisos.push(`Fila ${f.n}: "${desc.slice(0, 40)}…" no tiene precio; se omitió`); continue; }
    lineas.push({ descripcion: desc, cantidad: cant, unidad: texto(porCol[cols.unidad]) || null, precio_unitario: precio });
  }
  if (!lineas.length) throw new Error('No encontré partidas con cantidad y precio en la tabla');
  for (let i = iFin; i < Math.min(filas.length, iFin + 5); i++) {
    const cs = filas[i].celdas;
    for (let k = 0; k < cs.length - 1; k++) if (/^total$/.test(norm(texto(cs[k].v)))) totalExcel = numeroDe(cs[k + 1].v);
  }

  // 4) Secciones de texto debajo de los totales
  const secciones = [];
  let actual = null;
  const resto = [];
  for (let i = iFin + 1; i < filas.length; i++) {
    const cs = filas[i].celdas;
    if (cs.some((x) => /^(sub ?total|isv|total)$/.test(norm(texto(x.v))))) continue;
    const t = texto(cs[0].v);
    if (t) resto.push(t);
  }
  const tituloBonito = (t) => (t === t.toUpperCase() ? t.toLowerCase().replace(/[a-záéíóúñ]/, (c) => c.toUpperCase()) : t);
  const esTitulo = (t) => {
    const s = t.replace(/^\*/, '');
    return !t.includes('\n') && t.length <= 60 && ((s === s.toUpperCase() && /[A-ZÁÉÍÓÚÑ]{4}/.test(s)) || /^\*?[^.]{3,50}:$/.test(t));
  };
  // Firma: las dos últimas líneas cortas, sin punto final.
  let firma = { nombre: '', cargo: '' };
  if (resto.length >= 3) {
    const [a, b] = resto.slice(-2);
    if (a.length <= 50 && b.length <= 50 && !/[.:]$/.test(a) && !/[.:]$/.test(b) && !/^[a-z0-9]\)/.test(a)) { firma = { nombre: a, cargo: b }; resto.length -= 2; }
  }
  const CONOCIDOS = /^(estructura del sistema[^:\n]*|equipo de seguridad y herramientas|forma de pago|\*?\s*no incluye[^:\n]*|ventajas de trabajar con nosotros|observaciones|comentarios adicionales|garant[ií]a de materiales|condiciones[^:\n]*)\s*:?\s*([\s\S]*)$/i;
  for (const t of resto) {
    const conocido = t.match(CONOCIDOS);
    if (conocido) {
      actual = { titulo: tituloBonito(conocido[1].trim()), texto: conocido[2].trim() };
      secciones.push(actual);
      continue;
    }
    const pago = t.match(/^forma de pago\s*:?\s*([\s\S]*)$/i);
    if (pago) { actual = { titulo: 'Forma de pago', texto: pago[1].trim() }; secciones.push(actual); continue; }
    if (esTitulo(t)) { actual = { titulo: tituloBonito(t.replace(/:$/, '')), texto: '' }; secciones.push(actual); continue; }
    if (!actual) { actual = { titulo: 'Comentarios', texto: '' }; secciones.push(actual); }
    // Línea que continúa a la anterior (empieza en minúscula o con espacio en el original)
    actual.texto += actual.texto && /^[a-záéíóúñ ]/.test(t) && !/^[a-z]\)/.test(t) && !/\n$|[.:]$/.test(actual.texto) ? ` ${t}` : (actual.texto ? '\n' : '') + t;
  }
  const todoTexto = secciones.map((s) => `${s.titulo} ${s.texto}`).join(' ');
  const mAnt = todoTexto.match(/(\d{1,3})\s*%\s*de\s*anticipo/i);
  const anticipo = mAnt ? Number(mAnt[1]) : 0;

  // 5) Tipo: con "Área"/m2 es proyecto; con cantidades enteras y sin área, productos
  const esProyecto = /area/.test(encabezado) || lineas.some((l) => /^(m2|m²|ml|global|glb)$/i.test(l.unidad ?? '')) || lineas.some((l) => !Number.isInteger(l.cantidad));
  const tipo = esProyecto ? 'proyecto' : 'productos';
  if (tipo === 'proyecto' && !meta.proyecto) { meta.proyecto = lineas[0].descripcion.slice(0, 60); avisos.push('El Excel no traía "Proyecto:"; usé el inicio de la primera partida como nombre'); }

  const calc = lineas.reduce((s, l) => s + Math.round(l.cantidad * l.precio_unitario * 100) / 100, 0);
  const totalSistema = Math.round(calc * 1.15 * 100) / 100;
  if (totalExcel != null && Math.abs(totalExcel - totalSistema) > 0.05) avisos.push(`El total del Excel (L ${totalExcel.toFixed(2)}) no coincide con el calculado (L ${totalSistema.toFixed(2)}). Revisa la cotización.`);

  const fecha = parsearFecha(fechaTexto);
  for (const sec of secciones) sec.texto = sec.texto.replace(/\n{3,}/g, '\n\n').trim();
  return { tipo, meta, lineas, secciones: secciones.filter((x) => x.texto || x.titulo), anticipo, firma, codigoOriginal, fechaTexto, fecha, avisos };
}

// Genera el Excel de una cotización con el formato de DISERCO.
export async function generarExcelCotizacion(cot) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Cotización', { pageSetup: { paperSize: 1, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.columns = [{ width: 5 }, { width: 62 }, { width: 4 }, { width: 4 }, { width: 4 }, { width: 4 }, { width: 4 }, { width: 12 }, { width: 10 }, { width: 14 }, { width: 16 }];
  const naranja = 'FF' + DISERCO.naranja.slice(1).toUpperCase();
  const fila = (n) => ws.getRow(n);
  const esProyecto = cot.tipo === 'proyecto';
  ws.mergeCells('A1:K1'); ws.getCell('A1').value = 'COTIZACIÓN'; ws.getCell('A1').font = { bold: true, size: 20, color: { argb: naranja } }; ws.getCell('A1').alignment = { horizontal: 'center' };
  ws.mergeCells('A2:K2'); ws.getCell('A2').value = `No. ${cot.codigo}`; ws.getCell('A2').alignment = { horizontal: 'center' }; ws.getCell('A2').font = { bold: true };
  const f = new Date(cot.created_at ?? Date.now());
  ws.getCell('A4').value = `San Pedro Sula, ${f.toLocaleDateString('es-HN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Tegucigalpa' })}`;
  let r = 6;
  const dato = (et, v) => { if (!v) return; ws.getCell(`A${r}`).value = et; ws.getCell(`A${r}`).font = { bold: true }; ws.getCell(`C${r}`).value = v; r++; };
  if (esProyecto) dato('Proyecto:', cot.proyecto);
  dato('Cliente:', cot.nombre_cliente);
  dato('RTN:', cot.rtn_cliente);
  dato('Ubicación:', cot.ubicacion);
  r += 1;
  const enc = r;
  ws.mergeCells(`B${enc}:G${enc}`);
  [['A', '#'], ['B', 'DESCRIPCIÓN'], ['H', esProyecto ? 'Área' : 'Cant.'], ['I', 'Unidad'], ['J', esProyecto ? 'Valor x m2' : 'Precio'], ['K', 'TOTAL']].forEach(([c, t]) => {
    const cel = ws.getCell(`${c}${enc}`); cel.value = t; cel.font = { bold: true, color: { argb: 'FFFFFFFF' } }; cel.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: naranja } }; cel.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  r = enc + 1;
  const ini = r;
  cot.lineas.forEach((l, i) => {
    ws.mergeCells(`B${r}:G${r}`);
    ws.getCell(`A${r}`).value = i + 1;
    ws.getCell(`B${r}`).value = l.presentacion ? `${l.descripcion} (${l.presentacion})` : l.descripcion;
    ws.getCell(`B${r}`).alignment = { wrapText: true, vertical: 'top' };
    ws.getCell(`H${r}`).value = Number(l.cantidad); ws.getCell(`I${r}`).value = l.unidad; ws.getCell(`J${r}`).value = Number(l.precio_unitario);
    ws.getCell(`K${r}`).value = { formula: `H${r}*J${r}`, result: Number(l.cantidad) * Number(l.precio_unitario) };
    ws.getCell(`J${r}`).numFmt = ws.getCell(`K${r}`).numFmt = '#,##0.00';
    fila(r).height = Math.max(18, Math.ceil(String(l.descripcion).length / 62) * 15);
    r++;
  });
  const fin = r - 1;
  const desc = Number(cot.descuento_pct) > 0;
  const tot = (et, formula, result) => { ws.getCell(`J${r}`).value = et; ws.getCell(`J${r}`).font = { bold: true }; ws.getCell(`K${r}`).value = { formula, result }; ws.getCell(`K${r}`).numFmt = '#,##0.00'; ws.getCell(`K${r}`).font = { bold: true }; r++; };
  const sub = r;
  tot('Sub total', `SUM(K${ini}:K${fin})`, Number(cot.subtotal));
  if (desc) { ws.getCell(`J${r}`).value = `Descuento ${cot.descuento_pct}%`; ws.getCell(`K${r}`).value = -(Number(cot.subtotal) * Number(cot.descuento_pct)) / 100; ws.getCell(`K${r}`).numFmt = '#,##0.00'; r++; }
  tot('ISV', desc ? `(K${sub}+K${sub + 1})*0.15` : `K${sub}*0.15`, Number(cot.isv));
  tot('Total', `SUM(K${sub}:K${r - 1})`, Number(cot.total));
  r += 1;
  for (const s of cot.secciones ?? []) {
    ws.mergeCells(`A${r}:K${r}`); ws.getCell(`A${r}`).value = String(s.titulo).toUpperCase(); ws.getCell(`A${r}`).font = { bold: true, color: { argb: naranja } }; r++;
    ws.mergeCells(`A${r}:K${r}`); ws.getCell(`A${r}`).value = s.texto; ws.getCell(`A${r}`).alignment = { wrapText: true, vertical: 'top' };
    fila(r).height = Math.max(18, String(s.texto).split('\n').reduce((n, ln) => n + Math.max(1, Math.ceil(ln.length / 110)), 0) * 15); r += 2;
  }
  if (cot.firma_nombre) { ws.getCell(`A${r}`).value = cot.firma_nombre; ws.getCell(`A${r}`).font = { bold: true }; r++; }
  if (cot.firma_cargo) ws.getCell(`A${r}`).value = cot.firma_cargo;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
