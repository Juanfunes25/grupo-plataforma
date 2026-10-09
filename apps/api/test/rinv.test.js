import { fechaHN } from '@grupo/shared';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from './helpers.js';
import { sembrarRinv } from '../src/modulos/rinv/siembra.js';
import { valorInventarioFabrica, repartirFifo, aplicarMovimiento, pesoDesdeNombre, similitudNombres, parsearPedidoTexto, emparejarConCatalogo } from '../src/modulos/rinv/calculo.js';
import { codificarEpc, decodificarEpc } from '../src/modulos/rinv/rfid/epc.js';
import { alertasFifo } from '../src/modulos/rinv/rfid/fifo.js';
import { compararAuditoria } from '../src/modulos/rinv/rfid/auditoriaFreezer.js';

let t, eid, ger, bod, caj, otra, sucId;
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]).toString('base64');

before(async () => {
  t = await iniciar();
  eid = await t.empresaId('italo');
  sucId = await t.sucursalId('italo', 'mackey');
  await t.usuario({ nombre: 'Gerente', email: 'g@italo.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'italo', rol: 'gerente' }, { empresa: 'origen', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Bodeguero', accesos: [{ empresa: 'italo', rol: 'bodega', pin: '4141' }] });
  await t.usuario({ nombre: 'Tienda', accesos: [{ empresa: 'italo', rol: 'cajero', pin: '5252' }] });
  const con = (token, emp) => Object.assign(t.cli(token, emp), { cabeceras: { authorization: `Bearer ${token}`, 'x-empresa': emp } });
  ger = con(await t.login('italo', 'g@italo.hn', 'ClaveSegura123'), 'italo');
  otra = con(await t.login('origen', 'g@italo.hn', 'ClaveSegura123'), 'origen');
  bod = con(await t.loginPin('italo', '4141'), 'italo');
  caj = con(await t.loginPin('italo', '5252'), 'italo');
});
after(() => t.cerrar());

const crear = async (nombre, extra = {}) => (await ger.post('/api/rinv/fabrica', { nombre, ...extra })).body;
const stockDe = async (id) => Number((await t.db.query('select stock_actual from rinv.insumos_fab where id = $1', [id])).rows[0].stock_actual);

test('reglas puras: saldo, FIFO, peso del nombre, nombres parecidos', () => {
  assert.equal(aplicarMovimiento(0.1, 'entrada', 0.2).nuevo, 0.3);
  assert.equal(aplicarMovimiento(5, 'salida', 6).ok, false);
  assert.deepEqual(repartirFifo({ disponibles: [{ id: 1, restante: 4 }, { id: 2, restante: 6 }], cantidad: 5 }).tomas, [{ id: 1, cantidad: 4 }, { id: 2, cantidad: 1 }]);
  assert.equal(repartirFifo({ disponibles: [{ id: 1, restante: 2 }], cantidad: 5 }).sinOrigen, 3);
  assert.equal(pesoDesdeNombre('COOKIES BLACK X 6 KG'), 6);
  assert.equal(pesoDesdeNombre('BASE ALBA X 1,2 KG.'), 1.2);
  assert.equal(pesoDesdeNombre('ANGURIA *500* (WATERMELON)'), null);
  assert.equal(similitudNombres('Vaso 8oz', 'Vaso 12oz'), 0);
  assert.ok(similitudNombres('Vasos 8oz', 'Vaso 8oz') > 0.78);
  const p = parsearPedidoTexto('Pasta pistacho 8x4,5kg\nBase alba; 2+1x5\nAlgo raro');
  assert.equal(p[0].unidades, 8); assert.equal(p[0].peso_unitario, 4.5); assert.equal(p[1].unidades, 3); assert.equal(p[2].unidades, null);
  assert.equal(emparejarConCatalogo([{ nombre: 'pasta pistacho' }], [{ id: 'a', nombre: 'PASTA PISTACHO', unidad: 'unidad' }])[0].insumo_id, 'a');
});

