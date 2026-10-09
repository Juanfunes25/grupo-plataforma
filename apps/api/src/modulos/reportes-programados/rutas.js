import { Router } from 'express';
import { z } from 'zod';
import { fechaHN } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { estadoCorreo, normalizarDestinatarios } from '../../lib/correo.js';
import { malaPeticion, noEncontrado, prohibido, uuid, validar, fechaISO } from '../../lib/http.js';
import { CATALOGO, generarReporte, listarCatalogo } from './catalogo.js';
import { armarArchivos, correrProgramado, empresasConsolidablesDe, FORMATOS } from './servicio.js';

const parametros = z.object({
  dia: z.enum(['hoy', 'ayer']).optional(), dias: z.coerce.number().int().min(1).max(90).optional(), sucursal_id: uuid.optional(),
  fecha: fechaISO.optional(), desde: fechaISO.optional(), hasta: fechaISO.optional(),
}).strict();
const programacion = z.object({
  nombre: z.string().trim().min(2, 'Ponle un nombre').max(120),
  tipo: z.string().trim(),
  parametros: parametros.default({}),
  frecuencia: z.enum(['diario', 'semanal']),
  dia_semana: z.coerce.number().int().min(1).max(7).optional().nullable(),
  hora: z.coerce.number().int().min(0).max(23),
  destinatarios: z.union([z.string(), z.array(z.string())]),
  formatos: z.array(z.enum(FORMATOS)).min(1, 'Elige Excel, PDF o ambos').max(2),
  activo: z.boolean().default(true),
});

const MODULO_VISIBLE = (ctx, def) => !def.modulo || ctx.modulos.some((m) => m.id === def.modulo);

