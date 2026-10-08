import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from './helpers.js';
import { sembrarCatalogoItalo, sembrarCatalogoItaloSiVacio, leerCsv, prepararClientes } from '../src/db/italo-catalogo.js';

let t;
before(async () => { t = await iniciar(); });
after(() => t.cerrar());

test('leerCsv entiende comillas, comas internas y BOM', () => {
  const f = leerCsv('﻿nombre,rtn\n"3V Global, S.A.",05019020238098\nOtro,\n');
  assert.deepEqual(f, [{ nombre: '3V Global, S.A.', rtn: '05019020238098' }, { nombre: 'Otro', rtn: '' }]);
});

test('RTN inválido se guarda sin RTN y queda en notas; no se duplica por RTN', () => {
  const { clientes, avisos } = prepararClientes([
    { nombre: 'A', rtn: '160190158-7821' }, { nombre: 'B', rtn: '05019020238098' }, { nombre: 'B2', rtn: '05019020238098' },
  ]);
  assert.equal(clientes.length, 2);
  assert.equal(clientes[0].rtn, null);
  assert.match(clientes[0].notas, /RTN original/);
  assert.equal(avisos.length, 1);
});

test('carga el catálogo real de Italo: categorías, productos con ISV correcto y clientes; es idempotente', async () => {
  assert.equal((await t.db.query("select count(*)::int n from pos.productos p join core.empresas e on e.id = p.empresa_id where e.codigo = 'italo'")).rows[0].n, 0);
  const r = await sembrarCatalogoItaloSiVacio(t.db);
  assert.ok(r.productos > 150, `productos ${r.productos}`);
  assert.ok(r.clientes > 1400, `clientes ${r.clientes}`);
  const q = async (sql) => (await t.db.query(sql)).rows;
  const cats = (await q("select c.nombre from pos.categorias c join core.empresas e on e.id = c.empresa_id where e.codigo = 'italo' order by c.orden")).map((x) => x.nombre);
  assert.deepEqual(cats.slice(0, 4), ['1. BEBIDAS', '2. CAFE', '3. GELATO ARTESANAL', '4. GELATO PREMIUM']);
  assert.ok(!cats.includes('MATERIA PRIMA') && !cats.includes('SABORES GELATO'));
  // El gelato artesanal es exento (tasa 0); el premium paga 15 %; el precio ya trae ISV
  const art = (await q("select p.precio, p.impuesto_tasa, p.exento from pos.productos p join pos.categorias c on c.id = p.categoria_id join core.empresas e on e.id = p.empresa_id where e.codigo = 'italo' and c.nombre = '3. GELATO ARTESANAL' and p.nombre = 'COPPA CLASSICA'"))[0];
  assert.equal(Number(art.precio), 135); assert.equal(Number(art.impuesto_tasa), 0); assert.equal(art.exento, true);
  const pre = (await q("select p.precio, p.impuesto_tasa from pos.productos p join pos.categorias c on c.id = p.categoria_id join core.empresas e on e.id = p.empresa_id where e.codigo = 'italo' and c.nombre = '4. GELATO PREMIUM' and p.nombre = 'COPPA CLASSICA'"))[0];
  assert.equal(Number(pre.precio), 135); assert.equal(Number(pre.impuesto_tasa), 0.15);
  const ris = (await q("select p.codigo_barras from pos.productos p join core.empresas e on e.id = p.empresa_id where e.codigo = 'italo' and p.nombre like 'ACETO BALSAMICO%'"))[0];
  assert.equal(ris.codigo_barras, '8056515244974');
  // Segunda corrida: no duplica nada
  const r2 = await sembrarCatalogoItalo(t.db);
  assert.deepEqual([r2.categorias, r2.productos, r2.clientes], [0, 0, 0]);
  assert.equal(await sembrarCatalogoItaloSiVacio(t.db), null);
});
