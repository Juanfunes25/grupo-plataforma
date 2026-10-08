import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from './helpers.js';
import { prepararDatos, sembrarEcostone, sembrarEcostoneSiVacio } from '../src/db/ecostone-datos.js';

let t, adm, eid, fp;
before(async () => {
  t = await iniciar();
  await t.usuario({ nombre: 'Admin Eco', email: 'adm@eco.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'ecostone', rol: 'admin' }] });
  adm = t.cli(await t.login('ecostone', 'adm@eco.hn', 'ClaveSegura123'), 'ecostone');
  eid = await t.empresaId('ecostone');
  fp = (await t.db.query(`select id from pos.formas_pago where empresa_id = $1 and tipo = 'efectivo'`, [eid])).rows[0].id;
});
after(() => t.cerrar());

const uno = async (sql, p = []) => (await t.db.query(sql, p)).rows[0];

test('los datos preparados son coherentes: ISV incluido, costo de receta, clientes con RTN de 14 dígitos, «por confirmar» listado', () => {
  const d = prepararDatos();
  assert.equal(d.productos.length, 49);
  assert.equal(d.insumos.length, 12);
  assert.equal(d.clientes.length, 54);
  assert.deepEqual(d.aviso, []);
  assert.ok(d.clientes.every((c) => /^\d{14}$/.test(c.rtn)));
  assert.equal(new Set(d.productos.map((p) => p.codigo)).size, 49);
  const qf = d.productos.find((p) => p.codigo === 'WP-1');
  assert.equal(qf.precio, 1166.24); assert.equal(qf.unidad_venta, 'm2'); assert.equal(qf.modelo, 'Rustic Quick fit'); assert.equal(qf.color, 'Gran Cañon');
  // costo estándar = costo de la receta: 31.5×1.6 + 10.35×6 + 0.3×52.27 + 0.2×47.05 + 0.2×49.66 + 1×43 = 190.523
  assert.equal(qf.costo_estandar, 190.523);
  assert.equal(d.productos.find((p) => p.codigo === 'WP-30').costo_estandar, 0);     // caja esquina: sin costo en el reporte
  assert.ok(d.por_confirmar.some((x) => x.tema === 'm² por caja' && x.cantidad === d.productos.filter((p) => p.es_piedra).length));
});

test('carga los datos reales de EcoStone: conteos, ISV, piedra con sus atributos, insumos, recetas y clientes', async () => {
  assert.equal((await uno('select count(*)::int n from pos.productos where empresa_id = $1', [eid])).n, 0);
  const r = await sembrarEcostoneSiVacio(t.db);
  assert.deepEqual([r.productos, r.insumos, r.recetas, r.clientes], [49, 12, 28, 49]);
  assert.equal(r.clientes_existentes, 5);   // ya estaban en el directorio del grupo (mismo RTN): no se duplican
  assert.equal(r.receta_items, 143);

  const piedra = await uno('select count(*)::int n, count(*) filter (where m2_por_caja = 1)::int uno from pos.productos where empresa_id = $1 and es_piedra', [eid]);
  assert.deepEqual([piedra.n, piedra.uno], [45, 45]);
  const p = await uno(`select p.*, x.tipo, x.rendimiento_m2, x.peso_kg_m2, c.nombre as cat from pos.productos p join eco.producto_ext x on x.producto_id = p.id join pos.categorias c on c.id = p.categoria_id where p.empresa_id = $1 and p.codigo = 'WP-8'`, [eid]);
  assert.equal(p.nombre, 'Rustic Quick fit Everest'); assert.equal(p.cat, 'Rustic Quick fit'); assert.equal(p.modelo, 'Rustic Quick fit'); assert.equal(p.color, 'Everest');
  assert.equal(Number(p.precio), 1213.5); assert.equal(Number(p.impuesto_tasa), 0.15); assert.equal(p.unidad_venta, 'm2'); assert.equal(p.es_piedra, true);
  assert.equal(p.tipo, 'piedra'); assert.equal(p.peso_kg_m2, null);
  assert.equal(Number(p.costo_estandar), 242.358);
  const acc = await uno(`select p.unidad_venta, p.es_piedra, p.precio, x.tipo, x.rendimiento_m2 from pos.productos p join eco.producto_ext x on x.producto_id = p.id where p.empresa_id = $1 and p.codigo = 'WP-29'`, [eid]);
  assert.deepEqual([acc.unidad_venta, acc.es_piedra, Number(acc.precio), acc.tipo, acc.rendimiento_m2], ['saco', false, 567.14, 'accesorio', null]);
  const cats = (await t.db.query(`select nombre from pos.categorias where empresa_id = $1 and nombre in ('Rustic Quick fit','Castillo Europeo','Monasterio','Ledgestone/Laja','Cliff/Risco','Travertino','Eco Protector galon','PegaPiedra saco')`, [eid])).rowCount;
  assert.equal(cats, 8);

  // Insumos y recetas (sin inventario inventado)
  assert.equal(Number((await uno(`select costo_promedio from fab.insumos where empresa_id = $1 and codigo = 'WP-49'`, [eid])).costo_promedio), 6);
  assert.equal((await uno(`select count(*)::int n from fab.mov_insumos where empresa_id = $1`, [eid])).n, 0);
  assert.equal((await uno(`select count(*)::int n from fab.lotes where empresa_id = $1`, [eid])).n, 0);
  const rec = await uno(`select count(*)::int n from fab.recetas r where empresa_id = $1 and activa and merma_esperada_pct = 0`, [eid]);
  assert.equal(rec.n, 28);
  const ing = await uno(`select count(*)::int n from fab.receta_items ri join fab.recetas r on r.id = ri.receta_id join pos.productos p on p.id = r.producto_id where p.codigo = 'WP-13'`);
  assert.equal(ing.n, 5);   // Castillo Onyx: Eco Protector, cemento gris, agregado, color negro, caja

  // Clientes: tipo de cliente en eco.cliente_ext, uno por RTN, sin lista de precios asignada
  const c = await uno(`select t.nombre, x.tipo_cliente, x.lista_precio_id from core.terceros t join eco.cliente_ext x on x.tercero_id = t.id where t.rtn = '18069015794750'`);
  assert.deepEqual([c.nombre, c.tipo_cliente, c.lista_precio_id], ['URBANISADORA MONTERREY', 'constructora', null]);
  assert.equal((await uno(`select count(*)::int n from eco.cliente_ext x join core.terceros t on t.id = x.tercero_id where t.rtn is not null`)).n, 54);

  // Segunda corrida: no duplica nada
  const r2 = await sembrarEcostone(t.db);
  assert.deepEqual([r2.categorias, r2.productos, r2.insumos, r2.recetas, r2.receta_items, r2.clientes], [0, 0, 0, 0, 0, 0]);
  assert.equal(await sembrarEcostoneSiVacio(t.db), null);
  assert.equal((await uno('select count(*)::int n from pos.productos where empresa_id = $1', [eid])).n, 49);
  assert.equal((await uno('select count(*)::int n from fab.receta_items')).n, 143);
});

test('el cliente que ya existe en el grupo (mismo RTN) no se duplica: solo gana su dato comercial', async () => {
  // Otro negocio ya lo tenía con otro nombre
  await t.db.query(`delete from eco.cliente_ext where tercero_id = (select id from core.terceros where rtn = '05019002067400')`);
  await t.db.query(`update core.terceros set nombre = 'Diserco SA de CV (otra empresa)' where rtn = '05019002067400'`);
  const r = await sembrarEcostone(t.db);
  assert.equal(r.clientes, 0);
  const f = (await t.db.query(`select t.nombre, x.tipo_cliente from core.terceros t join eco.cliente_ext x on x.tercero_id = t.id where t.rtn = '05019002067400'`)).rows;
  assert.deepEqual(f, [{ nombre: 'Diserco SA de CV (otra empresa)', tipo_cliente: 'final' }]);
});

test('las cotizaciones de EcoStone cotizan con los productos cargados (Público con ISV; Contratista sin ISV)', async () => {
  const prods = (await adm.get('/api/eco/productos')).body;
  assert.equal(prods.length, 49);
  const wp1 = prods.find((x) => x.codigo === 'WP-1');
  assert.equal(wp1.tipo, 'piedra'); assert.equal(Number(wp1.m2_por_caja), 1); assert.equal(Number(wp1.costo_estandar), 190.523);
  const listas = (await adm.get('/api/eco/listas-precio')).body;

  const pub = await adm.post('/api/eco/cotizaciones', { nombre_cliente: 'Casa Prueba', proyecto: 'Fachada', lineas: [{ tipo: 'producto', producto_id: wp1.id, m2_neto: 10 }] });
  assert.equal(pub.status, 201, JSON.stringify(pub.body));
  assert.equal(pub.body.isv_incluido, true);
  assert.equal(Number(pub.body.lineas[0].cantidad), 10); assert.equal(Number(pub.body.lineas[0].precio_unitario), 1166.24);
  assert.equal(Number(pub.body.total), 11662.4);                       // el precio de lista ya trae ISV: no se suma otra vez
  assert.equal(Number(pub.body.isv), 1521.18);                         // 11 662.40 − 11 662.40 / 1.15

  const contr = listas.find((l) => l.nombre === 'Contratista');
  const con = await adm.post('/api/eco/cotizaciones', { nombre_cliente: 'Constructora X', proyecto: 'Torre', lista_precio_id: contr.id, lineas: [{ tipo: 'producto', producto_id: wp1.id, m2_neto: 10 }] });
  assert.equal(con.status, 201, JSON.stringify(con.body));
  assert.equal(con.body.isv_incluido, false);
  assert.equal(Number(con.body.lineas[0].precio_unitario), 1014.12);   // 1166.24 / 1.15
  assert.equal(Number(con.body.total), 11662.38);                      // 10 142.00 + 15 % ISV (el redondeo por línea cuesta 2 centavos)

  // Caja esquina (se vende por caja) y accesorio (sin rendimiento: cantidad manual)
  const esq = prods.find((x) => x.codigo === 'WP-30');
  const pega = prods.find((x) => x.codigo === 'WP-29');
  const mix = await adm.post('/api/eco/cotizaciones', { nombre_cliente: 'Casa Prueba', proyecto: 'Esquinas', lineas: [{ tipo: 'producto', producto_id: esq.id, m2_neto: 3 }, { tipo: 'accesorio', producto_id: pega.id, cantidad: 2 }] });
  assert.equal(mix.status, 201, JSON.stringify(mix.body));
  assert.equal(Number(mix.body.total), Math.round((3 * 1319.55 + 2 * 567.14) * 100) / 100);
});

test('el POS «Venta Directa» de EcoStone muestra los productos con su precio y factura uno', async () => {
  const cat = await adm.get('/api/pos/catalogo');
  assert.equal(cat.status, 200);
  const wp = cat.body.productos.find((x) => x.codigo === 'WP-4');
  assert.equal(wp.nombre, 'Rustic Quick fit Gray smoke'); assert.equal(Number(wp.precio), 1166.24); assert.equal(Number(wp.impuesto_tasa), 0.15);
  assert.equal(wp.unidad_venta, 'm2'); assert.equal(wp.disponible, true);
  assert.equal(cat.body.productos.filter((x) => x.codigo?.startsWith('WP-')).length, 49);
  const nombreCat = cat.body.categorias.find((c) => c.id === wp.categoria_id).nombre;
  assert.equal(nombreCat, 'Rustic Quick fit');
  // Sin existencias cargadas el POS pide confirmación; luego cobra el precio de lista con su ISV
  const orden = { items: [{ producto_id: wp.id, cantidad: 2 }], cobrar: { pagos: [{ forma_pago_id: fp, monto: 2332.48 }] } };
  const r1 = await adm.post('/api/pos/ventas', orden);
  assert.equal(r1.status, 409); assert.equal(r1.body.codigo, 'SIN_STOCK');
  const r2 = await adm.post('/api/pos/ventas', { ...orden, confirmar_sin_stock: true });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.equal(r2.body.estado, 'pagada'); assert.equal(Number(r2.body.total), 2332.48);
  assert.equal(Number(r2.body.isv_total), 304.24);
});
