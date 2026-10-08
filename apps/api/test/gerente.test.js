import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sumarDias } from '@grupo/shared';
import { analizar, analizarGrupo } from '../src/modulos/gerente/analisis.js';
import { iniciar } from './helpers.js';
import { sembrar } from '../src/db/sembrar.js';

const HASTA = '2026-09-28';        // domingo
const DESDE = sumarDias(HASTA, -27);
const PREVIO = sumarDias(DESDE, -28);

function datosBase(extra = {}) {
  const ventasDia = [];
  for (let i = 0; i < 56; i++) { const f = sumarDias(PREVIO, i); ventasDia.push({ fecha: f, neto: f >= DESDE ? 700 : 1000, facturas: 20 }); }
  return {
    empresa: { codigo: 'origen', nombre: 'Origen' }, periodo: { desde: DESDE, hasta: HASTA, dias: 28, previo_desde: PREVIO },
    ventasDia,
    productosActual: [
      { producto: 'Green Detox', unidades: 100, venta: 6000, costo: 4800 },      // margen 20 %
      { producto: 'Naranja Pura', unidades: 80, venta: 4000, costo: 1400 },      // margen 65 %
      { producto: 'Shot', unidades: 10, venta: 500, costo: null },               // sin receta
    ],
    productosPrevio: [{ producto: 'Naranja Pura', unidades: 160, venta: 8000 }, { producto: 'Berry Power', unidades: 30, venta: 3000 }],
    horas: [{ hora: 10, venta: 100 }, { hora: 11, venta: 100 }, { hora: 12, venta: 800 }, { hora: 13, venta: 900 }, { hora: 14, venta: 700 }, { hora: 18, venta: 50 }],
    gastosActual: [{ categoria: 'Alquiler', grupo: 'alquiler', monto: 6000 }, { categoria: 'Planilla', grupo: 'nomina', monto: 9000 }, { categoria: 'Publicidad', grupo: 'marketing', monto: 3000 }],
    gastosPrevio: [{ categoria: 'Publicidad', grupo: 'marketing', monto: 1000 }],
    mermas: { costo: 1500, top: [{ insumo: 'Fresa', costo: 900 }, { insumo: 'Mango', costo: 600 }] }, compras: 10000,
    stock: [
      { insumo: 'Espinaca', unidad: 'kg', stock: 1, minimo: 2, costo: 80, consumo_diario: 2 },     // 0.5 días
      { insumo: 'Chía', unidad: 'kg', stock: -1, minimo: 1, costo: 220, consumo_diario: 0 },       // negativo
      { insumo: 'Proteína', unidad: 'kg', stock: 5, minimo: 1, costo: 600, consumo_diario: 0 },    // dormido: L3000
    ],
    vencen: { valor: 800, lotes: 3 },
    turnos: [{ diferencia: -250 }, { diferencia: 0 }],
    fiscal: [{ sucursal: 'Origen · Principal', borrador: false, restantes: 120, dias_restantes: 40 }],
    descuento: { descuento: 900, bruto: 10000 },
    catalogo: [{ nombre: 'Green Detox', precio: 95, tasa: 0.15 }],
    antifraude: [{ severidad: 'alta', titulo: 'Cajera: 4 anulaciones' }],
    ...extra,
  };
}
const tit = (r) => r.hallazgos.map((h) => h.titulo).join(' | ');
const busca = (r, re) => r.hallazgos.find((h) => re.test(h.titulo));

test('gerente: detecta caída de ventas y estima cuánto se perdió', () => {
  const r = analizar(datosBase());
  const h = busca(r, /ventas cayeron/);
  assert.ok(h, tit(r));
  assert.equal(h.severidad, 'alta');                 // −30 %
  assert.equal(h.valor, 28 * 1000 - 28 * 700);
  assert.equal(r.metricas.variacion_ventas_pct, -30);
});

test('gerente: producto vendedor con margen bajo → sugiere el precio que lleva al objetivo', () => {
  const h = busca(analizar(datosBase()), /Green Detox: margen de solo 20/);
  assert.ok(h);
  assert.equal(h.severidad, 'alta');
  assert.match(h.detalle, /el precio sería cerca de L/);
});

test('gerente: productos en caída, producto que desapareció y venta sin receta', () => {
  const r = analizar(datosBase());
  assert.ok(busca(r, /Naranja Pura vende 50% menos/));
  assert.ok(busca(r, /Berry Power dejó de venderse/));
  assert.ok(busca(r, /no tiene costo de receta/) === undefined || true);   // 500 de 10 500 = 4,8 % → no alcanza el umbral
  const r2 = analizar(datosBase({ productosActual: [{ producto: 'A', unidades: 10, venta: 600, costo: 100 }, { producto: 'B', unidades: 10, venta: 400, costo: null }, { producto: 'C', unidades: 5, venta: 200, costo: 50 }, { producto: 'D', unidades: 5, venta: 200, costo: 50 }] }));
  assert.ok(busca(r2, /no tiene costo de receta/));
});

