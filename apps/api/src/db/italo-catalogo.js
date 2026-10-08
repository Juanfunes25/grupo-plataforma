import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { leerConfig } from '../config.js';
import { abrirDb } from './index.js';

/**
 * Catálogo y clientes REALES de Italo, exportados de WizPOS (solo lectura; aquí nada se escribe en WizPOS).
 *   datos/italo/productos_wizpos.csv  → export de productos de WizPOS (tienda Mackey, mismo catálogo en las demás)
 *   datos/italo/clientes_wizpos.csv   → clientes de todas las sucursales, ya unificados por RTN
 *
 * Es IDEMPOTENTE: los productos conservan un id determinista (md5 del id de WizPOS), las categorías se unen por
 * nombre y los clientes por RTN (o por nombre si no tienen). Se puede correr las veces que haga falta.
 * Los precios de WizPOS ya incluyen ISV (igual que pos.productos.precio).
 */
const DATOS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'datos', 'italo');
const EXCLUIR_CATEGORIAS = new Set(['MATERIA PRIMA', 'SABORES GELATO', 'Seleccionables']);   // insumos y fichas internas de WizPOS, no se venden
const ORDEN_CATEGORIAS = ['1. BEBIDAS', '2. CAFE', '3. GELATO ARTESANAL', '4. GELATO PREMIUM', '5. COMIDAS', '6. EVENTOS', 'PASTELES', 'CREMAS', 'RISTORIS'];

/** CSV mínimo (comillas, comas y saltos de línea dentro de comillas, BOM). */
export function leerCsv(texto) {
  const t = texto.replace(/^﻿/, '');
  const filas = [];
  let fila = [], campo = '', comillas = false;
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i];
    if (comillas) {
      if (c === '"' && t[i + 1] === '"') { campo += '"'; i += 1; } else if (c === '"') comillas = false; else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === ',') { fila.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i += 1; fila.push(campo); campo = ''; if (fila.some((x) => x !== '')) filas.push(fila); fila = []; }
    else campo += c;
  }
  if (campo !== '' || fila.length) { fila.push(campo); if (fila.some((x) => x !== '')) filas.push(fila); }
  const [enc, ...datos] = filas;
  return datos.map((f) => Object.fromEntries(enc.map((h, i) => [h.trim(), (f[i] ?? '').trim()])));
}

const num = (x) => { const n = Number(String(x).replace(',', '.')); return Number.isFinite(n) ? n : 0; };

export function prepararProductos(filas) {
  const aviso = [];
  const vendibles = filas.filter((p) => !EXCLUIR_CATEGORIAS.has(p.categoria) && p.nombre && !/^producto de prueba$/i.test(p.nombre));
  const rank = (c) => { const i = ORDEN_CATEGORIAS.indexOf(c); return i < 0 ? 99 : i; };
  vendibles.sort((a, b) => rank(a.categoria) - rank(b.categoria) || a.nombre.localeCompare(b.nombre, 'es'));
  const barras = new Set();
  const productos = vendibles.map((p, i) => {
    const tasa = num(p.impuesto_tasa) >= 0.17 ? 0.18 : num(p.impuesto_tasa) > 0 ? 0.15 : 0;
    let codigo_barras = p.codigo_barra || null;
    if (codigo_barras && barras.has(codigo_barras)) { aviso.push(`Código de barras repetido (${codigo_barras}) en "${p.nombre}": se omite`); codigo_barras = null; }
    if (codigo_barras) barras.add(codigo_barras);
    return {
      wiz: p.id_origen, codigo: p.id_origen, codigo_barras, nombre: p.nombre, descripcion: p.descripcion || null, categoria: p.categoria,
      precio: num(p.precio), tasa, exento: tasa === 0, activo: p.activo === '1', disponible: p.para_venta === '1', orden: i + 1,
    };
  });
  const categorias = ORDEN_CATEGORIAS.filter((c) => productos.some((p) => p.categoria === c))
    .concat([...new Set(productos.map((p) => p.categoria))].filter((c) => !ORDEN_CATEGORIAS.includes(c)));
  return { productos, categorias, aviso };
}