test('valor del inventario: kg directo, botes×peso, y lo incalculable se avisa aparte', () => {
  const v = valorInventarioFabrica([
    { id: 1, nombre: 'A', tipo: 'mec3', categoria: 'Gelato', unidad: 'unidad', stock_actual: 3, peso_unitario: 4.5, precio: 100, es_equipo: false },
    { id: 2, nombre: 'B', tipo: 'local', categoria: 'Gelato', unidad: 'kg', stock_actual: 10, precio: 25, es_equipo: false },
    { id: 3, nombre: 'C', tipo: 'local', unidad: 'unidad', stock_actual: 2, precio: 10 },
    { id: 4, nombre: 'D', tipo: 'local', unidad: 'kg', stock_actual: 2, precio: null },
    { id: 5, nombre: 'E', tipo: 'local', unidad: 'kg', stock_actual: null, precio: 5 },
    { id: 6, nombre: 'F', tipo: 'local', unidad: 'kg', stock_actual: 9, precio: 5, es_equipo: true },
  ]);
  assert.equal(v.total, 3 * 4.5 * 100 + 10 * 25);
  assert.equal(v.sinPeso.length, 1); assert.equal(v.sinPrecio.length, 1); assert.equal(v.sinStock.length, 1);
  assert.equal(v.porCategoria.Gelato, 1600);
});

test('solo Italo (módulo reposición) y según permisos', async () => {
  assert.equal((await otra.get('/api/rinv/fabrica')).status, 403);
  assert.equal((await bod.get('/api/rinv/fabrica')).status, 200);
  assert.equal((await caj.get('/api/rinv/fabrica')).status, 403);          // tienda: no mueve inventario
  assert.equal((await bod.get('/api/rinv/valor')).status, 403);            // sin costos
  assert.equal((await ger.get('/api/rinv/valor')).status, 200);
  assert.equal((await bod.post('/api/rinv/fabrica', { nombre: 'X' })).status, 403);
});

test('movimientos: kardex, reintento idempotente, sin stock negativo y kardex inalterable', async () => {
  const leche = await crear('LECHE TEST', { unidad: 'kg', lps_kg: 30 });
  assert.equal(leche.stock_actual, null);
  const mov = (id, b) => fetchPatch(bod, `/api/rinv/fabrica/${id}/movimiento`, b);
  let x = await mov(leche.id, { tipo: 'entrada', cantidad: 10, motivo: 'Compra', cliente_id: 'c-1' });
  assert.equal(x.status, 200); assert.equal(x.body.stock_actual, 10);
  x = await mov(leche.id, { tipo: 'entrada', cantidad: 10, cliente_id: 'c-1' });          // reintento
  assert.equal(x.body.stock_actual, 10); assert.equal(await stockDe(leche.id), 10);
  assert.equal((await mov(leche.id, { tipo: 'salida', cantidad: 11 })).status, 400);
  assert.equal((await mov(leche.id, { tipo: 'salida', cantidad: 2.5 })).body.stock_actual, 7.5);
  x = await fetchPatch(bod, `/api/rinv/fabrica/${leche.id}`, { stock_actual: 5, motivo: 'Conteo' });
  assert.equal(x.status, 200);
  const k = (await bod.get(`/api/rinv/fabrica/${leche.id}/movimientos`)).body;
  assert.equal(k.length, 3); assert.equal(k[0].tipo, 'salida'); assert.equal(k[0].cantidad, 2.5); assert.equal(k[0].saldo_resultante, 5);
  await assert.rejects(() => t.db.query('update rinv.movimientos set cantidad = 1'), /inalterable/);
  await assert.rejects(() => t.db.query('delete from rinv.movimientos'), /inalterable/);
  const bit = await t.db.query("select count(*)::int as n from core.auditoria where accion like 'rinv.%' and empresa_id = $1", [eid]);
  assert.ok(bit.rows[0].n >= 3);
});

async function fetchPatch(cli, ruta, cuerpo) {
  // el cliente de pruebas no trae PATCH: se usa fetch directo con las mismas cabeceras
  const base = t.base; const h = cli.cabeceras;
  const r = await fetch(base + ruta, { method: 'PATCH', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(cuerpo) });
  const txt = await r.text();
  return { status: r.status, body: txt ? JSON.parse(txt) : null };
}

