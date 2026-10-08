import { Router } from 'express';
import { z } from 'zod';
import { fechaHN } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { malaPeticion, noEncontrado, uuid, validar } from '../../lib/http.js';

// CAI del SAR: 32 hexadecimales en grupos 6-6-6-6-6-2.
const CAI_VALIDO = /^[0-9A-F]{6}(-[0-9A-F]{6}){4}-[0-9A-F]{2}$/;
export function normalizarCai(valor) {
  const t = String(valor ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (/^[0-9A-F]{32}$/.test(t)) return t.match(/.{1,6}/g).join('-');
  return String(valor ?? '').trim().toUpperCase();
}

export function estadoPunto(pe, hoy = fechaHN()) {
  const rango = pe.correlativo_hasta - pe.correlativo_desde + 1;
  const usados = pe.correlativo_actual - pe.correlativo_desde;
  const pct = rango > 0 ? Math.min(1, Math.max(0, usados / rango)) : 1;
  const dias = pe.fecha_limite_emision ? Math.round((Date.parse(pe.fecha_limite_emision) - Date.parse(hoy)) / 86_400_000) : null;
  const agotado = pe.correlativo_actual > pe.correlativo_hasta;
  const vencido = dias !== null && dias < 0;
  return { ...pe, porcentaje_usado: Math.round(pct * 1000) / 10, dias_restantes: dias, agotado, vencido, alerta: !pe.es_borrador && (pct >= 0.9 || (dias !== null && dias <= 15) || agotado || vencido) };
}

export function problemaCai(pe, hoy = fechaHN()) {
  if (!pe.cai || !CAI_VALIDO.test(pe.cai)) return 'El CAI debe tener el formato del SAR: 32 caracteres en grupos 6-6-6-6-6-2 (ej. 2F4851-96A881-B76670-CE6CCE-48D250-32)';
  if (!/^\d{3}$/.test(pe.punto_emision_codigo ?? '')) return 'El código de establecimiento debe tener 3 dígitos (ej. 001)';
  if (!/^\d{3}$/.test(pe.punto_venta_codigo ?? '')) return 'El código de punto de emisión debe tener 3 dígitos (ej. 001)';
  if (!/^\d{2}$/.test(pe.tipo_documento_codigo ?? '')) return 'El tipo de documento debe tener 2 dígitos (01 = factura)';
  const { correlativo_desde: d, correlativo_hasta: h, correlativo_actual: a } = pe;
  if (!Number.isInteger(d) || d < 1) return 'El rango "desde" debe ser un entero mayor que 0';
  if (!Number.isInteger(h) || h < d) return 'El rango "hasta" debe ser mayor o igual que "desde"';
  if (!Number.isInteger(a) || a < d || a > h) return `La próxima factura debe estar dentro del rango autorizado (${d} a ${h})`;
  if (!pe.fecha_limite_emision) return 'Falta la fecha límite de emisión de la resolución del SAR';
  if (pe.fecha_limite_emision < hoy) return 'La fecha límite de emisión ya pasó';
  return null;
}

export function rutasFiscal({ db }) {
  const r = Router();

  r.get('/', requierePermiso('pos:fiscal', 'pos:reportes'), async (req, res) => {
    const { rows } = await db.query(
      `select pe.*, s.nombre as sucursal from pos.puntos_emision pe join core.sucursales s on s.id = pe.sucursal_id
        where pe.empresa_id = $1 and pe.activo and ($2::uuid[] = '{}' or pe.sucursal_id = any($2::uuid[])) order by s.orden`, [req.ctx.empresa.id, req.ctx.sucursalIds]);
    res.json(rows.map((p) => estadoPunto(p)));
  });

  // Activa el CAI real (deja de ser borrador) o vuelve a modo borrador.
  r.put('/:id', requierePermiso('pos:fiscal'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(z.object({
      cai: z.string().optional().nullable(),
      punto_emision_codigo: z.string().optional(), punto_venta_codigo: z.string().optional(), tipo_documento_codigo: z.string().optional(),
      correlativo_desde: z.coerce.number().int().optional(), correlativo_hasta: z.coerce.number().int().optional(), correlativo_actual: z.coerce.number().int().optional(),
      fecha_limite_emision: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
      es_borrador: z.boolean().optional(),
    }), req.body);
    const out = await db.tx(async (q) => {
      const ant = (await q.query('select * from pos.puntos_emision where id = $1 and empresa_id = $2 for update', [id, req.ctx.empresa.id])).rows[0];
      if (!ant) throw noEncontrado();
      const nuevo = { ...ant, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
      if (b.cai !== undefined) nuevo.cai = b.cai ? normalizarCai(b.cai) : null;
      if (b.correlativo_desde !== undefined && b.correlativo_actual === undefined && ant.es_borrador) nuevo.correlativo_actual = b.correlativo_desde;
      if (!nuevo.es_borrador) { const p = problemaCai(nuevo); if (p) throw malaPeticion(p); }
      // Con facturas ya emitidas no se puede mover el correlativo hacia atrás: se repetirían números fiscales.
      if (nuevo.correlativo_actual < ant.correlativo_actual && !ant.es_borrador) throw malaPeticion('No se puede retroceder el correlativo de un CAI en uso');
      const p = (await q.query(
        `update pos.puntos_emision set cai=$2,punto_emision_codigo=$3,punto_venta_codigo=$4,tipo_documento_codigo=$5,correlativo_desde=$6,correlativo_hasta=$7,
                correlativo_actual=$8,fecha_limite_emision=$9,es_borrador=$10 where id=$1 returning *`,
        [id, nuevo.cai, nuevo.punto_emision_codigo, nuevo.punto_venta_codigo, nuevo.tipo_documento_codigo, nuevo.correlativo_desde, nuevo.correlativo_hasta,
          nuevo.correlativo_actual, nuevo.fecha_limite_emision, nuevo.es_borrador])).rows[0];
      await auditar(q, req.ctx, ant.es_borrador && !p.es_borrador ? 'cai_activado' : 'punto_emision_editado', 'punto_emision', id,
        { antes: { cai: ant.cai, borrador: ant.es_borrador, actual: ant.correlativo_actual }, despues: { cai: p.cai, borrador: p.es_borrador, actual: p.correlativo_actual } }, { sucursalId: p.sucursal_id });
      return p;
    });
    res.json(estadoPunto(out));
  });

  return r;
}
