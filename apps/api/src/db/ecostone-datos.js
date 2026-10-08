import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { leerConfig } from '../config.js';
import { abrirDb } from './index.js';
import { leerCsv } from './italo-catalogo.js';

/**
 * Datos REALES de EcoStone (fábrica de piedra de enchape), tomados de los seeds de «EcoStone Facturación»
 * (a su vez exportados de WizPOS; aquí solo se LEE, nada se escribe en WizPOS ni en sistemas externos):
 *   datos/ecostone/productos_wizpos.csv     → piedra y accesorios: código WP-n, modelo, color, unidad de venta, precio CON ISV, costo
 *   datos/ecostone/clientes_wizpos.csv      → clientes con RTN de 14 dígitos y tipo de cliente
 *   datos/ecostone/insumos_wizpos.csv       → materias primas con costo promedio (Lempiras)
 *   datos/ecostone/receta_items_wizpos.csv  → recetas por 1 m² (1 caja)
 *
 * Dónde cae cada cosa:
 *   pos.categorias / pos.productos (+ eco.producto_ext)  catálogo vendible (el precio ya incluye ISV 15 %)
 *   fab.insumos / fab.recetas / fab.receta_items          materias primas y recetas
 *   core.terceros + eco.cliente_ext                       clientes (unidos por RTN) y su tipo de cliente
 *
 * Es IDEMPOTENTE (productos con id determinista, insumos por código, recetas solo si el producto no tiene una activa,
 * clientes por RTN). NO inventa existencias: no crea lotes ni movimientos de inventario.
 * Lo que el original no traía se deja con su valor por defecto y se lista en `por_confirmar` para que el dueño lo complete.
 */
