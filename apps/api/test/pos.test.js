import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from './helpers.js';
import { sembrar } from '../src/db/sembrar.js';

let t, caja, gerente, dueno, italoCaja, cat, sucOrigen;
const prod = (n) => cat.productos.find((p) => p.nombre === n);
const mod = (n) => cat.grupos.flatMap((g) => g.modificadores).find((m) => m.nombre === n);
const fp = (tipo) => cat.formas_pago.find((f) => f.tipo === tipo).id;
const stock = async (nombre) => {
  const r = await gerente.get('/api/inv/insumos');
  return r.body.find((i) => i.nombre === nombre).stock;
};

before(async () => {
  t = await iniciar();
  await sembrar(t.db, t.config.semillas, 'origen');
  await t.usuario({ nombre: 'Dueño', email: 'dueno@grupo.hn', password: 'ClaveSegura123', dueno: true });
  await t.usuario({ nombre: 'Gerente', email: 'ger@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Cajera', accesos: [{ empresa: 'origen', rol: 'cajero', pin: '1234' }] });
  await t.usuario({ nombre: 'Cajero Italo', accesos: [{ empresa: 'italo', rol: 'cajero', pin: '1234' }] });
  caja = t.cli(await t.loginPin('origen', '1234'), 'origen');
  italoCaja = t.cli(await t.loginPin('italo', '1234'), 'italo');
  gerente = t.cli(await t.login('origen', 'ger@origen.hn', 'ClaveSegura123'), 'origen');
  dueno = t.cli(await t.login('origen', 'dueno@grupo.hn', 'ClaveSegura123'), 'origen');
  cat = (await caja.get('/api/pos/catalogo')).body;
  sucOrigen = cat.sucursales[0].id;
});
after(() => t.cerrar());

test('el catálogo trae productos, opciones, formas de pago y estado fiscal', () => {
  assert.equal(cat.productos.length, 11);
  assert.ok(cat.formas_pago.length >= 3);
  assert.equal(cat.fiscal[sucOrigen].borrador, true);
  const smoothie = prod('Mango Tropical');
  assert.equal(smoothie.grupo_ids.length, 3);
});

test('abrir turno NO es necesario: el primer cobro lo abre solo; se puede volver a exigir por empresa', async () => {
  const venta = (n) => ({ items: [{ producto_id: prod('Naranja Pura').id, cantidad: n }], cobrar: { pagos: [{ forma_pago_id: fp('efectivo'), monto: 100 * n }] } });
  const emp = (await t.db.query(`select id from core.empresas where codigo = 'origen'`)).rows[0].id;
  // Con exigir_turno = true se rechaza y se revierte todo
  await t.db.query(`insert into core.config (empresa_id, clave, valor) values ($1, 'pos', '{"exigir_turno": true}'::jsonb) on conflict (empresa_id, clave) do update set valor = core.config.valor || '{"exigir_turno": true}'::jsonb`, [emp]);
  const r = await caja.post('/api/pos/ventas', venta(1));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /turno/i);
  assert.equal((await caja.get('/api/pos/ventas')).body.length, 0);
  // Por defecto: vende y el turno se abre solo, con fondo 0
  await t.db.query(`update core.config set valor = valor - 'exigir_turno' where empresa_id = $1 and clave = 'pos'`, [emp]);
  const ok = await caja.post('/api/pos/ventas', venta(1));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const turno = (await caja.get('/api/pos/turno/actual')).body;
  assert.ok(turno.turno, 'quedó un turno abierto');
  assert.equal(Number(turno.turno.fondo_inicial), 0);
  // Se deja el estado como lo espera el resto: anular la venta y cerrar el turno
  const anul = await gerente.post(`/api/pos/ventas/${ok.body.id}/anular`, { motivo: 'prueba de turno automático' });
  assert.equal(anul.status, 200, JSON.stringify(anul.body));
  const cierre = await caja.post('/api/pos/turno/cerrar', { efectivo_contado: 0 });
  assert.equal(cierre.status, 200, JSON.stringify(cierre.body));
});

