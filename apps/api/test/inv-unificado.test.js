import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from './helpers.js';
import { estadoDe } from '../src/modulos/inv/adaptadores.js';

let t, dueno, bodOrigen, gerOrigen, cajero, oId, iId, eId, dId, sucMackey, sucProceres, sucPrincipal;

before(async () => {
  t = await iniciar();
  oId = await t.empresaId('origen'); iId = await t.empresaId('italo'); eId = await t.empresaId('ecostone'); dId = await t.empresaId('diserco');
  sucMackey = await t.sucursalId('italo', 'mackey'); sucProceres = await t.sucursalId('italo', 'proceres'); sucPrincipal = await t.sucursalId('origen', 'principal');
  await t.usuario({ nombre: 'Dueño', email: 'd@grupo.hn', password: 'ClaveSegura123', dueno: true });
  await t.usuario({ nombre: 'Gerente Origen', email: 'g@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Bodeguero', accesos: [{ empresa: 'origen', rol: 'bodega', pin: '2424' }] });
  await t.usuario({ nombre: 'Cajera', accesos: [{ empresa: 'origen', rol: 'cajero', pin: '1313' }] });
  const con = (token, emp) => t.cli(token, emp);
  const tk = await t.login('italo', 'd@grupo.hn', 'ClaveSegura123');
  dueno = (emp) => con(tk, emp);
  gerOrigen = con(await t.login('origen', 'g@origen.hn', 'ClaveSegura123'), 'origen');
  bodOrigen = con(await t.loginPin('origen', '2424'), 'origen');
  cajero = con(await t.loginPin('origen', '1313'), 'origen');
});
after(() => t.cerrar());

test('estado uniforme', () => {
  assert.equal(estadoDe(-1, 5), 'negativo'); assert.equal(estadoDe(0, 5), 'agotado'); assert.equal(estadoDe(3, 5), 'bajo');
  assert.equal(estadoDe(9, 5), 'ok'); assert.equal(estadoDe(9, null), 'ok'); assert.equal(estadoDe(0, 0, true), 'sin_cargar');
});

test('Origen: existencias unificadas, mínimo, vencimiento y costo oculto sin permiso', async () => {
  const ins = (await gerOrigen.post('/api/inv/insumos', { nombre: 'Fresa', categoria: 'Fruta', unidad: 'kg', costo_actual: 40, stock_minimo: 10, perecedero: true })).body;
  const vence = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const c = await gerOrigen.post('/api/inv/compras', { sucursal_id: sucPrincipal, items: [{ insumo_id: ins.id, cantidad: 6, costo_unitario: 40, vence_at: vence }] });
  assert.equal(c.status, 201);
  const r = await gerOrigen.get('/api/inv/u/existencias');
  assert.equal(r.status, 200);
  const f = r.body.items.find((i) => i.nombre === 'Fresa');
  assert.equal(f.existencia, 6); assert.equal(f.estado, 'bajo'); assert.equal(f.valor, 240); assert.equal(f.fuente, 'inv'); assert.equal(f.vence, vence);
  assert.equal(r.body.resumen.bajo_minimo, 1);
  const a = await gerOrigen.get('/api/inv/u/alertas?dias=5');
  assert.equal(a.body.vencimientos.length, 1); assert.equal(a.body.bajo_minimo[0].nombre, 'Fresa');
  // el cajero no tiene inv:ver
  assert.equal((await cajero.get('/api/inv/u/existencias')).status, 403);
});


const stockInv = async (insumo, suc) => Number((await t.db.query('select coalesce(sum(cantidad),0) as s from inv.movimientos where insumo_id = $1 and sucursal_id = $2', [insumo, suc])).rows[0].s);