test('lotes Mec3: entrada abre lote con vencimiento a un año, salidas FIFO y alerta de vencimiento', async () => {
  const pasta = await crear('PASTA TEST MEC3', { tipo: 'mec3', unidad: 'unidad', peso_unitario: 2 });
  const hoy = fechaHN();
  const hace = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
  let r = await bod.post('/api/rinv/fabrica/entradas-lote', { items: [{ id: pasta.id, unidades: 4, peso_unitario: 2, cliente_id: 'e1' }], fecha: hace(400), motivo: 'Pedido viejo' });
  assert.equal(r.body.guardados, 1); assert.equal(await stockDe(pasta.id), 8);
  r = await bod.post('/api/rinv/fabrica/entradas-lote', { items: [{ id: pasta.id, cantidad: 6 }], fecha: hoy });
  assert.equal(await stockDe(pasta.id), 14);
  const lotes = (await t.db.query('select * from rinv.lotes_mec3 where insumo_id = $1 order by fecha_ingreso', [pasta.id])).rows;
  assert.equal(lotes.length, 2);
  assert.equal(lotes[0].fecha_vencimiento, new Date(Date.parse(`${hace(400)}T00:00:00Z`) + 365 * 86400000).toISOString().slice(0, 10));
  // reintentar el lote entero no duplica lo que ya entró
  await bod.post('/api/rinv/fabrica/entradas-lote', { items: [{ id: pasta.id, unidades: 4, peso_unitario: 2, cliente_id: 'e1' }], fecha: hace(400) });
  assert.equal(await stockDe(pasta.id), 14);
  // vencimientos: el lote de hace 400 días vence en -35 días
  const v = (await bod.get('/api/rinv/fabrica/vencimientos?dias=60')).body;
  const mio = v.find((l) => l.insumo_id === pasta.id);
  assert.ok(mio && mio.dias_para_vencer < 0 && mio.cantidad_restante === 8);
  // salida: baja primero el lote viejo, y queda la salida por lote
  r = await bod.post('/api/rinv/fabrica/salidas-lote', { items: [{ id: pasta.id, cantidad: 10 }], motivo: 'Producción del martes' });
  assert.equal(r.status, 200);
  const despues = (await t.db.query('select cantidad_restante from rinv.lotes_mec3 where insumo_id = $1 order by fecha_ingreso', [pasta.id])).rows;
  assert.deepEqual(despues.map((l) => Number(l.cantidad_restante)), [0, 4]);
  const sal = (await t.db.query('select sum(cantidad)::float8 as s, count(*)::int as n from rinv.salida_lotes where insumo_id = $1', [pasta.id])).rows[0];
  assert.equal(sal.s, 10); assert.equal(sal.n, 2);
  const tr = (await bod.get(`/api/rinv/trazabilidad/lote/${lotes[1].id}`)).body;
  assert.equal(tr.salidas[0].cantidad, 2);
});

test('salidas en lote: todo o nada, y el mismo insumo repetido se suma', async () => {
  const a = await crear('INS A'); const b = await crear('INS B');
  await bod.post('/api/rinv/fabrica/entradas-lote', { items: [{ id: a.id, cantidad: 10 }, { id: b.id, cantidad: 50 }] });
  let r = await bod.post('/api/rinv/fabrica/salidas-lote', { items: [{ id: a.id, cantidad: 3 }, { id: b.id, cantidad: 999 }] });
  assert.equal(r.status, 409); assert.equal(r.body.faltantes[0].nombre, 'INS B'); assert.equal(r.body.faltantes[0].hay, 50);
  assert.equal(await stockDe(a.id), 10);
  r = await bod.post('/api/rinv/fabrica/salidas-lote', { items: [{ id: a.id, cantidad: 6 }, { id: a.id, cantidad: 6 }] });
  assert.equal(r.status, 409);
  r = await bod.post('/api/rinv/fabrica/salidas-lote', { items: [{ id: a.id, cantidad: 3, cliente_id: 's1' }] });
  await bod.post('/api/rinv/fabrica/salidas-lote', { items: [{ id: a.id, cantidad: 3, cliente_id: 's1' }] });
  assert.equal(await stockDe(a.id), 7);
  const mot = (await t.db.query("select motivo from rinv.movimientos where insumo_fab_id = $1 and tipo = 'salida'", [a.id])).rows[0].motivo;
  assert.equal(mot, 'Salida para producción');
});

