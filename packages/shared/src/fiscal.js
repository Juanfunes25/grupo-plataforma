// Cálculo de líneas y totales de una venta (SAR Honduras).
//
// Los precios de catálogo llevan el impuesto INCLUIDO: la tasa sirve para
// separar base e ISV del monto ya cobrado, no para sumarlo encima.
//
// Bucket fiscal por línea (el contador debe validar esta clasificación):
//   tasa 0.15            → gravado_15
//   tasa 0.18            → gravado_18
//   tasa 0 y (producto exento por ley o cliente exento) → exento
//   tasa 0 en cualquier otro caso                        → exonerado
//
// Un descuento reduce la base gravable: el global se reparte proporcional entre
// las líneas ANTES de separar base/ISV (si no, el ISV declarado sería mayor al
// realmente cobrado). El centavo de redondeo se ajusta en la última línea.

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export const PORCENTAJES_DESCUENTO = [0, 10, 25];

/** Opciones de descuento por línea, igual que Italo Facturación (25 % = tercera edad, exige identificar a la persona). */
export const OPCIONES_DESCUENTO = [
  { porcentaje: 0, etiqueta: 'Sin descuento', corta: '—' },
  { porcentaje: 10, etiqueta: '10 %', corta: '10 %' },
  { porcentaje: 25, etiqueta: '25 % Tercera edad', corta: '25 % 3ª edad' },
];

/** Monto de factura a partir del cual la ley exige el RTN del cliente (mismo criterio que Italo: L 10,000). */
export const UMBRAL_RTN_OBLIGATORIO = 10000;
export const DENOMINACIONES_EFECTIVO = [20, 50, 100, 200, 500, 1000];
export const MOTIVOS_DESCARTE = ['El cliente se arrepintió', 'Error al digitar la orden', 'Orden duplicada', 'Orden de prueba'];
export const MOTIVOS_REIMPRESION = ['El cliente la pidió de nuevo', 'El papel se trabó o salió mal', 'El cliente perdió la factura'];
export const MOTIVOS_ANULACION = ['Error al cobrar', 'Devolución del cliente', 'Producto en mal estado', 'Factura duplicada'];

export const soloDigitos = (v) => String(v ?? '').replace(/\D/g, '');
/** RTN con 14 dígitos exactos (lo que acepta el directorio de clientes). */
export const rtnValido = (rtn) => /^\d{14}$/.test(soloDigitos(rtn));
/** El criterio flojo de Italo (13-14 dígitos): sirve para avisar, no para bloquear. Vacío no se queja. */
export const rtnLuceValido = (rtn) => !rtn || /^\d{13,14}$/.test(String(rtn).replace(/[-\s]/g, ''));
/** Carné/identidad de tercera edad: al menos 5 caracteres alfanuméricos. */
export const identidadValida = (v) => String(v ?? '').replace(/[^0-9A-Za-z]/g, '').length >= 5;
/** ¿Falta el RTN del cliente para poder cobrar este total? */
export const requiereRtn = (total, cliente, umbral = UMBRAL_RTN_OBLIGATORIO) => Number(total) > umbral && !String(cliente?.rtn ?? '').trim();

/** Descuento de UNA línea (en una misma orden unos consumen con 25 % y otros no). */
export function descuentoDeLinea(precioUnitario, cantidad, porcentaje) {
  return round2((round2(Number(precioUnitario) * Number(cantidad)) * Number(porcentaje || 0)) / 100);
}

function bucketDe(tasa, exentoProducto, cliente) {
  if (tasa === 0.15) return 'gravado_15';
  if (tasa === 0.18) return 'gravado_18';
  return exentoProducto || cliente?.exento_impuestos ? 'exento' : 'exonerado';
}

function separar(monto, tasa) {
  const base = tasa > 0 ? round2(monto / (1 + tasa)) : monto;
  return { base, isv: round2(monto - base) };
}

/**
 * items: [{ producto_id, nombre_producto, cantidad, precio_base, extras?, descuento_porcentaje?,
 *           impuesto_tasa, exento?, opciones?, notas? }]
 */
export function calcularLineas(items, cliente) {
  return items.map((it, i) => {
    const cantidad = Number(it.cantidad);
    const precioBase = round2(it.precio_base);
    const extras = round2(it.extras || 0);
    const precioUnitario = round2(precioBase + extras);
    const pct = Number(it.descuento_porcentaje || 0);
    const descuento = descuentoDeLinea(precioUnitario, cantidad, pct);
    const tasa = Number(it.impuesto_tasa ?? 0);
    const monto = round2(precioUnitario * cantidad - descuento);
    const { base, isv } = separar(monto, tasa);
    return {
      producto_id: it.producto_id ?? null,
      nombre_producto: it.nombre_producto,
      cantidad,
      precio_base: precioBase,
      extras,
      precio_unitario: precioUnitario,
      opciones: it.opciones ?? [],
      notas: it.notas ?? null,
      descuento,
      descuento_porcentaje: pct,
      impuesto_tasa: tasa,
      exento: Boolean(it.exento),
      monto,
      base,
      isv,
      bucket: bucketDe(tasa, Boolean(it.exento), cliente),
      orden: i,
    };
  });
}

function repartirDescuento(lineas, descuento) {
  const totalBruto = round2(lineas.reduce((s, l) => s + l.monto, 0));
  let asignado = 0;
  return lineas.map((l, i) => {
    const ultima = i === lineas.length - 1;
    const parte = ultima ? round2(descuento - asignado) : totalBruto > 0 ? round2((descuento * l.monto) / totalBruto) : 0;
    asignado = round2(asignado + parte);
    const monto = round2(l.monto - parte);
    return { ...l, descuento: round2(l.descuento + parte), monto, ...separar(monto, l.impuesto_tasa) };
  });
}

export function calcularTotales(items, cliente, descuentoGlobal = 0) {
  const brutas = calcularLineas(items, cliente);
  const totalBruto = round2(brutas.reduce((s, l) => s + l.monto, 0));
  const desc = Math.min(totalBruto, Math.max(0, round2(descuentoGlobal || 0)));
  const lineas = desc > 0 ? repartirDescuento(brutas, desc) : brutas;
  const descuentoLineas = round2(brutas.reduce((s, l) => s + l.descuento, 0));

  const t = { exento: 0, exonerado: 0, gravado_15: 0, gravado_18: 0, isv: 0 };
  const porPct = {};   // descuento por línea, agrupado por porcentaje (para mostrar "Descuento 25 % (3ra edad)")
  for (const l of brutas) if (l.descuento > 0) porPct[l.descuento_porcentaje] = round2((porPct[l.descuento_porcentaje] ?? 0) + l.descuento);
  for (const l of lineas) {
    t[l.bucket] += l.base;
    t.isv += l.isv;
  }
  return {
    lineas,
    subtotal_bruto: round2(totalBruto + descuentoLineas),
    subtotal_exento: round2(t.exento),
    subtotal_exonerado: round2(t.exonerado),
    subtotal_gravado_15: round2(t.gravado_15),
    subtotal_gravado_18: round2(t.gravado_18),
    isv_total: round2(t.isv),
    descuento: round2(desc + descuentoLineas),
    descuentos_por_porcentaje: porPct,
    total: round2(lineas.reduce((s, l) => s + l.monto, 0)),
  };
}
