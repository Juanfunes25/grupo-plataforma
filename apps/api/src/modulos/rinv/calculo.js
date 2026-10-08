// Reglas puras del inventario de reposición (sin base de datos), para poder probarlas solas.
// Portadas de «Italo Reposición»: inventarioMovimientos, inventarioLotes, valorInventario,
// trazabilidad (repartirFifo), insumosDespachados, pesoDesdeNombre y extraccionInventario.
import { sumarDias } from '@grupo/shared';

// La materia prima Mec3 vence al año de haber llegado, según el negocio.
export const DIAS_VENCIMIENTO = 365;

/**
 * Redondea a 2 decimales el saldo que se va a guardar. Sumar decimales en coma flotante deja
 * residuos (0.1 + 0.2 = 0.30000000000000004) y el error se arrastra de un movimiento al siguiente.
 */
export function redondearSaldo(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Aplica una entrada o salida a un saldo. Una salida mayor que lo que hay NO se permite. */
export function aplicarMovimiento(actual, tipo, cantidad) {
  const base = Number(actual) || 0;
  if (tipo === 'entrada') return { ok: true, nuevo: redondearSaldo(base + cantidad) };
  if (tipo === 'salida') {
    if (cantidad > base) return { ok: false, error: `No hay suficiente stock (hay ${base}, se pidió sacar ${cantidad})` };
    return { ok: true, nuevo: redondearSaldo(base - cantidad) };
  }
  return { ok: false, error: 'Tipo de movimiento inválido (usar "entrada" o "salida")' };
}

export const vencimientoDe = (fechaIngreso) => sumarDias(fechaIngreso, DIAS_VENCIMIENTO);

export function validarLimites(min, max) {
  const malo = (v) => v !== undefined && v !== null && (!Number.isFinite(Number(v)) || Number(v) < 0);
  if (malo(min)) return 'Stock mínimo inválido';
  if (malo(max)) return 'Stock máximo inválido';
  if (min != null && max != null && Number(max) < Number(min)) return 'El stock máximo no puede ser menor que el mínimo';
  return null;
}

/** Un insumo está en alerta si no es equipo y está en 0 o bajo su mínimo. */
export const enAlerta = (stock, minimo, esEquipo = false) =>
  !esEquipo && stock !== null && stock !== undefined && (Number(stock) === 0 || (minimo != null && Number(stock) < Number(minimo)));

/** Bajo el mínimo (la lista «Reordenar»): sin stock cargado cuenta como 0. */
export const bajoMinimo = (stock, minimo, esEquipo = false) =>
  !esEquipo && minimo != null && (Number(stock) || 0) < Number(minimo);

// ── Nombres parecidos (aviso «esto ya existe, escrito distinto») ─────────────
export function normalizarComparacion(nombre) {
  return String(nombre || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
}

export function distanciaEdicion(a, b) {
  const filas = a.length + 1;
  const cols = b.length + 1;
  const d = Array.from({ length: filas }, (_, i) => [i, ...Array(cols - 1).fill(0)]);
  for (let j = 0; j < cols; j++) d[0][j] = j;
  for (let i = 1; i < filas; i++) {
    for (let j = 1; j < cols; j++) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + costo);
    }
  }
  return d[filas - 1][cols - 1];
}

/**
 * 1.0 = idénticos, 0.0 = nada en común. Los números del nombre se tratan aparte: "Vaso 8oz" y
 * "Vaso 12oz" son productos distintos a propósito, aunque queden muy cerca en distancia de edición.
 */
