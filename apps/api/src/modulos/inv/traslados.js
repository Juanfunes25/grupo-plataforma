// Traslados de inventario con documento: entre sucursales de una empresa o entre empresas del grupo.
//  1) El origen crea el traslado: la mercadería SALE del inventario de origen y queda «en tránsito» (con número de documento).
//  2) El destino la recibe y confirma cuánto llegó: ENTRA al inventario de destino (con el costo de origen).
//  3) Entre empresas, al confirmar se deja un registro intercompañía (fin.intercompania) para que Finanzas lo concilie.
// Si algo no llega completo, la diferencia queda anotada (no se inventa ni se borra mercadería).
import { z } from 'zod';
import { fechaHN } from '@grupo/shared';
import { requierePermiso, sucursalesPermitidas } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { conflicto, malaPeticion, noEncontrado, prohibido, uuid, validar } from '../../lib/http.js';
import { FUENTES, fuentesDe, leerItem, listarItems, moverItem } from './adaptadores.js';

const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const numeroDoc = (n) => `TR-${String(n).padStart(4, '0')}`;
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export function montarTraslados(r, { db, ctxMgr, ctxInv }) {
  const ver = requierePermiso('inv:ver');
  const operar = requierePermiso('inv:mover');

  /** Empresas del grupo a las que se puede enviar (con sus sucursales y de qué tipo de inventario son). */
  r.get('/destinos', ver, async (req, res) => {
    const empresas = await ctxMgr.empresas();
    const { rows: suc } = await db.query('select id, empresa_id, nombre, alias from core.sucursales where activo order by orden, nombre');
    res.json(empresas.map((e) => ({
      codigo: e.codigo, nombre: e.nombre, color: e.color, es_actual: e.id === req.ctx.empresa.id,
      con_sucursales: fuentesDe(e).some((f) => FUENTES[f].sucursal),
      sucursales: suc.filter((s) => s.empresa_id === e.id).map((s) => ({ id: s.id, nombre: s.nombre })),
    })));
  });

  async function nombres(q, t) {
    const ids = [t.empresa_origen_id, t.empresa_destino_id];
    const emp = (await q.query('select id, codigo, nombre from core.empresas where id = any($1::uuid[])', [ids])).rows;
    const sIds = [t.sucursal_origen_id, t.sucursal_destino_id].filter(Boolean);
    const suc = sIds.length ? (await q.query('select id, nombre from core.sucursales where id = any($1::uuid[])', [sIds])).rows : [];
    const usr = (await q.query('select id, nombre from core.usuarios where id = any($1::uuid[])', [[t.creado_por, t.recibido_por, t.anulado_por].filter(Boolean)])).rows;
    const e = (id) => emp.find((x) => x.id === id);
    const n = (arr, id) => arr.find((x) => x.id === id)?.nombre ?? null;
    return {
      numero_doc: numeroDoc(t.numero),
      origen: { empresa: e(t.empresa_origen_id)?.nombre, codigo: e(t.empresa_origen_id)?.codigo, sucursal: n(suc, t.sucursal_origen_id) },
      destino: { empresa: e(t.empresa_destino_id)?.nombre, codigo: e(t.empresa_destino_id)?.codigo, sucursal: n(suc, t.sucursal_destino_id) },
      entre_empresas: t.empresa_origen_id !== t.empresa_destino_id,
      creado_por_nombre: n(usr, t.creado_por), recibido_por_nombre: n(usr, t.recibido_por), anulado_por_nombre: n(usr, t.anulado_por),
    };
  }

  r.get('/traslados', ver, async (req, res) => {
    const f = validar(z.object({ vista: z.enum(['enviados', 'por_recibir', 'todos']).default('todos'), estado: z.enum(['en_transito', 'recibido', 'anulado']).optional() }), req.query);
    const e = req.ctx.empresa.id;
    const { rows } = await db.query(
      `select t.*, (select count(*)::int from invu.traslado_lineas l where l.traslado_id = t.id) as lineas
         from invu.traslados t
        where (($2 in ('enviados','todos') and t.empresa_origen_id = $1) or ($2 in ('por_recibir','todos') and t.empresa_destino_id = $1))
          and ($3::text is null or t.estado = $3) order by t.created_at desc limit 200`, [e, f.vista, f.estado ?? null]);
    const out = [];
    for (const t of rows) {
      const nm = await nombres(db, t);
      out.push({ ...t, ...nm, valor_total: ctxInv(req).costos ? t.valor_total : null, direccion: t.empresa_origen_id === e && t.empresa_destino_id === e ? 'interno' : t.empresa_origen_id === e ? 'envio' : 'recibo' });
    }
    res.json(out);
  });

  async function cargar(q, req, id, { bloquear = false } = {}) {
    const { rows } = await q.query(`select * from invu.traslados where id = $1 ${bloquear ? 'for update' : ''}`, [validar(uuid, id)]);
    const t = rows[0];
    const e = req.ctx.empresa.id;
    if (!t || (t.empresa_origen_id !== e && t.empresa_destino_id !== e)) throw noEncontrado('Traslado no encontrado');
    return t;
  }

  r.get('/traslados/:id', ver, async (req, res) => {
    const t = await cargar(db, req, req.params.id);
    const lineas = (await db.query('select * from invu.traslado_lineas where traslado_id = $1 order by nombre', [t.id])).rows;
    const costos = ctxInv(req).costos;
    const e = req.ctx.empresa.id;
    // Para quien recibe en OTRA empresa: sugerencia de a qué ítem de su inventario corresponde cada línea (si no vino ya).
    let catalogo = null;
    if (t.estado === 'en_transito' && t.empresa_destino_id === e) {
      const items = await listarItems(db, { ...ctxInv(req), sucursalIds: [], costos: false }, {});
      const vistos = new Map();
      for (const i of items) if (!vistos.has(`${i.fuente}:${i.ref_id}`)) vistos.set(`${i.fuente}:${i.ref_id}`, { fuente: i.fuente, ref_id: i.ref_id, nombre: i.nombre, unidad: i.unidad, categoria: i.categoria });
      catalogo = [...vistos.values()].filter((i) => FUENTES[i.fuente].traslado);
    }
    res.json({
      ...t, ...(await nombres(db, t)), valor_total: costos ? t.valor_total : null, soy_origen: t.empresa_origen_id === e, soy_destino: t.empresa_destino_id === e,
      lineas: lineas.map((l) => ({ ...l, costo_unitario: costos ? l.costo_unitario : null })), catalogo_destino: catalogo,
    });
  });

  async function equivalente(q, empresa, nombre) {
    const items = await listarItems(q, { empresa, sucursalIds: [], costos: false }, {});
    const n = norm(nombre);
    const i = items.find((x) => FUENTES[x.fuente].traslado && norm(x.nombre) === n);
    return i ? { fuente: i.fuente, ref_id: i.ref_id } : null;
  }

  r.post('/traslados', operar, async (req, res) => {
    const b = validar(z.object({
      destino: z.string().trim().min(2).max(30),                       // código de la empresa destino
      origen_sucursal_id: uuid.optional().nullable(), destino_sucursal_id: uuid.optional().nullable(),
      notas: z.string().trim().max(500).optional().nullable(),
      lineas: z.array(z.object({
        fuente: z.string().max(20), ref_id: uuid, cantidad: z.coerce.number().positive().max(10_000_000),
        destino: z.object({ fuente: z.string().max(20), ref_id: uuid }).optional().nullable(),
      })).min(1, 'Agrega al menos un producto al traslado').max(300),
    }), req.body);
    const empresas = await ctxMgr.empresas();
    const dest = empresas.find((x) => x.codigo === b.destino.toLowerCase());
    if (!dest) throw noEncontrado('La empresa destino no existe');
    const origen = req.ctx.empresa;
    const mismaEmpresa = dest.id === origen.id;
    const permitidas = await sucursalesPermitidas(db, req.ctx);
    const sucOrigen = b.origen_sucursal_id ?? null;
    if (sucOrigen && !permitidas.some((s) => s.id === sucOrigen)) throw prohibido('La sucursal de origen no existe o no tienes acceso a ella');
    if (b.destino_sucursal_id) {
      const ok = (await db.query('select 1 from core.sucursales where id = $1 and empresa_id = $2 and activo', [b.destino_sucursal_id, dest.id])).rowCount;
      if (!ok) throw malaPeticion('La sucursal de destino no pertenece a esa empresa');
    }
    if (mismaEmpresa) {
      if (!b.origen_sucursal_id || !b.destino_sucursal_id) throw malaPeticion('Entre sucursales de la misma empresa elige la sucursal de origen y la de destino');
      if (b.origen_sucursal_id === b.destino_sucursal_id) throw malaPeticion('El origen y el destino son la misma sucursal');
    }
    const fuentesOrigen = fuentesDe(origen);
    const out = await db.tx(async (q) => {
      const numero = (await q.query('select invu.siguiente($1, $2) as n', [origen.id, 'traslado'])).rows[0].n;
      const t = (await q.query(
        `insert into invu.traslados (numero, empresa_origen_id, sucursal_origen_id, empresa_destino_id, sucursal_destino_id, notas, creado_por)
         values ($1,$2,$3,$4,$5,$6,$7) returning *`, [numero, origen.id, sucOrigen, dest.id, b.destino_sucursal_id ?? null, b.notas || null, req.ctx.usuario.id])).rows[0];
      const doc = numeroDoc(numero);
      let total = 0;
      const vistos = new Set();
      for (const l of b.lineas) {
        if (!fuentesOrigen.includes(l.fuente) || !FUENTES[l.fuente]?.traslado) throw malaPeticion('Ese tipo de inventario no se puede trasladar (la piedra terminada se vende con factura)');
        const suc = FUENTES[l.fuente].sucursal ? sucOrigen : null;
        if (FUENTES[l.fuente].sucursal && !suc) throw malaPeticion('Elige la sucursal de origen');
        const dup = `${l.fuente}:${l.ref_id}:${suc ?? ''}`;
        if (vistos.has(dup)) throw malaPeticion('Un producto está repetido en el traslado: suma sus cantidades en una sola línea');
        vistos.add(dup);
        const item = await leerItem(q, origen.id, l.fuente, l.ref_id, suc, { bloquear: true });
        if (item.existencia < l.cantidad) throw conflicto(`No hay suficiente ${item.nombre}: hay ${item.existencia} ${item.unidad} y se quieren trasladar ${l.cantidad}`);
        const m = await moverItem(q, req.ctx, { fuente: l.fuente, ref: l.ref_id, sucursalId: suc, delta: -l.cantidad, tipo: 'traslado', documento: doc,
          motivo: `Traslado ${doc} a ${dest.nombre}${b.destino_sucursal_id ? '' : ''}` });
        const costo = m.costo_unitario == null ? null : Math.round(m.costo_unitario * 10000) / 10000;
        total += costo != null ? l.cantidad * costo : 0;
        let d = null;
        if (mismaEmpresa) d = { fuente: l.fuente, ref_id: l.ref_id };
        else if (l.destino) {
          if (!fuentesDe(dest).includes(l.destino.fuente) || !FUENTES[l.destino.fuente].traslado) throw malaPeticion('El producto de destino no es de esa empresa');
          d = l.destino;
        } else d = await equivalente(q, dest, item.nombre);
        await q.query(
          `insert into invu.traslado_lineas (traslado_id, fuente_origen, ref_origen, nombre, unidad, cantidad, costo_unitario, fuente_destino, ref_destino) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [t.id, l.fuente, l.ref_id, item.nombre, item.unidad, l.cantidad, costo, d?.fuente ?? null, d?.ref_id ?? null]);
      }
      await q.query('update invu.traslados set valor_total = $2 where id = $1', [t.id, r2(total)]);
      await auditar(q, req.ctx, 'inv.traslado_creado', 'traslado', t.id, { documento: doc, destino: dest.nombre, lineas: b.lineas.length, valor: r2(total) }, { sucursalId: sucOrigen });
      return { ...t, numero_doc: doc, valor_total: r2(total) };
    });
    res.status(201).json(out);
  });

  r.post('/traslados/:id/recibir', operar, async (req, res) => {
    const b = validar(z.object({
      sucursal_id: uuid.optional().nullable(), nota: z.string().trim().max(300).optional().nullable(),
      lineas: z.array(z.object({
        id: uuid, cantidad_recibida: z.coerce.number().min(0).max(10_000_000).optional(),
        fuente_destino: z.string().max(20).optional().nullable(), ref_destino: uuid.optional().nullable(), nota: z.string().trim().max(200).optional().nullable(),
      })).max(300).default([]),
    }), req.body);
    const out = await db.tx(async (q) => {
      const t = await cargar(q, req, req.params.id, { bloquear: true });
      if (t.empresa_destino_id !== req.ctx.empresa.id) throw prohibido('Solo la empresa de destino puede recibir este traslado');
      if (t.estado !== 'en_transito') throw conflicto(`Este traslado ya está ${t.estado}`);
      const lineas = (await q.query('select * from invu.traslado_lineas where traslado_id = $1 order by nombre for update', [t.id])).rows;
      const porId = new Map(b.lineas.map((l) => [l.id, l]));
      const destFuentes = fuentesDe(req.ctx.empresa);
      const permitidas = await sucursalesPermitidas(q, req.ctx);
      const sucDest = b.sucursal_id ?? t.sucursal_destino_id ?? null;
      let valor = 0; let diferencia = false; let recibidas = 0;
      const doc = numeroDoc(t.numero);
      const origenNombre = (await q.query('select nombre from core.empresas where id = $1', [t.empresa_origen_id])).rows[0].nombre;
      for (const l of lineas) {
        const dato = porId.get(l.id) ?? {};
        const recibida = r3(dato.cantidad_recibida ?? l.cantidad);
        if (recibida > l.cantidad) throw malaPeticion(`De «${l.nombre}» no pueden llegar más de ${l.cantidad}`);
        const fuente = dato.fuente_destino ?? l.fuente_destino;
        const ref = dato.ref_destino ?? l.ref_destino;
        if (recibida !== l.cantidad) diferencia = true;
        if (recibida > 0) {
          if (!fuente || !ref) throw malaPeticion(`Indica a qué producto de tu inventario corresponde «${l.nombre}»`);
          if (!destFuentes.includes(fuente) || !FUENTES[fuente].traslado) throw malaPeticion(`«${l.nombre}»: el producto elegido no es de este inventario`);
          if (FUENTES[fuente].sucursal) {
            if (!sucDest) throw malaPeticion('Elige la sucursal que recibe');
            if (!permitidas.some((s) => s.id === sucDest)) throw prohibido('No tienes acceso a esa sucursal');
          }
          await moverItem(q, req.ctx, { fuente, ref, sucursalId: FUENTES[fuente].sucursal ? sucDest : null, delta: recibida, tipo: 'traslado', costo: l.costo_unitario ?? 0,
            documento: doc, proveedor: origenNombre, motivo: `Traslado ${doc} desde ${origenNombre}` });
          valor += recibida * (l.costo_unitario ?? 0);
          recibidas++;
        }
        await q.query('update invu.traslado_lineas set cantidad_recibida = $2, fuente_destino = $3, ref_destino = $4, nota = $5 where id = $1', [l.id, recibida, fuente ?? null, ref ?? null, dato.nota || null]);
      }
      let interId = null;
      if (t.empresa_origen_id !== t.empresa_destino_id && valor > 0) {
        interId = (await q.query(
          `insert into fin.intercompania (fecha, empresa_origen_id, empresa_destino_id, concepto, monto, estado, registrado_por)
           values ($1,$2,$3,$4,$5,'pendiente',$6) returning id`,
          [fechaHN(), t.empresa_origen_id, t.empresa_destino_id, `Traslado de inventario ${doc} (al costo)`, r2(valor), req.ctx.usuario.id])).rows[0].id;
      }
      await q.query(
        `update invu.traslados set estado = 'recibido', recibido_por = $2, recibido_at = now(), nota_recepcion = $3, con_diferencia = $4, intercompania_id = $5,
                sucursal_destino_id = coalesce(sucursal_destino_id, $6) where id = $1`, [t.id, req.ctx.usuario.id, b.nota || null, diferencia, interId, sucDest]);
      const detalle = { documento: doc, lineas: recibidas, con_diferencia: diferencia, valor: r2(valor), intercompania: interId, nota: b.nota ?? null };
      await auditar(q, req.ctx, 'inv.traslado_recibido', 'traslado', t.id, detalle, { sucursalId: sucDest });
      if (t.empresa_origen_id !== t.empresa_destino_id) await auditar(q, { ...req.ctx, empresa: { id: t.empresa_origen_id } }, 'inv.traslado_confirmado_destino', 'traslado', t.id, detalle);
      return { ok: true, documento: doc, con_diferencia: diferencia, valor: r2(valor), intercompania_id: interId };
    });
    res.json(out);
  });

  r.post('/traslados/:id/anular', operar, async (req, res) => {
    const b = validar(z.object({ motivo: z.string().trim().min(3, 'Escribe el motivo').max(200) }), req.body);
    await db.tx(async (q) => {
      const t = await cargar(q, req, req.params.id, { bloquear: true });
      if (t.empresa_origen_id !== req.ctx.empresa.id) throw prohibido('Solo quien envió puede anular un traslado');
      if (t.estado !== 'en_transito') throw conflicto(`Este traslado ya está ${t.estado}`);
      const lineas = (await q.query('select * from invu.traslado_lineas where traslado_id = $1', [t.id])).rows;
      const doc = numeroDoc(t.numero);
      for (const l of lineas) {
        // la mercadería regresa al mismo lugar de donde salió
        const suc = FUENTES[l.fuente_origen].sucursal ? await sucursalDeSalida(q, t) : null;
        await moverItem(q, req.ctx, { fuente: l.fuente_origen, ref: l.ref_origen, sucursalId: suc, delta: l.cantidad, tipo: 'traslado', costo: l.costo_unitario ?? 0, documento: doc, motivo: `Se anuló el traslado ${doc}: ${b.motivo}` });
      }
      await q.query(`update invu.traslados set estado = 'anulado', anulado_por = $2, anulado_at = now(), motivo_anulacion = $3 where id = $1`, [t.id, req.ctx.usuario.id, b.motivo]);
      await auditar(q, req.ctx, 'inv.traslado_anulado', 'traslado', t.id, { documento: doc, motivo: b.motivo });
    });
    res.json({ ok: true });
  });

  /** Sucursal de la que salió una línea (la de la cabecera: un traslado sale de una sola sucursal). */
  async function sucursalDeSalida(_q, t) { return t.sucursal_origen_id; }
}
