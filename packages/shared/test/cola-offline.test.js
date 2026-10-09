import test from 'node:test';
import assert from 'node:assert/strict';
import { crearCola, almacenEnMemoria, EST_PENDIENTE, EST_REVISAR, formatearTicketProvisional, formatearTicket, formatearCierreTurno, calcularTotales, LEYENDA_BORRADOR } from '../src/index.js';

const venta = (n = 1) => ({ sucursal_id: 's1', items: [{ producto_id: 'p', cantidad: n }], cobrar: { pagos: [{ forma_pago_id: 'f', monto: 100 }] }, offline: { numero_provisional: `OFF-0001-000${n}` } });
const errorDe = (status, mensaje = 'x', codigo) => Object.assign(new Error(mensaje), { status, codigo });

/** «Servidor» de mentira que se comporta como el real: idempotente por id_cliente y con correlativo propio. */
function servidor() {
  const guardadas = new Map(); let correlativo = 0; let llamadas = 0; let caido = false;
  return {
    guardadas, get llamadas() { return llamadas; }, set caido(v) { caido = v; },
    async enviar(payload) {
      llamadas++;
      if (caido) throw errorDe(0, 'Sin conexión');
      if (guardadas.has(payload.id_cliente)) return { ...guardadas.get(payload.id_cliente), duplicado: true };
      const v = { id: `v${guardadas.size + 1}`, numero_factura: `001-001-01-${String(++correlativo).padStart(8, '0')}` };
      guardadas.set(payload.id_cliente, v);
      return v;
    },
  };
}

test('cola offline: encolar la misma venta dos veces no la duplica', async () => {
  const cola = crearCola({ almacen: almacenEnMemoria(), enviar: async () => ({}) });
  const a = await cola.encolar({ ...venta(), id_cliente: '11111111-1111-4111-8111-111111111111' });
  const b = await cola.encolar({ ...venta(), id_cliente: '11111111-1111-4111-8111-111111111111' });
  assert.equal(a.id, b.id);
  assert.equal((await cola.resumen()).pendientes, 1);
});

test('cola offline: sin red se queda todo; al volver la señal sale en orden y SIN duplicar aunque se sincronice dos veces', async () => {
  const srv = servidor(); srv.caido = true;
  const cola = crearCola({ almacen: almacenEnMemoria(), enviar: (p) => srv.enviar(p) });
  for (let i = 1; i <= 3; i++) await cola.encolar(venta(i));
  const r1 = await cola.sincronizar();
  assert.equal(r1.detenida, 'red');
  assert.equal(r1.pendientes, 3);
  assert.equal(srv.llamadas, 1, 'al primer fallo de red se detiene: no golpea tres veces');
  assert.equal(srv.guardadas.size, 0);

  srv.caido = false;
  // dos disparadores a la vez (evento «online» + temporizador): comparten el mismo trabajo
  const [a, b] = await Promise.all([cola.sincronizar(), cola.sincronizar()]);
  assert.strictEqual(a, b);
  assert.equal(a.enviadas.length, 3);
  assert.deepEqual(a.enviadas.map((e) => e.respuesta.numero_factura), ['001-001-01-00000001', '001-001-01-00000002', '001-001-01-00000003']);
  assert.equal((await cola.resumen()).total, 0);
  assert.equal(srv.guardadas.size, 3);
  const otra = await cola.sincronizar();
  assert.equal(otra.enviadas.length, 0);
  assert.equal(srv.guardadas.size, 3, 'sincronizar de nuevo no crea facturas');
});