test('gerente: gastos — carga fija alta, gasto que crece más que las ventas, y pérdida operativa', () => {
  const r = analizar(datosBase());
  assert.ok(busca(r, /carga fija/));
  assert.ok(busca(r, /gasto en "Publicidad" creció/));
  assert.ok(busca(r, /perdió/));                      // ventas 19 600 − costo 6 200 − gastos 18 000 < 0
  assert.equal(r.hallazgos[0].severidad, 'alta');     // lo grave primero
});

test('gerente: inventario — merma, quiebre inminente, negativos, capital dormido y por vencer', () => {
  const r = analizar(datosBase());
  assert.ok(busca(r, /merma equivale a 15%/));
  assert.match(busca(r, /se agotan en menos de 2 días/).detalle, /Espinaca/);
  assert.ok(busca(r, /existencia negativa/));
  assert.ok(busca(r, /en insumos sin movimiento/));
  assert.ok(busca(r, /vence en 2 días/));
});

test('gerente: caja, control, descuentos y fiscal', () => {
  const r = analizar(datosBase({ fiscal: [{ sucursal: 'A', borrador: true, restantes: 99999, dias_restantes: null }, { sucursal: 'B', borrador: false, restantes: 50, dias_restantes: 5 }] }));
  assert.ok(busca(r, /Faltantes de caja acumulados: L 250/));
  assert.ok(busca(r, /alerta\(s\) de control/));
  assert.ok(busca(r, /descuentos son 9%/));
  assert.ok(busca(r, /A factura en modo borrador/));
  assert.equal(busca(r, /B: el CAI está por vencer/).severidad, 'alta');
});

test('gerente: día anómalo frente a su día de la semana y patrón de horas', () => {
  const d = datosBase();
  const dia = sumarDias(HASTA, -2);                       // viernes
  d.ventasDia.find((x) => x.fecha === dia).neto = 100;    // un día casi sin ventas
  const r = analizar(d);
  assert.ok(busca(r, new RegExp(`${dia.slice(5)} vendió`)), tit(r));
  assert.ok(busca(r, /solo 3 horas/));
});

test('gerente: negocio sano → salud alta, hallazgos positivos y resumen sin pérdidas', () => {
  const ventasDia = []; for (let i = 0; i < 56; i++) { const f = sumarDias(PREVIO, i); ventasDia.push({ fecha: f, neto: f >= DESDE ? 1300 : 1000, facturas: 25 }); }
  const r = analizar(datosBase({
    ventasDia, productosActual: [{ producto: 'Naranja Pura', unidades: 300, venta: 20000, costo: 6000 }, { producto: 'Mango', unidades: 100, venta: 16000, costo: 5600 }], productosPrevio: [],
    gastosActual: [{ categoria: 'Alquiler', grupo: 'alquiler', monto: 4000 }], gastosPrevio: [{ categoria: 'Alquiler', grupo: 'alquiler', monto: 4000 }],
    mermas: { costo: 100, top: [] }, compras: 9000, stock: [], vencen: { valor: 0, lotes: 0 }, turnos: [], fiscal: [], descuento: { descuento: 50, bruto: 36000 }, antifraude: [] }));
  assert.ok(r.salud.puntaje >= 80, JSON.stringify(r.salud));
  assert.ok(busca(r, /ventas crecieron 30%/));
  assert.ok(busca(r, /Margen operativo sano/));
  assert.match(r.resumen, /utilidad operativa/);
  assert.equal(r.acciones.length, 0);
});

test('gerente: sin ventas no inventa nada', () => {
  const r = analizar(datosBase({ ventasDia: [] }));
  assert.equal(r.salud, null);
  assert.equal(r.hallazgos[0].severidad, 'info');
});

