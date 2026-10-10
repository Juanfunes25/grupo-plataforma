import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from './helpers.js';
import { sembrar } from '../src/db/sembrar.js';

let t, caja, gerente, dueno, cat, suc;
const prod = (n) => cat.productos.find((p) => p.nombre === n);
const efectivo = () => cat.formas_pago.find((f) => f.tipo === 'efectivo').id;
const vender = async (cli, nombre = 'Naranja Pura', cant = 1, extra = {}) =>
  (await cli.post('/api/pos/ventas', { items: [{ producto_id: prod(nombre).id, cantidad: cant }], cobrar: { pagos: [{ forma_pago_id: efectivo(), monto: 1000 }] }, ...extra }));

before(async () => {
  t = await iniciar();
  await t.activarNotasCredito('origen');
  await sembrar(t.db, t.config.semillas, 'origen');
  await t.usuario({ nombre: 'Dueño', email: 'dueno@grupo.hn', password: 'ClaveSegura123', dueno: true });
  await t.usuario({ nombre: 'Gerente', email: 'ger@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Cajera Ana', accesos: [{ empresa: 'origen', rol: 'cajero', pin: '1234' }] });
  caja = t.cli(await t.loginPin('origen', '1234'), 'origen');
  gerente = t.cli(await t.login('origen', 'ger@origen.hn', 'ClaveSegura123'), 'origen');
  dueno = t.cli(await t.login('origen', 'dueno@grupo.hn', 'ClaveSegura123'), 'origen');
  cat = (await caja.get('/api/pos/catalogo')).body;
  suc = cat.sucursales[0].id;
  await caja.post('/api/pos/turno/abrir', { fondo_inicial: 100 });
});
after(() => t.cerrar());

test('nota de crédito: parcial, total y tope; solo con permiso; queda en la factura y en la bitácora', async () => {
  const v = (await vender(caja, 'Naranja Pura', 2)).body;          // L150
  assert.equal(v.total, 150);
  assert.equal((await caja.post(`/api/pos/ventas/${v.id}/nota-credito`, { motivo: 'Devolución' })).status, 403);
  const n1 = await gerente.post(`/api/pos/ventas/${v.id}/nota-credito`, { motivo: 'Devolución de un jugo', monto: 75 });
  assert.equal(n1.status, 201, JSON.stringify(n1.body));
  assert.match(n1.body.numero_nota, /^BORRADOR-NC-000001$/);
  assert.equal((await gerente.post(`/api/pos/ventas/${v.id}/nota-credito`, { motivo: 'Demasiado', monto: 100 })).status, 400);
  const n2 = await gerente.post(`/api/pos/ventas/${v.id}/nota-credito`, { motivo: 'Resto' });      // por defecto: lo que falta acreditar
  assert.equal(n2.body.monto, 75);
  assert.equal((await gerente.post(`/api/pos/ventas/${v.id}/nota-credito`, { motivo: 'Otra más' })).status, 409);
  const det = (await dueno.get(`/api/pos/ventas/${v.id}`)).body;
  assert.equal(det.notas_credito.length, 2);
  const aud = (await dueno.get('/api/admin/auditoria?limite=50')).body.map((a) => a.accion);
  assert.ok(aud.includes('nota_credito_emitida'));
});

test('tercera edad: exige identidad; se puede apagar por empresa', async () => {
  const it = [{ producto_id: prod('Green Detox').id, cantidad: 1, descuento_porcentaje: 25 }];
  const pagos = [{ forma_pago_id: efectivo(), monto: 200 }];
  assert.equal((await dueno.post('/api/pos/turno/abrir', { sucursal_id: suc, fondo_inicial: 0 })).status, 201);
  assert.equal((await dueno.post('/api/pos/ventas', { items: it, cobrar: { pagos } })).status, 400);
  const ok = await dueno.post('/api/pos/ventas', { items: it, tercera_edad: { nombre: 'Don Jose Perez', identidad: '0801-1948-00456' }, cobrar: { pagos } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.tercera_edad_nombre, 'Don Jose Perez');
  await t.db.query(`insert into core.config (empresa_id, clave, valor) values ((select id from core.empresas where codigo = 'origen'), 'pos', '{"exigir_tercera_edad": false}') on conflict (empresa_id, clave) do update set valor = core.config.valor || '{"exigir_tercera_edad": false}'::jsonb`);
  assert.equal((await dueno.post('/api/pos/ventas', { items: it, cobrar: { pagos } })).status, 201);
});

test('caja chica: los movimientos de todos los turnos se listan con usuario y concepto', async () => {
  await caja.post('/api/pos/turno/movimiento', { tipo: 'salida', monto: 35, concepto: 'Hielo' });
  await caja.post('/api/pos/turno/movimiento', { tipo: 'ingreso', monto: 200, concepto: 'Cambio del banco' });
  const l = (await dueno.get('/api/pos/antifraude/movimientos-caja')).body;
  assert.equal(l.length, 2);
  assert.deepEqual(l.map((m) => m.tipo).sort(), ['ingreso', 'salida']);
  assert.equal(l[0].usuario, 'Cajera Ana');
  assert.equal((await caja.get('/api/pos/antifraude/movimientos-caja')).status, 403);
});

test('antifraude: detecta anulaciones altas, descuadre, reimpresiones y saltos de numeración', async () => {
  // 5 ventas más de la cajera; el gerente anula 3 (60 %)
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await vender(caja)).body.id);
  for (const id of ids.slice(0, 3)) assert.equal((await gerente.post(`/api/pos/ventas/${id}/anular`, { motivo: 'Error de cobro' })).status, 200);
  // reimpresiones (6 > 5)
  for (let i = 0; i < 6; i++) assert.equal((await caja.get(`/api/pos/ventas/${ids[3]}/ticket?reimpresion=true`)).status, 200);
  // salto de numeración: se "pierde" un correlativo
  await t.db.query(`update pos.puntos_emision set correlativo_actual = correlativo_actual + 3 where sucursal_id = $1`, [suc]);
  await vender(caja);
  // cierre con faltante grande
  const cierre = await caja.post('/api/pos/turno/cerrar', { efectivo_contado: 0 });
  assert.equal(cierre.status, 200);

  const r = (await dueno.get('/api/pos/antifraude')).body;
  const tipos = r.alertas.map((a) => a.tipo);
  for (const x of ['anulaciones_altas', 'reimpresiones', 'hueco_correlativo', 'descuadre_caja']) assert.ok(tipos.includes(x), `falta ${x}: ${tipos}`);
  assert.equal(r.alertas[0].severidad, 'alta');                       // lo grave va primero
  assert.equal((await caja.get('/api/pos/antifraude')).status, 403);
});

test('reglas del antifraude: se ajustan por empresa y cambian lo que se alerta', async () => {
  assert.equal((await gerente.put('/api/pos/antifraude/reglas', { reimpresiones_max: 100 })).status, 403);   // solo admin:empresa
  const nuevas = await dueno.put('/api/pos/antifraude/reglas', { reimpresiones_max: 100, descuadre_max: 100000 });
  assert.equal(nuevas.body.reimpresiones_max, 100);
  const tipos = (await dueno.get('/api/pos/antifraude')).body.alertas.map((a) => a.tipo);
  assert.ok(!tipos.includes('reimpresiones'));
  assert.ok(!tipos.includes('descuadre_caja'));
  assert.ok(tipos.includes('anulaciones_altas'));
});
