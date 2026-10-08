// Siembra de datos reales de Italo para el inventario de reposición. TODO es idempotente:
// se puede correr cuantas veces haga falta sin duplicar nada ni pisar lo que ya se movió.
//
//   · catálogo de materia prima (303 insumos con su precio vigente, migrados de costeo)
//   · catálogo Ristoris (68 productos, precio por envase en lempiras = precio en euros × 31)
//   · primer conteo físico de Ristoris (17/09/2026) como ENTRADA en el kardex
//   · ventas de Ristoris del 17/09 al 07/10 como SALIDA en el kardex (nunca deja stock negativo)
//   · catálogo de insumos/empaques de sucursal (vasos, servilletas, limpieza…)
//   · checklist de apertura y cierre (solo si la empresa no tiene uno)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pesoDesdeNombre, redondearSaldo } from './calculo.js';

const carpeta = path.join(path.dirname(fileURLToPath(import.meta.url)), 'datos');
const leer = (nombre) => JSON.parse(fs.readFileSync(path.join(carpeta, nombre), 'utf8'));

const FECHA_CONTEO = '2026-09-17';
const ARCHIVO_VENTAS = 'ristoris-ventas-2026-09-17-a-2026-10-07.json';
const fechaCorta = (iso) => iso.split('-').reverse().join('/');

/** Insumos de sucursal frecuentes, tomados de pedidos reales por WhatsApp. */
export const INSUMOS_SUCURSAL = [
  'Leche normal', 'Leche deslactosada', 'Leche orgánica', 'Leche descremada', 'Leche de almendra', 'Leche de avena',
  'Detergente', 'Cloro', 'Jabón de trastes', 'Limpia vidrios', 'Guantes negros', 'Guantes de servir transparentes', 'Trapos para limpieza',
  'Bolsas para basura', 'Ace', 'Papel toalla', 'Papel higiénico', 'Papel de impresora', 'Papel transparente',
  'Bolsas de papel para llevar', 'Bolsas para empacar conos', 'Bolsas para empacar waffles',
  'Servilletas pequeñas', 'Servilletas para dispensadores grandes', 'Servilletas de mano',
  'Conos', 'Canastas', 'Copas clásicas', 'Copas pícolas', 'Tapaderas clásicas', 'Tapaderas grandes', 'Tapaderas pícolas',
  'Portavasos', 'Vasos de malteada', 'Vasquetas de 1kg', 'Vasquetas XXL', 'Panas para llevar los waffles', 'Cucharas verdes', 'Agarraderas para vasquetas',
  'Café en grano', 'Pistachio en grano', 'Pistachio dulce', 'Fresas', 'Bananos', 'Nutella', 'Azúcar glass',
  'Kataifi suelto', 'Kataifi tostado', 'Kataifi variegato', 'Jalea de arándanos', 'Jalea de piña', 'Jalea de guayaba',
  'Variegato de Dubái', 'Variegato de limón (verde)', 'Variegato de guayaba', 'Variegato de pretzel', 'Variegato de brezel',
  'Variegato cookies limón merengue', 'Variegato de kataifi', 'Stracciatella', 'Insta crumble caramelo',
  'Aceite para engrasar waffleras', 'Pan', 'Pan de chocolate', 'Pan de zanahoria y banano', 'Brownie', 'Galletas con logo',
  'Galleta crocante', 'Galletas de mantequilla', 'Galletas de avena y mantequilla', 'Agua', 'Cambio para caja',
];

const CHECKLIST = {
  apertura: ['Temperatura de la vitrina correcta', 'Vitrina limpia y sabores presentados', 'Máquina de café encendida y limpia', 'Molino con café y calibrado',
    'Fuente de pistacho llena y limpia', 'Aire acondicionado encendido', 'Caja con cambio suficiente', 'Mesas, piso y baño limpios'],
  cierre: ['Vitrina tapada y freezer cerrado', 'Máquina de café limpia y apagada', 'Molino limpio', 'Fuente de pistacho lavada y guardada',
    'Aire acondicionado apagado', 'Caja cuadrada y guardada', 'Basura sacada', 'Luces apagadas y puertas con llave'],
};