/** /api/reportes-programados — programar reportes por correo y exportarlos a Excel/PDF. */
export function rutasReportesProgramados({ db }) {
  const r = Router();
  const programar = requierePermiso('reportes:programar');

  /** Reportes del catálogo que ESTE usuario puede pedir en la empresa activa. */
  const disponibles = (ctx) => listarCatalogo().filter((d) => ctx.permisos.has(d.permiso) && MODULO_VISIBLE(ctx, CATALOGO[d.id]) && (d.ambito !== 'grupo' || ctx.permisos.has('grupo:ver')));
  function defDe(ctx, tipo) {
    const def = CATALOGO[tipo];
    if (!def) throw malaPeticion('Ese reporte no existe');
    if (!ctx.permisos.has(def.permiso) || !MODULO_VISIBLE(ctx, def)) throw prohibido('No tienes permiso para ese reporte');
    if (def.ambito === 'grupo' && !ctx.permisos.has('grupo:ver')) throw prohibido('Solo Dirección puede programar el resumen del grupo');
    return def;
  }
  async function revisarSucursal(ctx, p) {
    if (!p.sucursal_id) return;
    const ok = await db.query('select 1 from core.sucursales where id = $1 and empresa_id = $2', [p.sucursal_id, ctx.empresa.id]);
    if (!ok.rowCount) throw malaPeticion('Esa sucursal no es de esta empresa');
    if (ctx.sucursalIds.length && !ctx.sucursalIds.includes(p.sucursal_id)) throw prohibido('No tienes acceso a esa sucursal');
  }
  function destinatarios(texto) {
    const { validos, invalidos } = normalizarDestinatarios(texto);
    if (invalidos.length) throw malaPeticion(`Correo no válido: ${invalidos[0]}`);
    if (!validos.length) throw malaPeticion('Escribe al menos un correo de destino');
    if (validos.length > 10) throw malaPeticion('Máximo 10 destinatarios por reporte');
    return validos;
  }
  const filaPublica = (p) => ({ ...p });

  r.get('/catalogo', (req, res) => res.json({ reportes: disponibles(req.ctx), correo: estadoCorreo() }));

  // Vista previa en pantalla (misma estructura que se convierte a Excel/PDF), sin enviar nada.
  r.get('/previa', async (req, res) => {
    const tipo = String(req.query.tipo ?? '');
    const def = defDe(req.ctx, tipo);
    const { tipo: _t, formato: _f, ...crudo } = req.query;
    const p = validar(parametros, crudo);
    await revisarSucursal(req.ctx, p);
    res.json(await generar(req, tipo, def, p));
  });

  async function generar(req, tipo, def, p) {
    const empresasGrupo = def.ambito === 'grupo' ? await empresasConsolidablesDe(db, req.ctx.usuario.id) : [];
    return generarReporte(tipo, { db, empresa: req.ctx.empresa, sucursalIds: req.ctx.sucursalIds, hoy: fechaHN(), params: p, restringidos: req.ctx.rol === 'dueno' || req.ctx.rol === 'admin', empresasGrupo });
  }

  // Exportación manual (botones «Excel» y «PDF» de las pantallas de reportes). Solo pide el permiso del propio reporte.
  r.get('/exportar', async (req, res) => {
    const tipo = String(req.query.tipo ?? '');
    const formato = validar(z.enum(FORMATOS), req.query.formato);
    const def = defDe(req.ctx, tipo);
    const { tipo: _t, formato: _f, ...crudo } = req.query;
    const p = validar(parametros, crudo);
    await revisarSucursal(req.ctx, p);
    const rep = await generar(req, tipo, def, p);
    const [archivo] = await armarArchivos(rep, [formato], { nombreBase: `${tipo}-${req.ctx.empresa.codigo}` });
    await auditar(db, req.ctx, 'reporte.exportar', 'reporte', tipo, { formato, parametros: p });
    res.setHeader('Content-Type', archivo.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${archivo.nombre}"`);
    res.send(archivo.contenido);
  });

  async function validarProgramacion(req, b) {
    const def = defDe(req.ctx, b.tipo);
    await revisarSucursal(req.ctx, b.parametros);
    if (b.frecuencia === 'semanal' && !b.dia_semana) throw malaPeticion('Elige el día de la semana');
    return { def, destinos: destinatarios(b.destinatarios), ambito: def.ambito === 'grupo' ? 'grupo' : 'empresa' };
  }

  r.get('/', programar, async (req, res) => {
    const grupo = req.ctx.permisos.has('grupo:ver');
    const { rows } = await db.query(
      `select p.*, u.nombre as creado_por_nombre, x.fecha as ultima_fecha, x.estado as ultimo_estado, x.detalle as ultimo_detalle, x.terminado_at as ultimo_at
         from rprog.programados p left join core.usuarios u on u.id = p.creado_por
         left join lateral (select fecha, estado, detalle, terminado_at from rprog.ejecuciones e where e.programado_id = p.id order by fecha desc limit 1) x on true
        where p.empresa_id = $1 and (p.ambito = 'empresa' or ($2::boolean and (p.creado_por = $3 or $4::boolean)))
        order by p.activo desc, p.hora, p.nombre`, [req.ctx.empresa.id, grupo, req.ctx.usuario.id, req.ctx.usuario.es_dueno_grupo]);
    res.json(rows.map(filaPublica));
  });

  r.post('/', programar, async (req, res) => {
    const b = validar(programacion, req.body);
    const { destinos, ambito } = await validarProgramacion(req, b);
    const { rows } = await db.query(
      `insert into rprog.programados (empresa_id, ambito, nombre, tipo, parametros, frecuencia, dia_semana, hora, destinatarios, formatos, activo, creado_por)
       values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12) returning *`,
      [req.ctx.empresa.id, ambito, b.nombre, b.tipo, JSON.stringify(b.parametros), b.frecuencia, b.frecuencia === 'semanal' ? b.dia_semana : null, b.hora, destinos, b.formatos, b.activo, req.ctx.usuario.id]);
    await auditar(db, req.ctx, 'reporte_programado.crear', 'reporte_programado', rows[0].id, { nombre: b.nombre, tipo: b.tipo, destinatarios: destinos.length });
    res.status(201).json(filaPublica(rows[0]));
  });

  async function cargar(req) {
    const id = validar(uuid, req.params.id);
    const p = (await db.query('select * from rprog.programados where id = $1 and empresa_id = $2', [id, req.ctx.empresa.id])).rows[0];
    if (!p || (p.ambito === 'grupo' && !req.ctx.permisos.has('grupo:ver'))) throw noEncontrado('Reporte programado no encontrado');
    return p;
  }

  r.put('/:id', programar, async (req, res) => {
    const actual = await cargar(req);
    const b = validar(programacion, req.body);
    const { destinos, ambito } = await validarProgramacion(req, b);
    const { rows } = await db.query(
      `update rprog.programados set ambito=$2, nombre=$3, tipo=$4, parametros=$5::jsonb, frecuencia=$6, dia_semana=$7, hora=$8, destinatarios=$9, formatos=$10, activo=$11, creado_por=$12, updated_at=now()
        where id=$1 returning *`,
      [actual.id, ambito, b.nombre, b.tipo, JSON.stringify(b.parametros), b.frecuencia, b.frecuencia === 'semanal' ? b.dia_semana : null, b.hora, destinos, b.formatos, b.activo, req.ctx.usuario.id]);
    await auditar(db, req.ctx, 'reporte_programado.editar', 'reporte_programado', actual.id, { nombre: b.nombre, tipo: b.tipo, activo: b.activo });
    res.json(filaPublica(rows[0]));
  });

  r.delete('/:id', programar, async (req, res) => {
    const p = await cargar(req);
    await db.query('delete from rprog.programados where id = $1', [p.id]);
    await auditar(db, req.ctx, 'reporte_programado.borrar', 'reporte_programado', p.id, { nombre: p.nombre });
    res.json({ ok: true });
  });

  // «Enviar ahora»: genera y manda en este momento (no cuenta como la ejecución del día).
  r.post('/:id/enviar-ahora', programar, async (req, res) => {
    const p = await cargar(req);
    const resultado = await correrProgramado(db, p, { forzar: true });
    await auditar(db, req.ctx, 'reporte_programado.enviar_ahora', 'reporte_programado', p.id, { nombre: p.nombre, estado: resultado.estado });
    res.json(resultado);
  });

  r.get('/:id/ejecuciones', programar, async (req, res) => {
    const p = await cargar(req);
    const { rows } = await db.query('select id, fecha, estado, intentos, detalle, destinatarios, archivos, iniciado_at, terminado_at from rprog.ejecuciones where programado_id = $1 order by fecha desc limit 30', [p.id]);
    res.json(rows);
  });

  return r;
}

