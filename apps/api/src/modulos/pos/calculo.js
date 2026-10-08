import { calcularTotales } from '@grupo/shared';
import { malaPeticion, prohibido } from '../../lib/http.js';

/**
 * Convierte lo que manda la caja ({producto_id, cantidad, opciones:[ids], …}) en líneas
 * con PRECIOS TOMADOS DE LA BASE (nunca del cliente) y valida las reglas de
 * modificadores: cada opción debe pertenecer a un grupo del producto y se
 * respetan min/max por grupo.
 */
export async function armarItems(q, ctx, items) {
  if (!Array.isArray(items) || items.length === 0) throw malaPeticion('La orden no tiene productos');
  const ids = [...new Set(items.map((i) => i.producto_id))];
  const prods = (await q.query(
    `select id, nombre, precio, impuesto_tasa, exento, activo, disponible from pos.productos where empresa_id = $1 and id = any($2::uuid[])`,
    [ctx.empresa.id, ids])).rows;
  const porId = new Map(prods.map((p) => [p.id, p]));

  const grupos = (await q.query(
    `select pg.producto_id, g.id as grupo_id, g.nombre as grupo, g.min_sel, g.max_sel
       from pos.producto_grupos pg join pos.modificador_grupos g on g.id = pg.grupo_id and g.activo
      where pg.producto_id = any($1::uuid[])`, [ids])).rows;
  const mods = (await q.query(
    `select m.id, m.nombre, m.precio_extra, m.grupo_id from pos.modificadores m
       join pos.producto_grupos pg on pg.grupo_id = m.grupo_id
      where m.activo and pg.producto_id = any($1::uuid[])`, [ids])).rows;

  const usaDescuento = items.some((i) => Number(i.descuento_porcentaje || 0) > 0);
  if (usaDescuento && !ctx.permisos.has('pos:descuento')) throw prohibido('No tienes permiso para dar descuentos');

  return items.map((it) => {
    const p = porId.get(it.producto_id);
    if (!p || !p.activo) throw malaPeticion('Un producto de la orden no existe o está inactivo');
    if (!p.disponible) throw malaPeticion(`"${p.nombre}" está marcado como agotado`);
    const cant = Number(it.cantidad);
    if (!(cant > 0) || cant > 999) throw malaPeticion(`Cantidad inválida en "${p.nombre}"`);
    const pct = Number(it.descuento_porcentaje || 0);
    if (![0, 10, 25].includes(pct)) throw malaPeticion('El descuento solo puede ser 0, 10 o 25 %');

    const elegidas = [...new Set(it.opciones ?? [])];
    const opciones = elegidas.map((mid) => {
      const m = mods.find((x) => x.id === mid && grupos.some((g) => g.producto_id === p.id && g.grupo_id === x.grupo_id));
      if (!m) throw malaPeticion(`Una opción elegida para "${p.nombre}" no es válida`);
      const g = grupos.find((x) => x.producto_id === p.id && x.grupo_id === m.grupo_id);
      return { id: m.id, grupo_id: g.grupo_id, grupo: g.grupo, nombre: m.nombre, precio_extra: Number(m.precio_extra) };
    });
    for (const g of grupos.filter((x) => x.producto_id === p.id)) {
      const n = opciones.filter((o) => o.grupo_id === g.grupo_id).length;
      if (n < g.min_sel) throw malaPeticion(`"${p.nombre}": elige ${g.min_sel > 1 ? 'al menos ' + g.min_sel : 'una opción'} de ${g.grupo}`);
      if (n > g.max_sel) throw malaPeticion(`"${p.nombre}": máximo ${g.max_sel} en ${g.grupo}`);
    }
    return {
      producto_id: p.id, nombre_producto: p.nombre, cantidad: cant,
      precio_base: Number(p.precio), extras: opciones.reduce((s, o) => s + o.precio_extra, 0),
      impuesto_tasa: Number(p.impuesto_tasa), exento: p.exento, opciones,
      notas: it.notas ? String(it.notas).slice(0, 200) : null, descuento_porcentaje: pct,
    };
  });
}

export const totalesDe = (items, cliente, descuentoGlobal) => calcularTotales(items, cliente, descuentoGlobal);