/** Inserta insumos de fábrica + su precio vigente (en bloque). Devuelve cuántos nuevos. */
async function insertarCatalogo(q, empresaId, lista) {
  const nombres = lista.map((i) => i.nombre.trim().toUpperCase());
  const antes = (await q.query('select count(*)::int as n from rinv.insumos_fab where empresa_id = $1', [empresaId])).rows[0].n;
  await q.query(
    `insert into rinv.insumos_fab (empresa_id, nombre, descripcion, tipo, part_number, unidad, categoria, peso_unitario)
     select $1, x.nombre, x.descripcion, x.tipo, x.pn, x.unidad, x.categoria, x.peso
       from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::numeric[])
            as x(nombre, descripcion, tipo, pn, unidad, categoria, peso)
     on conflict (empresa_id, nombre) do nothing`,
    [empresaId, nombres, lista.map((i) => i.descripcion ?? null), lista.map((i) => i.tipo), lista.map((i) => i.part_number ?? null),
      lista.map((i) => i.unidad), lista.map((i) => i.categoria ?? null), lista.map((i) => i.peso_unitario ?? null)]);
  const despues = (await q.query('select count(*)::int as n from rinv.insumos_fab where empresa_id = $1', [empresaId])).rows[0].n;

  const conPrecio = lista.map((i, k) => ({ ...i, nombre: nombres[k] })).filter((i) => i.lps_kg !== null && i.lps_kg !== undefined);
  const r = await q.query(
    `insert into rinv.precios_fab (empresa_id, insumo_id, fecha_vigencia, lps_kg, usd_kg, fuente, factura_ref)
     select $1, i.id, x.fecha::date, x.lps, x.usd, x.fuente, x.ref
       from unnest($2::text[], $3::text[], $4::numeric[], $5::numeric[], $6::text[], $7::text[]) as x(nombre, fecha, lps, usd, fuente, ref)
       join rinv.insumos_fab i on i.empresa_id = $1 and i.nombre = x.nombre
      where not exists (select 1 from rinv.precios_fab p where p.insumo_id = i.id and p.fecha_vigencia = x.fecha::date and p.lps_kg = x.lps)`,
    [empresaId, conPrecio.map((i) => i.nombre), conPrecio.map((i) => i.fecha_vigencia), conPrecio.map((i) => i.lps_kg),
      conPrecio.map((i) => i.usd_kg ?? null), conPrecio.map((i) => i.fuente), conPrecio.map((i) => i.factura_ref ?? null)]);
  return { insumosCreados: despues - antes, insumosTotal: lista.length, preciosCreados: r.rowCount };
}

/** Los 303 insumos de costeo. Materia prima Mec3 se cuenta por bote («unidad», con el peso leído del nombre); los locales, por kg. */
export async function sembrarCatalogoFabrica(q, empresaId) {
  const datos = leer('costeo-insumos.json');
  return insertarCatalogo(q, empresaId, datos.map((i) => ({
    ...i,
    unidad: i.tipo === 'mec3' ? 'unidad' : 'kg',
    peso_unitario: i.tipo === 'mec3' ? pesoDesdeNombre(i.nombre) : null,
  })));
}

/** Catálogo Ristoris: nombre en italiano (como viene en el empaque), descripción en español, precio por envase. */
export async function sembrarRistoris(q, empresaId) {
  const datos = leer('ristoris-insumos.json');
  return insertarCatalogo(q, empresaId, datos);
}

