import express, { Router } from 'express';
import { z } from 'zod';
import { fechaHN, GRUPOS_DOC, MAX_ARCHIVO_BYTES } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { ErrorHttp, conflicto, malaPeticion, noEncontrado, prohibido, uuid, validar } from '../../lib/http.js';
import { aBuffer, esPrevisualizable, validarArchivo } from './archivos.js';
import { asegurarTipos, checklist, columnasDoc, kpis, proximos, unionesDoc, veRestringidos } from './servicio.js';

const fechaReal = (s) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha inválida (AAAA-MM-DD)').refine(fechaReal, 'fecha inválida');
// Opcionales con semántica de PATCH: undefined = no tocar; null o '' = borrar el valor.
const opc = (zod) => z.union([z.literal('').transform(() => null), z.null(), zod]).optional();
const texto = (n) => opc(z.string().trim().max(n)).transform((v) => (v === undefined ? undefined : v || null));

const esqDoc = z.object({
  tipo: z.string().trim().min(2).max(40),
  titulo: z.string().trim().min(2, 'El título es obligatorio').max(200),
  descripcion: texto(2000), numero: texto(80), entidad_emisora: texto(160), contraparte: texto(160),
  fecha_emision: opc(fecha), fecha_vencimiento: opc(fecha),
  dias_aviso: z.coerce.number().int().min(0).max(730).optional(),
  sucursal_id: opc(uuid), empleado_id: opc(uuid),
  monto: opc(z.coerce.number().finite().min(0).max(999_999_999_999)),
  etiquetas: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  confidencialidad: z.enum(['normal', 'restringido']).optional(),
});
const esqEdicion = esqDoc.partial();
const esqNota = z.object({ nota: texto(300), nombre: z.string().max(300).optional() });
const esqMotivo = z.object({ motivo: z.string().trim().min(3, 'Escribe el motivo (mínimo 3 letras)').max(300) });

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 36);
const esqTipo = z.object({
  nombre: z.string().trim().min(2).max(120), grupo: z.enum(Object.keys(GRUPOS_DOC)).default('otro'),
  requiere_vencimiento: z.boolean().default(true), confidencial: z.boolean().default(false),
  dias_aviso: z.coerce.number().int().min(0).max(730).default(30),
  de_empleado: z.boolean().default(false), esperado: z.boolean().default(false), por_sucursal: z.boolean().default(false),
});

