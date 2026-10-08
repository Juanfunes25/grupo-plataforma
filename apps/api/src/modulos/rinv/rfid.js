import { Router } from 'express';
import { z } from 'zod';
import { fechaHN } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { ErrorHttp, conflicto, malaPeticion, noEncontrado, prohibido, uuid, validar } from '../../lib/http.js';
import { codificarEpc, decodificarEpc, normalizarEpc, prefijoDeLote } from './rfid/epc.js';
import { compararAuditoria } from './rfid/auditoriaFreezer.js';
import { alertasFifo } from './rfid/fifo.js';
import { empresaDe, texto } from './util.js';

const MINUTOS_PARA_GRABAR = 10;
const MAX_LECTURAS = 2000;
const MAX_TAGS_LISTA = 5000;
const PERM = ['rep:inventario', 'rep:producir'];

// Un tag con su producto: sabor (rep.sabores), tanda (prod.producciones), lote Mec3 e insumo. Las tandas y sabores son
// referencias blandas: si ya no existen, el tag igual se muestra.
const SELECT_TAG = `
  select t.id, t.epc, t.tid, t.estado, t.produccion_id, t.lote_mec3_id, t.ubicacion_id, t.ubicacion_desde, t.etiqueta,
         t.sabor_id as sabor_directo_id, t.insumo_id as insumo_directo_id, t.ultima_lectura_en, t.faltas_seguidas, t.ciclos,
         t.epc_pendiente, t.pendiente_hasta, t.created_at,
         u.nombre as ubicacion_nombre, u.freezer, u.orden_salida,
         p.fecha::text as fecha, p.lote, p.kg, p.kg_restante, coalesce(t.sabor_id, p.sabor_id) as sabor_id, sa.nombre as sabor_nombre,
         l.fecha_ingreso::text as fecha_ingreso, l.fecha_vencimiento::text as fecha_vencimiento, l.cantidad_restante,
         coalesce(t.insumo_id, l.insumo_id) as insumo_id, ci.nombre as insumo_nombre
    from rinv.rfid_tags t
    left join rinv.rfid_ubicaciones u on u.id = t.ubicacion_id
    left join prod.producciones p on p.id = t.produccion_id
    left join rep.sabores sa on sa.id = coalesce(t.sabor_id, p.sabor_id)
    left join rinv.lotes_mec3 l on l.id = t.lote_mec3_id
    left join rinv.insumos_fab ci on ci.id = coalesce(t.insumo_id, l.insumo_id)`;

const ahoraPlus = (min) => new Date(Date.now() + min * 60000);

