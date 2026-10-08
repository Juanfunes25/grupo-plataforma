// Ticket del cierre de caja para la impresora térmica (32/42/48 columnas). Devuelve renglones.
import { fechaHoraHN } from '@grupo/shared';
import { DENOMINACIONES } from './cierre-calculo.js';

const centrar = (t, w) => { const s = String(t).slice(0, w); return ' '.repeat(Math.floor((w - s.length) / 2)) + s; };
const L = (n) => `L ${Number(n ?? 0).toFixed(2)}`;
const fila = (izq, der, w) => { const d = String(der); const i = String(izq).slice(0, Math.max(1, w - d.length - 1)); return i + ' '.repeat(Math.max(1, w - i.length - d.length)) + d; };
const monto = (etq, n, w) => fila(etq, L(n), w);

function ajustar(texto, w) {
  const out = []; let act = '';
  for (const p of String(texto).split(/\s+/).flatMap((x) => (x.length > w ? x.match(new RegExp(`.{1,${w}}`, 'g')) : [x]))) {
    if ((act + ' ' + p).trim().length > w) { if (act) out.push(act); act = p; } else act = (act + ' ' + p).trim();
  }
  if (act) out.push(act);
  return out;
}

const etiquetaDif = (d) => {
  const x = Number(d ?? 0);
  if (Math.abs(x) < 0.005) return 'CUADRA';
  if (Math.abs(x) < 1) return x < 0 ? 'Faltan centavos' : 'Sobran centavos';
  return x < 0 ? 'FALTANTE' : 'SOBRANTE';
};

/** `cierre` = fila de pos.cierres_caja + { sucursal, cajero } ; `desglose` = salida de desgloseCierre (o null). */
export function formatearCierre({ empresa, cierre, desglose = null, ocultarSistema = false }, ancho = 42) {
  const t = [];
  const raya = (c = '-') => c.repeat(ancho);
  const f = (etq, n) => t.push(monto(etq, n, ancho));
  t.push(centrar((empresa.razon_social || empresa.nombre).toUpperCase(), ancho));
  t.push(centrar('CIERRE DE CAJA', ancho));
  for (const r of ajustar(cierre.sucursal ?? '', ancho)) t.push(centrar(r, ancho));
  t.push(raya());
  t.push(`Desde: ${fechaHoraHN(cierre.fecha_inicio)}`);
  t.push(`Hasta: ${fechaHoraHN(cierre.fecha_fin)}`);
  t.push(`Cajero: ${cierre.cajero ?? ''}`);
  if (cierre.factura_desde) for (const r of ajustar(`Facturas: ${cierre.factura_desde} a ${cierre.factura_hasta}`, ancho)) t.push(r);
  t.push(`Cantidad de facturas: ${cierre.cantidad_facturas ?? 0}`);
  t.push(raya('='));

  t.push('TARJETA');
  for (const [banco, m] of Object.entries(cierre.pos_bancos ?? {})) f(`  POS ${banco}`, m);
  f('  Total POS', cierre.tarjeta_reportada);
  if (!ocultarSistema) {
    f('  Segun sistema', cierre.tarjeta_sistema);
    f(`  ${etiquetaDif(cierre.diferencia_tarjeta)}`, Math.abs(cierre.diferencia_tarjeta ?? 0));
  }
  t.push(raya());

  t.push('EFECTIVO');
  f('  Contado en caja', cierre.efectivo_contado);
  f('  Fondo de caja', cierre.fondo_caja);
  if (Number(cierre.ingresos) > 0) f('  Ingresos de caja', cierre.ingresos);
  if (Number(cierre.salidas) > 0) f('  Salidas de caja', cierre.salidas);
  if (!ocultarSistema) {
    f('  Ventas en efectivo', cierre.efectivo_sistema);
    f('  Esperado en caja', cierre.efectivo_esperado);
    f(`  ${etiquetaDif(cierre.diferencia_efectivo)}`, Math.abs(cierre.diferencia_efectivo ?? 0));
  }
  t.push(raya());

  if (cierre.conteo && Object.keys(cierre.conteo).length) {
    t.push('CONTEO DE BILLETES Y MONEDAS');
    for (const d of DENOMINACIONES) {
      const c = Number(cierre.conteo[String(d.valor)] ?? 0);
      if (c > 0) t.push(fila(`  ${c} x L ${d.valor}${d.tipo === 'moneda' ? ' (moneda)' : ''}`, L(c * d.valor), ancho));
    }
    t.push(raya());
  }

  if (!ocultarSistema) {
    f('TRANSFERENCIAS', cierre.transferencia_sistema);
    if (Number(cierre.otros_sistema) > 0) f('OTRAS FORMAS DE PAGO', cierre.otros_sistema);
    t.push(raya('='));
    f('TOTAL VENTAS', cierre.total_ventas);
    f(`${etiquetaDif(cierre.diferencia)} TOTAL`, Math.abs(cierre.diferencia ?? 0));
    t.push(raya('='));
    if (Math.abs(Number(cierre.diferencia_tarjeta)) >= 1 || Math.abs(Number(cierre.diferencia_efectivo)) >= 1) {
      t.push(centrar('*** DESCUADRE ***', ancho)); t.push(centrar('Notificado a administracion', ancho)); t.push(raya('='));
    }
  }

  if (desglose && !ocultarSistema) {
    t.push('DESGLOSE DEL CIERRE');
    for (const x of desglose.formas) t.push(monto(`  ${x.nombre} x${x.facturas}`, x.monto, ancho));
    const listar = (titulo, lista) => {
      if (!lista.length) return;
      t.push(raya()); t.push(`${titulo} (${lista.length})`);
      for (const x of lista) t.push(monto(`  ${String(x.numero ?? '').slice(-8)}${x.referencia ? ' ' + x.referencia : ''}`, x.monto, ancho));
    };
    // Una por una, para cotejar contra los vouchers de cada POS y la banca.
    listar('FACTURAS CON TARJETA', desglose.tarjeta);
    listar('TRANSFERENCIAS', desglose.transferencia);
    listar('ANULADAS', desglose.anuladas);
    if (desglose.descuentos.length) {
      t.push(raya()); t.push('DESCUENTOS APLICADOS');
      for (const d of desglose.descuentos) t.push(monto(`  ${d.porcentaje === 25 ? '25% 3ra edad' : `${d.porcentaje}%`} (${d.lineas} prod.)`, d.monto, ancho));
    }
    t.push(raya('='));
  }

  if (cierre.observaciones) { t.push('Observaciones:'); for (const r of ajustar(cierre.observaciones, ancho)) t.push(r); }
  t.push(''); t.push('');
  t.push(centrar('______________________', ancho)); t.push(centrar('Firma cajero', ancho));
  t.push(''); t.push('');
  t.push(centrar('______________________', ancho)); t.push(centrar('Firma supervisor', ancho));
  t.push('');
  return t;
}