test('límites, alertas de reordenar y código de barras con conflicto', async () => {
  const a = await crear('INS ALERTA'); const b = await crear('INS OTRO');
  assert.equal((await fetchPatch(bod, `/api/rinv/fabrica/${a.id}/limites`, { stock_minimo: 5, stock_maximo: 2 })).status, 400);
  assert.equal((await fetchPatch(bod, `/api/rinv/fabrica/${a.id}/limites`, { stock_minimo: 5 })).status, 200);
  const al = (await bod.get('/api/rinv/alertas')).body;
  assert.ok(al.stockBajoFabrica.some((i) => i.nombre === 'INS ALERTA'));
  assert.match(al.texto, /Bajo el mínimo en fábrica/);
  assert.equal((await fetchPatch(bod, `/api/rinv/fabrica/${a.id}/codigo-barras`, { codigo_barras: '7501' })).status, 200);
  const c = await fetchPatch(bod, `/api/rinv/fabrica/${b.id}/codigo-barras`, { codigo_barras: '7501' });
  assert.equal(c.status, 409); assert.equal(c.body.faltantes.nombre, 'INS ALERTA');
  assert.equal((await fetchPatch(bod, `/api/rinv/fabrica/${b.id}/codigo-barras`, { codigo_barras: '7501', forzar: true })).status, 200);
  assert.equal((await bod.get('/api/rinv/codigo/7501')).body.id, b.id);
});

test('valor del inventario por API usa el precio más reciente y avisa lo que falta', async () => {
  const x = await crear('VALOR X', { unidad: 'kg', lps_kg: 10 });
  await ger.post(`/api/rinv/fabrica/${x.id}/precio`, { lps_kg: 20, fecha_vigencia: '2099-01-01' });
  await bod.post('/api/rinv/fabrica/entradas-lote', { items: [{ id: x.id, cantidad: 5 }] });
  const v = (await ger.get('/api/rinv/valor')).body;
  assert.equal(v.insumos.find((i) => i.nombre === 'VALOR X').valor, 100);
  assert.ok(v.insumosSinStock > 0);
  assert.equal((await ger.get(`/api/rinv/fabrica/${x.id}/precios`)).body.length, 2);
  await assert.rejects(() => t.db.query('update rinv.precios_fab set lps_kg = 1'), /inalterable/);
  assert.ok(!('precio' in (await bod.get('/api/rinv/fabrica')).body[0]));
});

test('insumos por sucursal: stock propio por tienda, mínimos compartidos, matriz y kardex', async () => {
  const sid2 = await t.sucursalId('italo', 'proceres');
  const n = await bod.post(`/api/rinv/sucursal/${sucId}/nuevo`, { nombre: 'Vasos 8oz', cantidad: 20, categoria: 'Empaque para venta' });
  assert.equal(n.status, 201);
  const rep = await bod.post(`/api/rinv/sucursal/${sid2}/nuevo`, { nombre: 'vasos 8OZ', cantidad: 5 });     // mismo insumo, otra tienda
  assert.equal(rep.body.id, n.body.id);
  assert.equal((await bod.get(`/api/rinv/sucursal/parecidos?nombre=Vasos%208%20oz`)).status, 200);
  const base = `/api/rinv/sucursal/${sucId}/${n.body.id}`;
  let x = await fetchPatch(bod, `${base}/movimiento`, { tipo: 'salida', cantidad: 8, motivo: 'Uso' });
  assert.equal(x.body.cantidad, 12);
  assert.equal((await fetchPatch(bod, `${base}/movimiento`, { tipo: 'salida', cantidad: 99 })).status, 400);
  await fetchPatch(bod, `${base}/limites`, { stock_minimo: 15 });
  const resumen = (await bod.get('/api/rinv/resumen-stock')).body;
  const fila = resumen.catalogoSucursal.find((i) => i.id === n.body.id);
  assert.equal(fila.porSucursal[sucId], 12); assert.equal(fila.porSucursal[sid2], 5);
  assert.ok((await bod.get('/api/rinv/alertas')).body.stockBajoSucursal.some((i) => i.nombre === 'Vasos 8oz' && i.cantidad === 12));
  assert.equal((await fetchPatch(bod, base, { cantidad: 30, motivo: 'Conteo' })).status, 200);
  const lote = await bod.post(`/api/rinv/sucursal/${sucId}/entradas-lote`, { items: [{ id: n.body.id, cantidad: 10, cliente_id: 'l1' }] });
  await bod.post(`/api/rinv/sucursal/${sucId}/entradas-lote`, { items: [{ id: n.body.id, cantidad: 10, cliente_id: 'l1' }] });
  assert.equal(lote.body.resultados[0].cantidad, 40);
  assert.equal((await bod.get(`${base}/movimientos`)).body.length, 4);
  const hoy = fechaHN();
  const mv = (await bod.get(`/api/rinv/movimientos?desde=${hoy}&hasta=${hoy}&ambito=sucursal&busqueda=vasos`)).body;
  assert.ok(mv.length >= 4 && mv.every((m) => m.ambito === 'sucursal'));
  assert.equal((await bod.get(`/api/rinv/reportes/mensual?meses=3`)).body.meses.length, 3);
  assert.equal((await bod.get(`/api/rinv/reportes/categoria?desde=${hoy}&hasta=${hoy}`)).status, 200);
});

