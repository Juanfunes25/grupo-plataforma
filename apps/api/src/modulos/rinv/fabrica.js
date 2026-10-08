import { Router } from 'express';
import { z } from 'zod';
import { fechaHN } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { ErrorHttp, conflicto, fechaISO, malaPeticion, noEncontrado, uuid, validar } from '../../lib/http.js';
import { aplicarMovimiento, emparejarConCatalogo, parsearPedidoTexto, redondearSaldo, validarLimites, vencimientoDe } from './calculo.js';
import {
  buscarPorCodigoBarras, consumirLotesFifo, empresaDe, insumoFab, movimientoPorCliente, registrarAjusteAbsoluto, registrarLote, registrarMov, soltarCodigoBarras, texto,
} from './util.js';

const num = z.coerce.number().finite();
const cantidadPos = num.positive('La cantidad tiene que ser mayor a cero').max(1_000_000);
const clienteIdEsq = z.string().trim().max(120).optional().nullable().transform((v) => v || null);

const COLUMNAS = `id, nombre, descripcion, tipo, part_number, unidad, categoria, codigo_barras, stock_minimo, stock_maximo, es_equipo,
                  stock_actual, stock_actualizado_en, peso_unitario`;

/** Insumos de fábrica: materia prima (Mec3, locales, Ristoris). Solo cantidades; el precio NUNCA sale de estas rutas. */
export function rutasFabrica({ db }) {
  const r = Router();
  const ver = requierePermiso('rep:inventario');
  const costos = requierePermiso('rep:costeo');

  // Buscar por código de barras (escaneo) en los dos catálogos.
  r.get('/codigo/:codigo', ver, async (req, res) => {
    const e = await buscarPorCodigoBarras(db, empresaDe(req), String(req.params.codigo).trim());
    if (!e) throw noEncontrado('Ningún insumo tiene ese código');
    res.json(e);
  });

  r.get('/fabrica', ver, async (req, res) => {
    res.json((await db.query(`select ${COLUMNAS} from rinv.insumos_fab where empresa_id = $1 and activo order by nombre`, [empresaDe(req)])).rows);
  });

  r.get('/fabrica/vencimientos', ver, async (req, res) => {
    const { dias } = validar(z.object({ dias: z.coerce.number().int().min(0).max(3650).default(60) }), req.query);
    res.json(await lotesPorVencer(db, empresaDe(req), dias));
  });

  r.get('/fabrica/:id/movimientos', ver, async (req, res) => {
    const id = validar(uuid, req.params.id);
    res.json((await db.query(
      `select id, tipo, cantidad, saldo_resultante, motivo, rol, usuario_nombre, created_at as creado_en
         from rinv.movimientos where ambito = 'fabrica' and empresa_id = $1 and insumo_fab_id = $2 order by n desc limit 100`, [empresaDe(req), id])).rows);
  });

  // ── Alta de insumo y precio (solo quien ve costos) ─────────────────────────
  const esqNuevo = z.object({
    nombre: z.string().trim().min(2, 'El nombre es obligatorio').max(160).transform((v) => v.toUpperCase()),
    tipo: z.enum(['mec3', 'local']).default('local'),
    unidad: z.string().trim().min(1).max(20).default('unidad'),
    categoria: z.string().trim().max(60).optional().nullable().transform((v) => v || null),
    part_number: z.string().trim().max(40).optional().nullable().transform((v) => v || null),
    descripcion: z.string().trim().max(200).optional().nullable().transform((v) => v || null),
    peso_unitario: num.positive().max(1000).optional().nullable(),
    lps_kg: num.min(0).max(9_999_999).optional().nullable(),
  });
  r.post('/fabrica', costos, async (req, res) => {
    const b = validar(esqNuevo, req.body);
    const nuevo = await db.tx(async (q) => {
      const dup = await q.query('select 1 from rinv.insumos_fab where empresa_id = $1 and nombre = $2', [empresaDe(req), b.nombre]);
      if (dup.rowCount) throw conflicto(`Ya existe un insumo llamado «${b.nombre}»`);
      const i = (await q.query(
        `insert into rinv.insumos_fab (empresa_id, nombre, descripcion, tipo, part_number, unidad, categoria, peso_unitario)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning ${COLUMNAS}`,
        [empresaDe(req), b.nombre, b.descripcion, b.tipo, b.part_number, b.unidad, b.categoria, b.peso_unitario ?? null])).rows[0];
      if (b.lps_kg !== null && b.lps_kg !== undefined) {
        await q.query(`insert into rinv.precios_fab (empresa_id, insumo_id, fecha_vigencia, lps_kg, fuente) values ($1,$2,$3,$4,'manual')`, [empresaDe(req), i.id, fechaHN(), b.lps_kg]);
      }
      await auditar(q, req.ctx, 'rinv.insumo_creado', 'insumo_fab', i.id, { nombre: i.nombre, tipo: i.tipo });
      return i;
    });
    res.status(201).json(nuevo);
  });

  r.get('/fabrica/:id/precios', costos, async (req, res) => {
    const id = validar(uuid, req.params.id);
    await insumoFab(db, empresaDe(req), id, { incluirArchivados: true });
    res.json((await db.query(
      `select id, fecha_vigencia, lps_kg, usd_kg, tipo_cambio_usado, fuente, factura_ref, created_at from rinv.precios_fab
        where insumo_id = $1 order by fecha_vigencia desc, n desc limit 50`, [id])).rows);
  });

  r.post('/fabrica/:id/precio', costos, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(z.object({
      lps_kg: num.min(0).max(9_999_999), usd_kg: num.min(0).optional().nullable(), tipo_cambio_usado: num.positive().optional().nullable(),
      fecha_vigencia: fechaISO.optional(), fuente: z.enum(['factura_mec3', 'manual']).default('manual'), factura_ref: z.string().trim().max(60).optional().nullable().transform((v) => v || null),
    }), req.body);
    const i = await insumoFab(db, empresaDe(req), id);
    const p = (await db.query(
      `insert into rinv.precios_fab (empresa_id, insumo_id, fecha_vigencia, lps_kg, usd_kg, tipo_cambio_usado, fuente, factura_ref)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, fecha_vigencia, lps_kg`,
      [empresaDe(req), id, b.fecha_vigencia ?? fechaHN(), b.lps_kg, b.usd_kg ?? null, b.tipo_cambio_usado ?? null, b.fuente, b.factura_ref])).rows[0];
    await auditar(db, req.ctx, 'rinv.precio_registrado', 'insumo_fab', id, { nombre: i.nombre, lps_kg: b.lps_kg });
    res.status(201).json(p);
  });

  r.patch('/fabrica/:id/archivar', costos, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const { archivar } = validar(z.object({ archivar: z.boolean() }), req.body);
    const i = await insumoFab(db, empresaDe(req), id, { incluirArchivados: true });
    await db.query('update rinv.insumos_fab set activo = $2 where id = $1', [id, !archivar]);
    await auditar(db, req.ctx, archivar ? 'rinv.insumo_archivado' : 'rinv.insumo_reactivado', 'insumo_fab', id, { nombre: i.nombre });
    res.json({ ok: true });
  });

  // ── Corregir el total (conteo físico) ──────────────────────────────────────
  r.patch('/fabrica/:id', ver, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(z.object({ stock_actual: num.min(0, 'Cantidad inválida').max(10_000_000), motivo: z.string().trim().max(200).optional().nullable() }), req.body);
    const stock = redondearSaldo(b.stock_actual);
    await db.tx(async (q) => {
      const fila = await insumoFab(q, empresaDe(req), id, { bloquear: true });
      const anterior = fila.stock_actual;
      await q.query('update rinv.insumos_fab set stock_actual = $2, stock_actualizado_en = now() where id = $1', [id, stock]);
      await registrarAjusteAbsoluto(q, req.ctx, { ambito: 'fabrica', insumoFabId: id, anterior, nuevo: stock, motivo: b.motivo });
      // Una corrección «a la baja» también descuenta de los lotes (FIFO) para que la alerta de vencimiento no cuente lo que ya no está.
      // Al alza no se crea lote: una corrección manual no es un envío real con fecha de llegada propia.
      if (fila.tipo === 'mec3' && stock < (Number(anterior) || 0)) await consumirLotesFifo(q, empresaDe(req), id, (Number(anterior) || 0) - stock, texto(b.motivo) ?? 'Ajuste manual (conteo/corrección)');
      await auditar(q, req.ctx, 'rinv.total_corregido', 'insumo_fab', id, { nombre: fila.nombre, antes: anterior, despues: stock, motivo: texto(b.motivo) });
    });
    res.json({ ok: true });
  });

  async function cambio(req, res, columnas, valores, accion) {
    const id = validar(uuid, req.params.id);
    const sets = columnas.map((c, k) => `${c} = $${k + 3}`).join(', ');
    const { rows } = await db.query(`update rinv.insumos_fab set ${sets} where id = $1 and empresa_id = $2 and activo returning nombre`, [id, empresaDe(req), ...valores]);
    if (!rows[0]) throw noEncontrado('Insumo no encontrado');
    await auditar(db, req.ctx, accion, 'insumo_fab', id, { nombre: rows[0].nombre, valores });
    res.json({ ok: true });
  }

  r.patch('/fabrica/:id/categoria', ver, (req, res) => cambio(req, res, ['categoria'], [texto(req.body?.categoria)], 'rinv.insumo_categoria'));

  r.patch('/fabrica/:id/limites', ver, (req, res) => {
    const { stock_minimo: min = null, stock_maximo: max = null } = req.body ?? {};
    const error = validarLimites(min, max);
    if (error) throw malaPeticion(error);
    return cambio(req, res, ['stock_minimo', 'stock_maximo'], [min ?? null, max ?? null], 'rinv.insumo_limites');
  });

  r.patch('/fabrica/:id/equipo', ver, (req, res) => cambio(req, res, ['es_equipo'], [Boolean(req.body?.es_equipo)], 'rinv.insumo_equipo'));

  /** Cuántos kg trae un bote/bolsa: se puede corregir aquí además de al vuelo en la carga en lote. */
  r.patch('/fabrica/:id/peso-unitario', ver, (req, res) => {
    const v = req.body?.peso_unitario;
    if (v !== null && v !== undefined && (!Number.isFinite(Number(v)) || Number(v) <= 0)) throw malaPeticion('Peso por unidad inválido');
    return cambio(req, res, ['peso_unitario'], [v === null || v === undefined ? null : Number(v)], 'rinv.insumo_peso');
  });

  /**
   * Cambia la unidad en que se cuenta (casi todo se cuenta por bote «unidad», pero leche o azúcar se miden por peso).
   * `peso_unitario` acompaña a la unidad: sin él, el valor del inventario no puede pasar de botes a kilos.
   */
  r.patch('/fabrica/:id/unidad', ver, (req, res) => {
    const unidad = texto(req.body?.unidad) ?? 'unidad';
    if (unidad.length > 20) throw malaPeticion('La unidad es demasiado larga');
    const cols = ['unidad'];
    const vals = [unidad];
    if (req.body?.peso_unitario !== undefined) {
      const p = req.body.peso_unitario === null || req.body.peso_unitario === '' ? null : Number(req.body.peso_unitario);
      if (p !== null && (!Number.isFinite(p) || p <= 0)) throw malaPeticion('El peso por unidad tiene que ser mayor a cero');
      cols.push('peso_unitario'); vals.push(p);
    }
    return cambio(req, res, cols, vals, 'rinv.insumo_unidad');
  });

  r.patch('/fabrica/:id/codigo-barras', ver, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const codigo = texto(req.body?.codigo_barras);
    if (codigo && codigo.length > 60) throw malaPeticion('El código es demasiado largo');
    await db.tx(async (q) => {
      const i = await insumoFab(q, empresaDe(req), id);
      if (codigo && !req.body?.forzar) {
        const dueno = await buscarPorCodigoBarras(q, empresaDe(req), codigo);
        if (dueno && !(dueno.ambito === 'fabrica' && dueno.id === id)) {
          // El detalle del dueño del código viaja en `faltantes` (único campo extra que el manejador de errores devuelve).
          throw Object.assign(new ErrorHttp(409, `Ese código ya pertenece a «${dueno.nombre}»`, 'conflicto'), { faltantes: dueno });
        }
      }
      if (codigo && req.body?.forzar) await soltarCodigoBarras(q, empresaDe(req), codigo);
      await q.query('update rinv.insumos_fab set codigo_barras = $2 where id = $1', [id, codigo]);
      await auditar(q, req.ctx, 'rinv.insumo_codigo', 'insumo_fab', id, { nombre: i.nombre, codigo });
    });
    res.json({ ok: true });
  });

  // ── Entrada / salida de UN insumo ──────────────────────────────────────────
  r.patch('/fabrica/:id/movimiento', ver, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(z.object({ tipo: z.enum(['entrada', 'salida'], { errorMap: () => ({ message: 'Tipo de movimiento inválido (usar "entrada" o "salida")' }) }), cantidad: cantidadPos,
      motivo: z.string().trim().max(200).optional().nullable(), cliente_id: clienteIdEsq }), req.body);
    const out = await db.tx(async (q) => {
      // Si esta solicitud ya se aplicó antes (reintento automático o la cola «sin señal»), devuelve lo que quedó guardado.
      const ya = await movimientoPorCliente(q, empresaDe(req), b.cliente_id);
      if (ya) return { ok: true, stock_actual: ya.saldo_resultante };
      const fila = await insumoFab(q, empresaDe(req), id, { bloquear: true });
      const resultado = aplicarMovimiento(fila.stock_actual, b.tipo, b.cantidad);
      if (!resultado.ok) throw malaPeticion(resultado.error);
      await q.query('update rinv.insumos_fab set stock_actual = $2, stock_actualizado_en = now() where id = $1', [id, resultado.nuevo]);
      const motivo = texto(b.motivo);
      await registrarMov(q, req.ctx, { ambito: 'fabrica', insumoFabId: id, tipo: b.tipo, cantidad: b.cantidad, saldo: resultado.nuevo, motivo, clienteId: b.cliente_id });
      // Solo la materia prima Mec3 lleva lote/vencimiento: una entrada abre lote nuevo con fecha de hoy; una salida descuenta FIFO.
      if (fila.tipo === 'mec3') {
        if (b.tipo === 'entrada') { const hoy = fechaHN(); await registrarLote(q, empresaDe(req), { insumoId: id, cantidad: b.cantidad, fechaIngreso: hoy, fechaVencimiento: vencimientoDe(hoy), motivo }); }
        else await consumirLotesFifo(q, empresaDe(req), id, b.cantidad, motivo);
      }
      await auditar(q, req.ctx, `rinv.fab_${b.tipo}`, 'insumo_fab', id, { nombre: fila.nombre, cantidad: b.cantidad, motivo, saldo: resultado.nuevo });
      return { ok: true, stock_actual: resultado.nuevo };
    });
    res.json(out);
  });

  // ── Carga en lote de un pedido completo (entradas) ─────────────────────────
  /**
   * El pedido de Mec3 llega contado en botes/bolsas (así es la factura). Cada item puede mandar {id, cantidad} en kg directo,
   * o {id, unidades, peso_unitario} y el servidor calcula cantidad = unidades × peso. Si manda peso_unitario, se guarda en el
   * insumo (si cambió) para que el próximo pedido ya venga con el peso recordado. Las filas en 0/vacío se ignoran en silencio.
   * `fecha` es la fecha real en que llegó el pedido: cada insumo Mec3 abre su lote con esa fecha (vence al año); los locales no.
   */
  r.post('/fabrica/entradas-lote', ver, async (req, res) => {
    const b = validar(z.object({
      items: z.array(z.object({ id: z.string(), cantidad: num.optional().nullable(), unidades: num.optional().nullable(), peso_unitario: num.optional().nullable(), cliente_id: clienteIdEsq })).min(1, 'Falta la lista de insumos').max(500),
      motivo: z.string().trim().max(200).optional().nullable(), fecha: fechaISO.optional().nullable(),
    }), req.body);
    const motivo = texto(b.motivo);
    const fechaIngreso = b.fecha || fechaHN();
    const fechaVenc = vencimientoDe(fechaIngreso);
    const resultados = await db.tx(async (q) => {
      const salida = [];
      for (const item of b.items) {
        if (!uuid.safeParse(item.id).success) continue;
        const ya = await movimientoPorCliente(q, empresaDe(req), item.cliente_id);
        if (ya) { salida.push({ id: item.id, stock_actual: ya.saldo_resultante }); continue; }
        const fila = (await q.query('select * from rinv.insumos_fab where id = $1 and empresa_id = $2 and activo for update', [item.id, empresaDe(req)])).rows[0];
        if (!fila) continue;
        const peso = item.peso_unitario && item.peso_unitario > 0 ? item.peso_unitario : null;
        let cantidad = item.cantidad;
        if (!cantidad || cantidad <= 0) cantidad = item.unidades && item.unidades > 0 && peso ? item.unidades * peso : 0;
        if (!Number.isFinite(cantidad) || cantidad <= 0) continue;
        if (peso && Number(fila.peso_unitario) !== peso) await q.query('update rinv.insumos_fab set peso_unitario = $2 where id = $1', [fila.id, peso]);
        const nuevo = redondearSaldo((Number(fila.stock_actual) || 0) + cantidad);
        await q.query('update rinv.insumos_fab set stock_actual = $2, stock_actualizado_en = now() where id = $1', [fila.id, nuevo]);
        await registrarMov(q, req.ctx, { ambito: 'fabrica', insumoFabId: fila.id, tipo: 'entrada', cantidad, saldo: nuevo, motivo, clienteId: item.cliente_id });
        if (fila.tipo === 'mec3') await registrarLote(q, empresaDe(req), { insumoId: fila.id, cantidad, fechaIngreso, fechaVencimiento: fechaVenc, motivo });
        salida.push({ id: fila.id, stock_actual: nuevo });
      }
      if (salida.length) await auditar(q, req.ctx, 'rinv.fab_entradas_lote', 'insumo_fab', null, { insumos: salida.length, motivo, fecha: fechaIngreso });
      return salida;
    });
    res.json({ ok: true, guardados: resultados.length, resultados });
  });

  // ── Sacar de bodega todo junto (todo o nada) ───────────────────────────────
  /**
   * En la mañana se decide qué se va a producir y alguien baja UNA vez a bodega a sacar todo. Se puede usar varias veces
   * el mismo día. Si a algún insumo no le alcanza el stock NO se saca nada y se devuelve la lista de cuáles son: aplicar la
   * mitad dejaría a la persona parada en bodega sin saber qué entró y qué no.
   */
  r.post('/fabrica/salidas-lote', ver, async (req, res) => {
    const b = validar(z.object({
      items: z.array(z.object({ id: z.string(), cantidad: num.optional().nullable(), cliente_id: clienteIdEsq })).min(1, 'Falta la lista de insumos').max(500),
      motivo: z.string().trim().max(200).optional().nullable(),
    }), req.body);
    const motivo = texto(b.motivo) ?? 'Salida para producción';
    const out = await db.tx(async (q) => {
      const ids = [...new Set(b.items.map((i) => i.id).filter((x) => uuid.safeParse(x).success))];
      if (!ids.length) return { ok: true, guardados: 0, resultados: [] };
      const filas = (await q.query('select * from rinv.insumos_fab where empresa_id = $1 and activo and id = any($2::uuid[]) for update', [empresaDe(req), ids])).rows;
      const porId = new Map(filas.map((f) => [f.id, f]));
      // Primero se valida TODO, llevando el saldo en memoria por si el mismo insumo viene repetido.
      const saldos = new Map(filas.map((f) => [f.id, Number(f.stock_actual) || 0]));
      const pedidos = [];
      const sinStock = [];
      for (const item of b.items) {
        if (item.cliente_id && (await movimientoPorCliente(q, empresaDe(req), item.cliente_id))) continue; // ya se aplicó en un intento anterior
        const fila = porId.get(item.id);
        if (!fila) continue;
        const cantidad = Number(item.cantidad);
        if (!Number.isFinite(cantidad) || cantidad <= 0) continue;
        const disponible = saldos.get(fila.id);
        if (cantidad > disponible) { sinStock.push({ id: fila.id, nombre: fila.nombre, unidad: fila.unidad, pedido: cantidad, hay: disponible }); continue; }
        saldos.set(fila.id, redondearSaldo(disponible - cantidad));
        pedidos.push({ fila, cantidad, clienteId: item.cliente_id, saldo: saldos.get(fila.id) });
      }
      if (sinStock.length) throw Object.assign(new ErrorHttp(409, 'No hay suficiente stock de algunos insumos', 'sin_stock'), { faltantes: sinStock });
      const resultados = [];
      for (const p of pedidos) {
        await q.query('update rinv.insumos_fab set stock_actual = $2, stock_actualizado_en = now() where id = $1', [p.fila.id, p.saldo]);
        await registrarMov(q, req.ctx, { ambito: 'fabrica', insumoFabId: p.fila.id, tipo: 'salida', cantidad: p.cantidad, saldo: p.saldo, motivo, clienteId: p.clienteId });
        // FIFO sobre los lotes; queda anotado de qué lote salió y qué día (trazabilidad hacia adelante).
        if (p.fila.tipo === 'mec3') await consumirLotesFifo(q, empresaDe(req), p.fila.id, p.cantidad, motivo);
        resultados.push({ id: p.fila.id, nombre: p.fila.nombre, sacado: p.cantidad, stock_actual: p.saldo });
      }
      if (resultados.length) await auditar(q, req.ctx, 'rinv.fab_salidas_lote', 'insumo_fab', null, { insumos: resultados.length, motivo });
      return { ok: true, guardados: resultados.length, resultados };
    });
    res.json(out);
  });

  // ── Pedido pegado como texto: se interpreta, se empareja y la persona VERIFICA antes de cargar ──
  /** No escribe nada. La lectura automática por foto/PDF con IA no está conectada: esto es el camino sin IA. */
  r.post('/fabrica/leer-pedido', ver, async (req, res) => {
    const { texto: t } = validar(z.object({ texto: z.string().max(40_000) }), req.body);
    const items = parsearPedidoTexto(t).slice(0, 300);
    if (!items.length) throw malaPeticion('No hay nada que leer en ese texto');
    const insumos = (await db.query('select id, nombre, unidad, peso_unitario from rinv.insumos_fab where empresa_id = $1 and activo and not es_equipo order by nombre', [empresaDe(req)])).rows;
    res.json({ fecha_escrita: null, proveedor: null, items: emparejarConCatalogo(items, insumos) });
  });

  r.post('/fabrica/extraer-documento', ver, () => {
    throw new ErrorHttp(501, 'La lectura automática de fotos y PDF todavía no está conectada. Pega las líneas del pedido en «Pegar texto» o cárgalo a mano.', 'no_disponible');
  });

  return r;
}

/** Lotes que vencen dentro de los próximos `dias` (o que ya vencieron), con stock restante. */
export async function lotesPorVencer(q, empresaId, dias = 60) {
  const hoy = fechaHN();
  const limite = new Date(Date.parse(`${hoy}T00:00:00Z`) + dias * 86400000).toISOString().slice(0, 10);
  return (await q.query(
    `select l.id, l.insumo_id, i.nombre as insumo_nombre, i.unidad, l.cantidad_restante, l.fecha_ingreso, l.fecha_vencimiento,
            (l.fecha_vencimiento - $2::date) as dias_para_vencer
       from rinv.lotes_mec3 l join rinv.insumos_fab i on i.id = l.insumo_id
      where l.empresa_id = $1 and l.cantidad_restante > 0 and l.fecha_vencimiento <= $3::date and i.activo
      order by l.fecha_vencimiento, l.n`, [empresaId, hoy, limite])).rows;
}