/** Primer conteo físico de Ristoris como entrada de stock. El desglose por tienda queda en el motivo. */
export async function cargarStockRistoris(q, empresaId) {
  const datos = leer('ristoris-stock.json');
  const insumos = (await q.query(`select id, nombre, part_number, stock_actual from rinv.insumos_fab where empresa_id = $1 and categoria = 'Ristoris'`, [empresaId])).rows;
  const porCodigo = new Map(insumos.map((i) => [i.part_number, i]));
  const r = { cargados: 0, sinStock: 0, sinMatch: [], yaCargados: [], total: datos.length };
  for (const item of datos) {
    const fila = porCodigo.get(item.part_number);
    if (!fila) { r.sinMatch.push(item.part_number); continue; }
    if (!(item.cantidad_total > 0)) { r.sinStock += 1; continue; }
    const clienteId = `ristoris-stock-${FECHA_CONTEO}-${item.part_number}`;
    const desglose = item.por_sucursal ? Object.entries(item.por_sucursal).map(([s, c]) => `${s}: ${c}`).join(', ') : '';
    const motivo = `Conteo físico inicial Ristoris (${FECHA_CONTEO}), todas las tiendas${desglose ? ` — ${desglose}` : ''}${item.nota ? ` [${item.nota}]` : ''}`;
    const actual = (await q.query('select stock_actual from rinv.insumos_fab where id = $1', [fila.id])).rows[0].stock_actual ?? 0;
    const nuevo = redondearSaldo(actual + item.cantidad_total);
    const ins = await q.query(
      `insert into rinv.movimientos (empresa_id, ambito, insumo_fab_id, tipo, cantidad, saldo_resultante, motivo, rol, cliente_id)
       values ($1,'fabrica',$2,'entrada',$3,$4,$5,'dueno',$6) on conflict (empresa_id, cliente_id) where cliente_id is not null do nothing`,
      [empresaId, fila.id, item.cantidad_total, nuevo, motivo, clienteId]);
    if (!ins.rowCount) { r.yaCargados.push(fila.nombre); continue; }
    await q.query('update rinv.insumos_fab set stock_actual = $2, stock_actualizado_en = now() where id = $1', [fila.id, nuevo]);
    r.cargados += 1;
  }
  return r;
}

/**
 * Descuenta lo vendido de Ristoris entre el conteo y el 07/10. Idempotente por producto; NUNCA deja el
 * stock en negativo: si se vendió más de lo que hay, no descuenta y lo informa (lo decide una persona).
 */
export async function descontarVentasRistoris(q, empresaId) {
  const datos = leer(ARCHIVO_VENTAS);
  const prefijo = `ristoris-ventas-${datos.desde}-a-${datos.hasta}-`;
  const insumos = (await q.query(`select id, nombre, part_number, stock_actual from rinv.insumos_fab where empresa_id = $1 and categoria = 'Ristoris'`, [empresaId])).rows;
  const porCodigo = new Map(insumos.map((i) => [i.part_number, i]));
  const r = { desde: datos.desde, hasta: datos.hasta, descontados: [], unidadesDescontadas: 0, yaDescontados: [], sinStockSuficiente: [], sinMatch: [], total: datos.productos.length };
  for (const item of datos.productos) {
    const fila = porCodigo.get(item.part_number);
    if (!fila) { r.sinMatch.push(item.part_number); continue; }
    const clienteId = prefijo + item.part_number;
    const ya = await q.query('select 1 from rinv.movimientos where empresa_id = $1 and cliente_id = $2', [empresaId, clienteId]);
    if (ya.rowCount) { r.yaDescontados.push(fila.nombre); continue; }
    const actual = (await q.query('select stock_actual from rinv.insumos_fab where id = $1', [fila.id])).rows[0].stock_actual ?? 0;
    if (actual < item.unidades) { r.sinStockSuficiente.push({ nombre: fila.nombre, part_number: item.part_number, hay: actual, vendidas: item.unidades }); continue; }
    const nuevo = redondearSaldo(actual - item.unidades);
    const desglose = Object.entries(item.por_sucursal).map(([s, c]) => `${s}: ${c}`).join(', ');
    await q.query(
      `insert into rinv.movimientos (empresa_id, ambito, insumo_fab_id, tipo, cantidad, saldo_resultante, motivo, rol, cliente_id)
       values ($1,'fabrica',$2,'salida',$3,$4,$5,'dueno',$6)`,
      [empresaId, fila.id, item.unidades, nuevo, `Ventas Ristoris del ${fechaCorta(datos.desde)} al ${fechaCorta(datos.hasta)} — ${desglose}`, clienteId]);
    await q.query('update rinv.insumos_fab set stock_actual = $2, stock_actualizado_en = now() where id = $1', [fila.id, nuevo]);
    r.descontados.push({ nombre: fila.nombre, antes: actual, vendidas: item.unidades, despues: nuevo });
    r.unidadesDescontadas += item.unidades;
  }
  return r;
}

