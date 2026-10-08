import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from './helpers.js';
import { sembrar } from '../src/db/sembrar.js';
import { calcularHoras } from '../src/modulos/rrhh/rutas.js';

let t, dueno, gerente, caja, cat, sucO;
const prod = (n) => cat.productos.find((p) => p.nombre === n);
const fp = (tipo) => cat.formas_pago.find((f) => f.tipo === tipo).id;

before(async () => {
  t = await iniciar();
  await sembrar(t.db, t.config.semillas, 'origen');
  await t.usuario({ nombre: 'Dueño', email: 'dueno@grupo.hn', password: 'ClaveSegura123', dueno: true });
  await t.usuario({ nombre: 'Gerente', email: 'ger@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Cajera', accesos: [{ empresa: 'origen', rol: 'cajero', pin: '1234' }] });
  dueno = t.cli(await t.login('origen', 'dueno@grupo.hn', 'ClaveSegura123'), 'origen');
  gerente = t.cli(await t.login('origen', 'ger@origen.hn', 'ClaveSegura123'), 'origen');
  caja = t.cli(await t.loginPin('origen', '1234'), 'origen');
  cat = (await caja.get('/api/pos/catalogo')).body;
  sucO = cat.sucursales[0].id;
});
after(() => t.cerrar());

test('inventario: compra crea lote con vencimiento estimado y sube el stock y el costo', async () => {
  const ins = (await gerente.get('/api/inv/insumos')).body;
  const fresa = ins.find((i) => i.nombre === 'Fresa');
  const r = await gerente.post('/api/inv/compras', { numero_documento: 'F-100', items: [{ insumo_id: fresa.id, cantidad: 10, costo_unitario: 150 }] });
  assert.equal(r.status, 201);
  assert.equal(r.body.total, 1500);
  const despues = (await gerente.get('/api/inv/insumos')).body.find((i) => i.nombre === 'Fresa');
  assert.equal(despues.stock, 30);
  assert.equal(despues.costo_actual, 150);
  assert.ok(despues.proximo_vencimiento);
  assert.equal((await caja.post('/api/inv/compras', { items: [] })).status, 403);   // cajera no mueve inventario
});

test('merma: descuenta FEFO (lo que vence primero) y exige motivo válido', async () => {
  const fresa = (await gerente.get('/api/inv/insumos')).body.find((i) => i.nombre === 'Fresa');
  assert.equal((await gerente.post('/api/inv/mermas', { insumo_id: fresa.id, cantidad: 2, motivo: 'inventado' })).status, 400);
  const r = await gerente.post('/api/inv/mermas', { insumo_id: fresa.id, cantidad: 2, motivo: 'maduracion', nota: 'Pasó de punto' });
  assert.equal(r.status, 201);
  assert.equal(r.body.costo, 280);   // salió del lote inicial (L140/kg) que vence antes que el comprado hoy
  const lotes = (await t.db.query(`select cantidad_actual from inv.lotes where insumo_id = $1 order by vence_at, recibido_at`, [fresa.id])).rows.map((x) => x.cantidad_actual);
  assert.deepEqual(lotes, [18, 10]);
});

test('conteo físico ajusta diferencias y las valora; traslado conserva costo', async () => {
  const mango = (await gerente.get('/api/inv/insumos')).body.find((i) => i.nombre === 'Mango');
  const r = await gerente.post('/api/inv/ajustes', { conteos: [{ insumo_id: mango.id, cantidad_real: 17 }] });
  assert.equal(r.body[0].diferencia, -3);
  assert.equal(r.body[0].valor, -90);
  const nueva = (await dueno.post('/api/admin/sucursales', { nombre: 'Origen · Express', alias: 'express', tipo: 'tienda' }));
  assert.equal(nueva.status, 201);
  const tr = await gerente.post('/api/inv/traslados', { origen_id: sucO, destino_id: nueva.body.id, insumo_id: mango.id, cantidad: 5 });
  assert.equal(tr.status, 201);
  const enDestino = (await gerente.get(`/api/inv/insumos?sucursal_id=${nueva.body.id}`)).body.find((i) => i.nombre === 'Mango');
  assert.equal(enDestino.stock, 5);
  assert.equal((await gerente.post('/api/inv/traslados', { origen_id: sucO, destino_id: sucO, insumo_id: mango.id, cantidad: 1 })).status, 400);
});

