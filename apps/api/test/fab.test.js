import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from './helpers.js';
import { costoDeReceta } from '../src/modulos/fab/produccion.js';

let t, ger, prod, bod, otra, eid, pA, pB;

before(async () => {
  t = await iniciar();
  eid = await t.empresaId('ecostone');
  await t.usuario({ nombre: 'Gerente Eco', email: 'ger@eco.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'ecostone', rol: 'admin' }, { empresa: 'italo', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Productor', accesos: [{ empresa: 'ecostone', rol: 'produccion', pin: '5151' }] });
  await t.usuario({ nombre: 'Bodeguero', accesos: [{ empresa: 'ecostone', rol: 'bodega', pin: '6161' }] });
  ger = t.cli(await t.login('ecostone', 'ger@eco.hn', 'ClaveSegura123'), 'ecostone');
  otra = t.cli(await t.login('italo', 'ger@eco.hn', 'ClaveSegura123'), 'italo');
  prod = t.cli(await t.loginPin('ecostone', '5151'), 'ecostone');
  bod = t.cli(await t.loginPin('ecostone', '6161'), 'ecostone');
  const mk = async (nombre, modelo, color) => (await t.db.query(
    `insert into pos.productos (empresa_id, codigo, nombre, precio, es_piedra, modelo, color, unidad_venta, m2_por_caja) values ($1,$2,$3,300,true,$4,$5,'m2',1) returning id`,
    [eid, nombre, nombre, modelo, color])).rows[0].id;
  pA = await mk('Cantera Beige', 'Cantera', 'Beige');
  pB = await mk('Río Gris', 'Río', 'Gris');
});
after(() => t.cerrar());

const insumoPorCodigo = async (c) => (await t.db.query('select * from fab.insumos where empresa_id = $1 and codigo = $2', [eid, c])).rows[0];
const stock = async (id) => Number((await t.db.query('select coalesce(sum(cantidad),0) as s from fab.mov_insumos where insumo_id = $1', [id])).rows[0].s);

test('solo EcoStone (módulo fabrica) y según permisos', async () => {
  assert.equal((await otra.get('/api/fab/insumos')).status, 403);
  assert.equal((await ger.get('/api/fab/insumos')).status, 200);
  assert.equal((await prod.get('/api/fab/recetas')).status, 403);        // recetas: solo gerencia
  assert.equal((await prod.get('/api/fab/registro/catalogo')).status, 200);
  assert.equal((await bod.get('/api/fab/registro/catalogo')).status, 403);
});

test('reglas puras: costo por m² = insumos × (1+merma) + mano de obra + indirectos', () => {
  const c = costoDeReceta({ merma_esperada_pct: 10, mano_obra_m2: 5, indirectos_m2: 3 }, [{ cantidad_m2: 2, costo_promedio: 10 }, { cantidad_m2: 1, costo_promedio: 30 }]);
  assert.equal(c.insumos, 50); assert.equal(c.insumos_con_merma, 55); assert.equal(c.total_m2, 63);
});

