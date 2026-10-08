import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from './helpers.js';
import { armarPlanProduccion } from '../src/modulos/prod/plan.js';
import { consumoSegunReceta, repartirFifo, desviacion } from '../src/modulos/prod/consumo.js';
import { costoKgReceta, precioVigente } from '../src/modulos/prod/costeo.js';

let tokProd, t, ger, prod, bod, otra, eid, sabor, sabor2, insA, insB, rinvA, rinvB;
const hoy = new Date().toISOString().slice(0, 10);

before(async () => {
  t = await iniciar();
  eid = await t.empresaId('italo');
  await t.usuario({ nombre: 'Gerente', email: 'ger@italo.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'italo', rol: 'gerente' }, { empresa: 'origen', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Productor', accesos: [{ empresa: 'italo', rol: 'produccion', pin: '5151' }] });
  await t.usuario({ nombre: 'Bodeguero', accesos: [{ empresa: 'italo', rol: 'bodega', pin: '6161' }] });
  ger = t.cli(await t.login('italo', 'ger@italo.hn', 'ClaveSegura123'), 'italo');
  otra = t.cli(await t.login('origen', 'ger@italo.hn', 'ClaveSegura123'), 'origen');
  tokProd = await t.loginPin('italo', '5151');
  prod = t.cli(tokProd, 'italo');
  prod.patch = async (ruta, body) => { const r = await fetch(t.base + ruta, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokProd}`, 'x-empresa': 'italo' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  bod = t.cli(await t.loginPin('italo', '6161'), 'italo');
  const s = (await t.db.query(`select id, nombre from rep.sabores where empresa_id = $1 and nombre in ('PISTACCHIO','MANGO') order by nombre`, [eid])).rows;
  sabor = s.find((x) => x.nombre === 'PISTACCHIO').id; sabor2 = s.find((x) => x.nombre === 'MANGO').id;
  // Insumos de costeo propios de la prueba y su espejo en inventario (rinv), por nombre.
  const mk = async (n, tipo) => (await t.db.query(`insert into prod.costeo_insumos (empresa_id, nombre, tipo, unidad) values ($1,$2,$3,'kg') returning id`, [eid, n, tipo])).rows[0].id;
  insA = await mk('PRUEBA PASTA', 'mec3'); insB = await mk('PRUEBA LECHE', 'local');
  const rv = async (n, tipo, stock) => (await t.db.query(`insert into rinv.insumos_fab (empresa_id, nombre, tipo, unidad, stock_actual) values ($1,$2,$3,'kg',$4) returning id`, [eid, n, tipo, stock])).rows[0].id;
  rinvA = await rv('PRUEBA PASTA', 'mec3', 10); rinvB = await rv('PRUEBA LECHE', 'local', 100);
});
after(() => t.cerrar());

test('semilla: 303 insumos con precio, 24 recetas, solo FRAGOLA SIN AZUCAR sin sabor', async () => {
  assert.equal((await t.db.query('select count(*)::int n from prod.costeo_insumos where nombre not like $1', ['PRUEBA%'])).rows[0].n, 303);
  assert.equal((await t.db.query('select count(*)::int n from prod.costeo_recetas')).rows[0].n, 24);
  const sin = (await ger.get('/api/prod/costeo/recetas-sin-sabor')).body;
  assert.deepEqual(sin.map((x) => x.nombre), ['FRAGOLA SIN AZUCAR']);
  // idempotente
  const r = (await ger.post('/api/prod/costeo/enganchar')).body;
  assert.equal(r.enganchadas, 0);
});

test('permisos y módulo por empresa', async () => {
  assert.equal((await otra.get('/api/prod/tandas')).status, 403);
  assert.equal((await prod.get('/api/prod/costeo/insumos')).status, 403);
  assert.equal((await prod.get('/api/prod/traza/buscar?q=abc')).status, 403);
  assert.equal((await prod.get('/api/prod/plan')).status, 403);
  assert.equal((await bod.post('/api/prod/tandas/lote', { fecha: hoy, items: [] })).status, 403);
  assert.equal((await ger.get('/api/prod/costeo/insumos')).status, 200);
});

test('reglas puras de costeo: precio vigente, todo o nada y costo por kg del lote', () => {
  const precios = new Map([['a', [{ fecha_vigencia: '2026-01-01', lps_kg: 100, id: 1 }, { fecha_vigencia: '2026-03-01', lps_kg: 80, id: 2 }, { fecha_vigencia: '2026-03-01', lps_kg: 90, id: 3 }]], ['b', [{ fecha_vigencia: '2026-01-01', lps_kg: 10, id: 4 }]]]);
  assert.equal(precioVigente(precios, 'a', '2025-12-31'), null);
  assert.equal(precioVigente(precios, 'a', '2026-02-01'), 100);
  assert.equal(precioVigente(precios, 'a', '2026-03-01'), 90);          // empate: el de mayor id; y baja de precio sí reacciona
  const recetas = new Map([['r', { items: [{ insumoId: 'a', gramos: 500 }, { insumoId: 'b', gramos: 1500 }], pesoTotalGramos: 2000 }], ['x', { items: [{ insumoId: 'a', gramos: 1000 }, { insumoId: 'z', gramos: 1000 }], pesoTotalGramos: 2000 }]]);
  assert.equal(costoKgReceta('r', '2026-03-05', recetas, precios), (0.5 * 90 + 1.5 * 10) / 2);
  assert.equal(costoKgReceta('x', '2026-03-05', recetas, precios), null);   // falta el precio de z
});

test('precios: solo se agregan; dólares con tipo de cambio; impacto y aplicar tipo de cambio', async () => {
  const lista = (await ger.get('/api/prod/costeo/insumos')).body;
  const dolar = lista.find((i) => i.usd_kg > 0);
  assert.ok(dolar.tipo_cambio_usado > 20);
  let r = await ger.post(`/api/prod/costeo/insumos/${insA}/precios`, { usd_kg: 10, tipo_cambio_usado: 26, fecha_vigencia: '2026-01-01' });
  assert.equal(r.status, 201); assert.equal(r.body.lps_kg, 260);
  r = await ger.post(`/api/prod/costeo/insumos/${insA}/precios`, { lps_kg: 300, fecha_vigencia: '2026-02-01' });
  const h = (await ger.get(`/api/prod/costeo/insumos/${insA}/precios`)).body.precios;
  assert.equal(h.length, 2); assert.equal(Math.round(h[0].variacion_pct), 15);
  await assert.rejects(t.db.query('update prod.costeo_precios set lps_kg = 1'), /no se edita ni se borra/);
  await assert.rejects(t.db.query('delete from prod.costeo_precios'), /no se edita ni se borra/);
  assert.equal((await ger.post(`/api/prod/costeo/insumos/${insA}/precios`, { fecha_vigencia: '2026-02-01' })).status, 400);
  await ger.post(`/api/prod/costeo/insumos/${insB}/precios`, { lps_kg: 20, fecha_vigencia: '2026-01-01' });
  // vista previa del tipo de cambio: no escribe
  const antes = (await t.db.query('select count(*)::int n from prod.costeo_precios')).rows[0].n;
  const vp = (await ger.post('/api/prod/costeo/tipo-cambio/aplicar', { tipo_cambio: 30, vista_previa: true })).body;
  assert.ok(vp.cambios.length > 100); assert.ok(vp.recetas.length > 5);
  assert.equal((await t.db.query('select count(*)::int n from prod.costeo_precios')).rows[0].n, antes);
  const ap = await ger.post('/api/prod/costeo/tipo-cambio/aplicar', { tipo_cambio: 30, fecha_vigencia: hoy });
  assert.equal(ap.status, 201); assert.equal(ap.body.actualizados, vp.cambios.length);
  const sig = (await ger.get('/api/prod/costeo/tipo-cambio')).body;
  assert.equal(sig.tipo_cambio_usd, 30);
});

test('receta por sabor: guardar, costo por kg del lote, margen y borrar', async () => {
  let r = await ger.put(`/api/prod/costeo/recetas/${sabor2}`, { items: [{ insumo_id: insA, gramos: 500 }, { insumo_id: insB, gramos: 1500 }], precio_venta_kg: 200 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = (await ger.get(`/api/prod/costeo/recetas/${sabor2}?fecha=2026-03-01`)).body;
  assert.equal(d.costo_kg_hoy, (0.5 * 300 + 1.5 * 20) / 2);   // 90
  assert.equal(Math.round(d.margen.pct), 55);
  const lista = (await ger.get(`/api/prod/costeo/recetas?fecha=2026-03-01`)).body.find((x) => x.sabor_id === sabor2);
  assert.equal(lista.cantidad_ingredientes, 2); assert.equal(lista.costo_kg_hoy, 90);
  const imp = (await ger.get(`/api/prod/costeo/insumos/${insB}/impacto?lps_kg=40&fecha=2026-03-01`)).body;
  assert.equal(imp[0].antes, 90); assert.equal(imp[0].despues, 105);
  assert.equal((await ger.put(`/api/prod/costeo/recetas/${sabor2}`, { items: [{ insumo_id: insA, gramos: 0 }] })).status, 400);
});

let tanda1, tanda2;
test('registrar producción: lote automático, costo congelado oculto a quien produce, idempotencia y límites', async () => {
  assert.equal((await prod.post('/api/prod/tandas/lote', { fecha: hoy, items: [{ sabor_id: sabor2, kg: 900 }] })).status, 400);
  assert.equal((await prod.post('/api/prod/tandas/lote', { fecha: '2999-01-01', items: [{ sabor_id: sabor2, kg: 10 }] })).status, 400);
  const r = await prod.post('/api/prod/tandas/lote', { fecha: hoy, operario: 'Ana', items: [{ sabor_id: sabor2, kg: 30, panas: 12, cliente_id: 'cli-123456' }, { sabor_id: sabor2, kg: 15 }, { sabor_id: sabor, kg: 20 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.guardados, 3);
  const compacta = hoy.replace(/-/g, '');
  const [a, b, c] = r.body.items;
  assert.match(a.lote, new RegExp(`^${compacta}-\\d+-1$`)); assert.match(b.lote, new RegExp(`^${compacta}-\\d+-2$`));   // 2.ª tanda del mismo sabor
  assert.notEqual(a.lote.split('-')[1], c.lote.split('-')[1]);
  assert.equal(JSON.stringify(r.body).includes('costo'), false);       // ni costo ni receta en la respuesta
  tanda1 = a.id; tanda2 = c.id;
  const rep = await prod.post('/api/prod/tandas/lote', { fecha: hoy, operario: 'Ana', items: [{ sabor_id: sabor2, kg: 30, cliente_id: 'cli-123456' }] });
  assert.equal(rep.body.items[0].id, tanda1);                           // el reintento sin señal no duplica
  const dia = (await prod.get(`/api/prod/tandas?fecha=${hoy}`)).body;
  assert.equal(dia.length, 3); assert.equal(dia.find((x) => x.id === tanda1).con_consumo, undefined);
  const row = (await t.db.query('select kg_restante, costo_kg_congelado, costo_total_congelado from prod.producciones where id = $1', [tanda1])).rows[0];
  assert.equal(row.kg_restante, 30);
  assert.equal(row.costo_kg_congelado, 90);                 // receta guardada arriba, precios vigentes hoy
  assert.equal(row.costo_total_congelado, 2700);
  const sinReceta = (await t.db.query('select costo_kg_congelado from prod.producciones where id = $1', [tanda2])).rows[0];
  assert.ok(sinReceta.costo_kg_congelado === null || sinReceta.costo_kg_congelado > 0);
});

test('consumo por tanda: sugerido por receta, FIFO entre lotes, desviación, kardex y reversa', async () => {
  const L = async (c, ing, venc) => (await t.db.query(`insert into rinv.lotes_mec3 (empresa_id, insumo_id, cantidad_inicial, cantidad_restante, fecha_ingreso, fecha_vencimiento) values ($1,$2,$3,$3,$4,$5) returning id`, [eid, ing, c, ing === rinvA ? '2026-01-01' : '2026-01-02', venc])).rows[0].id;
  const l1 = await L(3, rinvA, '2027-01-01'); const l2 = await L(5, rinvA, '2027-02-01');
  assert.equal((await prod.get(`/api/prod/tandas/${tanda1}/consumo`)).status, 403);     // producción no ve la receta
  const sug = (await bod.get(`/api/prod/tandas/${tanda1}/consumo`)).body;
  assert.equal(sug.confirmado, false);
  const sa = sug.sugerido.consumos.find((c) => c.insumo_id === insA);
  assert.equal(sa.cantidad, 7.5);                                    // 30 kg × 500 g / 2000 g
  const r = await bod.post(`/api/prod/tandas/${tanda1}/consumo`, { consumos: [{ insumo_id: insA, cantidad: 8 }, { insumo_id: insB, cantidad: 22.5 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const stock = async (id) => Number((await t.db.query('select stock_actual from rinv.insumos_fab where id = $1', [id])).rows[0].stock_actual);
  const rest = async (id) => Number((await t.db.query('select cantidad_restante from rinv.lotes_mec3 where id = $1', [id])).rows[0].cantidad_restante);
  assert.equal(await stock(rinvA), 2); assert.equal(await stock(rinvB), 77.5);
  assert.equal(await rest(l1), 0); assert.equal(await rest(l2), 0);        // 8 = 3 del viejo + 5 del segundo
  const traza = (await bod.get(`/api/prod/traza/tanda/${tanda1}`)).body;
  const ia = traza.insumos.find((i) => i.nombre === 'PRUEBA PASTA');
  assert.equal(ia.real, 8); assert.equal(ia.sugerida, 7.5); assert.equal(ia.desviacion, 6.7); assert.equal(ia.desviacion_notable, false);
  assert.deepEqual(ia.lotes.map((l) => l.cantidad), [3, 5]);
  assert.equal((await t.db.query(`select count(*)::int n from rinv.movimientos where motivo like 'Tanda %' and tipo = 'salida'`)).rows[0].n, 2);
  // volver a confirmar reemplaza (no descuenta dos veces)
  await bod.post(`/api/prod/tandas/${tanda1}/consumo`, { consumos: [{ insumo_id: insA, cantidad: 8 }] });
  assert.equal(await stock(rinvA), 2); assert.equal(await stock(rinvB), 100);
  // corregir los kg deshace el descuento
  const p = await prod.patch(`/api/prod/tandas/${tanda1}`, { kg: 31 });
  assert.equal(p.body.descuento_deshecho, true); assert.equal(p.body.costo_kg_congelado, undefined);
  assert.equal(await stock(rinvA), 10); assert.equal(await rest(l1), 3);
  assert.equal((await bod.get(`/api/prod/traza/tanda/${tanda1}`)).body.consumo_registrado, false);
  // sin inventario: el insumo no está en rinv → se registra igual y se avisa
  const ins3 = (await t.db.query(`insert into prod.costeo_insumos (empresa_id, nombre, tipo, unidad) values ($1,'PRUEBA SIN INV','local','kg') returning id`, [eid])).rows[0].id;
  const s3 = await bod.post(`/api/prod/tandas/${tanda1}/consumo`, { consumos: [{ insumo_id: ins3, cantidad: 1 }] });
  assert.deepEqual(s3.body.sin_inventario, ['PRUEBA SIN INV']);
  assert.equal((await bod.post(`/api/prod/tandas/${tanda1}/consumo`, { consumos: [{ insumo_id: '00000000-0000-4000-8000-000000000000', cantidad: 1 }] })).status, 400);
});

test('reglas puras: FIFO parcial, receta escalada y desviación', () => {
  const r = repartirFifo({ disponibles: [{ id: 'a', restante: 1.5 }, { id: 'b', restante: 4.5 }], cantidad: 3 });
  assert.deepEqual(r.tomas, [{ id: 'a', cantidad: 1.5 }, { id: 'b', cantidad: 1.5 }]); assert.equal(r.sinOrigen, 0);
  assert.equal(repartirFifo({ disponibles: [{ id: 'a', restante: 1 }], cantidad: 3 }).sinOrigen, 2);
  assert.deepEqual(consumoSegunReceta({ items: [{ insumoId: 'x', gramos: 250 }], pesoTotalGramos: 1000 }, 8), [{ insumoId: 'x', cantidad: 2 }]);
  assert.equal(desviacion(null, 5), null); assert.equal(desviacion(10, 12), 20);
});

test('trazabilidad: tanda → tiendas, tienda y día → tanda → lote, lote → tiendas afectadas', async () => {
  const suc = (await t.db.query(`select id from core.sucursales where empresa_id = $1 and tipo <> 'fabrica' order by orden limit 1`, [eid])).rows[0].id;
  const l = (await t.db.query(`insert into rinv.lotes_mec3 (empresa_id, insumo_id, cantidad_inicial, cantidad_restante, fecha_ingreso, fecha_vencimiento) values ($1,$2,5,5,'2026-05-01','2027-05-01') returning id`, [eid, rinvA])).rows[0].id;
  await bod.post(`/api/prod/tandas/${tanda2}/consumo`, { consumos: [{ insumo_id: insA, cantidad: 2 }] });
  const lote = (await t.db.query('select lote_id from prod.produccion_lotes where produccion_id = $1', [tanda2])).rows[0].lote_id;
  const d = (await t.db.query(`insert into rep.despachos (empresa_id, fecha, sucursal_id, sabor_id, categoria, panas, gramos_enviados, estado) values ($1,$2,$3,$4,'roja',2,6000,'enviado') returning id`, [eid, hoy, suc, sabor])).rows[0].id;
  await t.db.query('insert into rep.despacho_tandas (empresa_id, despacho_id, produccion_id, gramos) values ($1,$2,$3,6000)', [eid, d, tanda2]);
  const a = (await bod.get(`/api/prod/traza/tanda/${tanda2}`)).body;
  assert.equal(a.destinos.length, 1); assert.equal(a.destinos[0].gramos, 6000);
  const b = (await bod.get(`/api/prod/traza/sucursal/${suc}/${hoy}`)).body;
  assert.equal(b.recibido.length, 1); assert.equal(b.recibido[0].lotes[0].lote_id, lote);
  const c = (await bod.get(`/api/prod/traza/lote/${lote}`)).body;
  assert.equal(c.tandas.length, 1); assert.equal(c.tiendas_afectadas[0].sucursal_id, suc); assert.equal(c.tiendas_afectadas[0].gramos, 6000);
  assert.ok(((await bod.get('/api/prod/traza/lotes')).body).some((x) => x.id === lote));
  assert.equal((await bod.get('/api/prod/traza/buscar?q=PISTA')).body.length, 1);
  assert.equal((await bod.get('/api/prod/traza/buscar?q=ab')).status, 400);
  assert.ok(l);
  // una tanda que ya salió no se corrige ni se borra
  assert.equal((await prod.patch(`/api/prod/tandas/${tanda2}`, { kg: 10 })).status, 409);
  assert.equal((await prod.del(`/api/prod/tandas/${tanda2}`)).status, 409);
});

test('plan de producción: producir lo justo, panas enteras, saldo de cámara y +25 % de Los Andes', () => {
  const agenda = (fecha, g) => [{ fecha, sabores: [{ sabor_id: 's1', nombre: 'MANGO', gramosPana: 2500, gramosEnviar: g }] }];
  const tiendas = [{ nombre: 'Mackey', agenda: agenda('2026-10-09', 6000) }, { nombre: 'Próceres', agenda: [] }];
  const p = armarPlanProduccion({ tiendas, stock: [{ sabor_id: 's1', nombre: 'MANGO', gramos_pana: 2500, gramos: 2000 }], hoy: '2026-10-08', horizonteDias: 3 });
  // sale 6000 × 1.25 = 7500 el 9; hay 2000 → faltan 5500 → 3 panas de 2500 = 7500
  const hoyP = p.porDia[0];
  assert.equal(hoyP.sabores[0].panas, 3); assert.equal(hoyP.sabores[0].kg, 7.5); assert.deepEqual(hoyP.sabores[0].tiendas, ['Mackey']);
  assert.equal(p.porDia[1].sabores.length, 0);
  assert.equal(p.totalKgAProducir, 7.5); assert.equal(p.factorLosAndes, 0.25);
  // con cámara suficiente no se produce
  const q = armarPlanProduccion({ tiendas, stock: [{ sabor_id: 's1', nombre: 'MANGO', gramos_pana: 2500, gramos: 8000 }], hoy: '2026-10-08', horizonteDias: 3 });
  assert.equal(q.totalKgAProducir, 0);
});

test('plan de producción: endpoint con la agenda de reposición y la cámara real', async () => {
  const r = await ger.get(`/api/prod/plan?hoy=${hoy}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(Array.isArray(r.body.porDia)); assert.equal(r.body.porDia.length, 7);
  assert.equal((await prod.get('/api/prod/plan')).status, 403);
});

test('reportes del dueño y bitácora', async () => {
  const rg = (await ger.get(`/api/prod/tandas/rango?desde=${hoy}&hasta=${hoy}`)).body;
  assert.equal(rg.tandas, 3); assert.ok(rg.totalKg > 0);
  assert.equal((await ger.get('/api/prod/tandas/rango?desde=2020-01-01&hasta=2026-12-31')).status, 400);
  assert.equal((await prod.get('/api/prod/tandas/rango')).status, 403);
  const rs = (await ger.get(`/api/prod/tandas/resumen?fecha=${hoy}&dias=7`)).body;
  assert.equal(rs.historico.length, 7); assert.equal(rs.historico[6].fecha, hoy);
  const dash = (await ger.get(`/api/prod/costeo/dashboard?fecha=${hoy}`)).body;
  assert.ok(dash.mes.kg_total >= 0); assert.ok(dash.costo_teorico_hoy_por_sabor.length > 30);
  const pend = (await ger.post('/api/prod/costeo/recalcular-pendientes')).body;
  assert.ok(pend.revisadas >= 0);
  const acc = (await t.db.query(`select distinct accion from core.auditoria where empresa_id = $1 and accion like 'tanda.%' or accion like 'costeo.%'`, [eid])).rows.map((x) => x.accion);
  for (const a of ['tanda.registrar', 'tanda.corregir', 'tanda.consumo_confirmar', 'costeo.precio_agregar', 'costeo.receta_guardar', 'costeo.tipo_cambio_aplicar']) assert.ok(acc.includes(a), a);
  const del = await prod.del(`/api/prod/tandas/${tanda1}`);
  assert.equal(del.status, 200);
});
