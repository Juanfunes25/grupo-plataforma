import { Router } from 'express';
import { z } from 'zod';
import { lempiras } from '@grupo/shared';
import { sucursalesPermitidas } from '../../lib/contexto.js';
import { validar } from '../../lib/http.js';
import { veRestringidos } from '../documentos/servicio.js';

const TZ = `'America/Tegucigalpa'`;

/** Minúsculas y sin tildes (la misma transformación se aplica en SQL con `plano()`). */
export const sinTildes = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ñ/g, 'n');
/** Expresión SQL equivalente a sinTildes() para una columna o expresión de texto. */
export const plano = (c) => `translate(lower(coalesce(${c}, '')), 'áéíóúüñàèìòùâêîôû', 'aeiouunaeiouaeiou')`;
/** Patrón LIKE seguro (escapa % _ \). */
export const patron = (t) => `%${sinTildes(t).replace(/[\\%_]/g, '\\$&')}%`;

/** Qué módulo (y por tanto qué pantalla) atiende cada tipo de resultado en la empresa activa; sin módulo visible, no se busca ahí. */
const DESTINOS = {
  facturas: ['facturas'],
  clientes: ['clientes'],
  productos: ['catalogo', 'dis_catalogo', 'piedra'],
  empleados: ['rrhh'],
  documentos: ['documentos'],
};

/**
 * Búsqueda global (/api/busqueda?q=): facturas, clientes, productos, empleados y documentos de la
 * empresa activa. Solo busca donde el usuario tiene el módulo (y por tanto el permiso) y respeta sus
 * sucursales y la confidencialidad de los documentos.
 */