export function prepararClientes(filas) {
  const avisos = [];
  const vistos = new Set();
  const clientes = [];
  for (const c of filas) {
    if (!c.nombre) continue;
    const crudo = (c.rtn || '').trim();
    const limpio = crudo.replace(/[\s-]/g, '');
    const rtn = /^\d{14}$/.test(limpio) ? limpio : null;
    if (crudo && !rtn) avisos.push(`"${c.nombre}": RTN "${crudo}" no tiene 14 dígitos; se guardó sin RTN (queda en notas)`);
    const llave = rtn ?? `n:${c.nombre.toLowerCase()}`;
    if (vistos.has(llave)) continue;
    vistos.add(llave);
    clientes.push({ nombre: c.nombre, rtn, direccion: c.direccion || null, telefono: c.telefono || null, correo: c.correo || null, notas: crudo && !rtn ? `RTN original: ${crudo}` : null });
  }
  return { clientes, avisos };
}

export async function sembrarCatalogoItalo(db, { log = () => {} } = {}) {
  const emp = (await db.query("select id from core.empresas where codigo = 'italo'")).rows[0];
  if (!emp) throw new Error('No existe la empresa italo');
  const E = emp.id;
  const { productos, categorias, aviso } = prepararProductos(leerCsv(fs.readFileSync(path.join(DATOS, 'productos_wizpos.csv'), 'utf8')));
  const { clientes, avisos } = prepararClientes(leerCsv(fs.readFileSync(path.join(DATOS, 'clientes_wizpos.csv'), 'utf8')));
  const r = { categorias: 0, productos: 0, clientes: 0, avisos: [...aviso, ...avisos] };

  await db.tx(async (q) => {
    for (const [i, nombre] of categorias.entries()) {
      const ex = (await q.query('select id from pos.categorias where empresa_id = $1 and nombre = $2', [E, nombre])).rows[0];
      if (!ex) { await q.query('insert into pos.categorias (empresa_id, nombre, orden, activo) values ($1,$2,$3,true)', [E, nombre, i + 1]); r.categorias += 1; }
    }
    for (let i = 0; i < productos.length; i += 200) {
      const lote = productos.slice(i, i + 200);
      r.productos += (await q.query(
        `insert into pos.productos (id, empresa_id, codigo, codigo_barras, nombre, descripcion, categoria_id, precio, impuesto_tasa, exento, activo, disponible, orden)
         select md5('italo-wizpos-' || x.wiz)::uuid, $2, x.codigo, x.codigo_barras, x.nombre, x.descripcion, c.id, x.precio, x.tasa, x.exento, x.activo, x.disponible, x.orden
           from jsonb_to_recordset($1::jsonb) as x(wiz text, codigo text, codigo_barras text, nombre text, descripcion text, categoria text, precio numeric, tasa numeric, exento boolean, activo boolean, disponible boolean, orden int)
           left join pos.categorias c on c.empresa_id = $2 and c.nombre = x.categoria
         where not exists (select 1 from pos.productos p where p.id = md5('italo-wizpos-' || x.wiz)::uuid)
           and not exists (select 1 from pos.productos p where p.empresa_id = $2 and p.codigo = x.codigo)
           and (x.codigo_barras is null or not exists (select 1 from pos.productos p where p.empresa_id = $2 and p.codigo_barras = x.codigo_barras))`,
        [JSON.stringify(lote), E])).rowCount;
    }
    for (let i = 0; i < clientes.length; i += 300) {
      const lote = clientes.slice(i, i + 300);
      r.clientes += (await q.query(
        `insert into core.terceros (nombre, rtn, direccion, telefono, correo, notas, es_cliente)
         select x.nombre, x.rtn, x.direccion, x.telefono, x.correo, x.notas, true
           from jsonb_to_recordset($1::jsonb) as x(nombre text, rtn text, direccion text, telefono text, correo text, notas text)
         where case when x.rtn is not null then not exists (select 1 from core.terceros t where t.rtn = x.rtn)
                    else not exists (select 1 from core.terceros t where t.rtn is null and lower(t.nombre) = lower(x.nombre)) end`,
        [JSON.stringify(lote)])).rowCount;
    }
  });
  log(`[italo] catálogo: ${r.categorias} categorías, ${r.productos} productos, ${r.clientes} clientes nuevos`);
  return r;
}

/** Al arrancar: solo si Italo aún no tiene productos. */
export async function sembrarCatalogoItaloSiVacio(db, opciones) {
  const emp = (await db.query("select id from core.empresas where codigo = 'italo'")).rows[0];
  if (!emp) return null;
  const n = (await db.query('select count(*)::int as n from pos.productos where empresa_id = $1', [emp.id])).rows[0].n;
  return n === 0 ? sembrarCatalogoItalo(db, opciones) : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = await abrirDb(leerConfig());
  console.log(JSON.stringify(await sembrarCatalogoItalo(db, { log: console.log }), null, 2));
  await db.close();
}