test('siembra real de Italo: idempotente y sin dejar stock negativo', async () => {
  const r1 = await sembrarRinv(t.db, eid);
  assert.ok(r1.catalogo.insumosCreados >= 303); assert.equal(r1.ristoris.insumosCreados, 68);
  assert.equal(r1.stockRistoris.cargados, 61); assert.ok(r1.ventasRistoris.descontados.length > 0);
  const antes = (await t.db.query('select count(*)::int as n, coalesce(sum(stock_actual),0)::float8 as s from rinv.insumos_fab where empresa_id = $1', [eid])).rows[0];
  const movs = (await t.db.query('select count(*)::int as n from rinv.movimientos')).rows[0].n;
  const r2 = await sembrarRinv(t.db, eid);
  assert.equal(r2.catalogo.insumosCreados, 0); assert.equal(r2.stockRistoris.cargados, 0); assert.equal(r2.ventasRistoris.descontados.length, 0);
  const despues = (await t.db.query('select count(*)::int as n, coalesce(sum(stock_actual),0)::float8 as s from rinv.insumos_fab where empresa_id = $1', [eid])).rows[0];
  assert.deepEqual(despues, antes);
  assert.equal((await t.db.query('select count(*)::int as n from rinv.movimientos')).rows[0].n, movs);
  assert.equal((await t.db.query('select count(*)::int as n from rinv.insumos_fab where stock_actual < 0')).rows[0].n, 0);
  const aceite = (await bod.get('/api/rinv/fabrica')).body.find((i) => i.part_number === '017070');
  assert.equal(aceite.stock_actual, 41 - 9);                       // conteo 41 − ventas 9
  const val = (await ger.get('/api/rinv/valor')).body;
  assert.ok(val.categorias.includes('Ristoris') && val.porCategoria.Ristoris > 0);
  assert.equal((await bod.post('/api/rinv/siembra')).status, 403);
});