test('receta: costo, margen sobre precio neto de ISV, y editar la receta cambia el costo', async () => {
  const lista = (await gerente.get('/api/inv/recetas')).body;
  const gd = lista.find((p) => p.nombre === 'Green Detox');
  assert.equal(gd.precio_neto, 82.61);
  assert.ok(gd.margen_pct > 40 && gd.margen_pct < 60, `margen ${gd.margen_pct}`);
  const items = (await gerente.get(`/api/inv/recetas/${gd.id}`)).body;
  assert.ok(items.length >= 6);
  const nuevo = items.filter((i) => i.nombre !== 'Espinaca').map((i) => ({ insumo_id: i.insumo_id, cantidad: i.cantidad, merma_pct: i.merma_pct }));
  assert.equal((await gerente.put(`/api/inv/recetas/${gd.id}`, { items: nuevo })).status, 200);
  const despues = (await gerente.get('/api/inv/recetas')).body.find((p) => p.id === gd.id);
  assert.ok(despues.costo < gd.costo);
});

test('vencimientos próximos y stock negativo (venta sin existencia nunca bloquea la caja)', async () => {
  assert.equal((await caja.post('/api/pos/turno/abrir', { sucursal_id: sucO, fondo_inicial: 0 })).status, 201);
  const piña = (await gerente.get('/api/inv/insumos')).body.find((i) => i.nombre === 'Piña');
  assert.equal((await gerente.post('/api/inv/ajustes', { sucursal_id: sucO, conteos: [{ insumo_id: piña.id, cantidad_real: 0 }] })).status, 200);
  const v = await caja.post('/api/pos/ventas', { sucursal_id: sucO, items: [{ producto_id: prod('Piña Fresca').id, cantidad: 1 }], cobrar: { pagos: [{ forma_pago_id: fp('efectivo'), monto: 80 }] } });
  assert.equal(v.status, 201);   // vendió igual
  const despues = (await gerente.get('/api/inv/insumos')).body.find((i) => i.nombre === 'Piña');
  assert.ok(despues.negativo && despues.stock < 0);
  assert.ok(v.body.lineas[0].costo_unitario > 0);   // y costeó al último precio conocido
  const ven = await gerente.get('/api/inv/vencimientos?dias=30');
  assert.ok(ven.body.length > 0);
});

test('RRHH: una persona, dos empresas, un solo registro de persona', async () => {
  const a = await dueno.post('/api/rrhh/empleados', { nombres: 'María', apellidos: 'López', identidad: '0501-1990-12345', puesto: 'Cajera', salario_mensual: 9500 });
  assert.equal(a.status, 201);
  const enItalo = t.cli(await t.login('italo', 'dueno@grupo.hn', 'ClaveSegura123'), 'italo');
  const b = await enItalo.post('/api/rrhh/empleados', { nombres: 'María', apellidos: 'López', identidad: '0501199012345', puesto: 'Auxiliar de producción' });
  assert.equal(b.status, 201);
  const personas = await t.db.query(`select count(*)::int as n from rrhh.personas where identidad = '0501199012345'`);
  assert.equal(personas.rows[0].n, 1);
  assert.equal((await dueno.post('/api/rrhh/empleados', { nombres: 'María', apellidos: 'López', identidad: '0501199012345', puesto: 'Otra vez' })).status, 409);
  const dir = (await dueno.get('/api/rrhh/directorio')).body.find((p) => p.nombres === 'María');
  assert.equal(dir.contratos.length, 2);
  assert.deepEqual(dir.contratos.map((c) => c.empresa), ['italo', 'origen']);
  // el gerente ve la lista de su empresa pero NO el salario ni el directorio del grupo
  const lista = (await gerente.get('/api/rrhh/empleados')).body;
  assert.equal(lista[0].otros_contratos.length, 1);
  assert.equal(lista[0].salario_mensual, null);
  assert.equal((await gerente.get('/api/rrhh/directorio')).status, 403);
});

