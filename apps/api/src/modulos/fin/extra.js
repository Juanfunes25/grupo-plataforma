// Finanzas de UNA empresa (empresa activa): estado de resultados por sucursal, flujo de caja, por cobrar, por pagar,
// presupuesto, abonos, conciliación entre empresas y Excel. El consolidado del grupo vive en fin/consolidado.js.
import { z } from 'zod';
import { fechaHN } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { conflicto, malaPeticion, noEncontrado, prohibido, uuid, validar, fechaISO } from '../../lib/http.js';
import { libroExcel, enviarLibro } from '../../lib/excel.js';
import { diasEntre, r2 } from '../compras/calculo.js';
import { cuentasPorCobrar, cuentasPorPagar, estadoResultados, flujoCaja, limitesMes, netearSaldos, presupuestoVsReal } from './estados.js';
import { hojasDe } from './excel.js';

const mesEsq = z.string().regex(/^\d{4}-\d{2}(-01)?$/, 'mes inválido (AAAA-MM)');
const txt = (n = 200) => z.string().trim().max(n).optional().nullable().transform((v) => v || null);

export function rangoPorDefecto(f, hoy = fechaHN()) {
  return { desde: f.desde ?? `${hoy.slice(0, 8)}01`, hasta: f.hasta ?? hoy };
}
export function agruparAuto(desde, hasta) {
  const d = diasEntre(desde, hasta);
  return d <= 31 ? 'dia' : d <= 120 ? 'semana' : 'mes';
}

