import { z } from 'zod';
import { malaPeticion } from '../../lib/http.js';

export const texto = (max = 200) => z.string().trim().max(max).transform((v) => (v ? v : null)).nullish();
export const numeroOpc = z.coerce.number().finite();
export const hoyHn = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Tegucigalpa' }).format(new Date());

/** ¿Ve costos? Dirección, administración y manager (permiso de catálogo). Bodega y gestor ven cantidades, no costos. */
export const veCostos = (ctx) => ctx.permisos.has('pos:catalogo');
/** ¿Es administrador de la empresa? (ve y modifica las salidas, ve «en proyectos») */
export const esAdmin = (ctx) => ctx.permisos.has('admin:empresa');

export function sinCostosProducto(p, ctx) {
  if (veCostos(ctx)) return p;
  const { costo_estandar, ...resto } = p;
  return resto;
}

/** Existencias por producto de la empresa (Map producto_id → número). */
export async function existenciasMapa(q, empresaId) {
  const { rows } = await q.query('select producto_id, existencia from dis.existencias where empresa_id = $1', [empresaId]);
  return new Map(rows.map((x) => [x.producto_id, Number(x.existencia)]));
}

/** Material que está afuera, en proyectos abiertos: Map producto_id → [{salida_id, proyecto, cantidad}]. */
export async function enProyectosMapa(q, empresaId) {
  const { rows } = await q.query(
    `select i.producto_id, s.id as salida_id, s.proyecto, (i.cantidad_salida - i.cantidad_retorno) as pendiente
       from dis.salida_items i join dis.salidas s on s.id = i.salida_id
      where s.empresa_id = $1 and s.estado = 'abierta' and i.cantidad_salida > i.cantidad_retorno`, [empresaId]);
  const m = new Map();
  for (const f of rows) m.set(f.producto_id, [...(m.get(f.producto_id) ?? []), { salida_id: f.salida_id, proyecto: f.proyecto, cantidad: Number(f.pendiente) }]);
  return m;
}

export const enteroPositivo = (v, msg) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n === 0) throw malaPeticion(msg);
  return n;
};
