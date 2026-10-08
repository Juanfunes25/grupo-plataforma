import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { iniciar } from './helpers.js';
import { importarItaloFacturacion } from '../src/migracion/italo-facturacion.js';

const aqui = path.dirname(fileURLToPath(import.meta.url));
let t, legado;

/** Base "vieja": el esquema REAL de italo-facturacion (sus 15 migraciones) sobre un Postgres embebido. */
async function crearLegado() {
  const pg = new PGlite();
  await pg.exec(`
    create schema auth; create schema extensions;
    create table auth.users(id uuid primary key default gen_random_uuid(), email text);
    create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
    create role anon; create role authenticated; create role service_role;
    create function extensions.digest(d text, t text) returns bytea language sql immutable as $$ select sha256(convert_to(d,'UTF8')) $$;
    create publication supabase_realtime;`);
  const dir = path.join(aqui, 'fixtures', 'italo-facturacion');
  for (const f of fs.readdirSync(dir).sort()) await pg.exec(fs.readFileSync(path.join(dir, f), 'utf8').replace(/create extension if not exists "pgcrypto";/i, ''));
  const opciones = { parsers: { 20: (v) => Number(v), 1700: (v) => parseFloat(v), 1082: (v) => v } };
  return { query: async (sql, p) => { const r = await pg.query(sql, p, opciones); return { rows: r.rows, rowCount: Math.max(r.affectedRows ?? 0, r.rows.length) }; }, exec: (s) => pg.exec(s), pg };
}