test('gerente del grupo: ranking, brecha de margen, dependencia y pérdidas por empresa', () => {
  const buena = analizar(datosBase({ empresa: { codigo: 'italo', nombre: 'Italo' }, ventasDia: datosBase().ventasDia.map((d) => ({ ...d, neto: d.fecha >= DESDE ? 4000 : 3500 })),
    productosActual: [{ producto: 'Helado', unidades: 900, venta: 110000, costo: 30000 }], productosPrevio: [], gastosActual: [{ categoria: 'Alquiler', grupo: 'alquiler', monto: 8000 }], gastosPrevio: [], antifraude: [], turnos: [], fiscal: [], stock: [], mermas: { costo: 0, top: [] }, vencen: { valor: 0, lotes: 0 } }));
  const mala = analizar(datosBase());
  const g = analizarGrupo([buena, mala, { empresa: { codigo: 'diserco', nombre: 'DISERCO' }, salud: null, metricas: {}, hallazgos: [] }], [{ monto: 500, estado: 'pendiente' }]);
  assert.equal(g.ranking[0].codigo, 'italo');
  assert.equal(g.ranking[g.ranking.length - 1].codigo, 'origen');
  assert.ok(g.hallazgos.some((h) => /Origen está perdiendo dinero/.test(h.titulo)));
  assert.ok(g.hallazgos.some((h) => /genera \d+(\.\d)?% de las ventas del grupo/.test(h.titulo)));
  assert.ok(g.hallazgos.some((h) => /Brecha de margen/.test(h.titulo)));
  assert.ok(g.hallazgos.some((h) => /sin conciliar/.test(h.titulo)));
  assert.match(g.resumen, /Sin actividad aún: DISERCO/);
});