const DATOS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'datos', 'ecostone');
const leer = (f) => leerCsv(fs.readFileSync(path.join(DATOS, f), 'utf8'));
const num = (x) => { const n = Number(String(x).replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const r4 = (n) => Math.round((n + Number.EPSILON) * 10000) / 10000;

/** m² por caja que usa el original para TODA la piedra (migración 0020_m2_por_caja_1): «todas las cajas son de 1 m²». */
export const M2_POR_CAJA_DEFECTO = 1;
const TIPOS_CLIENTE = ['final', 'constructora', 'arquitecto', 'instalador', 'ferreteria', 'distribuidor'];
const ORDEN_CATEGORIAS_BASE = 10;   // 0015 ya trae Piedra/Accesorios/Servicios con orden 1–3

export function prepararDatos() {
  const insumos = leer('insumos_wizpos.csv').map((i) => ({ ...i, costo_promedio: num(i.costo_promedio) }));
  const costoInsumo = new Map(insumos.map((i) => [i.codigo, i.costo_promedio]));
  const items = leer('receta_items_wizpos.csv').map((x) => ({ producto: x.producto, insumo: x.insumo, cantidad_m2: num(x.cantidad_m2) }));
  const aviso = [];
  for (const x of items) if (!costoInsumo.has(x.insumo)) aviso.push(`Receta de ${x.producto} usa un insumo desconocido (${x.insumo})`);

  // Costo estándar = costo de la receta (insumos; merma, mano de obra e indirectos en 0 como en el original). Sin receta: el del reporte.
  const costoReceta = new Map();
  for (const x of items) costoReceta.set(x.producto, (costoReceta.get(x.producto) ?? 0) + x.cantidad_m2 * (costoInsumo.get(x.insumo) ?? 0));

  const categorias = [];
  const productos = leer('productos_wizpos.csv').map((p, i) => {
    if (!categorias.includes(p.categoria)) categorias.push(p.categoria);
    const esPiedra = p.tipo === 'piedra';
    return {
      codigo: p.codigo, nombre: p.nombre, categoria: p.categoria, tipo: p.tipo, modelo: p.modelo || null, color: p.color || null,
      unidad_venta: p.unidad_venta, precio: num(p.precio), descripcion: p.descripcion || null, es_piedra: esPiedra,
      m2_por_caja: esPiedra ? M2_POR_CAJA_DEFECTO : null,
      costo_estandar: costoReceta.has(p.codigo) ? r4(costoReceta.get(p.codigo)) : num(p.costo_wizpos),
      con_receta: costoReceta.has(p.codigo), orden: i + 1,
    };
  });
  for (const x of items) if (!productos.some((p) => p.codigo === x.producto)) aviso.push(`Receta de un producto que no está en el catálogo (${x.producto})`);

  const vistos = new Set();
  const clientes = [];
  for (const c of leer('clientes_wizpos.csv')) {
    const rtn = c.rtn.replace(/[\s-]/g, '');
    if (!c.nombre) continue;
    if (!/^\d{14}$/.test(rtn)) { aviso.push(`Cliente "${c.nombre}": RTN "${c.rtn}" no tiene 14 dígitos; se omite`); continue; }
    if (vistos.has(rtn)) continue;
    vistos.add(rtn);
    clientes.push({ nombre: c.nombre, rtn, tipo_cliente: TIPOS_CLIENTE.includes(c.tipo_cliente) ? c.tipo_cliente : 'final' });
  }

  // Lo que NO vino en los seeds del original y queda con su valor por defecto: el dueño debe completarlo.
  const piedra = productos.filter((p) => p.es_piedra);
  const acc = productos.filter((p) => p.tipo === 'accesorio');
  const por_confirmar = [
    { tema: 'm² por caja', detalle: `${piedra.length} productos de piedra quedaron con ${M2_POR_CAJA_DEFECTO} m² por caja (el valor por defecto del original, migración 0020). Confirmar el real de cada modelo, sobre todo las «Caja esquina» (piezas de esquina), que normalmente no rinden 1 m².`, cantidad: piedra.length, codigos: piedra.map((p) => p.codigo) },
    { tema: 'Rendimiento de accesorios (m² que cubre cada saco/galón)', detalle: 'Los 4 accesorios (Eco Protector, Sellador Acrílico, PegaPiedra, PegaPiedra Blanco) no traen rendimiento: sin él la cotización no sugiere cantidades de accesorios.', cantidad: acc.length, codigos: acc.map((p) => p.codigo) },
    { tema: 'Piezas por m²', detalle: 'No venía en los seeds: queda vacío en toda la piedra.', cantidad: piedra.length, codigos: [] },
    { tema: 'Peso por m² (kg)', detalle: 'No venía en los seeds: queda vacío; el flete por peso no se puede estimar.', cantidad: piedra.length, codigos: [] },
    { tema: 'Costo estándar de las cajas esquina', detalle: 'Las «Caja esquina» no tienen receta ni costo en el reporte: costo 0 (su margen no se puede calcular).', cantidad: productos.filter((p) => p.es_piedra && p.costo_estandar === 0).length, codigos: productos.filter((p) => p.es_piedra && p.costo_estandar === 0).map((p) => p.codigo) },
    { tema: 'Recetas: merma esperada, mano de obra e indirectos por m²', detalle: 'Se cargaron con merma 0 %, mano de obra 0 e indirectos 0 (como en el original); el costo estándar es solo el de los insumos.', cantidad: productos.filter((p) => p.con_receta).length, codigos: [] },
    { tema: 'Costos de insumos', detalle: 'Tomados del reporte de WizPOS del 29-sep-2026: confirmar con la última factura de compra.', cantidad: insumos.length, codigos: insumos.map((i) => i.codigo) },
    { tema: 'Precios de las listas Contratista y Distribuidor', detalle: 'Solo existe el precio Público (con ISV). Las otras listas no tienen precios propios: cotizan el precio Público sin ISV hasta que se carguen.', cantidad: 0, codigos: [] },
    { tema: 'Lista de precios, límite y días de crédito de los clientes', detalle: `Los ${clientes.length} clientes quedan con su tipo pero sin lista de precios asignada (cotizan con Público), límite de crédito 0 y 0 días.`, cantidad: clientes.length, codigos: [] },
    { tema: 'Clientes posiblemente repetidos', detalle: 'WILFREDO GOMEZ PINEDA aparece con dos RTN que solo difieren en el último dígito (…040 y …041); se cargaron ambos, uno puede ser error de digitación.', cantidad: 2, codigos: [] },
    { tema: 'RTN compartidos con otros negocios del grupo', detalle: '5 clientes ya estaban en el directorio común con el mismo RTN (no se duplicaron; conservan su nombre actual). En uno el nombre difiere: RTN 08019002277587 figura como «GRUPO ALPES» y en el seed de EcoStone como «CERAMICAS Y MAS».', cantidad: 5, codigos: [] },
    { tema: 'Moldes, zonas de flete y proveedores', detalle: 'El original no traía ninguno: no se cargó nada.', cantidad: 0, codigos: [] },
    { tema: 'Existencias', detalle: 'No se cargó ninguna existencia de piedra ni de insumos (sin lotes ni movimientos). Se registran con el conteo físico / primera producción.', cantidad: 0, codigos: [] },
  ];
  return { categorias, productos, insumos, items, clientes, aviso, por_confirmar };
}

export async function sembrarEcostone(db, { log = () => {} } = {}) {
  const emp = (await db.query("select id from core.empresas where codigo = 'ecostone'")).rows[0];
  if (!emp) throw new Error('No existe la empresa ecostone');
  const E = emp.id;
  const d = prepararDatos();
  const r = { categorias: 0, productos: 0, insumos: 0, recetas: 0, receta_items: 0, clientes: 0, clientes_existentes: 0, avisos: d.aviso, por_confirmar: d.por_confirmar };

  await db.tx(async (q) => {
    for (const [i, nombre] of d.categorias.entries()) {
      r.categorias += (await q.query(
        'insert into pos.categorias (empresa_id, nombre, orden, activo) values ($1,$2,$3,true) on conflict (empresa_id, nombre) do nothing', [E, nombre, ORDEN_CATEGORIAS_BASE + i])).rowCount;
    }

    // Productos: id determinista; no pisa uno que ya exista (por id o por código)
    const nuevos = (await q.query(
      `insert into pos.productos (id, empresa_id, codigo, nombre, descripcion, categoria_id, precio, impuesto_tasa, exento, unidad, unidad_venta, es_piedra, modelo, color, m2_por_caja, costo_estandar, activo, disponible, orden)
       select md5('ecostone-wizpos-' || x.codigo)::uuid, $2, x.codigo, x.nombre, x.descripcion, c.id, x.precio, 0.15, false, 'unidad', x.unidad_venta, x.es_piedra, x.modelo, x.color, x.m2_por_caja, x.costo_estandar, true, true, x.orden
         from jsonb_to_recordset($1::jsonb) as x(codigo text, nombre text, descripcion text, categoria text, precio numeric, unidad_venta text, es_piedra boolean, modelo text, color text, m2_por_caja numeric, costo_estandar numeric, orden int)
         left join pos.categorias c on c.empresa_id = $2 and c.nombre = x.categoria
        where not exists (select 1 from pos.productos p where p.id = md5('ecostone-wizpos-' || x.codigo)::uuid)
          and not exists (select 1 from pos.productos p where p.empresa_id = $2 and p.codigo = x.codigo)
       returning id`, [JSON.stringify(d.productos), E])).rows;
    r.productos = nuevos.length;
    // Datos comerciales de la piedra (tipo; peso y rendimiento sin dato → null)
    await q.query(
      `insert into eco.producto_ext (producto_id, empresa_id, tipo)
       select p.id, $2, x.tipo from jsonb_to_recordset($1::jsonb) as x(codigo text, tipo text)
         join pos.productos p on p.empresa_id = $2 and p.codigo = x.codigo
       on conflict (producto_id) do nothing`, [JSON.stringify(d.productos), E]);

    // Insumos (costo promedio en Lempiras). Sin movimientos: stock 0.
    r.insumos = (await q.query(
      `insert into fab.insumos (empresa_id, codigo, nombre, categoria, unidad, costo_promedio, moneda, notas)
       select $2, x.codigo, x.nombre, x.categoria, x.unidad, x.costo_promedio, 'HNL', x.notas
         from jsonb_to_recordset($1::jsonb) as x(codigo text, nombre text, categoria text, unidad text, costo_promedio numeric, notas text)
        on conflict (empresa_id, codigo) do nothing`, [JSON.stringify(d.insumos), E])).rowCount;

    // Recetas: una por producto, solo si aún no tiene una activa; sus ingredientes solo se cargan con la receta nueva.
    const conReceta = d.productos.filter((p) => p.con_receta).map((p) => p.codigo);
    const nuevas = (await q.query(
      `insert into fab.recetas (empresa_id, producto_id, nombre, merma_esperada_pct, mano_obra_m2, indirectos_m2, notas)
       select $1, p.id, 'Receta base (WizPOS)', 0, 0, 0, 'Importada de WizPOS: cantidades por 1 m² (1 caja). Merma, mano de obra e indirectos por confirmar.'
         from pos.productos p
        where p.empresa_id = $1 and p.codigo = any($2::text[])
          and not exists (select 1 from fab.recetas r where r.producto_id = p.id and r.activa)
       returning id, producto_id`, [E, conReceta])).rows;
    r.recetas = nuevas.length;
    if (nuevas.length) {
      r.receta_items = (await q.query(
        `insert into fab.receta_items (receta_id, insumo_id, cantidad_m2)
         select rr.id, i.id, x.cantidad_m2
           from jsonb_to_recordset($1::jsonb) as x(producto text, insumo text, cantidad_m2 numeric)
           join pos.productos p on p.empresa_id = $3 and p.codigo = x.producto
           join fab.recetas rr on rr.producto_id = p.id and rr.id = any($2::uuid[])
           join fab.insumos i on i.empresa_id = $3 and i.codigo = x.insumo
         on conflict do nothing`, [JSON.stringify(d.items), nuevas.map((n) => n.id), E])).rowCount;
    }

    // Clientes: por RTN (la ficha es común al grupo: si ya existe, solo se le agrega el dato comercial de EcoStone)
    const antes = (await q.query('select count(*)::int n from core.terceros where rtn = any($1::text[])', [d.clientes.map((c) => c.rtn)])).rows[0].n;
    r.clientes = (await q.query(
      `insert into core.terceros (nombre, rtn, es_cliente)
       select x.nombre, x.rtn, true from jsonb_to_recordset($1::jsonb) as x(nombre text, rtn text, tipo_cliente text)
        where not exists (select 1 from core.terceros t where t.rtn = x.rtn)`, [JSON.stringify(d.clientes)])).rowCount;
    r.clientes_existentes = antes;
    await q.query(
      `insert into eco.cliente_ext (tercero_id, tipo_cliente)
       select t.id, x.tipo_cliente from jsonb_to_recordset($1::jsonb) as x(nombre text, rtn text, tipo_cliente text)
         join core.terceros t on t.rtn = x.rtn
       on conflict (tercero_id) do nothing`, [JSON.stringify(d.clientes)]);
  });
  log(`[ecostone] ${r.categorias} categorías, ${r.productos} productos, ${r.insumos} insumos, ${r.recetas} recetas (${r.receta_items} ingredientes), ${r.clientes} clientes nuevos (${r.clientes_existentes} ya existían por RTN)`);
  return r;
}

/** Al arrancar: solo si EcoStone aún no tiene productos. */
export async function sembrarEcostoneSiVacio(db, opciones) {
  const emp = (await db.query("select id from core.empresas where codigo = 'ecostone'")).rows[0];
  if (!emp) return null;
  const n = (await db.query('select count(*)::int as n from pos.productos where empresa_id = $1', [emp.id])).rows[0].n;
  return n === 0 ? sembrarEcostone(db, opciones) : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = await abrirDb(leerConfig());
  const r = await sembrarEcostone(db, { log: console.log });
  console.log(JSON.stringify({ ...r, por_confirmar: r.por_confirmar.map(({ tema, detalle, cantidad }) => ({ tema, cantidad, detalle })) }, null, 2));
  await db.close();
}