before(async () => {
  t = await iniciar();
  legado = await crearLegado();
  await legado.exec(`
    -- usuarios con correo en auth.users
    insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1','juan@viejo.hn'), ('00000000-0000-0000-0000-0000000000a2','Cajera.Andes@viejo.hn'), ('00000000-0000-0000-0000-0000000000a3','gerente.mackey@viejo.hn');
    update sucursales set direccion = direccion;
    insert into perfiles (id, sucursal_id, nombre, rol) select '00000000-0000-0000-0000-0000000000a1', null, 'Juan Admin', 'admin';
    insert into perfiles (id, sucursal_id, nombre, rol) select '00000000-0000-0000-0000-0000000000a2', id, 'Cajera Los Andes', 'cajero' from sucursales where alias = 'los_andes';
    insert into perfiles (id, sucursal_id, nombre, rol) select '00000000-0000-0000-0000-0000000000a3', id, 'Gerente Mackey', 'manager' from sucursales where alias = 'mackey';
    -- catálogo
    insert into categorias (id, nombre, orden) values ('00000000-0000-0000-0000-0000000000c1', 'Helados', 1), ('00000000-0000-0000-0000-0000000000c2', 'Bebidas', 2);
    insert into productos (id, codigo, nombre, categoria_id, precio, impuesto1_tasa, codigo_barras) values
      ('00000000-0000-0000-0000-0000000000b1', 'H1', 'Cono doble', '00000000-0000-0000-0000-0000000000c1', 115, 0.15, '7501'),
      ('00000000-0000-0000-0000-0000000000b2', 'B1', 'Agua', '00000000-0000-0000-0000-0000000000c2', 25, 0, null),
      ('00000000-0000-0000-0000-0000000000b3', 'L1', 'Cerveza', '00000000-0000-0000-0000-0000000000c2', 59, 0.18, null);
    -- clientes
    insert into clientes (id, nombre, rtn, telefono) values
      ('00000000-0000-0000-0000-0000000000d1', 'Hotel Palace', '05019999123456', '2550-1111'),
      ('00000000-0000-0000-0000-0000000000d2', 'Hotel Palace (duplicado)', '05019999123456', null),
      ('00000000-0000-0000-0000-0000000000d3', 'Juan Perez', '123', null);
    -- CAI real en Los Andes
    update puntos_emision pe set es_borrador = false, cai = '2F4851-96A881-B76670-CE6CCE-48D250-32', punto_emision_codigo = '002', punto_venta_codigo = '001',
           correlativo_desde = 1, correlativo_hasta = 500, correlativo_actual = 4, fecha_limite_emision = '2027-06-30'
      from sucursales s where s.id = pe.sucursal_id and s.alias = 'los_andes';
  `);
  const idsSuc = Object.fromEntries((await legado.query('select id, alias from sucursales')).rows.map((s) => [s.alias, s.id]));
  const fp = Object.fromEntries((await legado.query('select id, nombre from formas_pago')).rows.map((f) => [f.nombre, f.id]));
  const pe = (await legado.query("select id from puntos_emision where sucursal_id = $1", [idsSuc.los_andes])).rows[0].id;
  const venta = async (id, extra) => legado.query(
    `insert into ventas (id, sucursal_id, punto_emision_id, numero_factura, correlativo, cliente_id, cajero_id, tipo_orden, estado, subtotal_gravado_15, isv_total, total, efectivo_recibido, cambio, fecha_emision, created_at, descuento_porcentaje, tercera_edad_nombre, tercera_edad_identidad)
     values ($1,$2,$3,$4,$5,$6,'00000000-0000-0000-0000-0000000000a2',$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,$16,$17)`,
    [id, idsSuc.los_andes, pe, extra.nf, extra.corr, extra.cliente ?? null, extra.tipo ?? 'restaurante', extra.estado ?? 'pagada', extra.base, extra.isv, extra.total, extra.recibido ?? extra.total, extra.cambio ?? 0, extra.fecha, extra.dpct ?? 0, extra.te ?? null, extra.te ? '0501-1950-00001' : null]);
  await venta('00000000-0000-0000-0000-0000000000e1', { nf: '002-001-01-00000001', corr: 1, cliente: '00000000-0000-0000-0000-0000000000d1', base: 200, isv: 30, total: 230, recibido: 250, cambio: 20, fecha: '2026-09-01T15:00:00Z' });
  await venta('00000000-0000-0000-0000-0000000000e2', { nf: '002-001-01-00000002', corr: 2, tipo: 'para_llevar', base: 86.96, isv: 13.04, total: 100, dpct: 25, te: 'Doña Marta', fecha: '2026-09-01T16:00:00Z' });
  await venta('00000000-0000-0000-0000-0000000000e3', { nf: '002-001-01-00000003', corr: 3, base: 43.48, isv: 6.52, total: 50, fecha: '2026-09-02T15:00:00Z' });
  await venta('00000000-0000-0000-0000-0000000000e4', { nf: 'BORRADOR-002-001-01-00000009', corr: 9, estado: 'anulada', base: 43.48, isv: 6.52, total: 50, fecha: '2026-09-02T17:00:00Z' });
  await legado.query(`insert into ventas (id, sucursal_id, tipo_orden, estado, total) values ('00000000-0000-0000-0000-0000000000e5', $1, 'restaurante', 'abierta', 10)`, [idsSuc.los_andes]);
  await legado.exec(`
    insert into detalle_venta (id, venta_id, producto_id, nombre_producto, cantidad, precio_unitario, descuento, impuesto_tasa, monto, descuento_porcentaje) values
      (gen_random_uuid(), '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000b1', 'Cono doble', 2, 115, 0, 0.15, 230, 0),
      (gen_random_uuid(), '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000b1', 'Cono doble', 1, 115, 15, 0.15, 100, 25),
      (gen_random_uuid(), '00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000b2', 'Agua', 2, 25, 0, 0, 50, 0);`);
  await legado.query(`insert into venta_pagos (id, venta_id, forma_pago_id, monto) values
      (gen_random_uuid(), '00000000-0000-0000-0000-0000000000e1', $1, 230), (gen_random_uuid(), '00000000-0000-0000-0000-0000000000e2', $1, 50), (gen_random_uuid(), '00000000-0000-0000-0000-0000000000e2', $2, 50),
      (gen_random_uuid(), '00000000-0000-0000-0000-0000000000e3', $2, 50)`, [fp.Efectivo, fp.Tarjeta]);
  await legado.query(
    `insert into cierres_caja (id, sucursal_id, cajero_id, fecha_inicio, fecha_fin, efectivo_contado, fondo_caja, efectivo_sistema, tarjeta_sistema, total_ventas, cantidad_facturas, diferencia_efectivo, estado, factura_desde, factura_hasta)
     values ('00000000-0000-0000-0000-0000000000f1', $1, '00000000-0000-0000-0000-0000000000a2', '2026-09-01T14:00:00Z', '2026-09-01T23:00:00Z', 330, 200, 330, 50, 330, 2, 0, 'cerrado', '002-001-01-00000001', '002-001-01-00000002')`, [idsSuc.los_andes]);
  await legado.query(`insert into notas_credito (id, venta_id, numero_nota, motivo, monto) values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000e1', 'NC-1', 'Devolución', 115)`);
  await legado.query(`insert into auditoria (accion, entidad, entidad_id, detalle) values ('venta_cobrada', 'venta', 'x', '{"total": 230}'), ('cierre', 'cierre', 'y', '{}')`);
  await legado.query(`insert into caja_chica (sucursal_id, tipo, monto, concepto) values ($1, 'egreso', 20, 'Hielo')`, [idsSuc.los_andes]);
});
after(async () => { await t.cerrar(); });