test('conteo cíclico: el bodeguero cuenta a ciegas, el gerente aprueba y el ajuste queda en kardex y bitácora', async () => {
  const fresa = (await t.db.query(`select id from inv.insumos where nombre = 'Fresa'`)).rows[0].id;
  const c = (await gerOrigen.post('/api/inv/u/conteos', { nombre: 'Conteo de fruta', categoria: 'Fruta' })).body;
  assert.equal(c.estado, 'programado');
  assert.equal((await bodOrigen.post(`/api/inv/u/conteos/${c.id}/iniciar`)).status, 200);
  const det = (await bodOrigen.get(`/api/inv/u/conteos/${c.id}`)).body;
  assert.equal(det.lineas.length, 1); assert.equal(det.oculto, true); assert.equal(det.lineas[0].esperado, null);   // a ciegas
  assert.equal((await bodOrigen.post(`/api/inv/u/conteos/${c.id}/captura`, { lineas: [{ id: det.lineas[0].id, contado: 4.5 }] })).status, 200);
  assert.equal((await bodOrigen.post(`/api/inv/u/conteos/${c.id}/enviar`)).status, 200);
  // el bodeguero no aprueba
  assert.equal((await bodOrigen.post(`/api/inv/u/conteos/${c.id}/aprobar`, { nota: 'ok yo' })).status, 403);
  const rev = (await gerOrigen.get(`/api/inv/u/conteos/${c.id}`)).body;
  assert.equal(rev.lineas[0].esperado, 6); assert.equal(rev.lineas[0].diferencia, -1.5); assert.equal(rev.lineas[0].valor_diferencia, -60);
  // sin motivo no se aplica
  assert.equal((await gerOrigen.post(`/api/inv/u/conteos/${c.id}/aprobar`, {})).status, 400);
  assert.equal(await stockInv(fresa, sucPrincipal), 6);
  const ok = await gerOrigen.post(`/api/inv/u/conteos/${c.id}/aprobar`, { nota: 'Fruta dañada en cámara' });
  assert.equal(ok.status, 200); assert.equal(ok.body.ajustadas, 1);
  assert.equal(await stockInv(fresa, sucPrincipal), 4.5);
  assert.equal((await gerOrigen.post(`/api/inv/u/conteos/${c.id}/aprobar`, { nota: 'otra vez' })).status, 409);   // ya aplicado
  const k = (await gerOrigen.get('/api/inv/u/kardex?q=fresa')).body;
  assert.ok(k.some((m) => m.tipo === 'ajuste' && m.cantidad === -1.5 && /Conteo/.test(m.motivo)));
  const bit = await t.db.query(`select 1 from core.auditoria where accion in ('inv.conteo_ajuste','inv.conteo_aprobado') and empresa_id = $1`, [oId]);
  assert.equal(bit.rowCount, 2);
});

test('traslado entre sucursales de Italo: sale en origen, entra al confirmar en destino', async () => {
  const d = dueno('italo');
  const vasos = (await d.post(`/api/rinv/sucursal/${sucMackey}/nuevo`, { nombre: 'Vaso 8oz', cantidad: 100, categoria: 'Empaque', unidad: 'u' })).body.id;
  assert.ok(vasos);
  const cant = async (suc) => Number((await t.db.query('select coalesce(sum(cantidad),0) as c from rinv.stock_suc where insumo_id = $1 and sucursal_id = $2', [vasos, suc])).rows[0].c);
  // no se puede mandar más de lo que hay
  const mal = await d.post('/api/inv/u/traslados', { destino: 'italo', origen_sucursal_id: sucMackey, destino_sucursal_id: sucProceres, lineas: [{ fuente: 'rinv_suc', ref_id: vasos, cantidad: 500 }] });
  assert.equal(mal.status, 409);
  const mismo = await d.post('/api/inv/u/traslados', { destino: 'italo', origen_sucursal_id: sucMackey, destino_sucursal_id: sucMackey, lineas: [{ fuente: 'rinv_suc', ref_id: vasos, cantidad: 5 }] });
  assert.equal(mismo.status, 400);
  const tr = await d.post('/api/inv/u/traslados', { destino: 'italo', origen_sucursal_id: sucMackey, destino_sucursal_id: sucProceres, notas: 'Reposición', lineas: [{ fuente: 'rinv_suc', ref_id: vasos, cantidad: 30 }] });
  assert.equal(tr.status, 201); assert.equal(tr.body.numero_doc, 'TR-0001');
  assert.equal(await cant(sucMackey), 70); assert.equal(await cant(sucProceres), 0);
  const doc = (await d.get(`/api/inv/u/traslados/${tr.body.id}`)).body;
  assert.equal(doc.estado, 'en_transito'); assert.equal(doc.origen.sucursal, 'Mackey'); assert.equal(doc.lineas[0].ref_destino, vasos);
  const rec = await d.post(`/api/inv/u/traslados/${tr.body.id}/recibir`, { lineas: [{ id: doc.lineas[0].id, cantidad_recibida: 28 }], nota: 'Llegaron 28' });
  assert.equal(rec.status, 200); assert.equal(rec.body.con_diferencia, true);
  assert.equal(await cant(sucProceres), 28);
  assert.equal((await d.post(`/api/inv/u/traslados/${tr.body.id}/recibir`, {})).status, 409);   // no se recibe dos veces
  // anular uno en tránsito devuelve la mercadería
  const t2 = await d.post('/api/inv/u/traslados', { destino: 'italo', origen_sucursal_id: sucMackey, destino_sucursal_id: sucProceres, lineas: [{ fuente: 'rinv_suc', ref_id: vasos, cantidad: 20 }] });
  assert.equal(await cant(sucMackey), 50);
  assert.equal((await d.post(`/api/inv/u/traslados/${t2.body.id}/anular`, { motivo: 'Se equivocaron de tienda' })).status, 200);
  assert.equal(await cant(sucMackey), 70);
  assert.equal((await d.get('/api/inv/u/traslados?vista=enviados&estado=anulado')).body.length, 1);
});

