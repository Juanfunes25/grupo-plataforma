import { Router } from 'express';
import { z } from 'zod';
import { requierePermiso, resolverSucursal } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { malaPeticion, noEncontrado, uuid, validar } from '../../lib/http.js';
import { empresaDe, texto } from './util.js';

const TIPOS = ['producto', 'equipo', 'temperatura', 'higiene', 'otro'];
const ESTADOS = ['abierta', 'en_revision', 'cerrada'];
// La foto viaja ya reducida desde el celular. El tope es la red de seguridad para un cliente viejo o un pedido armado a mano.
export const MAX_KB_FOTO = 400;
export const MAX_FOTOS = 3;

/** Tipo real de la imagen por sus primeros bytes (no se confía en lo que diga el cliente). */
export function mimeDe(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** Incidencias de calidad con foto. Reportar lo puede hacer una tienda; resolver es de fábrica. */
export function rutasIncidencias({ db }) {
  const r = Router();
  const reportar = requierePermiso('rep:pesar', 'rep:inventario', 'rep:producir');
  const gestionar = requierePermiso('rep:inventario', 'rep:producir');

  r.post('/', reportar, async (req, res) => {
    const b = validar(z.object({
      tipo: z.enum(TIPOS, { errorMap: () => ({ message: 'Tipo de incidencia inválido' }) }),
      gravedad: z.enum(['baja', 'media', 'alta']).catch('media'),
      descripcion: z.string().trim().min(5, 'Cuenta un poco más de qué pasó').max(2000),
      produccion_id: uuid.optional().nullable(), lote_id: uuid.optional().nullable(), sabor_id: uuid.optional().nullable(), sucursal_id: uuid.optional().nullable(),
      reportado_por: z.string().trim().max(80).optional().nullable(), fotos: z.array(z.string()).max(10).optional(),
    }), req.body);
    const fotos = (b.fotos ?? []).slice(0, MAX_FOTOS).map((f) => {
      const buf = Buffer.from(String(f).replace(/^data:[^,]*,/, ''), 'base64');
      const kb = buf.length / 1024;
      if (kb > MAX_KB_FOTO) throw malaPeticion(`Una foto pesa ${Math.round(kb)} KB y el máximo es ${MAX_KB_FOTO} KB`);
      const mime = mimeDe(buf);
      if (!mime) throw malaPeticion('Una de las fotos no es una imagen válida (JPG, PNG o WebP)');
      return { buf, mime };
    });
    // Una tienda solo puede reportar lo suyo; sin sucursal = pasó en fábrica.
    let sucursalId = null;
    if (b.sucursal_id) sucursalId = (await resolverSucursal(db, req.ctx, b.sucursal_id)).id;
    else if (req.ctx.sucursalIds.length === 1) sucursalId = req.ctx.sucursalIds[0];
    else if (req.ctx.sucursalIds.length > 1) throw malaPeticion('Elige la sucursal');
    const id = await db.tx(async (q) => {
      const i = (await q.query(
        `insert into rinv.incidencias (empresa_id, tipo, gravedad, sucursal_id, produccion_id, lote_id, sabor_id, descripcion, reportado_por, rol, usuario_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id, numero`,
        [empresaDe(req), b.tipo, b.gravedad, sucursalId, b.produccion_id ?? null, b.lote_id ?? null, b.sabor_id ?? null, b.descripcion, texto(b.reportado_por), req.ctx.rol, req.ctx.usuario.id])).rows[0];
      for (const f of fotos) await q.query('insert into rinv.incidencia_fotos (empresa_id, incidencia_id, imagen, mime) values ($1,$2,$3,$4)', [empresaDe(req), i.id, f.buf, f.mime]);
      await auditar(q, req.ctx, 'rinv.incidencia_reportada', 'incidencia', i.id, { tipo: b.tipo, gravedad: b.gravedad, fotos: fotos.length }, { sucursalId });
      return i.id;
    });
    res.status(201).json({ ok: true, id });
  });

  /** Por defecto solo las que siguen abiertas; las graves primero, no las más nuevas. */
  r.get('/', gestionar, async (req, res) => {
    const estado = ESTADOS.includes(req.query.estado) ? req.query.estado : null;
    const todas = req.query.todas === '1' || req.query.todas === 'true';
    res.json((await db.query(
      `select i.id, i.numero, i.tipo, i.gravedad, i.estado, i.descripcion, i.reportado_por, i.created_at as creado_en, i.sucursal_id, s.nombre as sucursal_nombre,
              i.produccion_id, p.lote as tanda_lote, i.lote_id, i.sabor_id, sa.nombre as sabor_nombre,
              (select count(*)::int from rinv.incidencia_fotos f where f.incidencia_id = i.id) as fotos
         from rinv.incidencias i left join core.sucursales s on s.id = i.sucursal_id left join prod.producciones p on p.id = i.produccion_id left join rep.sabores sa on sa.id = i.sabor_id
        where i.empresa_id = $1 and ($2::text is null or i.estado = $2) and ($2::text is not null or $3 or i.estado <> 'cerrada')
          and ($4::uuid is null or i.produccion_id = $4) and ($5::uuid is null or i.lote_id = $5)
        order by case i.gravedad when 'alta' then 0 when 'media' then 1 else 2 end, i.created_at desc limit 100`,
      [empresaDe(req), estado, todas, req.query.produccion_id || null, req.query.lote_id || null])).rows);
  });

  r.get('/abiertas/conteo', gestionar, async (req, res) => {
    const f = (await db.query(`select count(*)::int as n, count(*) filter (where gravedad = 'alta')::int as altas from rinv.incidencias where empresa_id = $1 and estado <> 'cerrada'`, [empresaDe(req)])).rows[0];
    res.json({ abiertas: f.n, altas: f.altas });
  });

  /** El detalle, con las fotos (base64). Es la única consulta que las trae. */
  r.get('/:id', gestionar, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const i = (await db.query(
      `select i.*, i.created_at as creado_en, s.nombre as sucursal_nombre, p.lote as tanda_lote, p.fecha::text as tanda_fecha, sa.nombre as sabor_nombre, ci.nombre as insumo_nombre
         from rinv.incidencias i left join core.sucursales s on s.id = i.sucursal_id left join prod.producciones p on p.id = i.produccion_id left join rep.sabores sa on sa.id = i.sabor_id
         left join rinv.lotes_mec3 l on l.id = i.lote_id left join rinv.insumos_fab ci on ci.id = l.insumo_id where i.id = $1 and i.empresa_id = $2`, [id, empresaDe(req)])).rows[0];
    if (!i) throw noEncontrado('Incidencia no encontrada');
    const fotos = (await db.query('select id, mime, imagen from rinv.incidencia_fotos where incidencia_id = $1 order by n', [id])).rows;
    res.json({ ...i, fotos: fotos.map((f) => ({ id: f.id, mime: f.mime, imagen: Buffer.from(f.imagen).toString('base64') })) });
  });

  /** Cerrar SIN escribir la resolución no se permite: una incidencia cerrada en blanco es lo mismo que borrada. */
  r.patch('/:id', gestionar, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(z.object({ estado: z.enum(ESTADOS, { errorMap: () => ({ message: 'Estado inválido' }) }), resolucion: z.string().trim().max(2000).optional().nullable(), cerrado_por: z.string().trim().max(80).optional().nullable() }), req.body);
    const res_ = texto(b.resolucion);
    if (b.estado === 'cerrada' && (res_ ?? '').length < 5) throw malaPeticion('Para cerrarla, escribe qué se hizo');
    const { rows } = await db.query(
      `update rinv.incidencias set estado = $3, resolucion = $4, cerrado_por = $5, cerrado_en = case when $3 = 'cerrada' then now() else null end where id = $1 and empresa_id = $2 returning id`,
      [id, empresaDe(req), b.estado, res_, texto(b.cerrado_por) ?? req.ctx.usuario.nombre]);
    if (!rows[0]) throw noEncontrado('Incidencia no encontrada');
    await auditar(db, req.ctx, `rinv.incidencia_${b.estado}`, 'incidencia', id, { resolucion: res_ });
    res.json({ ok: true });
  });

  return r;
}