test('RRHH: marcación propia alterna entrada/salida y el cálculo de horas empareja jornadas', async () => {
  const cajera = (await dueno.get('/api/admin/usuarios')).body.find((u) => u.nombre === 'Cajera');
  const e = await dueno.post('/api/rrhh/empleados', { nombres: 'Cajera', apellidos: 'Demo', puesto: 'Cajera', usuario_id: cajera.id });
  assert.equal(e.status, 201);
  const m1 = await caja.post('/api/rrhh/marcar');
  const m2 = await caja.post('/api/rrhh/marcar');
  assert.equal(m1.body.tipo, 'entrada');
  assert.equal(m2.body.tipo, 'salida');
  const h = calcularHoras([
    { empleado_id: 'a', tipo: 'entrada', marcada_at: '2026-03-01T14:00:00Z' }, { empleado_id: 'a', tipo: 'salida', marcada_at: '2026-03-01T22:30:00Z' },
    { empleado_id: 'a', tipo: 'entrada', marcada_at: '2026-03-02T14:00:00Z' },
  ]).get('a');
  assert.equal(h.horas, 8.5);
  assert.equal(h.jornadas, 1);
  assert.equal(h.sin_salida, 1);
  const as = await gerente.get('/api/rrhh/asistencia');
  assert.equal(as.status, 200);
});

test('Finanzas: gasto, resultados con costo de recetas, y anulación', async () => {
  const cats = (await gerente.get('/api/fin/categorias')).body;
  const alquiler = cats.find((c) => c.grupo === 'alquiler');
  const g = await gerente.post('/api/fin/gastos', { categoria_id: alquiler.id, descripcion: 'Alquiler de octubre', monto: 1150, isv: 150 });
  assert.equal(g.status, 201);
  assert.equal((await caja.post('/api/fin/gastos', { categoria_id: alquiler.id, descripcion: 'x', monto: 5 })).status, 403);
  const res = (await gerente.get('/api/fin/resultados')).body;
  assert.equal(res.gastos_operativos, 1000);            // monto sin ISV
  assert.ok(res.ventas_netas > 0 && res.costo_ventas > 0);
  assert.equal(res.utilidad_operativa, Math.round((res.ventas_netas - res.costo_ventas - 1000) * 100) / 100);
  assert.equal((await gerente.post(`/api/fin/gastos/${g.body.id}/anular`, { motivo: 'duplicado' })).status, 200);
  assert.equal((await gerente.get('/api/fin/resultados')).body.gastos_operativos, 0);
});