test('traslado entre empresas: DISERCO envía a EcoStone, EcoStone confirma y queda el registro intercompañía', async () => {
  const p = (await t.db.query(`insert into pos.productos (empresa_id, nombre, precio, unidad) values ($1,'Cemento gris 42kg',150,'saco') returning id`, [dId])).rows[0].id;
  await t.db.query(`insert into dis.producto_ext (producto_id, empresa_id, controla_inventario, costo_estandar) values ($1,$2,true,100)`, [p, dId]);
  await t.db.query(`select dis.mover($1,$2,'inicial',20,100,'Inicial',null,null,null,null,true,null)`, [dId, p]);
  const ins = (await t.db.query(`insert into fab.insumos (empresa_id, codigo, nombre, categoria, unidad) values ($1,'CEM-1','cemento gris 42KG','cemento','saco') returning id`, [eId])).rows[0].id;
  const disd = dueno('diserco'), eco = dueno('ecostone');
  const enDis = (await disd.get('/api/inv/u/existencias')).body.items.find((i) => i.nombre === 'Cemento gris 42kg');
  assert.equal(enDis.existencia, 20); assert.equal(enDis.valor, 2000);
  const tr = await disd.post('/api/inv/u/traslados', { destino: 'ecostone', lineas: [{ fuente: 'dis', ref_id: p, cantidad: 8 }] });
  assert.equal(tr.status, 201); assert.equal(tr.body.valor_total, 800);
  const doc = (await eco.get(`/api/inv/u/traslados/${tr.body.id}`)).body;
  assert.equal(doc.soy_destino, true); assert.equal(doc.entre_empresas, true);
  assert.equal(doc.lineas[0].ref_destino, ins);           // se emparejó por nombre
  // DISERCO no puede recibir su propio envío
  assert.equal((await disd.post(`/api/inv/u/traslados/${tr.body.id}/recibir`, {})).status, 403);
  const rec = await eco.post(`/api/inv/u/traslados/${tr.body.id}/recibir`, {});
  assert.equal(rec.status, 200); assert.equal(rec.body.valor, 800); assert.ok(rec.body.intercompania_id);
  const ic = (await t.db.query('select * from fin.intercompania where id = $1', [rec.body.intercompania_id])).rows[0];
  assert.equal(ic.empresa_origen_id, dId); assert.equal(ic.empresa_destino_id, eId); assert.equal(ic.monto, 800); assert.equal(ic.estado, 'pendiente');
  const stockEco = Number((await t.db.query('select stock from fab.stock_insumos where insumo_id = $1', [ins])).rows[0].stock);
  assert.equal(stockEco, 8);
  const stockDis = Number((await t.db.query('select existencia from dis.existencias where producto_id = $1', [p])).rows[0].existencia);
  assert.equal(stockDis, 12);
  const costo = Number((await t.db.query('select costo_promedio from fab.insumos where id = $1', [ins])).rows[0].costo_promedio);
  assert.equal(costo, 100);
  // el kardex consolidado de cada empresa muestra su lado
  assert.ok((await eco.get('/api/inv/u/kardex')).body.some((m) => /Traslado TR-0001/.test(m.motivo) && m.cantidad === 8));
  assert.ok((await disd.get('/api/inv/u/kardex')).body.some((m) => m.cantidad === -8));
  // un tercero sin acceso no ve el traslado
  assert.equal((await gerOrigen.get(`/api/inv/u/traslados/${tr.body.id}`)).status, 404);
});

