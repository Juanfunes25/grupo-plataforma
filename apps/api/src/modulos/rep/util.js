import { z } from 'zod';
import { prohibido, noEncontrado, malaPeticion, uuid, fechaISO } from '../../lib/http.js';
import { resolverSucursal } from '../../lib/contexto.js';

export { uuid, fechaISO };
export const GRAMOS_MAXIMO_RAZONABLE = 50000;

/** El módulo solo funciona en empresas con 'reposicion' encendido (Italo). */
export function soloReposicion(req, _res, next) {
  if (!req.ctx.empresa.modulos.includes('reposicion')) throw prohibido(`${req.ctx.empresa.nombre} no tiene el módulo de reposición`);
  next();
}

/**
 * Una tienda (cajero fijado a su sucursal) entra a pesar y recibir; no ve el análisis.
 * Dueño, administrador y gerente ven todo; bodega arma despachos; producción ve consumo.
 */
export const esTienda = (ctx) => ctx.permisos.has('rep:pesar') && !ctx.permisos.has('rep:despachar') && !ctx.permisos.has('rep:ver');

export const empresaDe = (req) => req.ctx.empresa.id;

/** Valida que la sucursal sea de la empresa activa y que el usuario pueda operarla. */
export async function sucursalDe(db, req, id) {
  const idv = z.string().uuid('sucursal inválida').safeParse(id);
  if (!idv.success) throw malaPeticion('Elige la sucursal');
  return resolverSucursal(db, req.ctx, idv.data);
}

/** Sucursales de la empresa que ve el usuario, con su configuración de reposición. */
export async function listarSucursales(db, ctx) {
  const { rows } = await db.query(
    `select s.id, s.nombre, s.alias, s.tipo, s.color, s.activo, coalesce(c.fuera_de_analisis,false) as fuera_de_analisis, coalesce(c.cerrada,false) as cerrada
       from core.sucursales s left join rep.sucursal_config c on c.sucursal_id = s.id
      where s.empresa_id = $1 and s.activo and not coalesce(c.cerrada,false) order by s.orden, s.nombre`, [ctx.empresa.id]);
  return ctx.sucursalIds.length ? rows.filter((s) => ctx.sucursalIds.includes(s.id)) : rows;
}

export async function saborDe(db, empresaId, id) {
  const { rows } = await db.query('select * from rep.sabores where id = $1 and empresa_id = $2', [id, empresaId]);
  if (!rows[0]) throw noEncontrado('Sabor no encontrado');
  return rows[0];
}

export const gramosValidos = (g) => { const n = Number(g); return Number.isFinite(n) && n >= 0 && n <= GRAMOS_MAXIMO_RAZONABLE; };
export const PERM_ADMIN = 'rep:costeo';   // dueño, administrador y gerente