test('cola offline: respuesta perdida (el servidor la guardó pero la caja no lo supo) → el reintento recibe la MISMA factura', async () => {
  const srv = servidor();
  let perder = true;
  const enviar = async (p) => { const r = await srv.enviar(p); if (perder) { perder = false; throw errorDe(0, 'Se cortó la respuesta'); } return r; };
  const cola = crearCola({ almacen: almacenEnMemoria(), enviar });
  await cola.encolar(venta(1));
  const r1 = await cola.sincronizar();
  assert.equal(r1.pendientes, 1);
  assert.equal(srv.guardadas.size, 1, 'el servidor sí la había guardado');
  const r2 = await cola.sincronizar();
  assert.equal(r2.enviadas.length, 1);
  assert.equal(r2.enviadas[0].respuesta.duplicado, true);
  assert.equal(srv.guardadas.size, 1, 'sigue habiendo UNA sola factura');
  assert.equal(r2.pendientes, 0);
});

test('cola offline: un rechazo definitivo queda en «revisar», no se pierde y no frena a las demás', async () => {
  const srv = servidor();
  const enviar = async (p) => { if (p.items[0].cantidad === 2) throw errorDe(409, 'El precio cambió', 'precio_cambio'); return srv.enviar(p); };
  const cola = crearCola({ almacen: almacenEnMemoria(), enviar });
  for (let i = 1; i <= 3; i++) await cola.encolar(venta(i));
  const r = await cola.sincronizar();
  assert.equal(r.enviadas.length, 2);
  assert.equal(r.revisar, 1);
  const lista = await cola.lista();
  assert.equal(lista.length, 1);
  assert.equal(lista[0].estado, EST_REVISAR);
  assert.match(lista[0].ultimoError, /precio/);
  // una venta en revisión no se reenvía sola...
  const r2 = await cola.sincronizar();
  assert.equal(r2.enviadas.length, 0);
  // ...hasta que un encargado la reintenta
  await cola.reintentar(lista[0].id);
  assert.equal((await cola.lista())[0].estado, EST_PENDIENTE);
  const descartada = await cola.descartar(lista[0].id);
  assert.equal(descartada.payload.items[0].cantidad, 2);
  assert.equal((await cola.resumen()).total, 0);
});

test('cola offline: sesión vencida detiene la fila sin marcar nada como rechazado', async () => {
  const cola = crearCola({ almacen: almacenEnMemoria(), enviar: async () => { throw errorDe(401, 'Sesión no válida'); } });
  await cola.encolar(venta(1));
  const r = await cola.sincronizar();
  assert.equal(r.detenida, 'sesion');
  assert.equal(r.revisar, 0);
  assert.equal(r.pendientes, 1);
});

test('cola offline: una venta que quedó «enviando» (pestaña cerrada a medias) se recupera y se reenvía', async () => {
  const almacen = almacenEnMemoria();
  const srv = servidor();
  const cola = crearCola({ almacen, enviar: (p) => srv.enviar(p) });
  const it = await cola.encolar(venta(1));
  await almacen.poner({ ...it, estado: 'enviando' });
  const r = await cola.sincronizar();
  assert.equal(r.enviadas.length, 1);
});

test('numeración provisional: correlativa por equipo, sin repetir ni con llamadas simultáneas', async () => {
  const cola = crearCola({ almacen: almacenEnMemoria(), enviar: async () => ({}) });
  const nums = await Promise.all(Array.from({ length: 20 }, () => cola.siguienteNumero('a1b2c3d4')));
  assert.equal(new Set(nums).size, 20);
  assert.equal(nums[0], 'OFF-C3D4-0001');
  assert.equal(nums[19], 'OFF-C3D4-0020');
});

const empresa = { codigo: 'italo', nombre: 'Italo', razon_social: 'Inversiones Milano S de R.L.', rtn: '08019999999999', telefono: '2550-0000', direccion: 'Col. Prado Alto' };
const sucursal = { nombre: 'Inversiones Milano - 10 Calle', direccion: '10 Calle, San Pedro Sula' };