export async function sembrarInsumosSucursal(q, empresaId) {
  const antes = (await q.query('select count(*)::int as n from rep.insumos_catalogo where empresa_id = $1', [empresaId])).rows[0].n;
  await q.query(
    `insert into rep.insumos_catalogo (empresa_id, nombre) select $1, x from unnest($2::text[]) as x
      where not exists (select 1 from rep.insumos_catalogo c where c.empresa_id = $1 and upper(c.nombre) = upper(x)) on conflict do nothing`,
    [empresaId, INSUMOS_SUCURSAL]);
  const despues = (await q.query('select count(*)::int as n from rep.insumos_catalogo where empresa_id = $1', [empresaId])).rows[0].n;
  return { insumosCreados: despues - antes, total: INSUMOS_SUCURSAL.length };
}

/** Punto de partida del checklist. Se siembra una sola vez: si ya hay filas no se toca nada. */
export async function sembrarChecklist(q, empresaId) {
  const hay = (await q.query('select count(*)::int as n from rinv.checklist_catalogo where empresa_id = $1', [empresaId])).rows[0].n;
  if (hay > 0) return { creados: 0 };
  let creados = 0;
  for (const [momento, textos] of Object.entries(CHECKLIST)) {
    for (const [orden, texto] of textos.entries()) {
      await q.query('insert into rinv.checklist_catalogo (empresa_id, momento, texto, orden) values ($1,$2,$3,$4)', [empresaId, momento, texto, orden]);
      creados += 1;
    }
  }
  return { creados };
}

/** Todo junto, en una sola transacción. */
export async function sembrarRinv(db, empresaId) {
  return db.tx(async (q) => {
    const catalogo = await sembrarCatalogoFabrica(q, empresaId);
    const ristoris = await sembrarRistoris(q, empresaId);
    const stockRistoris = await cargarStockRistoris(q, empresaId);
    const ventasRistoris = await descontarVentasRistoris(q, empresaId);
    const sucursal = await sembrarInsumosSucursal(q, empresaId);
    const checklist = await sembrarChecklist(q, empresaId);
    return { catalogo, ristoris, stockRistoris, ventasRistoris, sucursal, checklist };
  });
}

/** Para el arranque del servidor: siembra solo si Italo todavía no tiene catálogo de fábrica. */
export async function sembrarSiVacio(db, log = console.log) {
  const e = (await db.query(`select e.id from core.empresas e join core.empresa_modulos m on m.empresa_id = e.id and m.modulo = 'reposicion' and m.activo where e.codigo = 'italo'`)).rows[0];
  if (!e) return null;
  const hay = (await db.query('select 1 from rinv.insumos_fab where empresa_id = $1 limit 1', [e.id])).rowCount;
  if (hay) return null;
  const r = await sembrarRinv(db, e.id);
  log(`[rinv] siembra de Italo: ${r.catalogo.insumosCreados} insumos de fábrica, ${r.ristoris.insumosCreados} de Ristoris, ${r.stockRistoris.cargados} conteos, ${r.ventasRistoris.descontados.length} descuentos de ventas, ${r.sucursal.insumosCreados} insumos de sucursal`);
  return r;
}