const cuenta = async (sql, a = []) => Number((await t.db.query(sql, a)).rows[0].n);
const importar = (o = {}) => importarItaloFacturacion({ origen: legado, destino: t.db, ...o });

test('ensayo: informa lo que haría pero NO guarda nada', async () => {
  const r = await importar();
  assert.equal(r.modo, 'ENSAYO');
  assert.equal(r.tablas.ventas.nuevos, 4);          // 3 pagadas + 1 anulada (la abierta no se importa)
  assert.equal(r.tablas.productos.nuevos, 3);
  assert.equal(await cuenta(`select count(*) n from pos.ventas where origen_legado is not null`), 0);
  assert.equal(await cuenta(`select count(*) n from pos.productos`), 0);
});

test('aplicar: importa catálogo, clientes, ventas, pagos, cierres, notas y archiva la bitácora', async () => {
  const r = await importar({ aplicar: true });
  assert.equal(r.modo, 'APLICADO');
  assert.equal(await cuenta(`select count(*) n from pos.productos`), 3);
  assert.equal(await cuenta(`select count(*) n from pos.categorias where nombre in ('Helados','Bebidas')`), 2);
  assert.equal(await cuenta(`select count(*) n from pos.ventas where origen_legado = 'italo-facturacion'`), 4);
  assert.equal(await cuenta(`select count(*) n from pos.detalle_venta`), 3);
  assert.equal(await cuenta(`select count(*) n from pos.venta_pagos`), 4);
  assert.equal(await cuenta(`select count(*) n from pos.turnos where origen_legado is not null`), 1);
  assert.equal(await cuenta(`select count(*) n from pos.notas_credito`), 1);
  assert.equal(await cuenta(`select count(*) n from core.auditoria_legado`) >= 2, true);
  // la bitácora NUEVA no se contamina y sigue íntegra
  assert.equal((await t.db.query('select * from core.verificar_auditoria()')).rows[0].integra, true);
});

test('traducciones: tasas, tipo de orden, anulada, borrador, tercera edad, formas de pago, turno', async () => {
  const p = Object.fromEntries((await t.db.query('select nombre, impuesto_tasa, codigo_barras from pos.productos')).rows.map((x) => [x.nombre, x]));
  assert.equal(p['Cono doble'].impuesto_tasa, 0.15);
  assert.equal(p['Agua'].impuesto_tasa, 0);
  assert.equal(p['Cerveza'].impuesto_tasa, 0.18);
  assert.equal(p['Cono doble'].codigo_barras, '7501');
  const v = Object.fromEntries((await t.db.query('select numero_factura, tipo_orden, estado, es_borrador_fiscal, tercera_edad_nombre, descuento_porcentaje, estado_prep, turno_id, ticket_dia, cambio from pos.ventas')).rows.map((x) => [x.numero_factura, x]));
  assert.equal(v['002-001-01-00000002'].tipo_orden, 'llevar');
  assert.equal(v['002-001-01-00000002'].tercera_edad_nombre, 'Doña Marta');
  assert.equal(v['002-001-01-00000002'].descuento_porcentaje, 25);
  assert.equal(v['BORRADOR-002-001-01-00000009'].estado, 'anulada');
  assert.equal(v['BORRADOR-002-001-01-00000009'].es_borrador_fiscal, true);
  assert.equal(v['002-001-01-00000001'].es_borrador_fiscal, false);
  assert.equal(v['002-001-01-00000001'].cambio, 20);
  assert.equal(v['002-001-01-00000001'].estado_prep, 'entregado');
  assert.ok(v['002-001-01-00000001'].turno_id, 'la venta quedó enlazada a su cierre de caja');
  assert.equal(v['002-001-01-00000003'].turno_id, null, 'la venta de otro día no pertenece a ese cierre');
  assert.deepEqual([v['002-001-01-00000001'].ticket_dia, v['002-001-01-00000002'].ticket_dia, v['002-001-01-00000003'].ticket_dia], [1, 2, 1]);
  const pagos = (await t.db.query(`select f.tipo, sum(p.monto) m from pos.venta_pagos p join pos.formas_pago f on f.id = p.forma_pago_id group by f.tipo order by 1`)).rows;
  assert.deepEqual(pagos.map((x) => [x.tipo, x.m]), [['efectivo', 280], ['tarjeta', 100]]);
  const turno = (await t.db.query('select estado, efectivo_contado, fondo_inicial, factura_hasta from pos.turnos')).rows[0];
  assert.deepEqual([turno.estado, turno.efectivo_contado, turno.fondo_inicial, turno.factura_hasta], ['cerrado', 330, 200, '002-001-01-00000002']);
});

