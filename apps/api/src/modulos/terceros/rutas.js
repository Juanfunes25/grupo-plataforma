import { Router } from 'express';
import { z } from 'zod';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { malaPeticion, noEncontrado, prohibido, uuid, validar } from '../../lib/http.js';

const rtn = z.string().trim().transform((v) => v.replace(/[\s-]/g, '')).refine((v) => v === '' || /^\d{14}$/.test(v), 'El RTN lleva 14 dígitos')
  .optional().nullable().transform((v) => v || null);
const esq = z.object({
  nombre: z.string().trim().min(2).max(160), nombre_comercial: z.string().trim().max(160).optional().nullable(),
  rtn, identidad: z.string().trim().max(20).optional().nullable().transform((v) => v || null),
  telefono: z.string().trim().max(40).optional().nullable(), correo: z.string().trim().toLowerCase().email().optional().nullable().or(z.literal('').transform(() => null)),
  direccion: z.string().trim().max(250).optional().nullable(), notas: z.string().trim().max(500).optional().nullable(),
  es_cliente: z.boolean().default(true), es_proveedor: z.boolean().default(false), exento_impuestos: z.boolean().default(false), activo: z.boolean().default(true),
});

export function rutasTerceros({ db, ctxMgr }) {
  const r = Router();

  // El directorio es COMÚN a todo el grupo: un cliente de Origen que también compra en Italo es la misma ficha.
  r.get('/', requierePermiso('clientes:ver', 'pos:vender'), async (req, res) => {
    const f = validar(z.object({ q: z.string().trim().max(60).optional(), tipo: z.enum(['cliente', 'proveedor']).optional(), limite: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const { rows } = await db.query(
      `select id, nombre, nombre_comercial, rtn, identidad, telefono, correo, direccion, es_cliente, es_proveedor, exento_impuestos, es_consumidor_final, activo
         from core.terceros
        where activo and ($1::text is null or nombre ilike '%'||$1||'%' or nombre_comercial ilike '%'||$1||'%' or rtn like $1||'%' or telefono like '%'||$1||'%')
          and ($2::text is null or ($2 = 'cliente' and es_cliente) or ($2 = 'proveedor' and es_proveedor))
        order by es_consumidor_final desc, nombre limit $3`, [f.q ?? null, f.tipo ?? null, f.limite]);
    res.json(rows);
  });

  r.post('/', requierePermiso('clientes:editar'), async (req, res) => {
    const b = validar(esq, req.body);
    if (!b.es_cliente && !b.es_proveedor) throw malaPeticion('Marca si es cliente, proveedor o ambos');
    const t = (await db.query(
      `insert into core.terceros (nombre,nombre_comercial,rtn,identidad,telefono,correo,direccion,notas,es_cliente,es_proveedor,exento_impuestos,created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
      [b.nombre, b.nombre_comercial ?? null, b.rtn, b.identidad, b.telefono ?? null, b.correo ?? null, b.direccion ?? null, b.notas ?? null, b.es_cliente, b.es_proveedor, b.exento_impuestos, req.ctx.usuario.id])).rows[0];
    await auditar(db, req.ctx, 'tercero_creado', 'tercero', t.id, { nombre: t.nombre });
    res.status(201).json(t);
  });

  r.put('/:id', requierePermiso('clientes:editar'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(esq, req.body);
    const cf = (await db.query('select es_consumidor_final from core.terceros where id = $1', [id])).rows[0];
    if (!cf) throw noEncontrado();
    if (cf.es_consumidor_final) throw prohibido('La ficha "Consumidor Final" no se edita');
    const t = (await db.query(
      `update core.terceros set nombre=$2,nombre_comercial=$3,rtn=$4,identidad=$5,telefono=$6,correo=$7,direccion=$8,notas=$9,es_cliente=$10,es_proveedor=$11,exento_impuestos=$12,activo=$13
        where id=$1 returning *`,
      [id, b.nombre, b.nombre_comercial ?? null, b.rtn, b.identidad, b.telefono ?? null, b.correo ?? null, b.direccion ?? null, b.notas ?? null, b.es_cliente, b.es_proveedor, b.exento_impuestos, b.activo])).rows[0];
    await auditar(db, req.ctx, 'tercero_editado', 'tercero', id, { nombre: t.nombre });
    res.json(t);
  });

  // Historial de compras del cliente en las empresas que el usuario puede ver.
  r.get('/:id/historial', requierePermiso('clientes:ver'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const visibles = req.ctx.usuario.es_dueno_grupo ? (await ctxMgr.empresasDe(req.ctx.usuario)).map((e) => e.id) : [req.ctx.empresa.id];
    const { rows } = await db.query(
      `select e.codigo as empresa, e.nombre as empresa_nombre, count(*)::int as compras, sum(v.total)::numeric as total, max(v.fecha_emision) as ultima
         from pos.ventas v join core.empresas e on e.id = v.empresa_id
        where v.cliente_id = $1 and v.estado = 'pagada' and v.empresa_id = any($2::uuid[]) group by e.codigo, e.nombre, e.orden order by e.orden`, [id, visibles]);
    res.json(rows);
  });

  return r;
}