/** Rutas /api/documentos — documentos de la empresa activa (contratos, permisos, registros…). */
export function rutasDocumentos({ db }) {
  const r = Router();
  const hoyHN = () => fechaHN();
  const ver = requierePermiso('doc:ver');
  const editar = requierePermiso('doc:editar');
  const empresa = (req) => req.ctx.empresa.id;

  /** Documento visible para el usuario (empresa activa, no borrado, confidencialidad y sucursal). */
  async function cargar(q, req, id, { bloquear = false } = {}) {
    const { rows } = await q.query(
      `select d.* from doc.documentos d where d.id = $1 and d.empresa_id = $2 and d.eliminado_at is null ${bloquear ? 'for update' : ''}`, [validar(uuid, id), empresa(req)]);
    const d = rows[0];
    if (!d || (d.confidencialidad === 'restringido' && !veRestringidos(req.ctx))
      || (d.sucursal_id && req.ctx.sucursalIds.length && !req.ctx.sucursalIds.includes(d.sucursal_id))) throw noEncontrado('Documento no encontrado');
    return d;
  }
  async function ficha(q, req, id) {
    const { rows } = await q.query(`select ${columnasDoc('$3')} ${unionesDoc} where d.id = $1 and d.empresa_id = $2`, [id, empresa(req), hoyHN()]);
    return rows[0];
  }
  async function tipoDe(q, req, codigo, { soloActivo = true } = {}) {
    await asegurarTipos(q, req.ctx.empresa);
    const t = (await q.query(`select * from doc.tipos where empresa_id = $1 and codigo = $2 ${soloActivo ? 'and activo' : ''}`, [empresa(req), codigo])).rows[0];
    if (!t) throw malaPeticion('Ese tipo de documento no existe en esta empresa');
    return t;
  }
  async function revisarVinculos(q, req, b) {
    if (b.sucursal_id) {
      if (!(await q.query('select 1 from core.sucursales where id = $1 and empresa_id = $2', [b.sucursal_id, empresa(req)])).rowCount) throw malaPeticion('La sucursal no es de esta empresa');
    }
    if (b.empleado_id) {
      if (!(await q.query('select 1 from rrhh.empleados where id = $1 and empresa_id = $2', [b.empleado_id, empresa(req)])).rowCount) throw malaPeticion('El empleado no es de esta empresa');
    }
    if (b.fecha_emision && b.fecha_vencimiento && b.fecha_vencimiento < b.fecha_emision) throw malaPeticion('El vencimiento no puede ser anterior a la emisión');
  }

  // ═════════════════════════ Tipos (lista configurable por empresa) ═════════════════════════
  r.get('/tipos', ver, async (req, res) => {
    await asegurarTipos(db, req.ctx.empresa);
    const { rows } = await db.query(
      `select t.*, (select count(*)::int from doc.documentos d where d.empresa_id = t.empresa_id and d.tipo = t.codigo and d.eliminado_at is null) as documentos
         from doc.tipos t where t.empresa_id = $1 order by t.activo desc, t.orden, t.nombre`, [empresa(req)]);
    res.json({ tipos: rows, grupos: GRUPOS_DOC });
  });
  r.post('/tipos', editar, async (req, res) => {
    const b = validar(esqTipo, req.body);
    await asegurarTipos(db, req.ctx.empresa);
    const codigo = slug(b.nombre);
    if (codigo.length < 2) throw malaPeticion('Ese nombre no es válido');
    const t = (await db.query(
      `insert into doc.tipos (empresa_id,codigo,nombre,grupo,requiere_vencimiento,confidencial,dias_aviso,de_empleado,esperado,por_sucursal,orden)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,(select coalesce(max(orden),0)+1 from doc.tipos where empresa_id = $1)) returning *`,
      [empresa(req), codigo, b.nombre, b.grupo, b.requiere_vencimiento, b.confidencial, b.dias_aviso, b.de_empleado, b.esperado, b.por_sucursal])).rows[0];
    await auditar(db, req.ctx, 'documento.tipo_crear', 'doc_tipo', t.id, { codigo, nombre: b.nombre });
    res.status(201).json(t);
  });
  r.put('/tipos/:codigo', editar, async (req, res) => {
    const b = validar(esqTipo.partial().extend({ activo: z.boolean().optional() }), req.body);
    await asegurarTipos(db, req.ctx.empresa);
    const campos = Object.entries(b).filter(([, v]) => v !== undefined);
    if (!campos.length) throw malaPeticion('Nada que cambiar');
    const set = campos.map(([k], i) => `${k} = $${i + 3}`).join(', ');
    const t = (await db.query(`update doc.tipos set ${set} where empresa_id = $1 and codigo = $2 returning *`, [empresa(req), req.params.codigo, ...campos.map(([, v]) => v)])).rows[0];
    if (!t) throw noEncontrado('Tipo no encontrado');
    await auditar(db, req.ctx, 'documento.tipo_editar', 'doc_tipo', t.id, { codigo: t.codigo, cambios: b });
    res.json(t);
  });

  // ═════════════════════════ Tablero ═════════════════════════
  r.get('/resumen', ver, async (req, res) => {
    const hoy = hoyHN();
    const o = { hoy, verRestringido: veRestringidos(req.ctx), sucursalIds: req.ctx.sucursalIds };
    const [k, cl] = await Promise.all([kpis(db, empresa(req), o), checklist(db, req.ctx.empresa, o)]);
    res.json({ hoy, kpis: k, checklist: cl });
  });
  r.get('/checklist', ver, async (req, res) => {
    res.json(await checklist(db, req.ctx.empresa, { hoy: hoyHN(), verRestringido: veRestringidos(req.ctx), sucursalIds: req.ctx.sucursalIds }));
  });
  /** Alertas de vencimiento: vencidos y los que vencen en 30 / 60 / 90 días. */
  r.get('/alertas', ver, async (req, res) => {
    const hoy = hoyHN();
    const filas = await proximos(db, empresa(req), { hoy, dias: 90, verRestringido: veRestringidos(req.ctx), sucursalIds: req.ctx.sucursalIds });
    const por = (f) => filas.filter((d) => d.franja === f);
    res.json({ hoy, vencidos: por('vencido'), d30: por('d30'), d60: por('d60'), d90: por('d90'), total: filas.length });
  });

  // ═════════════════════════ Listado y ficha ═════════════════════════
  const esqLista = z.object({
    q: z.string().trim().max(100).optional(), tipo: z.string().max(40).optional(), sucursal_id: uuid.optional(), empleado_id: uuid.optional(),
    estado: z.enum(['vigente', 'por_vencer', 'vencido', 'archivado', 'activos', 'todos']).default('activos'),
    vence_en: z.coerce.number().int().min(0).max(3650).optional(),
    orden: z.enum(['vencimiento', 'reciente', 'titulo']).default('vencimiento'),
    limite: z.coerce.number().int().min(1).max(300).default(100), desde: z.coerce.number().int().min(0).default(0),
  });
  r.get('/', ver, async (req, res) => {
    const f = validar(esqLista, req.query);
    const hoy = hoyHN();
    const p = [empresa(req), hoy, veRestringidos(req.ctx), req.ctx.sucursalIds];
    const w = [`d.empresa_id = $1`, `d.eliminado_at is null`, `($3::boolean or d.confidencialidad = 'normal')`, `($4::uuid[] = '{}' or d.sucursal_id is null or d.sucursal_id = any($4::uuid[]))`];
    const add = (v) => { p.push(v); return `$${p.length}`; };
    if (f.q) { const x = add(`%${f.q.replace(/[%_\\]/g, '\\$&')}%`); w.push(`(d.titulo ilike ${x} or d.numero ilike ${x} or d.entidad_emisora ilike ${x} or d.contraparte ilike ${x} or d.descripcion ilike ${x} or array_to_string(d.etiquetas, ' ') ilike ${x})`); }
    if (f.tipo) w.push(`d.tipo = ${add(f.tipo)}`);
    if (f.sucursal_id) w.push(`d.sucursal_id = ${add(f.sucursal_id)}`);
    if (f.empleado_id) w.push(`d.empleado_id = ${add(f.empleado_id)}`);
    if (f.vence_en !== undefined) w.push(`d.fecha_vencimiento between $2::date and $2::date + ${add(f.vence_en)}::int`);
    if (f.estado === 'activos') w.push('not d.archivado');
    else if (f.estado !== 'todos') w.push(`${columnasDocEstado()} = ${add(f.estado)}`);
    const orden = { vencimiento: 'd.fecha_vencimiento asc nulls last, d.titulo', reciente: 'd.updated_at desc', titulo: 'lower(d.titulo)' }[f.orden];
    const donde = w.join(' and ');
    const [filas, total] = await Promise.all([
      db.query(`select ${columnasDoc('$2')} ${unionesDoc} where ${donde} order by ${orden} limit ${add(f.limite)} offset ${add(f.desde)}`, p),
      db.query(`select count(*)::int as n from doc.documentos d where ${donde} and $2::date is not null`, p.slice(0, p.length - 2)),
    ]);
    res.json({ filas: filas.rows, total: total.rows[0].n });
  });
  const columnasDocEstado = () => `(case when d.archivado then 'archivado' when d.fecha_vencimiento is null then 'vigente' when d.fecha_vencimiento < $2::date then 'vencido' when d.fecha_vencimiento <= $2::date + d.dias_aviso then 'por_vencer' else 'vigente' end)`;

  r.get('/:id', ver, async (req, res) => {
    const d = await cargar(db, req, req.params.id);
    const versiones = (await db.query(
      `select id, numero, nombre_archivo, mime, extension, tamano, sha256, nota, subido_por_nombre, purgada, created_at from doc.versiones where documento_id = $1 order by numero desc`, [d.id])).rows;
    res.json({ ...(await ficha(db, req, d.id)), versiones });
  });
  r.get('/:id/versiones', ver, async (req, res) => {
    const d = await cargar(db, req, req.params.id);
    res.json((await db.query(
      `select id, numero, nombre_archivo, mime, extension, tamano, sha256, nota, subido_por_nombre, purgada, created_at from doc.versiones where documento_id = $1 order by numero desc`, [d.id])).rows);
  });

  // ═════════════════════════ Crear / editar ═════════════════════════
  /** Inserta el documento (sin archivo). `q` es la transacción. */
  async function insertarDocumento(q, req, b) {
    const t = await tipoDe(q, req, b.tipo);
    await revisarVinculos(q, req, b);
    const conf = b.confidencialidad ?? (t.confidencial || b.empleado_id ? 'restringido' : 'normal');
    if (conf === 'normal' && b.confidencialidad === 'normal' && t.confidencial && !veRestringidos(req.ctx)) throw prohibido('Solo el dueño o el administrador pueden marcar este documento como normal');
    const d = (await q.query(
      `insert into doc.documentos (empresa_id,tipo,titulo,descripcion,numero,entidad_emisora,fecha_emision,fecha_vencimiento,dias_aviso,sucursal_id,empleado_id,contraparte,monto,etiquetas,confidencialidad,creado_por)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning *`,
      [empresa(req), b.tipo, b.titulo, b.descripcion ?? null, b.numero ?? null, b.entidad_emisora ?? null, b.fecha_emision ?? null, b.fecha_vencimiento ?? null, b.dias_aviso ?? t.dias_aviso,
        b.sucursal_id ?? null, b.empleado_id ?? null, b.contraparte ?? null, b.monto ?? null, b.etiquetas ?? [], conf, req.ctx.usuario.id])).rows[0];
    await auditar(q, req.ctx, 'documento.crear', 'documento', d.id, { titulo: d.titulo, tipo: d.tipo, empleado_id: d.empleado_id, confidencialidad: conf, vence: d.fecha_vencimiento }, { sucursalId: d.sucursal_id });
    return d;
  }

  /** Agrega una versión nueva (la anterior queda en el historial). `q` es la transacción y el documento va bloqueado. */
  async function insertarVersion(q, req, d, buf, nombre, { nota = null, cambios = {} } = {}) {
    const a = validarArchivo(buf, nombre);
    if (d.archivado) throw conflicto('El documento está archivado; restáuralo antes de subir una versión nueva');
    const actual = (await q.query('select sha256 from doc.versiones where documento_id = $1 and numero = $2', [d.id, d.version_actual])).rows[0];
    if (actual && actual.sha256 === a.sha256) throw conflicto('Ese archivo ya es la versión actual del documento');
    const numero = d.version_actual + 1;
    const v = (await q.query(
      `insert into doc.versiones (documento_id,empresa_id,numero,nombre_archivo,mime,extension,tamano,sha256,nota,subido_por,subido_por_nombre)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id, numero, nombre_archivo, mime, tamano`,
      [d.id, d.empresa_id, numero, a.nombre, a.mime, a.extension, a.tamano, a.sha256, nota, req.ctx.usuario.id, req.ctx.usuario.nombre])).rows[0];
    await q.query('insert into doc.archivos (version_id, empresa_id, contenido) values ($1,$2,$3)', [v.id, d.empresa_id, buf]);
    const campos = Object.entries(cambios).filter(([, x]) => x !== undefined);
    const set = ['version_actual = $2', 'updated_at = now()', ...campos.map(([k], i) => `${k} = $${i + 3}`)];
    await q.query(`update doc.documentos set ${set.join(', ')} where id = $1`, [d.id, numero, ...campos.map(([, x]) => x)]);
    await auditar(q, req.ctx, 'documento.subir', 'documento', d.id, { titulo: d.titulo, version: numero, archivo: a.nombre, tamano: a.tamano, sha256: a.sha256, confidencialidad: d.confidencialidad }, { sucursalId: d.sucursal_id });
    return v;
  }

  r.post('/', editar, async (req, res) => {
    const b = validar(esqDoc, req.body);
    const d = await db.tx((q) => insertarDocumento(q, req, b));
    res.status(201).json(await ficha(db, req, d.id));
  });

  const CAMPOS_EDITABLES = ['tipo', 'titulo', 'descripcion', 'numero', 'entidad_emisora', 'fecha_emision', 'fecha_vencimiento', 'dias_aviso', 'sucursal_id', 'empleado_id', 'contraparte', 'monto', 'etiquetas', 'confidencialidad'];
  r.put('/:id', editar, async (req, res) => {
    const b = validar(esqEdicion, req.body);
    const r2 = await db.tx(async (q) => {
      const d = await cargar(q, req, req.params.id, { bloquear: true });
      if (b.tipo && b.tipo !== d.tipo) await tipoDe(q, req, b.tipo);
      const final = { ...d, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
      await revisarVinculos(q, req, final);
      if (b.confidencialidad === 'normal' && d.confidencialidad === 'restringido' && !veRestringidos(req.ctx)) throw prohibido('Solo el dueño o el administrador pueden quitar la restricción');
      const campos = CAMPOS_EDITABLES.filter((k) => b[k] !== undefined);
      if (!campos.length) throw malaPeticion('Nada que cambiar');
      const antes = {}, despues = {};
      for (const k of campos) if (JSON.stringify(d[k]) !== JSON.stringify(b[k])) { antes[k] = d[k]; despues[k] = b[k]; }
      await q.query(`update doc.documentos set ${campos.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [d.id, ...campos.map((k) => b[k])]);
      if (Object.keys(despues).length) await auditar(q, req.ctx, 'documento.editar', 'documento', d.id, { titulo: d.titulo, antes, despues }, { sucursalId: final.sucursal_id });
      return d.id;
    });
    res.json(await ficha(db, req, r2));
  });

  // ═════════════════════════ Archivos ═════════════════════════
  // Subida cruda (sin multipart): el cuerpo ES el archivo; los datos van en la URL. Límite de 15 MB SOLO en estas rutas
  // (el resto del API sigue con el límite global de app.js). Se valida el contenido real, no solo la extensión.
  const cuerpoArchivo = (req, _res, next) => {
    const largo = Number(req.headers['content-length'] ?? 0);
    if (largo > MAX_ARCHIVO_BYTES) return next(new ErrorHttp(413, 'El archivo supera el máximo de 15 MB', 'archivo_grande'));
    return express.raw({ type: () => true, limit: MAX_ARCHIVO_BYTES })(req, _res, (err) => {
      if (err?.type === 'entity.too.large') return next(new ErrorHttp(413, 'El archivo supera el máximo de 15 MB', 'archivo_grande'));
      next(err);
    });
  };
  const nombreDe = (req) => {
    if (req.query.nombre) return String(req.query.nombre);
    const n = String(req.get('x-nombre-archivo') ?? '');
    try { return decodeURIComponent(n); } catch { return n; }
  };

  /** Crea el documento Y su primer archivo en una sola llamada. Datos del documento en la URL (?tipo=&titulo=&nombre=…). */
  r.post('/subir', editar, cuerpoArchivo, async (req, res) => {
    const qy = req.query;
    const b = validar(esqDoc, {
      tipo: qy.tipo, titulo: qy.titulo || nombreDe(req).replace(/\.[^.]+$/, ''), descripcion: qy.descripcion, numero: qy.numero, entidad_emisora: qy.entidad_emisora,
      contraparte: qy.contraparte, fecha_emision: qy.fecha_emision, fecha_vencimiento: qy.fecha_vencimiento, dias_aviso: qy.dias_aviso || undefined,
      sucursal_id: qy.sucursal_id, empleado_id: qy.empleado_id, monto: qy.monto, confidencialidad: qy.confidencialidad || undefined,
      etiquetas: qy.etiquetas ? String(qy.etiquetas).split(',').map((x) => x.trim()).filter(Boolean) : undefined,
    });
    validarArchivo(req.body, nombreDe(req));          // falla antes de crear nada
    const out = await db.tx(async (q) => {
      const d = await insertarDocumento(q, req, b);
      await insertarVersion(q, req, d, req.body, nombreDe(req), { nota: qy.nota ? String(qy.nota).slice(0, 300) : null });
      return d.id;
    });
    res.status(201).json(await ficha(db, req, out));
  });

  /** Sube una versión nueva de un documento. Opcional: renueva fechas/número (?fecha_vencimiento=&fecha_emision=&numero=&nota=). */
  r.post('/:id/archivo', editar, cuerpoArchivo, async (req, res) => {
    const qy = validar(z.object({ nota: texto(300), fecha_vencimiento: opc(fecha), fecha_emision: opc(fecha), numero: texto(80) }), req.query);
    validarArchivo(req.body, nombreDe(req));
    const id = await db.tx(async (q) => {
      const d = await cargar(q, req, req.params.id, { bloquear: true });
      const cambios = { fecha_vencimiento: qy.fecha_vencimiento, fecha_emision: qy.fecha_emision, numero: qy.numero };
      await revisarVinculos(q, req, { fecha_emision: qy.fecha_emision ?? d.fecha_emision, fecha_vencimiento: qy.fecha_vencimiento ?? d.fecha_vencimiento });
      await insertarVersion(q, req, d, req.body, nombreDe(req), { nota: qy.nota ?? null, cambios });
      return d.id;
    });
    res.status(201).json(await ficha(db, req, id));
  });

  /** Descarga o vista previa. ?version=N (por defecto la actual) · ?inline=1 para ver PDF e imágenes en pantalla. */
  r.get('/:id/archivo', ver, async (req, res) => {
    const { version, inline } = validar(z.object({ version: z.coerce.number().int().min(1).optional(), inline: z.enum(['1', 'true']).optional() }), req.query);
    const d = await cargar(db, req, req.params.id);
    const num = version ?? d.version_actual;
    const v = (await db.query(
      `select v.id, v.numero, v.nombre_archivo, v.mime, v.tamano, v.purgada, a.contenido from doc.versiones v left join doc.archivos a on a.version_id = v.id
        where v.documento_id = $1 and v.numero = $2`, [d.id, num])).rows[0];
    if (!v) throw noEncontrado(d.version_actual === 0 ? 'Este documento todavía no tiene archivo' : 'Esa versión no existe');
    if (v.purgada || !v.contenido) throw noEncontrado('El archivo de esta versión ya no está disponible');
    if (d.confidencialidad === 'restringido') {
      await auditar(db, req.ctx, 'documento.descargar', 'documento', d.id, { titulo: d.titulo, version: v.numero, archivo: v.nombre_archivo, vista: Boolean(inline) }, { sucursalId: d.sucursal_id });
    }
    const buf = aBuffer(v.contenido);
    const enLinea = Boolean(inline) && esPrevisualizable(v.mime);
    res.set({
      'Content-Type': v.mime, 'Content-Length': String(buf.length), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store',
      'Content-Disposition': `${enLinea ? 'inline' : 'attachment'}; filename="${v.nombre_archivo.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(v.nombre_archivo)}`,
    });
    res.end(buf);
  });

  // ═════════════════════════ Archivar / restaurar / borrar ═════════════════════════
  r.post('/:id/archivar', editar, async (req, res) => {
    const { motivo } = validar(esqMotivo, req.body);
    await db.tx(async (q) => {
      const d = await cargar(q, req, req.params.id, { bloquear: true });
      if (d.archivado) throw conflicto('El documento ya está archivado');
      await q.query('update doc.documentos set archivado = true, archivado_at = now(), archivado_por = $2, archivado_motivo = $3, updated_at = now() where id = $1', [d.id, req.ctx.usuario.id, motivo]);
      await auditar(q, req.ctx, 'documento.archivar', 'documento', d.id, { titulo: d.titulo, motivo }, { sucursalId: d.sucursal_id });
    });
    res.json(await ficha(db, req, req.params.id));
  });
  r.post('/:id/restaurar', editar, async (req, res) => {
    await db.tx(async (q) => {
      const d = await cargar(q, req, req.params.id, { bloquear: true });
      if (!d.archivado) throw conflicto('El documento no está archivado');
      await q.query('update doc.documentos set archivado = false, archivado_at = null, archivado_por = null, archivado_motivo = null, updated_at = now() where id = $1', [d.id]);
      await auditar(q, req.ctx, 'documento.restaurar', 'documento', d.id, { titulo: d.titulo }, { sucursalId: d.sucursal_id });
    });
    res.json(await ficha(db, req, req.params.id));
  });
  /** Borra el documento (queda marcado con motivo y usuario; los archivos se eliminan de la base). El motivo va en el cuerpo o en ?motivo=. */
  r.delete('/:id', editar, async (req, res) => {
    const { motivo } = validar(esqMotivo, { motivo: req.body?.motivo ?? req.query.motivo });
    await db.tx(async (q) => {
      const d = await cargar(q, req, req.params.id, { bloquear: true });
      const vs = (await q.query('select id from doc.versiones where documento_id = $1', [d.id])).rows;
      await q.query('delete from doc.archivos where version_id = any($1::uuid[])', [vs.map((x) => x.id)]);
      await q.query('update doc.versiones set purgada = true where documento_id = $1', [d.id]);
      await q.query('update doc.documentos set eliminado_at = now(), eliminado_por = $2, eliminado_motivo = $3, updated_at = now() where id = $1', [d.id, req.ctx.usuario.id, motivo]);
      await auditar(q, req.ctx, 'documento.eliminar', 'documento', d.id, { titulo: d.titulo, tipo: d.tipo, versiones: vs.length, motivo, confidencialidad: d.confidencialidad }, { sucursalId: d.sucursal_id });
    });
    res.json({ ok: true });
  });

  return r;
}