test('Grupo: el dueño consolida varias empresas y se elimina lo intercompañía', async () => {
  // Venta en EcoStone (producto simple, sin receta)
  const eco = t.cli(await t.login('ecostone', 'dueno@grupo.hn', 'ClaveSegura123'), 'ecostone');
  const catE = (await eco.get('/api/pos/catalogo')).body;
  const cp = await eco.post('/api/pos/catalogo/admin/productos', { nombre: 'Piedra Rústica m2', precio: 1150, impuesto_tasa: 0.15 });
  assert.equal(cp.status, 201, JSON.stringify(cp.body));
  assert.equal((await eco.post('/api/pos/turno/abrir', { fondo_inicial: 0 })).status, 201);
  const v = await eco.post('/api/pos/ventas', { items: [{ producto_id: cp.body.id, cantidad: 3 }], cobrar: { pagos: [{ forma_pago_id: catE.formas_pago[0].id, monto: 3450 }] } });
  assert.equal(v.status, 201, JSON.stringify(v.body));

  const grupo = (await dueno.get('/api/grupo/resumen')).body;
  const cod = grupo.empresas.map((e) => e.codigo);
  assert.deepEqual(cod, ['italo', 'origen', 'ecostone', 'diserco']);
  const e = grupo.empresas.find((x) => x.codigo === 'ecostone');
  assert.equal(e.ventas_netas, 3000);
  assert.equal(e.hoy.total, 3450);
  const o = grupo.empresas.find((x) => x.codigo === 'origen');
  assert.ok(o.ventas_netas > 0);
  assert.equal(grupo.total.ventas_netas, Math.round((e.ventas_netas + o.ventas_netas) * 100) / 100);

  // DISERCO le vende a EcoStone por 1,000: no cuenta dos veces en el consolidado
  const dis = t.cli(await t.login('diserco', 'dueno@grupo.hn', 'ClaveSegura123'), 'diserco');
  assert.equal((await dis.post('/api/fin/intercompania', { destino: 'ecostone', concepto: 'Epóxico para instalación', monto: 1000 })).status, 201);
  const g2 = (await dueno.get('/api/grupo/resumen')).body.total;
  assert.equal(g2.eliminacion_intercompania, 1000);
  assert.equal(g2.ventas_netas_consolidadas, g2.ventas_netas - 1000);
});

test('Grupo: un gerente de una sola empresa no puede ver el consolidado', async () => {
  assert.equal((await gerente.get('/api/grupo/resumen')).status, 403);
  assert.equal((await caja.get('/api/grupo/alertas')).status, 403);
  const alertas = await dueno.get('/api/grupo/alertas');
  assert.equal(alertas.status, 200);
  assert.ok(Array.isArray(alertas.body.stock_negativo) && alertas.body.stock_negativo.length >= 1);
});