test('abrir turno y vender con modificadores, cambio y factura en borrador', async () => {
  assert.equal((await caja.post('/api/pos/turno/abrir', { fondo_inicial: 500 })).status, 201);
  const r = await caja.post('/api/pos/ventas', {
    nombre_orden: 'Ana',
    items: [{ producto_id: prod('Mango Tropical').id, cantidad: 2, opciones: [mod('Grande 24 oz').id, mod('Chía').id, mod('Leche de almendra').id] }],
    cobrar: { pagos: [{ forma_pago_id: fp('efectivo'), monto: 400 }] },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const v = r.body;
  assert.equal(v.estado, 'pagada');
  assert.equal(v.total, 330);                       // (105 + 25 + 15 + 20) × 2
  assert.equal(v.subtotal_gravado_15, 286.96);
  assert.equal(v.isv_total, 43.04);
  assert.equal(v.cambio, 70);
  assert.equal(v.numero_factura, 'BORRADOR-001-001-01-00000002');
  assert.equal(v.es_borrador_fiscal, true);
  assert.equal(v.pagos.length, 1);
  assert.equal(v.pagos[0].monto, 330);              // pago neto, sin el cambio
  assert.equal(v.lineas[0].opciones.length, 3);
  assert.equal(v.lineas[0].precio_unitario, 165);
  assert.ok(v.lineas[0].costo_unitario > 0, 'guardó el costo de la receta');
  globalThis.__venta1 = v;
});

test('el cobro descontó receta + consumo de modificadores del inventario', async () => {
  // Mango: 2 × 0.25 × 1.30 (merma 30 %) + 2 × 0.08 (tamaño grande) = 0.81 → 20 − 0.81
  assert.equal(Math.round((await stock('Mango')) * 1000) / 1000, 19.19);
  assert.equal(Math.round((await stock('Chía')) * 1000) / 1000, 19.98);
  assert.equal(Math.round((await stock('Leche de almendra')) * 1000) / 1000, 19.6);
  assert.equal(await stock('Vaso 16 oz'), 198);
});

test('anular: el cajero no puede; el gerente sí, y el inventario se revierte', async () => {
  const id = globalThis.__venta1.id;
  assert.equal((await caja.post(`/api/pos/ventas/${id}/anular`, { motivo: 'prueba' })).status, 403);
  assert.equal((await gerente.post(`/api/pos/ventas/${id}/anular`, { motivo: '' })).status, 400);
  const r = await gerente.post(`/api/pos/ventas/${id}/anular`, { motivo: 'Error de digitación' });
  assert.equal(r.status, 200);
  assert.equal(r.body.estado, 'anulada');
  assert.equal(Math.round((await stock('Mango')) * 1000) / 1000, 20);
  assert.equal(await stock('Vaso 16 oz'), 200);
  assert.equal((await gerente.post(`/api/pos/ventas/${id}/anular`, { motivo: 'otra vez' })).status, 409);
});

test('validación de opciones: obligatoria, de otro producto, y precios del cliente se ignoran', async () => {
  const pagos = [{ forma_pago_id: fp('efectivo'), monto: 500 }];
  // Tamaño es obligatorio en smoothies
  let r = await caja.post('/api/pos/ventas', { items: [{ producto_id: prod('Berry Power').id, cantidad: 1 }], cobrar: { pagos } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Tamaño/);
  // "Chía" no es opción de un shot
  r = await caja.post('/api/pos/ventas', { items: [{ producto_id: prod('Shot Jengibre-Limón').id, cantidad: 1, opciones: [mod('Chía').id] }], cobrar: { pagos } });
  assert.equal(r.status, 400);
  // máximo 3 boosters
  r = await caja.post('/api/pos/ventas', { items: [{ producto_id: prod('Green Detox').id, cantidad: 1, opciones: [mod('Chía').id, mod('Miel').id, mod('Cúrcuma').id, mod('Proteína vegetal').id] }], cobrar: { pagos } });
  assert.equal(r.status, 400);
  // un cliente malicioso manda precio: se ignora
  r = await caja.post('/api/pos/ventas', { items: [{ producto_id: prod('Naranja Pura').id, cantidad: 1, precio_base: 1, precio_unitario: 1, monto: 1 }], cobrar: { pagos } });
  assert.equal(r.status, 201);
  assert.equal(r.body.total, 75);
});

test('pagos: insuficiente, tarjeta mayor al total y mixto', async () => {
  const item = [{ producto_id: prod('Green Detox').id, cantidad: 1 }];
  let r = await caja.post('/api/pos/ventas', { items: item, cobrar: { pagos: [{ forma_pago_id: fp('efectivo'), monto: 50 }] } });
  assert.equal(r.status, 409);
  r = await caja.post('/api/pos/ventas', { items: item, cobrar: { pagos: [{ forma_pago_id: fp('tarjeta'), monto: 120 }] } });
  assert.equal(r.status, 409);
  r = await caja.post('/api/pos/ventas', { items: item, cobrar: { pagos: [{ forma_pago_id: fp('tarjeta'), monto: 45, referencia: 'AUT123' }, { forma_pago_id: fp('efectivo'), monto: 100 }] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.total, 95);
  assert.equal(r.body.cambio, 50);
  assert.deepEqual(r.body.pagos.map((p) => [p.tipo, p.monto]).sort(), [['efectivo', 50], ['tarjeta', 45]]);
});

test('producto exento por peso (decimal) va a importe exento', async () => {
  const r = await caja.post('/api/pos/ventas', { items: [{ producto_id: prod('Mango (por kg)').id, cantidad: 1.35 }], cobrar: { pagos: [{ forma_pago_id: fp('efectivo'), monto: 100 }] } });
  assert.equal(r.status, 201);
  assert.equal(r.body.total, 60.75);
  assert.equal(r.body.subtotal_exento, 60.75);
  assert.equal(r.body.isv_total, 0);
});

test('correlativo atómico: 8 cobros simultáneos → 8 números distintos y consecutivos', async () => {
  const pedir = () => caja.post('/api/pos/ventas', { items: [{ producto_id: prod('Piña Fresca').id, cantidad: 1 }], cobrar: { pagos: [{ forma_pago_id: fp('efectivo'), monto: 80 }] } });
  const rs = await Promise.all(Array.from({ length: 8 }, pedir));
  assert.ok(rs.every((r) => r.status === 201));
  const nums = rs.map((r) => r.body.correlativo).sort((a, b) => a - b);
  assert.equal(new Set(nums).size, 8);
  assert.equal(nums[7] - nums[0], 7);
});

test('orden abierta: se edita, se cobra después y los totales se recalculan', async () => {
  let r = await caja.post('/api/pos/ventas', { items: [{ producto_id: prod('Naranja Pura').id, cantidad: 1 }] });
  assert.equal(r.status, 201);
  assert.equal(r.body.estado, 'abierta');
  assert.equal(r.body.numero_factura, null);
  const id = r.body.id;
  r = await caja.put(`/api/pos/ventas/${id}`, { items: [{ producto_id: prod('Naranja Pura').id, cantidad: 3 }, { producto_id: prod('Piña Fresca').id, cantidad: 1 }] });
  assert.equal(r.body.total, 305);
  r = await caja.post(`/api/pos/ventas/${id}/cobrar`, { pagos: [{ forma_pago_id: fp('transferencia'), monto: 305, referencia: 'TRX-9' }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.estado, 'pagada');
  assert.equal((await caja.put(`/api/pos/ventas/${id}`, { items: [{ producto_id: prod('Naranja Pura').id, cantidad: 1 }] })).status, 409);
});

test('descuento: con el permiso quitado el cajero no puede; el dueño sí (25 % tercera edad)', async () => {
  const it = [{ producto_id: prod('Green Detox').id, cantidad: 1, descuento_porcentaje: 25 }];
  const pagos = [{ forma_pago_id: fp('efectivo'), monto: 100 }];
  // el dueño quita el permiso a la cajera desde la API de administración
  const lista = (await dueno.get('/api/admin/usuarios')).body;
  const cajera = lista.find((u) => u.nombre === 'Cajera');
  assert.equal((await dueno.put(`/api/admin/usuarios/${cajera.id}`, { permisos_quitados: ['pos:descuento'] })).status, 200);
  assert.equal((await caja.post('/api/pos/ventas', { items: it })).status, 403);
  const r = await dueno.post('/api/pos/turno/abrir', { fondo_inicial: 0 });
  assert.equal(r.status, 201);
  const sinId = await dueno.post('/api/pos/ventas', { items: it, cobrar: { pagos } });
  assert.equal(sinId.status, 400);                 // la ley exige identificar a la persona de tercera edad
  assert.match(sinId.body.error, /tercera edad/);
  const v = await dueno.post('/api/pos/ventas', { items: it, tercera_edad: { nombre: 'Marta Lopez', identidad: '0501-1950-00123' }, cobrar: { pagos } });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  assert.equal(v.body.tercera_edad_identidad, '0501-1950-00123');
  assert.equal(v.body.total, 71.25);
  assert.equal(v.body.descuento, 23.75);
  assert.equal(v.body.descuento_porcentaje, 25);
  assert.equal(v.body.subtotal_gravado_15, 61.96);     // 71.25 / 1.15
  assert.equal(v.body.isv_total, 9.29);
});

test('aislamiento entre empresas: Italo no ve ventas ni catálogo de Origen', async () => {
  const lista = (await gerente.get('/api/pos/ventas')).body;
  assert.ok(lista.length > 0);
  const r = await italoCaja.get(`/api/pos/ventas/${lista[0].id}`);
  assert.equal(r.status, 404);
  const catI = (await italoCaja.get('/api/pos/catalogo')).body;
  assert.equal(catI.productos.length, 0);
  // y no puede cobrar una venta de Origen aunque conozca el id
  const c = await italoCaja.post(`/api/pos/ventas/${lista[0].id}/cobrar`, { pagos: [{ forma_pago_id: fp('efectivo'), monto: 1000 }] });
  assert.ok([403, 404].includes(c.status));
});

test('CAI: solo quien tiene pos:fiscal; formato SAR validado; al activarlo la factura ya no es borrador', async () => {
  const pes = (await dueno.get('/api/pos/puntos-emision')).body;
  const pe = pes.find((p) => p.sucursal_id === sucOrigen);
  assert.equal(pe.es_borrador, true);
  const cuerpo = { cai: '2F4851-96A881-B76670-CE6CCE-48D250-32', punto_emision_codigo: '001', punto_venta_codigo: '001', tipo_documento_codigo: '01',
    correlativo_desde: 1, correlativo_hasta: 500, correlativo_actual: 1, fecha_limite_emision: '2027-12-31', es_borrador: false };
  assert.equal((await gerente.put(`/api/pos/puntos-emision/${pe.id}`, cuerpo)).status, 403);
  assert.equal((await dueno.put(`/api/pos/puntos-emision/${pe.id}`, { ...cuerpo, cai: 'NO-ES-UN-CAI' })).status, 400);
  assert.equal((await dueno.put(`/api/pos/puntos-emision/${pe.id}`, { ...cuerpo, fecha_limite_emision: '2020-01-01' })).status, 400);
  const ok = await dueno.put(`/api/pos/puntos-emision/${pe.id}`, { ...cuerpo, cai: '2f485196a881b76670ce6cce48d25032' });   // pegado sin guiones
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.cai, '2F4851-96A881-B76670-CE6CCE-48D250-32');

  const v = await dueno.post('/api/pos/ventas', { items: [{ producto_id: prod('Naranja Pura').id, cantidad: 1 }], cobrar: { pagos: [{ forma_pago_id: fp('efectivo'), monto: 75 }] } });
  assert.equal(v.body.numero_factura, '001-001-01-00000001');
  assert.equal(v.body.es_borrador_fiscal, false);
  const tk = await dueno.get(`/api/pos/ventas/${v.body.id}/ticket`);
  const texto = tk.body.lineas.join('\n');
  assert.match(texto, /CAI: 2F4851-96A881/);
  assert.doesNotMatch(texto, /SIN VALOR FISCAL/);
  // con el CAI en uso no se puede retroceder el correlativo
  assert.equal((await dueno.put(`/api/pos/puntos-emision/${pe.id}`, { correlativo_actual: 1 })).status, 400);
});

test('rango agotado: el sistema se niega a emitir fuera del rango autorizado', async () => {
  const pe = (await dueno.get('/api/pos/puntos-emision')).body.find((p) => p.sucursal_id === sucOrigen);
  await t.db.query('update pos.puntos_emision set correlativo_hasta = correlativo_actual where id = $1', [pe.id]);
  const pagos = [{ forma_pago_id: fp('efectivo'), monto: 75 }];
  const it = [{ producto_id: prod('Naranja Pura').id, cantidad: 1 }];
  assert.equal((await dueno.post('/api/pos/ventas', { items: it, cobrar: { pagos } })).status, 201);   // la última del rango
  const r = await dueno.post('/api/pos/ventas', { items: it, cobrar: { pagos } });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /agotado/);
});

test('cierre de turno: cuadre por forma de pago; el cajero no ve el esperado antes de cerrar', async () => {
  const antes = await caja.get('/api/pos/turno/actual');
  assert.ok(antes.body.turno);
  assert.equal(antes.body.resumen.efectivo_esperado, undefined);
  assert.ok(antes.body.resumen.facturas >= 4);
  // movimiento de caja: salida
  assert.equal((await caja.post('/api/pos/turno/movimiento', { tipo: 'salida', monto: 20, concepto: 'Compra de hielo' })).status, 201);
  const r = await caja.post('/api/pos/turno/cerrar', { efectivo_contado: 0 });
  assert.equal(r.status, 200);
  const rs = r.body.resumen;
  assert.equal(rs.salidas, 20);
  assert.equal(r.body.turno.diferencia, Math.round((0 - rs.efectivo_esperado) * 100) / 100);
  assert.equal(r.body.turno.estado, 'cerrado');
  assert.ok(rs.tarjeta > 0 && rs.transferencia > 0);
  // ya no puede cobrar sin abrir otro turno
  const v = await caja.post('/api/pos/ventas', { items: [{ producto_id: prod('Naranja Pura').id, cantidad: 1 }], cobrar: { pagos: [{ forma_pago_id: fp('efectivo'), monto: 75 }] } });
  assert.equal(v.status, 409);
});

test('reporte de ventas y margen', async () => {
  const r = await gerente.get('/api/pos/reportes/resumen');
  assert.equal(r.status, 200);
  assert.ok(r.body.facturas >= 5);
  assert.ok(r.body.total > 0 && r.body.ticket_promedio > 0);
  assert.equal(r.body.anuladas.n, 2);
  assert.ok(r.body.top_productos.length > 0);
  assert.ok(r.body.margen_pct > 0 && r.body.margen_pct < 100);
  assert.equal(r.body.por_hora.length > 0, true);
  assert.equal((await caja.get('/api/pos/reportes/resumen')).status, 403);   // el cajero no ve reportes
  const libro = await gerente.get('/api/pos/reportes/libro');
  assert.ok(libro.body.some((f) => f.estado === 'anulada'));
});

test('la bitácora registró todo y su cadena de hashes está íntegra; no se puede alterar', async () => {
  const v = await dueno.get('/api/admin/auditoria/verificar');
  assert.equal(v.body.integra, true);
  assert.ok(v.body.total > 10);
  const acciones = (await dueno.get('/api/admin/auditoria?limite=200')).body.map((a) => a.accion);
  for (const a of ['venta_cobrada', 'venta_anulada', 'turno_abierto', 'turno_cerrado', 'cai_activado', 'usuario_editado']) assert.ok(acciones.includes(a), a);
  await assert.rejects(() => t.db.query(`update core.auditoria set accion = 'x' where id = 1`), /inalterable/);
  await assert.rejects(() => t.db.query('delete from core.auditoria'), /inalterable/);
  assert.equal((await caja.get('/api/admin/auditoria')).status, 403);
});