test('traslado a otra empresa sin ítem equivalente: el que recibe elige; sin elegir no se puede', async () => {
  const p = (await t.db.query(`select id from pos.productos where nombre = 'Cemento gris 42kg'`)).rows[0].id;
  const nuevo = (await t.db.query(`insert into fab.insumos (empresa_id, codigo, nombre, categoria, unidad) values ($1,'CEM-2','Cemento blanco','cemento','saco') returning id`, [eId])).rows[0].id;
  const tr = await dueno('diserco').post('/api/inv/u/traslados', { destino: 'ecostone', lineas: [{ fuente: 'dis', ref_id: p, cantidad: 2 }] });
  const eco = dueno('ecostone');
  const doc = (await eco.get(`/api/inv/u/traslados/${tr.body.id}`)).body;
  assert.ok(Array.isArray(doc.catalogo_destino));
  const mal = await eco.post(`/api/inv/u/traslados/${tr.body.id}/recibir`, { lineas: [{ id: doc.lineas[0].id, fuente_destino: 'dis', ref_destino: p }] });
  assert.equal(mal.status, 400);                       // 'dis' no es inventario de EcoStone
  const ok = await eco.post(`/api/inv/u/traslados/${tr.body.id}/recibir`, { lineas: [{ id: doc.lineas[0].id, fuente_destino: 'fab_insumo', ref_destino: nuevo }] });
  assert.equal(ok.status, 200);
});

test('piedra: se cuenta en cajas completas y no se traslada', async () => {
  const prod = (await t.db.query(`insert into pos.productos (empresa_id, nombre, precio, es_piedra, unidad_venta) values ($1,'Piedra Cantera Gris',100,true,'caja') returning id`, [eId])).rows[0].id;
  const lote = (await t.db.query(`insert into fab.lotes (empresa_id, codigo, producto_id, estado, cantidad_producida, cantidad_disponible) values ($1,'EC-1',$2,'lista',10,10) returning id`, [eId, prod])).rows[0].id;
  const eco = dueno('ecostone');
  const it = (await eco.get('/api/inv/u/existencias?fuente=fab_piedra')).body.items;
  assert.equal(it.length, 1); assert.equal(it[0].existencia, 10); assert.equal(it[0].unidad, 'cajas');
  const mal = await eco.post('/api/inv/u/traslados', { destino: 'diserco', lineas: [{ fuente: 'fab_piedra', ref_id: lote, cantidad: 1 }] });
  assert.equal(mal.status, 400);
  const c = (await eco.post('/api/inv/u/conteos', { nombre: 'Piedra', fuente: 'fab_piedra' })).body;
  await eco.post(`/api/inv/u/conteos/${c.id}/iniciar`);
  const det = (await eco.get(`/api/inv/u/conteos/${c.id}`)).body;
  assert.equal((await eco.post(`/api/inv/u/conteos/${c.id}/captura`, { lineas: [{ id: det.lineas[0].id, contado: 8.5 }] })).status, 400);
  assert.equal((await eco.post(`/api/inv/u/conteos/${c.id}/captura`, { lineas: [{ id: det.lineas[0].id, contado: 9 }] })).status, 200);
  await eco.post(`/api/inv/u/conteos/${c.id}/enviar`);
  assert.equal((await eco.post(`/api/inv/u/conteos/${c.id}/aprobar`, { nota: 'Se quebraron' })).status, 200);
  assert.equal(Number((await t.db.query('select cantidad_disponible from fab.lotes where id = $1', [lote])).rows[0].cantidad_disponible), 9);
});

test('Dirección: vista del grupo solo con grupo:ver, y mínimos propios (DISERCO)', async () => {
  const g = await dueno('italo').get('/api/inv/u/grupo');
  assert.equal(g.status, 200); assert.equal(g.body.empresas.length, 4);
  assert.ok(g.body.empresas.every((e) => e.resumen && Array.isArray(e.fuentes)));
  assert.equal((await gerOrigen.get('/api/inv/u/grupo')).status, 403);
  const p = (await t.db.query(`select id from pos.productos where nombre = 'Cemento gris 42kg'`)).rows[0].id;
  assert.equal((await dueno('diserco').put('/api/inv/u/minimos', { fuente: 'dis', ref_id: p, minimo: 20 })).status, 200);
  const it = (await dueno('diserco').get('/api/inv/u/existencias')).body.items.find((i) => i.ref_id === p);
  assert.equal(it.minimo, 20); assert.equal(it.estado, 'bajo'); assert.equal(it.minimo_propio, true);
  await dueno('diserco').put('/api/inv/u/minimos', { fuente: 'dis', ref_id: p, minimo: null });
  assert.equal((await dueno('diserco').get('/api/inv/u/existencias')).body.items.find((i) => i.ref_id === p).minimo_propio, false);
});