test('Clientes y proveedores: directorio común, RTN validado, historial entre empresas', async () => {
  const mal = await gerente.post('/api/terceros', { nombre: 'Cliente X', rtn: '123' });
  assert.equal(mal.status, 400);
  const c = await gerente.post('/api/terceros', { nombre: 'Restaurante La Esquina', rtn: '0501-1999-123456-7'.replace(/\D/g, '').slice(0, 14), telefono: '9999-0000' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal((await gerente.post('/api/terceros', { nombre: 'Otro', rtn: c.body.rtn })).status, 409);
  // lo ve otra empresa (directorio común)
  const enItalo = t.cli(await t.login('italo', 'dueno@grupo.hn', 'ClaveSegura123'), 'italo');
  assert.ok((await enItalo.get('/api/terceros?q=Esquina')).body.some((x) => x.id === c.body.id));
  // compra en Origen y en EcoStone → el dueño ve ambas en el historial
  const v = await caja.post('/api/pos/ventas', { sucursal_id: sucO, cliente_id: c.body.id, items: [{ producto_id: prod('Naranja Pura').id, cantidad: 2 }], cobrar: { pagos: [{ forma_pago_id: fp('efectivo'), monto: 150 }] } });
  assert.equal(v.status, 201);
  const h = (await dueno.get(`/api/terceros/${c.body.id}/historial`)).body;
  assert.equal(h.length, 1);
  assert.equal(h[0].empresa, 'origen');
  assert.equal((await gerente.put(`/api/terceros/${(await t.db.query('select id from core.terceros where es_consumidor_final')).rows[0].id}`, { nombre: 'Hackeado' })).status, 403);
});

test('Admin: crear usuario con PIN, PIN duplicado rechazado, escalada de privilegios bloqueada', async () => {
  const suc = (await gerente.get('/api/auth/yo')).body;   // el gerente no administra usuarios
  assert.ok(suc);
  assert.equal((await gerente.post('/api/admin/usuarios', { nombre: 'X', rol: 'cajero', pin: '5555' })).status, 403);
  const nuevo = await dueno.post('/api/admin/usuarios', { nombre: 'Cocinero Uno', rol: 'produccion', pin: '7777', sucursal_ids: [sucO] });
  assert.equal(nuevo.status, 201, JSON.stringify(nuevo.body));
  const dup = await dueno.post('/api/admin/usuarios', { nombre: 'Cocinero Dos', rol: 'produccion', pin: '7777' });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /PIN/);
  // el PIN del cocinero funciona y su rol solo ve cocina/inventario
  const coc = t.cli(await t.loginPin('origen', '7777'), 'origen');
  const yo = (await coc.get('/api/auth/yo')).body.contexto;
  assert.equal(yo.rol, 'produccion');
  assert.ok(!yo.permisos.includes('pos:vender'));
  assert.equal((await coc.post('/api/pos/ventas', { items: [{ producto_id: prod('Naranja Pura').id, cantidad: 1 }] })).status, 403);
  assert.equal((await coc.get('/api/pos/kds')).status, 200);
  // un admin (no dueño) no puede crear otro admin/dueño
  await t.usuario({ nombre: 'Admin Origen', email: 'adm@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'admin' }] });
  const adm = t.cli(await t.login('origen', 'adm@origen.hn', 'ClaveSegura123'), 'origen');
  assert.equal((await adm.post('/api/admin/usuarios', { nombre: 'Intruso', email: 'i@x.hn', password: 'ClaveSegura123', rol: 'dueno' })).status, 403);
  assert.equal((await adm.post('/api/admin/usuarios', { nombre: 'Cajero Nuevo', rol: 'cajero', pin: '3333' })).status, 201);
  // un rol de dirección sin correo no se puede crear
  assert.equal((await dueno.post('/api/admin/usuarios', { nombre: 'Sin correo', rol: 'contador', pin: '4444' })).status, 400);
});

test('Admin: usuario con acceso a dos empresas, roles distintos; desactivar lo saca solo de una', async () => {
  const cr = await dueno.post('/api/admin/usuarios', { nombre: 'Laura Mixta', email: 'laura@grupo.hn', password: 'ClaveSegura123', rol: 'gerente' });
  assert.equal(cr.status, 201);
  const enItalo = t.cli(await t.login('italo', 'dueno@grupo.hn', 'ClaveSegura123'), 'italo');
  const cr2 = await enItalo.post('/api/admin/usuarios', { nombre: 'Laura Mixta', email: 'laura@grupo.hn', rol: 'cajero', pin: '2468' });
  assert.equal(cr2.status, 201);
  assert.equal(cr2.body.id, cr.body.id);   // misma persona, mismo usuario
  const lo = t.cli(await t.login('origen', 'laura@grupo.hn', 'ClaveSegura123'), 'origen');
  const yo = (await lo.get('/api/auth/yo')).body;
  assert.deepEqual(yo.empresas.map((e) => [e.codigo, e.rol]).sort(), [['italo', 'cajero'], ['origen', 'gerente']]);
  assert.equal((await enItalo.put(`/api/admin/usuarios/${cr.body.id}`, { activo: false })).status, 200);
  assert.equal((await t.cli().post('/api/auth/pin', { empresa: 'italo', pin: '2468' })).status, 401);
  assert.equal((await t.cli().post('/api/auth/login', { empresa: 'origen', email: 'laura@grupo.hn', password: 'ClaveSegura123' })).status, 200);
});

test('KDS: la cocina ve las órdenes cobradas y las avanza hasta entregadas', async () => {
  const coc = t.cli(await t.loginPin('origen', '7777'), 'origen');
  const cola = (await coc.get('/api/pos/kds')).body;
  assert.ok(cola.length > 0);
  const o = cola[0];
  assert.ok(Array.isArray(o.lineas) && o.lineas.length > 0);
  for (const estado of ['preparando', 'listo', 'entregado']) assert.equal((await coc.put(`/api/pos/ventas/${o.id}/prep`, { estado })).status, 200);
  assert.ok(!(await coc.get('/api/pos/kds')).body.some((x) => x.id === o.id));
});
