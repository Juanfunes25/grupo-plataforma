import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fechaHN } from '@grupo/shared';
import { iniciar } from './helpers.js';
import { categoriaParaGramos, panasParaCategoria } from '../src/modulos/rep/lib/reposicion.js';
import { armarRecomendacion } from '../src/modulos/rep/lib/recomendacionDespacho.js';
import { armarConsumo } from '../src/modulos/rep/lib/consumo.js';
import { repartirFifo } from '../src/modulos/rep/lib/fifo.js';
import { extraerPesajeDeFoto, reiniciarUsoIA, registrarUsoIA } from '../src/modulos/rep/lib/extraccion.js';

/** Cliente con PATCH (el helper compartido solo trae get/post/put/del). */
const cliente = (token, empresa) => {
  const ll = async (method, ruta, body) => {
    const r = await fetch(t.base + ruta, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-empresa': empresa }, body: body === undefined ? undefined : JSON.stringify(body) });
    const txt = await r.text(); let json; try { json = txt ? JSON.parse(txt) : null; } catch { json = txt; }
    return { status: r.status, body: json };
  };
  return { get: (p) => ll('GET', p), post: (p, b = {}) => ll('POST', p, b), put: (p, b = {}) => ll('PUT', p, b), patch: (p, b = {}) => ll('PATCH', p, b), del: (p) => ll('DELETE', p) };
};
let t, tienda, otraTienda, bodega, prod, ger, dueno, origen, sucMackey, sucProceres, sucAndes, S = {};
const HOY = fechaHN();
const ayer = (n = 1) => { const d = new Date(`${HOY}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

before(async () => {
  t = await iniciar();
  sucMackey = await t.sucursalId('italo', 'mackey');
  sucProceres = await t.sucursalId('italo', 'proceres');
  sucAndes = await t.sucursalId('italo', 'los_andes');
  await t.usuario({ nombre: 'Caja Mackey', accesos: [{ empresa: 'italo', rol: 'cajero', pin: '4821', sucursal_ids: [sucMackey] }] });
  await t.usuario({ nombre: 'Caja Próceres', accesos: [{ empresa: 'italo', rol: 'cajero', pin: '4822', sucursal_ids: [sucProceres] }] });
  await t.usuario({ nombre: 'Bodeguero', accesos: [{ empresa: 'italo', rol: 'bodega', pin: '5931' }] });
  await t.usuario({ nombre: 'Producción', accesos: [{ empresa: 'italo', rol: 'produccion', pin: '6042' }] });
  await t.usuario({ nombre: 'Gerente', email: 'ger@italo.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'italo', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Dueño', email: 'dueno@grupo.hn', password: 'ClaveSegura123', dueno: true });
  tienda = cliente(await t.loginPin('italo', '4821'), 'italo');
  otraTienda = cliente(await t.loginPin('italo', '4822'), 'italo');
  bodega = cliente(await t.loginPin('italo', '5931'), 'italo');
  prod = cliente(await t.loginPin('italo', '6042'), 'italo');
  ger = cliente(await t.login('italo', 'ger@italo.hn', 'ClaveSegura123'), 'italo');
  dueno = cliente(await t.login('italo', 'dueno@grupo.hn', 'ClaveSegura123'), 'italo');
  origen = cliente(await t.login('origen', 'dueno@grupo.hn', 'ClaveSegura123'), 'origen');
  const sab = (await t.db.query(`select id, nombre, gramos_pana from rep.sabores where nombre in ('MANGO','CAFFE','DUBAI','NUVOLA','PRETZEL')`)).rows;
  for (const s of sab) S[s.nombre] = s;
});
after(() => t.cerrar());

test('reglas puras: 🔴 < 3000 g = 2 panas, 🟡 3000–5000 g = 1 pana, más de 5000 no repone', () => {
  assert.equal(categoriaParaGramos(0), 'roja'); assert.equal(categoriaParaGramos(2999), 'roja');
  assert.equal(categoriaParaGramos(3000), 'amarilla'); assert.equal(categoriaParaGramos(5000), 'amarilla');
  assert.equal(categoriaParaGramos(5001), null);
  assert.equal(panasParaCategoria('roja'), 2); assert.equal(panasParaCategoria('amarilla'), 1); assert.equal(panasParaCategoria(null), 0);
});

test('migración: sabores de Italo (35), panas de 2500 g en las frutales y Los Andes fuera del análisis', async () => {
  const n = (await t.db.query(`select count(*)::int as n from rep.sabores s join core.empresas e on e.id = s.empresa_id where e.codigo = 'italo'`)).rows[0].n;
  assert.equal(n, 35);
  assert.equal(S.MANGO.gramos_pana, 2500); assert.equal(S.CAFFE.gramos_pana, 3000);
  const cfg = (await t.db.query('select sucursal_id, fuera_de_analisis from rep.sucursal_config')).rows;
  assert.equal(cfg.find((c) => c.sucursal_id === sucAndes).fuera_de_analisis, true);
  assert.equal(cfg.find((c) => c.sucursal_id === sucMackey).fuera_de_analisis, false);
  const ss = (await t.db.query(`select count(*)::int as n from rep.sucursal_sabores where sucursal_id = $1 and activo`, [sucMackey])).rows[0].n;
  assert.equal(ss, 35);
});

test('el módulo solo existe en empresas con reposición y exige permiso', async () => {
  assert.equal((await origen.get('/api/rep/sucursales')).status, 403);
  assert.equal((await tienda.get('/api/rep/sucursales')).status, 200);
  assert.equal((await tienda.get('/api/rep/analitica/rotacion')).status, 403);          // la tienda no ve el análisis
  assert.equal((await bodega.get('/api/rep/analitica/rotacion')).status, 403);
  assert.equal((await ger.get('/api/rep/analitica/rotacion')).status, 200);
  assert.equal((await tienda.get('/api/rep/gerente/auditoria')).status, 403);
  const lista = (await tienda.get('/api/rep/sucursales')).body;
  assert.deepEqual(lista.map((s) => s.alias), ['mackey']);                              // el cajero solo ve su tienda
});

test('pesaje nocturno: reposición automática, idempotencia y recálculo del despacho pendiente', async () => {
  const cuerpo = (extra = []) => ({ sucursal_id: sucMackey, fecha: ayer(1), pesajes: [
    { sabor_id: S.CAFFE.id, gramos: 2000, cliente_id: 'c-1' },     // roja
    { sabor_id: S.DUBAI.id, gramos: 4000, cliente_id: 'c-2' },     // amarilla
    { sabor_id: S.NUVOLA.id, gramos: 6200, cliente_id: 'c-3' },    // no repone
    { sabor_id: S.MANGO.id, gramos: 100, cliente_id: 'c-4' },      // roja, pana de 2500
    ...extra] });
  let r = await tienda.post('/api/rep/pesajes/lote', cuerpo());
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const por = Object.fromEntries(r.body.resultados.map((x) => [x.sabor_id, x.despacho]));
  assert.deepEqual(por[S.CAFFE.id], { categoria: 'roja', panas: 2, gramosEnviados: 6000 });
  assert.deepEqual(por[S.DUBAI.id], { categoria: 'amarilla', panas: 1, gramosEnviados: 3000 });
  assert.equal(por[S.NUVOLA.id], null);
  assert.deepEqual(por[S.MANGO.id], { categoria: 'roja', panas: 2, gramosEnviados: 5000 });
  // reenviar el mismo reporte no duplica pesajes ni despachos
  r = await tienda.post('/api/rep/pesajes/lote', cuerpo());
  assert.equal(r.status, 201);
  assert.equal((await t.db.query('select count(*)::int as n from rep.pesajes where sucursal_id = $1', [sucMackey])).rows[0].n, 4);
  assert.equal((await t.db.query('select count(*)::int as n from rep.despachos where sucursal_id = $1', [sucMackey])).rows[0].n, 3);
  // un pesaje nuevo con otro valor actualiza el pendiente; si ya no necesita reposición, el despacho se cae
  await tienda.post('/api/rep/pesajes/lote', { sucursal_id: sucMackey, fecha: ayer(1), pesajes: [{ sabor_id: S.CAFFE.id, gramos: 3500, cliente_id: 'c-5' }, { sabor_id: S.DUBAI.id, gramos: 5600, cliente_id: 'c-6' }] });
  const ds = (await t.db.query('select sabor_id, categoria, panas from rep.despachos where sucursal_id = $1 order by categoria', [sucMackey])).rows;
  assert.equal(ds.length, 2);
  assert.equal(ds.find((d) => d.sabor_id === S.CAFFE.id).categoria, 'amarilla');
  assert.ok(!ds.some((d) => d.sabor_id === S.DUBAI.id));
  // validaciones
  assert.equal((await tienda.post('/api/rep/pesajes/lote', { sucursal_id: sucMackey, fecha: ayer(1), pesajes: [{ sabor_id: S.CAFFE.id, gramos: 45000000 }] })).status, 400);
  assert.equal((await tienda.post('/api/rep/pesajes/lote', { sucursal_id: sucMackey, fecha: ayer(1), pesajes: [] })).status, 400);
});

test('una tienda no puede pesar por otra y todo queda en la bitácora', async () => {
  const r = await otraTienda.post('/api/rep/pesajes/lote', { sucursal_id: sucMackey, fecha: ayer(1), pesajes: [{ sabor_id: S.CAFFE.id, gramos: 100 }] });
  assert.equal(r.status, 403);
  const aud = (await t.db.query(`select accion from core.auditoria where accion like 'pesaje.%'`)).rows;
  assert.ok(aud.some((a) => a.accion === 'pesaje.reporte'));
  const noche = (await dueno.get(`/api/rep/pesajes/${sucMackey}/${ayer(1)}`)).body;
  assert.equal(noche.length, 6);   // 4 del primer reporte (idempotente) + 2 del segundo
});

test('despacho: la bodega arma, la tienda recibe por panas y las discrepancias quedan abiertas hasta resolverse', async () => {
  await otraTienda.post('/api/rep/pesajes/lote', { sucursal_id: sucProceres, fecha: ayer(1), pesajes: [{ sabor_id: S.PRETZEL.id, gramos: 1000 }] });
  const dia = (await bodega.get(`/api/rep/despachos/${ayer(1)}`)).body;
  assert.deepEqual(Object.keys(dia).sort(), [sucMackey, sucProceres].sort());
  const caffe = dia[sucMackey].find((d) => d.sabor_nombre === 'CAFFE');
  const mango = dia[sucMackey].find((d) => d.sabor_nombre === 'MANGO');
  assert.equal((await tienda.patch(`/api/rep/despachos/${caffe.id}/panas-enviadas`, { panas: 1 })).status, 403);   // la tienda no despacha
  assert.equal((await bodega.patch(`/api/rep/despachos/${caffe.id}/panas-enviadas`, { panas: 9 })).status, 400);
  let r = await bodega.patch(`/api/rep/despachos/${caffe.id}/panas-enviadas`, { panas: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.gramosEnviados, 3000);
  r = await bodega.patch('/api/rep/despachos/lote/panas-enviadas', { ids: [mango.id], panas: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.body.sin_tanda, 5000);                                  // sin producción registrada: la tanda queda sin identificar
  // la tienda ve lo ENVIADO HOY (día de entrega), no por la noche del pedido
  assert.deepEqual(Object.keys((await tienda.get(`/api/rep/despachos/${ayer(1)}`)).body), []);
  const hoy = (await tienda.get(`/api/rep/despachos/${HOY}`)).body;
  assert.equal(hoy[sucMackey].length, 2);
  assert.equal(hoy[sucProceres], undefined);
  // recepción: confirma en panas; 2 de 1 enviada = discrepancia
  r = await tienda.patch(`/api/rep/despachos/${caffe.id}/recepcion`, { panas_recibidas: 1 });
  assert.equal(r.body.discrepancia, false);
  r = await tienda.patch(`/api/rep/despachos/${mango.id}/recepcion`, { panas_recibidas: 1 });
  assert.equal(r.body.discrepancia, true);
  assert.equal((await tienda.patch(`/api/rep/despachos/${mango.id}/recepcion`, { panas_recibidas: 11 })).status, 400);
  assert.equal((await otraTienda.patch(`/api/rep/despachos/${mango.id}/recepcion`, { panas_recibidas: 1 })).status, 403);
  const dueDia = (await dueno.get(`/api/rep/analitica/dueno/${HOY}`)).body;
  assert.equal(dueDia.discrepancias.length, 1);
  assert.equal(dueDia.discrepancias[0].sabor_nombre, 'MANGO');
  assert.equal((await bodega.patch(`/api/rep/despachos/${mango.id}/resolver-discrepancia`)).status, 403);
  assert.equal((await ger.patch(`/api/rep/despachos/${mango.id}/resolver-discrepancia`)).status, 200);
  assert.equal((await dueno.get(`/api/rep/analitica/dueno/${HOY}`)).body.discrepancias.length, 0);
  // corregir la recepción se guarda
  r = await tienda.patch(`/api/rep/despachos/${mango.id}/corregir-recepcion`);
  assert.equal(r.status, 200);
  assert.equal((await t.db.query('select estado, discrepancia from rep.despachos where id = $1', [mango.id])).rows[0].estado, 'enviado');
  const acc = (await t.db.query(`select accion from core.auditoria where accion like 'despacho.%'`)).rows.map((a) => a.accion);
  for (const a of ['despacho.enviar', 'despacho.enviar_lote', 'despacho.recepcion', 'despacho.recepcion_discrepancia', 'despacho.resolver_discrepancia', 'despacho.corregir_recepcion']) assert.ok(acc.includes(a), a);
});

test('no disponible: sale de la ecuación y la tienda no lo ve', async () => {
  const dia = (await bodega.get(`/api/rep/despachos/${ayer(1)}`)).body;
  const pretzel = dia[sucProceres].find((d) => d.sabor_nombre === 'PRETZEL');
  assert.equal((await bodega.patch(`/api/rep/despachos/${pretzel.id}/no-disponible`)).status, 200);
  const d = (await t.db.query('select estado, panas from rep.despachos where id = $1', [pretzel.id])).rows[0];
  assert.deepEqual(d, { estado: 'no_disponible', panas: 0 });
  assert.equal((await bodega.patch(`/api/rep/despachos/${pretzel.id}/restaurar`, { estado: 'pendiente', panas: 2, gramos_enviados: 6000 })).status, 200);
});

test('tandas: el envío descuenta FIFO de las producciones y deshacerlo las devuelve', async () => {
  const eid = await t.empresaId('italo');
  const mk = async (fecha, kg, lote) => (await t.db.query(
    `insert into prod.producciones (empresa_id, fecha, sabor_id, kg, kg_restante, lote) values ($1,$2,$3,$4,$4,$5) returning id`, [eid, fecha, S.NUVOLA.id, kg, lote])).rows[0].id;
  const viejo = await mk(ayer(5), 4, 'T-VIEJA'); const nuevo = await mk(ayer(2), 10, 'T-NUEVA');
  await tienda.post('/api/rep/pesajes/lote', { sucursal_id: sucMackey, fecha: ayer(1), pesajes: [{ sabor_id: S.NUVOLA.id, gramos: 500 }] });
  const d = (await t.db.query('select id from rep.despachos where sucursal_id = $1 and sabor_id = $2', [sucMackey, S.NUVOLA.id])).rows[0];
  const r = await bodega.patch(`/api/rep/despachos/${d.id}/panas-enviadas`, { panas: 2 });   // 6 kg: 4 de la vieja + 2 de la nueva
  assert.equal(r.body.sin_tanda, 0);
  const rest = async (id) => Number((await t.db.query('select kg_restante from prod.producciones where id = $1', [id])).rows[0].kg_restante);
  assert.equal(await rest(viejo), 0); assert.equal(await rest(nuevo), 8);
  assert.equal((await t.db.query('select count(*)::int as n from rep.despacho_tandas where despacho_id = $1', [d.id])).rows[0].n, 2);
  await bodega.patch(`/api/rep/despachos/${d.id}/no-disponible`);
  assert.equal(await rest(viejo), 4); assert.equal(await rest(nuevo), 10);
  assert.deepEqual(repartirFifo({ disponibles: [{ id: 'a', restante: 1 }, { id: 'b', restante: 5 }], cantidad: 3 }), { tomas: [{ id: 'a', cantidad: 1 }, { id: 'b', cantidad: 2 }], sinOrigen: 0 });
});

test('pedidos de insumos: se suman al abierto, se editan hasta que se empiezan a preparar y se despachan lo marcado', async () => {
  let r = await tienda.post('/api/rep/pedidos', { sucursal_id: sucMackey, fecha: ayer(1), items: [{ insumo_texto: 'Vasos 8oz', cantidad: '2 cajas' }, { insumo_texto: 'Cucharitas', cantidad: '1' }] });
  assert.equal(r.status, 201);
  const id = r.body.id;
  r = await tienda.post('/api/rep/pedidos', { sucursal_id: sucMackey, fecha: ayer(1), items: [{ insumo_texto: 'Servilletas' }], notas: 'urgente' });
  assert.equal(r.status, 200); assert.equal(r.body.agregado, true); assert.equal(r.body.id, id);
  assert.equal((await t.db.query('select count(*)::int as n from rep.insumos_catalogo where nombre = $1', ['Servilletas'])).rows[0].n, 1);
  let lista = (await bodega.get('/api/rep/pedidos')).body;
  assert.equal(lista.length, 1); assert.equal(lista[0].items.length, 3);
  assert.equal((await otraTienda.get('/api/rep/pedidos')).body.length, 0);
  assert.equal((await tienda.put(`/api/rep/pedidos/${id}`, { items: [{ insumo_texto: 'Vasos 8oz', cantidad: '3 cajas' }, { insumo_texto: 'Cucharitas' }, { insumo_texto: 'Servilletas' }] })).status, 200);
  lista = (await bodega.get('/api/rep/pedidos')).body;
  const [a, b] = lista[0].items;
  assert.equal((await bodega.patch(`/api/rep/pedidos/items/${a.id}/preparado`, { preparado: true })).status, 200);
  assert.equal((await tienda.put(`/api/rep/pedidos/${id}`, { items: [{ insumo_texto: 'X' }] })).status, 409);     // ya lo están preparando
  assert.equal((await tienda.del(`/api/rep/pedidos/${id}`)).status, 409);
  assert.equal((await bodega.patch(`/api/rep/pedidos/${id}/despachar-marcados`, { items_enviados: [] })).status, 400);
  r = await bodega.patch(`/api/rep/pedidos/${id}/despachar-marcados`, { items_enviados: [a.id, b.id] });
  assert.deepEqual([r.body.enviados, r.body.sinEnviar, r.body.estado], [2, 1, 'recibido']);
  assert.equal((await bodega.patch(`/api/rep/pedidos/${id}/reabrir`, { estado: 'pedido', items_preparados: [a.id] })).status, 200);
  const ins = (await ger.get(`/api/rep/analitica/insumos-despachados?dias=30&hasta=${HOY}`)).body;
  assert.ok(Array.isArray(ins.insumos));
});

test('recomendación de despacho: modelo con historia sintética y endpoint (Los Andes queda excluida)', async () => {
  const f = (o) => { const d = new Date('2026-06-01T12:00:00Z'); d.setUTCDate(d.getUTCDate() + o); return d.toISOString().slice(0, 10); };
  const despachos = []; const pesajes = [];
  for (let sem = 0; sem < 10; sem++) for (const dow of [3, 6]) {
    despachos.push({ fecha: f(sem * 7 + dow), sucursal_id: 'p', sucursal_nombre: 'Próceres', sabor_id: 's1', sabor_nombre: 'MANGO', gramos_enviados: dow === 3 ? 6000 : 9000, gramos_pana: 3000, estado: 'recibido' });
  }
  const r = armarRecomendacion({ despachos, pesajes, hasta: f(70), hoy: f(70) });
  assert.equal(r.tiendas.length, 1);
  assert.ok(r.tiendas[0].dias.length >= 2);
  assert.ok(r.tiendas[0].dias.every((d) => d.sabores[0].gramosObjetivo > 0));
  const ep = await ger.get('/api/rep/analitica/recomendacion-despacho');
  assert.equal(ep.status, 200);
  assert.deepEqual(ep.body.excluidas.map((e) => e.nombre), ['Los Andes']);
});

test('consumo: lo que bajó la vitrina + lo que entró, cruzado con la venta del POS', async () => {
  const sab = [{ id: 's', nombre: 'CAFFE' }];
  const suc = [{ id: 'm', nombre: 'Mackey' }, { id: 'p', nombre: 'Próceres', fuera_de_analisis: false }];
  const pes = [];
  for (const [s, base] of [['m', 6000], ['p', 6000]]) for (let d = 1; d <= 6; d++) pes.push({ sucursal_id: s, sabor_id: 's', fecha: `2026-07-0${d}`, gramos: base - d * (s === 'm' ? 500 : 1000) });
  const ventas = []; for (let d = 2; d <= 6; d++) { ventas.push({ sucursal_id: 'm', fecha: `2026-07-0${d}`, total: 1000, n: 20 }); ventas.push({ sucursal_id: 'p', fecha: `2026-07-0${d}`, total: 1000, n: 20 }); }
  const c = armarConsumo({ desde: '2026-07-02', hasta: '2026-07-06', pesajes: pes, despachos: [], ventas, sucursales: suc, sabores: sab });
  const m = c.sucursales.find((x) => x.sucursal_id === 'm'); const p = c.sucursales.find((x) => x.sucursal_id === 'p');
  assert.equal(m.consumoKg, 2.5); assert.equal(p.consumoKg, 5);          // 5 noches × 500 g / 1000 g
  assert.equal(p.cruce.gramosPorCienLps, 100); assert.equal(m.cruce.gramosPorCienLps, 50);
  // con una entrega: consumo = ayer + entrada − hoy
  const c2 = armarConsumo({ desde: '2026-07-03', hasta: '2026-07-03', pesajes: [{ sucursal_id: 'm', sabor_id: 's', fecha: '2026-07-02', gramos: 1000 }, { sucursal_id: 'm', sabor_id: 's', fecha: '2026-07-03', gramos: 2000 }], despachos: [{ sucursal_id: 'm', sabor_id: 's', fecha: '2026-07-02', enviado_en: '2026-07-03', gramos_enviados: 3000, estado: 'enviado' }], sucursales: suc, sabores: sab });
  assert.equal(c2.sucursales.find((x) => x.sucursal_id === 'm').consumoKg, 2);
  const ep = await ger.get(`/api/rep/analitica/consumo?hasta=${HOY}&dias=14`);
  assert.equal(ep.status, 200);
  assert.ok(Array.isArray(ep.body.sucursales));
});

test('catálogo: fusionar sabores duplicados, normalización y permisos', async () => {
  let r = await prod.post('/api/rep/sabores', { nombre: 'Fior di latte' });
  assert.equal(r.status, 400);                                                // ya existe (sin tildes ni mayúsculas)
  r = await prod.post('/api/rep/sabores', { nombre: 'MANGO 4500' });
  assert.equal(r.status, 409); assert.equal(r.body.codigo, 'nombre_con_peso');
  r = await prod.post('/api/rep/sabores', { nombre: 'Caffe Lungo' });
  assert.equal(r.status, 409); assert.equal(r.body.codigo, 'sabor_parecido');
  r = await prod.post('/api/rep/sabores', { nombre: 'Caffe Lungo', forzar: true });
  assert.equal(r.status, 201);
  const dup = r.body.sabor_id;
  assert.equal((await tienda.post('/api/rep/sabores', { nombre: 'ZZZ' })).status, 403);
  await tienda.patch(`/api/rep/sucursales/${sucMackey}/sabores/${dup}`, { activo: true });
  await tienda.post('/api/rep/pesajes/lote', { sucursal_id: sucMackey, fecha: ayer(3), pesajes: [{ sabor_id: dup, gramos: 4000 }] });
  assert.equal((await tienda.post(`/api/rep/sabores/${dup}/fusionar`, { en: S.CAFFE.id })).status, 403);
  r = await ger.post(`/api/rep/sabores/${dup}/fusionar`, { en: S.CAFFE.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.movidos.pesajes, 1);
  assert.equal((await t.db.query('select count(*)::int as n from rep.pesajes where sabor_id = $1 and fecha = $2', [S.CAFFE.id, ayer(3)])).rows[0].n, 1);
  // la tienda decide qué sabores pesa
  const cat = (await tienda.get(`/api/rep/sucursales/${sucMackey}/catalogo`)).body;
  assert.ok(cat.length >= 35);
  await tienda.patch(`/api/rep/sucursales/${sucMackey}/sabores/${S.WHISKY?.id ?? S.PRETZEL.id}`, { activo: false });
  const pesa = (await tienda.get(`/api/rep/sucursales/${sucMackey}/sabores`)).body;
  assert.ok(!pesa.some((x) => x.id === S.PRETZEL.id));
});

test('resumen diario: contenido listo, envío «pendiente de configurar»', async () => {
  const r = await ger.get(`/api/rep/analitica/resumen/${ayer(1)}`);
  assert.equal(r.status, 200);
  assert.match(r.body.texto, /Lista de envíos/);
  assert.equal(r.body.correoConfigurado, false);
  const e = await ger.post(`/api/rep/analitica/resumen/${ayer(1)}/enviar`);
  assert.equal(e.status, 200); assert.equal(e.body.enviado, false); assert.equal(e.body.estado, 'pendiente_configurar');
  assert.equal((await t.db.query('select estado from rep.resumenes')).rows[0].estado, 'pendiente_configurar');
  assert.equal((await tienda.post(`/api/rep/analitica/resumen/${ayer(1)}/enviar`)).status, 403);
});

test('lectura por foto: desactivada sin ANTHROPIC_API_KEY; con llave clasifica lo leído', async () => {
  const antes = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  assert.equal((await tienda.get('/api/rep/extraccion/estado')).body.disponible, false);
  const r = await tienda.post(`/api/rep/extraccion/${sucMackey}`, { imageBase64: 'A'.repeat(100) });
  assert.equal(r.status, 503); assert.match(r.body.error, /ANTHROPIC_API_KEY/);
  const fetchFalso = async () => ({ ok: true, json: async () => ({ content: [{ type: 'tool_use', input: { items: [{ nombre: 'caffe', componentes: [2000, 500], total: 2500, texto_crudo: '2000+500', confianza: 'alta', legible: true }, { nombre: 'Raro', componentes: [], total: null, texto_crudo: '?', confianza: 'baja', legible: false }] } }] }) });
  const x = await extraerPesajeDeFoto({ imageBase64: 'x', nombresSabores: ['CAFFE', 'DUBAI'], fetchFn: fetchFalso, env: { ANTHROPIC_API_KEY: 'k' } });
  assert.equal(x.sabores[0].nombre, 'CAFFE'); assert.equal(x.sabores_nuevos.length, 1);
  reiniciarUsoIA();
  for (let i = 0; i < 20; i++) assert.equal(registrarUsoIA('u').permitido, true);
  assert.equal(registrarUsoIA('u').permitido, false);
  reiniciarUsoIA();
  if (antes) process.env.ANTHROPIC_API_KEY = antes;
});

test('gerente digital: auditoría, simulador, cobertura y descartes (solo dirección)', async () => {
  assert.equal((await bodega.get('/api/rep/gerente/auditoria')).status, 403);
  const a = await ger.get('/api/rep/gerente/auditoria');
  assert.equal(a.status, 200);
  assert.ok(a.body.resumen.verificaciones > 10);
  assert.equal(a.body.resumen.conError, 0, JSON.stringify(a.body.errores));
  assert.equal((await ger.post('/api/rep/gerente/descartes', { huella: 'x:y', estado: 'visto' })).status, 200);
  assert.equal((await ger.del('/api/rep/gerente/descartes?huella=x%3Ay')).status, 200);
  assert.equal((await ger.get('/api/rep/gerente/simulador/base')).status, 200);
  const c = await ger.get('/api/rep/gerente/cobertura');
  assert.equal(c.status, 200);
  assert.equal((await ger.put('/api/rep/gerente/cobertura/minimo', { sucursal_id: sucMackey, dia_semana: 2, minimo: 3 })).status, 200);
  assert.equal((await ger.put('/api/rep/gerente/cobertura/minimo', { sucursal_id: sucMackey, dia_semana: 9, minimo: 3 })).status, 400);
  assert.equal((await ger.put('/api/rep/gerente/cobertura/minimo', { sucursal_id: sucMackey, dia_semana: 2, minimo: null })).status, 200);
});

test('historial de pesajes: noches con reporte dentro del rango', async () => {
  const h = await ger.get(`/api/rep/pesajes/historial?sucursal_id=${sucMackey}&hasta=${HOY}&dias=14`);
  assert.equal(h.status, 200);
  assert.ok(h.body.nochesConReporte >= 1);
  assert.equal(h.body.diasEnRango, 14);
  assert.equal((await tienda.get(`/api/rep/pesajes/historial?sucursal_id=${sucMackey}`)).status, 403);
});

test('tablero de gelato: semáforo por tienda, solo para administración', async () => {
  const noche = () => ayer(40);   // una noche que ningún otro test tocó
  await tienda.post('/api/rep/pesajes/lote', { sucursal_id: sucMackey, fecha: noche(), pesajes: [{ sabor_id: S.MANGO.id, gramos: 1000 }] });
  assert.equal((await tienda.get('/api/rep/tablero')).status, 403);
  assert.equal((await bodega.get('/api/rep/tablero')).status, 403);
  const r = await dueno.get(`/api/rep/tablero?fecha=${noche()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.noche.fecha, noche()); assert.equal(r.body.noche.esHoy, false);
  const mk = r.body.tiendas.find((t) => t.id === sucMackey), pr = r.body.tiendas.find((t) => t.id === sucProceres), an = r.body.tiendas.find((t) => t.id === sucAndes);
  assert.equal(mk.estado, 'parcial'); assert.ok(mk.pesados >= 1 && mk.pesados < mk.esperados);
  assert.equal(pr.estado, 'falta');          // otra noche, nadie pesó: rojo
  assert.equal(an.estado, 'opcional');       // Los Andes no se pinta de rojo
  assert.ok(r.body.alertas.some((a) => a.id === `sin-pesar-${sucProceres}`));
  assert.ok(r.body.despacho.sabores_totales >= 1 && Array.isArray(r.body.consumo));
  assert.equal((await ger.get('/api/rep/tablero')).status, 200);
});

test('tablero: «falta» solo con la noche cerrada; un pesaje de madrugada cuenta para la noche anterior; PIN de tienda único', async () => {
  const { estadoDeTienda } = await import('../src/modulos/rep/tablero.js');
  assert.equal(estadoDeTienda({ pesados: 0, esperados: 35, abierta: true }), 'pendiente');   // de noche nunca es rojo
  assert.equal(estadoDeTienda({ pesados: 0, esperados: 35, abierta: false }), 'falta');
  assert.equal(estadoDeTienda({ pesados: 0, esperados: 35, abierta: false, fuera: true }), 'opcional');
  // pesaje a las 12:30 a. m. (06:30 UTC): fecha del día nuevo, pero la noche anterior lo ve como suyo
  const f = ayer(60), sig = ayer(59);
  await t.db.query(`insert into rep.pesajes (empresa_id, sucursal_id, sabor_id, fecha, gramos, created_at)
                    values ((select id from core.empresas where codigo='italo'), $1, $2, $3, 1000, ($3::date + time '06:30') at time zone 'UTC')`, [sucProceres, S.MANGO.id, sig]);
  const r = await dueno.get(`/api/rep/tablero?fecha=${f}`);
  assert.equal(r.body.tiendas.find((x) => x.id === sucProceres).pesados, 1);
  // acceso de tienda: un solo PIN compartido, único en la empresa, con la sucursal fija
  const crear = (nombre, pin, suc) => dueno.post('/api/admin/usuarios', { nombre, rol: 'cajero', pin, sucursal_ids: [suc] });
  assert.equal((await crear('Tienda Mackey (acceso)', '8765', sucMackey)).status, 201);
  assert.equal((await crear('Tienda Próceres (acceso)', '8765', sucProceres)).status, 409);   // PIN repetido
  const tk = cliente(await t.loginPin('italo', '8765'), 'italo');
  assert.equal((await tk.post('/api/rep/pesajes/lote', { sucursal_id: sucProceres, fecha: HOY, pesajes: [{ sabor_id: S.MANGO.id, gramos: 900 }] })).status, 403);   // solo su sucursal
  assert.equal((await tk.post('/api/rep/pesajes/lote', { sucursal_id: sucMackey, fecha: HOY, pesajes: [{ sabor_id: S.CAFFE.id, gramos: 900 }] })).status, 201);
  const aud = (await t.db.query(`select count(*)::int as n from core.auditoria where accion = 'pesaje.reporte' and sucursal_id = $1 and usuario_nombre = 'Tienda Mackey (acceso)'`, [sucMackey])).rows[0].n;
  assert.ok(aud >= 1);   // queda registrado a nombre de la tienda y con la sucursal
});

test('despacho: los pesajes de madrugada (después de las 12 a. m.) aparecen en la noche anterior', async () => {
  const f = ayer(70), sig = ayer(69);
  const tk = cliente(await t.loginPin('italo', '4822'), 'italo');   // Próceres
  assert.equal((await tk.post('/api/rep/pesajes/lote', { sucursal_id: sucProceres, fecha: sig, pesajes: [{ sabor_id: S.DUBAI.id, gramos: 500 }] })).status, 201);
  await t.db.query(`update rep.pesajes set created_at = ($1::date + time '06:30') at time zone 'UTC' where sucursal_id = $2 and fecha = $1 and sabor_id = $3`, [sig, sucProceres, S.DUBAI.id]);
  const noche = await bodega.get(`/api/rep/analitica/panel-despacho/${f}`);
  assert.equal(noche.status, 200);
  assert.ok((noche.body.porSucursal[sucProceres] || []).some((d) => d.sabor_id === S.DUBAI.id), 'el pesaje de las 12:30 a. m. es de la noche anterior');
  assert.ok(noche.body.reportadoPorSucursal[sucProceres]);
  // uno hecho de tarde con la fecha nueva NO se cuela en la noche anterior
  const g = ayer(80), sig2 = ayer(79);
  await tk.post('/api/rep/pesajes/lote', { sucursal_id: sucProceres, fecha: sig2, pesajes: [{ sabor_id: S.NUVOLA.id, gramos: 500 }] });
  await t.db.query(`update rep.pesajes set created_at = ($1::date + time '20:00') at time zone 'UTC' where sucursal_id = $2 and fecha = $1 and sabor_id = $3`, [sig2, sucProceres, S.NUVOLA.id]);
  const otra = await bodega.get(`/api/rep/analitica/panel-despacho/${g}`);
  assert.ok(!(otra.body.porSucursal[sucProceres] || []).some((d) => d.sabor_id === S.NUVOLA.id));
});