export function rutasBusqueda({ db }) {
  const r = Router();
  const esq = z.object({ q: z.string().trim().max(80).default(''), limite: z.coerce.number().int().min(1).max(10).default(5) });

  r.get('/', async (req, res) => {
    const { q, limite } = validar(esq, req.query);
    const ctx = req.ctx;
    const destino = (tipo) => ctx.modulos.find((m) => DESTINOS[tipo].includes(m.id)) ?? null;
    if (q.length < 2) return res.json({ q, grupos: [] });
    const like = patron(q);
    const soloDigitos = q.replace(/\D/g, '');
    const digitos = soloDigitos.length >= 3 ? `${soloDigitos}%` : null;
    const exacto = /^\d{1,9}$/.test(q) ? Number(q) : null;
    const lim = limite + 1;
    const tareas = [];
    const poner = (tipo, titulo, filas, mapa) => {
      const m = destino(tipo);
      const items = filas.slice(0, limite).map((f) => ({ ...mapa(f), modulo: m.id, ruta: m.ruta }));
      return { id: tipo, titulo, items, hay_mas: filas.length > limite };
    };

    if (destino('facturas')) {
      const sucs = (await sucursalesPermitidas(db, ctx)).map((s) => s.id);
      tareas.push(db.query(
        `select v.id, v.numero_factura, v.numero_orden, v.ticket_dia, v.estado, v.total, v.nombre_orden, s.nombre as sucursal,
                coalesce(v.cliente_nombre, t.nombre) as cliente, coalesce(v.cliente_rtn, t.rtn) as rtn,
                to_char(coalesce(v.fecha_emision, v.created_at) at time zone ${TZ}, 'DD/MM/YYYY') as fecha
           from pos.ventas v join core.sucursales s on s.id = v.sucursal_id left join core.terceros t on t.id = v.cliente_id
          where v.empresa_id = $1 and v.sucursal_id = any($2::uuid[]) and v.estado in ('pagada', 'anulada')
            and (${plano('v.numero_factura')} like $3 or ${plano('coalesce(v.cliente_nombre, t.nombre)')} like $3 or ${plano('v.nombre_orden')} like $3
                 or ($4::text is not null and regexp_replace(coalesce(v.cliente_rtn, t.rtn, ''), '\\D', '', 'g') like $4)
                 or ($5::bigint is not null and v.numero_orden = $5))
          order by coalesce(v.fecha_emision, v.created_at) desc limit $6`,
        [ctx.empresa.id, sucs, like, digitos, exacto, lim]).then(({ rows }) => poner('facturas', 'Facturas', rows, (f) => ({
        id: f.id, titulo: f.numero_factura ?? `Orden ${f.numero_orden}`,
        detalle: `${f.cliente ?? 'Consumidor Final'} · ${lempiras(f.total)} · ${f.fecha} · ${f.sucursal}`,
        etiqueta: f.estado === 'anulada' ? 'Anulada' : null, buscar: f.numero_factura ?? String(f.numero_orden) }))));
    }

    if (destino('clientes')) {
      tareas.push(db.query(
        `select id, nombre, nombre_comercial, rtn, telefono, es_cliente, es_proveedor from core.terceros
          where activo and not es_consumidor_final
            and (${plano('nombre')} like $1 or ${plano('nombre_comercial')} like $1 or ($2::text is not null and (regexp_replace(coalesce(rtn, ''), '\\D', '', 'g') like $2 or regexp_replace(coalesce(telefono, ''), '\\D', '', 'g') like '%' || $2)))
          order by nombre limit $3`, [like, digitos, lim]).then(({ rows }) => poner('clientes', 'Clientes y proveedores', rows, (c) => ({
        id: c.id, titulo: c.nombre, detalle: [c.nombre_comercial, c.rtn ? `RTN ${c.rtn}` : null, c.telefono].filter(Boolean).join(' · '),
        etiqueta: c.es_proveedor && !c.es_cliente ? 'Proveedor' : null, buscar: c.nombre }))));
    }

    if (destino('productos')) {
      tareas.push(db.query(
        `select p.id, p.nombre, p.codigo, p.codigo_barras, p.precio, p.activo, c.nombre as categoria from pos.productos p left join pos.categorias c on c.id = p.categoria_id
          where p.empresa_id = $1 and (${plano('p.nombre')} like $2 or ${plano('p.codigo')} like $2 or p.codigo_barras = $3)
          order by p.activo desc, p.nombre limit $4`, [ctx.empresa.id, like, q, lim]).then(({ rows }) => poner('productos', 'Productos', rows, (p) => ({
        id: p.id, titulo: p.nombre, detalle: [p.codigo, p.categoria, lempiras(p.precio)].filter(Boolean).join(' · '), etiqueta: p.activo ? null : 'Inactivo', buscar: p.nombre }))));
    }

    if (destino('empleados')) {
      const sensible = ctx.permisos.has('rrhh:sensible');
      tareas.push(db.query(
        `select e.id, p.nombres, p.apellidos, e.puesto, e.estado, s.nombre as sucursal from rrhh.empleados e join rrhh.personas p on p.id = e.persona_id left join core.sucursales s on s.id = e.sucursal_id
          where e.empresa_id = $1 and ($2::uuid[] = '{}' or e.sucursal_id is null or e.sucursal_id = any($2::uuid[]))
            and (${plano("p.nombres || ' ' || p.apellidos")} like $3 or ${plano('e.puesto')} like $3 or ${plano('e.codigo')} like $3
                 or ($5::boolean and $4::text is not null and regexp_replace(coalesce(p.identidad, ''), '\\D', '', 'g') like $4))
          order by (e.estado = 'baja'), p.nombres, p.apellidos limit $6`,
        [ctx.empresa.id, ctx.sucursalIds, like, digitos, sensible, lim]).then(({ rows }) => poner('empleados', 'Empleados', rows, (e) => ({
        id: e.id, titulo: `${e.nombres} ${e.apellidos}`.trim(), detalle: [e.puesto, e.sucursal].filter(Boolean).join(' · '),
        etiqueta: e.estado === 'baja' ? 'Baja' : null, buscar: `${e.nombres} ${e.apellidos}`.trim() }))));
    }

    if (destino('documentos')) {
      tareas.push(db.query(
        `select d.id, d.titulo, d.numero, d.entidad_emisora, d.fecha_vencimiento::text as vence, t.nombre as tipo
           from doc.documentos d left join doc.tipos t on t.empresa_id = d.empresa_id and t.codigo = d.tipo
          where d.empresa_id = $1 and d.eliminado_at is null and not d.archivado
            and ($2::boolean or d.confidencialidad = 'normal') and ($3::uuid[] = '{}' or d.sucursal_id is null or d.sucursal_id = any($3::uuid[]))
            and (${plano('d.titulo')} like $4 or ${plano('d.numero')} like $4 or ${plano('d.entidad_emisora')} like $4 or ${plano('d.contraparte')} like $4 or ${plano("array_to_string(d.etiquetas, ' ')")} like $4)
          order by d.fecha_vencimiento asc nulls last, d.titulo limit $5`,
        [ctx.empresa.id, veRestringidos(ctx), ctx.sucursalIds, like, lim]).then(({ rows }) => poner('documentos', 'Documentos', rows, (d) => ({
        id: d.id, titulo: d.titulo, detalle: [d.tipo, d.numero, d.vence ? `vence ${d.vence}` : null].filter(Boolean).join(' · '), buscar: d.titulo }))));
    }

    const grupos = (await Promise.all(tareas)).filter((g) => g.items.length);
    res.json({ q, grupos });
  });
  return r;
}