test('RFID: formato de EPC, FIFO, secciones, registro, auditoría y grabación confirmada', async () => {
  const e = codificarEpc({ tipo: 'helado', referencia: 7, lote: 99, secuencia: 2 });
  assert.equal(e.length, 24); assert.equal(decodificarEpc(e).lote, 99);
  assert.equal(decodificarEpc(`${e.slice(0, 22)}00`).propio, false);
  const f = alertasFifo([
    { epc: 'A', sabor_id: 1, sabor_nombre: 'X', fecha: '2026-09-01', ubicacion_id: 1, ubicacion_nombre: 'F1 · Fondo', freezer: 'F1', orden_salida: 5 },
    { epc: 'B', sabor_id: 1, sabor_nombre: 'X', fecha: '2026-10-01', ubicacion_id: 2, ubicacion_nombre: 'F1 · Puerta', freezer: 'F1', orden_salida: 0 },
  ], { hoy: '2026-10-05' });
  assert.ok(f.some((a) => a.tipo === 'fifo')); assert.ok(f.some((a) => a.tipo === 'vejez'));
  const c = compararAuditoria({ ubicacion: { id: 'u' }, lecturas: [{ epc: 'E280116060000205AAAA0001' }], tagsPorEpc: new Map(), esperados: [{ id: 't', epc: 'E280116060000205AAAA0002', faltas_seguidas: 1 }] });
  assert.equal(c.faltantes[0].confirmado, true);

  const u = (await bod.post('/api/rinv/rfid/ubicaciones', { freezer: 'Freezer 1', seccion: 'Estante 1', orden_salida: 0 })).body;
  assert.equal((await bod.post('/api/rinv/rfid/ubicaciones', { freezer: 'Freezer 1', seccion: 'Estante 1' })).status, 409);
  assert.equal((await caj.get('/api/rinv/rfid/ubicaciones')).status, 403);
  const E1 = 'E280116060000205AAAA0001', E2 = 'E280116060000205AAAA0002', E3 = 'E280116060000205AAAA0003';
  let r = await bod.post(`/api/rinv/rfid/ubicaciones/${u.id}/registrar`, { lecturas: [{ epc: E1 }, { epc: E2 }, { epc: E2 }, { epc: 'zz' }] });
  assert.equal(r.body.nuevos, 2); assert.equal(r.body.ajenos, 1);
  r = await bod.post(`/api/rinv/rfid/ubicaciones/${u.id}/registrar`, { lecturas: [{ epc: E1 }] });
  assert.equal(r.body.ya_estaban, 1);
  // auditoría: E2 no aparece (1.ª vez), E3 es de otro formato/desconocido
  r = await bod.post('/api/rinv/rfid/auditorias', { ubicacion_id: u.id, lecturas: [{ epc: E1 }] });
  assert.equal(r.body.resumen.faltantes, 1); assert.equal(r.body.faltantes[0].confirmado, false);
  r = await bod.post('/api/rinv/rfid/auditorias', { ubicacion_id: u.id, lecturas: [{ epc: E1 }] });
  assert.equal(r.body.faltantes[0].confirmado, true);
  assert.equal((await bod.get('/api/rinv/rfid/auditorias')).body.length, 2);
  // vincular a un insumo, historial, liberar
  const ins = await crear('INSUMO TAG');
  const tags = (await bod.get('/api/rinv/rfid/tags')).body;
  assert.equal(tags.total, 2);
  const t1 = tags.tags.find((x) => x.epc === E1);
  r = await bod.post(`/api/rinv/rfid/tags/${t1.id}/asignar`, { insumo_id: ins.id });
  assert.equal(r.body.estado, 'asignado'); assert.equal(r.body.insumo_nombre, 'INSUMO TAG');
  assert.equal((await bod.post(`/api/rinv/rfid/tags/${t1.id}/asignar`, { insumo_id: ins.id })).status, 409);
  assert.equal((await bod.post(`/api/rinv/rfid/tags/${t1.id}/liberar`)).body.estado, 'disponible');
  assert.ok((await bod.get(`/api/rinv/rfid/tags/${t1.id}/historial`)).body.length >= 3);
  const q = (await bod.post('/api/rinv/rfid/consulta', { epcs: [E1, E3] })).body;
  assert.equal(q.tags.length, 1);
  // grabación: preparar → confirmar solo si el lector releyó el EPC nuevo
  const p = (await bod.post('/api/rinv/rfid/escritura/preparar', { epc_actual: E3, tipo: 'insumo', insumo_id: ins.id })).body;
  assert.equal(decodificarEpc(p.epc_nuevo).propio, true);
  assert.equal((await bod.post('/api/rinv/rfid/escritura/confirmar', { tag_id: p.tag_id, epc_leido: E3 })).status, 409);
  const p2 = (await bod.post('/api/rinv/rfid/escritura/preparar', { epc_actual: E3, tipo: 'insumo', insumo_id: ins.id })).body;
  r = await bod.post('/api/rinv/rfid/escritura/confirmar', { tag_id: p2.tag_id, epc_leido: p2.epc_nuevo });
  assert.equal(r.status, 200); assert.equal(r.body.epc, p2.epc_nuevo); assert.equal(r.body.insumo_nombre, 'INSUMO TAG');
  // no se puede reasignar por software un tag grabado con otro insumo
  const otroIns = await crear('OTRO INSUMO TAG');
  assert.equal((await bod.post(`/api/rinv/rfid/tags/${r.body.id}/liberar`)).status, 200);
  assert.equal((await bod.post(`/api/rinv/rfid/tags/${r.body.id}/asignar`, { insumo_id: otroIns.id })).status, 409);
  assert.equal((await bod.post(`/api/rinv/rfid/tags/${r.body.id}/baja`, { motivo: 'roto' })).status, 200);
  assert.equal((await bod.get('/api/rinv/rfid/fifo')).status, 200);
});