test('clientes: se une por RTN, RTN inválido se importa sin RTN y se avisa; consumidor final no se duplica', async () => {
  const hoteles = await cuenta(`select count(*) n from core.terceros where rtn = '05019999123456'`);
  assert.equal(hoteles, 1);
  assert.equal(await cuenta(`select count(*) n from core.terceros where es_consumidor_final`), 1);
  assert.equal(await cuenta(`select count(*) n from core.terceros where nombre = 'Juan Perez' and rtn is null`), 1);
  // la venta del hotel apunta a la ficha única
  const venta = (await t.db.query(`select c.nombre from pos.ventas v join core.terceros c on c.id = v.cliente_id where v.numero_factura = '002-001-01-00000001'`)).rows[0];
  assert.equal(venta.nombre, 'Hotel Palace');
});

test('usuarios: se crean con su rol y sucursal, sin contraseña ni PIN (hay que asignarlos)', async () => {
  const r = (await t.db.query(
    `select u.nombre, u.email, a.rol, a.sucursal_ids, a.pin_hash, u.password_hash from core.accesos a join core.usuarios u on u.id = a.usuario_id
      join core.empresas e on e.id = a.empresa_id where e.codigo = 'italo' order by u.nombre`)).rows;
  assert.deepEqual(r.map((x) => [x.nombre, x.rol]), [['Cajera Los Andes', 'cajero'], ['Gerente Mackey', 'gerente'], ['Juan Admin', 'admin']]);
  assert.equal(r[0].email, 'cajera.andes@viejo.hn');
  assert.equal(r[0].sucursal_ids.length, 1);
  assert.ok(r.every((x) => !x.pin_hash && !x.password_hash));
  const res = await importar({ aplicar: true });
  assert.equal(res.usuarios_sin_acceso, 3);
});

test('idempotente: una segunda corrida no duplica nada', async () => {
  const r = await importar({ aplicar: true });
  for (const [tabla, v] of Object.entries(r.tablas)) assert.equal(v.nuevos, 0, `${tabla} duplicó ${v.nuevos}`);
  assert.equal(await cuenta(`select count(*) n from pos.ventas where origen_legado is not null`), 4);
});

test('el CAI real NO se copia por defecto (se avisa); con fiscal:true se copia el correlativo vigente', async () => {
  const antes = (await t.db.query(`select pe.es_borrador, pe.cai from pos.puntos_emision pe join core.sucursales s on s.id = pe.sucursal_id join core.empresas e on e.id = pe.empresa_id where e.codigo = 'italo' and s.alias = 'los_andes'`)).rows[0];
  assert.equal(antes.es_borrador, true);
  assert.equal(antes.cai, null);
  const r1 = await importar({ aplicar: true });
  assert.ok(r1.avisos.some((a) => /CAI reales/.test(a)));
  await importar({ aplicar: true, fiscal: true });
  const pe = (await t.db.query(`select pe.* from pos.puntos_emision pe join core.sucursales s on s.id = pe.sucursal_id join core.empresas e on e.id = pe.empresa_id where e.codigo = 'italo' and s.alias = 'los_andes'`)).rows[0];
  assert.equal(pe.es_borrador, false);
  assert.equal(pe.cai, '2F4851-96A881-B76670-CE6CCE-48D250-32');
  assert.equal(pe.correlativo_actual, 4);
  assert.equal(pe.punto_emision_codigo, '002');
});

test('después del corte, la plataforma sigue la numeración fiscal y la secuencia de órdenes no choca', async () => {
  await t.usuario({ nombre: 'Dueño', email: 'dueno@x.hn', password: 'ClaveSegura123', dueno: true });
  const d = t.cli(await t.login('italo', 'dueno@x.hn', 'ClaveSegura123'), 'italo');
  const cat = (await d.get('/api/pos/catalogo')).body;
  const andes = cat.sucursales.find((s) => s.alias === 'los_andes');
  assert.equal(cat.productos.length, 3);
  assert.equal((await d.post('/api/pos/turno/abrir', { sucursal_id: andes.id })).status, 201);
  const cono = cat.productos.find((p) => p.nombre === 'Cono doble');
  const efectivo = cat.formas_pago.find((f) => f.tipo === 'efectivo').id;
  const v = await d.post('/api/pos/ventas', { sucursal_id: andes.id, items: [{ producto_id: cono.id, cantidad: 1 }], cobrar: { pagos: [{ forma_pago_id: efectivo, monto: 115 }] } });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  assert.equal(v.body.numero_factura, '002-001-01-00000004');       // continúa donde iba el sistema viejo
  assert.ok(v.body.numero_orden > 4);
  assert.equal(v.body.es_borrador_fiscal, false);
});