export function rutasRfid({ db }) {
  const r = Router();
  r.use(requierePermiso(...PERM));
  const emp = empresaDe;

  const tagPorId = async (q, req, id) => (await q.query(`${SELECT_TAG} where t.id = $1 and t.empresa_id = $2`, [id, emp(req)])).rows[0];
  async function cargarTag(q, req, id) {
    const t = await tagPorId(q, req, validar(uuid, id));
    if (!t) throw noEncontrado('Ese tag no existe');
    return t;
  }
  const evento = (q, req, tagId, tipo, { epc = null, ubicacion = null, detalle = null } = {}) =>
    q.query('insert into rinv.rfid_eventos (empresa_id, tag_id, evento, epc, ubicacion_id, detalle, rol) values ($1,$2,$3,$4,$5,$6,$7)', [emp(req), tagId, tipo, epc, ubicacion, detalle, req.ctx.rol]);

  // Código numérico estable de un sabor/insumo/tanda/lote para meterlo en el EPC de 96 bits.
  async function codigoDe(q, req, tipo, refId, maximo) {
    await q.query('insert into rinv.rfid_refs (empresa_id, tipo, ref_id) values ($1,$2,$3) on conflict (empresa_id, tipo, ref_id) do nothing', [emp(req), tipo, refId]);
    const c = Number((await q.query('select codigo from rinv.rfid_refs where empresa_id = $1 and tipo = $2 and ref_id = $3', [emp(req), tipo, refId])).rows[0].codigo);
    if (c > maximo) throw malaPeticion('Se acabaron los códigos disponibles para grabar tags de este tipo');
    return c;
  }
  const refDeCodigo = async (q, req, tipo, codigo) => (await q.query('select ref_id from rinv.rfid_refs where empresa_id = $1 and tipo = $2 and codigo = $3', [emp(req), tipo, codigo])).rows[0]?.ref_id ?? null;

  // ── ubicaciones ──
  r.get('/ubicaciones', async (req, res) => {
    res.json((await db.query('select id, freezer, nombre, orden_salida from rinv.rfid_ubicaciones where empresa_id = $1 and activa order by freezer, orden_salida, nombre', [emp(req)])).rows);
  });
  r.post('/ubicaciones', async (req, res) => {
    const b = validar(z.object({ freezer: z.string().trim().min(1, 'Falta el freezer o el nombre de la sección').max(60), seccion: z.string().trim().min(1, 'Falta el freezer o el nombre de la sección').max(60),
      orden_salida: z.coerce.number().int('El orden de salida tiene que ser un entero entre 0 (puerta) y 99').min(0).max(99).default(0) }), req.body);
    const nombre = `${b.freezer} · ${b.seccion}`;
    const dup = await db.query('select 1 from rinv.rfid_ubicaciones where empresa_id = $1 and nombre = $2', [emp(req), nombre]);
    if (dup.rowCount) throw conflicto(`Ya existe «${nombre}»`);
    const u = (await db.query('insert into rinv.rfid_ubicaciones (empresa_id, freezer, nombre, orden_salida) values ($1,$2,$3,$4) returning id, freezer, nombre, orden_salida', [emp(req), b.freezer, nombre, b.orden_salida])).rows[0];
    await auditar(db, req.ctx, 'rinv.rfid_seccion_creada', 'rfid_ubicacion', u.id, { nombre });
    res.status(201).json(u);
  });

  // ── consulta ──
  r.get('/tags', async (req, res) => {
    const estado = req.query.estado ? String(req.query.estado) : null;
    const filas = (await db.query(`${SELECT_TAG} where t.empresa_id = $1 and ($2::text is null or t.estado = $2) order by t.updated_at desc limit ${MAX_TAGS_LISTA}`, [emp(req), estado])).rows;
    const resumen = (await db.query('select estado, count(*)::int as n from rinv.rfid_tags where empresa_id = $1 group by estado', [emp(req)])).rows;
    const total = resumen.reduce((a, x) => a + x.n, 0);
    res.json({ tags: filas, resumen: Object.fromEntries(resumen.map((x) => [x.estado, x.n])), total, truncado: filas.length >= MAX_TAGS_LISTA && total > filas.length });
  });
  r.get('/tags/:id/historial', async (req, res) => {
    await cargarTag(db, req, req.params.id);
    res.json((await db.query(
      `select e.evento, e.epc, e.detalle, e.rol, e.created_at as creado_en, u.nombre as ubicacion from rinv.rfid_eventos e left join rinv.rfid_ubicaciones u on u.id = e.ubicacion_id
        where e.tag_id = $1 order by e.n desc limit 100`, [req.params.id])).rows);
  });
  /** Las listas para elegir a qué se vincula un tag: sabores e insumos activos. */
  r.get('/catalogo', async (req, res) => {
    const [sabores, insumos] = await Promise.all([
      db.query('select id, nombre from rep.sabores where empresa_id = $1 and activo order by nombre', [emp(req)]),
      db.query('select id, nombre, unidad from rinv.insumos_fab where empresa_id = $1 and activo order by nombre', [emp(req)]),
    ]);
    res.json({ sabores: sabores.rows, insumos: insumos.rows });
  });
  /** Lo que todavía no tiene tag (por tanda y lote; uso opcional). */
  r.get('/pendientes', async (req, res) => {
    const [producciones, lotes] = await Promise.all([
      db.query(`select p.id, p.fecha::text as fecha, p.lote, p.kg, p.kg_restante, sa.nombre as sabor_nombre from prod.producciones p join rep.sabores sa on sa.id = p.sabor_id
                 where p.empresa_id = $1 and p.kg_restante > 0 and p.fecha >= ($2::date - 60) and not exists (select 1 from rinv.rfid_tags t where t.produccion_id = p.id)
                 order by p.fecha desc limit 100`, [emp(req), fechaHN()]),
      db.query(`select l.id, l.fecha_ingreso::text as fecha_ingreso, l.fecha_vencimiento::text as fecha_vencimiento, l.cantidad_restante, i.nombre as insumo_nombre, i.unidad
                  from rinv.lotes_mec3 l join rinv.insumos_fab i on i.id = l.insumo_id where l.empresa_id = $1 and l.cantidad_restante > 0
                   and not exists (select 1 from rinv.rfid_tags t where t.lote_mec3_id = l.id) order by l.fecha_ingreso desc limit 100`, [emp(req)]),
    ]);
    res.json({ producciones: producciones.rows, lotes: lotes.rows });
  });

  // ── registrar, asignar, liberar (sin tocar el chip) ──
  r.post('/tags/registrar', async (req, res) => {
    const epc = normalizarEpc(req.body?.epc);
    if (!epc) throw malaPeticion('El EPC no es un hexadecimal válido');
    const tid = req.body?.tid ? normalizarEpc(req.body.tid) : null;
    const out = await db.tx(async (q) => {
      const ya = (await q.query('select id from rinv.rfid_tags where empresa_id = $1 and epc = $2', [emp(req), epc])).rows[0];
      if (ya) return { status: 200, body: { id: ya.id, nuevo: false } };
      const t = (await q.query('insert into rinv.rfid_tags (empresa_id, epc, tid) values ($1,$2,$3) returning id', [emp(req), epc, tid])).rows[0];
      await evento(q, req, t.id, 'registrado', { epc });
      return { status: 201, body: { id: t.id, nuevo: true } };
    });
    res.status(out.status).json(out.body);
  });

  r.post('/tags/:id/asignar', async (req, res) => {
    const b = validar(z.object({ sabor_id: uuid.optional().nullable(), insumo_id: uuid.optional().nullable(), produccion_id: uuid.optional().nullable(), lote_mec3_id: uuid.optional().nullable() }), req.body);
    if ([b.sabor_id, b.insumo_id, b.produccion_id, b.lote_mec3_id].filter(Boolean).length !== 1) throw malaPeticion('Hay que indicar un sabor o un insumo (uno solo)');
    const out = await db.tx(async (q) => {
      const tag = await cargarTag(q, req, req.params.id);
      if (tag.estado === 'asignado') throw conflicto('Este tag ya está asignado: libéralo primero');
      if (tag.estado === 'baja') throw conflicto('Este tag está dado de baja');
      // Un EPC grabado con un sabor (o insumo) adentro lo dice para siempre: asignarlo por software a otro lo dejaría mintiendo.
      const d = decodificarEpc(tag.epc);
      if (d.propio && d.tipo !== 'bandeja') {
        const objetivo = d.tipo === 'helado' ? (d.lote === 0 ? await refDeCodigo(q, req, 'sabor', d.referencia) : await refDeCodigo(q, req, 'tanda', d.lote))
          : (d.lote === 0 ? await refDeCodigo(q, req, 'insumo', d.referencia) : await refDeCodigo(q, req, 'lote', d.lote));
        const pedido = d.tipo === 'helado' ? (d.lote === 0 ? b.sabor_id : b.produccion_id) : (d.lote === 0 ? b.insumo_id : b.lote_mec3_id);
        if (objetivo !== pedido) throw conflicto(`Este tag tiene grabado ${d.tipo === 'helado' ? 'otro sabor' : 'otro insumo'}. Para usarlo con otro hay que volver a grabarlo (o usar una bandeja con tag de tipo «bandeja»).`);
      }
      const nombre = b.sabor_id ? (await q.query('select nombre from rep.sabores where id = $1 and empresa_id = $2', [b.sabor_id, emp(req)])).rows[0]?.nombre
        : b.insumo_id ? (await q.query('select nombre from rinv.insumos_fab where id = $1 and empresa_id = $2', [b.insumo_id, emp(req)])).rows[0]?.nombre
          : b.produccion_id ? (await q.query('select lote from prod.producciones where id = $1 and empresa_id = $2', [b.produccion_id, emp(req)])).rows[0]?.lote
            : (await q.query('select id::text as n from rinv.lotes_mec3 where id = $1 and empresa_id = $2', [b.lote_mec3_id, emp(req)])).rows[0]?.n;
      if (!nombre) throw noEncontrado('Ese sabor, insumo, tanda o lote no existe');
      // La ubicación NO se toca: un tag que ya estaba en un freezer sigue ahí al ponerle sabor.
      await q.query(`update rinv.rfid_tags set estado = 'asignado', sabor_id = $2, insumo_id = $3, produccion_id = $4, lote_mec3_id = $5, faltas_seguidas = 0, updated_at = now() where id = $1`,
        [tag.id, b.sabor_id ?? null, b.insumo_id ?? null, b.produccion_id ?? null, b.lote_mec3_id ?? null]);
      const que = b.sabor_id ? `sabor ${nombre}` : b.insumo_id ? `insumo ${nombre}` : b.produccion_id ? `tanda ${nombre}` : 'lote Mec3';
      await evento(q, req, tag.id, 'asignado', { epc: tag.epc, detalle: que });
      await auditar(q, req.ctx, 'rinv.rfid_asignado', 'rfid_tag', tag.id, { epc: tag.epc, a: que });
      return tagPorId(q, req, tag.id);
    });
    res.json(out);
  });

  /** Bandeja vacía y lavada: el tag queda libre con el mismo EPC, listo para otro lote o sabor. */
  r.post('/tags/:id/liberar', async (req, res) => {
    const out = await db.tx(async (q) => {
      const tag = await cargarTag(q, req, req.params.id);
      if (tag.estado !== 'asignado') throw conflicto('Este tag no está asignado a nada');
      await q.query(`update rinv.rfid_tags set estado = 'disponible', produccion_id = null, lote_mec3_id = null, sabor_id = null, insumo_id = null, ubicacion_id = null, ubicacion_desde = null,
                       faltas_seguidas = 0, ciclos = ciclos + 1, updated_at = now() where id = $1`, [tag.id]);
      await evento(q, req, tag.id, 'liberado', { epc: tag.epc, detalle: tag.sabor_nombre ? `${tag.sabor_nombre}${tag.produccion_id ? ' (tanda)' : ''}` : tag.insumo_nombre || null });
      await auditar(q, req.ctx, 'rinv.rfid_liberado', 'rfid_tag', tag.id, { epc: tag.epc });
      return tagPorId(q, req, tag.id);
    });
    res.json(out);
  });

  r.post('/tags/:id/mover', async (req, res) => {
    const ub = validar(uuid, req.body?.ubicacion_id);
    const out = await db.tx(async (q) => {
      const tag = await cargarTag(q, req, req.params.id);
      const u = (await q.query('select id, nombre from rinv.rfid_ubicaciones where id = $1 and empresa_id = $2 and activa', [ub, emp(req)])).rows[0];
      if (!u) throw noEncontrado('Esa sección no existe');
      if (tag.estado === 'baja') throw conflicto('Este tag está dado de baja');
      await q.query('update rinv.rfid_tags set ubicacion_id = $2, ubicacion_desde = now(), faltas_seguidas = 0, updated_at = now() where id = $1', [tag.id, u.id]);
      await evento(q, req, tag.id, 'movido', { epc: tag.epc, ubicacion: u.id, detalle: `de ${tag.ubicacion_nombre || 'sin ubicación'} a ${u.nombre}` });
      return tagPorId(q, req, tag.id);
    });
    res.json(out);
  });

  r.post('/tags/:id/baja', async (req, res) => {
    await db.tx(async (q) => {
      const tag = await cargarTag(q, req, req.params.id);
      await q.query(`update rinv.rfid_tags set estado = 'baja', produccion_id = null, lote_mec3_id = null, sabor_id = null, insumo_id = null, ubicacion_id = null, ubicacion_desde = null, updated_at = now() where id = $1`, [tag.id]);
      await evento(q, req, tag.id, 'baja', { epc: tag.epc, detalle: String(req.body?.motivo || '').slice(0, 200) || null });
      await auditar(q, req.ctx, 'rinv.rfid_baja', 'rfid_tag', tag.id, { epc: tag.epc, motivo: texto(req.body?.motivo) });
    });
    res.json({ ok: true });
  });

  // ── grabación del chip: reservar → grabar → releer → confirmar ──
  // El servidor no puede tocar el chip; solo lleva la contabilidad. El EPC nuevo SOLO se vuelve oficial cuando el lector
  // lo relee y coincide. Si el navegador se cierra entre medio, el pendiente vence y el tag sigue como estaba.
  r.post('/escritura/preparar', async (req, res) => {
    const epcActual = normalizarEpc(req.body?.epc_actual);
    if (!epcActual) throw malaPeticion('Falta el EPC actual del tag (el que lee el lector)');
    const tid = req.body?.tid ? normalizarEpc(req.body.tid) : null;
    const tipo = String(req.body?.tipo || '');
    if (!['helado', 'insumo', 'bandeja'].includes(tipo)) throw malaPeticion('El tipo tiene que ser helado, insumo o bandeja');
    const ids = validar(z.object({ sabor_id: uuid.optional().nullable(), produccion_id: uuid.optional().nullable(), insumo_id: uuid.optional().nullable(), lote_mec3_id: uuid.optional().nullable() }), req.body);
    const out = await db.tx(async (q) => {
      let tag = (tid && (await q.query('select id from rinv.rfid_tags where empresa_id = $1 and tid = $2', [emp(req), tid])).rows[0])
        || (await q.query('select id from rinv.rfid_tags where empresa_id = $1 and epc = $2', [emp(req), epcActual])).rows[0];
      if (!tag) tag = (await q.query('insert into rinv.rfid_tags (empresa_id, epc, tid) values ($1,$2,$3) returning id', [emp(req), epcActual, tid])).rows[0];
      const actual = await cargarTag(q, req, tag.id);
      if (actual.estado === 'asignado') throw conflicto('Este tag está asignado a un producto. Si la bandeja ya se vació, libéralo primero.');
      if (actual.estado === 'baja') throw conflicto('Este tag está dado de baja');
      if (tid && !actual.tid) await q.query('update rinv.rfid_tags set tid = $2 where id = $1', [actual.id, tid]);
      let base;
      if (tipo === 'helado') {
        if (ids.sabor_id) {
          if (!(await q.query('select 1 from rep.sabores where id = $1 and empresa_id = $2', [ids.sabor_id, emp(req)])).rowCount) throw noEncontrado('Ese sabor no existe');
          base = { tipo, referencia: await codigoDe(q, req, 'sabor', ids.sabor_id, 0xffff), lote: 0 };
        } else {
          const p = ids.produccion_id && (await q.query('select id, sabor_id from prod.producciones where id = $1 and empresa_id = $2', [ids.produccion_id, emp(req)])).rows[0];
          if (!p) throw noEncontrado('Elige el sabor al que va este tag');
          base = { tipo, referencia: await codigoDe(q, req, 'sabor', p.sabor_id, 0xffff), lote: await codigoDe(q, req, 'tanda', p.id, 0xffffffff) };
        }
      } else if (tipo === 'insumo') {
        if (ids.insumo_id) {
          if (!(await q.query('select 1 from rinv.insumos_fab where id = $1 and empresa_id = $2', [ids.insumo_id, emp(req)])).rowCount) throw noEncontrado('Ese insumo no existe');
          base = { tipo, referencia: await codigoDe(q, req, 'insumo', ids.insumo_id, 0xffff), lote: 0 };
        } else {
          const l = ids.lote_mec3_id && (await q.query('select id, insumo_id from rinv.lotes_mec3 where id = $1 and empresa_id = $2', [ids.lote_mec3_id, emp(req)])).rows[0];
          if (!l) throw noEncontrado('Elige el insumo al que va este tag');
          base = { tipo, referencia: await codigoDe(q, req, 'insumo', l.insumo_id, 0xffff), lote: await codigoDe(q, req, 'lote', l.id, 0xffffffff) };
        }
      } else {
        base = { tipo, referencia: 0, lote: await codigoDe(q, req, 'bandeja', actual.id, 0xffffffff) }; // la bandeja se identifica por su número de tag
      }
      const prefijo = prefijoDeLote(base);
      const ocupados = new Set((await q.query('select epc from rinv.rfid_tags where empresa_id = $1 and epc like $2 and id <> $3', [emp(req), `${prefijo}%`, actual.id])).rows.map((x) => x.epc));
      let secuencia = 1;
      while (ocupados.has(codificarEpc({ ...base, secuencia }))) secuencia += 1;
      const epcNuevo = codificarEpc({ ...base, secuencia });
      const vence = ahoraPlus(MINUTOS_PARA_GRABAR);
      await q.query('update rinv.rfid_tags set epc_pendiente = $2, pendiente_hasta = $3, updated_at = now() where id = $1', [actual.id, epcNuevo, vence]);
      return { tag_id: actual.id, epc_actual: actual.epc, epc_nuevo: epcNuevo, vence_en: vence, tipo };
    });
    res.json(out);
  });

  r.post('/escritura/confirmar', async (req, res) => {
    const leido = normalizarEpc(req.body?.epc_leido);
    const out = await db.tx(async (q) => {
      const tag = await cargarTag(q, req, req.body?.tag_id);
      if (!tag.epc_pendiente) throw conflicto('No hay una grabación en curso para este tag');
      if (new Date(tag.pendiente_hasta) < new Date()) throw conflicto('La grabación venció (pasaron más de 10 minutos). Empieza de nuevo.');
      if (leido !== tag.epc_pendiente) {
        await q.query('update rinv.rfid_tags set epc_pendiente = null, pendiente_hasta = null where id = $1', [tag.id]);
        await evento(q, req, tag.id, 'grabacion_fallida', { epc: tag.epc, detalle: `se esperaba ${tag.epc_pendiente} y el lector leyó ${leido || 'nada'}` });
        return { falla: { epc_registrado: tag.epc } };
      }
      const d = decodificarEpc(tag.epc_pendiente);
      const porTanda = d.lote > 0;
      const produccionId = d.tipo === 'helado' && porTanda ? await refDeCodigo(q, req, 'tanda', d.lote) : null;
      const loteId = d.tipo === 'insumo' && porTanda ? await refDeCodigo(q, req, 'lote', d.lote) : null;
      const saborId = d.tipo === 'helado' ? await refDeCodigo(q, req, 'sabor', d.referencia) : null;
      const insumoId = d.tipo === 'insumo' ? await refDeCodigo(q, req, 'insumo', d.referencia) : null;
      const estado = d.tipo === 'bandeja' ? 'disponible' : 'asignado';
      await q.query(
        `update rinv.rfid_tags set epc = $2, estado = $3, produccion_id = $4, lote_mec3_id = $5, sabor_id = $6, insumo_id = $7, ubicacion_id = null, ubicacion_desde = null, faltas_seguidas = 0,
           ciclos = ciclos + case when estado = 'nuevo' then 0 else 1 end, epc_pendiente = null, pendiente_hasta = null, updated_at = now() where id = $1`,
        [tag.id, tag.epc_pendiente, estado, produccionId, loteId, saborId, insumoId]);
      await evento(q, req, tag.id, 'grabado', { epc: tag.epc_pendiente, detalle: `antes ${tag.epc}` });
      if (estado === 'asignado') await evento(q, req, tag.id, 'asignado', { epc: tag.epc_pendiente, detalle: saborId ? 'sabor' : insumoId ? 'insumo' : produccionId ? 'tanda' : 'lote Mec3' });
      await auditar(q, req.ctx, 'rinv.rfid_grabado', 'rfid_tag', tag.id, { antes: tag.epc, despues: tag.epc_pendiente });
      return { tag: await tagPorId(q, req, tag.id) };
    });
    if (out.falla) throw Object.assign(new ErrorHttp(409, 'El lector no leyó el EPC nuevo después de grabar. El tag sigue registrado con su EPC anterior: vuelve a leerlo antes de reintentar.', 'conflicto'), { faltantes: out.falla });
    res.json(out.tag);
  });

  r.post('/escritura/cancelar', async (req, res) => {
    const tag = await cargarTag(db, req, req.body?.tag_id);
    await db.query('update rinv.rfid_tags set epc_pendiente = null, pendiente_hasta = null where id = $1', [tag.id]);
    await evento(db, req, tag.id, 'grabacion_fallida', { epc: tag.epc, detalle: String(req.body?.motivo || 'cancelada').slice(0, 200) });
    res.json({ ok: true, epc_registrado: tag.epc });
  });

  /** Cambió el código del chip por fuera (app de Chainway): se conserva el MISMO tag y solo se actualiza el código. */
  r.patch('/tags/:id/epc', async (req, res) => {
    const epc = normalizarEpc(req.body?.epc);
    if (!epc) throw malaPeticion('El código nuevo no es un hexadecimal válido');
    const out = await db.tx(async (q) => {
      const tag = await cargarTag(q, req, req.params.id);
      if (tag.estado === 'baja') throw conflicto('Este tag está dado de baja');
      if (epc === tag.epc) throw conflicto('Ese ya es el código de este tag');
      if ((await q.query('select 1 from rinv.rfid_tags where empresa_id = $1 and epc = $2', [emp(req), epc])).rowCount) throw conflicto('Ese código ya pertenece a otro tag registrado');
      await q.query('update rinv.rfid_tags set epc = $2, epc_pendiente = null, pendiente_hasta = null, updated_at = now() where id = $1', [tag.id, epc]);
      await evento(q, req, tag.id, 'grabado', { epc, detalle: `código actualizado (antes ${tag.epc})` });
      return tagPorId(q, req, tag.id);
    });
    res.json(out);
  });

  /** «¿Qué son estos códigos?»: mientras se escanea. Solo mira, no cambia nada. */
  r.post('/consulta', async (req, res) => {
    const epcs = [...new Set((Array.isArray(req.body?.epcs) ? req.body.epcs : []).map(normalizarEpc).filter(Boolean))].slice(0, 500);
    if (!epcs.length) return res.json({ tags: [] });
    const filas = (await db.query(`${SELECT_TAG} where t.empresa_id = $1 and t.epc = any($2::text[])`, [emp(req), epcs])).rows;
    res.json({ tags: filas.map((t) => ({ epc: t.epc, id: t.id, estado: t.estado, etiqueta: t.etiqueta, sabor_nombre: t.sabor_nombre, insumo_nombre: t.insumo_nombre, ubicacion_nombre: t.ubicacion_nombre, ubicacion_id: t.ubicacion_id })) });
  });

  r.patch('/tags/:id/etiqueta', async (req, res) => {
    const tag = await cargarTag(db, req, req.params.id);
    await db.query('update rinv.rfid_tags set etiqueta = $2, updated_at = now() where id = $1', [tag.id, String(req.body?.etiqueta || '').trim().slice(0, 60) || null]);
    res.json(await tagPorId(db, req, tag.id));
  });

  /** Registrar en un freezer los tags que el lector ve, SIN producción de por medio: cada tag leído queda ubicado en esta sección. */
  r.post('/ubicaciones/:id/registrar', async (req, res) => {
    const lecturas = Array.isArray(req.body?.lecturas) ? req.body.lecturas : null;
    if (!lecturas) throw malaPeticion('Faltan las lecturas');
    if (lecturas.length > MAX_LECTURAS) throw new ErrorHttp(413, `Demasiadas lecturas (${lecturas.length}); el cliente tiene que deduplicar antes de mandar`);
    const out = await db.tx(async (q) => {
      const u = (await q.query('select id, nombre from rinv.rfid_ubicaciones where id = $1 and empresa_id = $2 and activa', [validar(uuid, req.params.id), emp(req)])).rows[0];
      if (!u) throw noEncontrado('Esa sección no existe');
      const normalizados = lecturas.map((l) => normalizarEpc(l?.epc));
      const ajenos = normalizados.filter((e) => !e).length;
      const epcs = [...new Set(normalizados.filter(Boolean))];
      const existentes = epcs.length ? (await q.query('select id, epc, estado, ubicacion_id from rinv.rfid_tags where empresa_id = $1 and epc = any($2::text[])', [emp(req), epcs])).rows : [];
      const porEpc = new Map(existentes.map((t) => [t.epc, t]));
      const nuevos = epcs.filter((e) => !porEpc.has(e));
      const aMover = existentes.filter((t) => t.estado !== 'baja' && t.ubicacion_id !== u.id);
      const yaEstaban = existentes.filter((t) => t.estado !== 'baja' && t.ubicacion_id === u.id);
      const bajas = existentes.filter((t) => t.estado === 'baja');
      for (const epc of nuevos) {
        const t = (await q.query('insert into rinv.rfid_tags (empresa_id, epc, ubicacion_id, ubicacion_desde, ultima_lectura_en) values ($1,$2,$3,now(),now()) returning id', [emp(req), epc, u.id])).rows[0];
        await evento(q, req, t.id, 'ubicado', { epc, ubicacion: u.id, detalle: 'registrado en la sección' });
      }
      for (const t of aMover) {
        await evento(q, req, t.id, 'movido', { epc: t.epc, ubicacion: u.id, detalle: `a ${u.nombre}` });
        await q.query('update rinv.rfid_tags set ubicacion_id = $2, ubicacion_desde = now(), faltas_seguidas = 0, ultima_lectura_en = now() where id = $1', [t.id, u.id]);
      }
      if (yaEstaban.length) await q.query('update rinv.rfid_tags set ultima_lectura_en = now(), faltas_seguidas = 0 where id = any($1::uuid[])', [yaEstaban.map((t) => t.id)]);
      await auditar(q, req.ctx, 'rinv.rfid_registro_seccion', 'rfid_ubicacion', u.id, { seccion: u.nombre, nuevos: nuevos.length, movidos: aMover.length });
      return { ubicacion: u, leidos: epcs.length, nuevos: nuevos.length, movidos: aMover.length, ya_estaban: yaEstaban.length, dados_de_baja: bajas.length, ajenos };
    });
    res.json(out);
  });

  // ── FIFO y auditoría de una sección ──
  const tagsParaFifo = async (q, req, freezer) => (await q.query(
    `${SELECT_TAG} where t.empresa_id = $1 and t.estado = 'asignado' and t.produccion_id is not null and t.ubicacion_id is not null and ($2::text is null or u.freezer = $2)`, [emp(req), freezer])).rows;

  r.get('/fifo', async (req, res) => {
    res.json({ alertas: alertasFifo(await tagsParaFifo(db, req, req.query.freezer ? String(req.query.freezer) : null), { hoy: fechaHN() }) });
  });

  r.get('/auditorias', async (req, res) => {
    res.json((await db.query(
      `select a.id, a.created_at as creado_en, u.nombre as ubicacion, a.detectados, a.esperados, a.faltantes, a.equivocados, a.desconocidos, a.rol
         from rinv.rfid_auditorias a join rinv.rfid_ubicaciones u on u.id = a.ubicacion_id where a.empresa_id = $1 order by a.created_at desc limit 30`, [emp(req)])).rows);
  });

  r.post('/auditorias', async (req, res) => {
    const lecturas = Array.isArray(req.body?.lecturas) ? req.body.lecturas : null;
    if (!lecturas) throw malaPeticion('Faltan las lecturas');
    if (lecturas.length > MAX_LECTURAS) throw new ErrorHttp(413, `Demasiadas lecturas (${lecturas.length}); el cliente tiene que deduplicar antes de mandar`);
    const out = await db.tx(async (q) => {
      const ub = (await q.query('select id, freezer, nombre from rinv.rfid_ubicaciones where id = $1 and empresa_id = $2 and activa', [validar(uuid, req.body?.ubicacion_id), emp(req)])).rows[0];
      if (!ub) throw noEncontrado('Esa sección no existe');
      const epcs = [...new Set(lecturas.map((l) => normalizarEpc(l?.epc)).filter(Boolean))];
      const [conocidos, esperados] = await Promise.all([
        epcs.length ? q.query(`${SELECT_TAG} where t.empresa_id = $1 and t.epc = any($2::text[])`, [emp(req), epcs]) : { rows: [] },
        q.query(`${SELECT_TAG} where t.empresa_id = $1 and t.estado <> 'baja' and t.ubicacion_id = $2`, [emp(req), ub.id]),
      ]);
      const v = compararAuditoria({ ubicacion: ub, lecturas, tagsPorEpc: new Map(conocidos.rows.map((t) => [t.epc, t])), esperados: esperados.rows });
      if (v.cambios.vistos.length) await q.query('update rinv.rfid_tags set ultima_lectura_en = now(), faltas_seguidas = 0 where id = any($1::uuid[])', [v.cambios.vistos]);
      for (const id of v.cambios.ubicar) {
        await q.query('update rinv.rfid_tags set ubicacion_id = $2, ubicacion_desde = now() where id = $1', [id, ub.id]);
        await evento(q, req, id, 'ubicado', { ubicacion: ub.id, detalle: 'primera lectura en esta sección' });
      }
      for (const f of v.cambios.faltas) {
        await q.query('update rinv.rfid_tags set faltas_seguidas = $2 where id = $1', [f.tag_id, f.faltas_seguidas]);
        if (f.faltas_seguidas === 2) await evento(q, req, f.tag_id, 'no_detectado', { ubicacion: ub.id, detalle: 'no apareció en dos barridos seguidos' });
      }
      const compacto = {
        faltantes: v.faltantes.map((x) => ({ id: x.tag.id, epc: x.tag.epc, confirmado: x.confirmado })),
        equivocados: v.equivocados.map((x) => ({ id: x.tag.id, epc: x.tag.epc, registrada_en: x.registrada_en })),
        desconocidos: v.desconocidos.map((x) => x.epc),
      };
      await q.query(
        `insert into rinv.rfid_auditorias (empresa_id, ubicacion_id, detectados, esperados, faltantes, equivocados, desconocidos, resultado, rol, usuario_id) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
        [emp(req), ub.id, v.resumen.leidos, v.resumen.esperados, v.resumen.faltantes, v.resumen.equivocados, v.resumen.desconocidos, JSON.stringify(compacto), req.ctx.rol, req.ctx.usuario.id]);
      await auditar(q, req.ctx, 'rinv.rfid_auditoria', 'rfid_ubicacion', ub.id, { seccion: ub.nombre, ...v.resumen });
      const { cambios: _omitido, ...publico } = v;
      return { ...publico, fifo: alertasFifo(await tagsParaFifo(q, req, ub.freezer), { hoy: fechaHN() }) };
    });
    res.json(out);
  });

  void prohibido;
  return r;
}