test('comprobante provisional: dice que NO es factura, trae el número OFF- y cabe en 58 y 80 mm', () => {
  const tot = calcularTotales([{ producto_id: 'p', nombre_producto: 'Cono doble', cantidad: 2, precio_base: 80, impuesto_tasa: 0.15 }], null, 0);
  for (const ancho of [32, 42, 48]) {
    const t = formatearTicketProvisional({ empresa, sucursal, cajero: 'Ana', numero: 'OFF-A1B2-0007', fecha: new Date('2026-10-09T15:00:00Z'), lineas: [{ nombre: 'Cono doble', cantidad: 2 }], totales: tot, recibido: 200, cambio: 40, borrador: true }, ancho);
    const txt = t.join(' ').replace(/\s+/g, ' ');
    assert.match(txt, /COMPROBANTE PROVISIONAL/);
    assert.match(txt, /NO ES FACTURA/);
    assert.match(txt, /OFF-A1B2-0007/);
    assert.match(txt, /BORRADOR - SIN VALOR FISCAL|BORRADOR/);
    assert.ok(t.every((r) => r.length <= ancho), `ningún renglón pasa de ${ancho} columnas`);
  }
});

test('factura en borrador: leyenda BORRADOR - SIN VALOR FISCAL arriba y abajo; con CAI real ya no sale', () => {
  const base = { empresa, sucursal, lineas: [{ cantidad: 1, nombre_producto: 'Cono', precio_base: 50, descuento: 0, opciones: [] }], pagos: [{ forma: 'Efectivo', monto: 57.5 }], punto: null, cliente: null, cajero: { nombre: 'Ana' } };
  const venta = { estado: 'pagada', numero_factura: 'BORRADOR-001-001-01-00000001', created_at: '2026-10-09T15:00:00Z', ticket_dia: 3, subtotal_exento: 0, subtotal_exonerado: 0, subtotal_gravado_15: 50, subtotal_gravado_18: 0, isv_total: 7.5, total: 57.5, descuento: 0 };
  const b = formatearTicket({ ...base, venta: { ...venta, es_borrador_fiscal: true } }, 48).join('\n');
  assert.equal(b.split(LEYENDA_BORRADOR).length - 1, 2, 'la leyenda aparece arriba y abajo');
  const real = formatearTicket({ ...base, venta: { ...venta, es_borrador_fiscal: false } }, 48).join('\n');
  assert.doesNotMatch(real, /SIN VALOR FISCAL/);
  const copia = formatearTicket({ ...base, venta: { ...venta, es_borrador_fiscal: false } }, 32, { copia: 2 });
  assert.match(copia.join('\n'), /COPIA #2/);
  assert.ok(copia.every((r) => r.length <= 32));
});

test('cierre de caja imprimible: totales, diferencia y firma', () => {
  const t = formatearCierreTurno({
    empresa, sucursal, cajero: 'Ana',
    turno: { abierto_at: '2026-10-09T14:00:00Z', cerrado_at: '2026-10-09T23:00:00Z', fondo_inicial: 500, efectivo_contado: 1790, diferencia: -10, observaciones: null },
    resumen: { facturas: 12, total: 1800, por_forma: [{ nombre: 'Efectivo', monto: 1300 }, { nombre: 'Tarjeta', monto: 500 }], efectivo_ventas: 1300, ingresos: 0, salidas: 0, efectivo_esperado: 1800, factura_desde: 'A-1', factura_hasta: 'A-12' },
  }, 42).join('\n');
  assert.match(t, /CIERRE DE CAJA/);
  assert.match(t, /FALTANTE\s+L 10\.00/);
  assert.match(t, /Firma del cajero/);
  const ciego = formatearCierreTurno({ empresa, sucursal, turno: { abierto_at: '2026-10-09T14:00:00Z', fondo_inicial: 500, efectivo_contado: 1790 }, resumen: { facturas: 1, total: 10, por_forma: [], efectivo_ventas: 10, efectivo_esperado: 510 }, ocultarEsperado: true }, 42).join('\n');
  assert.doesNotMatch(ciego, /Efectivo esperado|FALTANTE|SOBRANTE|CUADRA/);
});