export function similitudNombres(a, b) {
  const na = normalizarComparacion(a);
  const nb = normalizarComparacion(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const numerosA = na.match(/\d+/g);
  const numerosB = nb.match(/\d+/g);
  if (numerosA && numerosB && numerosA.join(',') !== numerosB.join(',')) return 0;
  return 1 - distanciaEdicion(na, nb) / Math.max(na.length, nb.length);
}

// ── FIFO ────────────────────────────────────────────────────────────────────
const EPSILON = 1e-6;
export function redondear(n, decimales = 4) {
  const f = 10 ** decimales;
  return Math.round((Number(n) + Number.EPSILON) * f) / f;
}

/**
 * Reparte una cantidad entre orígenes FIFO (lo más viejo primero), tomando parcialmente de cada uno.
 * `disponibles` viene YA ordenado por antigüedad; `restante` es lo que le queda a cada origen.
 * `sinOrigen` es lo que no se pudo cubrir (stock que existía antes de llevar lotes): se devuelve, no se oculta.
 */
export function repartirFifo({ disponibles, cantidad }) {
  const tomas = [];
  let pendiente = redondear(cantidad);
  for (const origen of disponibles) {
    if (pendiente <= EPSILON) break;
    const restante = redondear(Number(origen.restante) || 0);
    if (restante <= EPSILON) continue;
    const toma = Math.min(restante, pendiente);
    tomas.push({ id: origen.id, cantidad: redondear(toma) });
    pendiente = redondear(pendiente - toma);
  }
  return { tomas, sinOrigen: pendiente > EPSILON ? pendiente : 0 };
}

// ── Peso del envase desde el nombre ("COOKIES BLACK X 6 KG" → 6) ────────────
const PESO_MAXIMO_KG = 60;
const PESO = /([0-9]+(?:[.,][0-9]+)?)\s*KG\b/i;
/** Solo se ancla en la palabra KG (no agarra códigos de producto) y no interpreta multipacks. */
export function pesoDesdeNombre(nombre) {
  const m = PESO.exec(String(nombre || ''));
  if (!m) return null;
  const peso = Number(m[1].replace(',', '.'));
  return Number.isFinite(peso) && peso > 0 && peso <= PESO_MAXIMO_KG ? peso : null;
}

// ── Valor del inventario ────────────────────────────────────────────────────
const SIN_CATEGORIA = 'Sin categoría';
// 'kg' y 'l' ya están en la misma unidad que el precio; cualquier otra (unidad, bote, bolsa)
// necesita el peso de cada envase para poder valorizarse.
const esPorPeso = (u) => ['kg', 'kilo', 'kilos', 'l', 'lt', 'litro', 'litros'].includes(String(u || '').trim().toLowerCase());

/**
 * Cuánto dinero hay parado en bodega. Cada insumo se valoriza con su precio más reciente (por kilo).
 * Lo que NO se puede calcular no se inventa en cero: se devuelve aparte (sinPrecio, sinPeso, sinStock)
 * y el total es un piso, no el valor real.
 *
 * `filas`: [{ id, nombre, descripcion, tipo, categoria, unidad, stock_actual, es_equipo, peso_unitario, precio }]
 */
export function valorInventarioFabrica(filas) {
  let total = 0;
  const valorados = [];
  const sinPrecio = [];
  const sinPeso = [];
  const sinStock = [];
  const categoriasSet = new Set();

  for (const f of filas) {
    if (f.es_equipo) continue; // los equipos no son mercadería
    const categoriaInsumo = f.categoria || SIN_CATEGORIA;
    categoriasSet.add(categoriaInsumo);

    const stock = Number(f.stock_actual);
    if (f.stock_actual === null || f.stock_actual === undefined || !Number.isFinite(stock) || stock <= 0) {
      sinStock.push({ id: f.id, nombre: f.nombre, categoria: categoriaInsumo });
      continue;
    }
    const precio = f.precio === null || f.precio === undefined ? null : Number(f.precio);
    if (precio === null || !Number.isFinite(precio)) {
      sinPrecio.push({ id: f.id, nombre: f.nombre, stock, unidad: f.unidad });
      continue;
    }
    const pesoUnitario = Number(f.peso_unitario);
    let kilos = stock;
    if (!esPorPeso(f.unidad)) {
      if (!Number.isFinite(pesoUnitario) || pesoUnitario <= 0) {
        sinPeso.push({ id: f.id, nombre: f.nombre, stock, unidad: f.unidad });
        continue;
      }
      kilos = stock * pesoUnitario;
    }
    const valor = kilos * precio;
    total += valor;
    valorados.push({
      id: f.id, nombre: f.nombre, descripcion: f.descripcion || null, tipo: f.tipo, categoria: categoriaInsumo, unidad: f.unidad,
      stock, kilos, peso_unitario: Number.isFinite(pesoUnitario) && pesoUnitario > 0 ? pesoUnitario : null, precio, valor,
    });
  }
  valorados.sort((a, b) => b.valor - a.valor);
  const porTipo = valorados.reduce((acc, v) => { acc[v.tipo] = (acc[v.tipo] || 0) + v.valor; return acc; }, {});
  const porCategoria = valorados.reduce((acc, v) => { acc[v.categoria] = (acc[v.categoria] || 0) + v.valor; return acc; }, {});
  return {
    total, porTipo, porCategoria, categorias: [...categoriasSet].sort(), insumos: valorados, sinPrecio, sinPeso, sinStock,
    insumosSinPrecio: sinPrecio.length, insumosSinPeso: sinPeso.length, insumosSinStock: sinStock.length,
  };
}

// ── Insumos más despachados ─────────────────────────────────────────────────
const normalizarTextoLibre = (t) => (t || '').trim().toUpperCase().replace(/\s+/g, ' ');

/**
 * Qué insumos mueve más el despachador: cuenta solo lo que de verdad se tachó como enviado.
 * `items`: [{ insumo_texto, enviado, sucursal_id, sucursal_nombre }].
 */
export function armarInsumosDespachados(items) {
  const porInsumo = new Map();
  for (const it of items) {
    if (!it.enviado) continue;
    const clave = normalizarTextoLibre(it.insumo_texto);
    if (!clave) continue;
    if (!porInsumo.has(clave)) porInsumo.set(clave, { nombre: (it.insumo_texto || '').trim(), veces: 0, porTienda: new Map() });
    const i = porInsumo.get(clave);
    i.veces += 1;
    const t = i.porTienda.get(it.sucursal_id) || { sucursal_id: it.sucursal_id, nombre: it.sucursal_nombre, veces: 0 };
    t.veces += 1;
    i.porTienda.set(it.sucursal_id, t);
  }
  return [...porInsumo.values()]
    .map((i) => ({ nombre: i.nombre, veces: i.veces, porTienda: [...i.porTienda.values()].sort((a, b) => b.veces - a.veces) }))
    .sort((a, b) => b.veces - a.veces);
}

// ── Pedido pegado como texto: "Pasta pistacho 8x4,5" ────────────────────────
const compactar = (s) => normalizarComparacion(s).replace(/[^A-Z0-9]/g, '');
const alfanum = (s) => normalizarComparacion(s).replace(/[^A-Z0-9]+/g, ' ').trim();

/**
 * Empareja cada línea con un insumo del catálogo de fábrica: primero exacto (normalizado), luego sin
 * espacios, y por último «contiene» solo si hay UN candidato (con dos o más es ambiguo y lo elige la persona).
 */
export function emparejarConCatalogo(items, insumos) {
  const porNombre = new Map(insumos.map((i) => [alfanum(i.nombre), i]));
  const porCompacto = new Map(insumos.map((i) => [compactar(i.nombre), i]));
  return items.map((item) => {
    const n = alfanum(item.nombre);
    const c = compactar(item.nombre);
    let insumo = porNombre.get(n) || porCompacto.get(c) || null;
    if (!insumo && c.length > 3) {
      const candidatos = insumos.filter((i) => { const ci = compactar(i.nombre); return ci.includes(c) || c.includes(ci); });
      if (candidatos.length === 1) insumo = candidatos[0];
    }
    return {
      ...item,
      insumo_id: insumo ? insumo.id : null,
      nombre_catalogo: insumo ? insumo.nombre : null,
      unidad: insumo ? insumo.unidad : null,
      peso_unitario: item.peso_unitario ?? (insumo ? insumo.peso_unitario : null),
    };
  });
}

/**
 * Lee las líneas de un pedido escrito o pegado desde una hoja: "Nombre  8x4,5kg", "Nombre; 8; 4.5",
 * "Nombre - 2+1X5,0kg". La coma es decimal latino ("4,5" = 4.5). Una suma en las unidades ("2+1") se suma.
 * Nunca inventa: lo que no se entiende queda con unidades/peso en null y confianza baja.
 */
export function parsearPedidoTexto(texto) {
  const lineas = String(texto || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const num = (s) => Number(String(s).replace(',', '.'));
  const items = [];
  for (const crudo of lineas) {
    // 1) «<nombre> <unidades>x<peso>[kg]»  (unidades pueden ser una suma 2+1)
    let m = /^(.*?)[\s:;,\-–]*\b(\d+(?:\s*\+\s*\d+)*)\s*[xX×]\s*(\d+(?:[.,]\d+)?)\s*(?:kg|KG|Kg)?\.?\s*$/.exec(crudo);
    if (m && m[1].trim()) {
      const unidades = m[2].split('+').reduce((a, b) => a + Number(b), 0);
      items.push({ nombre: m[1].trim().replace(/[\s:;,\-–]+$/, ''), unidades, peso_unitario: num(m[3]), texto_crudo: crudo, confianza: 'alta', legible: true });
      continue;
    }
    // 2) columnas separadas por ; , tab: nombre, unidades[, peso]
    const cols = crudo.split(/[;\t]|,(?=\s*\d)/).map((c) => c.trim());
    if (cols.length >= 2 && cols[0] && /^\d+(?:[.,]\d+)?$/.test(cols[1])) {
      items.push({
        nombre: cols[0], unidades: num(cols[1]), peso_unitario: cols[2] && /^\d+(?:[.,]\d+)?$/.test(cols[2].replace(/kg$/i, '').trim()) ? num(cols[2].replace(/kg$/i, '').trim()) : null,
        texto_crudo: crudo, confianza: 'media', legible: true,
      });
      continue;
    }
    // 3) solo nombre: queda para que la persona complete
    items.push({ nombre: crudo, unidades: null, peso_unitario: null, texto_crudo: crudo, confianza: 'baja', legible: false });
  }
  return items;
}