export function montarFinExtra(r, { db, ctxMgr }, resultadosEmpresa) {
  const ver = requierePermiso('fin:ver');
  const gastos = requierePermiso('fin:gastos');
  const emp = (req) => req.ctx.empresa.id;
  const rango = z.object({ desde: fechaISO.optional(), hasta: fechaISO.optional() });

  r.get('/estado-resultados', ver, async (req, res) => {
    const f = validar(rango, req.query);
    res.json(await estadoResultados(db, resultadosEmpresa, { empresaId: emp(req), sucursalIds: req.ctx.sucursalIds, ...rangoPorDefecto(f) }));
  });

  r.get('/flujo-caja', ver, async (req, res) => {
    const f = validar(rango.extend({ agrupar: z.enum(['dia', 'semana', 'mes']).optional() }), req.query);
    const { desde, hasta } = rangoPorDefecto(f);
    res.json(await flujoCaja(db, { empresaId: emp(req), sucursalIds: req.ctx.sucursalIds, desde, hasta, agrupar: f.agrupar ?? agruparAuto(desde, hasta) }));
  });

  r.get('/por-cobrar', ver, async (req, res) => res.json(await cuentasPorCobrar(db, { empresaId: emp(req), sucursalIds: req.ctx.sucursalIds, hoy: fechaHN() })));
  r.get('/por-pagar', ver, async (req, res) => res.json(await cuentasPorPagar(db, { empresaId: emp(req), hoy: fechaHN() })));

  // ── Gastos por pagar ───────────────────────────────────────────────────────
  r.post('/gastos/:id/pagar', gastos, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(z.object({ fecha: fechaISO.optional() }), req.body ?? {});
    const hoy = fechaHN();
    if ((b.fecha ?? hoy) > hoy) throw malaPeticion('La fecha del pago no puede ser futura');
    const g = (await db.query('update fin.gastos set pagado = true, pagado_at = $3 where id = $1 and empresa_id = $2 and not anulado and not pagado returning id, monto, descripcion', [id, emp(req), b.fecha ?? hoy])).rows[0];
    if (!g) throw noEncontrado('Gasto no encontrado o ya pagado');
    await auditar(db, req.ctx, 'gasto_pagado', 'gasto', id, { monto: g.monto, descripcion: g.descripcion });
    res.json({ ok: true });
  });

  // ── Abonos a facturas a crédito ────────────────────────────────────────────
  r.post('/abonos', gastos, async (req, res) => {
    const b = validar(z.object({ venta_id: uuid, monto: z.coerce.number().positive('El monto debe ser mayor a 0').max(999_999_999), fecha: fechaISO.optional(), forma: txt(30), referencia: txt(60) }), req.body);
    const hoy = fechaHN();
    if ((b.fecha ?? hoy) > hoy) throw malaPeticion('La fecha del abono no puede ser futura');
    const out = await db.tx(async (q) => {
      await q.query('select 1 from pos.ventas where id = $1 and empresa_id = $2 for update', [b.venta_id, emp(req)]);
      const cxc = await cuentasPorCobrar(q, { empresaId: emp(req), sucursalIds: [], hoy });
      const item = cxc.items.find((i) => i.tipo === 'factura' && i.id === b.venta_id);
      if (!item) throw conflicto('Esa factura no tiene saldo a crédito pendiente');
      if (b.monto > item.saldo + 0.005) throw malaPeticion(`El abono supera el saldo pendiente (L ${item.saldo.toFixed(2)})`);
      const a = (await q.query('insert into fin.abonos_credito (empresa_id, venta_id, fecha, monto, forma, referencia, usuario_id) values ($1,$2,$3,$4,$5,$6,$7) returning *', [emp(req), b.venta_id, b.fecha ?? hoy, b.monto, b.forma, b.referencia, req.ctx.usuario.id])).rows[0];
      await auditar(q, req.ctx, 'abono_credito', 'venta', b.venta_id, { factura: item.ref, monto: b.monto, saldo_despues: r2(item.saldo - b.monto), forma: b.forma });
      return a;
    });
    res.status(201).json(out);
  });
  r.post('/abonos/:id/anular', gastos, async (req, res) => {
    const { motivo } = validar(z.object({ motivo: z.string().trim().min(3).max(200) }), req.body);
    const a = (await db.query('update fin.abonos_credito set anulado = true where id = $1 and empresa_id = $2 and not anulado returning id, monto, venta_id', [validar(uuid, req.params.id), emp(req)])).rows[0];
    if (!a) throw noEncontrado('Abono no encontrado o ya anulado');
    await auditar(db, req.ctx, 'abono_anulado', 'venta', a.venta_id, { monto: a.monto, motivo });
    res.json({ ok: true });
  });
  r.get('/abonos', ver, async (req, res) => {
    const { venta_id } = validar(z.object({ venta_id: uuid }), req.query);
    res.json((await db.query(
      `select a.id, a.fecha::text as fecha, a.monto::float8 as monto, a.forma, a.referencia, a.anulado, u.nombre as usuario from fin.abonos_credito a left join core.usuarios u on u.id = a.usuario_id
        where a.empresa_id = $1 and a.venta_id = $2 order by a.fecha, a.created_at`, [emp(req), venta_id])).rows);
  });

  // ── Presupuesto mensual ────────────────────────────────────────────────────
  r.get('/presupuesto', ver, async (req, res) => {
    const { mes } = validar(z.object({ mes: mesEsq.optional() }), req.query);
    const hoy = fechaHN();
    res.json(await presupuestoVsReal(db, resultadosEmpresa, { empresaId: emp(req), mes: mes ?? hoy.slice(0, 7), hoy, sucursalIds: req.ctx.sucursalIds }));
  });
  r.put('/presupuesto', requierePermiso('fin:presupuesto'), async (req, res) => {
    const b = validar(z.object({ mes: mesEsq, lineas: z.array(z.object({ clave: z.string().min(1).max(60), monto: z.coerce.number().min(0).max(999_999_999) })).min(1).max(200) }), req.body);
    const { ini } = limitesMes(b.mes);
    await db.tx(async (q) => {
      const cats = new Set((await q.query('select id::text as id from fin.categorias_gasto where empresa_id = $1', [emp(req)])).rows.map((c) => c.id));
      for (const l of b.lineas) {
        if (l.clave !== 'ventas' && !cats.has(l.clave)) throw malaPeticion('Una categoría del presupuesto no es de esta empresa');
        if (l.monto > 0) {
          await q.query(`insert into fin.presupuestos (empresa_id, mes, clave, monto, updated_by) values ($1,$2,$3,$4,$5)
                         on conflict (empresa_id, mes, clave) do update set monto = excluded.monto, updated_by = excluded.updated_by, updated_at = now()`, [emp(req), ini, l.clave, l.monto, req.ctx.usuario.id]);
        } else await q.query('delete from fin.presupuestos where empresa_id = $1 and mes = $2 and clave = $3', [emp(req), ini, l.clave]);
      }
      await auditar(q, req.ctx, 'presupuesto_guardado', 'presupuesto', null, { mes: ini, lineas: b.lineas.length });
    });
    res.json(await presupuestoVsReal(db, resultadosEmpresa, { empresaId: emp(req), mes: ini, hoy: fechaHN(), sucursalIds: req.ctx.sucursalIds }));
  });
  r.post('/presupuesto/copiar', requierePermiso('fin:presupuesto'), async (req, res) => {
    const b = validar(z.object({ desde_mes: mesEsq, mes: mesEsq }), req.body);
    const o = limitesMes(b.desde_mes).ini, d = limitesMes(b.mes).ini;
    if (o === d) throw malaPeticion('Elige un mes distinto para copiar');
    const n = (await db.query(
      `insert into fin.presupuestos (empresa_id, mes, clave, monto, updated_by) select empresa_id, $3::date, clave, monto, $4 from fin.presupuestos where empresa_id = $1 and mes = $2::date
       on conflict (empresa_id, mes, clave) do nothing`, [emp(req), o, d, req.ctx.usuario.id])).rowCount;
    await auditar(db, req.ctx, 'presupuesto_copiado', 'presupuesto', null, { desde: o, a: d, lineas: n });
    res.json({ copiadas: n });
  });

  // ── Entre empresas: saldos, pagos y conciliación ───────────────────────────
  r.get('/intercompania/saldos', ver, async (req, res) => {
    const empresas = await ctxMgr.empresas();
    const nombre = (id) => empresas.find((e) => e.id === id)?.nombre ?? '—';
    const ops = (await db.query(
      `select id, empresa_origen_id, empresa_destino_id, monto::float8 as monto, monto_pagado::float8 as monto_pagado, estado from fin.intercompania where empresa_origen_id = $1 or empresa_destino_id = $1`, [emp(req)])).rows;
    const saldos = netearSaldos(ops).map((s) => ({ ...s, deudor_nombre: nombre(s.deudor), acreedor_nombre: nombre(s.acreedor) }));
    const me_deben = r2(saldos.filter((s) => s.acreedor === emp(req)).reduce((a, s) => a + s.saldo, 0));
    const debo = r2(saldos.filter((s) => s.deudor === emp(req)).reduce((a, s) => a + s.saldo, 0));
    res.json({ saldos, me_deben, debo, sin_conciliar: ops.filter((o) => o.estado !== 'conciliado').length });
  });
  r.post('/intercompania/:id/pago', gastos, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const { monto } = validar(z.object({ monto: z.coerce.number().positive('El monto debe ser mayor a 0') }), req.body);
    const out = await db.tx(async (q) => {
      const i = (await q.query('select * from fin.intercompania where id = $1 and (empresa_origen_id = $2 or empresa_destino_id = $2) for update', [id, emp(req)])).rows[0];
      if (!i) throw noEncontrado();
      const pend = r2(Number(i.monto) - Number(i.monto_pagado));
      if (monto > pend + 0.005) throw malaPeticion(`El pago supera lo pendiente (L ${pend.toFixed(2)})`);
      await q.query('update fin.intercompania set monto_pagado = monto_pagado + $2 where id = $1', [id, monto]);
      await auditar(q, req.ctx, 'intercompania_pago', 'intercompania', id, { monto, pendiente_despues: r2(pend - monto) });
      return { pendiente: r2(pend - monto) };
    });
    res.json(out);
  });
  // La empresa que recibe confirma que reconoce la operación (la que la registró no se concilia sola).
  r.put('/intercompania/:id/conciliar', gastos, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const { nota } = validar(z.object({ nota: txt(200) }), req.body ?? {});
    const i = (await db.query('select * from fin.intercompania where id = $1 and (empresa_origen_id = $2 or empresa_destino_id = $2)', [id, emp(req)])).rows[0];
    if (!i) throw noEncontrado();
    if (i.estado === 'conciliado') throw conflicto('Ya está conciliada');
    if (i.empresa_destino_id !== emp(req) && !req.ctx.usuario.es_dueno_grupo) throw prohibido('La conciliación la confirma la empresa que recibe o que debe');
    await db.query(`update fin.intercompania set estado = 'conciliado', conciliado_at = now(), conciliado_por = $2, nota = coalesce($3, nota) where id = $1`, [id, req.ctx.usuario.id, nota]);
    await auditar(db, req.ctx, 'intercompania_conciliada', 'intercompania', id, { monto: i.monto, nota });
    res.json({ ok: true });
  });

  // ── Excel ──────────────────────────────────────────────────────────────────
  r.get('/exportar', ver, async (req, res) => {
    const f = validar(rango.extend({ reporte: z.enum(['resultados', 'flujo', 'cobrar', 'pagar', 'presupuesto', 'interco']), mes: mesEsq.optional(), agrupar: z.enum(['dia', 'semana', 'mes']).optional() }), req.query);
    const hoy = fechaHN();
    const { desde, hasta } = rangoPorDefecto(f, hoy);
    const e = { empresaId: emp(req), sucursalIds: req.ctx.sucursalIds };
    let datos;
    if (f.reporte === 'resultados') datos = await estadoResultados(db, resultadosEmpresa, { ...e, desde, hasta });
    else if (f.reporte === 'flujo') datos = await flujoCaja(db, { ...e, desde, hasta, agrupar: f.agrupar ?? agruparAuto(desde, hasta) });
    else if (f.reporte === 'cobrar') datos = await cuentasPorCobrar(db, { ...e, hoy });
    else if (f.reporte === 'pagar') datos = await cuentasPorPagar(db, { empresaId: emp(req), hoy });
    else if (f.reporte === 'presupuesto') datos = await presupuestoVsReal(db, resultadosEmpresa, { ...e, mes: f.mes ?? hoy.slice(0, 7), hoy });
    else {
      const empresas = await ctxMgr.empresas();
      const nombre = (id) => empresas.find((x) => x.id === id)?.nombre ?? '—';
      const rows = (await db.query(
        `select i.fecha::text as fecha, i.empresa_origen_id, i.empresa_destino_id, i.concepto, i.monto::float8 as monto, i.monto_pagado::float8 as pagado, i.estado from fin.intercompania i
          where i.empresa_origen_id = $1 or i.empresa_destino_id = $1 order by i.fecha desc`, [emp(req)])).rows;
      datos = rows.map((x) => ({ ...x, de: nombre(x.empresa_origen_id), a: nombre(x.empresa_destino_id), pendiente: r2(x.monto - x.pagado) }));
    }
    const { hojas, nombre, titulo } = hojasDe(f.reporte, datos);
    enviarLibro(res, await libroExcel({ titulo, subtitulo: `${req.ctx.empresa.nombre} · ${f.reporte === 'presupuesto' ? (f.mes ?? hoy.slice(0, 7)) : `${desde} a ${hasta}`} · generado ${hoy}`, hojas }), `${nombre}-${req.ctx.empresa.codigo}.xlsx`);
  });

}
