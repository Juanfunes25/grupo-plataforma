import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from './helpers.js';
import { antiguedadDe, bucketAntiguedad, fechaHN, sumarDias, sumarPorBucket } from '@grupo/shared';
import { cuentasPorCobrar, cxcPorEmpresa, resumirCxc } from '../src/modulos/crm/cxc.js';

let t, eco, dis, cajaEco, hoy, docs = {};
before(async () => {
  t = await iniciar();
  await t.usuario({ nombre: 'Gerente Eco', email: 'g@eco.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'ecostone', rol: 'gerente' }, { empresa: 'diserco', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Cajero Eco', accesos: [{ empresa: 'ecostone', rol: 'cajero', pin: '4321' }] });
  await t.usuario({ nombre: 'Gerente Italo', email: 'g@italo.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'italo', rol: 'gerente' }] });
  const tk = await t.login('ecostone', 'g@eco.hn', 'ClaveSegura123');
  eco = t.cli(tk, 'ecostone'); dis = t.cli(await t.login('diserco', 'g@eco.hn', 'ClaveSegura123'), 'diserco');
  cajaEco = t.cli(await t.loginPin('ecostone', '4321'), 'ecostone');
  hoy = fechaHN();
  const eid = await t.empresaId('ecostone'), did = await t.empresaId('diserco');
  const cli = (await t.db.query(`insert into core.terceros (nombre, rtn) values ('Constructora Prueba SA', '08019000111222') returning id`)).rows[0].id;
  const forma = async (e) => (await t.db.query(`select id from pos.formas_pago where empresa_id = $1 and activo order by orden limit 1`, [e])).rows[0].id;
  const cotEco = async (num, dias, total, anticipoPct, pagado) => {
    const id = (await t.db.query(
      `insert into eco.cotizaciones (empresa_id, numero, estado, cliente_id, nombre_cliente, proyecto, total, anticipo_pct, aprobada_at)
       values ($1,$2,'aprobada',$3,'Constructora Prueba SA',$4,$5,$6, ($7::date + time '12:00') at time zone 'America/Tegucigalpa') returning id`, [eid, num, cli, `Obra ${num}`, total, anticipoPct, sumarDias(hoy, -dias)])).rows[0].id;
    if (pagado) await t.db.query(`insert into eco.cotizacion_pagos (cotizacion_id, tipo, forma_pago_id, monto) values ($1,'pago',$2,$3)`, [id, await forma(eid), pagado]);
    return id;
  };
  docs.e10 = await cotEco(9001, 10, 1000, 30, 0);       // sin cobro, anticipo 30% pendiente
  docs.e45 = await cotEco(9002, 45, 2000, 0, 500);      // parcial
  docs.e100 = await cotEco(9003, 100, 3000, 0, 0);      // +90
  docs.edone = await cotEco(9004, 5, 800, 0, 800);      // pagada completa: no aparece
  docs.dis = (await t.db.query(
    `insert into dis.cotizaciones (empresa_id, tipo, numero, anio, codigo, estado, cliente_id, nombre_cliente, proyecto, total, aprobada_at)
     values ($1,'proyecto',1,2026,'DIS-2026-0001','aprobada',$2,'Constructora Prueba SA','Torre', 5000, ($3::date + time '12:00') at time zone 'America/Tegucigalpa') returning id`, [did, cli, sumarDias(hoy, -65)])).rows[0].id;
  docs.cli = cli;
});
after(() => t.cerrar());

test('reglas puras de antigüedad', () => {
  assert.deepEqual(['0','30','31','60','61','90','91','400'].map((d) => bucketAntiguedad(+d)), ['0-30', '0-30', '31-60', '31-60', '61-90', '61-90', '+90', '+90']);
  assert.equal(bucketAntiguedad(-5), '0-30');
  const a = antiguedadDe({ fecha_documento: '2026-01-01' }, '2026-03-05');
  assert.equal(a.dias_atraso, 63); assert.equal(a.bucket, '61-90'); assert.ok(a.vencido);
  assert.deepEqual(sumarPorBucket([{ saldo: 10, bucket: '0-30' }, { saldo: 5.5, bucket: '+90' }]), { '0-30': 10, '31-60': 0, '61-90': 0, '+90': 5.5, total: 15.5 });
});

test('crm.cxc: solo aprobadas con saldo, y la función de la base coincide con la regla compartida', async () => {
  const filas = await cuentasPorCobrar(t.db, { hoy });
  assert.equal(filas.length, 4);
  assert.ok(!filas.some((f) => f.documento_id === docs.edone));
  for (const f of filas) assert.equal(f.bucket, antiguedadDe({ fecha_documento: String(f.fecha_documento).slice(0, 10) }, hoy).bucket);
  const e45 = filas.find((f) => f.documento_id === docs.e45);
  assert.equal(e45.saldo, 1500); assert.equal(e45.bucket, '31-60'); assert.equal(e45.dias_atraso, 45);
  assert.equal(filas.find((f) => f.documento_id === docs.e10).anticipo_pendiente, 300);
  // una fecha futura mueve de cubeta
  const futuro = await cuentasPorCobrar(t.db, { hoy: sumarDias(hoy, 30) });
  assert.equal(futuro.find((f) => f.documento_id === docs.e10).bucket, '31-60');
  const r = resumirCxc(filas.filter((f) => f.origen === 'eco'));
  assert.equal(r.total, 5500); assert.equal(r.buckets['+90'], 3000);
  const por = await cxcPorEmpresa(t.db, { hoy });
  assert.equal(por.length, 2);
  assert.equal((await t.db.query('select count(*)::int n from crm.v_cxc')).rows[0].n, 4);
});

test('permisos y módulo: el cajero no entra; Italo no usa cobranza', async () => {
  assert.equal((await cajaEco.get('/api/crm/cobranza/tablero')).status, 403);
  const italo = t.cli(await t.login('italo', 'g@italo.hn', 'ClaveSegura123'), 'italo');
  assert.equal((await italo.get('/api/crm/cobranza/tablero')).status, 403);
  assert.ok((await eco.get('/api/crm/cobranza/tablero')).body.fecha);
});

test('tablero: antigüedad, sin cobro, anticipos, y DISERCO queda aparte', async () => {
  const b = (await eco.get('/api/crm/cobranza/tablero')).body;
  assert.equal(b.resumen.total, 5500); assert.equal(b.resumen.documentos, 3);
  assert.deepEqual([b.resumen.buckets['0-30'], b.resumen.buckets['31-60'], b.resumen.buckets['61-90'], b.resumen.buckets['+90']], [1000, 1500, 0, 3000]);
  assert.equal(b.resumen.sin_cobro.n, 2); assert.equal(b.resumen.anticipos_pendientes.n, 1); assert.equal(b.resumen.anticipos_pendientes.monto, 300);
  assert.equal(b.clientes.length, 1); assert.equal(b.clientes[0].total, 5500);
  const d = (await dis.get('/api/crm/cobranza/tablero')).body;
  assert.equal(d.resumen.total, 5000); assert.equal(d.documentos[0].bucket, '61-90');
});

test('gestiones y promesas de pago con recordatorio; la promesa se cierra sola al pagar', async () => {
  const mala = await eco.post('/api/crm/cobranza/gestiones', { origen: 'eco', documento_id: docs.e45, tipo: 'llamada' });
  assert.equal(mala.status, 400);
  const manana = sumarDias(hoy, 1);
  const g = await eco.post('/api/crm/cobranza/gestiones', { origen: 'eco', documento_id: docs.e45, tipo: 'llamada', resultado: 'Dice que paga mañana', proxima_fecha: manana });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  assert.equal((await eco.post('/api/crm/cobranza/gestiones', { origen: 'eco', documento_id: docs.e45, tipo: 'llamada', nota: 'x', proxima_fecha: '2020-01-01' })).status, 400);
  assert.equal((await eco.post('/api/crm/cobranza/gestiones', { origen: 'eco', documento_id: docs.edone, tipo: 'nota', nota: 'x' })).status, 409);
  assert.equal((await eco.post('/api/crm/cobranza/promesas', { origen: 'eco', documento_id: docs.e45, monto: 99999, fecha_promesa: manana })).status, 400);
  const p = await eco.post('/api/crm/cobranza/promesas', { origen: 'eco', documento_id: docs.e45, monto: 1000, fecha_promesa: manana, nota: 'cheque' });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  assert.equal(p.body.responsable_nombre, 'Gerente Eco');
  const rec = (await eco.get('/api/crm/cobranza/recordatorios')).body;
  assert.equal(rec.length, 2); assert.ok(rec.some((x) => x.tipo === 'promesa' && x.fecha === manana));
  const det = (await eco.get(`/api/crm/cobranza/documento/eco/${docs.e45}`)).body;
  assert.equal(det.gestiones.length, 1); assert.equal(det.pagos.length, 1); assert.equal(det.promesas[0].estado, 'pendiente');
  // el cliente paga lo prometido → cumplida y su recordatorio queda hecho
  await t.db.query(`insert into eco.cotizacion_pagos (cotizacion_id, tipo, forma_pago_id, monto) values ($1,'pago',(select id from pos.formas_pago where empresa_id = (select empresa_id from eco.cotizaciones where id = $1) limit 1),1000)`, [docs.e45]);
  const lista = (await eco.get('/api/crm/cobranza/promesas')).body;
  assert.equal(lista[0].estado, 'cumplida');
  assert.equal((await eco.get('/api/crm/cobranza/recordatorios')).body.length, 1);
  // promesa vencida sin pago → incumplida
  const p2 = (await t.db.query(`insert into crm.promesas (empresa_id, tercero_id, nombre_cliente, origen, documento_id, documento, monto, fecha_promesa) select empresa_id, cliente_id, nombre_cliente, 'eco', id, 'COT-9003', 100, $2 from eco.cotizaciones where id = $1 returning id`, [docs.e100, sumarDias(hoy, -2)])).rows[0].id;
  await eco.get('/api/crm/cobranza/promesas');
  assert.equal((await t.db.query('select estado from crm.promesas where id = $1', [p2])).rows[0].estado, 'incumplida');
  assert.equal((await eco.put(`/api/crm/cobranza/promesas/${p2}/estado`, { estado: 'cancelada' })).status, 200);
});

test('bitácora de gestiones y estado de cuenta imprimible', async () => {
  const a = await t.db.query(`select count(*)::int n from core.auditoria where accion in ('cobranza_gestion','cobranza_promesa')`);
  assert.equal(a.rows[0].n, 2);
  const r = await eco.get(`/api/crm/cobranza/estado-cuenta/${docs.cli}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.resumen.saldo, 4500);
  assert.equal(r.body.documentos.length, 4);   // incluye la pagada completa del período (aprobada, sin facturar aún)
  assert.match(r.body.html, /Estado de cuenta/); assert.match(r.body.html, /Constructora Prueba SA/);
  const h = await fetch(`${t.base}/api/crm/cobranza/estado-cuenta/${docs.cli}?formato=html`, { headers: { authorization: `Bearer ${await t.login('ecostone', 'g@eco.hn', 'ClaveSegura123')}`, 'x-empresa': 'ecostone' } });
  assert.match(h.headers.get('content-type'), /html/);
  assert.ok((await h.text()).includes('Antigüedad del saldo'));
  assert.equal((await cajaEco.get(`/api/crm/cobranza/estado-cuenta/${docs.cli}`)).status, 403);
  // el nombre con HTML no se cuela
  await t.db.query(`update core.terceros set nombre = '<script>x</script>' where id = $1`, [docs.cli]);
  assert.ok(!(await eco.get(`/api/crm/cobranza/estado-cuenta/${docs.cli}`)).body.html.includes('<script>x'));
});
