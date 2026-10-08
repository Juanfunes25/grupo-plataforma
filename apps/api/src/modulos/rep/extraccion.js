import { Router } from 'express';
import { z } from 'zod';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { ErrorHttp, malaPeticion, validar } from '../../lib/http.js';
import { errorDeTamano, extraerPesajeDeFoto, lecturaDisponible, registrarUsoIA } from './lib/extraccion.js';
import { empresaDe, sucursalDe } from './util.js';

/** Lectura de la hoja de pesaje por foto. Desactivada si el servidor no tiene ANTHROPIC_API_KEY. */
export function rutasExtraccion({ db }) {
  const r = Router();
  r.get('/estado', requierePermiso('rep:pesar'), (_req, res) => res.json({ disponible: lecturaDisponible() }));

  r.post('/:sucursalId', requierePermiso('rep:pesar'), async (req, res) => {
    if (!lecturaDisponible()) throw new ErrorHttp(503, 'La lectura por foto está desactivada: falta ANTHROPIC_API_KEY en el servidor. Carga el pesaje a mano.', 'extraccion_desactivada');
    const b = validar(z.object({ imageBase64: z.string().min(20, 'Falta la imagen'), mediaType: z.string().max(40).optional() }), req.body);
    const suc = await sucursalDe(db, req, req.params.sucursalId);
    const tam = errorDeTamano(b.imageBase64);
    if (tam) throw new ErrorHttp(413, tam);
    const permiso = registrarUsoIA(`${empresaDe(req)}|${req.ctx.usuario.id}`);
    if (!permiso.permitido) throw new ErrorHttp(429, permiso.motivo);
    const sabores = (await db.query(
      `select sa.id, sa.nombre from rep.sucursal_sabores ss join rep.sabores sa on sa.id = ss.sabor_id
        where ss.sucursal_id = $1 and ss.activo and sa.activo`, [suc.id])).rows;
    if (!sabores.length) throw malaPeticion('Esta sucursal no tiene sabores activos en su catálogo');
    let resultado;
    try { resultado = await extraerPesajeDeFoto({ imageBase64: b.imageBase64, mediaType: b.mediaType, nombresSabores: sabores.map((s) => s.nombre) }); }
    catch (e) { throw new ErrorHttp(502, e.message); }
    const idPorNombre = Object.fromEntries(sabores.map((s) => [s.nombre, s.id]));
    await auditar(db, req.ctx, 'pesaje.lectura_foto', 'sucursal', suc.id, { sucursal: suc.nombre, leidos: resultado.sabores.length, nuevos: resultado.sabores_nuevos.length }, { sucursalId: suc.id });
    res.json({ ...resultado, sabores: resultado.sabores.map((s) => ({ ...s, sabor_id: idPorNombre[s.nombre] ?? null })) });
  });
  return r;
}