test('incidencias: la tienda reporta con foto, fábrica resuelve y no cierra en blanco', async () => {
  let r = await caj.post('/api/rinv/incidencias', { tipo: 'producto', gravedad: 'alta', descripcion: 'El pistacho tenía cristales', sucursal_id: sucId, fotos: [JPG] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.id;
  assert.equal((await caj.get('/api/rinv/incidencias')).status, 403);
  assert.equal((await caj.post('/api/rinv/incidencias', { tipo: 'otro', descripcion: 'xx' })).status, 400);
  const grande = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(420 * 1024)]).toString('base64');
  assert.equal((await caj.post('/api/rinv/incidencias', { tipo: 'otro', descripcion: 'foto muy pesada', fotos: [grande] })).status, 400);
  assert.equal((await caj.post('/api/rinv/incidencias', { tipo: 'otro', descripcion: 'esto no es imagen', fotos: [Buffer.from('hola mundo').toString('base64')] })).status, 400);
  await caj.post('/api/rinv/incidencias', { tipo: 'higiene', gravedad: 'baja', descripcion: 'Mancha en la vitrina', sucursal_id: sucId });
  const lista = (await bod.get('/api/rinv/incidencias')).body;
  assert.equal(lista[0].gravedad, 'alta'); assert.equal(lista[0].fotos, 1);
  assert.equal((await bod.get('/api/rinv/incidencias/abiertas/conteo')).body.abiertas, 2);
  const d = (await bod.get(`/api/rinv/incidencias/${id}`)).body;
  assert.equal(d.fotos[0].imagen, JPG); assert.equal(d.fotos[0].mime, 'image/jpeg');
  assert.equal((await fetchPatch(bod, `/api/rinv/incidencias/${id}`, { estado: 'cerrada', resolucion: '' })).status, 400);
  assert.equal((await fetchPatch(bod, `/api/rinv/incidencias/${id}`, { estado: 'en_revision' })).status, 200);
  assert.equal((await fetchPatch(bod, `/api/rinv/incidencias/${id}`, { estado: 'cerrada', resolucion: 'Se retiró la tanda' })).status, 200);
  assert.equal((await bod.get('/api/rinv/incidencias')).body.length, 1);
  assert.equal((await bod.get('/api/rinv/incidencias?todas=1')).body.length, 2);
});

test('mantenimiento: la tienda anota por sucursal, se resuelve y se borra', async () => {
  assert.equal((await caj.post('/api/rinv/mantenimiento', { equipo: 'Aire', fecha: '2026-10-01' })).status, 400);        // sin sucursal
  const r = await caj.post('/api/rinv/mantenimiento', { equipo: 'Congelador', descripcion: 'No enfría', sucursal_id: sucId, fecha: '2026-10-01' });
  assert.equal(r.status, 201);
  assert.equal((await caj.get('/api/rinv/mantenimiento')).body.length, 1);
  assert.equal((await fetchPatch(caj, `/api/rinv/mantenimiento/${r.body.id}`, { listo: true })).status, 200);
  assert.equal((await caj.get('/api/rinv/mantenimiento')).body.length, 0);
  const todos = (await caj.get('/api/rinv/mantenimiento?todos=1')).body;
  assert.equal(todos[0].listo, true); assert.ok(todos[0].resuelto_en);
  assert.equal((await caj.del(`/api/rinv/mantenimiento/${r.body.id}`)).status, 200);
  assert.equal((await otra.get('/api/rinv/mantenimiento')).status, 403);
});

test('pedido pegado como texto se interpreta y empareja sin escribir nada', async () => {
  const p = await crear('PASTA PEGADA', { tipo: 'mec3', unidad: 'unidad' });
  const r = await bod.post('/api/rinv/fabrica/leer-pedido', { texto: 'Pasta pegada 8x4,5kg\nCosa que no existe 2x1' });
  assert.equal(r.body.items[0].insumo_id, p.id); assert.equal(r.body.items[0].unidades, 8); assert.equal(r.body.items[1].insumo_id, null);
  assert.equal((await t.db.query('select stock_actual from rinv.insumos_fab where id = $1', [p.id])).rows[0].stock_actual, null);
  assert.equal((await bod.post('/api/rinv/fabrica/extraer-documento', {})).status, 501);
});