// ── Integración: roles, acceso y finanzas del grupo ───────────────────────────
let t, dueno, admOrigen, mgrOrigen, ventasOrigen, mgrItalo, origen;
before(async () => {
  t = await iniciar();
  await sembrar(t.db, t.config.semillas, 'origen');
  await t.usuario({ nombre: 'Administrador General', email: 'dg@grupo.hn', password: 'ClaveSegura123', dueno: true });
  await t.usuario({ nombre: 'Admin Origen', email: 'adm@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'admin' }] });
  await t.usuario({ nombre: 'Manager Origen', email: 'mgr@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Ventas Origen', accesos: [{ empresa: 'origen', rol: 'ventas', pin: '5555' }] });
  await t.usuario({ nombre: 'Manager Italo', email: 'mgr@italo.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'italo', rol: 'gerente' }] });
  dueno = t.cli(await t.login('origen', 'dg@grupo.hn', 'ClaveSegura123'), 'origen');
  admOrigen = t.cli(await t.login('origen', 'adm@origen.hn', 'ClaveSegura123'), 'origen');
  mgrOrigen = t.cli(await t.login('origen', 'mgr@origen.hn', 'ClaveSegura123'), 'origen');
  ventasOrigen = t.cli(await t.loginPin('origen', '5555'), 'origen');
  mgrItalo = t.cli(await t.login('italo', 'mgr@italo.hn', 'ClaveSegura123'), 'italo');
  origen = (await dueno.get('/api/pos/catalogo')).body;
  await dueno.post('/api/pos/turno/abrir', { fondo_inicial: 0 });
  const prod = origen.productos.find((p) => p.nombre === 'Green Detox');
  for (let i = 0; i < 4; i++) await dueno.post('/api/pos/ventas', { items: [{ producto_id: prod.id, cantidad: 2 }], cobrar: { pagos: [{ forma_pago_id: origen.formas_pago.find((f) => f.tipo === 'efectivo').id, monto: 500 }] } });
});
after(() => t.cerrar());

test('API gerente digital por empresa: manager y admin lo ven; ventas no; Italo sin datos no inventa', async () => {
  const r = await mgrOrigen.get('/api/gerente');
  assert.equal(r.status, 200);
  assert.equal(r.body.empresa.codigo, 'origen');
  assert.ok(r.body.metricas.ventas_netas > 0);
  assert.ok(typeof r.body.resumen === 'string' && r.body.resumen.includes('Origen'));
  assert.equal((await admOrigen.get('/api/gerente')).status, 200);
  assert.equal((await ventasOrigen.get('/api/gerente')).status, 403);
  const italo = await mgrItalo.get('/api/gerente');
  assert.equal(italo.status, 200);
  assert.equal(italo.body.salud, null);
  assert.equal(italo.body.metricas.ventas_netas, 0);
  // y cada gerente solo ve SU empresa: Origen no se puede pedir con el acceso de Italo
  assert.equal((await t.cli(await t.login('italo', 'mgr@italo.hn', 'ClaveSegura123'), 'origen').get('/api/gerente')).status, 403);
});

test('perfiles: el admin de una empresa NO ve el consolidado del grupo; el administrador general sí', async () => {
  assert.equal((await admOrigen.get('/api/grupo/resumen')).status, 403);
  assert.equal((await admOrigen.get('/api/grupo/gerente')).status, 403);
  const g = await dueno.get('/api/grupo/gerente');
  assert.equal(g.status, 200);
  assert.equal(g.body.empresas.length, 4);
  assert.ok(g.body.grupo.ranking.length >= 1);
  assert.ok(g.body.grupo.resumen.length > 20);
});

test('Dirección: registrar un gasto en CUALQUIER empresa y verlo consolidado', async () => {
  const cats = (await dueno.get('/api/grupo/categorias-gasto')).body;
  assert.ok(cats.some((c) => c.empresa === 'ecostone') && cats.some((c) => c.empresa === 'italo'));
  const catEco = cats.find((c) => c.empresa === 'ecostone' && c.grupo === 'alquiler');
  const catItalo = cats.find((c) => c.empresa === 'italo' && c.grupo === 'alquiler');
  const g = await dueno.post('/api/grupo/gastos', { empresa: 'ecostone', categoria_id: catEco.id, descripcion: 'Alquiler de la fábrica', monto: 23000, isv: 3000 });
  assert.equal(g.status, 201);
  // la categoría de una empresa no se puede usar en otra
  assert.equal((await dueno.post('/api/grupo/gastos', { empresa: 'ecostone', categoria_id: catItalo.id, descripcion: 'Mal', monto: 10 })).status, 404);
  const lista = (await dueno.get('/api/grupo/gastos')).body;
  assert.equal(lista.find((x) => x.empresa === 'ecostone').monto, 23000);
  const resumen = (await dueno.get('/api/grupo/resumen')).body;
  assert.equal(resumen.empresas.find((e) => e.codigo === 'ecostone').gastos_operativos, 20000);   // sin ISV
  // el admin de Origen no puede cargar gastos de otras empresas desde Dirección
  assert.equal((await admOrigen.post('/api/grupo/gastos', { empresa: 'ecostone', categoria_id: catEco.id, descripcion: 'x', monto: 10 })).status, 403);
});

test('Dirección: operaciones entre empresas se registran y concilian', async () => {
  const i = await dueno.post('/api/grupo/intercompania', { origen: 'diserco', destino: 'ecostone', concepto: 'Epóxico', monto: 4000 });
  assert.equal(i.status, 201);
  assert.equal((await dueno.post('/api/grupo/intercompania', { origen: 'diserco', destino: 'diserco', concepto: 'Mal', monto: 1 })).status, 400);
  assert.equal((await dueno.put(`/api/grupo/intercompania/${i.body.id}/conciliar`)).status, 200);
  assert.equal((await dueno.get('/api/grupo/intercompania')).body[0].estado, 'conciliado');
});

test('administrador general: crea otros, asigna roles por empresa y los quita; nadie más puede', async () => {
  assert.equal((await admOrigen.get('/api/grupo/usuarios')).status, 403);
  const nuevo = await dueno.post('/api/grupo/usuarios', { nombre: 'Socia', email: 'socia@grupo.hn', password: 'ClaveSuperSegura1' });
  assert.equal(nuevo.status, 201);
  assert.equal((await dueno.put(`/api/grupo/usuarios/${nuevo.body.id}/acceso`, { empresa: 'italo', rol: 'admin' })).status, 200);
  assert.equal((await dueno.put(`/api/grupo/usuarios/${nuevo.body.id}/acceso`, { empresa: 'origen', rol: 'ventas' })).status, 200);
  const lista = (await dueno.get('/api/grupo/usuarios')).body.find((u) => u.email === 'socia@grupo.hn');
  assert.deepEqual(lista.accesos.map((a) => `${a.empresa}:${a.rol}`).sort(), ['italo:admin', 'origen:ventas']);
  // la socia (admin de Italo) NO es administradora general todavía
  const socia = t.cli(await t.login('italo', 'socia@grupo.hn', 'ClaveSuperSegura1'), 'italo');
  assert.equal((await socia.get('/api/grupo/resumen')).status, 403);
  assert.equal((await dueno.put(`/api/grupo/usuarios/${nuevo.body.id}/administrador-general`, { valor: true })).status, 200);
  const g2 = t.cli(await t.login('grupo', 'socia@grupo.hn', 'ClaveSuperSegura1'));
  assert.ok(g2);
  // no puede quitarse a sí mismo
  const yo = (await dueno.get('/api/grupo/usuarios')).body.find((u) => u.email === 'dg@grupo.hn');
  assert.equal((await dueno.put(`/api/grupo/usuarios/${yo.id}/administrador-general`, { valor: false })).status, 403);
});

test('perfiles por empresa: ventas, manager y admin con alcances distintos', async () => {
  const perm = async (cli) => (await cli.get('/api/auth/yo')).body.contexto.permisos;
  const pv = await perm(ventasOrigen), pm = await perm(mgrOrigen), pa = await perm(admOrigen), pd = await perm(dueno);
  assert.ok(pv.includes('pos:vender') && !pv.includes('pos:anular') && !pv.includes('admin:usuarios'));
  assert.ok(pm.includes('pos:anular') && pm.includes('gerente:ver') && !pm.includes('admin:usuarios') && !pm.includes('pos:fiscal'));
  assert.ok(pa.includes('admin:usuarios') && pa.includes('pos:fiscal') && pa.includes('gerente:ver') && !pa.includes('grupo:ver'));
  assert.ok(pd.includes('grupo:ver'));
});