test('compras: costo promedio ponderado, USD a tipo de cambio, kardex y stock negativo bloqueado', async () => {
  const cem = await insumoPorCodigo('MP-CEM-01');
  const pig = await insumoPorCodigo('MP-PIG-01');
  let r = await bod.post(`/api/fab/insumos/${cem.id}/movimiento`, { tipo: 'compra', cantidad: 100, costo_unitario: 200 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  r = await bod.post(`/api/fab/insumos/${cem.id}/movimiento`, { tipo: 'compra', cantidad: 100, costo_unitario: 300 });
  assert.equal(r.status, 201);
  let lista = (await ger.get('/api/fab/insumos')).body;
  assert.equal(lista.find((i) => i.id === cem.id).costo_promedio, 250);   // (100×200 + 100×300) / 200
  assert.equal(lista.find((i) => i.id === cem.id).stock, 200);
  r = await bod.post(`/api/fab/insumos/${pig.id}/movimiento`, { tipo: 'compra', cantidad: 10, costo_unitario: 4, moneda: 'USD', documento: 'F-77' });
  assert.equal(r.status, 201);
  lista = (await ger.get('/api/fab/insumos')).body;
  assert.equal(lista.find((i) => i.id === pig.id).costo_promedio, 105.2);   // 4 US$ × 26.3
  assert.equal((await bod.post(`/api/fab/insumos/${cem.id}/movimiento`, { tipo: 'merma', cantidad: 5 })).status, 400);   // sin motivo
  assert.equal((await bod.post(`/api/fab/insumos/${cem.id}/movimiento`, { tipo: 'merma', cantidad: 500, motivo: 'x' })).status, 409);   // stock insuficiente
  assert.equal((await prod.post(`/api/fab/insumos/${cem.id}/movimiento`, { tipo: 'compra', cantidad: 1, costo_unitario: 1 })).status, 403);
  const k = (await ger.get(`/api/fab/insumos/${cem.id}/kardex`)).body;
  assert.equal(k.length, 2);
  // el bodeguero no ve costos
  assert.equal((await bod.get('/api/fab/insumos')).body.find((i) => i.id === cem.id).costo_promedio, undefined);
});

let recetaA;
test('recetas: costo por m² y margen, una sola activa por producto', async () => {
  const cem = await insumoPorCodigo('MP-CEM-01'); const are = await insumoPorCodigo('MP-ARE-01'); const pig = await insumoPorCodigo('MP-PIG-01');
  await ger.post(`/api/fab/insumos/${are.id}/movimiento`, { tipo: 'compra', cantidad: 1000, costo_unitario: 2 });
  await ger.post(`/api/fab/insumos/${pig.id}/movimiento`, { tipo: 'compra', cantidad: 10, costo_unitario: 4, moneda: 'USD' });
  const body = { producto_id: pA, nombre: 'Mezcla v1', merma_esperada_pct: 10, mano_obra_m2: 20, indirectos_m2: 10,
    items: [{ insumo_id: cem.id, cantidad_m2: 0.2 }, { insumo_id: are.id, cantidad_m2: 5 }, { insumo_id: pig.id, cantidad_m2: 0.05 }] };
  let r = await ger.post('/api/fab/recetas', body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  recetaA = r.body.id;
  // cem 250×0.2=50 + are 2×5=10 + pig 105.2×0.05=5.26 = 65.26 ; ×1.1 = 71.786 ; +30 = 101.786 → 101.79
  assert.equal(r.body.costo.total_m2, 101.79);
  assert.equal(Number((await t.db.query('select costo_estandar from pos.productos where id = $1', [pA])).rows[0].costo_estandar), 101.79);
  const lista = (await ger.get('/api/fab/recetas')).body;
  const rec = lista.find((x) => x.id === recetaA);
  assert.equal(rec.costo.total_m2, 101.79);
  assert.ok(rec.margen_pct_publico > 0 && rec.margen_pct_publico < 100);
  assert.equal((await ger.post('/api/fab/recetas', { ...body, items: [] })).status, 400);
  // nueva receta desactiva la anterior
  r = await ger.post('/api/fab/recetas', { ...body, nombre: 'Mezcla v2' });
  const act = (await t.db.query('select nombre from fab.recetas where producto_id = $1 and activa', [pA])).rows;
  assert.deepEqual(act.map((x) => x.nombre), ['Mezcla v2']);
});

test('registrar producción: descuenta insumos según receta, lote en secado, anti doble toque', async () => {
  const cem = await insumoPorCodigo('MP-CEM-01');
  const antes = await stock(cem.id);
  const r = await prod.post('/api/fab/registro', { producto_id: pA, cantidad: 50 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.lote, /^EC-\d{6}-01$/);
  // 0.2 × 50 × 1.10 = 11
  assert.equal(antes - (await stock(cem.id)), 11);
  const lote = (await t.db.query('select * from fab.lotes where empresa_id = $1 and codigo = $2', [eid, r.body.lote])).rows[0];
  assert.equal(lote.estado, 'secado'); assert.equal(Number(lote.cantidad_disponible), 0); assert.equal(Number(lote.cantidad_producida), 50);
  assert.ok(lote.operario);
  assert.equal((await prod.post('/api/fab/registro', { producto_id: pA, cantidad: 50 })).status, 409);   // doble toque
  assert.equal((await prod.post('/api/fab/registro', { producto_id: pA, cantidad: 2.5 })).status, 400);
  const rec = (await prod.get('/api/fab/registro/recientes')).body;
  assert.equal(rec.length, 1); assert.equal(rec[0].estado, 'curando');
  // sin receta: se registra igual, sin descontar, con aviso y alerta
  const s = await prod.post('/api/fab/registro', { producto_id: pB, cantidad: 10 });
  assert.equal(s.status, 201); assert.equal(s.body.avisos.length, 1);
  assert.equal((await t.db.query(`select count(*)::int as n from fab.alertas where tipo = 'produccion.sin_receta'`)).rows[0].n, 1);
});

test('registrar con insumos insuficientes fuerza el movimiento: stock negativo y alerta', async () => {
  const pig = await insumoPorCodigo('MP-PIG-01');
  const r = await prod.post('/api/fab/registro', { producto_id: pA, cantidad: 5000 });   // 0.05×5000×1.1 = 275 de pigmento, hay ~20
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.avisos.some((a) => /menos materia prima/.test(a)));
  assert.ok((await stock(pig.id)) < 0);
  assert.ok((await ger.get('/api/fab/reporte')).body.insumos_criticos.some((i) => i.nombre === pig.nombre && i.stock < 0));
});

let loteListo;
test('orden planificada → colada con consumo real y desvíos → lista con 1ª, 2ª y merma', async () => {
  const cem = await insumoPorCodigo('MP-CEM-01'); const are = await insumoPorCodigo('MP-ARE-01');
  await ger.post(`/api/fab/insumos/${cem.id}/movimiento`, { tipo: 'compra', cantidad: 1000, costo_unitario: 250 });
  await ger.post(`/api/fab/insumos/${are.id}/movimiento`, { tipo: 'compra', cantidad: 30000, costo_unitario: 2 });
  await ger.post(`/api/fab/insumos/${(await insumoPorCodigo('MP-PIG-01')).id}/movimiento`, { tipo: 'compra', cantidad: 300, costo_unitario: 4, moneda: 'USD' });
  assert.equal((await ger.post('/api/fab/ordenes', { producto_id: pB, m2_planificado: 10 })).status, 400);   // sin receta
  const molde = (await ger.post('/api/fab/moldes', { codigo: 'M-1', nombre: 'Molde Cantera', producto_id: pA, m2_por_colada: 4 })).body;
  const o = (await ger.post('/api/fab/ordenes', { producto_id: pA, m2_planificado: 20, molde_id: molde.id })).body;
  assert.equal(o.estado, 'planificada'); assert.equal(o.coladas, 5);
  const mrp = (await ger.get('/api/fab/mrp')).body;
  assert.equal(mrp.ordenes_planificadas, 1);
  assert.ok(mrp.insumos.find((i) => i.id === cem.id).requerido > 0);
  const det = (await ger.get(`/api/fab/ordenes/${o.id}`)).body;
  assert.equal(det.consumos.find((c) => c.insumo_id === cem.id).teorico, 4.4);   // 0.2 × 20 × 1.1
  const antes = await stock(cem.id);
  const c = await ger.post(`/api/fab/ordenes/${o.id}/colar`, { consumos: [{ insumo_id: cem.id, real: 6 }] });   // +36 %
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.estado, 'curando'); assert.equal(c.body.desvios.length, 1);
  assert.equal(antes - (await stock(cem.id)), 6);
  assert.equal((await ger.post(`/api/fab/ordenes/${o.id}/colar`, {})).status, 400);   // ya colada
  assert.equal(Number((await t.db.query('select usos from fab.moldes where id = $1', [molde.id])).rows[0].usos), 5);
  assert.equal((await t.db.query(`select count(*)::int as n from fab.alertas where tipo = 'produccion.consumo_desviado'`)).rows[0].n, 1);
  // calidad
  assert.equal((await ger.post(`/api/fab/ordenes/${o.id}/calidad`, { prueba: 'Absorción de agua (ASTM C1670)', resultado: 'rechazado', valor: 18, unidad: '%' })).status, 201);
  assert.equal((await bod.post(`/api/fab/ordenes/${o.id}/terminar`, {})).status, 400);   // rechazado: solo gerencia
  assert.equal((await prod.post(`/api/fab/ordenes/${o.id}/terminar`, {})).status, 403);
  const f = await ger.post(`/api/fab/ordenes/${o.id}/terminar`, { m2_bueno: 15, m2_segunda: 3, m2_merma: 2 });
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.equal(f.body.merma_pct, 10);   // 2 / (15+3+2)
  assert.equal(f.body.estado, 'terminada');
  const lotes = (await t.db.query('select * from fab.lotes where orden_id = $1 order by calidad', [o.id])).rows;
  assert.equal(lotes.length, 2);
  assert.equal(lotes[0].calidad, 'primera'); assert.equal(Number(lotes[0].cantidad_disponible), 15); assert.equal(lotes[0].estado, 'lista');
  assert.equal(lotes[1].calidad, 'segunda'); assert.equal(Number(lotes[1].cantidad_disponible), 3);
  // costo real = (costo_mp + 20×18 + 10×18) / 18
  const ord = (await ger.get(`/api/fab/ordenes/${o.id}`)).body;
  assert.ok(Number(ord.costo_m2) > 30);
  assert.equal((await ger.post(`/api/fab/ordenes/${o.id}/terminar`, {})).status, 400);   // ya está lista
  loteListo = o.lote;
});

test('pasa solo a lista para vender al cumplir los días (y no si hay calidad rechazada)', async () => {
  const a = (await prod.get('/api/fab/registro/recientes')).body.find((x) => x.estado === 'curando');
  assert.ok(a);
  await t.db.query(`update fab.ordenes set fecha_disponible = current_date - 1 where id = $1`, [a.id]);
  await ger.get('/api/fab/resumen');   // abrir una pantalla dispara la liberación
  const o = (await t.db.query('select estado, m2_bueno from fab.ordenes where id = $1', [a.id])).rows[0];
  assert.equal(o.estado, 'terminada'); assert.equal(Number(o.m2_bueno), Number(a.cantidad));
  const l = (await t.db.query(`select estado, cantidad_disponible from fab.lotes where orden_id = $1`, [a.id])).rows[0];
  assert.equal(l.estado, 'lista');
});

test('FIFO: reservar, consumir (primero lo reservado), liberar y agotar', async () => {
  // dos lotes de pA: L1 (más viejo, 15 de la prueba anterior ya en lista) + otros. Se arma un escenario limpio con producto nuevo.
  const pC = (await t.db.query(`insert into pos.productos (empresa_id, codigo, nombre, precio, es_piedra, unidad_venta) values ($1,'C','Prueba FIFO',100,true,'m2') returning id`, [eid])).rows[0].id;
  const mkLote = async (codigo, cant, dias) => (await t.db.query(
    `insert into fab.lotes (empresa_id, codigo, producto_id, estado, cantidad_producida, cantidad_disponible, fecha_lista) values ($1,$2,$3,'lista',$4,$4, now() - ($5 || ' days')::interval) returning id`,
    [eid, codigo, pC, cant, String(dias)])).rows[0].id;
  const l1 = await mkLote('F-1', 10, 3); const l2 = await mkLote('F-2', 10, 1);
  const ref1 = '11111111-1111-1111-1111-111111111111'; const ref2 = '22222222-2222-2222-2222-222222222222';
  const sel = async (id) => (await t.db.query('select cantidad_disponible d, cantidad_reservada r, cantidad_libre l, estado from fab.lotes where id = $1', [id])).rows[0];
  let r = (await t.db.query('select fab.reservar($1,$2,12,$3,$4,$5,null) as r', [eid, pC, ref1, 'COT-1', 'Cliente Uno'])).rows[0].r;
  assert.equal(r.reservado, 12); assert.equal(r.faltante, 0);
  assert.equal((await sel(l1)).r, 10); assert.equal((await sel(l2)).r, 2);   // el más viejo primero
  r = (await t.db.query('select fab.reservar($1,$2,12,$3,$4,$5,null) as r', [eid, pC, ref1, 'COT-1', 'Cliente Uno'])).rows[0].r;   // idempotente
  assert.equal(r.reservado, 0); assert.equal(r.ya_reservado, 12);
  r = (await t.db.query('select fab.reservar($1,$2,20,$3,$4,$5,null) as r', [eid, pC, ref2, 'COT-2', 'Cliente Dos'])).rows[0].r;
  assert.equal(r.reservado, 8); assert.equal(r.faltante, 12);   // solo quedaban 8 libres
  // Consumir 12 con ref1: usa lo reservado para ref1 (10 de L1 + 2 de L2); lo reservado para ref2 sigue intacto
  r = (await t.db.query('select fab.consumir($1,$2,12,$3,null,$4,$5,null,true) as r', [eid, pC, ref1, 'FAC-1', 'Cliente Uno'])).rows[0].r;
  assert.equal(r.consumido, 12); assert.equal(r.faltante, 0);
  let a = await sel(l1); assert.equal(a.d, 0); assert.equal(a.estado, 'agotado');
  a = await sel(l2); assert.equal(a.d, 8); assert.equal(a.r, 8);
  // Liberar la reserva 2
  assert.equal(Number((await t.db.query('select fab.liberar($1,$2,null) as n', [eid, ref2])).rows[0].n), 8);
  a = await sel(l2); assert.equal(a.r, 0); assert.equal(a.l, 8);
  // Consumir de más: forzar=true devuelve faltante; forzar=false falla
  r = (await t.db.query('select fab.consumir($1,$2,10,null,null,$3,null,null,true) as r', [eid, pC, 'FAC-2'])).rows[0].r;
  assert.equal(r.consumido, 8); assert.equal(r.faltante, 2);
  assert.equal((await sel(l2)).estado, 'agotado');
  await assert.rejects(t.db.query('select fab.consumir($1,$2,1,null,null,null,null,null,false)', [eid, pC]), /insuficiente/);
  const stockP = (await t.db.query('select fisico, libre from fab.stock_piedra where producto_id = $1', [pC])).rows[0];
  assert.equal(Number(stockP.fisico), 0);
});

test('trazabilidad: ficha del lote con insumos, última compra, calidad e historia; etiqueta cuenta impresiones', async () => {
  const f = await ger.get(`/api/fab/trazabilidad/lote/${loteListo}`);
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.equal(f.body.orden.estado, 'terminada');
  assert.equal(f.body.orden.cantidad_lista, 15); assert.equal(f.body.orden.segunda, 3);
  assert.ok(f.body.consumos.length >= 3);
  const cem = f.body.compras.find((c) => /Cemento/.test(c.insumo));
  assert.ok(cem.ultima_compra); assert.equal(cem.ultima_compra.cantidad, 1000);
  assert.equal(f.body.calidad[0].resultado, 'rechazado');
  assert.equal(f.body.inventario.fisico, 18);
  assert.equal((await ger.get('/api/fab/trazabilidad/lote/NO-EXISTE')).status, 404);
  const lista = (await ger.get('/api/fab/trazabilidad?q=ec-')).body;
  assert.ok(lista.some((x) => x.lote === loteListo));
  // el bodeguero ve la ficha pero sin costos
  const fb = (await bod.get(`/api/fab/trazabilidad/lote/${loteListo}`)).body;
  assert.equal(fb.orden.costo_m2, null);
  const e = await ger.post(`/api/fab/trazabilidad/lote/${loteListo}/etiqueta`, { modo: 'cajas' });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.match(e.body.url, new RegExp(`/ecostone/trazabilidad\\?lote=${loteListo}`));
  await ger.post(`/api/fab/trazabilidad/lote/${loteListo}/etiqueta`, {});
  assert.equal((await ger.get(`/api/fab/trazabilidad/lote/${loteListo}`)).body.orden.etiquetas_impresas, 2);
  const aud = (await t.db.query(`select count(*)::int as n from core.auditoria where accion = 'produccion.etiqueta'`)).rows[0].n;
  assert.equal(aud, 2);
});

test('reporte de producción y parámetros', async () => {
  const r = (await ger.get('/api/fab/reporte')).body;
  assert.ok(r.kpis.registros >= 4);
  assert.ok(r.kpis.m2_producidos > 0);
  assert.ok(r.consumo.length > 0);
  assert.equal(r.calidad.rechazado, 1);
  assert.equal((await bod.get('/api/fab/reporte')).status, 403);
  assert.equal((await ger.put('/api/fab/parametros/dias_a_inventario', { valor: 7 })).status, 200);
  assert.equal((await ger.get('/api/fab/parametros')).body.find((p) => p.clave === 'dias_a_inventario').valor, 7);
  assert.equal((await ger.put('/api/fab/parametros/inventada', { valor: 1 })).status, 404);
  const agenda = (await ger.get('/api/fab/agenda')).body;
  assert.ok(Array.isArray(agenda));
});
