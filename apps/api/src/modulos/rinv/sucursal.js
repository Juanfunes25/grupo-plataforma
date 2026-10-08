import { Router } from 'express';
import { z } from 'zod';
import { requierePermiso, resolverSucursal } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { ErrorHttp, malaPeticion, noEncontrado, uuid, validar } from '../../lib/http.js';
import { aplicarMovimiento, redondearSaldo, similitudNombres, validarLimites } from './calculo.js';
import {
  buscarPorCodigoBarras, empresaDe, insumoSuc, movimientoPorCliente, registrarAjusteAbsoluto, registrarMov, soltarCodigoBarras, texto,
} from './util.js';

const num = z.coerce.number().finite();
const clienteIdEsq = z.string().trim().max(120).optional().nullable().transform((v) => v || null);

/** Insumos y empaques por sucursal: cada tienda tiene su propio stock físico; el catálogo (nombre, mínimo, unidad…) es compartido. */
export function rutasSucursal({ db }) {
  const r = Router();
  const ver = requierePermiso('rep:inventario');
  
  /**
   * Nombres parecidos ya en el catálogo, para avisar ANTES de crear un insumo que en realidad ya existe escrito distinto
   * ("Vaso 8oz" vs "Vasos 8 oz"). Es un aviso, no un bloqueo. OJO: va antes que `/sucursal/:sucursalId`.
   */
  r.get('/sucursal/parecidos', ver, async (req, res) => {
    const nombre = String(req.query.nombre || '').trim();
    if (nombre.length < 3) return res.json([]);
    const catalogo = (await db.query('select id, nombre, categoria from rep.insumos_catalogo where empresa_id = $1 and activo', [empresaDe(req)])).rows;
    res.json(catalogo.map((i) => ({ ...i, similitud: similitudNombres(nombre, i.nombre) }))
      .filter((i) => i.similitud >= 0.78 && i.similitud < 1).sort((a, b) => b.similitud - a.similitud).slice(0, 5));
  });

  r.get('/sucursal/:sucursalId', ver, async (req, res) => {
    const s = await resolverSucursal(db, req.ctx, validar(uuid, req.params.sucursalId));
    res.json((await db.query(
      `select i.id, i.nombre, i.categoria, i.codigo_barras, i.stock_minimo, i.stock_maximo, i.es_equipo, i.unidad,
              coalesce(st.cantidad, 0) as cantidad, st.actualizado_en
         from rep.insumos_catalogo i left join rinv.stock_suc st on st.insumo_id = i.id and st.sucursal_id = $2
        where i.empresa_id = $1 and i.activo order by i.nombre`, [empresaDe(req), s.id])).rows);
  });

  r.get('/sucursal/:sucursalId/:insumoId/movimientos', ver, async (req, res) => {
    const s = await resolverSucursal(db, req.ctx, validar(uuid, req.params.sucursalId));
    res.json((await db.query(
      `select id, tipo, cantidad, saldo_resultante, motivo, rol, usuario_nombre, created_at as creado_en from rinv.movimientos
        where ambito = 'sucursal' and empresa_id = $1 and sucursal_id = $2 and insumo_suc_id = $3 order by n desc limit 100`,
      [empresaDe(req), s.id, validar(uuid, req.params.insumoId)])).rows);
  });

  const guardarStock = (q, empresaId, sucursalId, insumoId, cantidad) => q.query(
    `insert into rinv.stock_suc (empresa_id, sucursal_id, insumo_id, cantidad, actualizado_en) values ($1,$2,$3,$4,now())
     on conflict (sucursal_id, insumo_id) do update set cantidad = excluded.cantidad, actualizado_en = excluded.actualizado_en`,
    [empresaId, sucursalId, insumoId, cantidad]);
  const cantidadActual = async (q, sucursalId, insumoId) =>
    (await q.query('select cantidad from rinv.stock_suc where sucursal_id = $1 and insumo_id = $2 for update', [sucursalId, insumoId])).rows[0]?.cantidad;

  // Corregir el total de UNA sucursal (conteo físico)
  r.patch('/sucursal/:sucursalId/:insumoId', ver, async (req, res) => {
    const s = await resolverSucursal(db, req.ctx, validar(uuid, req.params.sucursalId));
    const id = validar(uuid, req.params.insumoId);
    const b = validar(z.object({ cantidad: num.min(0, 'Cantidad inválida').max(10_000_000), motivo: z.string().trim().max(200).optional().nullable() }), req.body);
    const cantidad = redondearSaldo(b.cantidad);
    await db.tx(async (q) => {
      const i = await insumoSuc(q, empresaDe(req), id);
      const anterior = await cantidadActual(q, s.id, id);
      await guardarStock(q, empresaDe(req), s.id, id, cantidad);
      await registrarAjusteAbsoluto(q, req.ctx, { ambito: 'sucursal', sucursalId: s.id, insumoSucId: id, anterior, nuevo: cantidad, motivo: b.motivo });
      await auditar(q, req.ctx, 'rinv.suc_total_corregido', 'insumo_suc', id, { nombre: i.nombre, sucursal: s.nombre, antes: anterior ?? 0, despues: cantidad });
    });
    res.json({ ok: true });
  });

  r.patch('/sucursal/:sucursalId/:insumoId/movimiento', ver, async (req, res) => {
    const s = await resolverSucursal(db, req.ctx, validar(uuid, req.params.sucursalId));
    const id = validar(uuid, req.params.insumoId);
    const b = validar(z.object({ tipo: z.enum(['entrada', 'salida'], { errorMap: () => ({ message: 'Tipo de movimiento inválido (usar "entrada" o "salida")' }) }),
      cantidad: num.positive('Cantidad inválida').max(1_000_000), motivo: z.string().trim().max(200).optional().nullable(), cliente_id: clienteIdEsq }), req.body);
    const out = await db.tx(async (q) => {
      const ya = await movimientoPorCliente(q, empresaDe(req), b.cliente_id);
      if (ya) return { ok: true, cantidad: ya.saldo_resultante };
      const i = await insumoSuc(q, empresaDe(req), id);
      const actual = await cantidadActual(q, s.id, id);
      const resultado = aplicarMovimiento(actual, b.tipo, b.cantidad);
      if (!resultado.ok) throw malaPeticion(resultado.error);
      await guardarStock(q, empresaDe(req), s.id, id, resultado.nuevo);
      await registrarMov(q, req.ctx, { ambito: 'sucursal', sucursalId: s.id, insumoSucId: id, tipo: b.tipo, cantidad: b.cantidad, saldo: resultado.nuevo, motivo: texto(b.motivo), clienteId: b.cliente_id });
      await auditar(q, req.ctx, `rinv.suc_${b.tipo}`, 'insumo_suc', id, { nombre: i.nombre, sucursal: s.nombre, cantidad: b.cantidad, saldo: resultado.nuevo });
      return { ok: true, cantidad: resultado.nuevo };
    });
    res.json(out);
  });

  // Datos del insumo (compartidos por todas las sucursales)
  async function cambio(req, res, columnas, valores, accion) {
    await resolverSucursal(db, req.ctx, validar(uuid, req.params.sucursalId));
    const id = validar(uuid, req.params.insumoId);
    const sets = columnas.map((c, k) => `${c} = $${k + 3}`).join(', ');
    const { rows } = await db.query(`update rep.insumos_catalogo set ${sets} where id = $1 and empresa_id = $2 returning nombre`, [id, empresaDe(req), ...valores]);
    if (!rows[0]) throw noEncontrado('Insumo no encontrado');
    await auditar(db, req.ctx, accion, 'insumo_suc', id, { nombre: rows[0].nombre, valores });
    res.json({ ok: true });
  }
  r.patch('/sucursal/:sucursalId/:insumoId/categoria', ver, (req, res) => cambio(req, res, ['categoria'], [texto(req.body?.categoria)], 'rinv.suc_categoria'));
  r.patch('/sucursal/:sucursalId/:insumoId/limites', ver, (req, res) => {
    const { stock_minimo: min = null, stock_maximo: max = null } = req.body ?? {};
    const error = validarLimites(min, max);
    if (error) throw malaPeticion(error);
    return cambio(req, res, ['stock_minimo', 'stock_maximo'], [min ?? null, max ?? null], 'rinv.suc_limites');
  });
  r.patch('/sucursal/:sucursalId/:insumoId/equipo', ver, (req, res) => cambio(req, res, ['es_equipo'], [Boolean(req.body?.es_equipo)], 'rinv.suc_equipo'));
  r.patch('/sucursal/:sucursalId/:insumoId/unidad', ver, (req, res) => {
    const unidad = texto(req.body?.unidad) ?? 'u';
    if (unidad.length > 20) throw malaPeticion('La unidad es demasiado larga');
    return cambio(req, res, ['unidad'], [unidad], 'rinv.suc_unidad');
  });
  /** Archivar un insumo que ya no se usa (sin borrarlo ni perder su historial). Es global: el catálogo se comparte. */
  r.patch('/sucursal/:sucursalId/:insumoId/archivar', ver, (req, res) => cambio(req, res, ['activo'], [!req.body?.archivar], req.body?.archivar ? 'rinv.suc_archivado' : 'rinv.suc_reactivado'));

  r.patch('/sucursal/:sucursalId/:insumoId/codigo-barras', ver, async (req, res) => {
    await resolverSucursal(db, req.ctx, validar(uuid, req.params.sucursalId));
    const id = validar(uuid, req.params.insumoId);
    const codigo = texto(req.body?.codigo_barras);
    if (codigo && codigo.length > 60) throw malaPeticion('El código es demasiado largo');
    await db.tx(async (q) => {
      const i = await insumoSuc(q, empresaDe(req), id);
      if (codigo && !req.body?.forzar) {
        const dueno = await buscarPorCodigoBarras(q, empresaDe(req), codigo);
        if (dueno && !(dueno.ambito === 'sucursal' && dueno.id === id)) {
          throw Object.assign(new ErrorHttp(409, `Ese código ya pertenece a «${dueno.nombre}»`, 'conflicto'), { faltantes: dueno });
        }
      }
      if (codigo && req.body?.forzar) await soltarCodigoBarras(q, empresaDe(req), codigo);
      await q.query('update rep.insumos_catalogo set codigo_barras = $2 where id = $1', [id, codigo]);
      await auditar(q, req.ctx, 'rinv.suc_codigo', 'insumo_suc', id, { nombre: i.nombre, codigo });
    });
    res.json({ ok: true });
  });

  /** Insumo nuevo que todavía no existe en el catálogo: se crea con cantidad inicial en la sucursal que lo carga. */
  r.post('/sucursal/:sucursalId/nuevo', ver, async (req, res) => {
    const s = await resolverSucursal(db, req.ctx, validar(uuid, req.params.sucursalId));
    const b = validar(z.object({
      nombre: z.string().trim().min(1, 'Falta el nombre').max(120), cantidad: num.min(0, 'Cantidad inválida').max(10_000_000).optional().nullable(),
      categoria: z.string().trim().max(60).optional().nullable(), unidad: z.string().trim().max(20).optional().nullable(), cliente_id: clienteIdEsq,
    }), req.body);
    const cantidad = redondearSaldo(b.cantidad || 0);
    const out = await db.tx(async (q) => {
      if (b.cliente_id && (await movimientoPorCliente(q, empresaDe(req), b.cliente_id))) return { id: null, yaExistia: true };
      // Sin distinguir mayúsculas: "vaso 8oz" y "Vaso 8oz" son el mismo insumo tipeado distinto.
      let i = (await q.query('select id from rep.insumos_catalogo where empresa_id = $1 and upper(nombre) = upper($2)', [empresaDe(req), b.nombre])).rows[0];
      if (!i) {
        i = (await q.query('insert into rep.insumos_catalogo (empresa_id, nombre, categoria, unidad) values ($1,$2,$3,$4) returning id',
          [empresaDe(req), b.nombre, texto(b.categoria), texto(b.unidad) ?? 'u'])).rows[0];
      } else {
        await q.query('update rep.insumos_catalogo set activo = true where id = $1', [i.id]);
      }
      await guardarStock(q, empresaDe(req), s.id, i.id, cantidad);
      if (cantidad > 0) await registrarMov(q, req.ctx, { ambito: 'sucursal', sucursalId: s.id, insumoSucId: i.id, tipo: 'entrada', cantidad, saldo: cantidad, motivo: 'Alta de insumo nuevo', clienteId: b.cliente_id });
      await auditar(q, req.ctx, 'rinv.suc_insumo_nuevo', 'insumo_suc', i.id, { nombre: b.nombre, sucursal: s.nombre, cantidad });
      return { id: i.id };
    });
    res.status(201).json(out);
  });

  /**
   * Carga en lote para UNA sucursal: la reposición semanal (vasos, servilletas, empaques). Cada {id, cantidad} se SUMA
   * al stock actual; cada uno lleva su cliente_id para poder reintentar el lote entero sin duplicar.
   */
  r.post('/sucursal/:sucursalId/entradas-lote', ver, async (req, res) => {
    const s = await resolverSucursal(db, req.ctx, validar(uuid, req.params.sucursalId));
    const b = validar(z.object({
      items: z.array(z.object({ id: z.string(), cantidad: num.optional().nullable(), cliente_id: clienteIdEsq })).min(1, 'Falta la lista de insumos').max(500),
      motivo: z.string().trim().max(200).optional().nullable(),
    }), req.body);
    const resultados = await db.tx(async (q) => {
      const salida = [];
      for (const item of b.items) {
        const cantidad = Number(item.cantidad);
        if (!Number.isFinite(cantidad) || cantidad <= 0 || !uuid.safeParse(item.id).success) continue;
        const ya = await movimientoPorCliente(q, empresaDe(req), item.cliente_id);
        if (ya) { salida.push({ id: item.id, cantidad: ya.saldo_resultante }); continue; }
        const i = (await q.query('select id from rep.insumos_catalogo where id = $1 and empresa_id = $2 and activo', [item.id, empresaDe(req)])).rows[0];
        if (!i) continue;
        const actual = await cantidadActual(q, s.id, i.id);
        const nuevo = redondearSaldo((Number(actual) || 0) + cantidad);
        await guardarStock(q, empresaDe(req), s.id, i.id, nuevo);
        await registrarMov(q, req.ctx, { ambito: 'sucursal', sucursalId: s.id, insumoSucId: i.id, tipo: 'entrada', cantidad, saldo: nuevo, motivo: texto(b.motivo), clienteId: item.cliente_id });
        salida.push({ id: i.id, cantidad: nuevo });
      }
      if (salida.length) await auditar(q, req.ctx, 'rinv.suc_entradas_lote', 'insumo_suc', null, { sucursal: s.nombre, insumos: salida.length, motivo: texto(b.motivo) });
      return salida;
    });
    res.json({ ok: true, guardados: resultados.length, resultados });
  });

  return r;
}

